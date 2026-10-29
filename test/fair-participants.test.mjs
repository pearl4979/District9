import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,parseEther as E} from 'ethers';
const mod=await import('../src/fair-participants.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const a=n=>'0x'+n.toString(16).padStart(40,'0'),TOKEN=a(1),PAD=a(2),QUOTE=a(3),CREATOR=a(4),X=a(5),Y=a(6);
function fixture(){
 let time=1800000000000,tip=100,broken=false,phase='bonding',apiCalls=0;
 const balances=new Map([[X,3n],[Y,0n]]),index={items:[{holder:X,shares:100,out:true},{holder:Y,shares:100}],total:2,offset:0,limit:50,hasMore:false,nextOffset:null};
 const token={address:TOKEN,creator:CREATOR,platformId:'gang',pad:'merged',launchType:'fair',phase,verified:true,quoteAsset:QUOTE,quoteSymbol:'WBNB',quoteDecimals:18};
 const s={creator:CREATOR,quote:QUOTE,sold:3n,capShares:100n,sharePrice:E('.0005'),mintFeeBps:100n,exitFeeBps:100n,launched:false};
 const provider={getNetwork:async()=>({chainId:56n}),getBlockNumber:async()=>tip,getCode:async()=> '0x6000'};
 const read=async(address,abi,method,args,block)=>{if(broken)throw Error('RPC unavailable');assert.equal(block,100);if(method==='positions')return balances.get(args[1])??0n;return {kindOf:2n,sales:s,launchpad:PAD,locked:true,TOTAL_SHARES:10000n,TOKENS_PER_SHARE:E('50000'),exitFeeBpsOf:0n,symbol:'WBNB',decimals:18n}[method];};
 const getJson=async url=>{apiCalls++;const u=new URL(url);assert.equal(u.origin,'https://gang.fun');assert.equal(u.pathname,`/api/fair/sales/${TOKEN}/participants`);assert.equal(u.searchParams.get('limit'),'50');return structuredClone(index);};
 const make=()=>{assert.equal(typeof mod.createFairParticipants,'function');return mod.createFairParticipants({snapshot:()=>({tokens:[{...token,phase}]}),provider,read,getJson,config:{pad:PAD,codeHash:keccak256('0x6000')},now:()=>time});};
 return {make,index,balances,token,s,provider,advance:n=>time+=n,breakRpc:()=>broken=true,setPhase:v=>phase=v,get apiCalls(){return apiCalls;}};
}
test('participant amounts use current same-block positions and not indexed shares or dividend-out flags',async()=>{
 const f=fixture(),r=await f.make().get(TOKEN);assert.equal(r.items.length,1);assert.equal(r.items[0].address,X);assert.equal(r.items[0].shares,'3');assert.equal(r.items[0].tokenAmount,'150000');assert.equal(r.items[0].principal,'0.0015');assert.equal(r.block,100);assert.equal(r.inactiveOnPage,1);assert.equal(r.indexedTotal,2);assert.equal(r.complete,false);assert.equal(r.demo,false);
});
test('participant pages reject malformed or ignored cursors, repeated candidates and unsupported markets',async()=>{
 for(const bad of ['cursor','duplicate','foreign','unknown']){
  const f=fixture();if(bad==='cursor'){f.index.hasMore=true;f.index.nextOffset=0;}if(bad==='duplicate')f.index.items[1].holder=X;if(bad==='foreign')f.index.offset=50;if(bad==='unknown')f.setPhase('graduated');
  await assert.rejects(f.make().get(TOKEN),/分页|重复|打新|索引/);
 }
});
test('RPC failures are explicit and an expired pinned-page request cannot silently mix a new block',async()=>{
 const f=fixture(),s=f.make(),first=await s.get(TOKEN);f.advance(61000);await assert.rejects(s.get(TOKEN,{offset:50,block:first.block}),/过期/);
 const g=fixture();g.breakRpc();await assert.rejects(g.make().get(TOKEN),/RPC/);
});
test('identical public reads reuse a short cache but do not expose a mutable result',async()=>{
 const f=fixture(),s=f.make(),r=await s.get(TOKEN);r.items[0].shares='999';const again=await s.get(TOKEN);assert.equal(again.items[0].shares,'3');assert.equal(f.apiCalls,1);
});
