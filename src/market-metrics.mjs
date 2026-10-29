import { formatUnits } from 'ethers';

// 只读展示指标。BigInt 计算曲线目标；不参与任何交易报价或最低收到计算。
const UNIT=10n**18n, VIRTUAL=1066666666666666666666666667n;
const positive=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>0;
const matches=(a,b)=>a>0n&&b>0n&&(a>b?a-b:b-a)*100n<=a; // 1% 容差仅用于识别展示模型
const result=(supply,target,decimals=18,initial=0n)=>({chartSupply:supply,initialPrice:initial>0n?formatUnits(initial,decimals):null,graduationPrice:target>0n?formatUnits(target,decimals):null,graduationLabel:'理论毕业线',graduationNote:'由当前链上曲线参数计算；非成交保证价，USD值随计价币参考汇率变化。'});
export function gangMetrics(curve,decimals=18) {
 const {virtualQuote:q,gradAmt:cap}=curve;
 return result('1000000000',q>0n&&cap>0n?(q+cap)**2n*UNIT/(q*VIRTUAL):0n,decimals,q>0n?q*UNIT/VIRTUAL:0n);
}
export function fourMetrics(cfg,snapshot) {
 let target=0n;
 if(snapshot.available) {
  const {initialQuoteLiquidity:q,initialTokenLiquidity:t,currentQuoteLiquidity:cq,currentTokenLiquidity:ct,lastPrice:p}=snapshot;
  const remaining=t-cfg.saleAmount;
  if(q>0n&&t>0n&&ct>0n&&remaining>0n&&matches(p,cq*UNIT/ct)&&matches(q*t,cq*ct))target=q*t*UNIT/(remaining*remaining);
 }
 return result(formatUnits(cfg.maxSupply,18).replace(/\.0$/,''),target);
}
export function flapMetrics(settings,detail,spot) {
 const {curveR:r,curveK:k,virtualReserveAtCapRaw:cap}=settings;
 const current=r+detail.curveReserveRaw;
 const target=k>0n&&cap>0n&&spot>0n&&matches(spot,current*current/k)?(r+cap)**2n/k:0n;
 return result('1000000000',target,Number(settings.quoteDecimals??18));
}
export function enrichMarketMetrics(tokens,{now=Date.now()}={}) {
 const fx=new Map();
  const fresh=t=>!t.sourceUnavailable&&(!t.sourceUpdatedAt||(Number.isFinite(Date.parse(t.sourceUpdatedAt))&&now-Date.parse(t.sourceUpdatedAt)<=90_000));
  for(const token of tokens)if(fresh(token)&&token.quoteAsset&&positive(token.valuationQuoteUsd))fx.set(token.quoteAsset.toLowerCase(),Number(token.valuationQuoteUsd));
  const nativeRate=fx.get('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
  if(nativeRate)fx.set('0x0000000000000000000000000000000000000000',nativeRate);
 return tokens.map(token=>{
    const quoteUsd=fresh(token)&&positive(token.valuationQuoteUsd)?Number(token.valuationQuoteUsd):fx.get(token.quoteAsset?.toLowerCase())||null;
  const native=positive(token.price)&&positive(token.chartSupply)?Number(token.price)*Number(token.chartSupply):null;
  const indexed=fresh(token)&&positive(token.indexedMarketCapUsd)?Number(token.indexedMarketCapUsd):null;
  const value=indexed??(native===null?null:native*(quoteUsd||1));
  const unit=indexed||quoteUsd?'USD':token.quoteSymbol||'未知';
  const label=(token.positionKind==='shares'&&token.phase!=='graduated'?'份额等值 FDV':token.phase==='graduated'&&!indexed&&token.priceSource!=='verified-pool'?'曲线参考 FDV':'FDV')+(fresh(token)?'':' · 旧数据');
  return {...token,valuationQuoteUsd:quoteUsd,marketCap:positive(value)?{value,unit,label,source:indexed?'平台公开索引':token.priceSource==='verified-pool'?'链上池价 × 总供应量':'曲线价 × 最大供应量',updatedAt:token.sourceUpdatedAt||null}:null};
 });
}
