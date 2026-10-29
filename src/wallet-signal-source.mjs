import {readFileSync} from 'node:fs';
import {Interface,formatUnits,zeroPadValue,ZeroAddress} from 'ethers';
import {createNativeEventValuation} from './event-valuation.mjs';

const readJson=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const config=readJson('../config/platforms.json'),manifest=readJson('../config/manifest.json');
const CORE=new Interface(readJson('../abi/Core.json'));
// Official sources, checked 2026-10-27:
// https://github.com/gangfun/gang-launchpad/blob/main/src/launchpad-v2/LaunchpadV2.sol
// Legacy stocks/LaunchpadU.sol and LaunchpadS.sol use the same Buy/Sell layout.
const GANG=new Interface([
 'event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 taxDividend,uint256 taxPlatform,uint256 tokensOut,uint256 realQuote)',
 'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 taxDividend,uint256 taxPlatform,uint256 quoteOut,uint256 realQuote)'
]);
// ABI published by https://flap.sh/apps/agent-bonding-curve?lang=zh, artifact
// vaultui_agent-bonding-curve_01M5FK4RKTKXQ8GDT8ZMZMAYVD,
// v20261023134909522_agent-bonding-curve_8b26639fea52/component.mjs.
// Side 0=buy, 1=sell; corroborated against successful on-chain VirtualTrade
// receipts 0x3afe4e0f0bbaf832832b21d96ba6d325f4e81516983ab01b5ee2a43ca567d166
// and 0x6bfd85f42958c07c185376112c64cd1d748a0bc987b229e2d210553c3a4cf905.
const FLAP=new Interface(['event VirtualTrade(uint256 indexed id,address indexed wallet,uint8 side,uint256 shares,uint256 quoteSubmitted,uint256 quoteUser,uint256 agentFee,uint256 quotePool,uint256 quoteCurve,uint256 refund,uint256 launchReserveRefund,uint256 poolAfter,uint256 expectedFlapReserveAfter,uint256 outstandingSharesAfter,uint256 spotPriceBefore,uint256 spotPriceAfter)']);
const ERC=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const V2=new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
// Pancake V3's event includes protocol fees (unlike the Uniswap V3 layout):
// https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-core/contracts/interfaces/pool/IPancakeV3PoolEvents.sol
const V3=new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);
const POOL=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)','function getPair(address,address) view returns(address)','function getPool(address,address,uint24) view returns(address)']);
const V2_FACTORY='0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',V3_FACTORY='0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const PADS=Object.entries(config.gang.pads).filter(([id])=>id!=='soft').map(([,p])=>p.address);
const TRANSFER=ERC.getEvent('Transfer').topicHash,CORE_TRADE=CORE.getEvent('TradeExecuted').topicHash,FLAP_TRADE=FLAP.getEvent('VirtualTrade').topicHash;
const GANG_TOPICS=['Buy','Sell'].map(n=>GANG.getEvent(n).topicHash);
const SWAP_TOPICS=[V2.getEvent('Swap').topicHash,V3.getEvent('Swap').topicHash];
const CONFIRMATIONS=5,OVERLAP=12,MAX_BLOCKS=128,MAX_LOGS=2000,MAX_RECEIPTS=200,MAX_POOLS=32;
const key=a=>String(a).toLowerCase(),same=(a,b)=>typeof a==='string'&&typeof b==='string'&&key(a)===key(b);
const address=a=>typeof a==='string'&&/^0x[0-9a-f]{40}$/i.test(a)&&!same(a,ZeroAddress);
const hash=h=>typeof h==='string'&&/^0x[0-9a-f]{64}$/i.test(h);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const decimals=d=>Number.isInteger(d)&&d>=0&&d<=36?d:null;
const logIndex=l=>l.index??l.logIndex;
const unique=rows=>[...new Map(rows.map(l=>[`${key(l.transactionHash)}:${logIndex(l)}:${key(l.address)}`,l])).values()];
const parse=(iface,l)=>{try{return iface.parseLog(l);}catch{return null;}};
const check=(ok,message)=>{if(!ok)throw Error(message);};
async function limited(items,fn){let next=0;const results=new Array(items.length);await Promise.all(Array.from({length:Math.min(2,items.length)},async()=>{while(next<items.length){const i=next++;results[i]=await fn(items[i],i);}}));return results;}
function metadata(markets){
 return (Array.isArray(markets)?markets:[]).slice(0,2000).filter(m=>m?.verified===true&&['four','gang','flap'].includes(m.platformId)&&address(m.address)&&
  (m.platformId==='four'?(!m.manager||same(m.manager,manifest.core)):m.platformId==='gang'?PADS.some(p=>same(p,m.manager)):same(m.manager,config.flap.portal)));
}
// A verified deployed Flap token is usable even if the monitor's phase lags;
// predictedToken is deliberately never an asset identity.
function asset(m){return m.platformId==='flap'?(address(m.tokenAddress)?m.tokenAddress:null):m.address;}
function quoteInfo(quote,m){
 if(same(quote,m.quoteAsset)&&decimals(m.quoteDecimals)!==null&&typeof m.quoteSymbol==='string'&&m.quoteSymbol.length)return{decimals:m.quoteDecimals,symbol:m.quoteSymbol.slice(0,32)};
 if(same(quote,config.wrappedNative))return{decimals:18,symbol:'WBNB'};
 if(same(quote,ZeroAddress))return{decimals:18,symbol:'BNB'};
 const known=config.flap.quoteAssets.find(q=>same(q.address,quote));return known?{decimals:known.decimals,symbol:known.symbol}:null;
}
function amount(raw,d){return typeof raw==='bigint'&&raw>=0n&&d!==null?formatUnits(raw,d):null;}
function unitPrice(tokenRaw,quoteRaw,td,qd){
 if(tokenRaw<=0n||typeof quoteRaw!=='bigint'||quoteRaw<=0n||td===null||qd===null)return null;
 const precision=36,raw=quoteRaw*10n**BigInt(td+precision)/(tokenRaw*10n**BigInt(qd));
 return raw>0n?formatUnits(raw,precision):null;
}
const coverage='仅覆盖本机已发现并核验的 Gang V2/U/S、Flap ID Agent Curve、Four Agent 市场及其毕业代币；非全历史。原生事件按 trader/wallet 归属；DEX 仅支持 tx.from 为关注钱包且代币在钱包与核验池之间直接转账的交易；中间路由/托管/AA归属不保证。DEX代币量为直接到账腿，计价量为池成交腿，非含税用户总成本。';

