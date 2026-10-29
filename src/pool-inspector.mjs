import{readContract,getJson as fetchJson,check,same,mapLimited}from'./market-utils.mjs';
export const V2_FACTORY='0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
export const V3_FACTORY='0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const ADDRESS=a=>/^0x[0-9a-f]{40}$/i.test(a||'')&&!/^0x0{40}$/i.test(a);
const PAIR=['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function fee() view returns(uint24)','function liquidity() view returns(uint128)'];
const FACTORY=['function getPair(address,address) view returns(address)','function getPool(address,address,uint24) view returns(address)'];
// Liquidity is an index estimate, never a binding trade route or guarantee of output.
export function createPoolInspector({provider,read=(a,b,m,args,block)=>readContract(provider,a,b,m,args,block),getBlock=()=>provider.getBlockNumber(),getJson=fetchJson,now=Date.now}={}){
 const cache=new Map();
 async function inspect(token,officialPair,{refresh=false}={}){
  check(ADDRESS(token),'池子目标代币无效');const key=`${token.toLowerCase()}:${officialPair||''}`,old=cache.get(key);if(!refresh&&old&&old.until>now())return old.rows;
  const raw=await getJson(`https://api.dexscreener.com/token-pairs/v1/bsc/${token}`,{limit:512*1024,timeoutMs:5000});check(Array.isArray(raw),'池子索引格式错误');
  const candidates=[...new Map(raw.slice(0,100).filter(p=>p.chainId==='bsc'&&ADDRESS(p.pairAddress)&&(same(p.baseToken?.address,token)||same(p.quoteToken?.address,token))).map(p=>[p.pairAddress.toLowerCase(),p])).values()].sort((a,b)=>Number(same(b.pairAddress,officialPair))-Number(same(a.pairAddress,officialPair))||(Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0)).slice(0,4);
  if(!candidates.length)return [];
  const block=await getBlock();
  const rows=await mapLimited(candidates,2,async p=>{
   const rawL=p.liquidity?.usd,liq=rawL!==null&&rawL!==undefined&&Number.isFinite(Number(rawL))&&Number(rawL)>=0?Number(rawL):null;
   const row={address:p.pairAddress,dex:String(p.dexId||'未知DEX').slice(0,60),quoteSymbol:String(p.quoteToken?.symbol||'未知').slice(0,32),liquidityUsd:liq,verified:false,official:same(p.pairAddress,officialPair),reason:'待核验',block};
   try{
    const[t0,t1,factory]=await Promise.all(['token0','token1','factory'].map(m=>read(p.pairAddress,PAIR,m,[],block)));
    check(ADDRESS(t0)&&ADDRESS(t1)&&!same(t0,t1)&&(same(t0,token)||same(t1,token)),'池内代币与目标不符');
    row.quoteAsset=same(t0,token)?t1:t0;
    if(!same(row.quoteAsset,p.quoteToken?.address))row.quoteSymbol=same(row.quoteAsset,p.baseToken?.address)?String(p.baseToken?.symbol||'未知').slice(0,32):'未知';
    if(same(factory,V2_FACTORY)){
     const[actual,reserves]=await Promise.all([read(factory,FACTORY,'getPair',[t0,t1],block),read(p.pairAddress,PAIR,'getReserves',[],block)]);
     check(same(actual,p.pairAddress)&&reserves[0]>0n&&reserves[1]>0n,'工厂登记不匹配或储备为零');
     row.version='V2';row.reserve0=String(reserves[0]);row.reserve1=String(reserves[1]);
    }else if(same(factory,V3_FACTORY)){
     const[fee,L]=await Promise.all([read(p.pairAddress,PAIR,'fee',[],block),read(p.pairAddress,PAIR,'liquidity',[],block)]);
     check(same(await read(factory,FACTORY,'getPool',[t0,t1,fee],block),p.pairAddress)&&L>0n,'V3登记不匹配或当前区间无流动性');row.version='V3';row.fee=Number(fee);
    }else throw Error('工厂不在已核验Pancake列表');
    row.verified=true;row.reason='同块核对工厂登记、池内代币及有效储备；USD流动性仍为索引参考';
   }catch{row.reason='未通过池归属/有效储备核验，不作为可执行路由';}
   return row;
  });
  rows.sort((a,b)=>Number(b.verified)-Number(a.verified)||(b.liquidityUsd??-1)-(a.liquidityUsd??-1));cache.set(key,{rows,until:now()+30000});while(cache.size>128)cache.delete(cache.keys().next().value);return rows;
 }
 return{inspect};
}
