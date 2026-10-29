import test from 'node:test';
import assert from 'node:assert/strict';

const T=1_800_000_000_000,WBNB='0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',ZERO=`0x${'0'.repeat(40)}`,QUOTE=`0x${'a'.repeat(40)}`;
const bar=(t=T,extra={})=>({t,o:2,h:4,l:1,c:3,v:7,...extra});
const data=(extra={})=>({address:`0x${'b'.repeat(40)}`,chartAddress:`0x${'b'.repeat(40)}`,interval:'1min',mode:'price',source:'gang-candles',seriesKey:'native-series',priceUnit:'WBNB',volumeUnit:'WBNB',candles:[bar()],pagination:{hasMore:true,nextBefore:T,scope:'official-window'},graduation:{value:10},graduationEvent:{at:T,verified:true},...extra});
const fx=(rows)=>({status:{error_code:'0'},data:rows.map(([t,c])=>[c,c,c,c,1,t])});
const source={quoteAsset:WBNB,quoteSymbol:'WBNB',positionKind:'token'};
async function service(options={}){
 const module=await import('../src/chart-currency.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
 assert.equal(typeof module.createChartCurrency,'function','historical currency conversion service must exist');
 return module.createChartCurrency({now:()=>T+120_000,...options});
}

test('canonical native BNB and wrapped BNB are one-to-one without requesting FX',async()=>{
 const converter=await service({getJson:()=>assert.fail('identity conversion must not fetch')});
 for(const [unit,asset]of [['BNB',ZERO],['WBNB',WBNB]]){
  const input=data({priceUnit:unit});const output=await converter.convert(input,'BNB',{quoteAsset:asset,quoteSymbol:unit});
  assert.deepEqual(output.candles,input.candles);assert.notEqual(output.candles,input.candles);assert.equal(output.priceUnit,'BNB');assert.equal(output.currencyConversion.status,'native');
  assert.deepEqual(output.graduation,input.graduation);assert.equal(input.priceUnit,unit);
 }
});

test('USD conversion applies each historical bucket close to all OHLC and leaves volume in its original unit',async()=>{
 const converter=await service({getJson:async()=>fx([[T,500],[T+60000,600]])});
 const input=data({mode:'marketcap',capBasis:'FDV',candles:[bar(),bar(T+60000)]});
 const output=await converter.convert(input,'USD',source);
 assert.deepEqual(output.candles,[bar(T,{o:1000,h:2000,l:500,c:1500}),bar(T+60000,{o:1200,h:2400,l:600,c:1800})]);
 assert.equal(output.priceUnit,'USD');assert.equal(output.volumeUnit,'WBNB');assert.equal(output.capBasis,'FDV');assert.equal(output.currencyConversion.status,'estimated');assert.match(output.warning,/历史.*估算|估算.*历史/);assert.equal(output.graduation.value,5000);assert.equal(output.graduation.referenceAt,T);assert.deepEqual(output.graduationEvent,input.graduationEvent);assert.deepEqual(input.candles,[bar(),bar(T+60000)]);
});

test('indexed USD to BNB uses the reciprocal historical BNB rate while USD itself requires no rate',async()=>{
 let calls=0;const converter=await service({getJson:async()=>{calls++;return fx([[T,500]]);}}),input=data({priceUnit:'USD',source:'binance-public',candles:[bar(T,{o:1000,h:2000,l:500,c:1500,v:null})]});
 const native=await converter.convert(input,'USD',source);assert.deepEqual(native.candles,input.candles);assert.equal(calls,0);
 const output=await converter.convert(input,'BNB',source);assert.deepEqual(output.candles,[bar(T,{v:null})]);assert.equal(output.priceUnit,'BNB');assert.equal(calls,1);assert.notEqual(output.seriesKey,native.seriesKey);
});

test('foreign quote prices use quote/USD divided by BNB/USD and preserve the share instrument',async()=>{
 const calls=[];const converter=await service({getJson:async url=>{const u=new URL(url);calls.push(u);return fx([[T,u.searchParams.get('address').toLowerCase()===QUOTE?10:500]]);}});
 const input=data({priceUnit:'QQQB/份额',volumeUnit:'QQQB',capBasis:'share-equivalent-FDV'}),quote={quoteAsset:QUOTE,quoteSymbol:'QQQB',positionKind:'shares'};
 const output=await converter.convert(input,'BNB',quote);assert.deepEqual(output.candles,[bar(T,{o:.04,h:.08,l:.02,c:.06})]);assert.equal(output.priceUnit,'BNB/份额');assert.equal(output.capBasis,'share-equivalent-FDV');assert.equal(output.volumeUnit,'QQQB');
 const usd=await converter.convert(input,'USD',quote);assert.equal(usd.priceUnit,'USD/份额');assert.equal(usd.candles[0].c,30);assert.equal(calls.length,2,'the shared historical quote window is reused');
 assert.ok(calls.every(u=>u.origin==='https://dquery.sintral.io'&&u.searchParams.get('limit')==='300'&&u.searchParams.get('pm')==='p'&&!u.searchParams.has('before')));
});

test('a token claiming BNB by symbol cannot acquire the canonical one-to-one conversion',async()=>{
 let calls=0;const converter=await service({getJson:async()=>{calls++;return fx([[T,500]]);}});
 for(const quote of [{quoteAsset:QUOTE,quoteSymbol:'BNB'},{quoteAsset:WBNB,quoteSymbol:'QQQB'},{quoteAsset:'not-an-address',quoteSymbol:'WBNB'}]){
  const output=await converter.convert(data(),'BNB',quote);assert.deepEqual(output.candles,[]);assert.equal(output.currencyConversion.status,'unavailable');
 }
 assert.equal(calls,0,'mismatched quote identities must fail before historical requests');
});

test('one older missing historical rate fails the whole page closed and preserves the original pagination separately',async()=>{
 const converter=await service({now:()=>T+180000,getJson:async()=>fx([[T,500]])}),input=data({candles:[bar(),bar(T+60000)]});
 const output=await converter.convert(input,'USD',source);assert.deepEqual(output.candles,[]);assert.equal(output.priceUnit,'USD');assert.equal(output.kind,'empty');assert.equal(output.currencyConversion.status,'unavailable');assert.deepEqual(output.currencyConversion.missingBuckets,[T+60000]);assert.equal(output.pagination.hasMore,false);assert.deepEqual(output.sourcePagination,input.pagination);assert.notEqual(output.seriesKey,input.seriesKey);assert.equal(output.continuous,false);assert.match(output.warning,/历史汇率/);
});

test('rates outside the requested buckets are never interpolated or replaced by current market FX',async()=>{
 const converter=await service({getJson:async()=>fx([[T-60000,500],[T+60000,600]])});
 const output=await converter.convert(data({valuationQuoteUsd:999}),'USD',source);assert.equal(output.currencyConversion.status,'unavailable');assert.deepEqual(output.candles,[]);
});

test('malformed, nonpositive, misaligned, future and conflicting historical FX fail closed',async()=>{
 const malformed=[{data:[[500,500,500,0,1,T]]},{data:[[500,500,500,500,1,T+1]]},{data:[[500,500,500,500,1,T+180000]]},{data:[[500,500,500,500,1,T],[600,600,600,600,1,T]]},{status:{error_code:9},data:[[500,500,500,500,1,T]]},{data:Array.from({length:301},()=>[500,500,500,500,1,T])}];
 for(const response of malformed){const converter=await service({getJson:async()=>response});const result=await converter.convert(data(),'USD',source);assert.equal(result.currencyConversion.status,'unavailable');assert.deepEqual(result.candles,[]);}
});

test('historical FX cache expires, coalesces concurrent consumers and never makes FX values part of series identity',async()=>{
 let clock=T+120000,calls=0,rate=500,release;const converter=await service({now:()=>clock,ttlMs:5000,getJson:async()=>{calls++;if(calls===1)await new Promise(resolve=>{release=resolve;});return fx([[T,rate]]);}});
 const a=converter.convert(data(),'USD',source),b=converter.convert(data(),'USD',source);await new Promise(setImmediate);assert.equal(calls,1);release();const[first,second]=await Promise.all([a,b]);assert.deepEqual(first.candles,second.candles);
 rate=600;clock+=4999;assert.equal((await converter.convert(data(),'USD',source)).candles[0].c,1500);assert.equal(calls,1);
 clock++;const updated=await converter.convert(data(),'USD',source);assert.equal(updated.candles[0].c,1800);assert.equal(calls,2);assert.equal(updated.seriesKey,first.seriesKey);
});

test('cache entry bounds evict old assets and failed refreshes do not reuse expired rates',async()=>{
 let calls=0,clock=T+120000,broken=false;const converter=await service({maxEntries:1,ttlMs:1000,now:()=>clock,getJson:async()=>{calls++;if(broken)throw Error('upstream down');return fx([[T,500]]);}});
 await converter.convert(data(),'USD',source);await converter.convert(data({priceUnit:'QQQB'}),'USD',{quoteAsset:QUOTE,quoteSymbol:'QQQB'});await converter.convert(data(),'USD',source);assert.equal(calls,3);
 broken=true;clock+=1000;const output=await converter.convert(data(),'USD',source);assert.equal(output.currencyConversion.status,'unavailable');assert.deepEqual(output.candles,[]);
});

test('concurrent FX work is bounded and a capacity failure cannot create an unconverted BNB chart',async()=>{
 const releases=[];let active=0,peak=0;const converter=await service({getJson:async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>releases.push(resolve));active--;return fx([[T,500]]);}});
 const pending=Array.from({length:7},(_,i)=>converter.convert(data({priceUnit:'QUOTE'}),'USD',{quoteAsset:`0x${String(i+1).padStart(40,'0')}`,quoteSymbol:'QUOTE'}));
 await new Promise(setImmediate);assert.ok(peak<=4);assert.equal(releases.length,4);for(const release of releases)release();const results=await Promise.all(pending);assert.equal(results.filter(row=>row.currencyConversion.status==='estimated').length,4);assert.equal(results.filter(row=>row.currencyConversion.status==='unavailable').length,3);
});

