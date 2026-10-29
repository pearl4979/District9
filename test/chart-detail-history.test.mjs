import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const source=await readFile(new URL('../public/token-detail.js',import.meta.url),'utf8');
const T=1_800_000_000_000,A=`0x${'a'.repeat(40)}`,B=`0x${'b'.repeat(40)}`;
const bar=(t,c=2)=>({t,o:c,h:c+.5,l:c-.5,c,v:3});
const token=address=>({address,name:'Fixture',symbol:'FIX',platformId:'gang',phase:'bonding',priceUnit:'WBNB'});
const pageData=(address,rows,key='native')=>({address,mode:'marketcap',candles:rows,seriesKey:key,source:'fixture',sourceLabel:'Fixture',kind:'trades',priceUnit:key==='usd'?'USD':'WBNB',volumeUnit:'WBNB',stale:true,updatedAt:new Date(T).toISOString(),lastCandleAt:new Date(rows.at(-1)?.t||T).toISOString(),pagination:{hasMore:true,nextBefore:rows[0]?.t??null,scope:'official-trades',reason:null}});
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
async function fixture({holdHistory=false,timeline=null}={}){
 const {window,document}=parseHTML(html),requests=[],sets=[],pending=[];let chartCallbacks,latestKey='native',latestClose=2,historyResponse=null,latestTimeline=timeline,latestExtra={};
 window.HTMLElement.prototype.scrollIntoView=function(){};
 window.createTokenInsights=()=>({open(){},close(){}});
 window.AgentCandleChart={create(host,callbacks){chartCallbacks=callbacks;return {setData(rows,options){sets.push({rows:structuredClone(rows),options});},clear(){},reset(){},focusTime(){return false;}};}};
 const api=async(path,body,options)=>{
  requests.push({path,body,options});const u=new URL(path,'http://local'),address=u.searchParams.get('token');
  if(u.searchParams.has('before')){
   if(holdHistory)return new Promise(resolve=>pending.push(resolve));
   if(historyResponse)return historyResponse;
   return {...pageData(address,[bar(T-60000)],latestKey),mode:u.searchParams.get('mode'),timeline:latestTimeline};
  }
  return {...pageData(address,[bar(T,latestClose),bar(T+60000,latestClose+1)],latestKey),mode:u.searchParams.get('mode'),timeline:latestTimeline,...latestExtra};
 };
 vm.runInContext(source,vm.createContext({window,document,URL,Intl,Date,AbortController,setTimeout:()=>1,clearTimeout(){},console}));
 const detail=window.createTokenDetail({api,avatar(){return document.createElement('span');},copy(){},canClose:()=>true,onBack(){},onTrade(){},onSelect(){}});
 return {window,document,detail,requests,sets,pending,get callbacks(){return chartCallbacks;},setLatest(key,close=2){latestKey=key;latestClose=close;},setExtra(value){latestExtra=value;},setTimeline(value){latestTimeline=value;},setHistory(value){historyResponse=value;},$:id=>document.getElementById(id)};
}
test('reference chart starts with marketcap one-minute candles and keeps a real wallet-avatar control',async()=>{
 const p=await fixture();p.detail.open(token(A));await settle();
 assert.match(p.requests[0].path,/interval=1min/);assert.match(p.requests[0].path,/mode=marketcap/);
 assert.equal(p.document.querySelector('[data-chart-mode="marketcap"]').getAttribute('aria-pressed'),'true');
 assert.ok(p.$('chart-wallet-avatars'));assert.equal(p.$('chart-wallet-avatars').checked,true);
 assert.equal(typeof p.callbacks.onHistoryNeeded,'function');
});
test('the chart identifies prior-close display and exposes original source OHLC in hover details',async()=>{
 const p=await fixture();p.detail.open(token(A));await settle();
 assert.match(p.$('chart-unit').textContent,/连续开盘/);
 p.callbacks.onHover({t:T+60000,o:11,h:15,l:11,c:14,v:6,display:'prior-close',raw:{o:14,h:15,l:13,c:14}});
 assert.match(p.$('chart-ohlc').textContent,/O 11.*H 15.*L 11.*C 14/,'the legend describes the OHLC actually drawn');
 assert.match(p.$('chart-ohlc').title,/原始.*O 14.*H 15.*L 13.*C 14/);
 assert.match(p.$('chart-ohlc').title,/开盘沿前收/);
});
test('older history merges once by timestamp, latest polling keeps it, and the view receives a stable series identity',async()=>{
 const p=await fixture();p.detail.open(token(A));await settle();
 await p.callbacks.onHistoryNeeded({before:T,seriesKey:p.sets.at(-1).options.seriesKey});await settle();
 assert.match(p.requests.at(-1).path,/before=1800000000000/);
 assert.deepEqual(p.sets.at(-1).rows.map(c=>c.t),[T-60000,T,T+60000]);
 p.setLatest('native',5);p.$('chart-refresh').click();await settle();
 const rows=p.sets.at(-1).rows;assert.equal(rows.length,3);assert.equal(rows[0].t,T-60000);assert.equal(rows.at(-1).c,6);assert.equal(rows.at(-1).v,3);
 assert.equal(p.requests.filter(r=>!r.path.startsWith('/api/candles?')).length,0,'chart interactions issue no wallet/trade requests');
});
test('a history request is cancelled on token switch and its late response cannot pollute the new chart',async()=>{
 const p=await fixture({holdHistory:true});p.detail.open(token(A));await settle();
 const loading=p.callbacks.onHistoryNeeded({before:T,seriesKey:p.sets.at(-1).options.seriesKey});await settle();
 const request=p.requests.at(-1);assert.match(request.path,/before=/);
 p.detail.open(token(B));await settle();assert.equal(request.options.signal.aborted,true);
 p.pending[0](pageData(A,[bar(T-60000,999)]));await loading;await settle();
 assert.ok(p.sets.at(-1).rows.every(c=>c.c!==999));assert.match(p.requests.at(-1).path,new RegExp(B));
});
test('a source/unit identity change discards incompatible older bars and reports the transition',async()=>{
 const p=await fixture();p.detail.open(token(A));await settle();
 await p.callbacks.onHistoryNeeded({before:T,seriesKey:p.sets.at(-1).options.seriesKey});
 p.setLatest('usd',5000);p.$('chart-refresh').click();await settle();
 assert.deepEqual(p.sets.at(-1).rows.map(c=>c.t),[T,T+60000]);assert.equal(p.sets.at(-1).options.priceUnit,'USD');
 assert.match(p.$('chart-series-status').textContent,/切换|分段|口径/);
});
test('an expired history cursor stays recoverable after a successful older page, rather than masquerading as exhausted history',async()=>{
 const p=await fixture();p.detail.open(token(A));await settle();
 await p.callbacks.onHistoryNeeded({before:T,seriesKey:p.sets.at(-1).options.seriesKey});
 p.setHistory({...pageData(A,[]),historyPartial:true,pagination:{hasMore:false,nextBefore:null,scope:'official-trades',reason:'cursor-expired'}});
 await p.callbacks.onHistoryNeeded({before:T-60000,seriesKey:p.sets.at(-1).options.seriesKey});await settle();
 assert.equal(p.$('chart-history-load').hidden,false);assert.equal(p.$('chart-history-load').textContent,'重新载入');
 assert.match(p.$('chart-history-status').textContent,/过期/);assert.doesNotMatch(p.$('chart-history-status').textContent,/已到当前可用历史边界/);
 assert.equal(p.sets.at(-1).rows.length,3,'failure retains the currently loaded chart');
 p.$('chart-history-load').click();await settle();
 assert.equal(new URL(p.requests.at(-1).path,'http://local').searchParams.has('before'),false,'explicit recovery restarts from a current verified window');
 assert.equal(p.sets.at(-1).rows.length,2);assert.equal(p.$('chart-history-load').hidden,false);
});

