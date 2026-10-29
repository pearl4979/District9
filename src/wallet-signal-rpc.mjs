import {performance} from 'node:perf_hooks';
import {FetchRequest,JsonRpcProvider} from 'ethers';

const DEFAULT_RPC='https://bsc-dataseed.bnbchain.org';
const METHODS=['getBlockNumber','getLogs','getTransactionReceipt','getBlock','call'];
const MAX_LOG_SPAN=128,MAX_LOGS=2000,MAX_REVERT_BYTES=2048;
const failure=(message,code)=>Object.assign(Error(message),{code});
function integer(value,name,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`${name} must be an integer from ${min} to ${max}`);return value;}
function setting(env,name,fallback,min,max){
 if(env[name]===undefined)return fallback;
 if(typeof env[name]!=='string'||!/^(?:0|[1-9]\d{0,8})$/.test(env[name]))throw Error(`${name} must be a bounded integer`);
 return integer(Number(env[name]),name,min,max);
}

/** Explicit signal-only endpoint; discovery, quote and execution providers are untouched. */
export function readWalletSignalRpcConfig(env=process.env){
 if(env.BSC_SIGNAL_RPC_URL===undefined){
  if(env.BSC_SIGNAL_LOG_BLOCK_RANGE!==undefined||env.BSC_SIGNAL_RPC_MIN_INTERVAL_MS!==undefined)throw Error('Signal RPC override requires BSC_SIGNAL_RPC_URL');
  return{enabled:false,rpcUrl:env.BSC_RPC_URL||DEFAULT_RPC,logBlockRange:null,minIntervalMs:null};
 }
 const rpcUrl=env.BSC_SIGNAL_RPC_URL;
 try{
  if(typeof rpcUrl!=='string'||rpcUrl.trim()!==rpcUrl||rpcUrl.length>4096||!rpcUrl)throw Error();
  const url=new URL(rpcUrl),local=url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!local||url.username||url.password||url.hash)throw Error();
 }catch{throw Error('BSC_SIGNAL_RPC_URL must be HTTPS (or local HTTP), without userinfo or fragment');}
 return{enabled:true,rpcUrl,logBlockRange:setting(env,'BSC_SIGNAL_LOG_BLOCK_RANGE',10,1,10),minIntervalMs:setting(env,'BSC_SIGNAL_RPC_MIN_INTERVAL_MS',600,1,60000)};
}

// Never copy the upstream message, URL, shortMessage, cause, request or body.
// Pool identity checks rely only on semantic codes and presence of revert data.
function sanitized(cause,method){
 const error=failure(`Signal RPC ${method} failed`,'SIGNAL_RPC_ERROR');
 if(typeof cause?.code==='string'&&/^[A-Z][A-Z0-9_]{0,31}$/.test(cause.code)||Number.isInteger(cause?.code)&&Math.abs(cause.code)<=2147483647)error.code=cause.code;
 const rpcCode=cause?.error?.code??cause?.info?.error?.code;
 if(Number.isInteger(rpcCode)&&Math.abs(rpcCode)<=2147483647)error.rpcCode=rpcCode;
 if(['BAD_DATA','CALL_EXCEPTION'].includes(error.code)&&typeof cause.data==='string'&&/^0x(?:[\da-f]{2})*$/i.test(cause.data)){
  error.data=cause.data.slice(0,2+MAX_REVERT_BYTES*2);
  if(cause.data.length>error.data.length)error.dataTruncated=true;
 }
 return error;
}

/** A serialized read-only facade over the original provider. maxQueue includes
 * the active call. close() rejects active/queued waits, cancels pacing timers,
 * and prevents late completions from starting another page; ownership/destroy
 * of the original provider stays with the caller. No retries are introduced.
 */