test('second intervals aggregate only observed seconds within their exact requested buckets',async()=>{
 const calls=[];const converter=await service({getJson:async url=>{calls.push(new URL(url));return fx([[T,400],[T+1000,500],[T+5000,600]]);}});
 const output=await converter.convert(data({interval:'5s',candles:[bar(),bar(T+5000)]}),'USD',source);assert.deepEqual(output.candles,[bar(T,{o:1000,h:2000,l:500,c:1500}),bar(T+5000,{o:1200,h:2400,l:600,c:1800})]);assert.equal(calls[0].searchParams.get('interval'),'1s');
});

test('input and output sizes, unsupported currency and nonfinite conversion never escape the safe contract',async()=>{
 const converter=await service({getJson:async()=>fx([[T,1e308]])});
 await assert.rejects(()=>converter.convert(data(),'ETH',source),/currency|币种/i);
 const tooMany=await converter.convert(data({candles:Array.from({length:5001},(_,i)=>bar(T-i*60000))}),'USD',source);assert.deepEqual(tooMany.candles,[]);assert.equal(tooMany.currencyConversion.status,'unavailable');
 const output=await converter.convert(data(),'USD',source);assert.deepEqual(output.candles,[]);assert.equal(output.currencyConversion.status,'unavailable');
});

test('quote identity and economic instrument remain isolated even if a caller supplies the same upstream series name',async()=>{
 const converter=await service({getJson:async()=>fx([[T,500]])});
 const native=await converter.convert(data(),'USD',source);
 const foreign=await converter.convert(data({priceUnit:'QQQB'}),'USD',{quoteAsset:QUOTE,quoteSymbol:'QQQB'});
 const shares=await converter.convert(data({priceUnit:'QQQB/份额'}),'USD',{quoteAsset:QUOTE,quoteSymbol:'QQQB',positionKind:'shares'});
 assert.notEqual(native.seriesKey,foreign.seriesKey);assert.notEqual(foreign.seriesKey,shares.seriesKey);
 assert.notEqual(native.currencyConversion.basisKey,foreign.currencyConversion.basisKey);assert.notEqual(foreign.currencyConversion.basisKey,shares.currencyConversion.basisKey);
 const otherCurrency=await converter.convert(data(),'BNB',source),otherSource=await converter.convert(data({source:'local-curve'}),'USD',source);
 assert.notEqual(native.currencyConversion.basisKey,otherCurrency.currencyConversion.basisKey);assert.notEqual(native.currencyConversion.basisKey,otherSource.currencyConversion.basisKey);
});

