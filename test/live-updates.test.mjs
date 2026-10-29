import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/live-updates.js',import.meta.url),'utf8').catch(()=>'');
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40);const token=(address=A)=>({address,verified:true,platformId:'four',price:'1',tradable:false});
const wait=()=>new Promise(r=>setTimeout(r,0));async function until(fn){for(let i=0;i<100;i++){if(fn())return;await wait();}assert.fail('timeout');}
const frame=(data,event='market')=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function setup(options={}){
 const doc=new EventTarget();doc.hidden=false;const nav={onLine:true};const win=new EventTarget();const requests=[],market=[],tracking=[],states=[],fallback=[];
 const fetch=async(url,init)=>{let controller;const stream=new ReadableStream({start(c){controller=c;}});requests.push({url,init,send:(value,event)=>controller.enqueue(new TextEncoder().encode(frame(value,event))),raw:text=>controller.enqueue(new TextEncoder().encode(text)),end:()=>controller.close()});return new Response(stream,{headers:{'content-type':'text/event-stream'}});};
 vm.runInNewContext(source,{window:win,document:doc,navigator:nav,fetch,TextDecoder,TextEncoder,AbortController,Headers,setTimeout,clearTimeout,structuredClone,console});
 assert.equal(typeof win.createLiveUpdates,'function','browser live update helper exists');
 const client=win.createLiveUpdates({document:doc,navigator:nav,fetch,onMarket:data=>market.push(data),onTracking:data=>tracking.push(data),onState:value=>states.push(value),onFallback:value=>fallback.push(value),retryMs:5,maxRetryMs:10,idleMs:1000,...options});
 return {client,requests,market,tracking,states,fallback,doc,nav,win};
}
test('browser applies ordered deltas atomically and reconnects from a full reset',async t=>{
 const x=setup();t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);x.requests[0].send({type:'snapshot',revision:4,data:{tokens:[token()],monitor:{status:'live'}}});await until(()=>x.market.length===1);
 x.requests[0].send({type:'delta',revision:5,upserts:[token(B)],removed:[A],monitor:{status:'degraded'}});await until(()=>x.market.length===2);assert.equal(x.market[1].tokens.length,1);assert.equal(x.market[1].tokens[0].address,B);
 x.requests[0].end();await until(()=>x.requests.length===2);x.requests[1].send({type:'snapshot',revision:1,data:{tokens:[token()],monitor:{status:'live'}}});await until(()=>x.market.length===3);assert.equal(x.market[2].tokens[0].address,A);assert.ok(x.states.some(s=>s.channel==='market'&&s.state==='live'));
});
test('private fetch snapshots owner context headers while public fetch has no private headers',async t=>{
 let owner='owner-A';const x=setup({tracking:true,getHeaders:()=>({'X-Account-Context':owner})});t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===2);
 const pub=x.requests.find(r=>r.url==='/api/market-stream'),priv=x.requests.find(r=>r.url==='/api/tracking-stream');assert.equal(new Headers(pub.init.headers).get('x-account-context'),null);assert.equal(new Headers(priv.init.headers).get('x-account-context'),'owner-A');assert.equal(pub.init.credentials,'omit');
 priv.send({type:'snapshot',revision:1,data:{wallets:[],events:[],indexedEvents:[{confirmed:false}],status:{state:'live'}}},'tracking');await until(()=>x.tracking.length===1);assert.equal(x.tracking[0].indexedEvents[0].confirmed,false);
 owner='owner-B';x.client.reset();await until(()=>x.requests.length===4);assert.equal(new Headers(x.requests[3].init.headers).get('x-account-context'),'owner-B');assert.equal(priv.init.signal.aborted,true);
});
test('hidden and offline pages pause streams and resume with a fresh snapshot',async t=>{
 const x=setup();t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);x.doc.hidden=true;x.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(x.requests[0].init.signal.aborted,true);assert.ok(x.states.some(s=>s.state==='paused'));await new Promise(r=>setTimeout(r,15));assert.equal(x.requests.length,1);
 x.doc.hidden=false;x.doc.dispatchEvent(new Event('visibilitychange'));await until(()=>x.requests.length===2);x.nav.onLine=false;x.win.dispatchEvent(new Event('offline'));assert.equal(x.requests[1].init.signal.aborted,true);x.nav.onLine=true;x.win.dispatchEvent(new Event('online'));await until(()=>x.requests.length===3);
});
test('invalid verification, revision gaps and oversized frames notify polling fallback without publishing patches',async t=>{
 const x=setup({maxFrameBytes:512});t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);x.requests[0].send({type:'snapshot',revision:1,data:{tokens:[token()],monitor:{status:'live'}}});await until(()=>x.market.length===1);
 x.requests[0].send({type:'delta',revision:3,upserts:[{...token(B),verified:false}],removed:[],monitor:{status:'live'}});await until(()=>x.fallback.length>0);assert.equal(x.market.length,1);assert.equal(x.fallback[0].channel,'market');await until(()=>x.requests.length===2);x.requests[1].raw('data: '+'x'.repeat(600));await until(()=>x.fallback.length===2);assert.ok(x.states.some(s=>s.state==='fallback'));
});
test('late fetch results after reset or stop cannot publish and tracking can be disabled',async()=>{
 const pending=[];const x=setup({fetch:(url,init)=>new Promise(resolve=>pending.push({url,init,resolve})),tracking:true});x.client.start();const old=pending.find(r=>r.url==='/api/tracking-stream');assert.ok(old);x.client.update({tracking:false});x.client.reset();old.resolve(new Response(frame({type:'snapshot',revision:1,data:{wallets:[{note:'OLD'}],events:[]}},'tracking'),{headers:{'content-type':'text/event-stream'}}));await wait();x.client.stop();pending.at(-1).resolve(new Response(frame({type:'snapshot',revision:1,data:{tokens:[token()],monitor:{status:'live'}}}),{headers:{'content-type':'text/event-stream'}}));await wait();assert.equal(old.init.signal.aborted,true);assert.equal(x.tracking.length,0);assert.equal(x.market.length,0);assert.ok(x.states.some(s=>s.state==='stopped'));
});
test('reset from a consumer callback cannot mark an obsolete connection live',async t=>{
 let x;x=setup({onMarket:()=>x.client.reset()});t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);x.requests[0].send({type:'snapshot',revision:1,data:{tokens:[token()],monitor:{status:'live'}}});await until(()=>x.requests.length===2);assert.notEqual(x.states.at(-1).state,'live');
});
test('stop from connection state notification prevents opening the cancelled request',async()=>{
 let client;const states=[];const x=setup({onState:value=>{states.push(value);if(value.state==='connecting')client.stop();}});client=x.client;client.start();await wait();assert.equal(x.requests.length,0);assert.equal(states.at(-1).state,'stopped');
});
test('revoked private stream notifies immediately and waits for reset before reconnecting',async t=>{
 for(const status of [401,409])await t.test(String(status),async t=>{
  const auth=[],calls=[];let denied=true;
  const fetch=async(url,init)=>{calls.push({url,init});if(url==='/api/tracking-stream'&&denied)return new Response('{}',{status,headers:{'content-type':'application/json'}});return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream'}});};
  const x=setup({tracking:true,fetch,onAuthError:value=>auth.push(value)});t.after(()=>x.client.stop());x.client.start();await until(()=>auth.length===1);
  assert.equal(auth[0].channel,'tracking');assert.equal(auth[0].status,status);assert.equal(x.fallback.some(value=>value.channel==='tracking'),false);
  await new Promise(r=>setTimeout(r,25));assert.equal(calls.filter(value=>value.url==='/api/tracking-stream').length,1);
  denied=false;x.client.reset();await until(()=>calls.filter(value=>value.url==='/api/tracking-stream').length===2);assert.equal(auth.length,1);
 });
});
test('public auth-shaped errors and late private denial after stop/reset cannot notify old owners',async t=>{
 const auth=[],pending=[];
 const fetch=(url,init)=>new Promise(resolve=>pending.push({url,init,resolve}));
 const x=setup({tracking:true,fetch,onAuthError:value=>auth.push(value)});t.after(()=>x.client.stop());x.client.start();
 pending.find(value=>value.url==='/api/market-stream').resolve(new Response('{}',{status:401}));await until(()=>x.fallback.length===1);assert.equal(auth.length,0);
 const oldPrivate=pending.find(value=>value.url==='/api/tracking-stream');x.client.reset();oldPrivate.resolve(new Response('{}',{status:409}));await wait();assert.equal(auth.length,0);
 const latestPrivate=pending.filter(value=>value.url==='/api/tracking-stream').at(-1);x.client.stop();latestPrivate.resolve(new Response('{}',{status:401}));await wait();assert.equal(auth.length,0);
});

const privateSnapshot=()=>({wallets:[{address:A,note:'owner'}],events:Array.from({length:300},(_,i)=>({id:'confirmed:'+i,confirmed:true})),indexedEvents:Array.from({length:300},(_,i)=>({id:'indexed:'+i,confirmed:false})),preferences:{showAvatars:false},status:{state:'live',lagBlocks:2,indexer:{state:'observing',updatedAt:'initial'}},extra:{preserved:true}});
test('tracking status frames reconstruct complete 600-event callbacks and preserve freshness and error state',async t=>{
 const x=setup({market:false,tracking:true});t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);
 const data=privateSnapshot();x.requests[0].send({type:'snapshot',revision:5,data},'tracking');await until(()=>x.tracking.length===1);x.tracking[0].events.pop();
 for(const [revision,status] of [[6,{state:'delayed',lagBlocks:99,indexer:{state:'observing',updatedAt:'next'}}],[7,{state:'error',message:'chain unavailable',updatedAt:'latest',lagBlocks:null}]]){
  x.requests[0].send({type:'status',revision,status},'tracking');await until(()=>x.tracking.length===revision-4);const last=x.tracking.at(-1);assert.equal(last.events.length,300);assert.equal(last.indexedEvents.length,300);assert.equal(last.wallets[0].note,'owner');assert.equal(last.preferences.showAvatars,false);assert.deepEqual(JSON.parse(JSON.stringify(last.extra)),data.extra);assert.deepEqual(JSON.parse(JSON.stringify(last.status)),status);
 }
});
for(const bad of ['before-full','gap','malformed-state','malformed-indexer-state','proto','oversize','reconstructed-oversize'])test(`invalid tracking status ${bad} falls back without publishing a private patch`,async t=>{
 const x=setup({market:false,tracking:true,maxFrameBytes:1024});t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);
 const data={wallets:[],events:[{id:'initial',note:'x'.repeat(300)}],status:{state:'live'}};
 if(bad!=='before-full'){x.requests[0].send({type:'snapshot',revision:1,data},'tracking');await until(()=>x.tracking.length===1);}
 const status={state:'delayed',message:bad==='oversize'?'x'.repeat(1100):bad==='reconstructed-oversize'?'x'.repeat(650):'next'};
 if(bad==='malformed-state')status.state=[];if(bad==='malformed-indexer-state')status.indexer={state:[]};if(bad==='proto')status.indexer=JSON.parse('{"__proto__":{"polluted":true}}');
 x.requests[0].send({type:'status',revision:bad==='gap'?3:2,status},'tracking');await until(()=>x.fallback.length===1);assert.equal(x.tracking.length,bad==='before-full'?0:1);assert.equal(x.requests[0].init.signal.aborted,true);
});
test('tracking reconnect and owner reset discard status reconstruction cache',async t=>{
 let owner='A';const x=setup({market:false,tracking:true,getHeaders:()=>({'X-Account-Context':owner})});t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);
 x.requests[0].send({type:'snapshot',revision:1,data:privateSnapshot()},'tracking');await until(()=>x.tracking.length===1);x.requests[0].end();await until(()=>x.requests.length===2);
 x.requests[1].send({type:'status',revision:2,status:{state:'live'}},'tracking');await until(()=>x.fallback.length===2);assert.equal(x.tracking.length,1);
 const before=x.requests.length;owner='B';x.client.reset();await until(()=>x.requests.length===before+1);const next=x.requests.at(-1);assert.equal(next.init.headers.get('X-Account-Context'),'B');
 next.send({type:'status',revision:3,status:{state:'live'}},'tracking');await until(()=>x.fallback.length===3);assert.equal(x.tracking.length,1);
});
test('tracking validation retains the full hub payload nesting allowance when adding its frame envelope',async t=>{
 const x=setup({market:false,tracking:true});t.after(()=>x.client.stop());let extra='bounded leaf';for(let i=0;i<11;i++)extra={nested:extra};const data={wallets:[],events:[],status:{state:'live'},extra};
 x.client.start();await until(()=>x.requests.length===1);x.requests[0].send({type:'snapshot',revision:1,data},'tracking');await until(()=>x.tracking.length===1);
 x.requests[0].send({type:'status',revision:2,status:{state:'delayed'}},'tracking');await until(()=>x.tracking.length===2);assert.equal(JSON.stringify(x.tracking[1].extra),JSON.stringify(extra));
});

