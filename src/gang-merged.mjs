import{readFileSync}from'node:fs';
import{formatUnits,keccak256,ZeroAddress}from'ethers';
import{readContract,getJson,check,same,mapLimited,messageOf}from'./market-utils.mjs';
import{gangMetrics}from'./market-metrics.mjs';
import{gangImageSources}from'./gang-images.mjs';
import{fairSaleSnapshot}from'./gang-fair-sale.mjs';
const platforms=JSON.parse(readFileSync(new URL('../config/platforms.json',import.meta.url)));
export const MERGED_GANG=platforms.gang.merged;
const ADDRESS=a=>typeof a==='string'&&/^0x[0-9a-f]{40}$/i.test(a)&&!same(a,ZeroAddress);
const VIRTUAL=1066666666666666666666666667n;
export const MERGED_READ_ABI=[
 'function kindOf(address) view returns(uint8)',
 'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,uint16 buyTaxBps,uint16 sellTaxBps,uint16 dividendBps,address pair,address refPair)',
 'function sales(address) view returns(address creator,uint64 progressAt,uint16 capShares,uint16 holdBps,address quote,uint16 sold,bool launched,uint16 mintFeeBps,uint16 exitFeeBps,address gate,uint128 sharePrice,address pair,address refPool,uint16 markSold)',
 'function status(address) view returns(uint8)','function pairFactory() view returns(address)',
 'function TOTAL_SHARES() view returns(uint256)','function TOKENS_PER_SHARE() view returns(uint256)',
 'function exitFeeBpsOf(address) view returns(uint256)',
 'function launchpad() view returns(address)','function locked() view returns(bool)','function pair() view returns(address)',
 'function name() view returns(string)','function symbol() view returns(string)','function decimals() view returns(uint8)','function totalSupply() view returns(uint256)',
 'function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)',
 'function getReserves() view returns(uint112,uint112,uint32)','function getPair(address,address) view returns(address)',
];
const ABI=MERGED_READ_ABI;
const routes=[
 {id:'v3',track:'v3',kind:1,label:'V3 曲线',path:'/v3/tokens?status=all',pages:3,limit:80},
 {id:'fair-minting',track:'fair',kind:2,label:'Fair 打新中',path:'/fair/sales?status=minting',pages:2,limit:56},
 {id:'fair-launched',track:'fair',kind:2,label:'Fair 已发射',path:'/fair/sales?status=launched',pages:2,limit:24},
];

// Independent reservations keep old finalized and high-progress markets even
// when the recent window is busy. API fields select candidates only.
export function selectMergedCandidates(rows,limit=80){
 limit=Math.max(1,Math.min(80,Math.floor(limit)));
 const valid=rows.filter(r=>r&&ADDRESS(r.address)&&Number(r.chainId)===56),selected=new Map();
 const add=(items,count)=>{let added=0;for(const r of items){if(selected.size>=limit||added>=count)break;const key=r.address.toLowerCase();if(!selected.has(key)){selected.set(key,r);added++;}}};
 const finalized=r=>r.graduated===true||r.status==='launched';
 add(valid.filter(finalized).sort((a,b)=>(b.graduatedAt||b.launchedAt||0)-(a.graduatedAt||a.launchedAt||0)),Math.max(1,Math.floor(limit*.3)));
 add(valid.filter(r=>!finalized(r)).sort((a,b)=>(Number(b.progressPct)||0)-(Number(a.progressPct)||0)),Math.max(1,Math.floor(limit*.2)));
 add([...valid].sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0)),limit);
 return [...selected.values()];
}