test('native activity timeline defaults to real candles and toggles locally without a fetch or source identity change',async()=>{
 const p=await fixture({timeline:'activity'});p.detail.open(token(A));await settle();
 const original=p.sets.at(-1),requestCount=p.requests.length;
 assert.equal(original.options.timeMode,'activity');assert.equal(p.$('chart-timeline-toggle').hidden,false);assert.equal(p.$('chart-timeline-toggle').getAttribute('aria-pressed'),'false');
 assert.match(p.$('chart-timeline-status').textContent,/成交时段.*无成交区间压缩/);
 p.$('chart-timeline-toggle').click();await settle();
 assert.equal(p.requests.length,requestCount,'a display projection cannot fetch new market or wallet data');
 assert.deepEqual(p.sets.at(-1).rows,original.rows);assert.equal(p.sets.at(-1).options.seriesKey,original.options.seriesKey);assert.equal(p.sets.at(-1).options.timeMode,'continuous');assert.equal(p.sets.at(-1).options.reset,false);
 assert.equal(p.$('chart-timeline-toggle').getAttribute('aria-pressed'),'true');assert.match(p.$('chart-timeline-status').textContent,/连续时间.*空桶沿前收/);
 p.$('chart-refresh').click();await settle();assert.equal(p.sets.at(-1).options.timeMode,'continuous','polling retains the selected local display mode');
 await p.callbacks.onHistoryNeeded({before:T,seriesKey:original.options.seriesKey});await settle();assert.equal(p.sets.at(-1).options.timeMode,'continuous');assert.equal(p.sets.at(-1).options.seriesKey,original.options.seriesKey);assert.equal(p.sets.at(-1).rows.length,3);
 p.$('chart-timeline-toggle').click();await settle();assert.equal(p.sets.at(-1).options.timeMode,'activity');assert.equal(p.sets.at(-1).rows.length,3);
});

