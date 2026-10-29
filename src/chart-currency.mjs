import {getJson as fetchJson} from './market-utils.mjs';

const WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',ZERO=`0x${'0'.repeat(40)}`;
const INTERVALS={'1s':1000,'5s':5000,'15s':15000,'1min':60000,'5min':300000,'15min':900000,'1h':3600000,'4h':14400000,'1d':86400000};
const address=value=>typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value)?value.toLowerCase():null;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const sameRow=(a,b)=>a.every((value,index)=>value===b[index]);

// Chart display only: each canonical bucket uses one historical close scalar.
// This cannot reconstruct the USD highs/lows of individual underlying trades.
export function createChartCurrency({getJson=fetchJson,now=Date.now,ttlMs=5000,maxEntries=32,maxPages=16}={}){
 const cache=new Map(),pending=new Map();let active=0;
 const ttl=Number.isFinite(ttlMs)?Math.max(1,Math.min(60000,ttlMs)):5000;
 const capacity=Number.isSafeInteger(maxEntries)?Math.max(1,Math.min(64,maxEntries)):32;
 const pageBudget=Number.isSafeInteger(maxPages)?Math.max(1,Math.min(16,maxPages)):16;
 const trim=()=>{while(cache.size>capacity)cache.delete(cache.keys().next().value);};

 async function window(asset,interval,to){
  const key=`${asset}:${interval}:${to??'latest'}`,stored=cache.get(key);
  if(stored&&stored.expires>now())return stored.value;
  if(pending.has(key))return pending.get(key);
  if(active>=4)return{rates:null,reason:'historical-capacity',from:null,to:null,rows:0};
  active++;
  const task=(async()=>{
   let value={rates:null,reason:'historical-upstream-unavailable',from:null,to:null,rows:0};
   try{
    const intervalMs=INTERVALS[interval],rawInterval=intervalMs<60000?'1s':interval,rawMs=INTERVALS[rawInterval];
    const url=new URL('https://dquery.sintral.io/u-kline/v1/k-line/candles');
    for(const[k,v]of Object.entries({platform:'bsc',address:asset,interval:rawInterval,limit:300,pm:'p'}))url.searchParams.set(k,String(v));
    // Binance's documented limit + to cursor uses milliseconds and includes
    // the bucket at to. Never substitute a current rate for an older window.
    if(to!==undefined)url.searchParams.set('to',String(to));
    const response=await getJson(url.href,{timeoutMs:6000,limit:512*1024});
    if(!response||!Array.isArray(response.data)||response.data.length>300||(response.status?.error_code!==undefined&&String(response.status.error_code)!=='0'))throw Error('Invalid historical FX response');
    const rows=new Map(),rejected=new Set(),timestamps=[];
    for(const input of response.data){
     if(!Array.isArray(input)||input.length<6)throw Error('Invalid historical FX row');
     const [o,h,l,c]=input.slice(0,4).map(Number),v=input[4]===null?null:Number(input[4]),t=Number(input[5]);
     if(!Number.isSafeInteger(t)||t<1e12||t>now()||t%rawMs!==0)throw Error('Invalid historical FX time');
     if(to!==undefined&&t>to){value.reason='historical-window-invalid';throw Error('Historical FX cursor ignored');}
     timestamps.push(t);
     if(![o,h,l,c].every(positive)||l>Math.min(o,c)||h<Math.max(o,c)||h<l||(v!==null&&(!Number.isFinite(v)||v<0))){rejected.add(Math.floor(t/intervalMs)*intervalMs);continue;}
     const normalized=[o,h,l,c,v,t],old=rows.get(t);
     if(old&&!sameRow(old,normalized)){rejected.add(Math.floor(t/intervalMs)*intervalMs);continue;}
     rows.set(t,normalized);
    }
    const ordered=[...rows.values()].sort((a,b)=>a[5]-b[5]),rates=new Map();
    for(const row of ordered)if(!rejected.has(Math.floor(row[5]/intervalMs)*intervalMs))rates.set(Math.floor(row[5]/intervalMs)*intervalMs,row[3]);
    value={rates,from:timestamps.length?Math.min(...timestamps):null,to:timestamps.length?Math.max(...timestamps):null,rows:timestamps.length,rejectedBuckets:[...rejected].sort((a,b)=>a-b),reason:timestamps.length?'historical-window':'historical-source-empty'};
   }catch{/* Missing or malformed FX cannot be replaced by a current quote. */}
   cache.delete(key);cache.set(key,{value,expires:now()+Math.min(ttl,INTERVALS[interval])});trim();return value;
  })().finally(()=>{active--;pending.delete(key);});
  pending.set(key,task);return task;
 }

 async function rates(asset,interval,times){
  const intervalMs=INTERVALS[interval],rawMs=intervalMs<60000?1000:intervalMs,remaining=[...times].sort((a,b)=>a-b),found=new Map(),windows=[],rejected=new Set();
  let targets=remaining,reason='historical-buckets-missing',truncated=false;
  while(targets.length&&windows.length<pageBudget){
   const last=targets.at(-1),end=Math.min(last+intervalMs-rawMs,Math.floor(now()/rawMs)*rawMs);
   const to=windows.length===0&&end>=Math.floor(now()/rawMs)*rawMs-299*rawMs?undefined:end;
   const page=await window(asset,interval,to);
   windows.push({requestedTo:to??null,from:page.from,to:page.to,rows:page.rows});
   for(const t of page.rejectedBuckets??[])rejected.add(t);
   if(!page.rates){reason=page.reason;break;}
   for(const t of times)if(positive(page.rates.get(t))&&!found.has(t))found.set(t,page.rates.get(t));
   if(!page.rows){reason=page.reason;break;}
   // Missing buckets inside an examined window stay unknown. Only request
   // older windows for requested native buckets earlier than its first row.
   targets=targets.filter(t=>!found.has(t)&&t<Math.floor(page.from/intervalMs)*intervalMs);
   if(!targets.length)break;
  }
  const missingBuckets=times.filter(t=>!found.has(t));
  if(targets.length&&windows.length>=pageBudget&&windows.at(-1)?.rows){reason='history-page-budget';truncated=true;}
  if(!missingBuckets.length)reason='complete';
  return{rates:found,coverage:{asset,interval,rawInterval:rawMs<60000?'1s':interval,requestedFrom:Math.min(...times),requestedTo:Math.max(...times),requestedBuckets:times.length,matchedBuckets:times.length-missingBuckets.length,missingBuckets,rejectedBuckets:[...rejected].sort((a,b)=>a-b),pages:windows.length,pageLimit:300,maxPages:pageBudget,truncated,complete:!missingBuckets.length,reason,windows}};
 }

 async function convert(data,currency,{quoteAsset,quoteSymbol,positionKind}={}){
  if(!['BNB','USD'].includes(currency))throw Error('Unsupported chart currency / 币种');
  const unit=typeof data?.priceUnit==='string'?data.priceUnit:'',suffix=unit.endsWith('/份额')?'/份额':'',sourceUnit=suffix?unit.slice(0,-3):unit;
  const targetUnit=currency+suffix,intervalMs=INTERVALS[data?.interval],asset=address(quoteAsset),nativeAsset=asset===ZERO||asset===WBNB;
  // USD is the indexed source's declared fiat denomination. An ERC20 with the
  // same symbol still needs its own historical asset/USD rate.
  const fiatUsd=sourceUnit==='USD'&&data?.source==='binance-public';
  const nativeSymbol=['BNB','WBNB'].includes(sourceUnit),validSymbol=typeof quoteSymbol==='string'&&quoteSymbol.trim().length>0&&quoteSymbol.length<=48&&quoteSymbol===quoteSymbol.trim();
  const validQuote=fiatUsd||Boolean(asset&&validSymbol&&(nativeAsset?nativeSymbol&&['BNB','WBNB'].includes(quoteSymbol):!nativeSymbol&&!['BNB','WBNB'].includes(quoteSymbol)&&sourceUnit===quoteSymbol));
  const identity=JSON.stringify([data?.seriesKey??[data?.address,data?.chartAddress,data?.interval,data?.mode],data?.source,asset,unit,positionKind??null,data?.capBasis??null,currency,'historical-bucket-close']);
  let fxCoverage=null,convertedGraduation=null;
  const result=(candles,status,warning,missingBuckets=[])=>{
   const unavailable=status==='unavailable',estimated=status==='estimated';
   return {...data,currency,priceUnit:targetUnit,sourcePriceUnit:unit,candles,seriesKey:JSON.stringify([identity,status]),
    ...(unavailable?{kind:'empty',continuous:false,historyPartial:true,sourcePagination:data?.pagination??null,pagination:{hasMore:false,nextBefore:null,scope:'currency-unavailable',reason:'historical-fx-unavailable'}}:{}),
    ...(estimated||unavailable?{graduation:unavailable?null:convertedGraduation,...(positive(data?.graduation?.value)&&!convertedGraduation?{graduationUnavailable:'毕业参考线缺少对应时点的历史汇率，待更新。'}:{})}:{}),
    ...(warning?{warning:[data?.warning,warning].filter(Boolean).join(' ')}:{}),
    currencyConversion:{status,basisKey:identity,requestedCurrency:currency,sourceUnit:unit,method:estimated||unavailable?'historical-bucket-close':'identity',fxSource:estimated||unavailable?'Binance Web3 公开历史 USD K线':null,missingBuckets,coverage:fxCoverage,warning:warning||null}};
  };
  const unavailable=(missing=[],reason='缺少对应时间桶的历史汇率，当前页无法换算；没有使用当前汇率或补造中间行情。')=>result([],'unavailable',reason,missing);
  if(!data||!intervalMs||!Array.isArray(data.candles)||data.candles.length>5000||!validQuote||(suffix&&positionKind!=='shares'))return unavailable([],'行情单位或资产身份无法核验，当前页不能进行历史汇率换算。');
  const seen=new Set();
  for(const row of data.candles){
   if(!row||!Number.isSafeInteger(row.t)||row.t<1e12||row.t>now()||row.t%intervalMs!==0||seen.has(row.t)||!['o','h','l','c'].every(key=>positive(row[key]))||row.l>Math.min(row.o,row.c)||row.h<Math.max(row.o,row.c)||row.h<row.l||(row.v!==null&&(!Number.isFinite(row.v)||row.v<0)))return unavailable([],'行情时间桶或数值无效，无法安全换算历史汇率。');
   seen.add(row.t);
  }
  if(fiatUsd&&currency==='USD'||!fiatUsd&&nativeAsset&&currency==='BNB')return result(data.candles.map(row=>({...row})),'native',null);
  if(!data.candles.length)return result([],'estimated','历史汇率估算：按各时间桶的历史收盘汇率换算，不代表逐笔 USD/BNB 成交 OHLC。');
  const quoteRateNeeded=!fiatUsd,bnbRateNeeded=currency==='BNB';
  const eventAt=data.graduationEvent?.at;
  const referenceAt=positive(data.graduation?.value)?Math.floor((Number.isSafeInteger(eventAt)&&eventAt>=1e12&&eventAt<=now()?eventAt:data.candles.at(-1).t)/intervalMs)*intervalMs:null;
  const times=data.candles.map(row=>row.t),
   [quoteResult,bnbResult]=await Promise.all([quoteRateNeeded?rates(nativeAsset?WBNB:asset,data.interval,times):null,bnbRateNeeded?rates(WBNB,data.interval,times):null]);
  const quoteRates=quoteResult?.rates,bnbRates=bnbResult?.rates;
  if(referenceAt!==null){
   const [quoteReference,bnbReference]=await Promise.all([quoteRateNeeded&&!positive(quoteRates?.get(referenceAt))?rates(nativeAsset?WBNB:asset,data.interval,[referenceAt]):null,bnbRateNeeded&&!positive(bnbRates?.get(referenceAt))?rates(WBNB,data.interval,[referenceAt]):null]);
   const scalar=(quoteRateNeeded?quoteRates?.get(referenceAt)??quoteReference?.rates.get(referenceAt):1)/(bnbRateNeeded?bnbRates?.get(referenceAt)??bnbReference?.rates.get(referenceAt):1),value=data.graduation.value*scalar;
   if(positive(value))convertedGraduation={...data.graduation,value,referenceAt,referenceFx:false,historicalFx:true,note:[data.graduation.note,'按参考时点所在K线桶的历史收盘汇率换算；属于毕业参考价，不代表迁移成交价。'].filter(Boolean).join(' ')};
  }
  const missing=data.candles.filter(row=>quoteRateNeeded&&!positive(quoteRates?.get(row.t))||bnbRateNeeded&&!positive(bnbRates?.get(row.t))).map(row=>row.t);
  const assets=[quoteResult,bnbResult].filter(Boolean).map(result=>result.coverage);
  fxCoverage={complete:!missing.length,requestedFrom:Math.min(...times),requestedTo:Math.max(...times),requestedBuckets:times.length,matchedBuckets:times.length-missing.length,truncated:assets.some(asset=>asset.truncated),assets};
  let prefix=data.candles;
  if(missing.length){
   const currentBucket=Math.floor(now()/intervalMs)*intervalMs,firstMissing=data.candles.findIndex(row=>row.t===missing[0]);
   const ordered=data.candles.every((row,index)=>index===0||row.t>data.candles[index-1].t);
   // A just-published native tail may precede its USD FX feed. Never extend
   // this exception to an internal gap, an old tail or an entirely missing page.
   if(!ordered||firstMissing<=0||missing.length>2||missing.length!==data.candles.length-firstMissing||missing.some(t=>t<currentBucket-intervalMs||t>currentBucket))return unavailable(missing);
   prefix=data.candles.slice(0,firstMissing);
  }
  const candles=prefix.map(row=>{
   const scalar=(quoteRateNeeded?quoteRates.get(row.t):1)/(bnbRateNeeded?bnbRates.get(row.t):1);
   return {...row,o:row.o*scalar,h:row.h*scalar,l:row.l*scalar,c:row.c*scalar};
  });
  if(candles.some(row=>!['o','h','l','c'].every(key=>positive(row[key]))))return unavailable([],'历史汇率换算超出安全数值范围，当前页未显示换算结果。');
  const warning='历史汇率估算：按各时间桶的历史收盘汇率换算，不代表逐笔 USD/BNB 成交 OHLC；成交量保持原币单位。';
  const output=result(candles,'estimated',warning+(missing.length?' 尾部历史汇率待更新，暂仅显示已取得对应汇率的历史柱。':''),missing);
  if(!missing.length)return output;
  const endAt=candles.at(-1).t;
  return {...output,stale:true,endAt,lastCandleAt:new Date(endAt).toISOString(),...(data.lastCandleAt?{sourceLastCandleAt:data.sourceLastCandleAt??data.lastCandleAt}:{}),currencyConversion:{...output.currencyConversion,partial:true}};
 }
 return {convert};
}
