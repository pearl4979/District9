import { readContract, check, same } from './market-utils.mjs';
export const AGENT_REGISTRY='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const ABI=['function handleOf(address) view returns(string)','function ownerOfHandle(string) view returns(address)','function balanceOf(address) view returns(uint256)'];
const valid=a=>/^0x[0-9a-f]{40}$/i.test(a||'')&&!/^0x0{40}$/i.test(a);
// TMTN names.js introduced this lookup; ownership checks, TTL and bounds are local.
// See THIRD_PARTY_NOTICES.md and licenses/TMTN-LICENSE.txt.
export function createAgentNameResolver({provider,read=(a,b,m,args,block)=>readContract(provider,a,b,m,args,block),getBlock=()=>provider.getBlockNumber(),now=Date.now}={}){
 const cache=new Map(),pending=new Map();
 async function resolve(address){
  check(valid(address),'身份地址无效');const key=address.toLowerCase(),old=cache.get(key);
  if(old&&old.until>now())return old.data;if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   const block=await getBlock();const h=await read(AGENT_REGISTRY,ABI,'handleOf',[address],block);
   let name=null,verified=false;
   if(typeof h==='string'&&/^[a-z0-9]{1,64}$/.test(h)){
    const[owner,balance]=await Promise.all([read(AGENT_REGISTRY,ABI,'ownerOfHandle',[h],block),read(AGENT_REGISTRY,ABI,'balanceOf',[address],block)]);
    if(same(owner,address)&&balance>0n){name=`${h}.ai`;verified=true;}
   }
   const data={address,name,verified,nameSource:name?'Agent ID 链上名称与持有者核验':'Agent ID 未取得匹配记录',block};
   cache.delete(key);cache.set(key,{data,until:now()+300000});while(cache.size>512)cache.delete(cache.keys().next().value);return data;
  })().finally(()=>pending.delete(key));pending.set(key,task);return task;
 }
 return{resolve};
}
