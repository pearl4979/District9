import {readFile,stat,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {getAddress,ZeroAddress} from 'ethers';
import {normalizeEventValuation} from './event-valuation.mjs';

const PLATFORMS=new Set(['gang','flap','four']), SIDES=new Set(['buy','sell','transfer-in','transfer-out']);
const address=value=>{try{const a=getAddress(value);if(a===ZeroAddress)throw Error();return a;}catch{throw Error('钱包地址无效');}};
const key=value=>String(value).toLowerCase();
const clone=value=>structuredClone(value);
const decimal=value=>typeof value==='string'&&/^\d{1,90}(?:\.\d{1,90})?$/.test(value)?value:null;
const idle=()=>({state:'idle',message:'添加钱包后开始追踪',updatedAt:null,coverage:'仅覆盖本机已发现并核验的三平台市场；不是全历史',lastBlock:null,coveredFromBlock:null,lagBlocks:null});

function profile(input,now){
 if(!input||Object.keys(input).some(k=>!['address','note','xUrl','avatar'].includes(k)))throw Error('钱包资料字段无效');
 const out={address:address(input.address),note:String(input.note??'').trim(),xUrl:null,avatar:null,createdAt:new Date(now()).toISOString()};
 if(out.note.length>48)throw Error('备注最多48个字符');
 if(input.xUrl){
  let u;try{u=new URL(input.xUrl);}catch{throw Error('X主页链接无效');}
  if(u.protocol!=='https:'||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname)||u.port||u.username||u.password||u.search||u.hash||!/^\/[A-Za-z0-9_]{1,15}\/?$/.test(u.pathname))throw Error('请填写完整的 X 用户主页链接');
  out.xUrl=`https://x.com/${u.pathname.split('/')[1]}`;
 }
 if(input.avatar){
  const m=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.avatar);
  if(!m||input.avatar.length>6500)throw Error('头像需为本地压缩图片，大小不超过约4KB');
  const b=Buffer.from(m[2],'base64');
  const valid=m[1]==='jpeg'?b[0]===255&&b[1]===216:m[1]==='png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';
  if(!valid)throw Error('头像图片格式无效');out.avatar=input.avatar;
 }
 return out;
}