test('empty quote symbols and invalid share annotations are unavailable before any historical request',async()=>{
 let calls=0;const converter=await service({getJson:async()=>{calls++;return fx([[T,500]]);}});
 const missing=await converter.convert(data({priceUnit:''}),'USD',{quoteAsset:QUOTE,quoteSymbol:''});
 assert.equal(missing.currencyConversion.status,'unavailable');
 const wrongKind=await converter.convert(data({priceUnit:'WBNB/份额'}),'USD',{...source,positionKind:'token'});
 assert.equal(wrongKind.currencyConversion.status,'unavailable');
 assert.equal(calls,0,'unverified units cannot reach the historical FX source');
});

test('an ERC20 quote named USD is converted through its asset history rather than impersonating fiat dollars',async()=>{
 let calls=0;const converter=await service({getJson:async()=>{calls++;return fx([[T,10]]);}});
 const input=data({priceUnit:'USD',source:'gang-candles'}),output=await converter.convert(input,'USD',{quoteAsset:QUOTE,quoteSymbol:'USD'});
 assert.equal(calls,1);assert.equal(output.currencyConversion.status,'estimated');assert.equal(output.candles[0].c,30);
 const unknown=await converter.convert(input,'USD',{});assert.equal(unknown.currencyConversion.status,'unavailable');assert.deepEqual(unknown.candles,[]);
});

