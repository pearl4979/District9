import {readFileSync} from 'node:fs';
import {Interface,ZeroAddress,formatUnits,parseUnits} from 'ethers';
import {ERC20,readContract,check,same,getJson} from './market-utils.mjs';
import {verifiedQuoteAsset} from './quote-asset-policy.mjs';
import {verifyNativeProceeds} from './native-proceeds.mjs';
const cfg=JSON.parse(readFileSync(new URL('../config/platforms.json',import.meta.url)));
export const NATIVE='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',USDT='0x55d398326f99059ff775485246999027b3197955';
const WBNB=cfg.wrappedNative,ONE=10n**18n,transfer=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const floor=(n,bps)=>n*BigInt(10000-bps)/10000n;
const address=a=>/^0x[0-9a-f]{40}$/i.test(a||'');
const raw=(v,d=18)=>{check(typeof v==='string'&&v.length<=100&&/^(0|[1-9]\d*)(\.\d+)?$/.test(v),'聚合数量无效');return parseUnits(v,d);};
const normal=a=>same(a,ZeroAddress)?NATIVE:a;
const RWA_URL='https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/scaleui/list';
let scaleCache=null,scaleTime=0,scalePending;
// Public metadata only. No credentials or wallet session files are read here.
async function defaultScales(){if(scaleCache&&Date.now()-scaleTime<30000)return scaleCache;if(scalePending)return scalePending;scalePending=(async()=>{const r=await getJson(RWA_URL,{limit:1024*1024,timeoutMs:8000});check(Array.isArray(r.data),'币安 RWA 数量元数据不可用');const result=new Map();for(const t of r.data){if(String(t.chainId)!=='56')continue;check(address(t.contractAddress)&&raw(t.multiplier)>0n,'RWA 乘数无效');result.set(t.contractAddress.toLowerCase(),t.multiplier);}scaleCache=result;scaleTime=Date.now();return result;})();try{return await scalePending;}finally{scalePending=null;}}

