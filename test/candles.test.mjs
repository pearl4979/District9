import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCandleService, normalizeCandles, aggregateSamples } from '../src/candles.mjs';

const address = '0x0000000000000000000000000000000000000011';
const launched = '0x0000000000000000000000000000000000000022';
const now = 1793088000000;
const market = (extra = {}) => ({ address, platformId: 'four', verified: true, tradable: true, phase: 'bonding', price: '0.00001', priceUnit: 'BNB', quoteSymbol: 'BNB', sourceUpdatedAt: new Date(now).toISOString(), ...extra });
const snapshot = token => () => ({ tokens: [token] });
const remote = data => ({ code: 0, data, status: { error_code: '0' } });

test('indexed OHLCV validates rows, timestamps and bounds without turning malformed responses into empty success', () => {
  const rows = [[2,4,1,3,10,now-60000], [3,5,2,4,20,now], [3,5,2,4,21,now]];
  const result = normalizeCandles(remote(rows), now);
  assert.equal(result.length, 2); assert.equal(result.at(-1).v, 21);
  assert.equal(result[0].t, now-60000);
  for(const bad of [[2,1,3,2,1,now], [1,2,0,1,0,now], [NaN,2,1,1,0,now], [1,2,1,1,-1,now]]) assert.throws(()=>normalizeCandles(remote([bad]),now));
  assert.throws(()=>normalizeCandles({data:{error:'oops'}},now));
  assert.throws(()=>normalizeCandles({status:{error_code:'429'},data:[]},now));
});

test('only verified market addresses and fixed intervals can issue a chart request', async () => {
  const requests=[];
  const service=createCandleService({ snapshot:snapshot(market()), now:()=>now, getJson:async url=>{requests.push(url);return remote([[1,2,1,2,3,now]]);} });
  await assert.rejects(()=>service.get(address,'../../bad'));
  await assert.rejects(()=>service.get(launched,'1min'));
  const chart=await service.get(address,'1min');
  assert.equal(requests.length,1);
  const url=new URL(requests[0]); assert.equal(url.origin,'https://dquery.sintral.io');
  assert.equal(url.searchParams.get('address'),address);
  assert.equal(chart.kind,'trades'); assert.equal(chart.priceUnit,'USD');
  assert.equal(chart.candles.length,1);
});

test('Flap unlaunched market is sampled as shares and never queries the market or predicted ERC20; launched chart uses actual CA', async () => {
  const calls=[]; let token=market({platformId:'flap', positionKind:'shares', predictedToken:launched, tokenAddress:null, priceUnit:'QQQB/份额'});
  const service=createCandleService({snapshot:()=>({tokens:[token]}),now:()=>now,getJson:async url=>{calls.push(url);return remote([[1,2,1,2,3,now]]);} });
  service.observe(); const chart=await service.get(address,'1min');
  assert.equal(calls.length,0); assert.equal(chart.kind,'samples'); assert.equal(chart.priceUnit,'QQQB/份额');
  assert.equal(chart.candles[0].v,null);
  token={...token,phase:'graduated',tokenAddress:launched};
  const next=await service.get(address,'1min');
  assert.equal(next.kind,'trades'); assert.equal(new URL(calls[0]).searchParams.get('address'),launched);
});

test('sample candles use observed values only, with no inferred volume or gap filling', () => {
  const result=aggregateSamples([{t:now,p:2},{t:now+20000,p:4},{t:now+40000,p:1},{t:now+3*60000,p:3}],60000);
  assert.equal(result.length,2);
  assert.deepEqual(result[0],{t:now,o:2,h:4,l:1,c:1,v:null});
  assert.equal(result[1].t,now+3*60000);
});

