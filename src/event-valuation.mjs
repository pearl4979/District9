// Display-only event references. Never quotes, current market caps or USD FX.
const FIELDS=new Set(['kind','value','unit','basis','source','blockNumber','timestamp']);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const validDecimals=n=>Number.isInteger(n)&&n>=0&&n<=36;
const decimal=value=>typeof value==='string'&&/^\d{1,90}(?:\.\d{1,36})?$/.test(value)&&BigInt(value.replace('.',''))>0n;
const timestamp=value=>typeof value==='string'?Date.parse(value):NaN;
const quoteUnit=value=>typeof value==='string'&&value.length>0&&value.length<=32&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);

function contract(event){
 if(!event||event.demo===true||event.confirmed!==true||event.phase!=='bonding'||!['buy','sell'].includes(event.side))return null;
 if(event.platformId==='four'&&event.source==='BSC four 原生TradeExecuted成功回执')return{basis:'FDV',source:'Four TradeExecuted.lastPrice × 已核验最大供应量；事件成交后 FDV（非流通市值）'};
 if(event.platformId==='flap'&&event.source==='BSC flap 原生VirtualTrade成功回执')return{basis:'share-equivalent-FDV',source:'Flap VirtualTrade.spotPriceAfter × 已核验最大等值供应量；事件后份额等值 FDV'};
 if(event.platformId==='gang'&&event.source===`BSC gang 原生${event.side==='buy'?'Buy':'Sell'}成功回执`)return{basis:'execution-FDV',source:event.side==='buy'?'Gang Buy 用户含费用成交均价 × 已核验最大供应量；非现货市值':'Gang Sell 用户到账成交均价 × 已核验最大供应量；非现货市值'};
 return null;
}

// Both fresh poll results and restored private event data pass this same gate.
export function normalizeEventValuation(value,event){
 const expected=contract(event),time=timestamp(event?.timestamp),at=timestamp(value?.timestamp);
 if(!expected||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!FIELDS.has(key))||value.kind!=='event-snapshot'||value.basis!==expected.basis||value.source!==expected.source||!decimal(value.value)||!quoteUnit(event.quoteSymbol)||value.unit!==event.quoteSymbol||!integer(event.blockNumber)||value.blockNumber!==event.blockNumber||!Number.isFinite(time)||at!==time)return null;
 return{kind:'event-snapshot',value:value.value,unit:value.unit,basis:expected.basis,source:expected.source,blockNumber:event.blockNumber,timestamp:new Date(time).toISOString()};
}

function rationalDecimal(numerator,denominator){
 if(numerator<=0n||denominator<=0n)return null;
 const whole=numerator/denominator;let remainder=numerator%denominator,fraction='';
 // Bounded deterministic precision. Truncation never overstates a reference.
 for(let i=0;i<36&&remainder>0n;i++){remainder*=10n;fraction+=String(remainder/denominator);remainder%=denominator;}
 fraction=fraction.replace(/0+$/,'');const value=String(whole)+(fraction?`.${fraction}`:'');
 return decimal(value)?value:null;
}

export function createNativeEventValuation({market,event,postPriceRaw=null,tokenRaw=null,quoteRaw=null,tokenDecimals,quoteDecimals}={}){
 const expected=contract(event),supply=market?.chartSupply;
 if(!expected||market?.verified!==true||market.platformId!==event.platformId||typeof market.address!=='string'||typeof event.tokenAddress!=='string'||market.address.toLowerCase()!==event.tokenAddress.toLowerCase()||!decimal(supply)||!validDecimals(tokenDecimals)||!validDecimals(quoteDecimals)||!quoteUnit(event.quoteSymbol)||typeof tokenRaw!=='bigint'||tokenRaw<=0n||typeof quoteRaw!=='bigint'||quoteRaw<0n)return null;
 const [whole,fraction='']=supply.split('.'),supplyRaw=BigInt(whole+fraction),supplyScale=10n**BigInt(fraction.length);
 let numerator,denominator;
 if(event.platformId==='gang'){
  if(typeof tokenRaw!=='bigint'||tokenRaw<=0n||typeof quoteRaw!=='bigint'||quoteRaw<=0n)return null;
  numerator=quoteRaw*supplyRaw*10n**BigInt(tokenDecimals);denominator=tokenRaw*10n**BigInt(quoteDecimals)*supplyScale;
 }else{
  if(typeof postPriceRaw!=='bigint'||postPriceRaw<=0n)return null;
  numerator=postPriceRaw*supplyRaw;denominator=10n**BigInt(quoteDecimals)*supplyScale;
 }
 const value=rationalDecimal(numerator,denominator);if(!value)return null;
 return normalizeEventValuation({kind:'event-snapshot',value,unit:event.quoteSymbol,...expected,blockNumber:event.blockNumber,timestamp:event.timestamp},event);
}