export function createAggregatorProtocol({protocol,baw,snapshot,provider=protocol.provider,now=Date.now,read=(...a)=>readContract(provider,...a),verifyQuote=verifiedQuoteAsset,scales=defaultScales,verifyLiquidity}={}){
 // Cache public routing recipes only: never a price, amount, wallet proof or
 // allowance. A hit still quotes this exact order and all send guards run.
 const pathHints=new Map(),referenceHints=new Map();
 const pairKey=(a,b)=>a.toLowerCase()+':'+b.toLowerCase();
 function hint(cache,key,ttl){const value=cache.get(key);if(!value)return null;if(now()<value.at||now()-value.at>=ttl){cache.delete(key);return null;}return value;}
 function remember(cache,key,value){cache.delete(key);while(cache.size>=128)cache.delete(cache.keys().next().value);cache.set(key,{...value,at:now()});}
 const unsupported=error=>/unsupported|not support|pair|route not found|路径|交易对|流动性/i.test(error.message);
 const balance=async(a,w)=>same(a,NATIVE)?provider.getBalance(w):read(a,ERC20,'balanceOf',[w]);
 const scaleOf=(map,a)=>map.get(a.toLowerCase())||'1';
 const fromDisplay=(v,d,s)=>raw(v,d)*ONE/raw(s);
 const toDisplay=(v,d,s)=>formatUnits(v*raw(s)/ONE,d);
 const inputAmount=(i)=>parseUnits(i.amount,18);
 async function market(token,platform){const rows=(await snapshot()).tokens.filter(t=>t.verified===true&&same(t.address,token));check(rows.length===1,'当前没有唯一的已核验市场');const row=rows[0];check((row.platformId||'four')===(platform||'four'),'请求平台与已核验归属不一致');check(!row.sourceUnavailable,'市场数据不可用，暂停交易');return row;}
 async function verifyAsset(a){if([NATIVE,WBNB,USDT].some(x=>same(x,a)))return{verified:true,decimals:18};return verifyQuote({provider,address:a,blockTag:await provider.getBlockNumber()});}
 async function liquidity(row){
  if(verifyLiquidity)return verifyLiquidity(row);
  const abi=['function getPair(address,address) view returns(address)','function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)'];
  const block=await provider.getBlockNumber();
  for(const quote of [...new Set([row.quoteAsset,WBNB,USDT].filter(address))]){
   const pair=await read(cfg.gang.merged.factory,abi,'getPair',[row.address,quote],block);if(!address(pair)||same(pair,ZeroAddress))continue;
   const [factory,t0,t1,r]=await Promise.all(['factory','token0','token1','getReserves'].map(m=>read(pair,abi,m,[],block)));
   check(same(factory,cfg.gang.merged.factory)&&((same(t0,row.address)&&same(t1,quote))||(same(t1,row.address)&&same(t0,quote))),'外盘登记池不匹配');check(r[0]>0n&&r[1]>0n,'外盘真实储备不足');
   return{verified:true,pair,quoteAsset:quote,tokenReserve:String(r[same(t0,row.address)?0:1]),quoteReserve:String(r[same(t0,row.address)?1:0]),block};
  }
  throw Error('尚未找到已核验的外盘储备；聚合路线暂停，避免无深度依据买入');
 }
 async function quoteLeg(fromToken,toToken,amountRaw,slippageBps,walletAddress){
  const map=await scales(),fromScale=scaleOf(map,fromToken),toScale=scaleOf(map,toToken);
  const fromDecimals=18,toDecimals=18; // Current verified markets/assets use 18 raw decimals.
  const amount=toDisplay(amountRaw,fromDecimals,fromScale);check(raw(amount)>0n,'聚合输入数量过小');
  const request={walletAddress,fromToken,toToken,amount,slippageBps};
  const q=await baw.marketQuote(request);check(raw(q.fromCoinAmount)===raw(amount),'币安报价输入数量不匹配');
  check(Number.isFinite(Number(q.slippage))&&Math.abs(Number(q.slippage)-slippageBps/10000)<1e-9,'聚合报价滑点与请求不一致');
  const toRaw=fromDisplay(q.toCoinAmount,toDecimals,toScale);check(toRaw>0n,'聚合报价没有有效到账');
  return{...request,fromRaw:String(amountRaw),toRaw:String(toRaw),minimumRaw:String(floor(toRaw,slippageBps)),fromScale,toScale,fromDecimals,toDecimals,quotedAt:now(),fromSymbol:q.fromCoinSymbol,toSymbol:q.toCoinSymbol};
 }
 function impact(full,small){
  const f=BigInt(full.fromRaw),r=BigInt(small.fromRaw),out=BigInt(full.toRaw),refOut=BigInt(small.toRaw);
  check(r>0n&&r<f&&out>0n&&refOut>0n,'参考报价数量不足，不能核验价格冲击');
  // Normalize the observed difference for the sampled input span. For a
  // constant-product route this recovers the full-size impact even when an
  // issuer minimum requires a 75% reference. Never call the small raw
  // difference the full-order impact or silently mark an unavailable probe 0.
  const loss=refOut*f-out*r,denominator=refOut*(f-r);
  return loss>0n?Number((loss*10000n+denominator-1n)/denominator):0;
 }
 async function referenceQuote(q){
  let last;const key=pairKey(q.fromToken,q.toToken),known=hint(referenceHints,key,60000),full=BigInt(q.fromRaw);
  const smallest=known&&full/100n<BigInt(known.workingRaw)?BigInt(known.fraction):100n;
  for(const fraction of [100n,7500n,9900n].filter(f=>f>=smallest)){
   const amount=full*fraction/10000n;if(amount<=0n||amount>=full)continue;
   try{const quote=await quoteLeg(q.fromToken,q.toToken,amount,q.slippageBps,q.walletAddress);remember(referenceHints,key,{fraction:String(fraction),workingRaw:String(amount)});return quote;}
   catch(error){if(!/From token value greater than [0-9.]+ USD|minimum.*(?:USD|amount)|amount.*(?:too small|minimum)/i.test(error.message))throw error;last=error;}
  }
  throw Object.assign(Error('订单金额接近兑换最低限制，无法取得独立参考报价核验冲击，请提高金额后重新报价'),{cause:last});
 }
 async function quotePath(from,to,amount,totalBps,wallet,reservedSteps=0){
  const key=pairKey(from,to);
  const allocation=legs=>{const bps=Math.floor(totalBps/(legs+reservedSteps));check(bps>=10,'当前总滑点不足以分配到全部交易步骤，请自行调整滑点后重新报价');return bps;};
  async function viaUsdt(){
   const bps=allocation(2);
   const first=await quoteLeg(from,USDT,amount,bps,wallet),second=await quoteLeg(USDT,to,BigInt(first.minimumRaw),bps,wallet);
   first.priceImpactBps=impact(first,await referenceQuote(first));second.priceImpactBps=impact(second,await referenceQuote(second));return[first,second];
  }
  if(hint(pathHints,key,300000)){
   try{return await viaUsdt();}catch(error){if(!unsupported(error))throw error;pathHints.delete(key);}
  }
  try{const q=await quoteLeg(from,to,amount,allocation(1),wallet),small=await referenceQuote(q);q.priceImpactBps=impact(q,small);return[q];}
  catch(error){
   // Quote failures choose a recipe; no post-submission fallback is possible.
   if(same(from,USDT)||same(to,USDT)||!unsupported(error))throw error;
   const legs=await viaUsdt();remember(pathHints,key,{via:USDT});return legs;
  }
 }
 function risk(legs,limit,extra=0){const n=legs.reduce((v,l)=>v+l.priceImpactBps,extra);check(Number.isSafeInteger(n)&&n<=limit,'完整路线价格冲击超过上限');return n;}
 async function planRoute(input){
  const row=await market(input.token,input.platformId),external=row.phase==='graduated';
  if(!external&&(input.settlement!=='bnb'||!['gang','flap'].includes(input.platformId)))return protocol.planRoute?.(input)??null;
  const state=await protocol.getTokenState(input.token,{platformId:input.platformId});
  check(state.phase===row.phase,'市场阶段已变化，请刷新');
  const assetToken=external&&state.addressKind==='market'?state.tokenAddress:input.token;
  check(address(assetToken),'外盘代币尚未发射或实际合约尚未核验');
  if(!external&&[ZeroAddress,WBNB].some(a=>same(a,state.quoteAsset)))return protocol.planRoute?.(input)??null;
  check(external||state.tradable===true,state.reason||'内盘当前不可交易');check(address(input.walletAddress),'缺少已核验钱包');
  check((await provider.getNetwork()).chainId===56n,'聚合必须使用 BSC 主网');
  const quoteAsset=normal(state.quoteAsset),limit=input.maxPriceImpactBps??300,deadline=Math.floor(now()/1000)+120;
  if(!external)await verifyAsset(quoteAsset);else {check(Number(await read(assetToken,ERC20,'decimals',[]))===18,'外盘精度暂不支持');await liquidity({...state,address:assetToken});}
  let legs,target,minimum,expected,steps=[];
  if(external){
   legs=await quotePath(input.side==='buy'?NATIVE:assetToken,input.side==='buy'?assetToken:NATIVE,inputAmount(input),input.slippageBps,input.walletAddress);
   expected=legs.at(-1).toRaw;minimum=String(floor(BigInt(expected),input.slippageBps));
  }else if(input.side==='buy'){
   legs=await quotePath(NATIVE,quoteAsset,inputAmount(input),input.slippageBps,input.walletAddress,1);
   target=await protocol.quoteTrade({...input,settlement:'quote',amount:formatUnits(legs.at(-1).toRaw,18)},{deadline});
   expected=target.summary.expectedOutputRaw;minimum=String(floor(BigInt(expected),input.slippageBps));
   const worst=await protocol.quoteTrade({...input,settlement:'quote',amount:formatUnits(legs.at(-1).minimumRaw,18)},{deadline,minimumOutputRaw:minimum});
   check(BigInt(worst.summary.expectedOutputRaw)>=BigInt(minimum),'桥接最差到账不能满足原最低输出');
  }else{
   target=await protocol.quoteTrade({...input,settlement:'quote'},{deadline});check(target.summary.tradeRisk?.blockReasons?.length===0,'内盘风险未核验');
   legs=await quotePath(quoteAsset,NATIVE,BigInt(target.summary.minimumOutputRaw),input.slippageBps,input.walletAddress,1);expected=legs.at(-1).toRaw;minimum=String(floor(BigInt(expected),input.slippageBps));
   steps.push({role:'target',label:'卖出持仓 → '+state.quoteSymbol,status:'PLANNED'});
  }
  const priceImpactBps=risk(legs,limit,target?.summary.tradeRisk?.priceImpactBps??0);
  if(target)check(['ok','warning'].includes(target.summary.tradeRisk?.status)&&target.summary.tradeRisk.blockReasons.length===0,'目标市场风险未核验');
  for(const q of legs){check(BigInt(q.minimumRaw)>0n,'聚合最低到账为零');steps.push({role:'market',label:`${q.fromSymbol||q.fromToken.slice(0,8)} → ${q.toSymbol||q.toToken.slice(0,8)} · 币安聚合`,quote:q,status:'PLANNED'});}
  if(!external&&input.side==='buy')steps.push({role:'target',label:state.quoteSymbol+' → 目标持仓',status:'PLANNED'});
  const fee=await provider.getFeeData(),gasPrice=fee.maxFeePerGas??fee.gasPrice;check(gasPrice>0n,'Gas 价格不可用');const gasReserve=4000000n*gasPrice*2n;check(await provider.getBalance(input.walletAddress)>=(input.side==='buy'?inputAmount(input):0n)+gasReserve,'BNB 余额不足以支付路线及 Gas 储备');
  const assets=[...new Set([quoteAsset,...legs.flatMap(l=>[l.fromToken,l.toToken])])],protectedBalances={};for(const a of assets)protectedBalances[a.toLowerCase()]=String(await balance(a,input.walletAddress));
  return{kind:'binance-sequential',walletAddress:input.walletAddress,input:{...input},quoteAsset,quoteSymbol:state.quoteSymbol,quoteDecimals:18,phase:state.phase,external,assetToken,targetPositionLedger:!external&&(state.positionKind==='shares'||state.launchType==='fair'),manager:state.manager,deadline,steps:steps.map((s,i)=>({...s,id:String(i+1)})),protectedBalances,originalMinimumOutputRaw:minimum,targetMinimumOutputRaw:target?.summary.minimumOutputRaw,summary:{...target?.summary,inputRaw:String(inputAmount(input)),inputCurrency:input.side==='buy'?'BNB':state.symbol,priceUnit:'BNB',priceImpactBps,estimatedSpend:input.side==='buy'?input.amount:undefined,estimatedRefund:undefined,estimatedTotalFee:undefined,intermediate:target?{quoteAsset:state.quoteAsset,quoteSymbol:state.quoteSymbol,estimatedSpend:target.summary.estimatedSpend,estimatedTotalFee:target.summary.estimatedTotalFee,targetExpectedOutputRaw:target.summary.expectedOutputRaw}:undefined,platformId:input.platformId,token:input.token,symbol:state.symbol,amount:input.amount,side:input.side,settlement:'bnb',quoteSymbol:'BNB',intermediateQuoteSymbol:state.quoteSymbol,routeKind:'binance-sequential',expectedOutputRaw:expected,minimumOutputRaw:minimum,...(input.side==='buy'?{estimatedTokens:formatUnits(expected,18),minTokens:formatUnits(minimum,18)}:{estimatedReceive:formatUnits(expected,18),minReceive:formatUnits(minimum,18)}),estimatedGasReserve:formatUnits(gasReserve,18),simulated:false,simulationSource:'币安聚合提交时重新报价；内盘步骤另行 eth_call',tradeRisk:{status:'ok',limitBps:limit,priceImpactBps,priceImpactMethod:'聚合整笔与参考报价按输入差归一估计，各段相加；外盘另核验登记池储备',depthVerified:true,blockReasons:[],warnings:['聚合 CLI 不暴露可复用报价或 calldata；最低到账为估计，提交时由钱包重新报价。'],estimatedNetOutput:formatUnits(expected,18),minimumNetOutput:formatUnits(minimum,18),outputSymbol:input.side==='sell'?'BNB':state.symbol},mevProtection:'requested'}};
 }
 async function validatePlan(p){check(Math.floor(now()/1000)<p.deadline,'路线已到期，已收到资产留在钱包');const row=await market(p.input.token,p.input.platformId);check(row.phase===p.phase,'市场阶段已经变化');if(p.external){const state=await protocol.getTokenState(p.input.token,{platformId:p.input.platformId});const asset=state.addressKind==='market'?state.tokenAddress:p.input.token;check(state.phase===p.phase&&same(asset,p.assetToken),'外盘阶段或实际代币合约已经变化');await liquidity({...state,address:asset});}else {const s=await protocol.getTokenState(p.input.token,{platformId:p.input.platformId});check(s.phase===p.phase&&same(s.quoteAsset,p.quoteAsset)&&same(s.manager,p.manager),'内盘入口或底币已经变化');await verifyAsset(p.quoteAsset);}}
 async function buildRouteStep(p,s){
  if(p.kind!=='binance-sequential')return protocol.buildRouteStep(p,s);await validatePlan(p);
  if(s.role==='market'){
   const original=s.quote,from=original.fromToken.toLowerCase(),owned=s.ownedAssets?.[from];
   const first=p.steps.indexOf(p.steps.find(x=>x.id===s.id))===0;
   const amount=first?BigInt(original.fromRaw):BigInt(owned||0);check(amount>0n,'前一步实际到账尚未确认');
   if(!first)check(await balance(original.fromToken,p.walletAddress)>=BigInt(p.protectedBalances[from]||0)+amount,'路线到账已被花费，不能动用原持有余额');
   const q=await quoteLeg(original.fromToken,original.toToken,amount,original.slippageBps,p.walletAddress);
   q.priceImpactBps=impact(q,await referenceQuote(q));const future=p.steps.filter(x=>Number(x.id)>Number(s.id)&&x.role==='market').reduce((n,x)=>n+x.quote.priceImpactBps,0);risk([q],p.input.maxPriceImpactBps??300,(s.completedImpactBps||0)+future+(p.input.side==='buy'&&!p.external?p.summary.tradeRisk.priceImpactBps-p.steps.filter(x=>x.quote).reduce((n,x)=>n+x.quote.priceImpactBps,0):0));
   check(BigInt(q.toRaw)>=BigInt(original.minimumRaw),'最新聚合报价低于原步骤最低收到');
   const beforeTo=String(await balance(q.toToken,p.walletAddress)),beforeFrom=String(await balance(q.fromToken,p.walletAddress));
   return{kind:'market',marketInput:q,beforeTo,beforeFrom,summary:{minimumOutputRaw:original.minimumRaw,expectedOutputRaw:q.toRaw,priceImpactBps:q.priceImpactBps}};
  }
  const amount=p.input.side==='buy'?BigInt(s.ownedAssets?.[p.quoteAsset.toLowerCase()]||0):inputAmount(p.input);check(amount>0n,'实际底币尚未到账');
  if(p.input.side==='buy')check(await balance(p.quoteAsset,p.walletAddress)>=BigInt(p.protectedBalances[p.quoteAsset.toLowerCase()]||0)+amount,'底币到账余额已经变化');
  const g={deadline:p.deadline,minimumOutputRaw:p.input.side==='buy'?p.originalMinimumOutputRaw:p.targetMinimumOutputRaw};
  const built=await protocol.buildTrade({...p.input,settlement:'quote',amount:formatUnits(amount,18)},g);check(built.summary.simulated===true,'内盘步骤缺少模拟');if(built.kind!=='approve'){const remaining=p.steps.filter(x=>x.role==='market'&&Number(x.id)>Number(s.id)).reduce((n,x)=>n+x.quote.priceImpactBps,0);risk([],p.input.maxPriceImpactBps??300,(s.completedImpactBps||0)+remaining+(built.summary.tradeRisk?.priceImpactBps??Number.MAX_SAFE_INTEGER));}
  return{...built,...(p.targetPositionLedger&&p.input.side==='buy'&&built.kind!=='approve'?{beforePositionRaw:String((await protocol.positions(p.input.token,p.walletAddress,{platformId:p.input.platformId})).balance)}:{}),beforeTo:String(await balance(p.quoteAsset,p.walletAddress)),beforeFrom:String(await balance(p.quoteAsset,p.walletAddress))};
 }
 async function validateRouteStep(p,s){if(p.kind!=='binance-sequential')return protocol.validateRouteStep(p,s);await validatePlan(p);if(s.kind==='market'){const q=s.marketInput,map=await scales();check(scaleOf(map,q.fromToken)===q.fromScale&&scaleOf(map,q.toToken)===q.toScale,'RWA 数量乘数已变化，请重新下单');const fresh=await quoteLeg(q.fromToken,q.toToken,BigInt(q.fromRaw),q.slippageBps,p.walletAddress);check(BigInt(fresh.toRaw)>=BigInt(s.summary.minimumOutputRaw),'聚合最新报价低于原步骤最低到账');const [nativeBalance,fee]=await Promise.all([provider.getBalance(p.walletAddress),provider.getFeeData()]);const gasPrice=fee.maxFeePerGas??fee.gasPrice;check(gasPrice>0n,'无法核验当前 Gas 价格');check(nativeBalance>=(same(q.fromToken,NATIVE)?BigInt(q.fromRaw):0n)+4000000n*gasPrice*2n,'当前 BNB 余额不足以支付本次路线和 Gas');if(!same(q.fromToken,NATIVE))check(await balance(q.fromToken,p.walletAddress)>=BigInt(q.fromRaw),'聚合输入余额不足');return{priceImpactBps:q.priceImpactBps};}return protocol.validateExecution(s.transaction,{...s.summary,kind:s.kind});}
 async function observeRouteStep(p,s,receipt,current={}){
  if(p.kind!=='binance-sequential')return protocol.observeRouteStep(p,s,receipt,current);
  const ownedAssets={...current.ownedAssets},retained=[];let haltReason;
  if(s.kind==='approve')return{ownedAssets,retainedBalances:current.retainedBalances||[]};
  const receives=s.kind==='market'?s.marketInput.toToken:p.input.side==='sell'?p.quoteAsset:p.input.token;
  const spends=s.kind==='market'?s.marketInput.fromToken:p.input.side==='sell'?p.input.token:p.quoteAsset;
  let spentRaw=null;
  if((s.kind==='market'||ownedAssets[spends.toLowerCase()])&&!same(spends,NATIVE)){let spent=0n;for(const log of receipt.logs||[]){if(!same(log.address,spends))continue;try{const e=transfer.parseLog(log);if(same(e.args.from,p.walletAddress))spent+=e.args.value;if(same(e.args.to,p.walletAddress))spent-=e.args.value;}catch{}}const cap=s.kind==='market'?BigInt(s.marketInput.fromRaw):BigInt(ownedAssets[spends.toLowerCase()]);check(spent>0n&&spent<=cap,'支出回执超出原输入额度或无法核验');spentRaw=spent;}
  const ledger=p.targetPositionLedger&&s.role==='target'&&p.input.side==='buy';
  let net=0n,nativeGasAdjustment=0n;const nowBalance=ledger?BigInt((await protocol.positions(p.input.token,p.walletAddress,{platformId:p.input.platformId})).balance):BigInt(await balance(receives,p.walletAddress));
  if(ledger){const minimum=BigInt(s.summary.minimumOutputRaw);check(minimum>0n&&nowBalance-BigInt(s.beforePositionRaw)>=minimum,'确认回执与持仓账本尚未证明最低份额到账');net=minimum;}
  else
  if(same(receives,NATIVE)){
   check(s.marketRecord?.status==='FINISHED','币安尚未确认实际到账');net=fromDisplay(s.marketRecord.toTokenActualQty,18,s.marketInput.toScale);
   const proof=await verifyNativeProceeds({provider,step:s,receipt,walletAddress:p.walletAddress,nowBalance,expectedRaw:net});nativeGasAdjustment=proof.gasAdjustmentRaw;s.nativeProceedsEvidence={swapGasRaw:String(BigInt(receipt.gasUsed||0)*BigInt(receipt.gasPrice||0)),auxiliaryGasRaw:String(proof.auxiliaryGasRaw),approvals:proof.approvals,...(proof.anchorBlock!==undefined?{anchorBlock:proof.anchorBlock}:{})};
  }else for(const log of receipt.logs||[]){if(!same(log.address,receives))continue;try{const e=transfer.parseLog(log);if(same(e.args.to,p.walletAddress))net+=e.args.value;if(same(e.args.from,p.walletAddress))net-=e.args.value;}catch{}}
  check(net>0n,'回执未证明本路线资产实际到账');
  const baseline=BigInt(ledger?s.beforePositionRaw:s.kind==='market'?s.beforeTo:p.input.side==='sell'?s.beforeTo:p.protectedBalances[receives.toLowerCase()]||0);const gasAdjustment=same(receives,NATIVE)?nativeGasAdjustment:0n;check(nowBalance+gasAdjustment>=baseline+net,'本路线到账已被花费或余额不足');
  ownedAssets[receives.toLowerCase()]=String(BigInt(ownedAssets[receives.toLowerCase()]||0)+net);if(ownedAssets[spends.toLowerCase()]){const remainder=BigInt(ownedAssets[spends.toLowerCase()])-(spentRaw??BigInt(ownedAssets[spends.toLowerCase()]));check(remainder>=0n,'路线动用了原持有资产');ownedAssets[spends.toLowerCase()]=String(remainder);}
  if(s.kind==='market'&&net<BigInt(s.summary.minimumOutputRaw))haltReason='聚合实际到账低于原步骤估计最低输出，后续暂停';
  if(s.marketRecord?.refund?.length)haltReason='聚合返回退款或部分成交，请核对余额后重新下单';
  for(const [asset,amountRaw] of Object.entries(ownedAssets))if(BigInt(amountRaw)>0n)retained.push({asset,...(ledger&&same(asset,p.input.token)?{basis:'链上最低输出与持仓账本核验的保守下界'}:{}),symbol:same(asset,p.quoteAsset)?p.quoteSymbol:same(asset,USDT)?'USDT':same(asset,NATIVE)?'BNB':p.summary.symbol,amountRaw,amount:formatUnits(amountRaw,18)});
  return{ownedAssets,completedImpactBps:(current.completedImpactBps||0)+(s.kind==='market'?s.marketInput.priceImpactBps:s.summary.tradeRisk?.priceImpactBps||0),retainedBalances:retained,...(haltReason?{haltReason}:{})};
 }
 return{...protocol,provider,aggregatorEnabled:true,async planRoute(i){try{return await planRoute(i);}catch(error){if(!/unsupported|not support|pair|route not found|timed? ?out|HTTP|网络|服务不可用|交易对|Not logged in/i.test(error.message))throw error;try{return await protocol.planRoute?.(i)??null;}catch{throw error;}}},buildRouteStep,validateRouteStep,observeRouteStep,async preparationKey(i){const row=await market(i.token,i.platformId);return JSON.stringify([row.phase,row.quoteAsset,row.sourceUpdatedAt]);},async positions(token,wallet,options={}){const row=await market(token,options.platformId);if(row.phase!=='graduated')return protocol.positions(token,wallet,options);const state=await protocol.getTokenState(token,options),asset=state.addressKind==='market'?state.tokenAddress:token;check(state.phase==='graduated'&&address(asset),'外盘实际代币尚未核验');return{token,assetToken:asset,address:wallet,balance:String(await balance(asset,wallet)),decimals:Number(await read(asset,ERC20,'decimals',[])),positionKind:'token',allowance:null,spender:null,verified:true};}};
}