test('a missing FX refresh retains the same conversion basis while its unavailable series identity stays distinct',async()=>{
 let clock=T+120000,missing=false;const converter=await service({now:()=>clock,ttlMs:1000,getJson:async()=>fx(missing?[]:[[T,500]])});
 const success=await converter.convert(data(),'USD',source);clock+=1000;missing=true;
 const unavailable=await converter.convert(data(),'USD',source);
 assert.equal(success.currencyConversion.status,'estimated');assert.equal(unavailable.currencyConversion.status,'unavailable');assert.deepEqual(unavailable.candles,[]);
 assert.equal(typeof success.currencyConversion.basisKey,'string');assert.ok(success.currencyConversion.basisKey.length>0);assert.equal(success.currencyConversion.basisKey,unavailable.currencyConversion.basisKey);assert.notEqual(success.seriesKey,unavailable.seriesKey);
});

test('one or two missing recent tail rates show only the converted prefix and cap the displayed end time',async()=>{
 for(const missingCount of [1,2]){
  const converter=await service({getJson:async()=>fx(missingCount===2?[[T,500]]:[[T,500],[T+60000,600]])});
  const input=data({candles:[bar(),bar(T+60000),bar(T+120000)],lastCandleAt:new Date(T+120000).toISOString(),coverage:{scope:'official-window',from:T,to:T+120000},sourcePagination:{hasMore:true,nextBefore:T}});
  const output=await converter.convert(input,'USD',source);
  assert.equal(output.currencyConversion.status,'estimated');assert.equal(output.currencyConversion.partial,true);assert.deepEqual(output.currencyConversion.missingBuckets,missingCount===2?[T+60000,T+120000]:[T+120000]);
  assert.deepEqual(output.candles,missingCount===2?[bar(T,{o:1000,h:2000,l:500,c:1500})]:[bar(T,{o:1000,h:2000,l:500,c:1500}),bar(T+60000,{o:1200,h:2400,l:600,c:1800})]);
  const end=missingCount===2?T:T+60000;assert.equal(output.endAt,end);assert.equal(output.lastCandleAt,new Date(end).toISOString());assert.equal(output.sourceLastCandleAt,input.lastCandleAt);assert.equal(output.stale,true);assert.equal(output.volumeUnit,'WBNB');assert.deepEqual(output.pagination,input.pagination);assert.deepEqual(output.sourcePagination,input.sourcePagination);assert.deepEqual(output.coverage,input.coverage);assert.match(output.warning,/尾部历史汇率待更新/);
 }
});

test('recent-tail allowance cannot hide internal, old, excessive, leading or wholly missing FX',async()=>{
 const examples=[
  {rows:[bar(),bar(T+60000),bar(T+120000)],rates:[[T,500],[T+120000,600]]},
  {rows:[bar(T-120000),bar(T-60000)],rates:[[T-120000,500]]},
  {rows:[bar(T-60000),bar(),bar(T+60000),bar(T+120000)],rates:[[T-60000,500]]},
  {rows:[bar(T+60000),bar(T+120000)],rates:[[T+120000,600]]},
  {rows:[bar(T+60000),bar(T+120000)],rates:[]},
 ];
 for(const example of examples){
  const converter=await service({getJson:async()=>fx(example.rates)}),output=await converter.convert(data({candles:example.rows}),'USD',source);
  assert.equal(output.currencyConversion.status,'unavailable');assert.deepEqual(output.candles,[]);assert.notEqual(output.currencyConversion.partial,true);
 }
});

