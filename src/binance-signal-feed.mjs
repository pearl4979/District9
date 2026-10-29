import {spawn as spawnProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

const CLI=fileURLToPath(new URL('../node_modules/@binance/agentic-wallet/dist/index.js',import.meta.url));
const STREAM='w3w@tracker@wallet@BSC';
const ADDRESS=/^0x[0-9a-f]{40}$/i, HASH=/^0x[0-9a-f]{64}$/i;
const PLATFORMS=new Set(['four','gang','flap']);
const SIDES=new Map([[11,'buy'],[19,'buy'],[21,'sell'],[29,'sell']]);
const DECIMAL=/^\d{1,90}(?:\.\d{1,90})?$/;
const COVERAGE='Public Binance BSC indexer observations for current verified local markets only; receipts and complete protocol coverage are not established.';
const clone=v=>structuredClone(v);
const address=v=>typeof v==='string'&&ADDRESS.test(v)&&!/^0x0{40}$/i.test(v)?v.toLowerCase():null;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const decimal=v=>typeof v==='string'&&v.length<=181&&DECIMAL.test(v)?v:null;
const count=n=>Math.min(Number.MAX_SAFE_INTEGER,n+1);

/**
 * One public, credential-free CLI collector. snapshot dependency may return
 * {tokens:[verified market rows]} synchronously or as a Promise. No BAW adapter
 * is created. start(), stop(), and snapshot() are async; subscribe(fn) receives a detached snapshot after revalidating markets, then receives bounded public changes.
 *
 * Event tokenAddress is the verified market address; assetAddress is the actual
 * upstream ca (important for Flap's virtual/deployed-token distinction). logId
 * remains indexerLogId; it is never interpreted as a chain logIndex. Historical
 * numeric strings retain upstream names under indexerFields. tokenPrice's unit
 * and txNativeTokenQty's meaning are deliberately not guessed. Current price,
 * market cap, labels, groups, tags and arbitrary fields are never forwarded.
 *
 * Limits are finite and validated. Only process exits trigger retries; CLI 1.11
 * owns its WebSocket PING/backoff/re-SUBSCRIBE lifecycle in --duration 0 mode.
 */
export function createBinanceSignalFeed({snapshot:readMarkets=()=>({tokens:[]}),spawn=spawnProcess,now=Date.now,env=process.env,
 setTimeout:schedule=globalThis.setTimeout,clearTimeout:cancel=globalThis.clearTimeout,
 maxEvents=500,retentionMs=3600000,maxLineBytes=65536,maxChunkBytes=1048576,maxPendingMessages=256,maxSubscribers=32,maxMarkets=10000,
 restartDelayMs=1000,maxRestartDelayMs=30000,maxRestarts=8,killGraceMs=1000}={}) {
 const limits={maxEvents:[maxEvents,10000],retentionMs:[retentionMs,86400000],maxLineBytes:[maxLineBytes,1048576],maxChunkBytes:[maxChunkBytes,4194304],maxPendingMessages:[maxPendingMessages,4096],maxSubscribers:[maxSubscribers,1024],maxMarkets:[maxMarkets,50000],restartDelayMs:[restartDelayMs,120000],maxRestartDelayMs:[maxRestartDelayMs,600000],maxRestarts:[maxRestarts,100],killGraceMs:[killGraceMs,10000]};
 for(const [key,[value,max]]of Object.entries(limits))if(!Number.isSafeInteger(value)||value<(key==='maxRestarts'?0:1)||value>max)throw new TypeError(`Invalid feed limit: ${key}`);
 if(maxRestartDelayMs<restartDelayMs)throw new TypeError('Invalid feed limit: maxRestartDelayMs');
 if([readMarkets,spawn,now,schedule,cancel].some(v=>typeof v!=='function'))throw new TypeError('Invalid public feed dependency');
 const listeners=new Set(),events=new Map();let running=false,generation=0,child=null,retry=null,root=null,stopPromise=null,queue=[],draining=null;
 let status={state:'idle',message:'Public indexer collector has not started',updatedAt:null,lastMessageAt:null,evidence:'binance-indexed',confirmed:false,coverage:COVERAGE,receivedMessages:0,rejectedMessages:0,droppedMessages:0,restarts:0};
 const iso=()=>new Date(now()).toISOString();
 function setStatus(patch){status={...status,...patch,updatedAt:iso()};}
 function prune(){for(const[id,e]of events)if(now()-e.receivedAt>retentionMs)events.delete(id);while(events.size>maxEvents)events.delete(events.keys().next().value);}
 function view(){prune();return clone({events:[...events.values()].reverse().map(e=>e.event),status});}
 function notify(){for(const fn of listeners){try{fn(view());}catch{/* A broken downstream listener cannot interrupt public collection. */}}}
 function marketMap(value){
  if(!object(value)||!Array.isArray(value.tokens)||value.tokens.length>maxMarkets)throw new Error('Market snapshot unavailable');
  const map=new Map();
  for(const row of value.tokens){
   if(!object(row)||row.verified!==true||!PLATFORMS.has(row.platformId)||(row.chainId!==undefined&&row.chainId!==56&&row.chainId!=='56'))continue;
   const market=address(row.address);if(!market)continue;
   for(const asset of new Set([market,address(row.tokenAddress)].filter(Boolean))){
    if(!map.has(asset))map.set(asset,new Map());
    map.get(asset).set(`${row.platformId}:${market}`,{address:market,platformId:row.platformId,...(typeof row.phase==='string'?{phase:row.phase.slice(0,32)}:{}),...(typeof row.symbol==='string'?{tokenSymbol:row.symbol.slice(0,32)}:{}),...(typeof row.name==='string'?{tokenName:row.name.slice(0,120)}:{})});
   }
  }
  return map;
 }
 function match(map,asset){const rows=map.get(asset);return rows?.size===1?rows.values().next().value:null;}
 function filterMarkets(map){for(const[id,e]of events){const row=match(map,e.event.assetAddress);if(!row||row.address!==e.event.tokenAddress||row.platformId!==e.event.platformId)events.delete(id);}}
 function normalize(frame,map){
  if(!object(frame)||frame.stream!==STREAM||!object(frame.data))return null;
  const d=frame.data;if(d.chainId!==56&&d.chainId!=='56')return null;
  const wallet=address(d.address),asset=address(d.ca),market=match(map,asset),side=SIDES.get(d.tradeSideCategory);
  if(!wallet||!asset||!market||!side||typeof d.txHash!=='string'||!HASH.test(d.txHash)||!Number.isSafeInteger(d.ts)||d.ts<0||d.ts*1000>now()+60000||d.ts*1000>8640000000000000)return null;
  let logId=null;
  if(d.logId!==undefined&&d.logId!==null){
   if(typeof d.logId==='string'&&/^\d{1,80}$/.test(d.logId))logId=d.logId;
   else if(Number.isSafeInteger(d.logId)&&d.logId>=0)logId=String(d.logId);
   else return null;
  }
  const txHash=d.txHash.toLowerCase(),id=`binance:56:${txHash}:${logId??'unknown'}:${wallet}:${asset}:${side}`;
  const indexerFields={ts:d.ts,tradeSideCategory:d.tradeSideCategory};
  for(const key of ['txUsdValue','tokenPrice','txNativeTokenQty','nativePrice']){const value=decimal(d[key]);if(value!==null)indexerFields[key]=value;}
  return {id,chainId:'56',walletAddress:wallet,tokenAddress:market.address,assetAddress:asset,txHash,indexerLogId:logId,side,timestamp:new Date(d.ts*1000).toISOString(),...market,tokenAddress:market.address,tokenAmount:null,quoteAmount:null,price:null,priceUnit:null,indexerFields,source:'Binance Web3 indexer',evidence:'binance-indexed',confirmed:false};
 }
 async function drain(epoch){
  if(draining===epoch)return;draining=epoch;
  try{while(running&&generation===epoch&&queue.length){
   // The queue remains bounded while a slow async market read is in flight.
   let map;try{map=marketMap(await readMarkets());}catch{if(running&&generation===epoch){events.clear();queue=[];setStatus({message:'Verified market snapshot unavailable; observations withheld'});notify();}break;}
   if(!running||generation!==epoch)break;
   filterMarkets(map);const pending=queue;queue=[];
   for(const frame of pending){const event=normalize(frame,map);if(!event){status.rejectedMessages=count(status.rejectedMessages);continue;}
    const previous=events.get(event.id);if(previous)event.indexerFields={...previous.event.indexerFields,...event.indexerFields};
    events.delete(event.id);events.set(event.id,{event,receivedAt:now()});prune();
   }
   notify();
  }}finally{if(draining===epoch)draining=null;if(running&&generation===epoch&&queue.length)void drain(epoch);}
 }
 function restart(epoch){
  if(!running||generation!==epoch||retry!==null)return;
  if(status.restarts>=maxRestarts){setStatus({state:'unavailable',message:'Public indexer process restart limit reached'});notify();return;}
  const delay=Math.min(maxRestartDelayMs,restartDelayMs*2**Math.min(status.restarts,20));
  setStatus({state:'reconnecting',message:'Public indexer process exited; waiting to restart'});notify();
  retry=schedule(()=>{retry=null;if(!running||generation!==epoch)return;status.restarts++;launch(epoch);},delay);retry?.unref?.();
 }
 function launch(epoch){
  if(!running||generation!==epoch)return;
  let transport;
  try{
   const childEnv={HOME:join(root,'home'),BINANCE_BAW_DIR:join(root,'state'),PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,LANG:'C.UTF-8'};
   // env is intentionally NOT copied. Neither secrets, endpoint overrides,
   // NODE_OPTIONS/preloads nor authentication state may enter this child.
   void env;
   transport=spawn(process.execPath,[CLI,'tracker','ws','--wallet','BSC','--duration','0','--json'],{cwd:childEnv.HOME,env:childEnv,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  }catch{restart(epoch);return;}
  child=transport;let ended=false,buffer='',bytes=0;const decoder=new StringDecoder('utf8');
  const finish=()=>{if(ended)return;ended=true;transport.stdout?.off('data',onData);transport.stderr?.off('data',onStderr);transport.off('error',onError);transport.off('close',finish);if(child===transport)child=null;if(running&&generation===epoch)restart(epoch);};
  const overflow=()=>{if(!running||generation!==epoch||ended)return;status.droppedMessages=count(status.droppedMessages);setStatus({message:'Oversized public indexer frame discarded'});transport.kill('SIGKILL');};
  const onError=()=>{transport.kill('SIGKILL');};
  const onStderr=()=>{/* Drain stderr; do not retain arbitrary upstream diagnostics. */};
  const onData=chunk=>{
   if(!running||generation!==epoch||ended)return;
   const input=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);if(input.length>maxChunkBytes){overflow();return;}
   buffer+=decoder.write(input);bytes=Buffer.byteLength(buffer);
   for(let nl;(nl=buffer.indexOf('\n'))!==-1;){
    const line=buffer.slice(0,nl).replace(/\r$/,'');buffer=buffer.slice(nl+1);
    if(Buffer.byteLength(line)>maxLineBytes){buffer='';overflow();return;}
    if(!line.trim())continue;
    let frame;try{frame=JSON.parse(line);}catch{status.rejectedMessages=count(status.rejectedMessages);continue;}
    if(object(frame)&&frame.stream===STREAM&&object(frame.data)&&(frame.data.chainId==='56'||frame.data.chainId===56)){
     setStatus({state:'observing',message:'Receiving unconfirmed public Binance indexer observations',lastMessageAt:iso(),receivedMessages:count(status.receivedMessages)});
    }
    if(queue.length>=maxPendingMessages){status.droppedMessages=count(status.droppedMessages);continue;}
    queue.push(frame);
   }
   bytes=Buffer.byteLength(buffer);if(bytes>maxLineBytes){buffer='';overflow();return;}
   if(queue.length)void drain(epoch);
  };
  transport.stdout.on('data',onData);transport.stderr.on('data',onStderr);transport.on('error',onError);transport.once('close',finish);
  setStatus({state:'starting',message:'Public indexer process started; waiting for a push (socket state is not exposed by CLI JSON)'});notify();
 }
 async function start(){
  if(stopPromise)await stopPromise;if(running)return view();
  root=mkdtempSync(join(tmpdir(),'district9-binance-public-'));mkdirSync(join(root,'home'),{mode:0o700});mkdirSync(join(root,'state'),{mode:0o700});
  running=true;generation++;status.restarts=0;launch(generation);return view();
 }
 async function snapshot(){
  if(running){const epoch=generation;try{const map=marketMap(await readMarkets());if(running&&generation===epoch)filterMarkets(map);}catch{if(running&&generation===epoch){events.clear();setStatus({message:'Verified market snapshot unavailable; observations withheld'});}}}
  return view();
 }
 function stop(){
  if(stopPromise)return stopPromise;
  running=false;generation++;if(retry!==null){cancel(retry);retry=null;}queue=[];events.clear();const active=child;child=null;const directory=root;root=null;
  stopPromise=(async()=>{
   if(active)await new Promise(resolve=>{let complete=false;const done=()=>{if(complete)return;complete=true;globalThis.clearTimeout(timer);active.off('close',done);resolve();};const timer=globalThis.setTimeout(()=>{active.kill('SIGKILL');done();},killGraceMs);active.once('close',done);active.kill('SIGTERM');});
   if(directory)rmSync(directory,{recursive:true,force:true});setStatus({state:'stopped',message:'Public indexer collector stopped'});notify();listeners.clear();
  })().finally(()=>{stopPromise=null;});return stopPromise;
 }
 function subscribe(fn){if(typeof fn!=='function')throw new TypeError('Invalid public feed subscriber');if(listeners.size>=maxSubscribers)throw new Error('Public feed subscriber limit reached');listeners.add(fn);const epoch=generation;void snapshot().then(value=>{if(listeners.has(fn)&&generation===epoch){try{fn(value);}catch{}}});return()=>listeners.delete(fn);}
 return {start,stop,snapshot,subscribe};
}
