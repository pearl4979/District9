import test from 'node:test';import assert from 'node:assert/strict';
import{createDemo}from'../src/demo.mjs';import{createTradeService}from'../src/trades.mjs';import{createHttpServer}from'../src/server.mjs';
test('HTTP preparation is CSRF protected, read-only, and never shared with another private service',async t=>{
 async function setup(){const d=createDemo();let previews=0,sends=0;const original=d.baw.preview;d.baw.preview=async(...args)=>{previews++;return original(...args);};d.baw.execute=async()=>{sends++;throw Error('no execution permitted');};const trades=createTradeService({...d,demo:true});const s=createHttpServer({...d,trades,demo:true});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));const base=`http://127.0.0.1:${s.address().port}`,session=await(await fetch(base+'/api/session')).json();return{base,session,d,counts:()=>({previews,sends}),post:(path,body,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(body)})};}
 const a=await setup(),b=await setup();const input={token:a.d.monitor.snapshot().tokens[0].address,side:'buy',amount:'0.01',slippageBps:50};
 assert.equal(a.session.capabilities.tradePreparation,true);assert.equal((await a.post('/api/trade-prepare',input,'https://foreign.test')).status,403);
 const response=await a.post('/api/trade-prepare',input);assert.equal(response.status,200);const ready=await response.json();assert.equal(ready.readOnly,true);assert.equal(ready.id,undefined);assert.equal(ready.raw,undefined);assert.deepEqual(a.counts(),{previews:0,sends:0});
 const own=await(await a.post('/api/preview',input)).json(),other=await(await b.post('/api/preview',input)).json();assert.equal(own.preparation.reused,true);assert.equal(other.preparation.reused,false);assert.equal(a.counts().sends,0);assert.equal(b.counts().sends,0);
 for(const file of ['/order-observer.js','/trade-preparation.js'])assert.equal((await fetch(a.base+file)).status,200);
});
test('direct order HTTP is CSRF protected and a closed deployment cannot create a wallet request',async t=>{
 const d=createDemo();let previews=0,sends=0;d.baw.preview=async()=>{previews++;throw Error('must not preview');};d.baw.execute=async()=>{sends++;throw Error('must not send');};
 const trades=createTradeService({...d,liveExecution:true}),s=createHttpServer({...d,trades,liveExecutionAllowed:false});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));
 const base=`http://127.0.0.1:${s.address().port}`,session=await(await fetch(base+'/api/session')).json(),input={token:d.monitor.snapshot().tokens[0].address,side:'buy',amount:'0.01',slippageBps:50};
 const post=(path,body,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(body)});
 assert.equal(session.capabilities.directOrders,true);assert.equal(session.liveExecutionAllowed,false);assert.equal(session.liveExecution,false);
 assert.equal((await post('/api/order',{input,intentId:'http-intent-00001',expectedWallet:(await d.baw.wallet()).address},'https://foreign.test')).status,403);
 const r=await post('/api/order',{input,intentId:'http-intent-00001',expectedWallet:(await d.baw.wallet()).address});assert.equal(r.status,200);assert.equal((await r.json()).status,'PREVIEW_ONLY');assert.equal(previews,0);assert.equal(sends,0);
 assert.equal((await post('/api/settings/execution',{enabled:true})).status,403);
 assert.equal((await post('/api/order',{input,intentId:'http-intent-00002',expectedWallet:(await d.baw.wallet()).address,liveExecution:true})).status,400);
});
