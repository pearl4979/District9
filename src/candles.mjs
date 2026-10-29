import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getJson as fetchJson, check, same } from './market-utils.mjs';
import { validateCandleBefore, validateCandleCurrency } from './candle-query.mjs';
import { createGangHistory } from './candle-history.mjs';
import { createChartCurrency } from './chart-currency.mjs';
import { GANG_CANDLE_RESOLUTIONS, normalizeGangCandles, pageGangCandles } from './gang-candles.mjs';

export const INTERVALS = { '1s':1000, '5s':5000, '15s':15000, '1min': 60_000, '5min': 300_000, '15min': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const addressOk = a => typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a) && !/^0x0{40}$/i.test(a);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

// Upstream endpoint/array layout adapted from ai-wallet-binance, MIT.
// See THIRD_PARTY_NOTICES.md. Validation and source separation are local additions.
export function normalizeCandles(response, now = Date.now()) {
  check(response && Array.isArray(response.data), 'K线接口返回格式无效');
  check(response.status?.error_code === undefined || String(response.status.error_code) === '0', 'K线接口报告错误');
  const rows = new Map();
  for (const input of response.data.slice(-300)) {
    check(Array.isArray(input) && input.length >= 6, 'K线数据行不完整');
    const [o,h,l,c] = input.slice(0,4).map(Number), v=input[4]===null?null:Number(input[4]);
    const t = Number(input[5]);
    check([o,h,l,c,t].every(Number.isFinite) && (v===null||Number.isFinite(v)&&v>=0) && Math.min(o,h,l,c) > 0 && l <= Math.min(o,c) && h >= Math.max(o,c) && h >= l, 'K线OHLCV数值无效');
    check(Number.isSafeInteger(t) && t >= 1e12 && t <= now + 60_000, 'K线时间无效');
    rows.set(t,{t,o,h,l,c,v});
  }
  return [...rows.values()].sort((a,b)=>a.t-b.t);
}

export function aggregateSamples(points, intervalMs) {
  const rows = new Map();
  for(const {t,p} of points) {
    const bucket = Math.floor(t / intervalMs) * intervalMs;
    const row = rows.get(bucket);
    if(row) { row.h=Math.max(row.h,p); row.l=Math.min(row.l,p); row.c=p; }
    else rows.set(bucket,{t:bucket,o:p,h:p,l:p,c:p,v:null});
  }
  return [...rows.values()].sort((a,b)=>a.t-b.t).slice(-300);
}

// 仅合并真实的小周期柱；从不拆分分钟柱，不补造无成交的秒。
export function aggregateCandles(candles, intervalMs) {
  const rows=new Map();
  for(const c of candles) {
    const t=Math.floor(c.t/intervalMs)*intervalMs, old=rows.get(t);
    if(old){old.h=Math.max(old.h,c.h);old.l=Math.min(old.l,c.l);old.c=c.c;old.v=old.v===null||c.v===null?null:old.v+c.v;}
    else rows.set(t,{...c,t});
  }
  return [...rows.values()].slice(-300);
}

// 后端标准序列：按固定时间桶补齐前收，Volume=0；不篡改真实成交桶。
// 未知采样成交量仍为null。可选初始价只在已经核验且覆盖起点时使用。
export function forwardFillCandles(candles,intervalMs,{until=Date.now(),start,initialPrice,limit=300,volumeKnown=true}={}) {
  const source=aggregateCandles(candles,intervalMs);
  const hasInitial=Number.isFinite(initialPrice)&&initialPrice>0;
  if(!source.length&&!hasInitial)return [];
  const end=Math.max(source.at(-1)?.t??0,Math.floor(until/intervalMs)*intervalMs);
  const first=hasInitial&&Number.isFinite(start)?Math.floor(start/intervalMs)*intervalMs:source[0]?.t??end;
  const begin=Math.max(first,end-(limit-1)*intervalMs),out=[];
  let cursor=0,last=hasInitial?{c:initialPrice,v:volumeKnown?0:null}:null;
  while(cursor<source.length&&source[cursor].t<begin)last=source[cursor++];
  for(let t=begin;t<=end;t+=intervalMs) {
    if(cursor<source.length&&source[cursor].t===t){last=source[cursor++];out.push(last);}
    else if(last)out.push({t,o:last.c,h:last.c,l:last.c,c:last.c,v:volumeKnown?0:null,idle:true});
  }
  return out;
}

