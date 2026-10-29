import test from'node:test';import assert from'node:assert/strict';import{createPoolInspector,V2_FACTORY}from'../src/pool-inspector.mjs';
const T='0x1111111111111111111111111111111111111111',Q='0x2222222222222222222222222222222222222222',P='0x3333333333333333333333333333333333333333';
test('a high USD number cannot verify a pool whose factory or pair registration is wrong',async()=>{
 let wrong=true;const service=createPoolInspector({getJson:async()=>[{chainId:'bsc',pairAddress:P,baseToken:{address:T},quoteToken:{address:Q,symbol:'Q'},liquidity:{usd:999999},dexId:'pancakeswap'}],getBlock:async()=>123,read:async(a,abi,m)=>m==='token0'?T:m==='token1'?Q:m==='factory'?(wrong?T:V2_FACTORY):m==='getPair'?P:[1n,2n,0n]});
 assert.equal((await service.inspect(T,P))[0].verified,false);wrong=false;const rows=await service.inspect(T,P,{refresh:true});assert.equal(rows[0].verified,true);assert.equal(rows[0].official,true);
});
test('different chain or unrelated token entries are rejected; an empty response never invents liquidity',async()=>{
 const s=createPoolInspector({getJson:async()=>[{chainId:'eth',pairAddress:P,baseToken:{address:T},quoteToken:{address:Q}}]});assert.deepEqual(await s.inspect(T),[]);
});
