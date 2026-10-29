import {Interface,getAddress,ZeroAddress,keccak256,formatUnits} from 'ethers';
import {MERGED_GANG,MERGED_READ_ABI} from './gang-merged.mjs';
import {readContract,same,check,simulate,exactApproval,checkDrift,ERC20} from './market-utils.mjs';
import {parseDecimalAmount,slippageFloor} from './protocol.mjs';
import {gangBuyQuote,gangSellQuote} from './gang-curve-quote.mjs';
import {fairPositionPrincipal} from './gang-fair-sale.mjs';
import {gangTradeRisk,gangMergedRisk,priceImpactLimit,enforceTradeRisk,withRiskGas} from './trade-risk.mjs';
import {recordAllowanceConsumption} from './allowance-consumption.mjs';

const WBNB='0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',SHARE=50_000n*10n**18n;
const SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ABI=[...MERGED_READ_ABI,...ERC20,
 'function buy(address,uint256,uint256) returns(uint256)','function sell(address,uint256,uint256) returns(uint256)',
 'function mint(address,uint256,uint256) returns(uint256)','function withdraw(address,uint256,uint256) returns(uint256)',
 'function isAgent(address) view returns(bool)','function agentGateEnabled() view returns(bool)','function routers(address) view returns(bool)',
 'function walletRoom(address,address) view returns(uint256)','function positions(address,address) view returns(uint16)',
 'function TOKENS_PER_SHARE() view returns(uint256)','function previewMint(address,address,uint256) view returns(uint256,uint256,uint256)',
 'function previewWithdraw(address,address,uint256) view returns(uint256,uint256)','function exitFeeBpsOf(address) view returns(uint256)',
 'function pad() view returns(address)','function wbnb() view returns(address)','function pancakeRouter() view returns(address)',
 'function taxHandler() view returns(address)','function buyTaxBps() view returns(uint16)','function sellTaxBps() view returns(uint16)',
 'function getAmountsOut(uint256,address[]) view returns(uint256[])','function previewSellNextBlock(address,uint256) view returns(uint256,uint256)',
 'function baselineOf(address,address) view returns(uint256)','function holdBpsOf(address) view returns(uint16)','function isOut(address,address) view returns(bool)',
 'function v3BuyBNB(address,uint256,uint256) payable returns(uint256)',
 'function fairMintBNB(address,uint256,uint256,uint256) payable returns(uint256)',
 'function poolBuyBNB(address,address,uint256,uint256) payable returns(uint256)',
 'function poolBuy(address,address,uint256,uint256,uint256) returns(uint256)',
 'function poolSell(address,address,uint256,uint256,uint256) returns(uint256)',
 'function poolSellForBNB(address,address,uint256,uint256,uint256) returns(uint256)',
];
const iface=new Interface(ABI),positiveAddress=a=>typeof a==='string'&&/^0x[0-9a-f]{40}$/i.test(a)&&!same(a,ZeroAddress);
function tradeTransaction({s,nativeRoute,atomicBnb,fair,side,raw,quoted,shares,minimum,deadline,wallet,target}){
 let fn,args,value='0';
 if(s._pool){fn=side==='buy'?(nativeRoute?'poolBuyBNB':'poolBuy'):(atomicBnb?'poolSellForBNB':'poolSell');args=side==='buy'?(nativeRoute?[s.address,s.quoteAsset,minimum,deadline]:[s.address,s.quoteAsset,raw,minimum,deadline]):[s.address,s.quoteAsset,raw,minimum,deadline];if(nativeRoute)value=String(raw);}
 else if(fair){fn=side==='buy'?(nativeRoute?'fairMintBNB':'mint'):'withdraw';args=side==='buy'?(nativeRoute?[s.address,shares,shares,deadline]:[s.address,shares,shares]):[s.address,shares,minimum];if(nativeRoute)value=String(quoted.spent);}
 else{fn=side==='buy'&&nativeRoute?'v3BuyBNB':side;args=fn==='v3BuyBNB'?[s.address,minimum,deadline]:[s.address,raw,minimum];if(nativeRoute)value=String(raw);}
 return{from:wallet,to:target,value,data:iface.encodeFunctionData(fn,args)};
}

