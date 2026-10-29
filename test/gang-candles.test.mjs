import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createCandleService} from '../src/candles.mjs';

const address='0x05d041F418842861fFBE2349E9a95687784F3BB0';
const fixture=JSON.parse(await readFile(new URL('./fixtures/gang-elfin-candles.json',import.meta.url),'utf8'));
const T=1_793_088_000_000;
const token=(more={})=>({address,platformId:'gang',pad:'v2',phase:'bonding',verified:true,price:'0.1',quoteSymbol:'WBNB',priceUnit:'WBNB',chartSupply:'1000000000',sourceUpdatedAt:new Date(T).toISOString(),...more});
const isOfficial=url=>new URL(url).hostname==='gang.fun'&&new URL(url).pathname.endsWith('/candles');
const official=(rows)=>async url=>isOfficial(url)?rows:{data:[]};
const bar=(i,more={})=>({t:(T+i*60000)/1000,o:2,h:4,l:1,c:3,v:5,...more});

// Removing the official native-OHLC branch would reconstruct a different open
// from recent trades and forward-fill quiet time. The captured 14-row fixture
// independently fixes both the OHLC values and timestamps to compare.
test('Gang minute native candles exactly preserve the official elfin OHLC and irregular times without filling quiet minutes',async()=>{
 const now=fixture.at(-1).t*1000+3*86400000,urls=[];
 const service=createCandleService({snapshot:()=>({tokens:[token()]}),now:()=>now,getJson:async(url,options)=>{urls.push({url,options});return official(fixture)(url);}});
 const data=await service.get(address,'1min');
 assert.equal(data.source,'gang-candles');assert.equal(data.timeline,'activity');assert.equal(data.continuous,false);
 assert.deepEqual(data.candles.map(({idle,...c})=>c),fixture.map(c=>({...c,t:c.t*1000})));
 assert.equal(data.candles.at(-1).idle,true);
 assert.equal(data.candles.length,14);assert.equal(data.priceUnit,'WBNB');assert.equal(data.volumeUnit,'WBNB');
 assert.equal(urls.length,1);assert.match(urls[0].url,/\/api\/stocks\/tokens\/0x05d041F418842861fFBE2349E9a95687784F3BB0\/candles\?res=1m$/);
 assert.ok(urls[0].options.timeoutMs<=6000);assert.ok(urls[0].options.limit<=2*1024*1024);
});

test('official routes and resolutions are fixed and FDV uses verified supply without applying current FX',async()=>{
 const calls=[];
 const resolutions={'1min':'1m','5min':'5m','15min':'15m','1h':'1h','4h':'4h','1d':'1d'};
 for(const [interval,res]of Object.entries(resolutions)){
  const service=createCandleService({snapshot:()=>({tokens:[token({pad:'v1',chartSupply:'100',valuationQuoteUsd:700})]}),now:()=>T,getJson:async url=>{calls.push(new URL(url));return [bar(0,{t:Math.floor(T/86400000)*86400000/1000})];}});
  const data=await service.get(address,interval,'marketcap');assert.equal(data.source,'gang-candles');assert.equal(data.priceUnit,'WBNB');assert.deepEqual(data.candles,[{t:Math.floor(T/86400000)*86400000,o:200,h:400,l:100,c:300,v:5}]);
  assert.equal(calls.at(-1).pathname,`/api/tokens/${address}/candles`);assert.deepEqual([...calls.at(-1).searchParams],[['res',res]]);
 }
});

test('official full window pages by 300 actual rows with exclusive local before and no second upstream request',async()=>{
 const rows=Array.from({length:650},(_,i)=>bar(i-649)),urls=[];
 const service=createCandleService({snapshot:()=>({tokens:[token()]}),now:()=>T,getJson:async url=>{urls.push(url);return official(rows)(url);}});
 const latest=await service.get(address,'1min');assert.equal(latest.candles.length,300);assert.equal(latest.candles[0].t,T-299*60000);assert.equal(latest.pagination.hasMore,true);assert.equal(latest.pagination.scope,'official-window');
 const middle=await service.get(address,'1min','price',{before:latest.pagination.nextBefore});assert.equal(middle.candles.length,300);assert.ok(middle.candles.every(c=>c.t<latest.candles[0].t));
 const oldest=await service.get(address,'1min','price',{before:middle.pagination.nextBefore});assert.equal(oldest.candles.length,50);assert.equal(oldest.pagination.hasMore,false);assert.equal(oldest.pagination.reason,'official-window-boundary');
 assert.equal(new Set([...oldest.candles,...middle.candles,...latest.candles].map(c=>c.t)).size,650);assert.equal(urls.length,1);assert.equal(oldest.seriesKey,latest.seriesKey);
});

test('null official volume stays unknown and a market with only quiet reference rows retains one real anchor',async()=>{
 const service=createCandleService({snapshot:()=>({tokens:[token()]}),now:()=>T,getJson:official([bar(-2,{v:null}),bar(0,{v:null})])});
 const data=await service.get(address,'1min');assert.equal(data.source,'gang-candles');assert.equal(data.volumeUnit,null);assert.ok(data.candles.every(c=>c.v===null));assert.equal(data.candles.length,2);
 const quiet=createCandleService({snapshot:()=>({tokens:[token()]}),now:()=>T,getJson:official([bar(-1,{o:2,h:2,l:2,c:2,v:0}),bar(0,{o:2,h:2,l:2,c:2,v:0})])});
 const anchor=await quiet.get(address,'1min');assert.ok(anchor.candles.length>=1);assert.ok(anchor.candles.every(c=>c.idle===true&&c.v===0&&c.c===2));
});

