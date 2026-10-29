import {check} from './market-utils.mjs';

// Official offset pagination is not a stable snapshot. Every continuation starts
// one row early and finds the previous page's full time/transaction anchor.
// New trades can move that anchor inside the bounded page; an anchor outside
// the page is reported, never joined into invented historical OHLCV.
export function createGangHistory({getJson,now}) {
  const cursors=new Map(), ttl=5*60_000, maxOffset=20_000, maxRows=1000;
  const keyOf=r=>[r.tx,r.side,r.ts,r.tokens,r.price,r.quoteIn??r.bnb].join(':');
  const purge=()=>{for(const [k,v]of cursors)if(v.expires<=now())cursors.delete(k);while(cursors.size>64)cursors.delete(cursors.keys().next().value);};
  function remember(seriesKey,before,state) {
    if(!Number.isSafeInteger(before)||(!state.more&&!state.rows.some(r=>r.t<before)))return;
    purge();cursors.delete(`${seriesKey}:${before}`);
    cursors.set(`${seriesKey}:${before}`,{...state,rows:state.rows.filter(r=>r.t<before),expires:now()+ttl});purge();
  }
  async function read(token,intervalMs,seriesKey,before) {
    purge();
    const stored=before===undefined?null:cursors.get(`${seriesKey}:${before}`);
    if(before!==undefined&&!stored)return {rows:[],more:false,partial:true,reason:'cursor-expired'};
    const state=stored?{...stored,rows:[...stored.rows]}:{rows:[],offset:0,anchor:null,more:true};
    try {
      for(let page=0;page<4&&state.more;page++) {
        if(state.offset>=maxOffset)return {rows:[],more:false,partial:true,reason:'history-offset-limit'};
        const offset=state.offset?state.offset-1:0;
        const prefix=token.pad==='v2'?'stocks/':'';
        const response=await getJson(`https://gang.fun/api/${prefix}tokens/${token.address}/trades?limit=200&offset=${offset}&sort=ts_desc`,{timeoutMs:2000,limit:512*1024});
        check(Array.isArray(response.items)&&response.items.length<=200,'Gang成交记录格式错误');
        const parsed=response.items.map(raw=>{
          const t=Number(raw.ts)*1000,p=Number(raw.price),v=Number(raw.quoteIn??raw.bnb);
          check(Number.isSafeInteger(t)&&t>=1e12&&t<=now()+1000&&Number.isFinite(p)&&p>0&&Number.isFinite(v)&&v>=0,'Gang成交记录数值错误');
          return {t,p,v,key:keyOf(raw)};
        });
        check(parsed.every((r,i)=>i===0||r.t<=parsed[i-1].t),'Gang成交时间顺序错误');
        const anchorIndex=state.anchor?parsed.findIndex(r=>r.key===state.anchor):-1;
        if(state.anchor&&anchorIndex<0)return {rows:[],more:false,partial:true,reason:'offset-anchor-changed'};
        const seen=new Set(state.rows.map(r=>r.key));
        // Ignore the anchor and every newer prefix row. The anchor was already
        // fetched; only strictly subsequent official rows extend this snapshot.
        const continuation=state.anchor?parsed.slice(anchorIndex+1):parsed;
        for(const row of continuation)if(!seen.has(row.key)){seen.add(row.key);state.rows.push(row);}
        if(state.rows.length>maxRows)return {rows:[],more:false,partial:true,reason:'history-retention-limit'};
        state.more=response.hasMore===true;
        if(state.more) {
          check(parsed.length>0&&Number.isSafeInteger(response.nextOffset)&&response.nextOffset>state.offset&&response.nextOffset<=offset+200,'Gang成交分页错误');
          state.offset=response.nextOffset;state.anchor=parsed.at(-1).key;
        }
        // All buckets newer than the oldest fetched bucket are complete. Only
        // continue when history has not yet reached a complete requested bucket.
        const oldest=state.rows.at(-1)?.t;
        if(before!==undefined&&(!state.more||(oldest!==undefined&&Math.floor(oldest/intervalMs)*intervalMs<before-intervalMs)))break;
      }
    } catch {return {rows:[],more:true,partial:true,reason:'upstream-unavailable'};}
    const oldest=state.rows.at(-1)?.t;
    const completeFrom=state.more&&oldest!==undefined?(Math.floor(oldest/intervalMs)+1)*intervalMs:0;
    const eligible=state.rows.filter(r=>r.t>=completeFrom&&(before===undefined||r.t<before));
    if(!eligible.length&&state.more) {
      if(before!==undefined)remember(seriesKey,before,state);
      return {rows:[],more:true,partial:true,reason:'history-page-budget'};
    }
    const end=Math.floor((before===undefined?now():before-1)/intervalMs)*intervalMs;
    const first=eligible.length?Math.max(Math.floor(eligible.at(-1).t/intervalMs)*intervalMs,end-299*intervalMs):null;
    const more=state.more||(first!==null&&state.rows.some(r=>r.t<first));
    if(first!==null)remember(seriesKey,first,state);
    // Reverse latest-first official rows before the stable chronological sort,
    // preserving the existing same-second trade ordering.
    const rows=[...eligible].reverse().sort((a,b)=>a.t-b.t);
    return {rows,more,partial:false,reason:state.more?'more-official-trades':more?'retained-official-window':'source-exhausted',nextBefore:first};
  }
  return {read};
}
