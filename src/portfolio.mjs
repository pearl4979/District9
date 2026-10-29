import {formatUnits,parseUnits} from 'ethers';
const ADDRESS=/^0x[0-9a-f]{40}$/i,NATIVE='0x'+'e'.repeat(40),S=10n**36n;
const key=x=>String(x||'').toLowerCase();
const number=x=>{if(typeof x!=='string'||!/^\d{1,90}(?:\.\d{1,36})?$/.test(x))throw Error('数量格式无法核验');return parseUnits(x,36);};
const fmt=x=>{const s=formatUnits(x,36);return s.endsWith('.0')?s.slice(0,-2):s;};
const unknown=reason=>({costUsd:null,realizedUsd:null,unrealizedUsd:null,totalUsd:null,percent:null,status:'unknown',reason});
// Inputs are actual net cashflows, never order budgets/preview quotations.
export function calculatePnl({fills,balance,valueUsd,historyComplete}={}){
 if(historyComplete!==true)return unknown('缺少完整成交与初始成本记录');
 let quantity=0n,cost=0n,realized=0n;const seen=new Set();
 try{
  if(!Array.isArray(fills)||!fills.length||fills.length>2000)throw Error('成交记录不完整');
  for(const fill of fills){
   if(!fill||fill.confirmed!==true||typeof fill.id!=='string'||seen.has(fill.id))throw Error('成交状态或去重无法核验');seen.add(fill.id);
   const q=number(fill.quantity);if(q<=0n)throw Error('成交数量无效');
   if(fill.side==='buy'){cost+=number(fill.costUsd);quantity+=q;}
   else if(fill.side==='sell'){
    if(q>quantity)throw Error('卖出超过已知成本持仓');const disposed=q===quantity?cost:cost*q/quantity;
    realized+=number(fill.proceedsUsd)-disposed;cost-=disposed;quantity-=q;
   }else throw Error('转入或转出缺少可延续的成本基础');
  }
  if(quantity!==number(balance))throw Error('当前余额与已知成交不一致，可能存在转账或缺失历史');
  const value=valueUsd===null||valueUsd===undefined?null:number(valueUsd),unrealized=value===null?null:value-cost;
  return{status:unrealized===null?'partial':'known',reason:unrealized===null?'参考估值未知':null,costUsd:fmt(cost),realizedUsd:fmt(realized),unrealizedUsd:unrealized===null?null:fmt(unrealized),totalUsd:unrealized===null?null:fmt(realized+unrealized),percent:cost>0n&&unrealized!==null?fmt(unrealized*100n*S/cost):null};
 }catch(e){return unknown(e.message);}
}
export const emptyPortfolio=()=>({connected:false,address:null,holdings:[],summary:{nativeBalance:null,valueUsd:null,realizedUsd:null,unrealizedUsd:null,pnlUsd:null,knownPnlCount:0,unknownPnlCount:0},coverage:{complete:false,description:'连接钱包后读取BSC持仓；不签名、不交易'},updatedAt:null});
export function createPortfolioService({wallet,snapshot,protocol,orders=()=>[],ledger,now=Date.now,demo=false,timeoutMs=5500}={}){
 if(!Number.isFinite(timeoutMs)||timeoutMs<10||timeoutMs>5500)throw Error('Invalid portfolio read deadline');
 const bounded=(work,ms)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('持仓读取超时')),ms);Promise.resolve().then(work).then(resolve,reject).finally(()=>clearTimeout(timer));});
 let pending=null,cached=null,cacheKey=null,cacheTime=0;
 async function get(){
  const w=await wallet();if(w?.status!=='CONNECTED'||!ADDRESS.test(w.address||'')){cached=null;return emptyPortfolio();}
  const owner=key(w.address),fingerprint=JSON.stringify([owner,w.balance,w.raw?.balance,w.assets,orders().slice(0,200).map(o=>[o.id,o.status])]);
  if(cached&&cacheKey===fingerprint&&now()-cacheTime<15000)return structuredClone(cached);
  if(pending?.key===fingerprint)return structuredClone(await pending.promise);
  const request={key:fingerprint};pending=request;
  request.promise=(async()=>{
   const deadline=Date.now()+timeoutMs,current=await bounded(()=>snapshot(),timeoutMs),markets=new Map((current.tokens||[]).filter(t=>t.verified===true).map(t=>[key(t.address),t]));
   const raw=Array.isArray(w.assets)?w.assets:Array.isArray(w.raw?.balance)?w.raw.balance:[],holdings=[],seen=new Set();let invalid=0;
   let history=null;try{history=await bounded(()=>ledger?.(owner),Math.max(1,deadline-Date.now()));}catch{/* Missing basis stays unknown. */}
   if(history?.demo===true&&!demo||key(history?.address)!==owner)history=null;
   const bases=new Map((history?.assets||[]).slice(0,200).map(a=>[`${key(a.address)}:${a.positionKind||'token'}`,a]));
   for(const asset of raw.slice(0,200)){
    if(String(asset?.binanceChainId)!=='56'||!ADDRESS.test(asset?.address||'')||key(asset.address)===NATIVE)continue;
    const id=key(asset.address);if(seen.has(id)){invalid++;continue;}seen.add(id);
    try{
     const balance=number(asset.balance);if(balance<=0n)continue;
     let valueUsd=null;try{const price=number(asset.price);if(price>0n)valueUsd=fmt(balance*price/S);}catch{}
     const market=markets.get(id),positionKind='token',basis=bases.get(`${id}:${positionKind}`);
     holdings.push({address:id,symbol:String(market?.symbol||asset.symbol||'TOKEN').slice(0,32),name:String(market?.name||asset.symbol||'代币').slice(0,120),balance:asset.balance,positionKind,priceUsd:valueUsd===null?null:asset.price,valueUsd,platformId:market?.platformId||null,imageUrl:market?`/api/token-image/${id}`:null,canOpen:Boolean(market),balanceSource:demo?'DEMO 独立模拟余额':'Binance 钱包资产索引',pnl:calculatePnl({fills:basis?.fills,balance:asset.balance,valueUsd,historyComplete:history?.complete===true&&basis?.complete===true})});
    }catch{invalid++;}
   }
   // Shares are not deployed ERC20 balances. Only query identified private orders,
   // not every public market on every dashboard refresh.
   const shareIds=[...new Set(orders().filter(o=>o.positionKind==='shares'&&ADDRESS.test(o.token||'')).map(o=>key(o.token)))].slice(0,20);
   if(demo)for(const market of markets.values())if(market.positionKind==='shares'&&!shareIds.includes(key(market.address))&&shareIds.length<20)shareIds.push(key(market.address));
   for(let start=0;start<shareIds.length;start+=4){await Promise.all(shareIds.slice(start,start+4).map(async id=>{
    const m=markets.get(id);if(m?.positionKind!=='shares'||!protocol?.positions)return;
    try{
     if(Date.now()>=deadline)throw Error('持仓读取超时');
     const p=await bounded(()=>protocol.positions(id,w.address,{platformId:m.platformId}),Math.max(1,deadline-Date.now()));if(key(p.address)!==owner||key(p.token)!==id||p.positionKind!=='shares'||!Number.isInteger(p.decimals)||p.decimals<0||p.decimals>36)throw Error('份额归属未知');
     const balance=formatUnits(BigInt(p.balance),p.decimals);if(number(balance)<=0n)return;
     let priceUsd=null;if(demo)priceUsd=String(Number(m.price)*(m.quoteSymbol==='QQQB'?1.5:700));
     const valueUsd=priceUsd?fmt(number(balance)*number(priceUsd)/S):null,basis=bases.get(`${id}:shares`);
     holdings.push({address:id,symbol:m.symbol,name:m.name,balance,positionKind:'shares',priceUsd,valueUsd,platformId:m.platformId,imageUrl:`/api/token-image/${id}`,canOpen:true,balanceSource:demo?'DEMO 独立模拟份额':'平台份额账本',pnl:calculatePnl({fills:basis?.fills,balance,valueUsd,historyComplete:history?.complete===true&&basis?.complete===true})});
    }catch{invalid++;}
   }));}
   holdings.sort((a,b)=>{const av=a.valueUsd===null?-1n:number(a.valueUsd),bv=b.valueUsd===null?-1n:number(b.valueUsd);return av===bv?a.symbol.localeCompare(b.symbol):av>bv?-1:1;});
   const sum=field=>{const known=holdings.map(h=>field==='valueUsd'?h.valueUsd:h.pnl[field]).filter(x=>x!==null&&x!==undefined);return known.length?fmt(known.reduce((total,x)=>total+parseUnits(x,36),0n)):null;};
   const known=holdings.filter(h=>h.pnl.status==='known').length;
   const data={connected:true,address:w.address,demo,holdings,summary:{nativeBalance:w.balance??null,valueUsd:sum('valueUsd'),realizedUsd:sum('realizedUsd'),unrealizedUsd:sum('unrealizedUsd'),pnlUsd:sum('totalUsd'),knownPnlCount:known,unknownPnlCount:holdings.length-known,unpricedCount:holdings.filter(h=>h.valueUsd===null).length},coverage:{complete:false,assetLimit:200,invalidCount:invalid,description:demo?'DEMO：独立模拟持仓、价格和成本，不代表真实资产。':'持仓来自Binance BSC资产索引（CLI隐藏低于$0.01的资产）及本平台订单涉及的份额；不是全钱包全历史。市值为参考估值，不是预计卖出净到账。',pnlDescription:'PNL只合计成本和成交已知项目；缺少历史、转账成本或余额不一致时暂不可核算。'},updatedAt:new Date(now()).toISOString()};
   if(pending===request){cached=data;cacheKey=fingerprint;cacheTime=now();}return data;
  })().finally(()=>{if(pending===request)pending=null;});
  return structuredClone(await request.promise);
 }
 return{get};
}
