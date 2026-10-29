import test from 'node:test';import assert from 'node:assert/strict';import {FetchRequest}from'ethers';
import{publicRpcAddress,rpcUrl,resolveRpcEndpoint,rpcConnection,probeRpc}from'../src/rpc-transport.mjs';
test('connection probe sends JSON read methods and accepts unordered batch replies',async()=>{
 const req=new FetchRequest('https://rpc.example.com/key');req.getUrlFunc=async request=>{
  assert.equal(request.getHeader('content-type'),'application/json');const rows=JSON.parse(Buffer.from(request.body).toString());assert.deepEqual(rows.map(r=>r.method),['eth_chainId','eth_blockNumber','eth_getBalance','eth_call']);assert.equal(request.method,'POST');
  return{statusCode:200,statusMessage:'OK',headers:{},body:Buffer.from(JSON.stringify([{id:3,result:'0x0'},{id:2,result:'0x100'},{id:4,result:'0x123'},{id:1,result:'0x38'}]))};
 };const result=await probeRpc(null,{connection:req});assert.equal(result.chainId,56);assert.equal(result.blockNumber,256);
});
test('custom transport pins DNS and cannot follow a redirect to a second host',async()=>{
 const endpoint=await resolveRpcEndpoint('https://rpc.example.com/key',{resolveHost:async()=>[{address:'8.8.8.8',family:4}]});
 try{const agent=endpoint.agent;await new Promise((resolve,reject)=>agent.options.lookup('rpc.example.com',{},(e,a,f)=>{if(e)return reject(e);assert.equal(a,'8.8.8.8');assert.equal(f,4);resolve();}));await assert.rejects(rpcConnection(endpoint).getUrlFunc({url:'https://127.0.0.1/',method:'POST'}),/重定向/);}finally{endpoint.close();}
});
test('RPC URLs reject credentials, internal and reserved addresses including integer IP encodings',()=>{
 for(const ip of ['0.0.0.0','10.1.1.1','100.64.0.1','127.0.0.1','169.254.169.254','172.31.0.1','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','::ffff:8.8.8.8'])assert.equal(publicRpcAddress(ip),false,ip);
 assert.equal(publicRpcAddress('8.8.8.8'),true);assert.throws(()=>rpcUrl('https://0x7f000001'));assert.throws(()=>rpcUrl('https://user:pass@rpc.example.com'));assert.throws(()=>rpcUrl('https://rpc.example.com:4430'));
});