function validEventTime(value,now) {
  const t=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
  return Number.isSafeInteger(t)&&t>=1e12&&t<=now+60_000?t:null;
}
function eventMetadata(token,now) {
  if(token.phase!=='graduated')return null;
  const supplied=token.graduationEvent,at=validEventTime(supplied?.at,now),created=Date.parse(token.createdAt);
  if(supplied?.proof==='chain-event'&&supplied.verified===true&&at!==null&&(!Number.isFinite(created)||at>=created)&&Number.isSafeInteger(supplied.blockNumber)&&supplied.blockNumber>0&&/^0x[0-9a-f]{64}$/i.test(supplied.txHash||'')&&Number.isSafeInteger(supplied.logIndex)&&supplied.logIndex>=0)return{at,timestamp:new Date(at).toISOString(),proof:'chain-event',verified:true,blockNumber:supplied.blockNumber,txHash:supplied.txHash,logIndex:supplied.logIndex};
  const hint=validEventTime(token.graduatedAt,now);
  return hint!==null&&(!Number.isFinite(created)||hint>=created)?{at:hint,timestamp:new Date(hint).toISOString(),proof:'official-index',verified:false,blockNumber:null,txHash:null,logIndex:null}:null;
}
function nativeCompatible(token,interval) {
  return token.platformId==='gang'&&Object.hasOwn(GANG_CANDLE_RESOLUTIONS,interval)&&(token.positionKind??'token')==='token'&&(token.launchType==='curve-v3'?token.nativeCandleUnitVerified===true&&token.quoteDecimals===18:!token.launchType&&(['v1','v2'].includes(token.pad)||['u','s'].includes(token.pad)&&token.quoteDecimals===18&&addressOk(token.quoteAsset)));
}
function annotate(data,token,mode,now=Date.now()) {
  const supply=Number(token.chartSupply), nativePrice=Number(token.graduationPrice);
  const fx=data.priceUnit==='USD'?Number(token.valuationQuoteUsd):1;
  const value=nativePrice*(mode==='marketcap'?supply:1)*fx;
  const initial=Number(token.initialPrice)*(mode==='marketcap'?supply:1);
  const initialKnown=data.source==='gang-trades'&&!data.historyTruncated&&Number.isFinite(Date.parse(token.createdAt))&&Number.isFinite(initial)&&initial>0;
  const seriesKey=JSON.stringify([token.address.toLowerCase(),data.chartAddress?.toLowerCase()??null,token.platformId,token.pad??null,token.launchType??null,data.source==='gang-candles'?'whole-journey-native':token.phase,token.positionKind??null,token.quoteAsset?.toLowerCase()??null,data.source,data.interval,mode,data.priceUnit,data.capBasis??(mode==='marketcap'?'FDV':'price'),mode==='marketcap'?token.chartSupply??null:null,token.platformId==='gang'&&token.launchType==='fair'?data.coverage?.excludedBefore??null:null]);
  return {...data,mode,phase:token.phase,quoteAsset:token.quoteAsset??null,quoteSymbol:token.quoteSymbol??null,positionKind:token.positionKind??'token',seriesKey,graduationEvent:eventMetadata(token,now),...(initialKnown?{seriesStartAt:token.createdAt,initialValue:initial}:{}),graduation:data.capBasis!=='source'&&Number.isFinite(value)&&value>0?{value,label:token.graduationLabel||'理论毕业线',note:token.graduationNote,referenceFx:data.priceUnit==='USD'}:null};
}

