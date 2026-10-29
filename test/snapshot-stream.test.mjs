import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
const { createSnapshotStream } = await import('../src/snapshot-stream.mjs').catch(() => ({}));
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const token = (address=A, price='1') => ({address,price,verified:true,platformId:'four',tradable:false});
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn) { for(let i=0;i<100;i++){if(fn())return;await sleep(5);}assert.fail('timed out'); }
async function fixture(t, options) {
 assert.equal(typeof createSnapshotStream,'function','shared snapshot stream is implemented');
 const hub=createSnapshotStream(options), server=http.createServer((req,res)=>hub.attach(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{hub.close();server.closeAllConnections();server.close();});
 const connect=async()=>{const controller=new AbortController(); const response=await fetch(`http://127.0.0.1:${server.address().port}`,{signal:controller.signal}); t.after(()=>controller.abort());return {response,controller,reader:response.body.getReader()};};
 return {hub,connect};
}
async function next(client) { return new TextDecoder().decode((await client.reader.read()).value); }
test('one sampling loop sends initial snapshots and ordered token removals/upserts to all clients',async t=>{
 let reads=0, current={tokens:[token()],monitor:{status:'live'},wallets:[{note:'PRIVATE'}]};
 const {hub,connect}=await fixture(t,{read:()=>{reads++;return current;},intervalMs:30,heartbeatMs:1000});
 const first=await connect();const initial=await next(first);assert.match(initial,/"type":"snapshot"/);assert.doesNotMatch(initial,/PRIVATE/);
 const second=await connect();const again=await next(second);assert.match(again,/"revision":1/);assert.equal(reads,1);
 current={tokens:[token(B,'2')],monitor:{status:'degraded'}};
 const [a,b]=await Promise.all([next(first),next(second)]);
 for(const frame of [a,b]){assert.match(frame,/"type":"delta"/);assert.match(frame,new RegExp(`"removed":\\["${A}"\\]`));assert.match(frame,/"price":"2"/);assert.match(frame,/"revision":2/);}
 assert.equal(reads,2);first.controller.abort();second.controller.abort();await until(()=>hub.metrics().subscribers===0);
 const count=reads;await sleep(65);assert.equal(reads,count);
 const third=await connect();assert.match(await next(third),/"type":"snapshot"/);
});
test('heartbeats and safe read failures keep the stream alive without leaking errors',async t=>{
 let fail=false;
 const {connect,hub}=await fixture(t,{read:()=>{if(fail)throw Error('SECRET');return {tokens:[],monitor:{status:'live'}};},intervalMs:20,heartbeatMs:15});
 const c=await connect();await next(c);assert.match(await next(c),/: heartbeat/);fail=true;
 let wire='';
 for(let i=0;i<5&&!wire.includes('unavailable');i++)wire+=await next(c);
 assert.match(wire,/unavailable/);assert.doesNotMatch(wire,/SECRET/);assert.ok(hub.metrics().readErrors>0);
});
test('private full mode emits snapshots without converting tracking data into market deltas',async t=>{
 const {connect}=await fixture(t,{read:()=>({wallets:[{address:A,note:'owner only'}],events:[]}),mode:'full',eventName:'tracking',intervalMs:50});
 const c=await connect();const wire=await next(c);assert.match(wire,/event: tracking/);assert.match(wire,/owner only/);assert.match(wire,/"type":"snapshot"/);
});
test('maximum subscribers rejects excess and blocked writers are cut off without a growing queue',async()=>{
 assert.equal(typeof createSnapshotStream,'function');
 class Response extends EventEmitter {constructor(blocked=false){super();this.blocked=blocked;this.writableLength=0;this.writes=[];}writeHead(status){this.status=status;}flushHeaders(){}write(chunk){this.writes.push(chunk);return !this.blocked;}end(){this.ended=true;this.emit('close');}destroy(){this.destroyed=true;this.emit('close');}}
 const hub=createSnapshotStream({read:()=>({tokens:[],monitor:{status:'live'}}),intervalMs:10,heartbeatMs:10,maxSubscribers:1,slowClientMs:20});
 const req=new EventEmitter(), slow=new Response(true);hub.attach(req,slow);
 const rejected=new Response();hub.attach(new EventEmitter(),rejected);assert.equal(rejected.status,503);
 await until(()=>slow.destroyed);assert.equal(slow.writes.length,1);assert.equal(hub.metrics().subscribers,0);hub.close();hub.close();
 const after=new Response();hub.attach(new EventEmitter(),after);assert.equal(after.status,503);
});
test('invalid identity and oversized public data never enter the stream',async t=>{
 const {hub,connect}=await fixture(t,{read:()=>({tokens:[{...token(),verified:false}],monitor:{status:'live'}}),intervalMs:20,maxFrameBytes:256});
 const c=await connect();assert.match(await next(c),/unavailable/);assert.equal(hub.metrics().revision,0);
});
test('a new client during a read failure receives unavailable rather than a cached live quote',async t=>{
 let fail=false;const {hub,connect}=await fixture(t,{read:()=>{if(fail)throw Error('private detail');return {tokens:[token()],monitor:{status:'live'}};},intervalMs:10,heartbeatMs:1000});
 const first=await connect();await next(first);fail=true;await until(()=>hub.metrics().readErrors>0);const second=await connect();assert.match(await next(second),/unavailable/);
});
test('a hanging read never overlaps retries and close aborts it without late frames',async()=>{
 assert.equal(typeof createSnapshotStream,'function');let resolve,signal,reads=0;
 class Response extends EventEmitter {writeHead(){}flushHeaders(){}write(){this.frames=(this.frames||0)+1;return true;}end(){this.emit('close');}}
 const response=new Response();const hub=createSnapshotStream({read:options=>{signal=options.signal;reads++;return new Promise(r=>resolve=r);},readTimeoutMs:5,intervalMs:5,heartbeatMs:1000});
 hub.attach(new EventEmitter(),response);await sleep(25);assert.equal(reads,1);assert.equal(signal.aborted,true);assert.equal(hub.metrics().readErrors,1);hub.close();const count=response.frames;resolve({tokens:[],monitor:{status:'live'}});await sleep(10);assert.equal(response.frames,count);assert.equal(hub.metrics().subscribers,0);
});
test('oversized valid data is rejected before retention or transmission',async t=>{
 const {hub,connect}=await fixture(t,{read:()=>({tokens:[{...token(),name:'a'.repeat(600)}],monitor:{status:'live'}}),maxFrameBytes:256,intervalMs:20});const c=await connect();assert.match(await next(c),/unavailable/);assert.equal(hub.metrics().revision,0);
});

async function privateFrame(client){
 client.pending ||= '';while(!client.pending.includes('\n\n')){const chunk=await client.reader.read();assert.equal(chunk.done,false);client.pending+=new TextDecoder().decode(chunk.value);}
 const end=client.pending.indexOf('\n\n')+2,wire=client.pending.slice(0,end);client.pending=client.pending.slice(end);
 return{wire,frame:JSON.parse(wire.split('\n').find(line=>line.startsWith('data:')).slice(5))};
}
const privateData=()=>({wallets:[{address:A,note:'owner'}],events:Array.from({length:300},(_,i)=>({id:'confirmed:'+i,confirmed:true})),indexedEvents:Array.from({length:300},(_,i)=>({id:'indexed:'+i,confirmed:false})),preferences:{showAvatars:true},status:{state:'live',lagBlocks:2,indexer:{state:'observing',updatedAt:'initial'}}});
test('opt-in private status deltas preserve all 600 history rows and full every nonstatus change',async t=>{
 let current=privateData();const {connect}=await fixture(t,{read:()=>current,mode:'full',eventName:'tracking',statusDeltas:true,intervalMs:15,heartbeatMs:10000});
 const c=await connect();assert.equal((await privateFrame(c)).frame.type,'snapshot');
 current={...current,status:{...current.status,lagBlocks:9,indexer:{state:'observing',updatedAt:'next'}}};
 const update=await privateFrame(c);assert.equal(update.frame.type,'status');assert.ok(Buffer.byteLength(update.wire)<1024);assert.deepEqual(update.frame.status,current.status);assert.equal('data' in update.frame,false);
 for(const field of ['events','indexedEvents','wallets','preferences','futureField']){
  current={...current,[field]:field==='preferences'?{showAvatars:false}:field==='futureField'?{retained:true}:[...current[field],field==='wallets'?{address:B,note:'second'}:{id:'new',confirmed:field==='events'}]};
  const full=(await privateFrame(c)).frame;assert.equal(full.type,'snapshot',field+' changes require full reset');assert.deepEqual(full.data,current);
 }
});
test('private status delta optimization is opt-in and default full mode remains opaque',async t=>{
 let current=privateData();const {connect}=await fixture(t,{read:()=>current,mode:'full',eventName:'tracking',intervalMs:15,heartbeatMs:10000});const c=await connect();await privateFrame(c);
 current={...current,status:{state:'error',message:'still delivered',lagBlocks:90}};assert.equal((await privateFrame(c)).frame.type,'snapshot');
});
test('blocked status-delta subscribers drain to a complete latest reset and new clients start full',async()=>{
 class Response extends EventEmitter{constructor(){super();this.frames=[];this.blocked=true;this.writableLength=0;}writeHead(){}flushHeaders(){}write(wire){this.frames.push(wire);return !this.blocked;}end(){this.emit('close');}}
 let current=privateData();const hub=createSnapshotStream({read:()=>current,mode:'full',eventName:'tracking',statusDeltas:true,intervalMs:5,heartbeatMs:10000,slowClientMs:1000});
 const response=new Response();try{hub.attach(new EventEmitter(),response);await until(()=>hub.metrics().revision===1);
 current={...current,status:{state:'delayed',lagBlocks:77}};await until(()=>hub.metrics().revision===2);assert.equal(response.frames.length,1);
 response.blocked=false;response.emit('drain');const reset=JSON.parse(response.frames[1].split('\n')[1].slice(6));assert.equal(reset.type,'snapshot');assert.equal(reset.data.events.length,300);assert.equal(reset.data.status.lagBlocks,77);
 current={...current,status:{state:'error',message:'read unavailable'}};await until(()=>response.frames.length===3);assert.match(response.frames[2],/"type":"status"/);
 const fresh=new Response();fresh.blocked=false;hub.attach(new EventEmitter(),fresh);assert.match(fresh.frames[0],/"type":"snapshot"/);
 }finally{hub.close();}
});

test('opt-in tracking event patches reconstruct replacement/removal/order, reject malformed frames and remain opt-in',async()=>{
 const {applyTrackingFrame,createTrackingDelta}=await import('../src/snapshot-stream.mjs');assert.equal(typeof createTrackingDelta,'function');
 const previous={...privateData(),events:[{id:'a',value:1},{id:'b',value:2},{id:'c',value:3}],indexedEvents:[{id:'i'}]},next={...previous,events:[{id:'new'},{id:'a',value:10},{id:'c',value:3}],indexedEvents:[],status:{state:'delayed'}};
 const delta=createTrackingDelta(previous,next,2);assert.equal(delta.type,'delta');assert.deepEqual(delta.events.removed,['a','b']);assert.deepEqual(delta.events.upserts.map(x=>x.index),[0,1]);assert.deepEqual(applyTrackingFrame(previous,1,delta,2*1024*1024,{eventDeltas:true}).data,next);assert.throws(()=>applyTrackingFrame(previous,1,delta));
 assert.equal(createTrackingDelta(previous,{...previous,events:[previous.events[2],previous.events[0],previous.events[1]]},2),null,'untouched reorder requires full');assert.equal(createTrackingDelta(previous,{...next,preferences:{showAvatars:false}},2),null);
 for(const bad of [null,{...delta,revision:3},{...delta,extra:true},{...delta,events:{removed:['missing'],upserts:[]}},{...delta,events:{removed:['a','a'],upserts:[]}},{...delta,events:{removed:[],upserts:[{index:0,row:{id:'a'}}]}},{...delta,events:{removed:[],upserts:[{index:999,row:{id:'x'}}]}},{...delta,events:{removed:[],upserts:[{index:1,row:{id:'x'}},{index:0,row:{id:'y'}}]}},{...delta,events:{removed:[],upserts:[{index:0,row:JSON.parse('{"id":"x","__proto__":{}}')}]}}])assert.throws(()=>applyTrackingFrame(previous,1,bad,2*1024*1024,{eventDeltas:true}));
 assert.throws(()=>applyTrackingFrame(null,0,delta,2*1024*1024,{eventDeltas:true}));assert.throws(()=>applyTrackingFrame(null,0,{type:'snapshot',revision:1,data:{...previous,events:[{id:'a'},{id:'a'}]}},2*1024*1024,{eventDeltas:true}));assert.throws(()=>applyTrackingFrame(previous,1,{...delta,events:{removed:[],upserts:[{index:0,row:{id:'large',value:'x'.repeat(1000)}}]}},512,{eventDeltas:true}));
});
test('trusted readUpdate skips all full-history serialization on status churn and sends compact event changes',async t=>{
 let value=privateData(),version='data:1',calls=[];const original=JSON.stringify;let historySerializations=0;
 t.mock.method(JSON,'stringify',function(value,...args){if(value?.events===dataEvents||value?.data?.events===dataEvents)historySerializations++;return original.call(this,value,...args);});const dataEvents=value.events;
 const {connect}=await fixture(t,{readUpdate:options=>{calls.push(options.version);return options.version===version?{version,status:value.status}:{version,data:value};},mode:'full',eventName:'tracking',statusDeltas:true,eventDeltas:true,intervalMs:15,heartbeatMs:10000});const c=await connect();assert.equal((await privateFrame(c)).frame.type,'snapshot');const before=historySerializations;
 value={...value,status:{state:'delayed',indexer:{state:'observing',updatedAt:'later'}}};const status=await privateFrame(c);assert.equal(status.frame.type,'status');assert.equal(historySerializations,before);assert.ok(calls.includes('data:1'));
 version='data:2';value={...value,events:[{id:'new',confirmed:true},...value.events.slice(0,299)]};const delta=await privateFrame(c);assert.equal(delta.frame.type,'delta');assert.ok(delta.wire.length<1000);assert.equal(delta.frame.events.upserts[0].index,0);assert.equal(delta.frame.indexedEvents,undefined);
 const fresh=await connect();const reset=(await privateFrame(fresh)).frame;assert.equal(reset.type,'snapshot');assert.equal(reset.data.events.length,300);assert.equal(reset.data.events[0].id,'new');
});
test('trusted producer mismatch requires full reset, bounded status growth fails closed, drain always reconstructs latest full',async()=>{
 class Response extends EventEmitter{constructor(){super();this.frames=[];this.blocked=true;this.writableLength=0;}writeHead(){}flushHeaders(){}write(wire){this.frames.push(wire);return!this.blocked;}end(){this.emit('close');}}
 let update={version:'one',data:{wallets:[],events:[{id:'a',value:'x'.repeat(200)}],indexedEvents:[],status:{state:'live'}}};const versions=[];const hub=createSnapshotStream({readUpdate:({version})=>{versions.push(version);return update;},mode:'full',eventName:'tracking',eventDeltas:true,statusDeltas:true,intervalMs:5,heartbeatMs:10000,maxFrameBytes:700,slowClientMs:1000});const r=new Response();try{hub.attach(new EventEmitter(),r);await until(()=>hub.metrics().revision===1);update={version:'one',status:{state:'delayed',message:'next'}};await until(()=>hub.metrics().revision===2);r.blocked=false;r.emit('drain');assert.match(r.frames.at(-1),/"type":"snapshot"/);assert.match(r.frames.at(-1),/"message":"next"/);
 update={version:'unexpected',status:{state:'error'}};await until(()=>hub.metrics().readErrors>0);assert.equal(hub.metrics().revision,2);await until(()=>versions.at(-1)===null);update={version:'two',data:{wallets:[],events:[],indexedEvents:[],status:{state:'live'}}};await until(()=>hub.metrics().revision===3);assert.match(r.frames.at(-1),/"type":"snapshot"/);
 update={version:'two',status:{state:'error',message:'x'.repeat(800)}};await until(()=>hub.metrics().readErrors>1);assert.equal(hub.metrics().revision,3);
 }finally{hub.close();}
});

test('trusted status validates unsafe keys and a later full can restore an earlier status value',{timeout:1500},async t=>{
 let value=privateData(),version='one',bad=false;const {connect,hub}=await fixture(t,{readUpdate:({version:seen})=>bad?{version,status:JSON.parse('{"state":"live","__proto__":{}}')}:seen===version?{version,status:value.status}:{version,data:value},mode:'full',eventName:'tracking',eventDeltas:true,intervalMs:10,heartbeatMs:10000});const c=await connect();await privateFrame(c);const original=value;
 value={...value,status:{state:'delayed'}};await privateFrame(c);value=original;version='two';const restored=(await privateFrame(c)).frame;assert.deepEqual(restored.status||restored.data?.status,original.status);bad=true;await until(()=>hub.metrics().readErrors>0);
});

test('actual HTTP stream retains 600 large rows across one-second status/event changes and cleans up reader cancellation',{timeout:8000},async t=>{
 let data={...privateData(),events:privateData().events.map(row=>({...row,provenance:{proof:'c'.repeat(1400)}})),indexedEvents:privateData().indexedEvents.map(row=>({...row,providerExtra:{proof:'i'.repeat(1400)}}))},version='one';const {connect,hub}=await fixture(t,{readUpdate:({version:seen})=>seen===version?{version,status:data.status}:{version,data},mode:'full',eventName:'tracking',statusDeltas:true,eventDeltas:true,intervalMs:1000,heartbeatMs:15000,slowClientMs:5000});const c=await connect(),initial=await privateFrame(c);assert.ok(initial.wire.length>850000);const {applyTrackingFrame}=await import('../src/snapshot-stream.mjs');let state=applyTrackingFrame(null,0,initial.frame,2*1024*1024,{eventDeltas:true});
 data={...data,status:{state:'delayed',lagBlocks:7,indexer:{state:'observing',updatedAt:'one-second'}}};const status=await privateFrame(c);assert.equal(status.frame.type,'status');assert.ok(status.wire.length<512);state=applyTrackingFrame(state.data,state.revision,status.frame,2*1024*1024,{eventDeltas:true});assert.equal(state.data.events.length,300);assert.equal(state.data.indexedEvents.length,300);
 data={...data,events:[{id:'new-confirmed',confirmed:true,provenance:{proof:'new'}},...data.events.slice(0,299)]};version='two';const patch=await privateFrame(c);assert.equal(patch.frame.type,'delta');assert.ok(patch.wire.length<1000);state=applyTrackingFrame(state.data,state.revision,patch.frame,2*1024*1024,{eventDeltas:true});assert.deepEqual(state.data,JSON.parse(JSON.stringify(data)));c.controller.abort();await until(()=>hub.metrics().subscribers===0);assert.equal(hub.metrics().reading,false);
});
test('trusted reconstructed byte budget rejects small status frames which overflow retained history',async()=>{
 class Response extends EventEmitter{constructor(){super();this.frames=[];}writeHead(){}flushHeaders(){}write(w){this.frames.push(w);return true;}end(){this.emit('close');}}
 let update={version:'one',data:{wallets:[],events:[{id:'a',proof:'é'.repeat(160)}],indexedEvents:[],status:{state:'live'}}};const hub=createSnapshotStream({readUpdate:()=>update,mode:'full',eventName:'tracking',eventDeltas:true,intervalMs:5,heartbeatMs:10000,maxFrameBytes:650});try{const r=new Response();hub.attach(new EventEmitter(),r);await until(()=>hub.metrics().revision===1);update={version:'one',status:{state:'delayed',message:'é'.repeat(160)}};assert.ok(Buffer.byteLength(JSON.stringify(update))<650);await until(()=>hub.metrics().readErrors===1);assert.equal(hub.metrics().revision,1);assert.match(r.frames.at(-1),/unavailable/);}finally{hub.close();}
});
test('stalled opt-in private writer coalesces event/status updates with no unbounded frames and closes at deadline',async()=>{
 class Response extends EventEmitter{constructor(){super();this.frames=[];this.writableLength=0;}writeHead(){}flushHeaders(){}write(w){this.frames.push(w);return false;}destroy(){this.destroyed=true;this.emit('close');}end(){this.emit('close');}}
 let n=0;const hub=createSnapshotStream({readUpdate:({version})=>version===String(n)?{version,status:{state:'delayed',tick:Date.now()}}:{version:String(n),data:{wallets:[],events:[{id:'event'+n}],indexedEvents:[],status:{state:'live'}}},mode:'full',eventName:'tracking',eventDeltas:true,intervalMs:5,heartbeatMs:10,slowClientMs:40});const r=new Response();try{hub.attach(new EventEmitter(),r);await until(()=>hub.metrics().revision>0);n++;await until(()=>hub.metrics().revision>1);await until(()=>r.destroyed);assert.equal(r.frames.length,1);assert.equal(hub.metrics().subscribers,0);assert.equal(r.listenerCount('drain'),0);}finally{hub.close();}
});

test('oversized event patch falls back to a legal full reset at the same bounded frame limit',async t=>{
 const {createTrackingDelta}=await import('../src/snapshot-stream.mjs');
 for(const trusted of [false,true])await t.test(trusted?'versioned producer':'legacy read producer',async t=>{
  const previous={wallets:[],events:[{id:'a'.repeat(256),value:'x'.repeat(100)}],indexedEvents:[],status:{state:'live'}},replacement={...previous,events:[{id:'b'.repeat(256),value:'x'.repeat(100)}]};let current=previous,version='one';
  const fullWire=`event: tracking\ndata: ${JSON.stringify({type:'snapshot',revision:2,data:replacement})}\n\n`,patchWire=`event: tracking\ndata: ${JSON.stringify(createTrackingDelta(previous,replacement,2))}\n\n`;assert.equal(Buffer.byteLength(fullWire),511);assert.equal(Buffer.byteLength(patchWire),768);
  const options={mode:'full',eventName:'tracking',eventDeltas:true,maxFrameBytes:700,intervalMs:10,heartbeatMs:10000,...(trusted?{readUpdate:({version:seen})=>seen===version?{version,status:current.status}:{version,data:current}}:{read:()=>current})};const {connect,hub}=await fixture(t,options),client=await connect();assert.equal((await privateFrame(client)).frame.revision,1);current=replacement;version='two';
  const update=await privateFrame(client);assert.equal(update.frame.type,'snapshot','legal full must be sent instead of unavailable when only its patch overflows');assert.equal(update.frame.revision,2);assert.deepEqual(update.frame.data,replacement);assert.ok(Buffer.byteLength(update.wire)<=700);assert.equal(hub.metrics().readErrors,0);
  const fresh=await connect();const reset=await privateFrame(fresh);assert.equal(reset.frame.type,'snapshot');assert.equal(reset.frame.revision,2);assert.deepEqual(reset.frame.data,replacement);
 });
});