test('activity-only controls disappear for fixed-time sources and a new native source starts in activity time',async()=>{
 const p=await fixture({timeline:'activity'});p.detail.open(token(A));await settle();p.$('chart-timeline-toggle').click();
 p.setTimeline(null);p.setLatest('indexed');p.$('chart-refresh').click();await settle();
 assert.equal(p.sets.at(-1).options.timeMode,'continuous');assert.equal(p.$('chart-timeline-toggle').hidden,true);
 p.setTimeline('activity');p.setLatest('native-return');p.$('chart-refresh').click();await settle();
 assert.equal(p.sets.at(-1).options.timeMode,'activity');assert.equal(p.$('chart-timeline-toggle').hidden,false);assert.equal(p.$('chart-timeline-toggle').getAttribute('aria-pressed'),'false');
 p.$('chart-timeline-toggle').click();p.detail.open(token(B));await settle();assert.equal(p.sets.at(-1).options.timeMode,'activity','another wallet signal asset cannot inherit a continuous-time override');
});

test('BNB/USD is independent of Price/MCap and propagates to older requests while cancelling the previous currency',async()=>{
 const p=await fixture({holdHistory:true});p.detail.open(token(A));await settle();
 assert.equal(new URL(p.requests[0].path,'http://local').searchParams.get('currency'),'BNB');
 assert.equal(p.document.querySelector('[data-chart-currency="BNB"]').getAttribute('aria-pressed'),'true');
 const loading=p.callbacks.onHistoryNeeded({before:T,seriesKey:p.sets.at(-1).options.seriesKey});await settle();
 const oldRequest=p.requests.at(-1);assert.match(oldRequest.path,/currency=BNB/);
 p.setLatest('usd',900);p.document.querySelector('[data-chart-currency="USD"]').click();await settle();
 assert.equal(oldRequest.options.signal.aborted,true);
 const request=new URL(p.requests.at(-1).path,'http://local');assert.equal(request.searchParams.get('currency'),'USD');assert.equal(request.searchParams.get('mode'),'marketcap');
 p.pending[0](pageData(A,[bar(T-60000,999)]));await loading;await settle();assert.ok(p.sets.at(-1).rows.every(c=>c.c!==999));
 p.document.querySelector('[data-chart-mode="price"]').click();await settle();
 assert.equal(new URL(p.requests.at(-1).path,'http://local').searchParams.get('currency'),'USD');
 assert.equal(new URL(p.requests.at(-1).path,'http://local').searchParams.get('mode'),'price');
 assert.equal(p.sets.at(-1).options.mode,'price');
});

test('historical-rate estimates and official composite semantics remain visible with original volume units',async()=>{
 const p=await fixture();p.setExtra({semantics:'official-composite-reference',currency:'BNB',priceUnit:'BNB',currencyConversion:{status:'estimated',warning:'按每根K线历史汇率折算，估算值'}});p.detail.open(token(A));await settle();
 assert.equal(p.$('chart-currency-status').hidden,false);assert.match(p.$('chart-currency-status').textContent,/历史.*估算|估算.*历史/);
 assert.match(p.$('chart-unit').textContent,/官方综合行情/);assert.doesNotMatch(p.$('chart-unit').textContent,/成交K线/);
 assert.match(p.$('chart-ohlc').textContent,/等待行情/,'fixture has no synthetic hover');
 assert.equal(p.sets.at(-1).options.volumeKnown,true);assert.equal(p.sets.at(-1).rows[0].v,3);
});

test('a response for a different requested currency cannot render under the selected currency button',async()=>{
 const p=await fixture();p.setExtra({currency:'USD',priceUnit:'USD'});p.detail.open(token(A));await settle();
 assert.equal(p.sets.at(-1).rows.length,0);assert.match(p.$('chart-empty-message').textContent,/计价|归属/);
});