/** Read-only, finite RPC scanner. Errors reject the entire poll, retaining caller's cursor. */
export function createWalletSignalSource({provider,now=Date.now}={}){
 let coveredFromBlock=null;
 async function poll({wallets=[],cursor=null,markets=[]}={}){
  const watched=[...new Set(wallets.slice(0,100).map(w=>typeof w==='string'?w:w?.address).filter(address).map(key))];
  if(!watched.length)return{events:[],cursor:integer(cursor)?cursor:0,status:{state:'idle',message:'添加钱包后开始追踪',lastBlock:integer(cursor)?cursor:null,coveredFromBlock:null,lagBlocks:null,coverage}};
  check(provider?.getLogs&&provider?.getBlockNumber&&provider?.getTransactionReceipt&&provider?.getBlock,'只读 RPC 不可用');
  const tip=await provider.getBlockNumber();check(integer(tip),'RPC block number invalid');
  const confirmed=Math.max(0,tip-CONFIRMATIONS);check(cursor===null||integer(cursor),'扫描游标无效');
  check(cursor===null||cursor<=confirmed,'RPC head is behind confirmed cursor; awaiting recovery');
  const fromBlock=cursor===null?Math.max(0,confirmed-MAX_BLOCKS+1):Math.max(0,cursor-OVERLAP+1);
  const toBlock=Math.min(confirmed,fromBlock+MAX_BLOCKS-1),known=metadata(markets),walletTopics=watched.map(w=>zeroPadValue(w,32));
  const filters=[
   {topics:[TRANSFER,walletTopics]},
   {topics:[TRANSFER,null,walletTopics]},
   {address:manifest.core,topics:[CORE_TRADE,null,walletTopics]},
   {address:PADS,topics:[GANG_TOPICS,null,walletTopics]},
   {topics:[FLAP_TRADE,null,walletTopics]}
  ].map(f=>({...f,fromBlock,toBlock}));
  let count=0;
  const groups=await limited(filters,async f=>{const logs=await provider.getLogs(f);check(Array.isArray(logs),'RPC logs invalid');count+=logs.length;check(count<=MAX_LOGS,'关注钱包日志过多，扫描暂停且游标保留');return logs;});
  const validLog=l=>l&&!l.removed&&integer(l.blockNumber)&&l.blockNumber>=fromBlock&&l.blockNumber<=toBlock&&integer(logIndex(l))&&hash(l.transactionHash)&&address(l.address);
  const nativeMarket=(l,e)=>known.find(m=>m.platformId==='four'?same(l.address,manifest.core)&&e?.name==='TradeExecuted'&&same(e.args.token,m.address):m.platformId==='gang'?same(l.address,m.manager)&&['Buy','Sell'].includes(e?.name)&&same(e.args.token,m.address):same(l.address,m.address)&&e?.name==='VirtualTrade');
  const native=l=>{
   const topic=l.topics?.[0];let e,actor;
   if(same(topic,CORE_TRADE)){e=parse(CORE,l);actor=e?.args.trader;}
   else if(GANG_TOPICS.some(t=>same(t,topic))){e=parse(GANG,l);actor=e?.name==='Buy'?e.args.buyer:e?.args.seller;}
   else if(same(topic,FLAP_TRADE)){e=parse(FLAP,l);actor=e?.args.wallet;}
   if(!e||!watched.includes(key(actor)))return null;
   const m=nativeMarket(l,e);return m?{m,e,wallet:actor}:null;
  };
  const transferMarket=l=>same(l.topics?.[0],TRANSFER)?known.find(m=>same(asset(m),l.address)):null;
  const candidates=unique(groups.flat().filter(validLog)).filter(l=>native(l)||transferMarket(l));
  const txs=[...new Set(candidates.map(l=>key(l.transactionHash)))];check(txs.length<=MAX_RECEIPTS,'关注钱包交易过多，扫描暂停且游标保留');
  const receipts=await limited(txs,async tx=>{
   const r=await provider.getTransactionReceipt(tx);check(r&&[0,1].includes(r.status),'Transaction receipt unavailable');
   check(integer(r.blockNumber)&&r.blockNumber>=fromBlock&&r.blockNumber<=toBlock,'Receipt moved during scan; retry');
   check(Array.isArray(r.logs)&&r.logs.length<=MAX_LOGS,'Receipt logs invalid or too large');
   const scanned=candidates.filter(l=>same(l.transactionHash,tx));
   check(scanned.every(l=>l.blockNumber===r.blockNumber&&(!hash(r.blockHash)||!hash(l.blockHash)||same(r.blockHash,l.blockHash))),'Receipt changed during scan; retry');
   return{...r,hash:tx,logs:unique(r.logs.filter(validLog).filter(l=>same(l.transactionHash,tx)))};
  });
  const blocks=new Map(),events=[];
  async function event(m,wallet,side,l,r,tokenRaw,quoteRaw=null,quote=null,sourceLabel,phase=m.phase,postPriceRaw=null){
   if(!blocks.has(l.blockNumber))blocks.set(l.blockNumber,Promise.resolve(provider.getBlock(l.blockNumber)).then(b=>{check(b&&integer(b.timestamp)&&Number.isFinite(new Date(b.timestamp*1000).getTime()),'Block timestamp unavailable');return b;}));
   const block=await blocks.get(l.blockNumber);check(!hash(block.hash)||!hash(l.blockHash)||same(block.hash,l.blockHash),'Block changed during scan; retry');
   const td=decimals(m.decimals),q=quote===null?null:quoteInfo(quote,m),qd=q?.decimals??null;
   const observed={id:`${key(l.transactionHash)}:${logIndex(l)}:${key(wallet)}`,walletAddress:wallet,tokenAddress:m.address,
    assetAddress:phase==='bonding'&&m.platformId==='flap'?m.address:asset(m)||m.address,platformId:m.platformId,phase,side,
    timestamp:new Date(block.timestamp*1000).toISOString(),blockNumber:l.blockNumber,blockHash:l.blockHash||block.hash||null,
    transactionIndex:integer(l.transactionIndex)?l.transactionIndex:integer(r.index)?r.index:0,logIndex:logIndex(l),txHash:key(l.transactionHash),
    tokenSymbol:typeof m.symbol==='string'?m.symbol:null,tokenName:typeof m.name==='string'?m.name:null,tokenAmount:amount(tokenRaw,td),quoteAmount:amount(quoteRaw,qd),quoteSymbol:q?.symbol??null,
    price:unitPrice(tokenRaw,quoteRaw,td,qd),priceUnit:q?`${q.symbol}${m.platformId==='flap'&&phase==='bonding'?'/份额':''}`:null,
    source:sourceLabel,confirmed:true,demo:false,market:m};
   observed.valuation=createNativeEventValuation({market:m,event:observed,postPriceRaw,tokenRaw,quoteRaw,tokenDecimals:td,quoteDecimals:qd});events.push(observed);
  }
  const poolCache=new Map();
  async function poolOf(l){
   const cacheKey=`${key(l.address)}:${l.blockNumber}`;if(poolCache.has(cacheKey))return poolCache.get(cacheKey);
   check(poolCache.size<MAX_POOLS,'单批候选池过多，扫描暂停且游标保留');
   const read=async(to,method,args=[])=>POOL.decodeFunctionResult(method,await provider.call({to,data:POOL.encodeFunctionData(method,args),blockTag:l.blockNumber}))[0];
   const work=(async()=>{
    // Sequential reads keep this dedicated RPC's concurrency at two or fewer.
    const token0=await read(l.address,'token0'),token1=await read(l.address,'token1'),factory=await read(l.address,'factory');
    if(!address(token0)||!address(token1)||same(token0,token1))return null;
    let version,registered;
    if(same(factory,V2_FACTORY)&&same(l.topics[0],SWAP_TOPICS[0])){version='V2';registered=await read(factory,'getPair',[token0,token1]);}
    else if(same(factory,V3_FACTORY)&&same(l.topics[0],SWAP_TOPICS[1])){version='V3';const fee=await read(l.address,'fee');if(fee<0n||fee>1000000n)return null;registered=await read(factory,'getPool',[token0,token1,fee]);}
    else return null;
    return same(registered,l.address)?{token0,token1,version}:null;
   })().catch(error=>{
    // A real revert or empty/malformed getter result is failed pool identity,
    // while transport/archive errors must stop the scan without cursor advance.
    if(error.code==='BAD_DATA'||(error.code==='CALL_EXCEPTION'&&typeof error.data==='string'))return null;
    throw error;
   });poolCache.set(cacheKey,work);return work;
  }
  for(const r of receipts){
   if(r.status!==1)continue;
   const consumed=new Set(),consumedTransfers=new Set(),transferRows=r.logs.flatMap(l=>{const m=transferMarket(l),e=m&&parse(ERC,l);return e&&e.args.value>0n?[{m,e,l}]:[];});
   for(const l of r.logs){
    const row=native(l);if(!row)continue;
    const {m,e,wallet}=row,a=e.args;let side,tokenRaw,quoteRaw,quote=m.quoteAsset,postPriceRaw=null;
    if(e.name==='TradeExecuted'){
     if(!same(a.quoteAsset,m.quoteAsset))continue;
     side=a.isBuy?'buy':'sell';tokenRaw=a.tokenAmount;quoteRaw=a.traderQuoteAmount;quote=a.quoteAsset;postPriceRaw=a.lastPrice;
    }else if(e.name==='Buy'){side='buy';tokenRaw=a.tokensOut;quoteRaw=a.quoteIn+a.taxDividend+a.taxPlatform;}
    else if(e.name==='Sell'){side='sell';tokenRaw=a.tokensIn;quoteRaw=a.quoteOut;}
    else{if(a.side!==0n&&a.side!==1n)continue;side=a.side===0n?'buy':'sell';tokenRaw=a.shares;quoteRaw=a.quoteUser;postPriceRaw=a.spotPriceAfter;}
    if(tokenRaw<=0n||quoteRaw<0n)continue;
    await event(m,wallet,side,l,r,tokenRaw,quoteRaw,quote,`BSC ${m.platformId} 原生${e.name}成功回执`,'bonding',postPriceRaw);
    consumed.add(`${key(m.address)}:${key(wallet)}`);
   }
   // A matching net balance alone is insufficient: a batched transaction may
   // contain a gift to the watched sender and a swap for somebody else.
   // Require the registered pool's target transfer to connect directly to the
   // watched sender; leave ambiguous intermediary paths as ordinary transfers.
   if(watched.includes(key(r.from))){
    const byAsset=new Map();
    for(const t of transferRows){if(consumed.has(`${key(t.m.address)}:${key(r.from)}`))continue;const k=key(t.l.address);if(!byAsset.has(k))byAsset.set(k,t.m);}
    for(const [target,m]of byAsset){
     const swaps=[];
     for(const l of r.logs){
      if(!SWAP_TOPICS.some(t=>same(t,l.topics?.[0])))continue;
      const p=await poolOf(l);if(!p||![key(p.token0),key(p.token1)].includes(target))continue;
      const e=parse(p.version==='V2'?V2:V3,l);if(!e)continue;
      const a=e.args,delta0=p.version==='V2'?a.amount0In-a.amount0Out:a.amount0,delta1=p.version==='V2'?a.amount1In-a.amount1Out:a.amount1;
      const delta=same(p.token0,target)?delta0:delta1,quoteDelta=same(p.token0,target)?delta1:delta0;
      if((delta<0n&&quoteDelta>0n)||(delta>0n&&quoteDelta<0n))swaps.push({l,p,delta,recipient:p.version==='V2'?a.to:a.recipient,quote:same(p.token0,target)?p.token1:p.token0,quoteRaw:quoteDelta<0n?-quoteDelta:quoteDelta});
     }
     // Multiple target pools in one tx can be arbitrage or routed legs; retain
     // transfers instead of claiming a unique user trade/quote allocation.
     if(swaps.length!==1)continue;
     const s=swaps[0],buy=s.delta<0n,poolAmount=buy?-s.delta:s.delta;
     if(buy&&!same(s.recipient,r.from))continue;
     const direct=transferRows.filter(t=>same(t.l.address,target)&&logIndex(t.l)<logIndex(s.l)&&
      (buy?same(t.e.args.from,s.l.address)&&same(t.e.args.to,r.from):same(t.e.args.from,r.from)&&same(t.e.args.to,s.l.address)));
     const directAmount=direct.reduce((sum,t)=>sum+t.e.args.value,0n);
     // Buy output may split a transfer tax before reaching the recipient. Sell
     // input must match the pool delta so another sender's input is not charged
     // to this wallet. Additional wallet tax/gift legs remain transfers.
     if(directAmount<=0n||(buy?directAmount>poolAmount:directAmount!==poolAmount))continue;
     await event(m,r.from,buy?'buy':'sell',s.l,r,directAmount,s.quoteRaw,s.quote,`BSC Pancake ${s.p.version} 已核验Swap；钱包与池直接代币量；池计价量`,'graduated');
     for(const t of direct)consumedTransfers.add(`${logIndex(t.l)}:${key(r.from)}`);
    }
   }
   for(const {m,e,l}of transferRows){
    if(same(e.args.from,e.args.to))continue;
    for(const [wallet,side]of [[e.args.from,'transfer-out'],[e.args.to,'transfer-in']])if(watched.includes(key(wallet))&&!consumed.has(`${key(m.address)}:${key(wallet)}`)&&!consumedTransfers.has(`${logIndex(l)}:${key(wallet)}`))await event(m,wallet,side,l,r,e.args.value,null,null,'BSC ERC20 Transfer成功回执；仅转账');
   }
  }
  const nextCovered=cursor===null?fromBlock:coveredFromBlock===null?fromBlock:Math.min(coveredFromBlock,fromBlock);coveredFromBlock=nextCovered;
  const lagBlocks=confirmed-toBlock;
  const sorted=[...new Map(events.map(e=>[e.id,e])).values()].sort((a,b)=>a.blockNumber-b.blockNumber||a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex);
  return{events:sorted,cursor:toBlock,replaceFromBlock:fromBlock,status:{state:lagBlocks>0?'syncing':'live',message:lagBlocks>0?`追踪积压 ${lagBlocks} 个确认区块；分批同步中`:`已扫描至 ${toBlock}；保留 ${CONFIRMATIONS} 个确认区块`,lastBlock:toBlock,coveredFromBlock,lagBlocks,coverage,updatedAt:new Date(now()).toISOString()}};
 }
 return{poll};
}