for(const problem of ['empty','failure','conflict'])test(`cached official truth survives ${problem} refresh without changing source or manufacturing recent bars`,async()=>{
 let clock=T,failed=false;
 const service=createCandleService({snapshot:()=>({tokens:[token()]}),now:()=>clock,getJson:async url=>{if(!isOfficial(url))throw Error('fallback must not replace real official series');if(failed){if(problem==='failure')throw Error('offline');if(problem==='empty')return [];return [bar(-2),bar(-2,{c:4})];}return [bar(-2),bar(0)];}});
 const initial=await service.get(address,'1min');failed=true;clock+=6000;
 const next=await service.get(address,'1min');assert.equal(next.source,'gang-candles');assert.equal(next.stale,true);assert.deepEqual(next.candles,initial.candles);assert.equal(next.updatedAt,initial.updatedAt);
});

test('malformed official data is never accepted as native OHLC and cold failures retain the existing safe fallback',async()=>{
 const cases=[{},[bar(0,{o:0})],[bar(0,{h:1})],[bar(0,{v:-1})],[bar(0,{t:T/1000+.5})],[bar(0,{t:T/1000+1})],[bar(2)],[bar(0),bar(-1)],[bar(0),bar(0,{c:4})],Array.from({length:5001},()=>bar(0))];
 for(const rows of cases){
  const service=createCandleService({snapshot:()=>({tokens:[token()]}),now:()=>T,getJson:async url=>isOfficial(url)?rows:new URL(url).hostname==='dquery.sintral.io'?{data:[[1,2,1,2,3,T]]}:{items:[],hasMore:false}});
  const data=await service.get(address,'1min');assert.equal(data.source,'binance-public');assert.equal(data.priceUnit,'USD');
 }
});

test('identical official duplicates deduplicate, seconds never use minute sources, and graduated native failures retain the USD fallback',async()=>{
 for(const [interval,extra]of [['1s',{}],['1min',{phase:'graduated'}]]){
  const calls=[];
  const service=createCandleService({snapshot:()=>({tokens:[token(extra)]}),now:()=>T,getJson:async url=>{calls.push(url);return new URL(url).hostname==='gang.fun'?{items:[{ts:T/1000,price:'2',quoteIn:'3',tx:'one',side:'buy'}],hasMore:false}:{data:[[1,2,1,2,3,T]]};}});
  const data=await service.get(address,interval);assert.equal(data.source,interval==='1s'?'gang-trades':'binance-public');
  assert.equal(calls.some(isOfficial),interval==='1min');
 }
 const service=createCandleService({snapshot:()=>({tokens:[token()]}),now:()=>T,getJson:official([bar(0),bar(0)])});
 assert.equal((await service.get(address,'1min')).candles.length,1);
});

test('verified merged V3 native-token candles use the observed route, never old V2 trades',async()=>{
 for(const [launchType,path]of [['curve-v3','v3/tokens']]){
  const urls=[];const service=createCandleService({snapshot:()=>({tokens:[token({pad:'merged',launchType,nativeCandleUnitVerified:true,quoteDecimals:18,positionKind:'token'})]}),now:()=>T,getJson:async url=>{urls.push(url);return isOfficial(url)?[bar(0)]:{data:[]};}});
  const out=await service.get(address,'1min');assert.equal(out.source,'gang-candles');assert.equal(new URL(urls[0]).pathname,`/api/${path}/${address}/candles`);assert.equal(out.priceUnit,'WBNB');assert.equal(urls.length,1);
 }
 const urls=[];const service=createCandleService({snapshot:()=>({tokens:[token({pad:'merged',launchType:'fair',nativeCandleUnitVerified:false})]}),now:()=>T,getJson:async url=>{urls.push(url);return{data:[]};}});await service.get(address,'1min');assert.ok(urls.every(url=>new URL(url).hostname!=='gang.fun'));
});


test('locked Fair mint reference values never become ERC20 trade candles or a marketcap, including public-index fallback',async()=>{
 for(const interval of ['1s','1min'])for(const mode of ['price','marketcap']){
  const calls=[],fair=token({pad:'merged',launchType:'fair',phase:'bonding',locked:true,price:null,positionKind:'token',quoteDecimals:18,nativeCandleUnitVerified:true});
  const service=createCandleService({snapshot:()=>({tokens:[fair]}),now:()=>T,getJson:async url=>{calls.push(url);return isOfficial(url)?[bar(0)]:{data:[[1,2,1,2,3,T]]};}});
  const out=await service.get(address,interval,mode);assert.equal(out.kind,'empty');assert.deepEqual(out.candles,[]);assert.match(out.warning,/打新|成交/);assert.equal(out.pagination.hasMore,false);assert.equal(calls.length,0);
 }
});
