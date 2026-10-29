import test from 'node:test';import assert from 'node:assert/strict';
import {createHttpServer} from '../src/server.mjs';import {createDemo} from '../src/demo.mjs';import {createTradeService} from '../src/trades.mjs';import {createRpcSettings} from '../src/rpc-settings.mjs';
test('RPC endpoints require CSRF, mask keys and preserve execution and automatic setup choices',async t=>{
 const deps=createDemo(),trades=createTradeService({...deps,demo:true});let invalidated=0;trades.invalidateQuotes=()=>invalidated++;
 const rpcSettings=createRpcSettings({resolveHost:async()=>[{address:'8.8.8.8',family:4}],probe:async()=>({chainId:56,blockNumber:42,latencyMs:3})});await rpcSettings.ready;
 const server=createHttpServer({...deps,trades,rpcSettings,demo:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;const session=await(await fetch(base+'/api/session')).json();
 const post=(path,body,csrf=session.csrf)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
 assert.equal((await fetch(base+'/api/settings/rpc')).status,200);
 const input={mode:'custom',httpUrl:'https://rpc.example.com/secret-test-key'};
 assert.equal((await post('/api/settings/rpc',input,'invalid')).status,403);
 const tested=await post('/api/settings/rpc/test',input);assert.equal(tested.status,200);assert.equal((await tested.json()).chainId,56);assert.equal(invalidated,0);
 const before=await trades.approvalSettings(),saved=await post('/api/settings/rpc',input);assert.equal(saved.status,200);assert.doesNotMatch(await saved.text(),/secret-test-key/);assert.equal(invalidated,1);
 assert.deepEqual(await trades.approvalSettings(),before);assert.equal(trades.isLiveExecution(),false);
 const reset=await post('/api/settings/rpc',{mode:'default'});assert.equal(reset.status,200);assert.equal((await reset.json()).mode,'default');
});
test('switching blocks new preparations until validated configuration has committed',async t=>{
 const deps=createDemo(),trades=createTradeService({...deps,demo:true});let release;const gate=new Promise(r=>release=r);
 const rpcSettings=createRpcSettings({resolveHost:async()=>[{address:'8.8.8.8',family:4}],probe:async()=>{await gate;return{chainId:56,blockNumber:42,latencyMs:3};}});await rpcSettings.ready;
 const server=createHttpServer({...deps,trades,rpcSettings,demo:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,s=await(await fetch(base+'/api/session')).json();const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify(body)});
 const save=post('/api/settings/rpc',{mode:'custom',httpUrl:'https://rpc.example.com/key'});for(let i=0;i<50&&!rpcSettings.isChanging();i++)await new Promise(r=>setTimeout(r,1));
 try{assert.equal(rpcSettings.isChanging(),true);const prepare=await post('/api/trade-prepare',{});assert.equal(prepare.status,409);}finally{release();}assert.equal((await save).status,200);
});
