import test from'node:test';import assert from'node:assert/strict';import{createCandleService}from'../src/candles.mjs';
const A='0x1111111111111111111111111111111111111111',WBNB='0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',T=1793088000000;
const token=more=>({address:A,platformId:'gang',pad:'merged',launchType:'curve-v3',nativeCandleUnitVerified:true,positionKind:'token',quoteDecimals:18,quoteAsset:WBNB,quoteSymbol:'WBNB',priceUnit:'WBNB',chartSupply:'100',price:'2',verified:true,phase:'bonding',createdAt:new Date(T-1000*60000).toISOString(),sourceUpdatedAt:new Date(T).toISOString(),...more});
const bar=(i,more={})=>({t:(T+i*60000)/1000,o:2,h:4,l:1,c:3,v:5,...more});
const official=url=>new URL(url).hostname==='gang.fun';

test('compatible Gang native whole journey preserves exact pregraduation bars, exclusive pages and identity after phase change',async()=>{
 let row=token(),clock=T,calls=0;const rows=Array.from({length:650},(_,i)=>bar(i-649));
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>clock,getJson:async url=>{calls++;return official(url)?rows:{data:[]};}});
 const inner=await service.get(A,'1min');row={...row,phase:'graduated',graduatedAt:new Date(T-100*60000+30000).toISOString()};clock+=6000;
 const whole=await service.get(A,'1min');assert.equal(whole.source,'gang-candles');assert.equal(whole.semantics,'official-composite-reference');assert.equal(whole.sourceLabel,'Gang 官方综合走势');assert.equal(whole.seriesKey,inner.seriesKey);assert.equal(whole.candles.length,300);assert.deepEqual(whole.candles,inner.candles);assert.equal(whole.coverage.complete,false);assert.equal(whole.coverage.scope,'official-window');assert.equal(whole.coverage.from,T-649*60000);assert.equal(whole.coverage.to,T);
 const middle=await service.get(A,'1min','price',{before:whole.pagination.nextBefore}),oldest=await service.get(A,'1min','price',{before:middle.pagination.nextBefore});
 assert.equal(middle.candles.length,300);assert.equal(oldest.candles.length,50);assert.equal(oldest.pagination.hasMore,false);assert.equal(oldest.seriesKey,whole.seriesKey);assert.equal(calls,2);
});

test('graduated legacy native routes remain compatible but quote asset and supply changes cannot reuse their identity',async()=>{
 let row=token({pad:'v2',launchType:undefined,nativeCandleUnitVerified:undefined,phase:'graduated'}),clock=T;const calls=[];
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>clock,getJson:async url=>{calls.push(url);return official(url)?[bar(0)]:{data:[]};}});
 const first=await service.get(A,'1min','marketcap');assert.equal(first.source,'gang-candles');assert.match(calls[0],/\/stocks\/tokens\//);row={...row,quoteAsset:'0x2222222222222222222222222222222222222222'};clock+=6000;
 const changed=await service.get(A,'1min','marketcap');assert.notEqual(changed.seriesKey,first.seriesKey);row={...row,chartSupply:'200'};assert.notEqual((await service.get(A,'1min','marketcap')).seriesKey,changed.seriesKey);
});

test('graduation marker provenance never promotes a current market block to the event block',async()=>{
 let row=token({phase:'graduated',graduatedAt:new Date(T-90000).toISOString(),sourceBlock:999}),clock=T;
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>clock,getJson:async url=>official(url)?[bar(-2),bar(0)]:{data:[]}});
 const indexed=(await service.get(A,'1min')).graduationEvent;assert.equal(indexed.at,T-90000);assert.equal(indexed.proof,'official-index');assert.equal(indexed.verified,false);assert.equal(indexed.blockNumber,null);assert.equal(indexed.txHash,null);
 row={...row,graduationEvent:{at:T-90000,proof:'chain-event',verified:true,blockNumber:123,txHash:'0x'+'a'.repeat(64),logIndex:7}};const proved=(await service.get(A,'1min')).graduationEvent;assert.equal(proved.verified,true);assert.equal(proved.blockNumber,123);assert.equal(proved.logIndex,7);
 row={...row,graduatedAt:null,graduationEvent:null};assert.equal((await service.get(A,'1min')).graduationEvent,null);
 row={...row,graduatedAt:new Date(T+60001).toISOString()};assert.equal((await service.get(A,'1min')).graduationEvent,null);
});

