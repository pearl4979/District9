import { Buffer } from 'node:buffer';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE = /^(?:__proto__|prototype|constructor|wallets?|watchlist|credentials?|password|secrets?|session(?:Id)?|account(?:Id|Context)?|notes?|authorization|cookie|privateKey|mnemonic|indexedEvents)$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;

// Discovery is public; callers must supply public market records, never tenant state.
// Keep existing quote/module/metadata fields while removing private/implementation keys.
function publicValue(value, depth = 0, budget = {remaining:2*1024*1024}, stripPrivate = true) {
  if (depth > 12) throw new TypeError('Market nesting limit');
  const spend = count => {budget.remaining -= count;if(budget.remaining < 0)throw new TypeError('Snapshot size limit');};
  spend(2);
  if (typeof value === 'string') {spend(Buffer.byteLength(value));return value;}
  if (value === null || typeof value === 'boolean') {spend(5);return value;}
  if (typeof value === 'number' && Number.isFinite(value)) {spend(24);return value;}
  if (Array.isArray(value)) {
    if (value.length > 2000) throw new TypeError('Market array limit');
    return value.map(item => publicValue(item, depth + 1, budget, stripPrivate));
  }
  if (!object(value)) throw new TypeError('Invalid market field');
  const result = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (stripPrivate && (PRIVATE.test(key) || key.startsWith('_')) || child === undefined) continue;
    spend(Buffer.byteLength(key)+3);
    result[key] = publicValue(child, depth + 1, budget, stripPrivate);
  }
  return result;
}
export function sanitizeMarketSnapshot(value, maxTokens = 2000, maxBytes = 2*1024*1024) {
  if (!object(value) || !Array.isArray(value.tokens) || value.tokens.length > maxTokens || !object(value.monitor)) throw new TypeError('Invalid market snapshot');
  const seen = new Set(), budget = {remaining:maxBytes};
  const tokens = value.tokens.map(token => {
    if (!object(token) || !ADDRESS.test(token.address) || token.verified !== true || !['four','flap','gang'].includes(token.platformId) || (token.tradable !== undefined && typeof token.tradable !== 'boolean')) throw new TypeError('Invalid verified market');
    const key = token.address.toLowerCase();
    if (seen.has(key)) throw new TypeError('Duplicate market identity');
    seen.add(key);
    return publicValue(token, 0, budget);
  });
  return {tokens, monitor: publicValue(value.monitor, 0, budget)};
}

// A delta is atomic. Invalid identities, revisions, or missing full reset discard it.
export function applyMarketFrame(previous, revision, frame, maxTokens = 2000) {
  if (!object(frame) || !Number.isSafeInteger(frame.revision) || frame.revision < 1) throw new TypeError('Invalid revision');
  if (frame.type === 'snapshot') return {data: sanitizeMarketSnapshot(frame.data, maxTokens), revision: frame.revision};
  if (frame.type !== 'delta' || !previous || frame.revision !== revision + 1 || !Array.isArray(frame.upserts) || !Array.isArray(frame.removed) || frame.removed.length > maxTokens || frame.removed.some(key => typeof key !== 'string' || !ADDRESS.test(key))) throw new TypeError('Market reset required');
  const patch = sanitizeMarketSnapshot({tokens:frame.upserts, monitor:frame.monitor}, maxTokens);
  const rows = new Map(previous.tokens.map(token => [token.address.toLowerCase(), token]));
  for (const address of frame.removed) rows.delete(address.toLowerCase());
  for (const token of patch.tokens) rows.set(token.address.toLowerCase(), token);
  return {data:sanitizeMarketSnapshot({tokens:[...rows.values()],monitor:patch.monitor},maxTokens),revision:frame.revision};
}