export function createWalletSignalRpc({provider,logBlockRange=10,minIntervalMs=600,maxQueue=64,now=()=>performance.now(),setTimeout:later=globalThis.setTimeout,clearTimeout:cancel=globalThis.clearTimeout}={}){
 integer(logBlockRange,'logBlockRange',1,10);integer(minIntervalMs,'minIntervalMs',1,60000);integer(maxQueue,'maxQueue',1,256);
 if(!METHODS.every(method=>typeof provider?.[method]==='function'))throw Error('Signal RPC provider must supply all five read methods');
 if(typeof now!=='function'||typeof later!=='function'||typeof cancel!=='function')throw Error('Signal RPC clock invalid');
 const queue=[];let active=null,timer=null,lastStart=null,closed=false;
 const closedError=()=>failure('Signal RPC closed','SIGNAL_RPC_CLOSED');
 async function run(){
  timer=null;if(closed||active||!queue.length)return;
  // Native timers may wake early after fractional-millisecond truncation.
  // Recheck monotonic time before consuming a queue slot or starting a read.
  const wait=lastStart===null?0:Math.max(0,minIntervalMs-(now()-lastStart));
  if(wait>0){timer=later(run,Math.ceil(wait));return;}
  const job=queue.shift();active=job;lastStart=now();
  try{const value=await provider[job.method](...job.args);if(!closed)job.resolve(value);}
  catch(cause){if(!closed)job.reject(sanitized(cause,job.method));}
  finally{active=null;pump();}
 }
 function pump(){
  if(closed||active||timer!==null||!queue.length)return;
  const wait=lastStart===null?0:Math.max(0,minIntervalMs-(now()-lastStart));
  if(wait>0)timer=later(run,Math.ceil(wait));else void run();
 }
 function request(method,args){
  if(closed)return Promise.reject(closedError());
  if(queue.length+(active?1:0)>=maxQueue)return Promise.reject(failure('Signal RPC queue full','SIGNAL_RPC_QUEUE_FULL'));
  return new Promise((resolve,reject)=>{queue.push({method,args,resolve,reject});pump();});
 }
 async function getLogs(filter){
  if(closed)throw closedError();
  if(!filter||typeof filter!=='object'||Array.isArray(filter)||Object.hasOwn(filter,'blockHash'))throw Error('Signal RPC requires a finite log filter');
  const {fromBlock,toBlock}=filter;
  if(!Number.isSafeInteger(fromBlock)||!Number.isSafeInteger(toBlock)||fromBlock<0||toBlock<fromBlock||toBlock-fromBlock>=MAX_LOG_SPAN)throw Error('Signal RPC requires a finite inclusive log range of at most128 blocks');
  const original=structuredClone(filter),logs=[];
  for(let start=fromBlock;;){
   const end=start+Math.min(logBlockRange-1,toBlock-start);
   const page=await request('getLogs',[{...original,fromBlock:start,toBlock:end}]);
   if(!Array.isArray(page))throw failure('Signal RPC logs invalid','SIGNAL_RPC_LOG_INVALID');
   if(logs.length+page.length>MAX_LOGS)throw failure('Signal RPC log output exceeds2000 entries','SIGNAL_RPC_LOG_LIMIT');
   logs.push(...page);if(end===toBlock)break;start=end+1;
  }
  return logs;
 }
 const api={};for(const method of METHODS)api[method]=method==='getLogs'?getLogs:(...args)=>request(method,args);
 api.close=()=>{if(closed)return;closed=true;cancel(timer);timer=null;active?.reject(closedError());for(const job of queue.splice(0))job.reject(closedError());};
 return api;
}

function defaultProvider(rpcUrl){
 const request=new FetchRequest(rpcUrl);request.timeout=8000;request.setThrottleParams({maxAttempts:1});
 return new JsonRpcProvider(request,56,{staticNetwork:true,batchMaxCount:1});
}
/** Shared local/hosted ownership boundary. Without an explicit dedicated URL,
 * return the original unwrapped provider, preserving the previous behavior.
 */
export function createWalletSignalProvider({env=process.env,createProvider=defaultProvider}={}){
 const config=readWalletSignalRpcConfig(env);let original;
 try{original=createProvider(config.rpcUrl);}catch(cause){throw config.enabled?sanitized(cause,'initialize'):cause;}
 let provider;
 try{provider=config.enabled?createWalletSignalRpc({provider:original,logBlockRange:config.logBlockRange,minIntervalMs:config.minIntervalMs}):original;}
 catch(cause){original.destroy?.();throw cause;}
 let closed=false;
 return{provider,close(){if(closed)return;closed=true;if(config.enabled)provider.close();original.destroy?.();}};
}
