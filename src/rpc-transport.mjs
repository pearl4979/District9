import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, request } from 'node:https';
import { FetchRequest } from 'ethers';
import { WebSocket } from 'ws';

export function publicRpcAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || a===100&&b>=64&&b<=127 ||
    a===169&&b===254 || a===172&&b>=16&&b<=31 ||
    a===192&&(b===168 || b===0 || b===88&&c===99) ||
    a===198&&(b===18 || b===19 || b===51&&c===100) || a===203&&b===0&&c===113);
}

export function rpcUrl(input, protocol='https:') {
  if (typeof input!=='string' || input.length>2048 || /[\s\\]/.test(input)) throw Error('RPC 地址格式无效');
  let url; try { url=new URL(input); } catch { throw Error('RPC 地址格式无效'); }
  if (url.protocol!==protocol || url.username || url.password || url.port || url.hash ||
      !url.hostname.includes('.') || url.hostname.endsWith('.') || isIP(url.hostname) && !publicRpcAddress(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) throw Error('只支持默认端口的公网 HTTPS / WSS RPC，不支持内网地址或账号密码');
  return url;
}

export async function resolvePublicRpcHost(hostname) {
  let answers;try{answers=await lookup(hostname,{all:true,family:4,verbatim:true});}catch{}
  if(answers?.length&&answers.every(a=>publicRpcAddress(a.address)))return answers;
  // Some local VPNs synthesize 198.18/15 DNS. Never connect to those
  // addresses: ask a fixed authenticated public resolver at its pinned IP.
  if(answers?.length&&answers.some(a=>!/^198\.(18|19)\./.test(a.address)))throw Error('RPC 必须解析为公网地址');
  const url=new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',hostname);url.searchParams.set('type','A');
  const data=await new Promise((resolve,reject)=>{
    const req=request(url,{method:'GET',agent:false,servername:'cloudflare-dns.com',headers:{accept:'application/dns-json'},lookup:(_host,options,callback)=>options?.all?callback(null,[{address:'1.1.1.1',family:4}]):callback(null,'1.1.1.1',4)},response=>{
      if(response.statusCode!==200){response.resume();reject(Error('公网 DNS 暂不可用'));return;}
      const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>16384){response.destroy();reject(Error('DNS 响应过大'));}else chunks.push(chunk);});
      response.on('error',()=>reject(Error('公网 DNS 暂不可用')));response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch{reject(Error('DNS 响应格式无效'));}});
    });req.setTimeout(5000,()=>req.destroy());req.on('error',()=>reject(Error('公网 DNS 查询失败')));req.end();
  });
  answers=data?.Answer?.filter(a=>a.type===1).map(a=>({address:a.data,family:4}));
  if(data?.Status!==0||!answers?.length||answers.some(a=>!publicRpcAddress(a.address)))throw Error('RPC 必须解析为公网地址');
  return answers;
}

export async function resolveRpcEndpoint(input, {resolveHost=resolvePublicRpcHost,protocol='https:'}={}) {
  const url=rpcUrl(input,protocol);
  const answers=await Promise.race([resolveHost(url.hostname,{all:true,family:4,verbatim:true}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('RPC DNS 查询超时')),5000);t.unref();})]);
  if (!Array.isArray(answers) || !answers.length || answers.some(a=>!publicRpcAddress(a.address))) throw Error('RPC 必须解析为公网地址');
  const agent=new Agent({keepAlive:true,maxSockets:6,timeout:12000,lookup:(host,options,callback)=>{
    if(host!==url.hostname)return callback(Error('RPC 主机不匹配'));
    const pinned={address:answers[0].address,family:4};
    return options?.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family);
  }});
  return {url,agent,active:0,close(){agent.destroy();}};
}