export function createWalletTracking({snapshot=()=>({tokens:[]}),poll,storagePath,now=Date.now,pollMs=4000,demo=false,seedWallets=[]}={}){
 let data={version:1,wallets:[],events:[],markets:[],preferences:{showAvatars:true},cursor:null,replayNeeded:false,status:idle()};
 let revision=0,mutation=Promise.resolve(),pending=null,timer=null,running=false,stopped=false,storageError=null;
 const ready=(async()=>{
  if(!storagePath){data.wallets=seedWallets.map(w=>profile(w,now));return;}
  try{
   if((await stat(storagePath)).size>8*1024*1024)throw Error('文件过大');
   const raw=JSON.parse(await readFile(storagePath,'utf8'));
   if(raw.version!==1||!Array.isArray(raw.wallets)||!Array.isArray(raw.events)||!Array.isArray(raw.markets)||raw.wallets.length>100||raw.events.length>1000||raw.markets.length>2000)throw Error('格式无效');
   data={...data,...raw,wallets:raw.wallets.map(w=>({...profile({address:w.address,note:w.note,xUrl:w.xUrl,avatar:w.avatar},now),createdAt:w.createdAt})),replayNeeded:raw.replayNeeded===true,preferences:{showAvatars:raw.preferences?.showAvatars!==false},status:{...idle(),state:raw.wallets.length?'syncing':'idle',message:raw.wallets.length?'正在恢复追踪，等待新数据':'添加钱包后开始追踪'}};
   data.markets=data.markets.filter(m=>m.verified===true&&PLATFORMS.has(m.platformId));
   data.events=data.events.filter(e=>data.wallets.some(w=>key(w.address)===key(e.walletAddress))).map(e=>({...e,valuation:normalizeEventValuation(e.valuation,e)}));
  }catch(e){
   if(e.code==='ENOENT'){data.wallets=seedWallets.map(w=>profile(w,now));return;}
   storageError=`追踪存储无法读取，原文件已保留：${e.message}`;data.status={...idle(),state:'error',message:storageError};
  }
 })();
 async function persist(next){
  if(!storagePath)return;
  const text=JSON.stringify(next);if(Buffer.byteLength(text)>8*1024*1024)throw Error('追踪存储达到容量上限');
  await mkdir(dirname(storagePath),{recursive:true,mode:0o700});await writeFile(`${storagePath}.tmp`,text,{mode:0o600});await rename(`${storagePath}.tmp`,storagePath);
 }
 function mutate(fn){
  const work=mutation.catch(()=>{}).then(async()=>{await ready;if(storageError)throw Error(storageError);const next=clone(data);if(fn(next)===false)return view();await persist(next);data=next;revision++;return view();});
  mutation=work;return work;
 }
 function view(){
  let status={...data.status};
  if(data.wallets.length&&['live','demo'].includes(status.state)&&now()-Date.parse(status.updatedAt)>20000)status={...status,state:'delayed',message:'数据已超过20秒未更新，显示上次信号'};
  const markets=new Map(data.markets.map(m=>[key(m.address),m]));
  return clone({wallets:data.wallets,preferences:data.preferences,status,events:data.events.filter(e=>data.wallets.some(w=>key(w.address)===key(e.walletAddress))).slice(0,300).map(e=>({...e,market:markets.get(key(e.tokenAddress))||null}))});
 }
 function mergeMarkets(next,tokens){
  const all=new Map(next.markets.map(m=>[key(m.address),m]));let replay=false;
  for(const m of tokens||[]){
   if(m.verified!==true||!PLATFORMS.has(m.platformId))continue;
   try{address(m.address);}catch{continue;}
   const previous=all.get(key(m.address));
   if(!previous||(previous.phase!=='graduated'&&m.phase==='graduated')||key(previous.tokenAddress)!==key(m.tokenAddress))replay=true;
   const clean=JSON.parse(JSON.stringify(m, (k,v)=>k.startsWith('_')?undefined:typeof v==='bigint'?String(v):v));
   all.delete(key(m.address));all.set(key(m.address),clean);
  }
  next.markets=[...all.values()].slice(-2000);
  return replay;
 }
 function normalizeEvent(e,next){
  if(!e||e.confirmed!==true||!SIDES.has(e.side)||(!demo&&e.demo)||!PLATFORMS.has(e.platformId))return null;
  const market=next.markets.find(m=>key(m.address)===key(e.tokenAddress)&&m.platformId===e.platformId);
  const wallet=next.wallets.find(w=>key(w.address)===key(e.walletAddress));
  if(!market||!wallet||!Number.isSafeInteger(e.blockNumber)||e.blockNumber<0||!Number.isSafeInteger(e.logIndex)||e.logIndex<0)return null;
  if(!demo&&!/^0x[0-9a-f]{64}$/i.test(e.txHash||''))return null;
  const ts=Date.parse(e.timestamp);if(!Number.isFinite(ts)||ts>now()+60000)return null;
  const txHash=demo?null:e.txHash.toLowerCase();
  const id=demo?String(e.id).slice(0,160):`${txHash}:${e.logIndex}:${key(wallet.address)}`;
  const observed={id,walletAddress:wallet.address,tokenAddress:market.address,assetAddress:e.assetAddress||market.tokenAddress||market.address,platformId:market.platformId,phase:e.phase||market.phase,side:e.side,timestamp:new Date(ts).toISOString(),blockNumber:e.blockNumber,transactionIndex:Number.isSafeInteger(e.transactionIndex)?e.transactionIndex:0,logIndex:e.logIndex,txHash,blockHash:/^0x[0-9a-f]{64}$/i.test(e.blockHash||'')?e.blockHash:null,tokenSymbol:market.symbol,tokenName:market.name,tokenAmount:decimal(e.tokenAmount),quoteAmount:decimal(e.quoteAmount),quoteSymbol:typeof e.quoteSymbol==='string'?e.quoteSymbol.slice(0,32):null,price:decimal(e.price),priceUnit:typeof e.priceUnit==='string'?e.priceUnit.slice(0,32):null,source:String(e.source||'链上记录').slice(0,160),confirmed:true,demo};
  observed.valuation=normalizeEventValuation(e.valuation,observed);return observed;
 }
 async function tick(){
  await ready;if(stopped||storageError)return view();if(pending)return pending;
  if(!data.wallets.length){if(data.status.state!=='idle')await mutate(n=>{n.status=idle();});return view();}
  const generation=revision;
  pending=(async()=>{
   try{
    const current=await snapshot();if(generation!==revision||stopped)return view();
    const candidate=clone(data),discovered=mergeMarkets(candidate,current.tokens),cursor=data.cursor;
    if(!poll)throw Error('交易信号源未接入');
    // The forward scan always starts at the committed cursor. A separate 128-block
    // replay handles late discovery/migration without spending forward progress.
    const read=async from=>{
     const result=await poll({wallets:clone(candidate.wallets),cursor:from,markets:clone(candidate.markets)});
     if(!Number.isSafeInteger(result.cursor)||result.cursor<0||(Number.isSafeInteger(from)&&result.cursor<from))throw Error('信号扫描游标无效');
     if(['error','delayed'].includes(result.status?.state))throw Error(result.status?.message||'信号扫描未完成');
     if(result.replaceFromBlock!=null&&(!Number.isSafeInteger(result.replaceFromBlock)||result.replaceFromBlock<0||result.replaceFromBlock>result.cursor))throw Error('信号补扫范围无效');
     return result;
    };
    const result=await read(cursor),results=[result];
    if(generation!==revision||stopped)return view();
    if(Number.isSafeInteger(cursor)&&(discovered||candidate.replayNeeded)){
     // Source overlap is 12 blocks; rewinding 116 bounds this replay at 128.
     const replay=await read(Math.max(0,cursor-116));
     if(replay.cursor>result.cursor)throw Error('信号补扫超出已确认扫描范围');
     results.push(replay);
    }
    if(generation!==revision||stopped)return view();
    return await mutate(next=>{
     if(generation!==revision||stopped)return false;
     mergeMarkets(next,current.tokens);
     const events=new Map(next.events.map(e=>[e.id,e]));
     // Each complete range replaces its own earlier observations; the later
     // replay wins any overlap, including events removed by a recent reorg.
     for(const scanned of results){
      if(Number.isSafeInteger(scanned.replaceFromBlock))for(const [id,e]of events)if(e.blockNumber>=scanned.replaceFromBlock&&e.blockNumber<=scanned.cursor)events.delete(id);
      for(const raw of scanned.events||[]){const e=normalizeEvent(raw,next);if(e)events.set(e.id,e);}
     }
     next.events=[...events.values()].sort((a,b)=>b.blockNumber-a.blockNumber||b.transactionIndex-a.transactionIndex||b.logIndex-a.logIndex).slice(0,1000);
     const covered=[next.status.coveredFromBlock,...results.map(scanned=>scanned.status?.coveredFromBlock)].filter(Number.isSafeInteger);
     next.cursor=result.cursor;next.replayNeeded=false;next.status={...idle(),...result.status,...(covered.length?{coveredFromBlock:Math.min(...covered)}:{}),state:demo?'demo':result.status?.state||'live',updatedAt:new Date(now()).toISOString()};
    });
   }catch(e){
    if(generation!==revision||stopped)return view();
    try{return await mutate(next=>{if(generation!==revision||stopped)return false;next.status={...next.status,state:'delayed',message:`信号延迟：${e.shortMessage||e.message}`};});}
    catch(storage){data.status={...data.status,state:'error',message:`追踪存储写入失败：${storage.message}`};return view();}
   }finally{pending=null;}
  })();return pending;
 }
 async function saveWallet(input){
  const w=profile(input,now);
  const out=await mutate(next=>{const i=next.wallets.findIndex(p=>key(p.address)===key(w.address));if(i<0&&next.wallets.length>=100)throw Error('最多关注100个钱包');if(i<0){next.wallets.push(w);next.replayNeeded=Number.isSafeInteger(next.cursor);}else next.wallets[i]={...w,createdAt:next.wallets[i].createdAt};next.status={...next.status,state:'syncing',message:'正在更新关注钱包的信号'};});
  if(running)void tick();return out;
 }
 async function removeWallet({address:raw}={}){
  const a=address(raw);return mutate(next=>{next.wallets=next.wallets.filter(w=>key(w.address)!==key(a));next.events=next.events.filter(e=>key(e.walletAddress)!==key(a));if(!next.wallets.length){next.status=idle();next.cursor=null;next.replayNeeded=false;}});
 }
 async function setPreferences(input){if(!input||Object.keys(input).length!==1||typeof input.showAvatars!=='boolean')throw Error('头像开关参数无效');return mutate(next=>{next.preferences={showAvatars:input.showAvatars};});}
 function start(){if(running)return;stopped=false;running=true;const loop=async()=>{await tick();if(running){timer=setTimeout(loop,pollMs);timer.unref?.();}};void loop();}
 function stop(){running=false;stopped=true;revision++;clearTimeout(timer);}
 return {ready,snapshot:async()=>{await ready;return view();},saveWallet,removeWallet,setPreferences,tick,start,stop,getToken:a=>clone(data.markets.find(m=>key(m.address)===key(a))||null),knownMarkets:()=>clone(data.markets)};
}
