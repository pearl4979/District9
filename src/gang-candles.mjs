import {check} from './market-utils.mjs';

export const GANG_CANDLE_RESOLUTIONS = Object.freeze({
  '1min':'1m', '5min':'5m', '15min':'15m', '1h':'1h', '4h':'4h', '1d':'1d',
});
const MAX_ROWS=5000, PAGE_ROWS=300;
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;

// Gang returns native-quote OHLCV in ascending UTC seconds. Its official open
// can carry the preceding close across inactive time: never reconstruct it from
// recent trades, fill the gaps, or rewrite the source's values.
export function normalizeGangCandles(response,intervalMs,now=Date.now()) {
  check(Array.isArray(response)&&response.length<=MAX_ROWS,'Gang官方K线格式或条数无效');
  check(Number.isSafeInteger(intervalMs)&&intervalMs>=60_000,'Gang官方K线周期无效');
  const rows=[];
  for(const raw of response) {
    check(raw&&typeof raw==='object'&&!Array.isArray(raw),'Gang官方K线行无效');
    const {o,h,l,c,v}=raw,t=raw.t*1000;
    check([o,h,l,c].every(positive)&&l<=Math.min(o,c)&&h>=Math.max(o,c)&&h>=l,'Gang官方OHLC数值无效');
    check(v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0,'Gang官方成交量无效');
    check(typeof raw.t==='number'&&Number.isSafeInteger(raw.t)&&Number.isSafeInteger(t)&&t>=1e12&&t<=now+60_000&&t%intervalMs===0,'Gang官方K线时间无效');
    const previous=rows.at(-1);
    check(!previous||t>=previous.t,'Gang官方K线时间乱序');
    if(previous?.t===t) {
      check(['o','h','l','c','v'].every(field=>previous[field]===raw[field]),'Gang官方K线同时间数据冲突');
      continue;
    }
    rows.push({t,o,h,l,c,v,...(v===0&&o===h&&h===l&&l===c?{idle:true}:{})});
  }
  // A never-traded market still has a useful official reference. Do not remove
  // every anchor merely because an activity view will hide quiet rows.
  return rows.length&&rows.every(row=>row.idle)?[rows.at(-1)]:rows;
}

export function pageGangCandles(candles,before) {
  const eligible=before===undefined?candles:candles.filter(candle=>candle.t<before);
  const page=eligible.slice(-PAGE_ROWS),hasMore=eligible.length>page.length;
  return {candles:page,pagination:{nextBefore:page[0]?.t??null,hasMore,scope:'official-window',reason:hasMore?'more-official-window':'official-window-boundary'}};
}