export function rpcConnection(endpoint) {
  const connection=new FetchRequest(endpoint.url.href);connection.timeout=12000;connection.setThrottleParams({maxAttempts:1});
  connection.getUrlFunc=async(req,signal)=>{
    if(req.url!==endpoint.url.href || req.method!=='POST')throw Error('RPC 重定向被拒绝');
    signal?.checkSignal();endpoint.active++;
    try{return await new Promise((resolve,reject)=>{
      const outgoing=request(req.url,{method:'POST',agent:endpoint.agent,headers:{...req.headers,'accept-encoding':'identity'}},response=>{
        if(response.statusCode!==200){response.resume();return reject(Error(response.statusCode===429?'个人 RPC 已限流，请稍后重试或切换节点':`RPC 返回 HTTP ${response.statusCode}`));}
        const chunks=[];let size=0;
        response.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){response.destroy();reject(Error('RPC 响应过大'));}else chunks.push(chunk);});
        response.on('error',()=>reject(Error('RPC 响应读取失败')));
        response.on('end',()=>resolve({statusCode:200,statusMessage:response.statusMessage||'OK',headers:Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):String(v??'')])),body:Buffer.concat(chunks)}));
      });
      outgoing.setTimeout(req.timeout,()=>outgoing.destroy(Error('RPC 请求超时')));
      outgoing.on('error',()=>reject(Error('个人 RPC 连接失败，请测试连接或恢复默认')));
      signal?.addListener(()=>outgoing.destroy(Error('RPC 请求已取消')));
      outgoing.end(req.body?Buffer.from(req.body):undefined);
    });}finally{endpoint.active--;}
  };
  return connection;
}

export async function probeRpc(endpoint,{connection=rpcConnection(endpoint)}={}) {
  const started=performance.now(), req=connection;
  req.setHeader('content-type','application/json');
  // Single read-only batch. No wallet credentials, approval or broadcast methods.
  req.body=JSON.stringify(['eth_chainId','eth_blockNumber','eth_getBalance','eth_call'].map((method,i)=>({jsonrpc:'2.0',id:i+1,method,params:i===2?['0x0000000000000000000000000000000000000000','latest']:i===3?[{to:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',data:'0x18160ddd'},'latest']:[]})));
  const response=await req.send();let rows;try{rows=JSON.parse(response.bodyText);}catch{throw Error('RPC 未返回有效 JSON');}
  if(!Array.isArray(rows)||rows.length!==4 || rows.some((r,i)=>!rows.some(v=>v.id===i+1)||r.error||!/^0x[0-9a-f]+$/i.test(r.result||'')))throw Error('RPC 不支持所需的链上读取方法');
  const result=id=>rows.find(r=>r.id===id).result;
  return {chainId:Number(BigInt(result(1))),blockNumber:Number(BigInt(result(2))),latencyMs:Math.round(performance.now()-started)};
}

export function openRpcWebSocket(endpoint,{onBlock=()=>{},onState=()=>{}}={}) {
  let ws,closed=false,ready=false,lastBlock=0,healthTimer;
  const connected=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{reject(Error('WSS 连接超时'));ws?.terminate();},6000);timer.unref();
    const fail=()=>{clearTimeout(timer);if(!ready)reject(Error('WSS 必须连接 BSC 主网并支持新区块订阅'));onState('unavailable');};
    ws=new WebSocket(endpoint.url.href,{agent:endpoint.agent,followRedirects:false,handshakeTimeout:5000,maxPayload:128*1024});
    ws.on('open',()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})));
    ws.on('message',raw=>{try{
      const row=JSON.parse(raw.toString());
      if(row.id===1){if(row.error||BigInt(row.result)!==56n){fail();ws.terminate();return;}ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_subscribe',params:['newHeads']}));}
      else if(row.id===2){if(typeof row.result!=='string'||row.error){fail();ws.terminate();return;}ready=true;clearTimeout(timer);onState('connected');resolve();}
      else if(ready&&row.method==='eth_subscription'){const n=Number(BigInt(row.params?.result?.number||0));if(n>lastBlock){lastBlock=n;onBlock();}}
    }catch{fail();ws.terminate();}});
    ws.on('error',fail);ws.on('close',()=>{clearInterval(healthTimer);if(!closed)fail();});
    healthTimer=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.ping();},25000);healthTimer.unref();
  });
  return {connected,close(){closed=true;clearInterval(healthTimer);ws?.terminate();endpoint.close();}};
}