// No signer or BAW dependency: every chain operation here is a read, call or gas estimate.
export function createGangMergedProtocol({provider,config=MERGED_GANG,now=Date.now,verifyQuoteAsset=async args=>(await import('./quote-asset-policy.mjs')).verifiedQuoteAsset(args),read=(a,b,m,args,block)=>readContract(provider,a,b,m,args,block)}={}){
 const presentation=new Map();
 const call=(address,method,args,block)=>read(address,ABI,method,args||[],block);
 async function code(address,hash,block){check(positiveAddress(address)&&hash&&keccak256(await provider.getCode(address,block))===hash,'Gang 合约或路由实现已改变，请重新核验');}
 async function padBlock(){
  const chain=typeof provider.send==='function'?BigInt(await provider.send('eth_chainId',[])):(await provider.getNetwork()).chainId;
  check(chain===56n,'Gang 必须使用 BSC 主网');const block=await provider.getBlockNumber();await code(config.pad,config.codeHash,block);return block;
 }
 async function supports(token){const b=await padBlock(),kind=Number(await call(config.pad,'kindOf',[getAddress(token)],b));return kind===1||kind===2;}
 async function router(block){
  await Promise.all([code(config.router,config.routerCodeHash,block),code(config.implementation,config.implementationCodeHash,block),code(config.pancakeRouter,config.pancakeCodeHash,block)]);
  const slot=await provider.getStorage(config.router,SLOT,block);
  check(/^0x0{24}[0-9a-f]{40}$/i.test(slot)&&same('0x'+slot.slice(-40),config.implementation),'Gang 路由代理实现已改变，请重新预览并核验');
  const [pad,w,dex]=await Promise.all(['pad','wbnb','pancakeRouter'].map(m=>call(config.router,m,[],block)));
  check(same(pad,config.pad)&&same(w,WBNB)&&same(dex,config.pancakeRouter),'Gang 路由配置不匹配');
 }
 async function getTokenState(token,{reusePresentation=false}={}){
  token=getAddress(token);const block=await padBlock();
  const known=reusePresentation?presentation.get(token):null;
  const kind=Number(await call(config.pad,'kindOf',[token],block));check(kind===1||kind===2,'不是 Gang 合并版代币');
  const [s,pad,locked,decimals,supply,name,symbol]=await Promise.all([
   call(config.pad,kind===1?'curves':'sales',[token],block),call(token,'launchpad',[],block),call(token,'locked',[],block),call(token,'decimals',[],block),call(token,'totalSupply',[],block),known?known.name:call(token,'name',[],block),known?known.symbol:call(token,'symbol',[],block),
  ]);
  check(same(pad,config.pad)&&positiveAddress(s.creator)&&positiveAddress(s.quote)&&Number(decimals)===18&&supply===1_000_000_000n*10n**18n,'Gang 代币归属、供应量或精度不匹配');
  const finalized=kind===1?s.graduated:s.launched;check(typeof finalized==='boolean'&&locked===!finalized,'Gang 阶段和锁定状态不匹配');
  const [quoteSymbol,quoteDecimals]=await Promise.all([known&&same(known.quoteAsset,s.quote)?known.quoteSymbol:call(s.quote,'symbol',[],block),call(s.quote,'decimals',[],block)]);check(Number(quoteDecimals)===18,'计价币精度暂不支持');
  presentation.set(token,{name:String(name).slice(0,200),symbol:String(symbol).slice(0,32),quoteAsset:s.quote,quoteSymbol:String(quoteSymbol).slice(0,32)});if(presentation.size>256)presentation.delete(presentation.keys().next().value);
  if(kind===2){check(Number(await call(config.pad,'status',[token],block))===(finalized?2:1),'Fair 阶段已改变');check(await call(config.pad,'TOKENS_PER_SHARE',[],block)===SHARE,'Fair 每份数量已改变');}
  let pool=null;
  const buyTax=kind===1?Number(s.buyTaxBps):100,sellTax=kind===1?Number(s.sellTaxBps):100;
  check(Number.isInteger(buyTax)&&Number.isInteger(sellTax)&&buyTax>=0&&buyTax<=500&&sellTax>=0&&sellTax<=500,'Gang 项目税无效');
  if(finalized){
   check(positiveAddress(s.pair),'Gang 毕业池缺失');
   const [t0,t1,factory,actual,reserves]=await Promise.all([call(s.pair,'token0',[],block),call(s.pair,'token1',[],block),call(s.pair,'factory',[],block),call(config.factory,'getPair',[token,s.quote],block),call(s.pair,'getReserves',[],block)]);
   check(same(factory,config.factory)&&same(actual,s.pair)&&((same(t0,token)&&same(t1,s.quote))||(same(t1,token)&&same(t0,s.quote))),'Gang 工厂登记或池子币种不匹配');
   check(reserves[0]>0n&&reserves[1]>0n,'Gang 池子储备为零');
   pool={tokenReserve:same(t0,token)?reserves[0]:reserves[1],quoteReserve:same(t0,token)?reserves[1]:reserves[0]};
   if(buyTax||sellTax){
    await code(config.handler,config.handlerCodeHash,block);
    const [pair,handler,buy,sell]=await Promise.all(['pair','taxHandler','buyTaxBps','sellTaxBps'].map(m=>call(token,m,[],block)));
    check(same(pair,s.pair)&&same(handler,config.handler)&&Number(buy)===buyTax&&Number(sell)===sellTax,'Gang 税处理或税池不匹配');
   }
  }
  return{address:token,platformId:'gang',manager:config.pad,pad:'merged',launchType:kind===1?'curve-v3':'fair',phase:finalized?'graduated':'bonding',tradable:true,verified:true,name:String(name).slice(0,200),symbol:String(symbol).slice(0,32),quoteAsset:s.quote,quoteSymbol:same(s.quote,WBNB)?'WBNB':String(quoteSymbol).slice(0,32),quoteDecimals:18,decimals:18,positionKind:'token',tokenTaxBuyBps:String(buyTax),tokenTaxSellBps:String(sellTax),_state:s,_pool:pool,_block:block,_kind:kind};
 }
 async function positions(token,wallet){
  wallet=getAddress(wallet);const s=await getTokenState(token),b=s._block;
  const [balance,allowance,quoteBalance]=await Promise.all([call(s.address,'balanceOf',[wallet],b),call(s.address,'allowance',[wallet,s._pool?config.router:config.pad],b),call(s.quoteAsset,'balanceOf',[wallet],b)]);
  const fair=s._kind===2&&!s._pool,shares=fair?await call(config.pad,'positions',[s.address,wallet],b):null;
  return{token:s.address,address:wallet,balance:String(fair?shares*SHARE:balance),walletTokenBalance:String(balance),allowance:String(allowance),spender:s._pool?config.router:config.pad,decimals:18,positionKind:'token',quoteBalance:String(quoteBalance),quoteDecimals:18,quoteSymbol:s.quoteSymbol,sourceBlock:b,...(fair?{fairShares:String(shares),sellUnitRaw:String(SHARE),...fairPositionPrincipal(shares,s._state.sharePrice)}:{})};
 }
 async function build(input,{minimumOutputRaw:guardMinimum,deadline:originalDeadline}={},quoteOnly=false,validationOnly=false){
  const originalMinimum=guardMinimum===undefined?undefined:BigInt(guardMinimum);
  const {side,amount,slippageBps,walletAddress}=input;check(['buy','sell'].includes(side),'买卖方向无效');
  slippageFloor(1n,slippageBps);
  const wallet=getAddress(walletAddress),s=await getTokenState(input.token,{reusePresentation:validationOnly}),b=s._block,c=s._state;
  const limit=priceImpactLimit(input.maxPriceImpactBps??300),raw=parseDecimalAmount(amount,18);check(raw>0n,'输入数量必须大于零');
  const settlement=input.settlement==='bnb'?'bnb':'quote',atomicBnb=settlement==='bnb'&&Boolean(s._pool);
  check(settlement!=='bnb'||s._pool||(side==='buy'&&same(s.quoteAsset,WBNB)),'Gang 内盘 BNB 支付或结算需要顺序桥接后以底币重新报价');
  const native=side==='buy'&&(same(s.quoteAsset,WBNB)||atomicBnb),fair=s._kind===2&&!s._pool;
  let quoteProof;
  try{quoteProof=same(s.quoteAsset,WBNB)?{verified:true,decimals:18}:await verifyQuoteAsset({provider,address:s.quoteAsset,blockTag:b});}
  catch(error){
   // Preserve ordinary exits with nominal amounts and unknown recipient net;
   // a failed proof must never enable a buy or a BNB conversion.
   if(side!=='sell'||settlement!=='quote')throw error;
   quoteProof={verified:false};
  }
  const quoteTransferVerified=quoteProof?.verified===true&&quoteProof.decimals===18;
  // Native multihop net proceeds cannot be bounded for an unknown transfer model, even on sells.
  if(atomicBnb)check(quoteTransferVerified,'Gang 桥接底币转账语义尚未核验');
  let bridge=null,routeHops=side==='buy'?[s.quoteAsset,s.address]:[s.address,s.quoteAsset],poolInput=raw,bridgeInput=0n;
  if(atomicBnb){
   routeHops=same(s.quoteAsset,WBNB)?(side==='buy'?[WBNB,s.address]:[s.address,WBNB]):(side==='buy'?[WBNB,s.quoteAsset,s.address]:[s.address,s.quoteAsset,WBNB]);
   if(!same(s.quoteAsset,WBNB)){
    const pair=await call(config.factory,'getPair',[WBNB,s.quoteAsset],b);check(positiveAddress(pair),'Gang BNB 桥接池缺失');
    const [t0,t1,factory,reserves]=await Promise.all([call(pair,'token0',[],b),call(pair,'token1',[],b),call(pair,'factory',[],b),call(pair,'getReserves',[],b)]);
    check(same(factory,config.factory)&&((same(t0,WBNB)&&same(t1,s.quoteAsset))||(same(t1,WBNB)&&same(t0,s.quoteAsset))),'Gang BNB 桥接池币种或工厂改变');
    check(reserves[0]>0n&&reserves[1]>0n,'Gang BNB 桥接池储备为零');
    bridge={pair,nativeReserve:same(t0,WBNB)?reserves[0]:reserves[1],quoteReserve:same(t0,WBNB)?reserves[1]:reserves[0]};
   }
  }
  const deadline=originalDeadline??Math.floor(now()/1000)+120;
  check(Number.isSafeInteger(deadline)&&deadline>Math.floor(now()/1000)&&deadline<=Math.floor(now()/1000)+120,'原预览期限已失效，请重新预览');
  let quoted,shares=null,tax=0n,quotedWith='Gang curve',fairRewardLost=false,gateEnabled=false;
  const warnings=[];
  if(!s._pool&&s._kind===1){
   gateEnabled=await call(config.pad,'agentGateEnabled',[],b);
   if(gateEnabled)check(await call(config.pad,'isAgent',[wallet],b),'此钱包没有 Gang 所需 Agent ID');
   quoted=side==='buy'?gangBuyQuote(c,raw,await call(config.pad,'walletRoom',[s.address,wallet],b)):gangSellQuote(c,raw);
  }else if(fair){
   check(c.sharePrice>0n&&c.sold>=0n&&c.sold<10000n,'Fair 打新状态无效');
   if(side==='buy'){
    gateEnabled=!same(c.gate,ZeroAddress);
    if(gateEnabled)check(await call(c.gate,'balanceOf',[wallet],b)>0n,'此钱包没有 Fair 打新所需 Agent ID');
    let lo=0n,hi=10000n;
    while(lo<hi){const mid=(lo+hi+1n)/2n,principal=mid*c.sharePrice;if(principal+principal*BigInt(c.mintFeeBps)/10000n<=raw)lo=mid;else hi=mid-1n;}
    check(lo>0n,'预算不足以购买 1 份 Fair 打新');
    const [accepted,cost,fee]=await call(config.pad,'previewMint',[s.address,wallet,lo],b);
    check(accepted>0n&&accepted<=lo&&cost===accepted*c.sharePrice&&fee===cost*BigInt(c.mintFeeBps)/10000n&&cost+fee<=raw,'Fair 可购份额或费用未核验');
    shares=accepted;quoted={output:accepted*SHARE,spent:cost+fee,fee,refund:raw-cost-fee};
   }else{
    check(raw%SHARE===0n,'Fair 退出必须为整份，每份 50,000 代币');shares=raw/SHARE;
    check(shares>0n&&shares<=await call(config.pad,'positions',[s.address,wallet],b),'Fair 可退出份额不足');
    const [payout,fee]=await call(config.pad,'previewWithdraw',[s.address,wallet,shares],b),feeBps=await call(config.pad,'exitFeeBpsOf',[s.address],b),gross=shares*c.sharePrice;
    check(payout>0n&&payout+fee===gross&&fee===gross*feeBps/10000n,'Fair 退出报价无效');quoted={output:payout,gross,fee};
   }
   quotedWith=side==='buy'?'previewMint':'previewWithdraw';
  }else{
   await router(b);
   if(side==='buy'){
    const amounts=await call(config.pancakeRouter,'getAmountsOut',[raw,atomicBnb?routeHops:[s.quoteAsset,s.address]],b);
    check(amounts.length===(atomicBnb?routeHops.length:2)&&amounts[0]===raw&&amounts.every(x=>x>0n),'Gang 池子买入报价无效');
    poolInput=amounts[amounts.length-2];bridgeInput=bridge?raw:0n;const out=amounts.at(-1);tax=out*BigInt(s.tokenTaxBuyBps)/10000n;
    quoted={output:out-tax,spent:raw,fee:0n,refund:0n};quotedWith='Pancake getAmountsOut minus buy tax';
   }else{
    tax=raw*BigInt(s.tokenTaxSellBps)/10000n;
    if(tax>0n){const [out,chunk]=await call(config.handler,'previewSellNextBlock',[s.address,raw],b);check(out>0n&&chunk>=0n,'Gang 含税回售的下一块卖出报价无效');quoted={output:out,fee:0n};quotedWith='previewSellNextBlock';warnings.push('卖出报价已计入下一块税回售；本块报价不可代替。');}
    else{const amounts=await call(config.pancakeRouter,'getAmountsOut',[raw,[s.address,s.quoteAsset]],b);check(amounts.length===2&&amounts[0]===raw&&amounts[1]>0n,'Gang 池子卖出报价无效');quoted={output:amounts[1],fee:0n};quotedWith='Pancake getAmountsOut';}
    if(bridge){bridgeInput=quoted.output;const amounts=await call(config.pancakeRouter,'getAmountsOut',[bridgeInput,[s.quoteAsset,WBNB]],b);check(amounts.length===2&&amounts[0]===bridgeInput&&amounts[1]>0n,'Gang BNB 桥接卖出报价无效');quoted={...quoted,output:amounts[1]};quotedWith+=' + Pancake quote/WBNB';}
    if(s._kind===2){
     const [baseline,hold,out,balance]=await Promise.all([call(config.pad,'baselineOf',[s.address,wallet],b),call(config.pad,'holdBpsOf',[s.address],b),call(config.handler,'isOut',[s.address,wallet],b),call(s.address,'balanceOf',[wallet],b)]);
     fairRewardLost=baseline>0n&&!out&&(balance-raw)*10000n<baseline*BigInt(hold);
     if(fairRewardLost)warnings.push('本次卖出将低于打新持仓线，永久失去该代币的打新分红资格；回购不会恢复。');
     else if(baseline>0n&&!out)warnings.push('打新分红资格按成交时余额判断；提交前持仓若减少，可能跌破持仓线并永久失去分红资格。');
    }
   }
  }
  const minimum=originalMinimum??(fair&&side==='buy'?quoted.output:slippageFloor(quoted.output,slippageBps));check(minimum>0n&&minimum<=quoted.output,'最低收到无效，请重新预览');
  let risk=s._pool||fair?gangMergedRisk({side,limitBps:limit,quoteAsset:s.quoteAsset,quoteSymbol:s.quoteSymbol,tokenSymbol:s.symbol,quoted,minimum,reserve:fair?c.sold*c.sharePrice:s._pool.quoteReserve,tokenReserve:s._pool?.tokenReserve,input:poolInput,fair,tax,warnings,quoteTransferVerified}):gangTradeRisk({curve:c,quoted,side,input:raw,minimum,quoteAsset:s.quoteAsset,quoteDecimals:18,quoteSymbol:s.quoteSymbol,tokenSymbol:s.symbol,limitBps:limit,quoteTransferVerified});
  if(!s._pool&&!fair)risk={...risk,priceImpactMethod:risk.priceImpactMethod?.replace('Gang V2','Gang V3')};
  if(bridge){
   // Fee-exclusive reserve impact composes both pool legs; fees and token taxes remain separate.
   const scale=10n**18n;let ratio;
   if(side==='buy')ratio=(bridge.nativeReserve+raw)*(s._pool.quoteReserve+poolInput)*scale/(bridge.nativeReserve*s._pool.quoteReserve)-scale;
   else ratio=scale-s._pool.tokenReserve*bridge.quoteReserve*scale/((s._pool.tokenReserve+raw)*(bridge.quoteReserve+bridgeInput));
   const impact=Number((ratio*10000n+scale-1n)/scale),high=impact>limit,reason=`本次完整 BNB 路径价格冲击 ${impact} bps 超过上限 ${limit} bps`;
   risk={...risk,priceImpactBps:impact,priceImpactMethod:'Pancake V2 双池储备价格冲击；LP费、项目税与税回售另计。',bridgeDepth:{pair:bridge.pair,nativeReserveRaw:String(bridge.nativeReserve),quoteReserveRaw:String(bridge.quoteReserve)},status:high?(side==='buy'?'blocked':'warning'):risk.status,blockReasons:[...risk.blockReasons,...(high&&side==='buy'?[reason]:[])],warnings:[...risk.warnings,...(high&&side==='sell'?[reason]:[])]};
  }
  if(atomicBnb&&side==='sell')risk={...risk,outputSymbol:'BNB'};
  risk=enforceTradeRisk(risk,side);
  const nativeRoute=native&&(Boolean(s._pool)||gateEnabled);
  const target=s._pool||nativeRoute?config.router:config.pad;
  if(nativeRoute&&!s._pool){await router(b);check(await call(config.pad,'routers',[config.router],b)===true,'Gang 原生币路由未在发射台授权');}
  const summary={platformId:'gang',token:s.address,manager:target,symbol:s.symbol,side,amount,slippageBps,maxPriceImpactBps:limit,walletAddress:wallet,quoteAsset:s.quoteAsset,quoteDecimals:18,settlement,routeHops,quoteSymbol:nativeRoute||atomicBnb?'BNB':s.quoteSymbol,priceUnit:s.quoteSymbol,launchType:s.launchType,phase:s.phase,routeKind:s._pool?'pool':fair?'fair':'curve',positionKind:'token',deadline,sourceBlock:b,inputRaw:String(raw),expectedOutputRaw:String(quoted.output),minimumOutputRaw:String(minimum),appliedTokenTaxBps:s._pool?(side==='buy'?s.tokenTaxBuyBps:s.tokenTaxSellBps):'0',protocolFeeBps:fair?String(side==='buy'?c.mintFeeBps:await call(config.pad,'exitFeeBpsOf',[s.address],b)):s._pool?'0':'100',quotedWith,fairRewardLost,mevProtection:'unverified',tradeRisk:risk,priceImpactBps:risk.priceImpactBps,
   ...(shares!==null?{fairShares:String(shares),tokensPerShare:'50000',unspentBudget:side==='buy'?formatUnits(quoted.refund,18):'0'}:{}),
   ...(side==='buy'?{estimatedTokens:formatUnits(quoted.output,18),minTokens:formatUnits(minimum,18),estimatedSpend:formatUnits(quoted.spent,18),estimatedRefund:fair?'0.0':formatUnits(quoted.refund,18),estimatedTotalFee:formatUnits(quoted.fee,18),...(nativeRoute&&!fair&&!s._pool?{refundCurrency:'WBNB；曲线限额或毕业裁剪的退款为 WBNB'}:{})}:{estimatedReceive:risk.estimatedNetOutput,minReceive:risk.minimumNetOutput,estimatedTotalFee:s._pool?null:formatUnits(quoted.fee,18)})};
  if(quoteOnly)return{kind:side,summary,...(validationOnly?{transaction:tradeTransaction({s,nativeRoute,atomicBnb,fair,side,raw,quoted,shares,minimum,deadline,wallet,target})}:{})};
  let transaction,allowance;
  const need=side==='buy'&&fair?quoted.spent:raw,spendAsset=side==='buy'?s.quoteAsset:s.address;
  if(!nativeRoute){
   const balance=await call(spendAsset,'balanceOf',[wallet],b);
   if(side==='buy'&&same(spendAsset,WBNB)&&balance<need){
    const deficit=need-balance;transaction={from:wallet,to:WBNB,value:String(deficit),data:new Interface(['function deposit() payable']).encodeFunctionData('deposit')};
    const gas=await simulate(provider,transaction);return{kind:'wrap',transaction,summary:{...summary,...gas,wrapAmountRaw:String(deficit),tradeRisk:withRiskGas(risk,gas.estimatedGasCost),requiresNewPreview:true,action:'本次仅包装 BNB；成功后重新预览。'}};
   }
   check(balance>=need,'当前支付资产余额不足');
   if(!(fair&&side==='sell')){
    allowance=await call(spendAsset,'allowance',[wallet,target],b);
    if(allowance<need){const approval=await exactApproval(provider,spendAsset,wallet,target,need,summary);return{...approval,summary:{...approval.summary,tradeRisk:withRiskGas(risk,approval.summary.estimatedGasCost)}};}
   }
  }
  transaction=tradeTransaction({s,nativeRoute,atomicBnb,fair,side,raw,quoted,shares,minimum,deadline,wallet,target});const gas=await simulate(provider,transaction);
  if(allowance!==undefined)recordAllowanceConsumption(transaction,{asset:spendAsset,owner:wallet,spender:target,before:allowance,amount:need});
  return{kind:side,transaction,summary:{...summary,...gas,tradeRisk:withRiskGas(risk,gas.estimatedGasCost,{nativeOutput:atomicBnb&&side==='sell'})}};
 }
 async function validateExecution(transaction,summary){
  check(summary&&['buy','sell','approve','wrap'].includes(summary.kind),'原预览种类缺失');
  const input={token:summary.token,side:summary.side,amount:summary.amount,slippageBps:summary.slippageBps,maxPriceImpactBps:summary.maxPriceImpactBps,walletAddress:summary.walletAddress,settlement:summary.settlement};
  const trade=['buy','sell'].includes(summary.kind),fresh=await build(input,{minimumOutputRaw:summary.minimumOutputRaw,deadline:summary.deadline},trade,trade);
  check(fresh.summary.phase===summary.phase&&fresh.summary.routeKind===summary.routeKind&&same(fresh.summary.manager,summary.manager)&&fresh.kind===summary.kind,'Gang 阶段、路由或准备步骤已变化，请重新预览');
  check(!fresh.summary.fairRewardLost||summary.fairRewardLost===true,'Fair 分红资格影响已变化，请重新预览并确认');
  check(summary.inputRaw===fresh.summary.inputRaw&&summary.tradeRisk?.limitBps===fresh.summary.tradeRisk.limitBps,'原输入或风险上限依据不匹配');
  checkDrift(BigInt(summary.expectedOutputRaw),BigInt(fresh.summary.expectedOutputRaw),BigInt(summary.minimumOutputRaw),summary.slippageBps);
  check(same(transaction.from,fresh.transaction.from)&&same(transaction.to,fresh.transaction.to)&&transaction.value===fresh.transaction.value&&transaction.data===fresh.transaction.data,'Gang 交易参数与原预览不一致');
  if(trade){const gas=await simulate(provider,transaction);return{...gas,tradeRisk:withRiskGas(fresh.summary.tradeRisk,gas.estimatedGasCost,{nativeOutput:summary.side==='sell'&&summary.settlement==='bnb'})};}
  return{simulated:fresh.summary.simulated,estimatedGas:fresh.summary.estimatedGas,estimatedGasCost:fresh.summary.estimatedGasCost,tradeRisk:fresh.summary.tradeRisk};
 }
 return{provider,supports,getTokenState,positions,buildTrade:(input,guards)=>build(input,guards),quoteTrade:(input,guards)=>build(input,guards,true),validateExecution};
}