const trackingId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
function trackingRows(rows){
 if(!Array.isArray(rows)||rows.length>300)throw new TypeError('Private event limit');
 const ids=new Set();for(const row of rows){if(!object(row)||!trackingId(row.id)||ids.has(row.id))throw new TypeError('Invalid private event identity');ids.add(row.id);}return rows;
}
function trackingPatch(previous,patch){
 trackingRows(previous);
 if(!object(patch)||Object.keys(patch).length!==2||!Array.isArray(patch.removed)||!Array.isArray(patch.upserts)||patch.removed.length>300||patch.upserts.length>300||!Object.keys(patch).every(k=>['removed','upserts'].includes(k)))throw new TypeError('Invalid private patch');
 const existing=new Set(previous.map(r=>r.id)),removed=new Set();for(const id of patch.removed){if(!trackingId(id)||!existing.has(id)||removed.has(id))throw new TypeError('Invalid private removal');removed.add(id);}
 const rows=previous.filter(row=>!removed.has(row.id)),ids=new Set(rows.map(r=>r.id));let last=-1;
 for(const item of patch.upserts){if(!object(item)||Object.keys(item).length!==2||!Object.keys(item).every(k=>['index','row'].includes(k))||!Number.isSafeInteger(item.index)||item.index<=last||item.index>rows.length||!object(item.row)||!trackingId(item.row.id)||ids.has(item.row.id))throw new TypeError('Invalid private insertion');last=item.index;ids.add(item.row.id);rows.splice(item.index,0,item.row);}
 return trackingRows(rows);
}
function trackingStatus(status){
 if(!object(status)||typeof status.state!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(status.state))throw new TypeError('Invalid private status');
 for(const field of ['indexer','verification'])if(status[field]!==undefined&&status[field]!==null&&(!object(status[field])||typeof status[field].state!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(status[field].state)))throw new TypeError('Invalid private source status');
}
// Full resets may jump after coalescing/reconnect. Patches always require +1.
export function applyTrackingFrame(previous,revision,frame,maxFrameBytes=2*1024*1024,{eventDeltas=false}={}){
 function safe(value,depth=0){
  if(depth>13)throw new TypeError('Private nesting limit');
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return;
  if(!object(value)&&!Array.isArray(value))throw new TypeError('Invalid private field');
  for(const [key,child]of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw new TypeError('Unsafe private key');safe(child,depth+1);}
 }
 if(!object(frame)||!Number.isSafeInteger(frame.revision)||frame.revision<1)throw new TypeError('Invalid private revision');safe(frame,frame.type==='delta'?-1:0);
 let data;
 if(frame.type==='snapshot')data=frame.data;
 else if(frame.type==='status'&&previous&&frame.revision===revision+1&&Object.keys(frame).every(k=>['type','revision','status'].includes(k)))data={...previous,status:frame.status};
 else if(eventDeltas===true&&frame.type==='delta'&&previous&&frame.revision===revision+1&&Object.keys(frame).every(k=>['type','revision','events','indexedEvents','status'].includes(k))&&('events'in frame||'indexedEvents'in frame)){
  data={...previous,status:frame.status};for(const field of ['events','indexedEvents'])if(field in frame)data[field]=trackingPatch(previous[field]||[],frame[field]);safe(data,1);
 }else throw new TypeError('Private full reset required');
 if(!object(data)||!Array.isArray(data.wallets)||data.wallets.length>100||!Array.isArray(data.events)||data.events.length>1000||data.indexedEvents!==undefined&&(!Array.isArray(data.indexedEvents)||data.indexedEvents.length>1000))throw new TypeError('Invalid private snapshot');
 trackingStatus(data.status);if(eventDeltas===true){trackingRows(data.events);trackingRows(data.indexedEvents||[]);}
 if(Buffer.byteLength(`event: tracking\ndata: ${JSON.stringify({type:'snapshot',revision:frame.revision,data})}\n\n`)>maxFrameBytes)throw new TypeError('Private snapshot limit');
 return{data,revision:frame.revision};
}

