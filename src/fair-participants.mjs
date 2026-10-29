import {getAddress,keccak256,formatUnits,ZeroAddress} from 'ethers';
import {readContract,getJson as fetchJson,check,same,mapLimited} from './market-utils.mjs';
import {MERGED_GANG,MERGED_READ_ABI} from './gang-merged.mjs';
import {fairSaleSnapshot} from './gang-fair-sale.mjs';

const ABI=[...MERGED_READ_ABI,'function positions(address,address) view returns(uint16)'];
const ADDRESS=v=>typeof v==='string'&&/^0x[\da-f]{40}$/i.test(v)&&!same(v,ZeroAddress);
const copy=v=>JSON.parse(JSON.stringify(v));
export function readFairParticipantsQuery(url){
  for(const key of url.searchParams.keys())check(['token','offset','block'].includes(key)&&url.searchParams.getAll(key).length===1,'认购列表查询参数无效');
  const token=url.searchParams.get('token');check(ADDRESS(token),'认购代币地址无效');
  const number=(key,fallback)=>{const value=url.searchParams.get(key);if(value===null)return fallback;check(/^(0|[1-9]\d{0,9})$/.test(value),'认购分页参数无效');return Number(value);};
  const offset=number('offset',0),block=number('block',undefined);check(offset<=10000&&offset%50===0&&(block===undefined||block>0),'认购分页参数无效');
  return {token,options:{offset,block}};
}

// The index discovers addresses only. Amounts are always read from positions
// at the same verified block; a dividend `out` flag is not a share balance.
export function createFairParticipants({snapshot,provider,read=(a,b,m,args,block)=>readContract(provider,a,b,m,args,block),getJson=fetchJson,config=MERGED_GANG,now=Date.now}={}){
  const cache=new Map(),pending=new Map(),pins=new Map();let active=0;
  const trim=map=>{while(map.size>64)map.delete(map.keys().next().value);};
  const call=(address,method,args,block)=>read(address,ABI,method,args,block);
  const expired=()=>Object.assign(Error('认购列表快照已过期，请刷新后重新加载'),{code:'FAIR_SNAPSHOT_EXPIRED'});
  async function pin(t){
    check((await provider.getNetwork()).chainId===56n,'认购数量必须在BSC核验');
    const block=await provider.getBlockNumber();check(Number.isSafeInteger(block)&&block>0,'认购区块不可用');
    check(keccak256(await provider.getCode(config.pad,block))===config.codeHash,'认购合约实现已变化');
    const[kind,state,pad,locked,totalShares,tokensPerShare,exitFee,symbol,decimals]=await Promise.all([
      call(config.pad,'kindOf',[t.address],block),call(config.pad,'sales',[t.address],block),call(t.address,'launchpad',[],block),call(t.address,'locked',[],block),call(config.pad,'TOTAL_SHARES',[],block),call(config.pad,'TOKENS_PER_SHARE',[],block),call(config.pad,'exitFeeBpsOf',[t.address],block),call(t.quoteAsset,'symbol',[],block),call(t.quoteAsset,'decimals',[],block),
    ]);
    check(kind===2n&&same(pad,config.pad)&&locked===true&&state.launched===false&&same(state.quote,t.quoteAsset)&&same(state.creator,t.creator)&&String(symbol)===t.quoteSymbol&&decimals===18n,'打新阶段或代币归属已变化，请刷新');
    const sale=fairSaleSnapshot(state,{totalShares,tokensPerShare,effectiveExitFeeBps:exitFee,sourceBlock:block,updatedAt:new Date(now()).toISOString()});
    const value={block,sale,expiresAt:now()+60000};pins.set(`${t.address.toLowerCase()}:${block}`,value);trim(pins);return value;
  }
  async function get(address,{offset=0,block}={}){
    check(ADDRESS(address)&&Number.isSafeInteger(offset)&&offset>=0&&offset<=10000&&offset%50===0&&(block===undefined||Number.isSafeInteger(block)&&block>0),'认购分页参数无效');
    const id=address.toLowerCase(),data=await snapshot(),t=data.tokens?.find(t=>same(t.address,id));
    check(t?.verified===true&&t.platformId==='gang'&&t.pad==='merged'&&t.launchType==='fair'&&['bonding','launching'].includes(t.phase)&&!t.sourceUnavailable,'只能读取当前已核验的 Fair 打新认购列表');
    if(offset>0&&block===undefined)throw expired();
    let pinned=block===undefined?null:pins.get(`${id}:${block}`);if(block!==undefined&&(!pinned||pinned.expiresAt<=now()))throw expired();
    const key=`${id}:${offset}:${block??'latest'}`,stored=cache.get(key);if(stored&&stored.expires>now())return copy(stored.value);
    if(pending.has(key))return copy(await pending.get(key));
    check(active<2,'认购列表正在核对其他请求，请稍后重试');active++;
    const task=(async()=>{
      pinned??=await pin(t);
      const result=await getJson(`https://gang.fun/api/fair/sales/${id}/participants?limit=50&offset=${offset}`,{timeoutMs:6000,limit:256*1024});
      check(result&&Array.isArray(result.items)&&result.items.length<=50&&result.offset===offset&&result.limit===50&&Number.isSafeInteger(result.total)&&result.total>=0&&result.total<=1_000_000&&typeof result.hasMore==='boolean','认购地址索引分页无效');
      check(!result.hasMore||result.items.length===50&&result.nextOffset===offset+50,'认购地址索引分页未前进');
      const addresses=result.items.map(row=>{check(ADDRESS(row?.holder),'认购地址索引无效');return getAddress(row.holder);});
      check(new Set(addresses.map(a=>a.toLowerCase())).size===addresses.length,'认购地址索引存在重复项');
      const rows=await mapLimited(addresses,6,async wallet=>{try{
        const shares=await call(config.pad,'positions',[t.address,wallet],pinned.block);
        check(typeof shares==='bigint'&&shares>=0n&&shares<=BigInt(pinned.sale.walletCapShares)&&shares<=BigInt(pinned.sale.soldShares),'认购地址有效份数无效');
        return {address:wallet,shares:String(shares),tokenAmount:String(shares*50000n),principal:formatUnits(shares*BigInt(pinned.sale.sharePriceRaw),18)};
      }catch(error){return {error};}});
      const failed=rows.find(r=>r.error);if(failed)throw failed.error;
      check(rows.reduce((sum,r)=>sum+BigInt(r.shares),0n)<=BigInt(pinned.sale.soldShares),'认购份数与同块总量不一致');
      const items=rows.filter(r=>BigInt(r.shares)>0n).sort((a,b)=>Number(BigInt(b.shares)-BigInt(a.shares))||a.address.localeCompare(b.address));
      const truncated=result.hasMore&&offset+50>10000;
      const value={token:t.address,block:pinned.block,updatedAt:new Date(now()).toISOString(),demo:false,items,indexedTotal:result.total,checkedOnPage:rows.length,inactiveOnPage:rows.length-items.length,offset,hasMore:result.hasMore&&!truncated,nextOffset:result.hasMore&&!truncated?result.nextOffset:null,truncated,complete:false,quoteSymbol:t.quoteSymbol,symbol:t.symbol||'',source:'Gang官方地址索引 + BSC同块 positions',coverage:'地址索引可能延迟；只核对当前分页，已退出的零份额地址不列入当前认购。'};
      cache.set(key,{expires:now()+5000,value});trim(cache);return value;
    })().finally(()=>{active--;pending.delete(key);});pending.set(key,task);return copy(await task);
  }
  return {get};
}
