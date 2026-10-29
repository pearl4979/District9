import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const module = await import('../src/rpc-settings.mjs').catch(e => { if(e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const address = 'https://rpc.example.com/v2/private-user-key';
const lookup = async () => [{address:'8.8.8.8',family:4}];
const probe = async () => ({chainId:56,blockNumber:123,latencyMs:4});
const create = options => { assert.equal(typeof module.createRpcSettings,'function'); return module.createRpcSettings({resolveHost:lookup,probe,...options}); };

test('default RPC does not resolve, probe or replace the existing connection',async()=>{
 let calls=0; const settings=create({resolveHost:()=>{calls++;},probe:()=>{calls++;}});await settings.ready;
 const connection={url:'https://platform.example'},provider={_getConnection:()=>connection};settings.attach(provider);
 assert.equal(provider._getConnection(),connection);assert.equal(calls,0);assert.equal(settings.snapshot().mode,'default');settings.close();
});
test('custom RPC is private, durable, isolated, and restored without touching wallet preferences',async()=>{
 const root=await mkdtemp(join(tmpdir(),'district9-rpc-'));const path=join(root,'owner-a','rpc.json');
 const a=create({storagePath:path}),b=create({storagePath:join(root,'owner-b','rpc.json')});await Promise.all([a.ready,b.ready]);
 try{
  await a.save({mode:'custom',httpUrl:address});assert.equal(a.snapshot().mode,'custom');assert.equal(b.snapshot().mode,'default');
  assert.doesNotMatch(JSON.stringify(a.snapshot()),/private-user-key/);assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal(JSON.parse(await readFile(path,'utf8')).httpUrl,address);
  const restored=create({storagePath:path});await restored.ready;assert.equal(restored.snapshot().mode,'custom');restored.close();
  await a.save({mode:'default'});assert.equal(a.snapshot().mode,'default');
 }finally{a.close();b.close();await rm(root,{recursive:true,force:true});}
});
test('failure cannot replace a working RPC, and API errors do not contain secret URLs',async()=>{
 let fail=false;const settings=create({probe:async()=>{if(fail)throw Error(address);return probe();}});await settings.ready;
 await settings.save({mode:'custom',httpUrl:address});fail=true;
 await assert.rejects(settings.save({mode:'custom',httpUrl:'https://other.example.com/new-secret'}),e=>!e.message.includes('private-user-key'));
 assert.equal(settings.snapshot().host,'rpc.example.com');assert.equal(settings.redact(JSON.stringify({error:address})),JSON.stringify({error:'[private RPC endpoint]'}));settings.close();
});
test('rejects unsafe destinations, unexpected fields, redirects and wrong chain IDs',async()=>{
 for(const httpUrl of ['http://rpc.example.com','https://localhost','https://127.0.0.1','https://2130706433','https://[::1]','https://169.254.169.254','https://user:pass@rpc.example.com','https://rpc.example.com:8443','https://rpc.example.com/#key']){
  const settings=create();await settings.ready;await assert.rejects(settings.test({mode:'custom',httpUrl}));settings.close();
 }
 const privateDns=create({resolveHost:async()=>[{address:'10.0.0.1',family:4}]});await privateDns.ready;await assert.rejects(privateDns.test({mode:'custom',httpUrl:address}));privateDns.close();
 const wrong=create({probe:async()=>({chainId:1,blockNumber:123})});await wrong.ready;await assert.rejects(wrong.save({mode:'custom',httpUrl:address}));assert.equal(wrong.snapshot().mode,'default');
 await assert.rejects(wrong.save({mode:'custom',httpUrl:address,account:'another-user'}));wrong.close();
});
test('cannot switch RPC while an order is active, including an order that starts during a connection test',async()=>{
 let busy=true;const settings=create({isBusy:()=>busy});await settings.ready;
 await assert.rejects(settings.save({mode:'custom',httpUrl:address}),e=>e.code==='RPC_BUSY');busy=false;
 const next=create({isBusy:()=>busy,probe:async()=>{busy=true;return probe();}});await next.ready;
 await assert.rejects(next.save({mode:'custom',httpUrl:address}),e=>e.code==='RPC_BUSY');assert.equal(next.snapshot().mode,'default');settings.close();next.close();
});
test('saving changes only the private provider and reset restores the exact default transport',async()=>{
 const settings=create();await settings.ready;const baseline={url:'https://platform.example'},provider={_getConnection:()=>baseline};settings.attach(provider);
 await settings.save({mode:'custom',httpUrl:address});assert.equal(provider._getConnection().url,address);
 await settings.save({mode:'default'});assert.equal(provider._getConnection(),baseline);settings.close();
});
test('RPC switching and admitted slow-body operations use the same synchronous barrier',async()=>{
 const settings=create();await settings.ready;const release=settings.beginOperation();await assert.rejects(settings.save({mode:'default'}),e=>e.code==='RPC_BUSY');release();release();await settings.save({mode:'default'});
 let unblock;const gate=new Promise(r=>unblock=r),next=create({probe:async()=>{await gate;return probe();}});await next.ready;
 const saved=next.save({mode:'custom',httpUrl:address});for(let i=0;i<10&&!next.isChanging();i++)await new Promise(setImmediate);assert.throws(()=>next.beginOperation(),e=>e.code==='RPC_BUSY');unblock();await saved;next.close();settings.close();
});