test('a recent FX tail delay is visible and stops continuous projection at the last converted bucket',async()=>{
 const p=await fixture({timeline:'activity'});p.setExtra({currency:'BNB',priceUnit:'BNB',endAt:T,stale:true,currencyConversion:{status:'estimated',partial:true,warning:'尾部历史汇率待更新'}});p.detail.open(token(A));await settle();
 assert.match(p.$('chart-currency-status').textContent,/尾部.*待更新/);p.$('chart-timeline-toggle').click();
 assert.equal(p.sets.at(-1).options.until,T,'the renderer must not project unconverted FX to the present');
});

test('missing FX on an older page preserves loaded bars and exposes a retry rather than changing currency or exhausting history',async()=>{
 const p=await fixture();p.detail.open(token(A));await settle();const current=p.sets.at(-1),count=p.sets.length;
 p.setHistory({...pageData(A,[],'unavailable-usd'),currencyConversion:{status:'unavailable',warning:'这段历史缺少对应汇率'},pagination:{hasMore:false,reason:'currency-unavailable'}});
 await p.callbacks.onHistoryNeeded({before:T,seriesKey:current.options.seriesKey});await settle();
 assert.equal(p.sets.length,count);assert.deepEqual(p.sets.at(-1).rows,current.rows);
 assert.equal(p.$('chart-history-load').hidden,false);assert.match(p.$('chart-history-status').textContent,/汇率.*保留/);
 assert.doesNotMatch(p.$('chart-history-status').textContent,/已到当前可用历史边界/);
});

test('a latest FX outage retains only previously converted bars with the identical source and currency basis',async()=>{
 const p=await fixture();p.setExtra({currency:'BNB',priceUnit:'BNB',currencyConversion:{status:'estimated',basisKey:'same-asset-source-supply-bnb'}});p.detail.open(token(A));await settle();
 const original=p.sets.at(-1),count=p.sets.length;
 p.setLatest('fx-unavailable');p.setExtra({currency:'BNB',priceUnit:'BNB',candles:[],currencyConversion:{status:'unavailable',basisKey:'same-asset-source-supply-bnb',warning:'历史汇率来源暂时不可用'}});p.$('chart-refresh').click();await settle();
 assert.equal(p.sets.length,count);assert.deepEqual(p.sets.at(-1).rows,original.rows);assert.match(p.$('chart-currency-status').textContent,/汇率.*保留/);
 p.setExtra({currency:'BNB',priceUnit:'BNB',candles:[],currencyConversion:{status:'unavailable',basisKey:'different-supply-or-asset-bnb',warning:'新口径的汇率不可用'}});p.$('chart-refresh').click();await settle();
 assert.equal(p.sets.at(-1).rows.length,0,'a different source/asset/supply basis must not retain the old converted series');
});

test('graduation event is distinct from the horizontal target, follows adapter geometry and clears with the chart',async()=>{
 const e={at:T+15000,proof:'official-index',verified:false};
 const p=await fixture();p.setExtra({graduationEvent:e});p.detail.open({...token(A),phase:'graduated'});await settle();
 assert.deepEqual(p.sets.at(-1).options.graduationEvent,e);
 assert.equal(p.$('chart-graduation-locate').hidden,false);assert.match(p.$('chart-graduation-info').textContent,/毕业.*平台记录/);
 p.callbacks.onLayout({width:600,height:300,plotWidth:530,plotHeight:276,intervalMs:60000,buckets:[],graduationEvent:{...e,x:123,bucketTime:T}});
 assert.equal(p.$('chart-graduation-event').hidden,false);assert.equal(p.$('chart-graduation-event').style.left,'123px');assert.match(p.$('chart-graduation-event').textContent,/毕业/);
 p.callbacks.onLayout({width:600,height:300,plotWidth:530,plotHeight:276,buckets:[],graduationEvent:null});assert.equal(p.$('chart-graduation-event').hidden,true);
 p.$('chart-graduation-locate').click();assert.match(p.$('chart-graduation-info').textContent,/当前.*窗口|未加载/);
 p.detail.close();assert.equal(p.$('chart-graduation-event').hidden,true);
});

test('graduation line is included in the default view and can still be toggled off',async()=>{
 const p=await fixture();p.setExtra({graduation:{value:100}});p.detail.open({...token(A),phase:'graduated'});await settle();
 assert.equal(p.sets.at(-1).options.fitTarget,true);assert.equal(p.$('chart-fit-target').getAttribute('aria-pressed'),'true');
 p.$('chart-fit-target').click();assert.equal(p.sets.at(-1).options.fitTarget,false);
});