test('sample ingestion deduplicates source snapshots, ignores stale data, and persists bounded public history', async () => {
  const dir=await mkdtemp(join(tmpdir(),'agent-chart-'));
  try {
    let clock=now, token=market(); const options={snapshot:()=>({tokens:[token]}),now:()=>clock,cachePath:join(dir,'samples.json'),maxSamples:2,getJson:async()=>remote([])};
    const service=createCandleService(options);
    service.observe(); service.observe();
    clock+=20000; token={...token,price:'0.00002',sourceUpdatedAt:new Date(clock).toISOString()}; service.observe();
    clock+=20000; token={...token,price:'0.00003',sourceUpdatedAt:new Date(clock).toISOString()}; service.observe();
    await service.flush();
    const restored=createCandleService(options); await restored.restore();
    const result=await restored.get(address,'1min');
    assert.equal(result.samples,2); assert.equal(result.candles[0].o,0.00002);
    clock+=120000; token={...token,price:'999'}; restored.observe();
    const stale=await restored.get(address,'1min'); assert.equal(stale.samples,2);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('chart fetches coalesce; remote failure retains clearly marked old indexed data instead of silently substituting samples', async () => {
  let clock=now,calls=0,failed=false;
  const service=createCandleService({snapshot:snapshot(market()),now:()=>clock,getJson:async()=>{calls++;if(failed)throw new Error('network');return remote([[1,2,1,2,3,now]]);} });
  const result=await Promise.all([service.get(address,'1min'),service.get(address,'1min')]);
  assert.equal(calls,1); assert.equal(result[0].kind,'trades');
  failed=true;clock+=11000;
  const old=await service.get(address,'1min'); assert.equal(old.stale,true); assert.equal(old.kind,'trades');assert.match(old.warning,/失败/);
});

test('second bars aggregate actual 1s OHLCV without filling quiet seconds; marketcap requests and caches stay separate',async()=>{
 const calls=[];const token=market({chartSupply:'1000000000',graduationPrice:'0.0001',valuationQuoteUsd:500});
 const service=createCandleService({snapshot:snapshot(token),now:()=>now,getJson:async url=>{calls.push(url);return remote([[1,2,1,2,3,now-4000],[2,4,2,3,5,now-3000],[3,5,3,4,7,now+1000]]);}});
 const p=await service.get(address,'5s','price');assert.equal(p.candles.length,2);assert.equal(p.candles[0].v,8);
 assert.equal(new URL(calls[0]).searchParams.get('interval'),'1s');assert.equal(new URL(calls[0]).searchParams.get('pm'),'p');
 const m=await service.get(address,'5s','marketcap');assert.equal(m.mode,'marketcap');assert.equal(new URL(calls[1]).searchParams.get('pm'),'p');assert.equal(m.candles[0].c,3000000000);
 await service.get(address,'5s','price');assert.equal(calls.length,2);
 await assert.rejects(()=>service.get(address,'1s','bad'));
 assert.equal(p.graduation.value,0.05);assert.equal(m.graduation.value,50000000);
});

test('Gang inner seconds come from recent official trades and never use minute candles relabeled as seconds',async()=>{
 const calls=[];const token=market({platformId:'gang',pad:'v2',quoteSymbol:'GANG',priceUnit:'GANG',chartSupply:'1000000000'});
 const service=createCandleService({snapshot:snapshot(token),now:()=>now,getJson:async url=>{calls.push(url);return {items:[{ts:(now-2000)/1000,price:'0.02',quoteIn:'3',tx:'0x02',side:'buy'},{ts:(now-2000)/1000,price:'0.01',quoteIn:'2',tx:'0x01',side:'buy'}],hasMore:false};}});
 const data=await service.get(address,'1s','marketcap');
 assert.equal(data.source,'gang-trades');assert.equal(data.priceUnit,'GANG');assert.equal(data.candles[0].v,5);assert.equal(data.candles[0].h,20000000);
 assert.equal(calls.length,1);assert.match(calls[0],/^https:\/\/gang.fun\/api\/stocks\/tokens\//);
});

test('Gang minute candles refresh official trades after each cache expiry when the public index remains empty',async()=>{
 let clock=now,price=2;
 const token=market({platformId:'gang',pad:'v2'}),trades=[];
 const service=createCandleService({snapshot:snapshot(token),now:()=>clock,getJson:async url=>{
  if(new URL(url).hostname==='dquery.sintral.io')return remote([]);
  trades.unshift({ts:clock/1000,price:String(price),quoteIn:'3',tx:`trade-${price}`,side:'buy'});
  return {items:[...trades],hasMore:false,nextOffset:null,limit:200,offset:0,sort:'ts_desc'};
 }});
 for(const expectedPrice of [2,3,4]) {
  price=expectedPrice;
  const data=await service.get(address,'1min','price');
  assert.equal(data.source,'gang-trades');assert.equal(data.stale,false,'a successful official refresh must not become stale after the first cached response');
  assert.equal(data.updatedAt,new Date(clock).toISOString());assert.equal(data.lastCandleAt,new Date(clock).toISOString());
  assert.deepEqual(data.candles.at(-1),{t:clock,o:expectedPrice,h:expectedPrice,l:expectedPrice,c:expectedPrice,v:3});
  clock+=60000;
 }
});

for(const unavailable of ['empty','failure'])test(`Gang minute candles retain old real trades when the official refresh is ${unavailable}, even with a verified initial price`,async()=>{
 let clock=now,first=true;
 const token=market({platformId:'gang',pad:'v2',initialPrice:'0.01',createdAt:new Date(now-60000).toISOString()});
 const service=createCandleService({snapshot:snapshot(token),now:()=>clock,getJson:async url=>{
  if(new URL(url).hostname==='dquery.sintral.io')return remote([]);
  if(new URL(url).pathname.endsWith('/candles'))return [];
  if(first){first=false;return {items:[{ts:now/1000,price:'2',quoteIn:'3',tx:'first-trade',side:'buy'}],hasMore:false,nextOffset:null,limit:200,offset:0,sort:'ts_desc'};}
  if(unavailable==='failure')throw new Error('Official trades unavailable');
  return {items:[],hasMore:false,nextOffset:null,limit:200,offset:0,sort:'ts_desc'};
 }});
 const initial=await service.get(address,'1min','price');
 assert.equal(initial.kind,'trades');assert.equal(initial.stale,false);assert.equal(initial.candles.at(-1).c,2);
 clock+=60000;
 const retained=await service.get(address,'1min','price');
 assert.equal(retained.source,'gang-trades');assert.equal(retained.kind,'trades');assert.equal(retained.stale,true);
 assert.equal(retained.updatedAt,new Date(now).toISOString());assert.equal(retained.lastCandleAt,new Date(now).toISOString());
 assert.deepEqual(retained.candles,initial.candles,'empty official data must not replace real trades with samples or initial-price buckets');assert.match(retained.warning,/失败/);
});

test('sample marketcap needs known supply and keeps unknown volume and native units',async()=>{
 const service=createCandleService({snapshot:snapshot(market({platformId:'flap',priceUnit:'QQQB/份额',quoteSymbol:'QQQB',chartSupply:'1000000000'})),now:()=>now});
 const data=await service.get(address,'1s','marketcap');assert.equal(data.candles[0].c,10000);assert.equal(data.candles[0].v,null);assert.equal(data.priceUnit,'QQQB');assert.equal(data.mode,'marketcap');
});

test('API candle output forward-fills every fixed bucket through now with prior close and zero volume; FDV uses identical fill',async()=>{
 const token=market({chartSupply:'1000000000'}), service=createCandleService({snapshot:snapshot(token),now:()=>now,getJson:async()=>remote([[2,4,1,3,10,now-5000],[5,6,4,5,20,now-2000]])});
 const p=await service.get(address,'1s','price');
 assert.equal(p.candles.length,6);assert.equal(p.candles[1].t-p.candles[0].t,1000);
 assert.deepEqual(p.candles[1],{t:now-4000,o:3,h:3,l:3,c:3,v:0,idle:true});
 assert.equal(p.candles.at(-1).c,5);assert.equal(p.candles.at(-1).v,0);assert.equal(p.lastCandleAt,new Date(now-2000).toISOString());
 const cap=await service.get(address,'1s','marketcap');assert.equal(cap.candles[1].c,3000000000);assert.equal(cap.candles[1].v,0);
 for(let i=1;i<cap.candles.length;i++)assert.equal(cap.candles[i].t-cap.candles[i-1].t,1000);
});

test('explicit verified initial price fills a leading empty window without fabricating volume',async()=>{
 const {forwardFillCandles}=await import('../src/candles.mjs');
 const rows=forwardFillCandles([{t:now,o:3,h:4,l:2,c:4,v:9}],1000,{start:now-2000,until:now,initialPrice:2});
 assert.equal(rows.length,3);assert.equal(rows[0].c,2);assert.equal(rows[0].v,0);assert.equal(rows[0].idle,true);assert.equal(rows[2].v,9);
});

test('a Gang market with no first trade returns continuous verified initial-price buckets with volume zero',async()=>{
 const token=market({platformId:'gang',pad:'v2',quoteSymbol:'GANG',priceUnit:'GANG',chartSupply:'1000000000',initialPrice:'0.01',createdAt:new Date(now-3000).toISOString()});
 let calls=0;
 const service=createCandleService({snapshot:snapshot(token),now:()=>now,getJson:async()=>{calls++;return {items:[],hasMore:false};}});
 const data=await service.get(address,'1s','price');assert.equal(data.source,'gang-trades');assert.equal(data.kind,'initial');assert.equal(data.candles.length,4);
 assert.ok(data.candles.every(c=>c.o===0.01&&c.h===0.01&&c.l===0.01&&c.c===0.01&&c.v===0));assert.equal(calls,1);
});

test('history cursors are exclusive, bounded milliseconds and never query unverified indexed parameters',async()=>{
 const urls=[];const service=createCandleService({snapshot:snapshot(market()),now:()=>now,getJson:async url=>{urls.push(url);return remote([[1,2,1,2,3,now-60000],[2,3,2,3,4,now]]);}});
 const latest=await service.get(address,'1min');
 assert.equal(typeof latest.seriesKey,'string');assert.equal(latest.pagination.scope,'indexed-window');
 const page=await service.get(address,'1min','price',{before:now});
 assert.deepEqual(page.candles,[{t:now-60000,o:1,h:2,l:1,c:2,v:3}]);
 assert.equal(page.seriesKey,latest.seriesKey);assert.equal(page.pagination.hasMore,false);
 assert.equal(page.pagination.reason,'indexed-history-unavailable');assert.equal(urls.length,1);
 for(const before of [0,now+60001,1.2,NaN,'1793088000000',null])await assert.rejects(()=>service.get(address,'1min','price',{before}));
});

test('retained sample history ends before its cursor, preserves unknown volume, and does not forward-fill toward now',async()=>{
 let clock=now,token=market({platformId:'flap',priceUnit:'QQQB/份额'});
 const service=createCandleService({snapshot:()=>({tokens:[token]}),now:()=>clock,maxSamples:512});
 for(let i=0;i<310;i++){clock=now+i*60000;token={...token,price:String(i+1),sourceUpdatedAt:new Date(clock).toISOString()};service.observe();}
 const latest=await service.get(address,'1min');assert.equal(latest.candles.length,300);assert.equal(latest.pagination.hasMore,true);
 const page=await service.get(address,'1min','price',{before:latest.pagination.nextBefore});
 assert.equal(page.candles.length,10);assert.equal(page.candles[0].t,now);assert.equal(page.candles.at(-1).t,now+9*60000);
 assert.ok(page.candles.every(c=>c.v===null));assert.equal(page.pagination.hasMore,false);assert.equal(page.pagination.scope,'retained-samples');
 assert.equal(page.seriesKey,latest.seriesKey);
});

test('Gang history completes a bucket split across official pages and deduplicates overlap without adding volume',async()=>{
 const token=market({platformId:'gang',pad:'v2'}),calls=[];
 const trades=Array.from({length:1000},(_,i)=>({ts:(now-1000-i*1000)/1000,price:String(1000-i),quoteIn:'1',tx:`tx-${i}`,side:'buy'}));
 const service=createCandleService({snapshot:snapshot(token),now:()=>now,getJson:async url=>{
  const u=new URL(url);calls.push(u);if(u.hostname==='dquery.sintral.io')return remote([]);
  const offset=Number(u.searchParams.get('offset')),items=trades.slice(offset,offset+200);
  return {items,hasMore:offset+200<trades.length,nextOffset:offset+200};
 }});
 const latest=await service.get(address,'1min');assert.equal(latest.pagination.hasMore,true);
 const before=latest.pagination.nextBefore;
 const page=await service.get(address,'1min','price',{before});
 assert.ok(page.candles.length>0);assert.ok(page.candles.every(c=>c.t<before));
 const sharedBucket=now-14*60000;
 const bar=page.candles.find(c=>c.t===sharedBucket);assert.ok(bar,'bucket spanning request boundary must be present');
 assert.equal(bar.v,60);assert.equal(bar.o,161);assert.equal(bar.c,220);assert.equal(bar.h,220);assert.equal(bar.l,161);
 assert.equal(page.pagination.hasMore,true);assert.equal(page.pagination.scope,'official-trades');
 const final=await service.get(address,'1min','price',{before:page.pagination.nextBefore});assert.equal(final.pagination.hasMore,false);assert.ok(final.candles.every(c=>c.t<page.candles[0].t));
 assert.ok(calls.filter(u=>u.hostname==='gang.fun'&&u.pathname.endsWith('/trades')).length<=6);
 const cached=await service.get(address,'1min');assert.deepEqual(cached.candles,latest.candles,'historical read cannot replace latest cache');
});

test('Gang historical failure and changed offset anchor return explicit empty pages, preserving latest real trades',async()=>{
 for(const problem of ['failure','anchor']) {
  let historical=false;const trades=Array.from({length:1000},(_,i)=>({ts:(now-1000-i*1000)/1000,price:'2',quoteIn:'1',tx:`tx-${i}`,side:'buy'}));
  const service=createCandleService({snapshot:snapshot(market({platformId:'gang',pad:'v2'})),now:()=>now,getJson:async url=>{
   const u=new URL(url);if(u.hostname==='dquery.sintral.io')return remote([]);
   if(historical&&problem==='failure')throw Error('offline');
   const offset=Number(u.searchParams.get('offset')),items=trades.slice(offset,offset+200);
   if(historical&&problem==='anchor')items[0]={...items[0],tx:'shifted-anchor'};
   return {items,hasMore:true,nextOffset:offset+200};
  }});
  const latest=await service.get(address,'1min');historical=true;
  const page=await service.get(address,'1min','price',{before:latest.pagination.nextBefore});
  assert.deepEqual(page.candles,[]);assert.equal(page.historyPartial,true);
  assert.equal(page.pagination.reason,problem==='failure'?'upstream-unavailable':'offset-anchor-changed');
  assert.deepEqual((await service.get(address,'1min')).candles,latest.candles);
 }
});

test('series identity separates valuation scale, phase and chart asset but reference-only FX preserves USD history',async()=>{
 let token=market({platformId:'flap',chartSupply:'100',valuationQuoteUsd:500,graduationPrice:'0.01'}),clock=now;
 const service=createCandleService({snapshot:()=>({tokens:[token]}),now:()=>clock,getJson:async()=>remote([[1,2,1,2,3,now]])});
 const shares=await service.get(address,'1min','marketcap');token={...token,chartSupply:'200'};
 const scaled=await service.get(address,'1min','marketcap');assert.notEqual(shares.seriesKey,scaled.seriesKey);
 token={...token,phase:'graduated',tokenAddress:launched};const graduated=await service.get(address,'1min','marketcap');assert.notEqual(scaled.seriesKey,graduated.seriesKey);
 token={...token,valuationQuoteUsd:600};const fx=await service.get(address,'1min','marketcap');assert.equal(graduated.seriesKey,fx.seriesKey);assert.deepEqual(graduated.candles,fx.candles);assert.notEqual(graduated.graduation.value,fx.graduation.value);
});

test('Gang expired cursors and invalid upstream offsets never guess history or alter latest data',async()=>{
 let clock=now,broken=false,requests=0;
 const trades=Array.from({length:1000},(_,i)=>({ts:(now-1000-i*1000)/1000,price:'2',quoteIn:'1',tx:`tx-${i}`,side:'buy'}));
 const service=createCandleService({snapshot:snapshot(market({platformId:'gang',pad:'v2'})),now:()=>clock,getJson:async url=>{
  const u=new URL(url);if(u.hostname==='dquery.sintral.io')return remote([]);requests++;
  const offset=Number(u.searchParams.get('offset'));return {items:trades.slice(offset,offset+200),hasMore:true,nextOffset:broken?offset:offset+200};
 }});
 const latest=await service.get(address,'1min');broken=true;
 const malformed=await service.get(address,'1min','price',{before:latest.pagination.nextBefore});
 assert.deepEqual(malformed.candles,[]);assert.equal(malformed.pagination.reason,'upstream-unavailable');
 clock+=300001;const count=requests;
 const expired=await service.get(address,'1min','price',{before:latest.pagination.nextBefore});
 assert.deepEqual(expired.candles,[]);assert.equal(expired.pagination.reason,'cursor-expired');assert.equal(requests,count);
});

test('Gang partial bucket budget is explicit, bounded to four pages, and retry resumes without inventing a bucket',async()=>{
 const trades=Array.from({length:2400},(_,i)=>({ts:(i<796?now-1000:now-120000)/1000,price:'2',quoteIn:'1',tx:`tx-${i}`,side:'buy'}));
 let reads=0;
 const service=createCandleService({snapshot:snapshot(market({platformId:'gang',pad:'v2'})),now:()=>now,getJson:async url=>{
  const u=new URL(url);if(u.hostname==='dquery.sintral.io')return remote([]);reads++;
  const offset=Number(u.searchParams.get('offset'));return {items:trades.slice(offset,offset+200),hasMore:true,nextOffset:offset+200};
 }});
 // Exactly one complete newer minute, followed by a bucket whose trades exceed
 // the bounded per-request read budget. Establish its real initial cursor.
 const latest=await service.get(address,'1min');
 assert.equal(latest.source,'gang-trades');const before=latest.pagination.nextBefore,count=reads;
 const partial=await service.get(address,'1min','price',{before});
 assert.deepEqual(partial.candles,[]);assert.equal(partial.historyPartial,true);
 assert.ok(['history-page-budget','history-retention-limit'].includes(partial.pagination.reason));assert.ok(reads-count<=4);
});

test('sparse retained samples advertise older retained points even when idle filling trims the visible window',async()=>{
 let clock=now,token=market({platformId:'flap'});
 const service=createCandleService({snapshot:()=>({tokens:[token]}),now:()=>clock});service.observe();
 clock+=600*60000;token={...token,price:'2',sourceUpdatedAt:new Date(clock).toISOString()};service.observe();
 const latest=await service.get(address,'1min');assert.equal(latest.candles.length,300);assert.equal(latest.pagination.hasMore,true);
 const old=await service.get(address,'1min','price',{before:latest.pagination.nextBefore});assert.ok(old.candles.length>0);assert.ok(old.candles.every(c=>c.v===null));assert.equal(old.pagination.hasMore,true);
});

test('Gang fully fetched source still paginates older fetched trades outside the current 300-bar window',async()=>{
 const token=market({platformId:'gang',pad:'v2'}),trades=[{ts:now/1000,price:'3',quoteIn:'5',tx:'new',side:'buy'},{ts:(now-600*60000)/1000,price:'2',quoteIn:'7',tx:'old',side:'buy'}];
 const service=createCandleService({snapshot:snapshot(token),now:()=>now,getJson:async url=>new URL(url).hostname==='dquery.sintral.io'?remote([]):{items:trades,hasMore:false}});
 const latest=await service.get(address,'1min');assert.equal(latest.candles.length,300);assert.equal(latest.pagination.hasMore,true);
 const middle=await service.get(address,'1min','price',{before:latest.pagination.nextBefore});assert.equal(middle.pagination.hasMore,true);assert.ok(middle.candles.every(c=>c.v===0));
 const oldest=await service.get(address,'1min','price',{before:middle.pagination.nextBefore});assert.equal(oldest.pagination.hasMore,false);assert.deepEqual(oldest.candles[0],{t:now-600*60000,o:2,h:2,l:2,c:2,v:7});
});

test('indexed null volume stays unknown in real and idle buckets, including historical reads',async()=>{
 const service=createCandleService({snapshot:snapshot(market()),now:()=>now,getJson:async()=>remote([[2,3,1,2,null,now-120000],[2,3,2,3,null,now]])});
 const latest=await service.get(address,'1min');assert.equal(latest.volumeUnit,null);assert.ok(latest.candles.every(c=>c.v===null));
 const history=await service.get(address,'1min','price',{before:now});assert.equal(history.candles.length,2);assert.ok(history.candles.every(c=>c.v===null));
});

test('Gang history safely finds its complete anchor after a new trade shifts the official offset',async()=>{
 const trades=Array.from({length:1000},(_,i)=>({ts:(now-1000-i*1000)/1000,price:String(1000-i),quoteIn:'1',tx:`tx-${i}`,side:'buy'}));
 const service=createCandleService({snapshot:snapshot(market({platformId:'gang',pad:'v2'})),now:()=>now,getJson:async url=>{
  const u=new URL(url);if(u.hostname==='dquery.sintral.io')return remote([]);
  const offset=Number(u.searchParams.get('offset'));return {items:trades.slice(offset,offset+200),hasMore:offset+200<trades.length,nextOffset:offset+200};
 }});
 const latest=await service.get(address,'1min');trades.unshift({ts:now/1000,price:'99999',quoteIn:'999',tx:'inserted',side:'buy'});
 const page=await service.get(address,'1min','price',{before:latest.pagination.nextBefore});
 assert.equal(page.historyPartial,false);const bar=page.candles.find(c=>c.t===now-14*60000);assert.ok(bar);assert.equal(bar.v,60);assert.equal(bar.h,220);assert.equal(bar.l,161);
 assert.ok(page.candles.every(c=>c.t<latest.pagination.nextBefore&&c.h<99999));
});

test('a cold indexed historical request fails explicitly without fetching a latest page or doubling page budgets',async()=>{
 let reads=0;const service=createCandleService({snapshot:snapshot(market({platformId:'gang',pad:'v2'})),now:()=>now,getJson:async()=>{reads++;return remote([]);}});
 const history=await service.get(address,'1min','price',{before:now-60000});
 assert.deepEqual(history.candles,[]);assert.equal(history.historyPartial,true);assert.equal(history.pagination.reason,'cursor-unavailable');assert.equal(reads,0);
});

test('a latest source transition from USD index to native Gang trades creates a distinct series identity',async()=>{
 let clock=now,indexed=true;
 const service=createCandleService({snapshot:snapshot(market({platformId:'gang',pad:'v2',chartSupply:'100'})),now:()=>clock,getJson:async url=>new URL(url).hostname==='dquery.sintral.io'?remote(indexed?[[2,3,1,2,4,now]]:[]):{items:[{ts:clock/1000,price:'5',quoteIn:'7',tx:'native',side:'buy'}],hasMore:false}});
 const usd=await service.get(address,'1min','marketcap');clock+=60000;indexed=false;
 const native=await service.get(address,'1min','marketcap');
 assert.equal(usd.priceUnit,'USD');assert.equal(native.priceUnit,'BNB');assert.notEqual(usd.seriesKey,native.seriesKey);assert.equal(native.candles.at(-1).c,500);assert.equal(native.source,'gang-trades');
});
