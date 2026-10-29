import{Interface,parseUnits,formatUnits}from'ethers';
import{check,same,ERC20,readContract}from'./market-utils.mjs';
import{verifiedQuoteAsset}from'./quote-asset-policy.mjs';
export const CONVERSION_ASSETS={GANG:'0x0c6302401aa5325c2e36f170f52c00b1d220b405',WBNB:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'};
const NATIVE='0x'+'e'.repeat(40),wbnb=new Interface(['function withdraw(uint256)','event Withdrawal(address indexed src,uint256 wad)']);
const amount=value=>{check(typeof value==='string'&&value.length<=80&&/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value),'兑换数量格式无效');const n=parseUnits(value,18);check(n>0n&&n<(1n<<256n),'兑换数量必须大于零');return n;};
export function createAssetConversionProtocol({protocol,baw,provider=protocol.provider,read=(...args)=>readContract(provider,...args),verifyAsset=verifiedQuoteAsset,now=Date.now}={}){
 const token=asset=>{check(typeof asset==='string'&&['GANG','WBNB'].includes(asset),'仅支持 GANG / WBNB 换回 BNB');return CONVERSION_ASSETS[asset];};
 const balance=(asset,wallet)=>same(asset,NATIVE)?provider.getBalance(wallet):read(asset,ERC20,'balanceOf',[wallet]);
 async function verify(asset){check((await provider.getNetwork()).chainId===56n,'兑换必须连接 BSC 主网');if(asset==='GANG')await verifyAsset({provider,address:token(asset),blockTag:await provider.getBlockNumber()});else check(await provider.getCode(token(asset))!=='0x','WBNB 合约不可用');}
 async function quote(input,from,raw){const q={walletAddress:input.walletAddress,fromToken:from,toToken:NATIVE,amount:formatUnits(raw,18),slippageBps:input.slippageBps};const result=await baw.marketQuote(q);check(amount(result.fromCoinAmount)===raw,'兑换报价输入数量不匹配');check(Number(result.slippage)===input.slippageBps/10000,'兑换报价滑点不匹配');const output=amount(result.toCoinAmount);return{...q,fromRaw:String(raw),toRaw:String(output),minimumRaw:String(output*BigInt(10000-input.slippageBps)/10000n),fromScale:'1',toScale:'1',fromDecimals:18,toDecimals:18,quotedAt:now(),fromSymbol:'GANG',toSymbol:'BNB',priceImpactBps:0};}
 async function quoted(input,from,raw){const full=await quote(input,from,raw),small=await quote(input,from,raw/2n);const out=BigInt(full.toRaw),ref=BigInt(small.toRaw),r=BigInt(small.fromRaw),loss=ref*raw-out*r,den=ref*(raw-r);check(den>0n,'兑换参考报价无效');full.priceImpactBps=loss>0n?Number((loss*10000n+den-1n)/den):0;check(full.priceImpactBps<=300,'兑换价格冲击超过 3%，请减小数量');return full;}
 async function balances(walletAddress){check(/^0x[0-9a-f]{40}$/i.test(walletAddress||''),'钱包地址无效');check((await provider.getNetwork()).chainId===56n,'兑换必须连接 BSC 主网');const rows=await Promise.all(Object.entries(CONVERSION_ASSETS).map(async([asset,address])=>({asset,address,balance:formatUnits(await balance(address,walletAddress),18)})));return{assets:rows,updatedAt:new Date(now()).toISOString()};}
 async function planAssetConversion(input){
  const from=token(input.asset),raw=amount(input.amount);check(/^0x[0-9a-f]{40}$/i.test(input.walletAddress||''),'钱包地址无效');check(Number.isInteger(input.slippageBps)&&input.slippageBps>=10&&input.slippageBps<=5000,'滑点范围无效');await verify(input.asset);
  const [owned,native,fee]=await Promise.all([balance(from,input.walletAddress),balance(NATIVE,input.walletAddress),provider.getFeeData()]);check(owned>=raw,'兑换代币余额不足');const gasPrice=fee.maxFeePerGas??fee.gasPrice;check(gasPrice>0n&&native>=gasPrice*1000000n,'BNB 不足以支付兑换 Gas');
  const q=input.asset==='GANG'?await quoted(input,from,raw):null,expected=q?.toRaw??String(raw),minimum=q?.minimumRaw??String(raw),deadline=Math.floor(now()/1000)+120;
  const steps=q?[{id:'convert',role:'market',label:'GANG → BNB · 币安聚合',quote:q,status:'PLANNED'}]:[{id:'unwrap',role:'unwrap',label:'WBNB → BNB · 1:1 解包',status:'PLANNED'}];
  return{kind:'asset-conversion',sourceAsset:input.asset,walletAddress:input.walletAddress,input:{token:from,platformId:'gang',side:'sell',amount:input.amount,slippageBps:input.slippageBps,settlement:'bnb'},quoteAsset:NATIVE,quoteSymbol:'BNB',assetToken:from,deadline,steps,protectedBalances:{[from]:String(owned),[NATIVE]:String(native)},originalMinimumOutputRaw:minimum,summary:{operation:'asset-conversion',symbol:input.asset,amount:input.amount,side:'sell',inputCurrency:input.asset,quoteSymbol:'BNB',expectedOutputRaw:expected,minimumOutputRaw:minimum,estimatedReceive:formatUnits(expected,18),minReceive:formatUnits(minimum,18),priceImpactBps:q?.priceImpactBps??0}};
 }
 async function validatePlan(p){check(now()<p.deadline*1000,'兑换报价已过期');check(same(p.assetToken,token(p.sourceAsset))&&same(p.input.token,p.assetToken)&&same(p.quoteAsset,NATIVE)&&p.input.side==='sell'&&/^0x[0-9a-f]{40}$/i.test(p.walletAddress||''),'兑换资产或钱包不匹配');amount(p.input.amount);await verify(p.sourceAsset);}
 async function buildRouteStep(p,s){
  if(p.kind!=='asset-conversion')return protocol.buildRouteStep(p,s);await validatePlan(p);const raw=amount(p.input.amount);check(await balance(p.assetToken,p.walletAddress)>=raw,'兑换余额不足');
  if(p.sourceAsset==='GANG'){check(s.role==='market','兑换步骤无效');const q=await quoted({...p.input,walletAddress:p.walletAddress},p.assetToken,raw);check(BigInt(q.toRaw)>=BigInt(p.originalMinimumOutputRaw),'最新兑换报价低于最低收到');return{kind:'market',marketInput:q,beforeFrom:String(await balance(p.assetToken,p.walletAddress)),beforeTo:String(await balance(NATIVE,p.walletAddress)),summary:{minimumOutputRaw:p.originalMinimumOutputRaw,expectedOutputRaw:q.toRaw,priceImpactBps:q.priceImpactBps}};}
  check(s.role==='unwrap','解包步骤无效');const transaction={from:p.walletAddress,to:CONVERSION_ASSETS.WBNB,value:'0',data:wbnb.encodeFunctionData('withdraw',[raw])};await provider.call(transaction);await provider.estimateGas(transaction);return{kind:'unwrap',transaction,summary:{inputRaw:String(raw),minimumOutputRaw:String(raw),expectedOutputRaw:String(raw)},beforeTo:String(await balance(NATIVE,p.walletAddress))};
 }
 async function validateRouteStep(p,s){
  if(p.kind!=='asset-conversion')return protocol.validateRouteStep(p,s);await validatePlan(p);const raw=amount(p.input.amount);
  if(p.sourceAsset==='GANG'){const q=s.marketInput;check(s.kind==='market'&&same(q.walletAddress,p.walletAddress)&&same(q.fromToken,p.assetToken)&&same(q.toToken,NATIVE)&&amount(q.amount)===raw&&q.slippageBps===p.input.slippageBps&&now()>=q.quotedAt&&now()-q.quotedAt<30000&&BigInt(q.toRaw)>=BigInt(p.originalMinimumOutputRaw),'聚合兑换参数已变化');}
  else{const parsed=wbnb.parseTransaction(s.transaction);check(s.kind==='unwrap'&&same(s.transaction.from,p.walletAddress)&&same(s.transaction.to,CONVERSION_ASSETS.WBNB)&&BigInt(s.transaction.value)===0n&&parsed?.name==='withdraw'&&parsed.args[0]===raw,'WBNB 解包参数已变化');}
  return{verified:true};
 }
 async function observeRouteStep(p,s,receipt,current={}){
  if(p.kind!=='asset-conversion')return protocol.observeRouteStep(p,s,receipt,current);
  if(p.sourceAsset==='GANG')return protocol.observeRouteStep({...p,kind:'binance-sequential'},s,receipt,current);
  let received=0n;for(const log of receipt.logs||[]){if(!same(log.address,CONVERSION_ASSETS.WBNB))continue;try{const event=wbnb.parseLog(log);if(event?.name==='Withdrawal'&&same(event.args.src,p.walletAddress))received+=event.args.wad;}catch{}}
  check(received===amount(p.input.amount),'回执未证明 WBNB 精确解包到账');const fee=BigInt(receipt.gasUsed||0)*BigInt(receipt.gasPrice||0);check(await balance(NATIVE,p.walletAddress)+fee>=BigInt(s.beforeTo)+received,'BNB 余额尚未支持解包到账');return{ownedAssets:{[NATIVE]:String(received)},retainedBalances:[{asset:NATIVE,symbol:'BNB',amountRaw:String(received),amount:formatUnits(received,18)}],completedImpactBps:0};
 }
 return{...protocol,conversionToken:token,conversionBalances:balances,planAssetConversion,buildRouteStep,validateRouteStep,observeRouteStep};
}