export function createTrackingDelta(previous,next,revision){
 const {events:before,indexedEvents:beforeIndexed,status:beforeStatus,...restBefore}=previous;
 const {events:after,indexedEvents:afterIndexed,status,...restAfter}=next;
 if(JSON.stringify(restBefore)!==JSON.stringify(restAfter)||(beforeIndexed===undefined)!==(afterIndexed===undefined))return null;
 const result={type:'delta',revision,status};
 for(const [field,oldRows,newRows]of [['events',before,after],['indexedEvents',beforeIndexed||[],afterIndexed||[]]]){
  trackingRows(oldRows);trackingRows(newRows);const oldMap=new Map(oldRows.map(row=>[row.id,JSON.stringify(row)])),newMap=new Map(newRows.map(row=>[row.id,JSON.stringify(row)]));
  const removed=oldRows.filter(row=>oldMap.get(row.id)!==newMap.get(row.id)).map(row=>row.id),upserts=newRows.flatMap((row,index)=>oldMap.get(row.id)!==newMap.get(row.id)?[{index,row}]:[]);
  if(!removed.length&&!upserts.length){if(oldRows.some((row,i)=>row.id!==newRows[i]?.id))return null;continue;}
  const patch={removed,upserts};if(JSON.stringify(trackingPatch(oldRows,patch))!==JSON.stringify(newRows))return null;result[field]=patch;
 }
 return 'events'in result||'indexedEvents'in result?result:null;
}

/** One demand-driven sampling loop. mode='market' emits snapshots/deltas;
 * mode='full' emits opaque full snapshots for an already-authorized private hub.
 * statusDeltas=true opts tracking into full resets plus status-only frames.
 * transform(raw) runs before validation. read({signal}) may be async. close() is final.
 */
