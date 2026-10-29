// Indexer observations are ephemeral display data. The chain journal and cursor
// belong exclusively to wallet-tracking.mjs and are never changed here.
const ADDRESS=/^0x[0-9a-f]{40}$/i,HASH=/^0x[0-9a-f]{64}$/i;
const key=v=>String(v||'').toLowerCase();
const decimal=v=>typeof v==='string'&&/^\d{1,90}(?:\.\d{1,90})?$/.test(v)?v:null;
const identity=e=>[key(e.txHash),key(e.walletAddress),key(e.tokenAddress),e.side].join(':');
const sourceStates=new Set(['idle','starting','connecting','live','observing','reconnecting','unavailable','retrying','delayed','error','stopped','waiting']);
const sourceMessage=state=>['live','observing'].includes(state)?'币安索引数据已接收 · 待链上核验':['error','unavailable'].includes(state)?'币安实时流暂不可用 · 链上扫描继续':state==='stopped'?'币安实时流已停止':'币安实时流连接中 · 链上扫描继续';

export function createIndexedTracking({tracking,feed,snapshot=()=>({tokens:[]}),now=Date.now,maxAgeMs=600000}={}){
 if(typeof tracking?.snapshot!=='function')throw Error('Private tracking service required');
 let stopped=false;
 async function view(){
  let shared,current,state='idle';
  if(feed&&!stopped){
   try{[shared,current]=await Promise.all([feed.snapshot(),snapshot()]);state=sourceStates.has(shared?.status?.state)?shared.status.state:'error';}
   catch{state='error';}
  }else if(stopped)state='stopped';
  // Read private state after upstream IO: removing/switching a wallet must not
  // allow a late shared response to resurrect its notes or observations.
  const base=await tracking.snapshot();
  const status={...base.status,indexer:{state,message:sourceMessage(state),updatedAt:typeof shared?.status?.updatedAt==='string'?shared.status.updatedAt:null}};
  if(stopped||!shared||!Array.isArray(shared.events)||!Array.isArray(current?.tokens))return{...base,indexedEvents:[],status};
  const wallets=new Map(base.wallets.map(w=>[key(w.address),w]));
  const markets=current.tokens.filter(m=>m?.verified===true&&ADDRESS.test(m.address)&&['gang','flap','four'].includes(m.platformId));
  const confirmed=new Set(base.events.filter(e=>e.confirmed===true&&['buy','sell'].includes(e.side)).map(identity));
  const out=new Map();
  for(const raw of shared.events.slice(-2000)){
   if(!raw||raw.evidence!=='binance-indexed'||raw.confirmed!==false||raw.demo===true||!HASH.test(raw.txHash)||!ADDRESS.test(raw.walletAddress)||!wallets.has(key(raw.walletAddress))||!['buy','sell'].includes(raw.side))continue;
   const candidates=markets.filter(m=>m.platformId===raw.platformId&&key(m.address)===key(raw.tokenAddress));
   if(candidates.length!==1)continue;
   const market=candidates[0],timestamp=Date.parse(raw.timestamp);
   if(!Number.isFinite(timestamp)||timestamp>now()+60000||now()-timestamp>maxAgeMs)continue;
   const id=typeof raw.id==='string'&&raw.id.length<=256&&!/[\u0000-\u001f\u007f]/.test(raw.id)?raw.id:null;
   if(!id)continue;
   const event={id,evidence:'binance-indexed',confirmed:false,demo:false,walletAddress:wallets.get(key(raw.walletAddress)).address,tokenAddress:market.address,assetAddress:ADDRESS.test(raw.assetAddress||'')?raw.assetAddress:market.tokenAddress||market.address,platformId:market.platformId,phase:market.phase,side:raw.side,timestamp:new Date(timestamp).toISOString(),txHash:key(raw.txHash),blockNumber:null,logIndex:null,transactionIndex:null,tokenSymbol:market.symbol,tokenName:market.name,tokenAmount:null,quoteAmount:null,quoteSymbol:null,price:decimal(raw.price),priceUnit:raw.priceUnit==='USD'?'USD':null,valuation:null,source:'Binance Web3 索引推送 · 待链上核验',market:structuredClone(market)};
   if(!event.priceUnit)event.price=null;
   if(raw.indexerFields&&typeof raw.indexerFields==='object'){
    event.indexerFields={};
    for(const field of ['txUsdValue','tokenPrice','txNativeTokenQty','nativePrice']){const value=decimal(raw.indexerFields[field]);if(value!==null)event.indexerFields[field]=value;}
   }
   if(!confirmed.has(identity(event)))out.set(id,event);
  }
  return{...base,indexedEvents:[...out.values()].sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)).slice(0,300),status};
 }
 return{...tracking,snapshot:view,stop(){stopped=true;tracking.stop();}};
}