test('Fair graduated charts retain only real DEX periods after the mixed launch bucket and expose the excluded issuance interval',async()=>{
 const row=token({launchType:'fair',nativeCandleUnitVerified:false,phase:'graduated',graduatedAt:new Date(T-90000).toISOString()});const calls=[];
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async url=>{calls.push(url);return official(url)?[bar(-2),bar(-1),bar(0)]:{data:[[2,4,1,3,5,T-120000],[4,6,3,5,7,T-60000],[5,7,4,6,8,T]]};}});
 const data=await service.get(A,'1min','marketcap');assert.equal(data.source,'binance-public');assert.deepEqual(data.candles.map(c=>c.t),[T-60000,T]);assert.equal(data.candles[0].c,500);assert.ok(calls.every(url=>!official(url)));assert.equal(data.coverage.excludedBefore,T-60000);assert.equal(data.coverage.reason,'fair-mint-not-erc20-trades');assert.match(data.warning,/申购|打新/);
 const unknown=createCandleService({snapshot:()=>({tokens:[{...row,graduatedAt:null}]}),now:()=>T,getJson:async()=>{throw Error('unknown launch must not request history');}});const empty=await unknown.get(A,'1min');assert.equal(empty.kind,'empty');assert.equal(empty.candles.length,0);assert.match(empty.warning,/发射时间/);
});

test('currency conversion happens after native pagination, preserves raw cached history and rejects invalid currency before upstream IO',async()=>{
 const rows=Array.from({length:650},(_,i)=>bar(i-649)),calls=[],seen=[];const currencyService={async convert(data,currency,metadata){seen.push({count:data.candles.length,currency,metadata});return{...data,currency,priceUnit:currency,seriesKey:data.seriesKey+':'+currency};}};
 const service=createCandleService({snapshot:()=>({tokens:[token({phase:'graduated'})]}),now:()=>T,currencyService,getJson:async url=>{calls.push(url);return official(url)?rows:{data:[]};}});
 await assert.rejects(()=>service.get(A,'1min','price',{currency:'EUR'}));assert.equal(calls.length,0);
 const latest=await service.get(A,'1min','price',{currency:'USD'}),older=await service.get(A,'1min','price',{before:latest.pagination.nextBefore,currency:'BNB'});
 assert.equal(latest.priceUnit,'USD');assert.equal(older.priceUnit,'BNB');assert.deepEqual(seen.map(r=>r.count),[300,300]);assert.deepEqual(seen.map(r=>r.currency),['USD','BNB']);assert.equal(seen[0].metadata.quoteAsset,WBNB);assert.equal(seen[0].metadata.positionKind,'token');assert.notEqual(latest.seriesKey,older.seriesKey);
 const native=await service.get(A,'1min');assert.equal(native.priceUnit,'WBNB');assert.equal(native.candles[0].o,2);assert.equal(calls.length,1);
});

test('real historical FX integration scales a native page by matching bucket closes and preserves volume and graduation event',async()=>{
 const row=token({phase:'graduated',graduatedAt:new Date(T-30000).toISOString()}),calls=[];
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async url=>{calls.push(url);return official(url)?[bar(-1),bar(0)]:{data:[[100,100,100,100,1,T-60000],[200,200,200,200,1,T]]};}});
 const usd=await service.get(A,'1min','price',{currency:'USD'});assert.equal(usd.currencyConversion.status,'estimated');assert.equal(usd.priceUnit,'USD');assert.equal(usd.candles[0].o,200);assert.equal(usd.candles[1].c,600);assert.deepEqual(usd.candles.map(c=>c.v),[5,5]);assert.equal(usd.volumeUnit,'WBNB');assert.equal(usd.graduationEvent.at,T-30000);assert.equal(usd.graduation,null);assert.equal(calls.length,2);
});