test('tail FX recovery restores the missing buckets without changing estimated series or conversion basis',async()=>{
 let clock=T+120000,ready=false;const converter=await service({now:()=>clock,ttlMs:1000,getJson:async()=>fx(ready?[[T,500],[T+60000,600],[T+120000,700]]:[[T,500],[T+60000,600]])});
 const input=data({candles:[bar(),bar(T+60000),bar(T+120000)],lastCandleAt:new Date(T+120000).toISOString()});
 const partial=await converter.convert(input,'USD',source);assert.equal(partial.currencyConversion.partial,true);
 clock+=1000;ready=true;const complete=await converter.convert(input,'USD',source);
 assert.equal(complete.currencyConversion.status,'estimated');assert.notEqual(complete.currencyConversion.partial,true);assert.deepEqual(complete.currencyConversion.missingBuckets,[]);assert.equal(complete.candles.length,3);assert.equal(complete.candles.at(-1).c,2100);assert.equal(complete.seriesKey,partial.seriesKey);assert.equal(complete.currencyConversion.basisKey,partial.currencyConversion.basisKey);assert.equal(complete.lastCandleAt,input.lastCandleAt);assert.equal(complete.endAt,undefined);assert.notEqual(complete.stale,true);
});

test('historical FX targets the actual sparse native candle times instead of being limited to the latest 300 rates',async()=>{
 const calls=[],old=T-600*60000;
 const converter=await service({now:()=>T,getJson:async url=>{const u=new URL(url);calls.push(u);const end=Number(u.searchParams.get('to')??T),rate=end===old?100:200;return fx(Array.from({length:300},(_,i)=>[end-(299-i)*60000,rate]));}});
 const input=data({candles:[bar(old),bar()]}),output=await converter.convert(input,'USD',source);
 assert.equal(output.currencyConversion.status,'estimated');assert.deepEqual(output.candles,[bar(old,{o:200,h:400,l:100,c:300}),bar(T,{o:400,h:800,l:200,c:600})]);assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('to'),String(old));
 assert.equal(output.currencyConversion.coverage.complete,true);assert.equal(output.currencyConversion.coverage.matchedBuckets,2);assert.equal(output.currencyConversion.coverage.assets[0].pages,2);assert.equal(output.currencyConversion.coverage.truncated,false);
 const again=await converter.convert({...input,mode:'marketcap'},'USD',source);assert.equal(again.candles[0].c,300);assert.equal(calls.length,2,'price and FDV consumers reuse the same exact historic windows');
});

test('an older native page selects its own historical FX window without contaminating the latest cache',async()=>{
 const calls=[],old=T-1000*60000;
 const converter=await service({now:()=>T,getJson:async url=>{const u=new URL(url);calls.push(u);const end=Number(u.searchParams.get('to')??T);return fx([[end,end===old?100:200]]);}});
 const historical=await converter.convert(data({candles:[bar(old)]}),'USD',source),latest=await converter.convert(data(),'USD',source);
 assert.equal(historical.candles[0]?.c,300);assert.equal(latest.candles[0]?.c,600);assert.equal(calls[0].searchParams.get('to'),String(old));assert.equal(calls[1].searchParams.has('to'),false);assert.equal(historical.seriesKey,latest.seriesKey);
});

test('FX history page budgets report exact unmatched buckets and truncation without falling back to present rates',async()=>{
 let reads=0;const old=T-600*60000;
 const converter=await service({now:()=>T,maxPages:1,getJson:async()=>{reads++;return fx([[T,200]]);}});
 const output=await converter.convert(data({candles:[bar(old),bar()],valuationQuoteUsd:999}),'USD',source);
 assert.equal(output.currencyConversion.status,'unavailable');assert.deepEqual(output.candles,[]);assert.deepEqual(output.currencyConversion.missingBuckets,[old]);assert.equal(reads,1);assert.ok(output.currencyConversion.coverage,'missing FX must explain its bounded coverage');assert.equal(output.currencyConversion.coverage.truncated,true);assert.equal(output.currencyConversion.coverage.assets[0].reason,'history-page-budget');assert.equal(output.currencyConversion.coverage.matchedBuckets,1);
});

test('an upstream that ignores historical FX cursors cannot inject a current rate into an old bucket',async()=>{
 let reads=0;const old=T-600*60000;
 const converter=await service({now:()=>T,getJson:async()=>{reads++;return fx([[T,200]]);}});
 const output=await converter.convert(data({candles:[bar(old),bar()]}),'USD',source);
 assert.equal(output.currencyConversion.status,'unavailable');assert.deepEqual(output.currencyConversion.missingBuckets,[old]);assert.deepEqual(output.candles,[]);assert.equal(reads,2);assert.equal(output.currencyConversion.coverage.assets[0].reason,'historical-window-invalid');
});