test('opt-in private event deltas preserve complete UI callbacks and reset caches across owner changes',async t=>{
 const x=setup({market:false,tracking:true,trackingDeltas:true});t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);const data=privateSnapshot();x.requests[0].send({type:'snapshot',revision:1,data},'tracking');await until(()=>x.tracking.length===1);x.tracking[0].events=[];
 x.requests[0].send({type:'delta',revision:2,events:{removed:['confirmed:299'],upserts:[{index:0,row:{id:'new',confirmed:true}}]},status:{state:'delayed'}},'tracking');await until(()=>x.tracking.length===2);assert.equal(x.tracking[1].events.length,300);assert.equal(x.tracking[1].events[0].id,'new');assert.equal(x.tracking[1].indexedEvents.length,300);
 x.client.reset();await until(()=>x.requests.length===2);x.requests[1].send({type:'delta',revision:3,events:{removed:[],upserts:[]},status:{state:'live'}},'tracking');await until(()=>x.fallback.length===1);assert.equal(x.tracking.length,2);
});
for(const bad of ['disabled','gap','duplicate','bad-index','bad-order','missing-remove','proto','oversize','too-many'])test(`private event delta ${bad} is rejected atomically`,async t=>{
 const x=setup({market:false,tracking:true,trackingDeltas:bad!=='disabled',maxFrameBytes:2048});t.after(()=>x.client.stop());x.client.start();await until(()=>x.requests.length===1);const data={wallets:[],events:[{id:'a'},{id:'b'}],indexedEvents:[],status:{state:'live'}};x.requests[0].send({type:'snapshot',revision:1,data},'tracking');await until(()=>x.tracking.length===1);
 let patch={removed:[],upserts:[{index:0,row:{id:'new'}}]};if(bad==='duplicate')patch.upserts.push({index:1,row:{id:'new'}});if(bad==='bad-index')patch.upserts[0].index=3;if(bad==='bad-order')patch.upserts=[{index:1,row:{id:'x'}},{index:0,row:{id:'y'}}];if(bad==='missing-remove')patch.upserts[0].row.id='a';if(bad==='proto')patch.upserts[0].row=JSON.parse('{"id":"new","__proto__":{}}');if(bad==='oversize')patch.upserts[0].row.large='x'.repeat(2100);if(bad==='too-many')patch.upserts=Array.from({length:301},(_,i)=>({index:i,row:{id:String(i)}}));x.requests[0].send({type:'delta',revision:bad==='gap'?3:2,events:patch,status:{state:'live'}},'tracking');await until(()=>x.fallback.length===1);assert.equal(x.tracking.length,1);
});
