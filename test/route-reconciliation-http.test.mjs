import test from'node:test';import assert from'node:assert/strict';import{createHttpServer}from'../src/server.mjs';import{createDemo}from'../src/demo.mjs';import{createTradeService}from'../src/trades.mjs';
test('route reconciliation is CSRF-protected and read-only with live execution off',async t=>{
 const deps=createDemo();let checked=0;const trades={...createTradeService({...deps,demo:true}),reconcileRoute:async input=>{checked++;return{readOnly:true,order:{id:input.orderId,status:'ROUTE_PAUSED'}};}};
 const server=createHttpServer({...deps,trades,demo:true,liveExecutionAllowed:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port,s=await(await fetch(base+'/api/session')).json();
 const post=csrf=>fetch(base+'/api/orders/reconcile-route',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({orderId:'existing-order'})});
 assert.equal((await post('wrong')).status,403);assert.equal(checked,0);const response=await post(s.csrf);assert.equal(response.status,200);assert.equal((await response.json()).readOnly,true);assert.equal(checked,1);assert.equal(trades.isLiveExecution(),false);
});