test('demo currency switches remain isolated simulated data and preserve share instruments and historical page identity',async()=>{
 const{createDemo}=await import('../src/demo.mjs');const demo=createDemo(),row=demo.monitor.snapshot().tokens.find(t=>t.positionKind==='shares');
 const native=await demo.charts.get(row.address,'1min','price',{currency:'BNB'}),usd=await demo.charts.get(row.address,'1min','price',{currency:'USD'});
 assert.equal(native.kind,'demo');assert.equal(native.priceUnit,'BNB/份额');assert.equal(usd.priceUnit,'USD/份额');assert.equal(usd.currencyConversion.status,'demo');assert.match(usd.currencyConversion.warning,/演示/);assert.notEqual(native.seriesKey,usd.seriesKey);
 const older=await demo.charts.get(row.address,'1min','price',{currency:'USD',before:usd.pagination.nextBefore});assert.equal(older.seriesKey,usd.seriesKey);assert.ok(older.candles.at(-1).t<usd.candles[0].t);
 await assert.rejects(()=>demo.charts.get(row.address,'1min','price',{currency:'EUR'}));
});

test('Fair postlaunch source failures remain unavailable instead of being substituted by locally observed mint references',async()=>{
 const row=token({launchType:'fair',nativeCandleUnitVerified:false,phase:'graduated',graduatedAt:new Date(T-90000).toISOString()});
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async()=>{throw Error('index offline');}});
 const data=await service.get(A,'1min');assert.equal(data.kind,'empty');assert.equal(data.source,'gang-fair-history-unavailable');assert.equal(data.candles.length,0);assert.match(data.warning,/发射后.*失败/);
});

test('a verified Fair launch event supplies the conservative boundary even when the official time hint is absent',async()=>{
 const row=token({launchType:'fair',nativeCandleUnitVerified:false,phase:'graduated',graduatedAt:null,graduationEvent:{at:T-90000,proof:'chain-event',verified:true,blockNumber:123,txHash:'0x'+'a'.repeat(64),logIndex:1}});
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async()=>({data:[[2,4,1,3,5,T-120000],[4,6,3,5,7,T-60000]]})});
 const data=await service.get(A,'1min');assert.equal(data.source,'binance-public');assert.equal(data.candles[0].t,T-60000);assert.equal(data.graduationEvent.verified,true);
});

test('Fair launch-boundary corrections change the series so previously excluded issuance buckets cannot survive client merging',async()=>{
 let row=token({launchType:'fair',nativeCandleUnitVerified:false,phase:'graduated',graduatedAt:new Date(T-150000).toISOString()});
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async()=>({data:[[2,4,1,3,5,T-120000],[4,6,3,5,7,T-60000],[5,7,4,6,8,T]]})});
 const hint=await service.get(A,'1min');assert.equal(hint.coverage.excludedBefore,T-120000);assert.equal(hint.candles[0].t,T-120000);
 row={...row,graduationEvent:{at:T-90000,proof:'chain-event',verified:true,blockNumber:123,txHash:'0x'+'a'.repeat(64),logIndex:1}};
 const corrected=await service.get(A,'1min');assert.equal(corrected.coverage.excludedBefore,T-60000);assert.equal(corrected.candles[0].t,T-60000);assert.notEqual(corrected.seriesKey,hint.seriesKey);
 row={...row,graduationEvent:{...row.graduationEvent,at:T-150000}};const earlier=await service.get(A,'1min');assert.notEqual(earlier.seriesKey,corrected.seriesKey);assert.equal(earlier.seriesKey,hint.seriesKey);
});

test('indexed retained history remains reachable when quiet filling pushes real candles outside the latest 300 elapsed buckets',async()=>{
 const row=token({platformId:'four',pad:undefined,launchType:undefined,phase:'graduated'});let reads=0;
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async()=>{reads++;return{data:[[2,3,1,2,7,T-600*60000],[3,4,2,3,5,T]]};}});
 const latest=await service.get(A,'1min');assert.equal(latest.candles.length,300);assert.equal(latest.pagination.hasMore,true);
 const middle=await service.get(A,'1min','price',{before:latest.pagination.nextBefore});assert.equal(middle.candles.length,300);assert.equal(middle.pagination.hasMore,true);assert.ok(middle.candles.every(c=>c.t<latest.pagination.nextBefore&&c.v===0));
 const oldest=await service.get(A,'1min','price',{before:middle.pagination.nextBefore});assert.deepEqual(oldest.candles,[{t:T-600*60000,o:2,h:3,l:1,c:2,v:7}]);assert.equal(oldest.pagination.hasMore,false);assert.equal(oldest.seriesKey,latest.seriesKey);assert.equal(reads,1);
 assert.equal(latest.coverage.from,T-600*60000);assert.equal(latest.coverage.to,T);assert.equal(latest.coverage.complete,false);
});

