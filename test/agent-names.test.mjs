import test from'node:test';import assert from'node:assert/strict';import{createAgentNameResolver}from'../src/agent-names.mjs';
const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222';
test('ai name needs handle, forward owner and positive balance at the same block; caches expire',async()=>{
 let clock=1000,calls=[];const r=createAgentNameResolver({now:()=>clock,getBlock:async()=>123,read:async(a,abi,m,args,block)=>{calls.push({m,block});return m==='handleOf'?'alice':m==='ownerOfHandle'?A:1n;}});
 const x=await r.resolve(A);assert.equal(x.name,'alice.ai');assert.equal(x.verified,true);assert.ok(calls.every(c=>c.block===123));await r.resolve(A);assert.equal(calls.length,3);clock+=300001;await r.resolve(A);assert.equal(calls.length,6);
});
test('mismatched owner, empty handle or unregistered address cannot borrow an indexed .ai name',async()=>{
 const r=createAgentNameResolver({getBlock:async()=>1,read:async(a,abi,m)=>m==='handleOf'?'alice':m==='ownerOfHandle'?B:1n});assert.equal((await r.resolve(A)).name,null);
 await assert.rejects(()=>r.resolve('bad'));
});