test('an internal missing FX bucket stays unknown with explicit coverage rather than being filled from nearby history',async()=>{
 let reads=0;const converter=await service({now:()=>T+600000,getJson:async()=>{reads++;return fx([[T,100],[T+120000,200]]);}});
 const output=await converter.convert(data({candles:[bar(),bar(T+60000),bar(T+120000)]}),'USD',source);
 assert.equal(output.currencyConversion.status,'unavailable');assert.deepEqual(output.currencyConversion.missingBuckets,[T+60000]);assert.equal(reads,1);assert.ok(output.currencyConversion.coverage,'missing FX must explain which buckets were covered');assert.equal(output.currencyConversion.coverage.complete,false);assert.equal(output.currencyConversion.coverage.truncated,false);assert.equal(output.currencyConversion.coverage.assets[0].reason,'historical-buckets-missing');
});

test('a malformed FX bucket outside the requested native times is quarantined without discarding independent valid historical rates',async()=>{
 const converter=await service({now:()=>T+600000,getJson:async()=>({data:[[100,100,100,100,1,T],[150,140,130,135,1,T+60000],[200,200,200,200,1,T+120000]]})});
 const output=await converter.convert(data({candles:[bar(),bar(T+120000)]}),'USD',source);
 assert.equal(output.currencyConversion.status,'estimated');assert.deepEqual(output.candles.map(c=>c.c),[300,600]);assert.equal(output.currencyConversion.coverage.complete,true);assert.deepEqual(output.currencyConversion.coverage.assets[0].rejectedBuckets,[T+60000]);
});

test('a requested malformed FX bucket stays missing while coverage records the valid neighboring buckets',async()=>{
 const converter=await service({now:()=>T+600000,getJson:async()=>({data:[[100,100,100,100,1,T],[150,140,130,135,1,T+60000],[200,200,200,200,1,T+120000]]})});
 const output=await converter.convert(data({candles:[bar(),bar(T+60000),bar(T+120000)]}),'USD',source);
 assert.equal(output.currencyConversion.status,'unavailable');assert.deepEqual(output.currencyConversion.missingBuckets,[T+60000]);assert.equal(output.currencyConversion.coverage.matchedBuckets,2);assert.deepEqual(output.candles,[]);
});

test('a full 300-bucket 15-second page can retrieve its corresponding observed second FX windows within the hard page bound',async()=>{
 let reads=0;const converter=await service({now:()=>T,getJson:async url=>{reads++;const to=Number(new URL(url).searchParams.get('to')??T);return fx(Array.from({length:300},(_,i)=>[to-(299-i)*1000,100]));}});
 const output=await converter.convert(data({interval:'15s',candles:Array.from({length:300},(_,i)=>bar(T-(299-i)*15000))}),'USD',source);
 assert.equal(output.currencyConversion.status,'estimated');assert.equal(output.candles.length,300);assert.equal(output.candles[0].c,300);assert.ok(reads<=16);assert.equal(output.currencyConversion.coverage.truncated,false);
});

test('foreign-quote graduation line uses graduation-time FX in USD and BNB, not the latest candle rate',async()=>{
 const converter=await service({now:()=>T+240000,getJson:async url=>fx([[T,new URL(url).searchParams.get('address').toLowerCase()===QUOTE?10:500],[T+60000,new URL(url).searchParams.get('address').toLowerCase()===QUOTE?20:1000]])});
 const input=data({priceUnit:'GANG',candles:[bar(T+60000)],graduation:{value:100,label:'理论毕业线'},graduationEvent:{at:T+1234,verified:false,proof:'official-index'}}),quote={quoteAsset:QUOTE,quoteSymbol:'GANG'};
 const usd=await converter.convert(input,'USD',quote),bnb=await converter.convert(input,'BNB',quote);
 assert.equal(usd.graduation.value,1000);assert.equal(bnb.graduation.value,2);
 assert.equal(usd.graduation.referenceAt,T);assert.equal(usd.graduation.referenceFx,false);
 assert.equal(usd.candles[0].c,60);assert.equal(input.graduation.value,100);
});
test('missing graduation-time FX hides only the unverified line and never substitutes the latest FX',async()=>{
 const converter=await service({now:()=>T+240000,getJson:async()=>fx([[T+60000,600]])});
 const output=await converter.convert(data({candles:[bar(T+60000)]}),'USD',source);
 assert.equal(output.candles.length,1);assert.equal(output.graduation,null);assert.match(output.graduationUnavailable,/汇率/);
});