export function createSnapshotStream({read,readUpdate,eventDeltas=false,eventName='market',mode='market',statusDeltas=false,transform=value=>value,intervalMs=1000,heartbeatMs=15000,maxSubscribers=64,maxFrameBytes=2*1024*1024,maxBufferedBytes=2*1024*1024,slowClientMs=10000,readTimeoutMs=8000,setTimeout:later=globalThis.setTimeout,clearTimeout:cancel=globalThis.clearTimeout}={}) {
  if ((typeof read !== 'function' && !(mode==='full'&&typeof readUpdate==='function')) || typeof transform !== 'function' || !/^[a-z][a-z0-9-]{0,31}$/.test(eventName) || !['market','full'].includes(mode)) throw new TypeError('Invalid snapshot stream options');
  intervalMs=bounded(intervalMs,1000,1,3600000); heartbeatMs=bounded(heartbeatMs,15000,1,3600000);
  maxSubscribers=bounded(maxSubscribers,64,1,10000);maxFrameBytes=bounded(maxFrameBytes,2*1024*1024,128,8*1024*1024);maxBufferedBytes=bounded(maxBufferedBytes,maxFrameBytes,128,8*1024*1024);
  slowClientMs=bounded(slowClientMs,10000,1,60000);readTimeoutMs=bounded(readTimeoutMs,8000,1,60000);
  const clients=new Set();let closed=false,failed=false,latest=null,serialized=null,nonStatusSerialized=null,revision=0,producerVersion=null,statusSerialized=null,fullStaticBytes=null,sampleTimer,heartbeatTimer,pending=false,controller;
  const counts={reads:0,readErrors:0,dropped:0,rejected:0};
  const timer=(fn,ms)=>{const handle=later(fn,ms);handle?.unref?.();return handle;};
  function encode(payload){const wire=`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;if(Buffer.byteLength(wire)>maxFrameBytes)throw new TypeError('Snapshot frame limit');return wire;}
  const full=()=>encode({type:'snapshot',revision,data:latest});
  function idle(){if(clients.size)return;cancel(sampleTimer);cancel(heartbeatTimer);sampleTimer=null;heartbeatTimer=null;latest=null;serialized=null;nonStatusSerialized=null;producerVersion=null;statusSerialized=null;fullStaticBytes=null;controller?.abort();}
  function remove(client,destroy=false){if(!clients.delete(client))return;cancel(client.slowTimer);client.req.off?.('aborted',client.cleanup);client.res.off?.('close',client.cleanup);client.res.off?.('error',client.cleanup);client.res.off?.('drain',client.drain);if(destroy){counts.dropped++;client.res.destroy?.();}idle();}
  function send(client,wire){
    if(!clients.has(client))return;
    if(client.blocked){client.reset=true;return;}
    if((client.res.writableLength||0)+Buffer.byteLength(wire)>maxBufferedBytes){remove(client,true);return;}
    try {if(client.res.write(wire)===false){client.blocked=true;client.slowTimer=timer(()=>remove(client,true),slowClientMs);}}
    catch {remove(client,true);}
  }
  function broadcast(wire){for(const client of clients)send(client,wire);}
  function unavailable(){failed=true;producerVersion=null;for(const client of clients)client.initialized=false;broadcast(`event: status\ndata: {"state":"unavailable"}\n\n`);}
  async function sample(){
    if(closed||!clients.size||pending)return;
    pending=true;counts.reads++;const ownController=new AbortController();controller=ownController;let timedOut=false;
    const timeout=timer(()=>{timedOut=true;ownController.abort();if(!closed&&clients.size){counts.readErrors++;unavailable();}},readTimeoutMs);
    try {
      const trusted=mode==='full'&&typeof readUpdate==='function';
      const raw=trusted?await readUpdate({version:producerVersion,signal:ownController.signal}):await read({signal:ownController.signal});
      if(closed||!clients.size||timedOut||ownController.signal.aborted)return;
      if(trusted){
        if(!object(raw)||!(typeof raw.version==='string'&&raw.version.length>0&&raw.version.length<=128&&!/[\u0000-\u001f\u007f]/.test(raw.version)||Number.isSafeInteger(raw.version)&&raw.version>=0))throw new TypeError('Invalid producer version');
        if(!('data'in raw)){
          if(!latest||failed||producerVersion===null||raw.version!==producerVersion||Object.keys(raw).some(k=>!['version','status'].includes(k)))throw new TypeError('Producer reset required');
          const status=publicValue(raw.status,0,{remaining:maxFrameBytes},false);applyTrackingFrame(null,0,{type:'snapshot',revision:revision+1,data:{wallets:[],events:[],status}},maxFrameBytes);const text=JSON.stringify(status);
          if(text===statusSerialized)return;
          const nextRevision=revision+1;if(fullStaticBytes+Buffer.byteLength(text)+String(nextRevision).length>maxFrameBytes)throw new TypeError('Private snapshot limit');
          const wire=encode({type:'status',revision:nextRevision,status});latest={...latest,status};revision=nextRevision;statusSerialized=text;serialized=null;
          for(const client of clients){send(client,client.initialized?wire:full());client.initialized=true;}return;
        }
        if(Object.keys(raw).some(k=>!['version','data'].includes(k)))throw new TypeError('Invalid producer update');
      }
      const transformed=await transform(trusted?raw.data:raw);
      if(closed||!clients.size||ownController.signal.aborted)return;
      const next=mode==='market'?sanitizeMarketSnapshot(transformed,2000,maxFrameBytes):publicValue(transformed,0,{remaining:maxFrameBytes},false);
      const text=JSON.stringify(next);if(text===serialized&&!failed){if(trusted)producerVersion=raw.version;return;}
      const nextRevision=revision+1;let payload={type:'snapshot',revision:nextRevision,data:next},nonStatus=null;
      if(mode==='full'&&(statusDeltas===true||eventDeltas===true||trusted)){
        applyTrackingFrame(null,0,payload,maxFrameBytes,{eventDeltas});
        const {status,...rest}=next;nonStatus=JSON.stringify(rest);
        if(latest&&!failed&&nonStatus===nonStatusSerialized)payload={type:'status',revision:nextRevision,status};
        else if(latest&&!failed&&eventDeltas===true){const patch=createTrackingDelta(latest,next,nextRevision);if(patch){try{applyTrackingFrame(latest,revision,patch,maxFrameBytes,{eventDeltas:true});payload=patch;}catch{/* Full reset preserves valid data if its patch envelope cannot fit. */}}}
      }
      if(latest&&mode==='market'){
        const before=new Map(latest.tokens.map(token=>[token.address.toLowerCase(),JSON.stringify(token)]));const after=new Set(next.tokens.map(token=>token.address.toLowerCase()));
        payload={type:'delta',revision:nextRevision,upserts:next.tokens.filter(token=>before.get(token.address.toLowerCase())!==JSON.stringify(token)),removed:latest.tokens.map(token=>token.address.toLowerCase()).filter(key=>!after.has(key)),monitor:next.monitor};
      }
      const fullWire=encode({type:'snapshot',revision:nextRevision,data:next});let wire;
      try{wire=encode(payload);}catch(error){
        // Replacement IDs can make an otherwise valid event patch larger than
        // its reconstructed full snapshot. The checked full reset still fits.
        if(mode!=='full'||eventDeltas!==true||payload.type!=='delta'||!(error instanceof TypeError)||error.message!=='Snapshot frame limit')throw error;
        wire=fullWire;
      }
      if(mode==='full'&&eventDeltas===true&&Buffer.byteLength(wire)>=Buffer.byteLength(fullWire))wire=fullWire;
      latest=next;serialized=text;nonStatusSerialized=nonStatus;revision=nextRevision;failed=false;
      if(trusted){producerVersion=raw.version;statusSerialized=JSON.stringify(next.status);fullStaticBytes=Buffer.byteLength(fullWire)-Buffer.byteLength(statusSerialized)-String(revision).length;}
      for(const client of clients){send(client,client.initialized?wire:fullWire);client.initialized=true;}
    } catch {if(!closed&&clients.size&&!timedOut){counts.readErrors++;unavailable();}}
    finally {cancel(timeout);pending=false;if(controller===ownController)controller=null;if(!closed&&clients.size)sampleTimer=timer(sample,intervalMs);}
  }
  function heartbeat(){if(closed||!clients.size)return;broadcast(': heartbeat\n\n');heartbeatTimer=timer(heartbeat,heartbeatMs);}
  function attach(req,res){
    if(closed||clients.size>=maxSubscribers){counts.rejected++;res.writeHead(503,{'content-type':'application/json','retry-after':'5'});res.end('{"error":"STREAM_CAPACITY_FULL"}');return false;}
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.flushHeaders?.();
    const client={req,res,blocked:false,reset:false,initialized:false,slowTimer:null};client.cleanup=()=>remove(client);client.drain=()=>{if(!clients.has(client))return;cancel(client.slowTimer);client.blocked=false;if(client.reset&&latest&&!failed){client.reset=false;send(client,full());}};
    clients.add(client);req.on?.('aborted',client.cleanup);res.on?.('close',client.cleanup);res.on?.('error',client.cleanup);res.on?.('drain',client.drain);
    if(failed)send(client,`event: status\ndata: {"state":"unavailable"}\n\n`);else if(latest){send(client,full());client.initialized=true;}
    if(!heartbeatTimer)heartbeatTimer=timer(heartbeat,heartbeatMs);
    if(!sampleTimer&&!pending)void sample();
    return true;
  }
  return {attach,close(){if(closed)return;closed=true;cancel(sampleTimer);cancel(heartbeatTimer);controller?.abort();for(const client of [...clients]){remove(client);client.res.end();}latest=null;serialized=null;nonStatusSerialized=null;producerVersion=null;},metrics:()=>({subscribers:clients.size,revision,...counts,closed,reading:pending})};
}
