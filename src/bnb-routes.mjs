import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress, formatUnits, parseUnits, keccak256 } from 'ethers';
import { ERC20, check, same, readContract, simulate, exactApproval } from './market-utils.mjs';
import {recordAllowanceConsumption} from './allowance-consumption.mjs';

const config = JSON.parse(readFileSync(new URL('../config/platforms.json', import.meta.url)));
const ROUTER = ['function factory() view returns(address)', 'function WETH() view returns(address)', 'function getAmountsOut(uint256,address[]) view returns(uint256[])', 'function swapExactETHForTokens(uint256,address[],address,uint256) payable returns(uint256[])', 'function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns(uint256[])'];
const FACTORY = ['function getPair(address,address) view returns(address)'];
const PAIR = ['function token0() view returns(address)', 'function token1() view returns(address)', 'function getReserves() view returns(uint112,uint112,uint32)'];
const iface = new Interface(ROUTER), transfers = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const floor = (n,bps) => n * BigInt(10000-bps) / 10000n;
const positive = v => /^(?:[1-9][0-9]*)$/.test(String(v));
const defaultVerifyQuote = async options => (await import('./quote-asset-policy.mjs')).verifiedQuoteAsset(options);

// The only externally selectable values are validated order inputs. Read/verifier
// injection is constructor-only for deterministic tests, never an HTTP parameter.
export function createBnbRouteProtocol({ protocol, provider = protocol.provider, read = (...args) => readContract(provider,...args), verifyQuote = defaultVerifyQuote, now = Date.now, routerCodeHash = config.gang.merged.pancakeCodeHash } = {}) {
  const router = config.gang.merged.pancakeRouter, factory = config.gang.merged.factory, wrapped = config.wrappedNative;
  const assetBalance = (asset,owner,block='latest') => read(asset,ERC20,'balanceOf',[owner],block);
  async function bridgeQuote(quoteAsset, amount, side, slippageBps, maxPriceImpactBps, verifyOnly=false) {
    const blockTag = await provider.getBlockNumber();
    check((await provider.getNetwork()).chainId === 56n,'BNB 路线必须使用 BSC 主网');
    const verified = await verifyQuote({provider,address:quoteAsset,blockTag});
    check(verified?.verified === true && Number.isInteger(verified.decimals),'底币转账语义未核验');
    const code = await provider.getCode(router,blockTag);
    check(code !== '0x' && keccak256(code) === routerCodeHash,'Pancake 路由代码已变化');
    const [actualFactory,actualWrapped,pair] = await Promise.all([read(router,ROUTER,'factory',[],blockTag),read(router,ROUTER,'WETH',[],blockTag),read(factory,FACTORY,'getPair',[wrapped,quoteAsset],blockTag)]);
    check(same(actualFactory,factory) && same(actualWrapped,wrapped),'Pancake 工厂或 WBNB 已变化');
    check(pair && !same(pair,ZeroAddress),'没有已核验 BNB 底币池');
    const [token0,token1,reserves] = await Promise.all([read(pair,PAIR,'token0',[],blockTag),read(pair,PAIR,'token1',[],blockTag),read(pair,PAIR,'getReserves',[],blockTag)]);
    check(same(token0,wrapped)&&same(token1,quoteAsset)||same(token1,wrapped)&&same(token0,quoteAsset),'桥接池 pair 币种不匹配');
    const nativeReserve = BigInt(reserves[same(token0,wrapped)?0:1]), quoteReserve = BigInt(reserves[same(token0,wrapped)?1:0]);
    check(nativeReserve > 0n && quoteReserve > 0n,'桥接池真实储备不足');
    if(verifyOnly)return{pair,blockTag,decimals:verified.decimals};
    const reserve = side === 'buy' ? nativeReserve : quoteReserve;
    const denominator=side==='buy'?reserve:reserve+amount;
    const impact = Number((amount*10000n+denominator-1n)/denominator);
    check(Number.isSafeInteger(impact)&&impact <= maxPriceImpactBps,'桥接价格冲击超过上限');
    const path = side === 'buy' ? [wrapped,quoteAsset] : [quoteAsset,wrapped];
    const amounts = await read(router,ROUTER,'getAmountsOut',[amount,path],blockTag);
    check(amounts.length === 2 && BigInt(amounts[0]) === amount && BigInt(amounts[1]) > 0n,'桥接报价无效');
    // For a code-verified ordinary ERC20 these quotes have ordinary receipt
    // semantics; fee/rebasing/unknown assets never reach this point.
    const output = BigInt(amounts[1]), minimum = floor(output,slippageBps);
    check(minimum > 0n && output < (side === 'buy'?quoteReserve:nativeReserve),'桥接报价超过实际储备');
    return {pair,path,blockTag,priceImpactBps:impact,inputRaw:String(amount),expectedOutputRaw:String(output),minimumOutputRaw:String(minimum),decimals:verified.decimals};
  }
  function checkRisk(summary, bridge, limit, side='buy') {
    const risk=summary.tradeRisk;
    check(risk && ['ok','warning'].includes(risk.status) && Array.isArray(risk.blockReasons) && risk.blockReasons.length===0 && Number.isFinite(risk.priceImpactBps),'目标市场风险或底币转账语义未知');
    const combined=side==='buy'?Math.ceil((10000+risk.priceImpactBps)*(10000+bridge.priceImpactBps)/10000)-10000:risk.priceImpactBps+bridge.priceImpactBps;
    check(combined <= limit,'完整路线价格冲击超过原上限');
    return combined;
  }
  async function gasReserve(wallet, nativeInput=0n) {
    const fee=await provider.getFeeData(),price=fee.maxFeePerGas??fee.gasPrice;
    check(price>0n,'无法核验路线 Gas 储备');
    // Reserve four million gas at 2x the quoted price for bridge, approval,
    // target and possible allowance reset. Each actual transaction is simulated.
    const reserve=4000000n*price*2n;
    check(await provider.getBalance(wallet)>=nativeInput+reserve,'BNB 余额不足以覆盖整条路线和 Gas 储备');
    return reserve;
  }
  async function planRoute(input) {
    if(input.settlement!=='bnb'||!['gang','flap'].includes(input.platformId))return null;
    const state=await protocol.getTokenState(input.token,{platformId:input.platformId});
    if(same(state.quoteAsset,ZeroAddress)||same(state.quoteAsset,wrapped)||input.platformId==='gang'&&state.pad==='merged'&&state.phase==='graduated')return null;
    check(state.tradable===true,state.reason||'市场不能交易');
    check(input.walletAddress,'路线缺少已认证钱包');
    const limit=input.maxPriceImpactBps??300, deadline=Math.floor(now()/1000)+120;
    const firstLegSlippageBps=Math.floor(input.slippageBps/2);
    let bridge,target,originalMinimumOutputRaw,targetMinimumOutputRaw;
    if(input.side==='buy'){
      bridge=await bridgeQuote(state.quoteAsset,parseUnits(input.amount,18),'buy',firstLegSlippageBps,limit);
      target=await protocol.quoteTrade({...input,settlement:'quote',amount:formatUnits(bridge.expectedOutputRaw,state.quoteDecimals)},{deadline});
      originalMinimumOutputRaw=String(floor(BigInt(target.summary.expectedOutputRaw),input.slippageBps));
      targetMinimumOutputRaw=originalMinimumOutputRaw;
      const worst=await protocol.quoteTrade({...input,settlement:'quote',amount:formatUnits(bridge.minimumOutputRaw,state.quoteDecimals)},{deadline,minimumOutputRaw:originalMinimumOutputRaw});
      check(BigInt(worst.summary.expectedOutputRaw)>=BigInt(originalMinimumOutputRaw),'最差桥接到账无法满足原整条路线最低输出');
      checkRisk(worst.summary,bridge,limit,input.side);
    }else{
      target=await protocol.quoteTrade({...input,settlement:'quote'},{deadline});
      check(positive(target.summary.expectedOutputRaw),'目标输出报价无效');
      targetMinimumOutputRaw=String(floor(BigInt(target.summary.expectedOutputRaw),firstLegSlippageBps));
      bridge=await bridgeQuote(state.quoteAsset,BigInt(target.summary.expectedOutputRaw),'sell',firstLegSlippageBps,limit);
      originalMinimumOutputRaw=String(floor(BigInt(bridge.expectedOutputRaw),input.slippageBps));
      const worst=await bridgeQuote(state.quoteAsset,BigInt(targetMinimumOutputRaw),'sell',0,limit);
      check(BigInt(worst.expectedOutputRaw)>=BigInt(originalMinimumOutputRaw),'最差卖出到账无法满足原整条路线最低输出');
    }
    check(state.quoteDecimals===bridge.decimals,'底币精度与已核验代码不符');
    const wholeImpact=checkRisk(target.summary,bridge,limit,input.side);
    check(positive(originalMinimumOutputRaw),'原始最低到账无效');
    const gasReserveRaw=String(await gasReserve(input.walletAddress,input.side==='buy'?parseUnits(input.amount,18):0n));
    const steps=(input.side==='buy'?[['bridge','BNB → '+state.quoteSymbol],['target',state.quoteSymbol+' → 目标持仓']]:[['target','卖出持仓 → '+state.quoteSymbol],['bridge',state.quoteSymbol+' → BNB']]).map(([role,label],i)=>({id:String(i+1),role,label,status:'PLANNED'}));
    return {kind:'bnb-sequential',walletAddress:input.walletAddress,input:{...input},quoteAsset:state.quoteAsset,quoteSymbol:state.quoteSymbol,quoteDecimals:state.quoteDecimals,phase:state.phase,manager:state.manager,deadline,originalMinimumOutputRaw:String(originalMinimumOutputRaw),targetMinimumOutputRaw,firstLegSlippageBps,gasReserveRaw,bridge,targetSummary:target.summary,steps,summary:{...target.summary,amount:input.amount,inputRaw:input.side==='buy'?bridge.inputRaw:target.summary.inputRaw,estimatedSpend:input.side==='buy'?input.amount:undefined,estimatedRefund:undefined,estimatedTotalFee:undefined,intermediate:{quoteAsset:state.quoteAsset,quoteSymbol:state.quoteSymbol,targetExpectedOutputRaw:target.summary.expectedOutputRaw,targetMinimumOutputRaw,estimatedTotalFee:target.summary.estimatedTotalFee},tradeRisk:{...target.summary.tradeRisk,priceImpactBps:wholeImpact,priceImpactMethod:'完整路线：买入两段平均价冲击复合；卖出两段冲击保守相加',quoteSymbol:state.quoteSymbol,...(input.side==='sell'?{outputSymbol:'BNB',estimatedNetOutput:formatUnits(bridge.expectedOutputRaw,18),minimumNetOutput:formatUnits(originalMinimumOutputRaw,18),nativeGasBudget:formatUnits(gasReserveRaw,18),netAfterGas:formatUnits(BigInt(bridge.expectedOutputRaw)-BigInt(gasReserveRaw),18)}:{})},...(input.side==='sell'?{expectedOutputRaw:bridge.expectedOutputRaw,estimatedReceive:formatUnits(bridge.expectedOutputRaw,18),minReceive:formatUnits(originalMinimumOutputRaw,18)}:{}),settlement:'bnb',routeKind:'bnb-sequential',quoteSymbol:'BNB',inputCurrency:input.side==='buy'?'BNB':state.symbol,intermediateQuoteSymbol:state.quoteSymbol,minimumOutputRaw:String(originalMinimumOutputRaw),estimatedGasReserve:formatUnits(gasReserveRaw,18),deadline,simulated:false}};
  }
  async function validateRoute(plan) {
    check(Math.floor(now()/1000)<plan.deadline,'路线已到期；已兑换资产保留在钱包');
    const state=await protocol.getTokenState(plan.input.token,{platformId:plan.input.platformId});
    check(state.tradable===true&&state.phase===plan.phase&&same(state.quoteAsset,plan.quoteAsset)&&same(state.manager,plan.manager),'路线市场阶段、底币或入口已变化');
    return state;
  }
  async function buildRouteStep(plan, state) {
    await validateRoute(plan);
    const i=plan.input, guards={deadline:plan.deadline,minimumOutputRaw:plan.originalMinimumOutputRaw};
    let built;
    if(state.role==='target'){
      let amount=i.amount;
      if(i.side==='buy'){
        check(state.bridgeConfirmed===true&&positive(state.ownedQuoteRaw),'桥接尚未确认实际到账');
        check(BigInt(await assetBalance(plan.quoteAsset,plan.walletAddress))-BigInt(state.protectedQuoteRaw||0)>=BigInt(state.ownedQuoteRaw),'路线底币到账已被花费，不能动用原持有底币');
        amount=formatUnits(state.ownedQuoteRaw,plan.quoteDecimals);
      }else guards.minimumOutputRaw=plan.targetMinimumOutputRaw;
      const request={...i,amount,settlement:'quote'}, fresh=await protocol.quoteTrade(request,guards);
      let bridge;
      if(i.side==='buy'){
        await bridgeQuote(plan.quoteAsset,0n,i.side,0,i.maxPriceImpactBps??300,true);
        check(Number.isInteger(state.completedBridgePriceImpactBps),'缺少已确认桥接的价格冲击依据');
        bridge={priceImpactBps:state.completedBridgePriceImpactBps};
      }else bridge=await bridgeQuote(plan.quoteAsset,BigInt(fresh.summary.expectedOutputRaw),i.side,plan.firstLegSlippageBps,i.maxPriceImpactBps??300);
      checkRisk(fresh.summary,bridge,i.maxPriceImpactBps??300,i.side);
      check(BigInt(fresh.summary.expectedOutputRaw)>=BigInt(guards.minimumOutputRaw),'最新报价低于原始最低到账');
      built=await protocol.buildTrade(request,guards);
      check(['approve',i.side].includes(built.kind),'路线暂不支持自动包装或未知设置步骤');
      check(BigInt(built.summary.minimumOutputRaw)>=BigInt(guards.minimumOutputRaw),'目标交易降低了原最低到账');
    }else{
      const amount=i.side==='buy'?parseUnits(i.amount,18):BigInt(state.ownedQuoteRaw||0);
      check(amount>0n&&(i.side==='buy'||state.targetConfirmed===true),'目标卖出尚未确认到账');
      const fresh=await bridgeQuote(plan.quoteAsset,amount,i.side,plan.firstLegSlippageBps,i.maxPriceImpactBps??300);
      if(i.side==='sell'){
        check(Number.isInteger(state.completedTargetPriceImpactBps),'缺少已确认目标卖出的价格冲击依据');
        checkRisk({tradeRisk:{status:'ok',blockReasons:[],priceImpactBps:state.completedTargetPriceImpactBps}},fresh,i.maxPriceImpactBps??300,'sell');
      }
      const minimum=i.side==='buy'?BigInt(plan.bridge.minimumOutputRaw):BigInt(plan.originalMinimumOutputRaw);
      check(BigInt(fresh.expectedOutputRaw)>=minimum,'最新桥接报价低于原始最低到账');
      const summary={platformId:i.platformId,token:i.token,walletAddress:plan.walletAddress,side:i.side,amount:formatUnits(amount,i.side==='buy'?18:plan.quoteDecimals),quoteAsset:plan.quoteAsset,inputRaw:String(amount),minimumOutputRaw:String(minimum),expectedOutputRaw:fresh.expectedOutputRaw,deadline:plan.deadline,bridge:true,priceImpactBps:fresh.priceImpactBps,slippageBps:i.slippageBps,maxPriceImpactBps:i.maxPriceImpactBps??300,path:fresh.path};
      let allowance;
      if(i.side==='sell'){
        check(BigInt(await assetBalance(plan.quoteAsset,plan.walletAddress))-BigInt(state.protectedQuoteRaw||0)>=amount,'本意图卖出所得已被花费，不能动用原持有底币');
        allowance=await read(plan.quoteAsset,ERC20,'allowance',[plan.walletAddress,router]);
        if(allowance<amount)built=await exactApproval(provider,plan.quoteAsset,plan.walletAddress,router,amount,summary);
      }
      if(!built){
        const data=i.side==='buy'?iface.encodeFunctionData('swapExactETHForTokens',[minimum,fresh.path,plan.walletAddress,plan.deadline]):iface.encodeFunctionData('swapExactTokensForETH',[amount,minimum,fresh.path,plan.walletAddress,plan.deadline]);
        const transaction={from:plan.walletAddress,to:router,value:i.side==='buy'?String(amount):'0',data};
        if(allowance!==undefined)recordAllowanceConsumption(transaction,{asset:plan.quoteAsset,owner:plan.walletAddress,spender:router,before:allowance,amount});
        built={kind:i.side==='buy'?'bridge-buy':'bridge-sell',transaction,summary:{...summary,...await simulate(provider,transaction)}};
      }
    }
    check(built.transaction&&same(built.transaction.from,plan.walletAddress),'路线步骤钱包不一致');
    check(built.summary.simulated===true&&positive(built.summary.estimatedGas),'路线当前步骤缺少真实 eth_call 和 Gas 模拟');
    check(BigInt(built.summary.estimatedGas)<=1000000n,'单步骤 Gas 超出整条路线预留范围');
    await gasReserve(plan.walletAddress,BigInt(built.transaction.value));
    return {...built,completedBridgePriceImpactBps:state.completedBridgePriceImpactBps,completedTargetPriceImpactBps:state.completedTargetPriceImpactBps,routeOwnedQuoteRaw:String(state.ownedQuoteRaw||0),protectedQuoteRaw:String(state.protectedQuoteRaw||0),beforeQuoteBalanceRaw:String(await assetBalance(plan.quoteAsset,plan.walletAddress))};
  }
  async function validateRouteStep(plan,step) {
    await validateRoute(plan);
    check(same(step.transaction.from,plan.walletAddress),'路线钱包改变');
    const spendsProceeds=plan.input.side==='buy'&&step.role==='target'||plan.input.side==='sell'&&step.role==='bridge';
    if(spendsProceeds)check(BigInt(await assetBalance(plan.quoteAsset,plan.walletAddress))-BigInt(step.protectedQuoteRaw||0)>=BigInt(step.routeOwnedQuoteRaw||0),'本意图到账余额已变化，不能动用原持有底币');
    if(!step.summary.bridge){
      const result=await protocol.validateExecution(step.transaction,{...step.summary,kind:step.kind});
      check(result?.simulated===true&&positive(result.estimatedGas)&&BigInt(result.estimatedGas)<=1000000n,'最新目标模拟或 Gas 超出路线范围');
      if(plan.input.side==='buy')checkRisk({tradeRisk:result.tradeRisk},{priceImpactBps:step.completedBridgePriceImpactBps},plan.input.maxPriceImpactBps??300,'buy');
      else{const latest=await protocol.quoteTrade({...plan.input,settlement:'quote'},{minimumOutputRaw:plan.targetMinimumOutputRaw,deadline:plan.deadline});const bridge=await bridgeQuote(plan.quoteAsset,BigInt(latest.summary.expectedOutputRaw),'sell',plan.firstLegSlippageBps,plan.input.maxPriceImpactBps??300);checkRisk(latest.summary,bridge,plan.input.maxPriceImpactBps??300,'sell');}
      await gasReserve(plan.walletAddress,BigInt(step.transaction.value));
      return result;
    }
    const s=step.summary;
    const q=await bridgeQuote(plan.quoteAsset,BigInt(s.inputRaw),plan.input.side,plan.input.slippageBps,plan.input.maxPriceImpactBps??300);
    check(BigInt(q.expectedOutputRaw)>=BigInt(s.minimumOutputRaw),'最新报价低于原最低到账');
    if(plan.input.side==='buy'){
      const freshTarget=await protocol.quoteTrade({...plan.input,settlement:'quote',amount:formatUnits(plan.bridge.minimumOutputRaw,plan.quoteDecimals)},{minimumOutputRaw:plan.originalMinimumOutputRaw,deadline:plan.deadline});
      checkRisk(freshTarget.summary,q,plan.input.maxPriceImpactBps??300,'buy');
      check(BigInt(freshTarget.summary.expectedOutputRaw)>=BigInt(plan.originalMinimumOutputRaw),'目标最新报价低于原最低到账');
    }
    if(plan.input.side==='sell')checkRisk({tradeRisk:{status:'ok',blockReasons:[],priceImpactBps:step.completedTargetPriceImpactBps}},q,plan.input.maxPriceImpactBps??300,'sell');
    if(step.kind==='approve'){
      const parsed=new Interface(ERC20).parseTransaction(step.transaction);
      check(same(step.transaction.to,plan.quoteAsset)&&BigInt(step.transaction.value)===0n&&parsed?.name==='approve'&&same(parsed.args[0],router)&&String(parsed.args[1])===s.inputRaw,'桥接授权参数改变');
    }else{
      const expected=plan.input.side==='buy'?iface.encodeFunctionData('swapExactETHForTokens',[s.minimumOutputRaw,q.path,plan.walletAddress,plan.deadline]):iface.encodeFunctionData('swapExactTokensForETH',[s.inputRaw,s.minimumOutputRaw,q.path,plan.walletAddress,plan.deadline]);
      check(same(step.transaction.to,router)&&step.transaction.data===expected&&BigInt(step.transaction.value)===(plan.input.side==='buy'?BigInt(s.inputRaw):0n),'桥接交易参数改变');
    }
    await gasReserve(plan.walletAddress,BigInt(step.transaction.value));
    return {...await simulate(provider,step.transaction),priceImpactBps:q.priceImpactBps};
  }
  async function observeRouteStep(plan,step,receipt,current={ownedQuoteRaw:'0'}) {
    const balance=BigInt(await assetBalance(plan.quoteAsset,plan.walletAddress));
    let net=0n;
    for(const log of receipt.logs||[]){if(!same(log.address,plan.quoteAsset))continue;try{const e=transfers.parseLog(log);if(e?.name==='Transfer'){if(same(e.args.to,plan.walletAddress))net+=e.args.value;if(same(e.args.from,plan.walletAddress))net-=e.args.value;}}catch{/* Unrelated token event. */}}
    let owned=BigInt(current.ownedQuoteRaw||0), protectedQuote=BigInt(current.protectedQuoteRaw||0);
    const receives=step.kind!=='approve'&&(step.role==='bridge'&&plan.input.side==='buy'||step.role==='target'&&plan.input.side==='sell');
    if(receives){
      const increase=balance-BigInt(step.beforeQuoteBalanceRaw);
      check(net>0n&&increase>0n,'回执或钱包余额无法证明本意图的实际底币到账');
      owned=net<increase?net:increase;protectedQuote=BigInt(step.beforeQuoteBalanceRaw);
      const min=step.summary?.minimumOutputRaw;
      if(min)check(owned>=BigInt(min),'实际底币到账低于该步骤原最低输出');
    }else if(step.kind!=='approve'){
      check(net<=0n,'底币支出回执与路线不符');
      owned=owned+net;
      check(owned>=0n,'路线消耗了本意图之外的底币');
      check(balance>=protectedQuote,'钱包底币余额低于路线前原持有量');
      const available=balance-protectedQuote;owned=owned<available?owned:available;
    }
    const executionImpact=step.kind==='approve'?{}:step.role==='bridge'?{completedBridgePriceImpactBps:step.executionEvidence?.priceImpactBps??step.summary?.priceImpactBps}:{completedTargetPriceImpactBps:step.executionEvidence?.tradeRisk?.priceImpactBps??step.summary?.tradeRisk?.priceImpactBps};
    return {...executionImpact,ownedQuoteRaw:String(owned),protectedQuoteRaw:String(protectedQuote),retainedBalances:[{asset:plan.quoteAsset,symbol:plan.quoteSymbol,decimals:plan.quoteDecimals,amountRaw:String(owned),amount:formatUnits(owned,plan.quoteDecimals),walletBalanceRaw:String(balance)}]};
  }
  return {...protocol,provider,planRoute,buildRouteStep,validateRouteStep,observeRouteStep,validateRoute};
}
