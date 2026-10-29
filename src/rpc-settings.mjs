import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRpcEndpoint, rpcConnection, probeRpc, openRpcWebSocket } from './rpc-transport.mjs';

const failBusy=()=>Object.assign(Error('订单或钱包读取正在进行，请完成后再切换 RPC'),{code:'RPC_BUSY',status:409});
export function createRpcSettings({storagePath,resolveHost,probe=probeRpc,isBusy=()=>false,connectWs=openRpcWebSocket}={}) {
  let active=null,changing=false,closed=false,operations=0,wsState='disabled',notice=null,validation=null;
  const attached=[],secrets=new Set(),listeners=new Set();
  const remember=input=>{for(const key of ['httpUrl','wsUrl'])if(typeof input?.[key]==='string'&&input[key])secrets.add(input[key]);};
  const redact=value=>{let text=String(value);for(const url of secrets)text=text.split(JSON.stringify(url).slice(1,-1)).join('[private RPC endpoint]').split(url).join('[private RPC endpoint]');return text;};
  const snapshot=()=>({mode:active?'custom':'default',host:active?.http.url.hostname??null,webSocket:wsState,...(validation||{}),message:notice,configured:Boolean(active)});
  function body(value) {
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['mode','httpUrl','wsUrl'].includes(k))||!['default','custom'].includes(value.mode))throw Error('RPC 设置字段无效');
    if(value.mode==='default'){if(value.httpUrl||value.wsUrl)throw Error('默认 RPC 不接受自定义地址');return {version:1,mode:'default'};}
    if(typeof value.httpUrl!=='string'||!value.httpUrl||value.wsUrl!==undefined&&typeof value.wsUrl!=='string')throw Error('请填写 HTTPS RPC 地址');
    return {version:1,mode:'custom',httpUrl:value.httpUrl,...(value.wsUrl?{wsUrl:value.wsUrl}:{})};
  }
  const dispose=value=>{value?.webSocket?.close();value?.http?.close();};
  async function candidate(input) {
    let http,wsEndpoint,webSocket;remember(input);
    try{
      http=await resolveRpcEndpoint(input.httpUrl,{resolveHost});secrets.add(http.url.href);
      const result=await probe(http);
      if(result.chainId!==56||!Number.isSafeInteger(result.blockNumber)||result.blockNumber<1)throw Error('RPC 必须连接 BNB Smart Chain 主网（56）');
      const value={http,connection:rpcConnection(http),result,webSocket:null};
      if(input.wsUrl){wsEndpoint=await resolveRpcEndpoint(input.wsUrl,{resolveHost,protocol:'wss:'});secrets.add(wsEndpoint.url.href);webSocket=connectWs(wsEndpoint,{onBlock:()=>{if(active===value)for(const fn of listeners)fn();},onState:state=>{if(active===value)wsState=state;}});await webSocket.connected;value.webSocket=webSocket;}
      return value;
    }catch(error){webSocket?.close();wsEndpoint?.close();http?.close();throw Error(redact(error.message||'个人 RPC 连接失败'));}
  }
  async function persist(input) {
    if(!storagePath)return;
    await mkdir(dirname(storagePath),{recursive:true,mode:0o700});
    const temp=`${storagePath}.${randomUUID()}.tmp`;
    try{await writeFile(temp,JSON.stringify(input),{mode:0o600,flag:'wx'});await rename(temp,storagePath);}finally{await rm(temp,{force:true});}
  }
  function install(next){const old=active;active=next;validation=next?{chainId:56,blockNumber:next.result.blockNumber,latencyMs:next.result.latencyMs,checkedAt:new Date().toISOString()}:null;wsState=next?.webSocket?'connected':'disabled';notice=null;dispose(old);}
  const ready=(async()=>{
    if(!storagePath)return;
    try{const stored=JSON.parse(await readFile(storagePath,'utf8'));const {version,...value}=stored;if(version!==1)throw Error('RPC 配置版本无效');const input=body(value);if(input.mode==='custom')install(await candidate(input));}
    catch(error){if(error.code!=='ENOENT')notice='保存的个人 RPC 暂不可用，当前使用平台默认；请重新测试并保存。';}
  })();
  return {
    ready,snapshot,redact,isChanging:()=>changing,
    beginOperation(){if(changing||closed)throw failBusy();operations++;let released=false;return()=>{if(!released){released=true;operations--;}};},
    attach(provider){if(typeof provider?._getConnection!=='function')return;const original=provider._getConnection.bind(provider);provider._getConnection=()=>active?active.connection.clone():original();attached.push(()=>{provider._getConnection=original;});},
    watchBlocks(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async test(value){await ready;const input=body(value);if(input.mode==='default')return {...snapshot(),tested:false,message:'默认 RPC 保持现有配置'};const next=await candidate(input);try{return {tested:true,chainId:56,blockNumber:next.result.blockNumber,latencyMs:next.result.latencyMs,webSocket:next.webSocket?'connected':'disabled'};}finally{dispose(next);}},
    async save(value){
      await ready;if(closed||changing||operations||isBusy()||active?.http.active)throw failBusy();
      const input=body(value);changing=true;let next;
      try{if(input.mode==='custom')next=await candidate(input);if(closed||operations||isBusy()||active?.http.active)throw failBusy();await persist(input);install(next||null);return snapshot();}
      catch(error){dispose(next);throw error;}finally{changing=false;}
    },
    close(){closed=true;for(const restore of attached)restore();dispose(active);active=null;listeners.clear();},
  };
}