test('Fair retained postlaunch pages reach the first real DEX candle without bringing excluded issuance buckets back',async()=>{
 const row=token({launchType:'fair',nativeCandleUnitVerified:false,phase:'graduated',graduatedAt:new Date(T-600*60000-30000).toISOString()});let reads=0;
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async()=>{reads++;return{data:[[99,99,99,99,100,T-601*60000],[2,3,1,2,7,T-600*60000],[3,4,2,3,5,T]]};}});
 const latest=await service.get(A,'1min');assert.equal(latest.pagination.hasMore,true);
 const middle=await service.get(A,'1min','price',{before:latest.pagination.nextBefore});
 const oldest=await service.get(A,'1min','price',{before:middle.pagination.nextBefore});assert.equal(oldest.candles.length,1);assert.equal(oldest.candles[0].t,T-600*60000);assert.equal(oldest.candles[0].c,2);assert.equal(oldest.coverage.excludedBefore,T-600*60000);assert.equal(oldest.pagination.hasMore,false);assert.equal(reads,1);
});

test('verified legacy U and S tokens use their official stocks-native history after matching the quote asset identity',async()=>{
 for(const pad of ['u','s']){
  const row=token({pad,launchType:undefined,nativeCandleUnitVerified:undefined,quoteSymbol:'NVDAB',priceUnit:'NVDAB',phase:'graduated',graduatedAt:new Date(T-90000).toISOString()}),calls=[];
  const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async url=>{calls.push(url);const path=new URL(url).pathname;return path.endsWith('/candles')?[bar(-3),bar(0)]:{address:A,track:'stocks',quoteAddress:WBNB,quoteSymbol:'NVDAB'};}});
  const data=await service.get(A,'1min');assert.equal(data.source,'gang-candles');assert.equal(data.priceUnit,'NVDAB');assert.equal(data.candles[0].t,T-180000);assert.ok(calls.every(url=>new URL(url).pathname.startsWith(`/api/stocks/tokens/${A}`)));assert.equal(calls.length,2);
 }
});

test('legacy U and S native history never relabels an official response whose token or quote address differs',async()=>{
 for(const metadata of [{address:'0x2222222222222222222222222222222222222222',track:'stocks',quoteAddress:WBNB},{address:A,track:'stocks',quoteAddress:'0x2222222222222222222222222222222222222222'}]){
  const row=token({pad:'u',launchType:undefined,nativeCandleUnitVerified:undefined,phase:'graduated'});let candleReads=0;
  const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async url=>{if(!official(url))return{data:[[2,4,1,3,5,T]]};if(new URL(url).pathname.endsWith('/candles')){candleReads++;return[bar(0)];}return metadata;}});
  const data=await service.get(A,'1min');assert.equal(data.source,'binance-public');assert.equal(data.priceUnit,'USD');assert.equal(candleReads,0);
 }
});

test('legacy U and S price histories do not infer marketcap supply from an official index or a fixed billion-token assumption',async()=>{
 const row=token({pad:'u',launchType:undefined,nativeCandleUnitVerified:undefined,chartSupply:undefined,phase:'graduated'});
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async()=>{throw Error('unknown supply must not request a marketcap substitute');}});
 const data=await service.get(A,'1min','marketcap');assert.equal(data.kind,'empty');assert.equal(data.source,'gang-cap-unavailable');assert.equal(data.coverage.reason,'supply-unverified');assert.match(data.warning,/供应量/);assert.equal(data.candles.length,0);
});