export function createGangMergedSource({provider,fetchJson=getJson,read=(a,b,m,args,block)=>readContract(provider,a,b,m,args,block),now=Date.now,config=MERGED_GANG,previewTrading=false}={}){
 const retained=new Map();let pending;
 const call=(address,method,args,block)=>read(address,ABI,method,args,block);
 async function candidates(route){
  const rows=[];let offset=0,more=false;
  for(let page=0;page<route.pages;page++){
   const body=await fetchJson(`https://gang.fun/api${route.path}&limit=100&offset=${offset}`,{timeoutMs:4000,limit:2*1024*1024});
   check(body&&Array.isArray(body.items)&&body.items.length<=100&&typeof body.hasMore==='boolean','Gang新轨索引格式无效');
   rows.push(...body.items);more=body.hasMore;if(!more)break;
   check(body.items.length>0&&Number.isSafeInteger(body.nextOffset)&&body.nextOffset>offset&&body.nextOffset<=offset+100,'Gang新轨分页无效');offset=body.nextOffset;
  }
  return{rows:selectMergedCandidates(rows,route.limit),truncated:more||new Set(rows.filter(r=>ADDRESS(r?.address)).map(r=>r.address.toLowerCase())).size>route.limit};
 }
 async function verifyToken(hint,route,block,updatedAt,quoteCache){
  const address=hint.address;
  const kind=Number(await call(config.pad,'kindOf',[address],block));check(kind===route.kind,'Gang新轨类型不匹配');
  check((await provider.getCode(address,block))!=='0x','Gang地址不是已部署ERC20');
  const[state,launchpad,locked,decimals,supply,name,symbol]=await Promise.all([
   call(config.pad,kind===1?'curves':'sales',[address],block),call(address,'launchpad',[],block),call(address,'locked',[],block),
   call(address,'decimals',[],block),call(address,'totalSupply',[],block),call(address,'name',[],block),call(address,'symbol',[],block),
  ]);
  check(same(launchpad,config.pad)&&Number(decimals)===18&&supply===1_000_000_000n*10n**18n,'Gang代币归属/精度/供应量不匹配');
  check(ADDRESS(state.creator)&&ADDRESS(state.quote),'Gang新轨状态未登记');
  const finalized=kind===1?state.graduated:state.launched;
  check(typeof finalized==='boolean'&&typeof locked==='boolean'&&locked===!finalized,'Gang新轨阶段与锁定不一致');
  if(kind===2)check(Number(await call(config.pad,'status',[address],block))===(finalized?2:1),'Gang打新状态不一致');
  const quoteKey=state.quote.toLowerCase();
  if(!quoteCache.has(quoteKey))quoteCache.set(quoteKey,Promise.all([call(state.quote,'symbol',[],block),call(state.quote,'decimals',[],block)]).then(([symbol,decimals])=>({symbol:String(symbol).slice(0,32),decimals:Number(decimals)})));
  const quote=await quoteCache.get(quoteKey);check(quote.decimals===18,'Gang新轨报价币精度未支持');
  let fairSale;
  if(kind===2){
   if(!quoteCache.has('fair-constants'))quoteCache.set('fair-constants',Promise.all([call(config.pad,'TOTAL_SHARES',[],block),call(config.pad,'TOKENS_PER_SHARE',[],block)]));
   const[[totalShares,tokensPerShare],effectiveExitFeeBps]=await Promise.all([quoteCache.get('fair-constants'),call(config.pad,'exitFeeBpsOf',[address],block)]);
   fairSale=fairSaleSnapshot(state,{totalShares,tokensPerShare,effectiveExitFeeBps,quoteDecimals:quote.decimals,sourceBlock:block,updatedAt});
  }
  let price=null,priceSource=null;
  const buyTax=kind===1?Number(state.buyTaxBps):100,sellTax=kind===1?Number(state.sellTaxBps):100;
  if(finalized){
   check(ADDRESS(state.pair),'Gang毕业池缺失');
   const[t0,t1,factory,reserves,actual]=await Promise.all([call(state.pair,'token0',[],block),call(state.pair,'token1',[],block),call(state.pair,'factory',[],block),call(state.pair,'getReserves',[],block),call(config.factory,'getPair',[address,state.quote],block)]);
   check(same(factory,config.factory)&&same(actual,state.pair)&&((same(t0,address)&&same(t1,state.quote))||(same(t1,address)&&same(t0,state.quote))),'Gang毕业池登记或币种不匹配');
   check(reserves[0]>0n&&reserves[1]>0n,'Gang毕业池储备为零');
   if(buyTax||sellTax)check(same(await call(address,'pair',[],block),state.pair),'Gang代币税池与发射池不一致');
   const tokenReserve=same(t0,address)?reserves[0]:reserves[1],quoteReserve=same(t0,address)?reserves[1]:reserves[0];
   const raw=quoteReserve*10n**18n/tokenReserve;if(raw>0n){price=formatUnits(raw,quote.decimals);priceSource='verified-pool';}
  }else if(kind===1){
   check(state.virtualQuote>0n&&state.gradAmt>0n&&state.sold>=0n&&state.sold<VIRTUAL&&state.realQuote>=0n&&state.realQuote<state.gradAmt,'Gang新曲线状态无效');
   const raw=(state.virtualQuote+state.realQuote)*10n**18n/(VIRTUAL-state.sold);if(raw>0n){price=formatUnits(raw,quote.decimals);priceSource='verified-curve';}
  }
  const launchType=kind===1?'curve-v3':'fair',phase=finalized?'graduated':'bonding';
  const created=Number(hint.createdAt),graduated=Number(hint.graduatedAt??hint.launchedAt),sameCreator=same(hint.creator,state.creator);
  const quoteFx=same(hint.quoteAddress,state.quote)?Number(hint.quoteUsd):NaN;
  return{address,platformId:'gang',pad:'merged',manager:config.pad,launchType,launchTypeLabel:kind===1?'V3 曲线':'Fair 打新',
   name:String(name).slice(0,200),symbol:String(symbol).slice(0,32),verified:true,tradable:previewTrading===true,
   reason:previewTrading===true?`${kind===2&&!finalized?'Fair 打新 / 整份退出':finalized?'Pancake V2 池子买卖':'V3 曲线买卖'}；下单时后台报价、模拟与风控。`:`${kind===2&&!finalized?'Fair 打新中，ERC20 锁定':finalized?'已毕业 / 已发射':'V3 曲线内盘'}；新合并版仅只读展示，尚未接入交易。`,phase,locked,positionKind:'token',decimals:18,
   creator:state.creator,creatorName:sameCreator&&typeof hint.creatorHandle==='string'?hint.creatorHandle.slice(0,64):null,creatorNameSource:'Gang官方索引名称，creator已链上核对',
   quoteAsset:state.quote,quoteSymbol:quote.symbol,quoteDecimals:quote.decimals,priceUnit:quote.symbol,price,priceSource,priceUpdatedAt:price?updatedAt:null,
   chartSupply:formatUnits(supply,18).replace(/\.0$/,''),...(kind===1?gangMetrics(state,quote.decimals):{graduationPrice:null,initialPrice:null}),
   nativeCandleUnitVerified:kind===1,indexedMarketCapUsd:null,valuationQuoteUsd:Number.isFinite(quoteFx)&&quoteFx>0?quoteFx:null,
   tokenTaxBuyBps:String(buyTax),tokenTaxSellBps:String(sellTax),tokenTaxScope:'毕业 / 发射后',
   progress:finalized?100:kind===1?Math.min(100,Number(state.realQuote*10000n/state.gradAmt)/100):fairSale.progress,...(fairSale?{fairSale}:{}),
   pair:finalized?state.pair:null,createdAt:Number.isFinite(created)&&created>0&&created*1000<=now()+1000?new Date(created*1000).toISOString():null,
   graduatedAt:finalized&&Number.isFinite(graduated)&&graduated>0&&graduated*1000<=now()+1000?new Date(graduated*1000).toISOString():null,
   creationTransaction:/^0x[0-9a-f]{64}$/i.test(hint.createdTx||'')?hint.createdTx:null,
   ...gangImageSources(hint,address),
   officialUrl:`https://gang.fun/token/${address}`,discoveryTrack:route.id,sourceUpdatedAt:updatedAt,sourceBlock:block,sourceUnavailable:false,
  };
 }
 const staleToken=t=>({...t,tradable:false,sourceUnavailable:true,reason:t.reason.includes('行情读取失败，保留上次核验数据。')?t.reason:`${t.reason} 行情读取失败，保留上次核验数据。`});
 function stale(route,error){
  const old=retained.get(route.id),message=String(messageOf(error)).slice(0,180);
  return{tokens:(old?.tokens||[]).map(staleToken),track:{id:route.id,label:route.label,status:'error',count:old?.tokens.length||0,updatedAt:old?.updatedAt??null,message,unavailable:old?.tokens.length||0,truncated:old?.truncated??false}};
 }
 async function load(){
  if(pending)return pending;
  pending=(async()=>{
   let block;
   try{
    const chain=typeof provider.send==='function'?BigInt(await provider.send('eth_chainId',[])):(await provider.getNetwork()).chainId;
    check(chain===56n,'Gang新轨必须为BSC主网');block=await provider.getBlockNumber();
    check(keccak256(await provider.getCode(config.pad,block))===config.codeHash,'Gang合并版代码已变化，需要重新核验');
    check(same(await call(config.pad,'pairFactory',[],block),config.factory),'Gang合并版工厂配置已变化');
   }catch(error){return output(routes.map(route=>stale(route,error)),block);}
   const quoteCache=new Map();
   const parts=await Promise.all(routes.map(async route=>{
    try{
     const{rows,truncated}=await candidates(route),updatedAt=new Date(now()).toISOString(),previous=new Map((retained.get(route.id)?.tokens||[]).map(t=>[t.address.toLowerCase(),t]));let unavailable=0;
     const tokens=(await mapLimited(rows,2,async hint=>{try{return await verifyToken(hint,route,block,updatedAt,quoteCache);}catch{unavailable++;const old=previous.get(hint.address.toLowerCase());return old?staleToken(old):null;}})).filter(Boolean);
     check(tokens.length||!rows.length,'Gang新轨候选全部未通过链上核验');retained.set(route.id,{tokens,updatedAt,truncated});
     return{tokens,track:{id:route.id,label:route.label,status:unavailable?'degraded':'live',count:tokens.length,updatedAt,unavailable,truncated,message:unavailable?`${unavailable}个未通过核验`:'同块归属及阶段已核验'}};
    }catch(error){return stale(route,error);}
   }));
   return output(parts,block);
  })().finally(()=>{pending=null;});return pending;
 }
 function output(parts,block){
  const map=new Map();for(const part of parts)for(const token of part.tokens){const key=token.address.toLowerCase(),old=map.get(key);if(!old||old.sourceUnavailable&&!token.sourceUnavailable)map.set(key,token);}
  const tracks=parts.map(p=>p.track),status=tracks.every(t=>t.status==='error')?'error':tracks.some(t=>t.status!=='live')?'degraded':'live';
  return{tokens:[...map.values()],tracks,status,lastBlock:block??null,unavailable:tracks.reduce((n,t)=>n+t.unavailable,0),truncated:tracks.some(t=>t.truncated),message:tracks.map(t=>`${t.label} ${t.count} · ${t.status==='error'?'异常':t.status==='degraded'?'部分未核验':'实时'}`).join(' / ')};
 }
 return{load};
}