export function createCandleService({ snapshot, getJson = fetchJson, now = Date.now, cachePath, maxMarkets = 512, maxSamples = 512, currencyService } = {}) {
  const histories = new Map(), indexed = new Map(), pending = new Map();
  const annotateFor=(data,token,mode)=>annotate(data,token,mode,now());
  const currencies=currencyService||createChartCurrency({getJson,now});
  const gangHistory=createGangHistory({getJson,now});
  maxMarkets=Math.min(512,Math.max(1,maxMarkets)); maxSamples=Math.min(4096,Math.max(1,maxSamples));
  let active = 0, dirty = false, flushing;
  const trim = map => { while(map.size>maxMarkets) map.delete(map.keys().next().value); };

  function ingest(data) {
    for(const token of (data.tokens || []).toReversed()) {
      if(!token.verified || !addressOk(token.address) || token.phase !== 'bonding') continue;
      const source = data.monitor?.sources?.find(s=>s.id===token.platformId);
      if(source?.status==='error') continue;
      const t=Date.parse(token.sourceUpdatedAt || data.monitor?.updatedAt), p=Number(token.price);
      if(!Number.isFinite(t) || t>now()+1000 || now()-t>90_000 || !Number.isFinite(p) || p<=0) continue;
      const id=token.address.toLowerCase(), unit=token.priceUnit || token.quoteSymbol;
      if(typeof unit!=='string' || !unit || unit.length>48) continue;
      let entry=histories.get(id);
      if(entry && (entry.unit!==unit || entry.platformId!==token.platformId)) entry=null;
      if(entry && t<=entry.points.at(-1)?.t) continue;
      if(!entry) entry={address:token.address,platformId:token.platformId,unit,points:[]};
      entry.points.push({t,p}); entry.points=entry.points.slice(-maxSamples);
      histories.delete(id);histories.set(id,entry);trim(histories);dirty=true;
    }
  }
  function observe(data=snapshot()) { return data?.then ? data.then(ingest) : ingest(data); }

  function samples(token, interval, mode, warning = null, before) {
    const entry=histories.get(token.address.toLowerCase());
    const matches=entry?.unit===(token.priceUnit||token.quoteSymbol) && entry?.platformId===token.platformId;
    const points=matches ? entry.points.filter(p=>before===undefined||p.t<before) : [];
    const supply=Number(token.chartSupply), known=Number.isFinite(supply)&&supply>0;
    const candles=mode==='marketcap'&&!known?[]:aggregateSamples(points,INTERVALS[interval]).map(c=>mode==='price'?c:{...c,o:c.o*supply,h:c.h*supply,l:c.l*supply,c:c.c*supply});
    const end=before!==undefined?Math.floor((before-1)/INTERVALS[interval])*INTERVALS[interval]:Math.floor((points.length&&now()-points.at(-1).t>90_000?points.at(-1).t:now())/INTERVALS[interval])*INTERVALS[interval];
    const first=candles.length?Math.max(candles[0].t,end-299*INTERVALS[interval]):null;
    return annotateFor({ kind:candles.length?'samples':'empty', source:'local-curve', sourceLabel:'本地链上曲线采样', priceUnit:mode==='marketcap'?token.quoteSymbol||'未知':token.priceUnit||token.quoteSymbol||'未知', volumeUnit:null,
      address:token.address, chartAddress:null, interval, candles, samples:points.length, updatedAt:points.length?new Date(points.at(-1).t).toISOString():null,
      startedAt:points.length?new Date(points[0].t).toISOString():null, stale:points.length?now()-points.at(-1).t>90_000:false,
      pagination:{nextBefore:first,hasMore:first!==null&&points.some(p=>p.t<first),scope:'retained-samples',reason:'retained-window-only'},
      warning:mode==='marketcap'&&!known?'供应量未核验，暂不能显示市值。':warning || '曲线采样，非历史成交K线；仅记录本机已观察价格，源通常15–60秒刷新，秒周期不代表逐秒成交，成交量未知。' },token,mode);
  }

  async function gangTrades(token,interval,mode,before) {
    const template=annotateFor({address:token.address,chartAddress:token.address,interval,source:'gang-trades',priceUnit:token.quoteSymbol},token,mode);
    const history=await gangHistory.read(token,INTERVALS[interval],template.seriesKey,before);
    if(before===undefined&&history.partial)throw new Error(history.reason);
    const supply=Number(token.chartSupply);check(mode==='price'||Number.isFinite(supply)&&supply>0,'供应量未核验');
    const scale=mode==='marketcap'?supply:1;
    const candles=aggregateCandles(history.rows.map(r=>({t:r.t,o:r.p*scale,h:r.p*scale,l:r.p*scale,c:r.p*scale,v:r.v})),INTERVALS[interval]);
    return annotateFor({address:token.address,chartAddress:token.address,interval,kind:history.rows.length?'trades':'empty',source:'gang-trades',sourceLabel:'Gang 官方成交',historyTruncated:history.more,historyPartial:history.partial,priceUnit:token.quoteSymbol,volumeUnit:token.quoteSymbol,candles,updatedAt:new Date(now()).toISOString(),lastCandleAt:candles.length?new Date(candles.at(-1).t).toISOString():null,stale:history.partial,
      pagination:{nextBefore:history.partial&&history.more?before??null:candles[0]?.t??null,hasMore:history.more,scope:'official-trades',reason:history.reason},
      warning:history.partial?'历史暂不可用；'+history.reason:`本次读取${history.rows.length}笔内盘成交${history.more?'；可继续加载更早记录':''}；无成交时沿用前收，量为0。${mode==='marketcap'?'市值按价格 × 最大供应量计算 FDV。':''}`},token,mode);
  }

  async function gangCandles(token,interval,mode) {
    const resolution=GANG_CANDLE_RESOLUTIONS[interval];
    const merged=['curve-v3','fair'].includes(token.launchType);
    check(nativeCompatible(token,interval),'Gang官方K线来源或原币单位未核验');
    const path=merged?'v3/tokens/':token.pad==='v1'?'tokens/':'stocks/tokens/';
    if(['u','s'].includes(token.pad)) {
      const metadata=await getJson(`https://gang.fun/api/${path}${token.address}`,{timeoutMs:4000,limit:512*1024});
      check(metadata?.track==='stocks'&&same(metadata.address,token.address)&&same(metadata.quoteAddress,token.quoteAsset),'Gang旧轨官方K线资产或报价币不匹配');
    }
    const response=await getJson(`https://gang.fun/api/${path}${token.address}/candles?res=${resolution}`,{timeoutMs:4000,limit:2*1024*1024});
    const raw=normalizeGangCandles(response,INTERVALS[interval],now());
    check(raw.length>0,'Gang官方暂未返回K线');
    const supply=Number(token.chartSupply),scale=mode==='marketcap'?supply:1;
    check(Number.isFinite(scale)&&scale>0,'供应量未核验');
    const candles=raw.map(c=>({...c,o:c.o*scale,h:c.h*scale,l:c.l*scale,c:c.c*scale}));
    check(candles.every(c=>[c.o,c.h,c.l,c.c].every(n=>Number.isFinite(n)&&n>0)),'Gang官方K线换算超出范围');
    return annotateFor({address:token.address,chartAddress:token.address,interval,kind:'trades',source:'gang-candles',sourceLabel:'Gang 官方综合走势',semantics:'official-composite-reference',timeline:'activity',continuous:false,coverage:{scope:'official-window',from:candles[0].t,to:candles.at(-1).t,complete:false,reason:'official-retained-window'},
      priceUnit:token.quoteSymbol,volumeUnit:candles.some(c=>c.v===null)?null:token.quoteSymbol,capBasis:mode==='marketcap'?'FDV':'price',candles,
      updatedAt:new Date(now()).toISOString(),lastCandleAt:new Date(candles.at(-1).t).toISOString(),stale:false,
      warning:`官方综合走势包含内盘、毕业后DEX及可能的实时池价参考锚点；不等于逐笔成交记录。仅官方返回窗口，不声明覆盖全部历史。${mode==='marketcap'?'市值按官方原币价格 × 已核验最大供应量计算 FDV，未用当前汇率换算历史美元。':''}`},token,mode);
  }

  async function indexedWindow(chartAddress,interval,mode,supply,{before,fairCut}={}) {
    const knownSupply=Number.isFinite(supply)&&supply>0,url=new URL('https://dquery.sintral.io/u-kline/v1/k-line/candles');
    for(const[k,v]of Object.entries({platform:'bsc',address:chartAddress,interval:INTERVALS[interval]<60_000?'1s':interval,limit:300,pm:mode==='marketcap'&&!knownSupply?'m':'p'}))url.searchParams.set(k,String(v));
    if(before!==undefined)url.searchParams.set('to',String(before-1));
    const response=await getJson(url.href,{timeoutMs:6000,limit:512*1024});
    check(Array.isArray(response?.data)&&response.data.length<=300,'索引K线窗口格式或条数无效');
    let candles=normalizeCandles(response,now());
    if(before!==undefined&&candles.some(c=>c.t>=before))throw Object.assign(Error('索引忽略历史游标'),{reason:'indexed-cursor-ignored'});
    const sourceHasMore=response.data.length===300;
    if(INTERVALS[interval]>1000&&INTERVALS[interval]<60_000) {
      const first=candles[0]?.t,completeFrom=(Math.floor(first/INTERVALS[interval])+(sourceHasMore&&first%INTERVALS[interval]!==0?1:0))*INTERVALS[interval];
      // A capped 1s page can begin inside a larger bucket. Keep that bucket
      // behind the cursor so the next source window can aggregate it fully.
      candles=aggregateCandles(candles,INTERVALS[interval]).filter(c=>c.t>=completeFrom);
    }
    if(fairCut!==undefined&&fairCut!==null)candles=candles.filter(c=>c.t>=fairCut);
    if(mode==='marketcap'&&knownSupply)candles=candles.map(c=>({...c,o:c.o*supply,h:c.h*supply,l:c.l*supply,c:c.c*supply}));
    return {candles,sourceHasMore:sourceHasMore&&(fairCut==null||candles[0]?.t>fairCut)};
  }

  async function getRaw(address, interval='1min', mode='price', {before}={}) {
    validateCandleBefore(before,now());
    check(addressOk(address),'代币地址无效'); check(Object.hasOwn(INTERVALS,interval),'不支持的K线周期');
    check(['price','marketcap'].includes(mode),'不支持的K线指标');
    const data=await snapshot();
    const rows=(data.tokens||[]).filter(t=>t.verified===true && same(t.address,address));
    check(rows.length===1,'只能查询当前已核验的唯一市场');
    const token=rows[0];
    if(token.platformId==='gang'&&!token.launchType&&['u','s'].includes(token.pad)&&mode==='marketcap'&&!(Number.isFinite(Number(token.chartSupply))&&Number(token.chartSupply)>0))return annotateFor({address:token.address,chartAddress:token.address,interval,kind:'empty',source:'gang-cap-unavailable',sourceLabel:'供应量待核验',priceUnit:token.quoteSymbol||'未知',volumeUnit:null,candles:[],updatedAt:null,stale:false,coverage:{scope:'unavailable',complete:false,reason:'supply-unverified'},warning:'代币供应量未链上核验，暂不能把历史价格换算成市值。',pagination:{nextBefore:null,hasMore:false,scope:'unavailable',reason:'supply-unverified'}},token,mode);
    // Fair mint values are allocation reference amounts, not ERC20 trades.
    // No index or retained sample may manufacture a tradable pre-launch series.
    if(token.platformId==='gang'&&token.launchType==='fair'&&token.phase!=='graduated')return annotateFor({address:token.address,chartAddress:null,interval,kind:'empty',source:'gang-fair-pending',sourceLabel:'Fair 打新中',priceUnit:token.quoteSymbol||'未知',volumeUnit:null,candles:[],updatedAt:null,stale:false,warning:'Fair 打新阶段，暂无可核验的 ERC20 成交K线或市值。',pagination:{nextBefore:null,hasMore:false,scope:'unavailable',reason:'prelaunch-not-traded'}},token,mode);
    const fair=token.platformId==='gang'&&token.launchType==='fair',launchTime=fair?eventMetadata(token,now())?.at??null:null;
    if(fair&&launchTime===null)return annotateFor({address:token.address,chartAddress:null,interval,kind:'empty',source:'gang-fair-history-unavailable',sourceLabel:'Fair 发射时间待核验',priceUnit:token.quoteSymbol||'未知',volumeUnit:null,candles:[],updatedAt:null,stale:false,coverage:{scope:'unavailable',complete:false,reason:'fair-launch-time-unavailable'},warning:'Fair 发射时间未知，暂不能安全划分申购参考与 ERC20 成交行情。',pagination:{nextBefore:null,hasMore:false,scope:'unavailable',reason:'fair-launch-time-unavailable'}},token,mode);
    const fairCut=fair?(Math.floor(launchTime/INTERVALS[interval])+1)*INTERVALS[interval]:null;
    ingest(data);
    const chartAddress=token.platformId==='flap' ? (token.phase==='graduated' && addressOk(token.tokenAddress) ? token.tokenAddress : null) : token.address;
    if(!chartAddress) return samples(token,interval,mode,null,before);
    const key=JSON.stringify([address.toLowerCase(),chartAddress.toLowerCase(),token.platformId,token.pad,token.launchType,nativeCompatible(token,interval)?'whole-journey-native':token.phase,token.positionKind,token.quoteAsset?.toLowerCase(),fairCut,interval,mode,token.chartSupply,token.priceUnit,token.quoteSymbol]);
    const cacheMs=INTERVALS[interval]<60_000?2000:5000;
    const old=indexed.get(key);
    if(before!==undefined) {
      if(!old)return annotateFor({address:token.address,chartAddress,interval,kind:'empty',source:'history-unavailable',sourceLabel:'历史游标不可用',priceUnit:token.priceUnit||token.quoteSymbol,volumeUnit:null,candles:[],historyPartial:true,stale:true,warning:'请先刷新当前行情，再重新加载历史。',pagination:{nextBefore:null,hasMore:false,scope:'current-window',reason:'cursor-unavailable'}},token,mode);
      const latest=old.data;
      if(latest.source==='local-curve')return samples(token,interval,mode,null,before);
      if(latest.source==='gang-candles')return annotateFor(latest,token,mode);
      if(latest.source==='gang-trades') {
        const historyKey=`${key}:before:${before}`;
        if(pending.has(historyKey))return pending.get(historyKey);
        check(active<4,'K线请求繁忙，请稍后重试');active++;
        const task=gangTrades(token,interval,mode,before).finally(()=>{active--;pending.delete(historyKey);});
        pending.set(historyKey,task);return task;
      }
      if(latest.source==='binance-public') {
        const historyKey=`indexed-history:${latest.seriesKey}:${before}`,retained=indexed.get(historyKey)?.data??latest;
        const candles=retained.candles.filter(c=>c.t<before);
        if(candles.length||!retained.pagination?.hasMore||fair&&before<=fairCut)return {...retained,candles,pagination:{...retained.pagination,nextBefore:candles[0]?.t??null,hasMore:retained.pagination?.hasMore===true&&(!fair||before>fairCut)}};
        if(pending.has(historyKey))return pending.get(historyKey);
        check(active<4,'K线请求繁忙，请稍后重试');active++;
        const task=(async()=>{
          try {
            const result=await indexedWindow(chartAddress,interval,mode,Number(token.chartSupply),{before,fairCut});
            const data={...latest,candles:result.candles,kind:result.candles.length?'trades':'empty',volumeUnit:result.candles.some(c=>c.v===null)?null:'source-reported',updatedAt:new Date(now()).toISOString(),lastCandleAt:result.candles.length?new Date(result.candles.at(-1).t).toISOString():null,stale:false,
              coverage:{...latest.coverage,scope:'indexed-history',from:result.candles[0]?.t??null,to:result.candles.at(-1)?.t??null,complete:false,truncated:result.sourceHasMore},
              pagination:{nextBefore:result.candles[0]?.t??null,hasMore:result.sourceHasMore,scope:'indexed-window',reason:result.sourceHasMore?'more-indexed-history':'indexed-history-unavailable'}};
            indexed.set(historyKey,{data,expires:now()+cacheMs});trim(indexed);return data;
          }catch(error){return {...latest,kind:'empty',candles:[],historyPartial:true,stale:true,warning:'历史成交K线读取失败，缺口保持未知；当前最新行情未被替换。',coverage:{...latest.coverage,scope:'unavailable',complete:false,reason:error.reason??'indexed-upstream-unavailable'},pagination:{nextBefore:before,hasMore:true,scope:'indexed-window',reason:error.reason??'indexed-upstream-unavailable'}};}
          finally{active--;pending.delete(historyKey);}
        })();pending.set(historyKey,task);return task;
      }
      const candles=latest.candles.filter(c=>c.t<before);
      return {...latest,candles,pagination:{nextBefore:candles[0]?.t??null,hasMore:false,scope:'indexed-window',reason:'indexed-history-unavailable'}};
    }
    if(old && old.expires>now()&&(old.data.source==='gang-candles'||old.data.phase===token.phase)) return annotateFor(old.data,token,mode);
    if(pending.has(key)) return pending.get(key);
    check(active<4,'K线请求繁忙，请稍后重试'); active++;
    const task=(async()=>{
      try {
        if(nativeCompatible(token,interval)) {
          try {const result=await gangCandles(token,interval,mode);indexed.delete(key);indexed.set(key,{data:result,expires:now()+cacheMs});trim(indexed);return result;}
          catch {if(old?.data.source==='gang-candles'&&old.data.kind==='trades')throw new Error('Gang官方K线刷新失败');}
        }
        if(token.platformId==='gang'&&token.phase==='bonding'&&!token.launchType&&INTERVALS[interval]<60_000) {
          try {const result=await gangTrades(token,interval,mode);if(result.candles.length||result.initialValue){indexed.set(key,{data:result,expires:now()+2000});trim(indexed);return result;}}catch{/* 固定公开索引作为回退。 */}
        }
        const supply=Number(token.chartSupply), knownSupply=Number.isFinite(supply)&&supply>0;
        const {candles,sourceHasMore}=await indexedWindow(chartAddress,interval,mode,supply,{fairCut});
        if(!candles.length&&fair){
          if(old?.data.kind==='trades')throw Error('Fair 发射后索引未返回行情');
          const result=annotateFor({address:token.address,chartAddress,interval,kind:'empty',source:'binance-public',sourceLabel:'Fair 发射后行情',priceUnit:'USD',volumeUnit:null,candles:[],updatedAt:null,stale:false,coverage:{scope:'indexed-window',complete:false,excludedBefore:fairCut,reason:'fair-mint-not-erc20-trades'},warning:'Fair 打新申购期没有 ERC20 成交K线；发射所在时间桶已保守排除，当前窗口尚无后续成交。',pagination:{nextBefore:null,hasMore:false,scope:'indexed-window',reason:'fair-postlaunch-empty'}},token,mode);
          indexed.set(key,{data:result,expires:now()+cacheMs});trim(indexed);return result;
        }
        if(!candles.length) {
          if(token.platformId==='gang'&&token.phase==='bonding'&&!token.launchType&&INTERVALS[interval]>=60_000) {const result=await gangTrades(token,interval,mode);if(result.candles.length||result.initialValue&&old?.data.kind!=='trades'){indexed.set(key,{data:result,expires:now()+cacheMs});trim(indexed);return result;}}
          if(old?.data.kind==='trades') throw new Error('索引暂未返回K线');
          const result=samples(token,interval,mode); if(!result.candles.length)result.warning='行情源尚未收录此币；等待成交记录或本地曲线采样。';
          indexed.set(key,{data:result,expires:now()+cacheMs});trim(indexed);return result;
        }
        const coverage={scope:'indexed-window',from:candles[0]?.t??null,to:candles.at(-1)?.t??null,complete:false,truncated:sourceHasMore,...(fair?{excludedBefore:fairCut,reason:'fair-mint-not-erc20-trades'}:{reason:'indexed-retained-window'})};
        const pagination={nextBefore:candles[0]?.t??null,hasMore:sourceHasMore,scope:'indexed-window',reason:sourceHasMore?'more-indexed-history':'indexed-history-unavailable'};
        const result=annotateFor({address:token.address,chartAddress,interval,kind:'trades',source:'binance-public',sourceLabel:'Binance Web3 公开行情',priceUnit:'USD',volumeUnit:candles.some(c=>c.v===null)?null:'source-reported',capBasis:knownSupply?'FDV':'source',coverage,pagination,...(fair?{semantics:'post-launch-erc20-trades'}:{}),candles,updatedAt:new Date(now()).toISOString(),lastCandleAt:new Date(candles.at(-1).t).toISOString(),stale:false,warning:(fair?'Fair 申购期不是 ERC20 成交；已保守排除发射所在时间桶。 ':'')+(mode==='marketcap'?(knownSupply?'市值 = 历史价格 × 最大供应量（FDV），不代表流通市值。':'供应量未核验，采用行情源市值口径。'):'')},token,mode);
        indexed.delete(key);indexed.set(key,{data:result,expires:now()+cacheMs});trim(indexed);return result;
      } catch {
        const result=old?.data.kind==='trades' ? annotateFor({...old.data,stale:true,warning:'K线读取失败，正在显示上次取得的数据，请留意更新时间。'},token,mode) : fair?annotateFor({address:token.address,chartAddress,interval,kind:'empty',source:'gang-fair-history-unavailable',sourceLabel:'Fair 发射后行情不可用',priceUnit:token.quoteSymbol||'未知',volumeUnit:null,candles:[],updatedAt:null,stale:true,coverage:{scope:'unavailable',complete:false,excludedBefore:fairCut,reason:'fair-postlaunch-unavailable'},pagination:{nextBefore:null,hasMore:false,scope:'unavailable',reason:'fair-postlaunch-unavailable'},warning:'Fair 发射后成交行情读取失败；申购参考不会替代 ERC20 成交K线。'},token,mode):samples(token,interval,mode,'成交K线读取失败；当前为本地曲线采样，不代表成交记录，成交量未知。');
        indexed.set(key,{data:result,expires:now()+cacheMs});trim(indexed);return result;
      } finally {active--;pending.delete(key);}
    })(); pending.set(key,task); return task;
  }

  async function get(address,interval='1min',mode='price',options={}) {
    const {before,currency}=options;validateCandleCurrency(currency);
    const data=await getRaw(address,interval,mode,options);
    let page;
    if(data.historyPartial)page={...data,candles:[],continuous:data.continuous!==false};
    else if(data.source==='gang-candles')page={...data,...pageGangCandles(data.candles,before),timeline:'activity',continuous:false};
    else {
      const until=before!==undefined?Math.floor((before-1)/INTERVALS[interval])*INTERVALS[interval]:data.stale?Date.parse(data.lastCandleAt||data.updatedAt):now();
      const candles=forwardFillCandles(data.candles,INTERVALS[interval],{until:Number.isFinite(until)?until:now(),volumeKnown:data.volumeUnit!==null,start:Date.parse(data.seriesStartAt),initialPrice:before===undefined?data.initialValue:undefined});
      let pagination=data.pagination??{nextBefore:candles[0]?.t??null,hasMore:false,scope:'indexed-window',reason:'indexed-history-unavailable'};
      // Fixed-time filling can trim away real rows even when the complete
      // fetched source window contains fewer than 300 activity candles.
      if(data.source==='binance-public') {
        const retainedOlder=Boolean(candles.length&&data.candles.some(row=>row.t<candles[0].t)),hasMore=retainedOlder||pagination.hasMore===true;
        pagination={...pagination,hasMore,...(retainedOlder?{reason:'more-retained-indexed-window'}:{})};
        if(hasMore&&candles.length){indexed.set(`indexed-history:${data.seriesKey}:${candles[0].t}`,{data,expires:now()+300_000});trim(indexed);}
      }
      page={...data,pagination:{...pagination,nextBefore:candles[0]?.t??pagination.nextBefore},...(data.kind==='empty'&&candles.length?{kind:'initial',sourceLabel:'Gang 初始曲线参考',warning:'暂无成交；使用已核验的池子初始价格延续，成交量为0。'}:{}),candles,continuous:true};
    }
    return currency===undefined?page:currencies.convert(page,currency,{quoteAsset:data.quoteAsset,quoteSymbol:data.quoteSymbol,positionKind:data.positionKind});
  }

  async function restore() {
    if(!cachePath)return;
    try {
      check((await stat(cachePath)).size<=MAX_CACHE_BYTES,'采样缓存过大');
      const data=JSON.parse(await readFile(cachePath,'utf8')); check(data.version===1 && Array.isArray(data.markets),'采样缓存格式错误');
      for(const raw of data.markets.slice(-maxMarkets)) {
        if(!addressOk(raw.address)||!['four','gang','flap'].includes(raw.platformId)||typeof raw.unit!=='string'||raw.unit.length>48||!Array.isArray(raw.points))continue;
        const points=raw.points.slice(-maxSamples).filter(p=>finite(p.t)&&Number.isSafeInteger(p.t)&&p.t>=1e12&&p.t<=now()+1000&&finite(p.p)&&p.p>0).sort((a,b)=>a.t-b.t);
        if(points.length)histories.set(raw.address.toLowerCase(),{address:raw.address,platformId:raw.platformId,unit:raw.unit,points});
      }
    } catch { /* Invalid public caches do not prevent monitoring or transactions. */ }
  }
  async function flush() {
    if(flushing)return flushing;
    if(!cachePath||!dirty)return;
    const data=JSON.stringify({version:1,markets:[...histories.values()]}); check(Buffer.byteLength(data)<=MAX_CACHE_BYTES,'采样缓存达到大小限制');
    dirty=false;
    flushing=(async()=>{try {await mkdir(dirname(cachePath),{recursive:true});await writeFile(`${cachePath}.tmp`,data,{mode:0o600});await rename(`${cachePath}.tmp`,cachePath);}catch(e){dirty=true;throw e;}finally{flushing=null;}})();
    return flushing;
  }
  return {get,observe,restore,flush};
}