test('indexed graduated histories page real source windows with exclusive millisecond cursors for Four, Fair and actual Flap ERC20 assets',async()=>{
 for(const platform of ['four','fair','flap']){
  const launched='0x2222222222222222222222222222222222222222',row=token({platformId:platform==='fair'?'gang':platform,pad:undefined,launchType:platform==='fair'?'fair':undefined,nativeCandleUnitVerified:false,phase:'graduated',positionKind:platform==='flap'?'shares':'token',tokenAddress:platform==='flap'?launched:undefined,graduatedAt:new Date(T-640*60000+30000).toISOString()}),calls=[];
  const rows=Array.from({length:650},(_,i)=>[2,4,1,3,1,T-(649-i)*60000]);
  const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async url=>{const u=new URL(url);calls.push(u);const to=Number(u.searchParams.get('to')??T);return{data:rows.filter(c=>c[5]<=to).slice(-300)};}});
  const latest=await service.get(A,'1min');assert.equal(latest.pagination.hasMore,true);const middle=await service.get(A,'1min','price',{before:latest.pagination.nextBefore}),oldest=await service.get(A,'1min','price',{before:middle.pagination.nextBefore});
  assert.equal(middle.candles.length,300);assert.equal(oldest.candles.length,platform==='fair'?40:50);assert.equal(oldest.pagination.hasMore,false);assert.equal(oldest.candles[0].t,platform==='fair'?T-639*60000:T-649*60000);assert.ok(middle.candles.every(c=>c.t<latest.pagination.nextBefore));assert.ok(oldest.candles.every(c=>c.t<middle.pagination.nextBefore));assert.equal(oldest.seriesKey,latest.seriesKey);
  assert.equal(calls.length,3);assert.equal(calls[1].searchParams.get('to'),String(latest.pagination.nextBefore-1));assert.equal(calls[2].searchParams.get('to'),String(middle.pagination.nextBefore-1));assert.ok(calls.every(u=>u.searchParams.get('address')===(platform==='flap'?launched:A)));assert.deepEqual((await service.get(A,'1min')).candles,latest.candles,'historical windows never replace the latest cache');
 }
});

test('indexed historical errors and ignored cursors return explicit gaps while preserving the latest true candles',async()=>{
 for(const problem of ['failure','ignored']){
  let reads=0;const rows=Array.from({length:300},(_,i)=>[2,4,1,3,1,T-(299-i)*60000]);const row=token({platformId:'four',pad:undefined,launchType:undefined,phase:'graduated'});
  const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async url=>{reads++;if(new URL(url).searchParams.has('to')&&problem==='failure')throw Error('offline');return{data:rows};}});
  const latest=await service.get(A,'1min'),older=await service.get(A,'1min','price',{before:latest.pagination.nextBefore});assert.equal(older.historyPartial,true);assert.deepEqual(older.candles,[]);assert.equal(reads,2);assert.equal(older.pagination.reason,problem==='failure'?'indexed-upstream-unavailable':'indexed-cursor-ignored');assert.deepEqual((await service.get(A,'1min')).candles,latest.candles);
 }
});

test('indexed source backfill preserves unknown historical volume even when the latest source page had known volume',async()=>{
 const row=token({platformId:'four',pad:undefined,launchType:undefined,phase:'graduated'}),recent=Array.from({length:300},(_,i)=>[2,4,1,3,1,T-(299-i)*60000]);
 const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async url=>({data:new URL(url).searchParams.has('to')?[[2,4,1,3,null,T-600*60000]]:recent})});
 const latest=await service.get(A,'1min'),history=await service.get(A,'1min','price',{before:latest.pagination.nextBefore});assert.equal(latest.volumeUnit,'source-reported');assert.equal(history.volumeUnit,null);assert.ok(history.candles.every(c=>c.v===null));
});

test('5s and 15s indexed history completes the raw-second boundary bucket before exposing it behind an exclusive cursor',async()=>{
 for(const [interval,seconds]of [['5s',5],['15s',15]]){
  const row=token({platformId:'four',pad:undefined,launchType:undefined,phase:'graduated'}),rows=Array.from({length:650},(_,i)=>{const t=T-(649-i)*1000,p=t===T-300000?99:2;return[p,p,p,p,1,t];});
  const service=createCandleService({snapshot:()=>({tokens:[row]}),now:()=>T,getJson:async url=>{const to=Number(new URL(url).searchParams.get('to')??T);return{data:rows.filter(r=>r[5]<=to).slice(-300)};}});
  const latest=await service.get(A,interval);assert.equal(latest.candles[0].t,T-(300-seconds)*1000,'the incomplete oldest source bucket must remain behind the cursor');
  const older=await service.get(A,interval,'price',{before:latest.pagination.nextBefore}),seam=older.candles.find(c=>c.t===T-300000);assert.deepEqual(seam,{t:T-300000,o:99,h:99,l:2,c:2,v:seconds});assert.ok(older.candles.every(c=>c.t<latest.pagination.nextBefore));
 }
});
