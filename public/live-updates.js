(() => {
  'use strict';
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const address=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value);
  const bounded=(value,fallback,min,max)=>Number.isInteger(value)&&value>=min&&value<=max?value:fallback;
  const clone=value=>JSON.parse(JSON.stringify(value));
  function market(value){
    if(!object(value)||!Array.isArray(value.tokens)||value.tokens.length>2000||!object(value.monitor))throw Error('Invalid market');
    const seen=new Set();
    for(const token of value.tokens){if(!object(token)||!address(token.address)||token.verified!==true||!['four','flap','gang'].includes(token.platformId)||(token.tradable!==undefined&&typeof token.tradable!=='boolean')||seen.has(token.address.toLowerCase()))throw Error('Invalid verified identity');seen.add(token.address.toLowerCase());}
    return {tokens:clone(value.tokens),monitor:clone(value.monitor)};
  }
  function patch(previous,revision,frame){
    if(!object(frame)||!Number.isSafeInteger(frame.revision)||frame.revision<1)throw Error('Invalid revision');
    if(frame.type==='snapshot')return {data:market(frame.data),revision:frame.revision};
    if(frame.type!=='delta'||!previous||frame.revision!==revision+1||!Array.isArray(frame.removed)||frame.removed.length>2000||frame.removed.some(value=>!address(value)))throw Error('Full reset required');
    const update=market({tokens:frame.upserts,monitor:frame.monitor}),rows=new Map(previous.tokens.map(token=>[token.address.toLowerCase(),token]));
    for(const key of frame.removed)rows.delete(key.toLowerCase());for(const token of update.tokens)rows.set(token.address.toLowerCase(),token);
    return {data:market({tokens:[...rows.values()],monitor:update.monitor}),revision:frame.revision};
  }
const trackingId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
function trackingRows(rows){
 if(!Array.isArray(rows)||rows.length>300)throw Error('Private event limit');
 const ids=new Set();for(const row of rows){if(!object(row)||!trackingId(row.id)||ids.has(row.id))throw Error('Invalid private event identity');ids.add(row.id);}return rows;
}
function trackingPatch(previous,patch){
 trackingRows(previous);
 if(!object(patch)||Object.keys(patch).length!==2||!Array.isArray(patch.removed)||!Array.isArray(patch.upserts)||patch.removed.length>300||patch.upserts.length>300||!Object.keys(patch).every(k=>['removed','upserts'].includes(k)))throw Error('Invalid private patch');
 const existing=new Set(previous.map(r=>r.id)),removed=new Set();for(const id of patch.removed){if(!trackingId(id)||!existing.has(id)||removed.has(id))throw Error('Invalid private removal');removed.add(id);}
 const rows=previous.filter(row=>!removed.has(row.id)),ids=new Set(rows.map(r=>r.id));let last=-1;
 for(const item of patch.upserts){if(!object(item)||Object.keys(item).length!==2||!Object.keys(item).every(k=>['index','row'].includes(k))||!Number.isSafeInteger(item.index)||item.index<=last||item.index>rows.length||!object(item.row)||!trackingId(item.row.id)||ids.has(item.row.id))throw Error('Invalid private insertion');last=item.index;ids.add(item.row.id);rows.splice(item.index,0,item.row);}
 return trackingRows(rows);
}
function trackingStatus(status){
 if(!object(status)||typeof status.state!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(status.state))throw Error('Invalid private status');
 for(const field of ['indexer','verification'])if(status[field]!==undefined&&status[field]!==null&&(!object(status[field])||typeof status[field].state!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(status[field].state)))throw Error('Invalid private source status');
}
// Full resets may jump after coalescing/reconnect. Patches always require +1.
function tracking(previous,revision,frame,maxFrameBytes=2*1024*1024,{eventDeltas=false}={}){
 function safe(value,depth=0){
  if(depth>13)throw Error('Private nesting limit');
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return;
  if(!object(value)&&!Array.isArray(value))throw Error('Invalid private field');
  for(const [key,child]of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe private key');safe(child,depth+1);}
 }
 if(!object(frame)||!Number.isSafeInteger(frame.revision)||frame.revision<1)throw Error('Invalid private revision');safe(frame,frame.type==='delta'?-1:0);
 let data;
 if(frame.type==='snapshot')data=frame.data;
 else if(frame.type==='status'&&previous&&frame.revision===revision+1&&Object.keys(frame).every(k=>['type','revision','status'].includes(k)))data={...previous,status:frame.status};
 else if(eventDeltas===true&&frame.type==='delta'&&previous&&frame.revision===revision+1&&Object.keys(frame).every(k=>['type','revision','events','indexedEvents','status'].includes(k))&&('events'in frame||'indexedEvents'in frame)){
  data={...previous,status:frame.status};for(const field of ['events','indexedEvents'])if(field in frame)data[field]=trackingPatch(previous[field]||[],frame[field]);safe(data,1);
 }else throw Error('Private full reset required');
 if(!object(data)||!Array.isArray(data.wallets)||data.wallets.length>100||!Array.isArray(data.events)||data.events.length>1000||data.indexedEvents!==undefined&&(!Array.isArray(data.indexedEvents)||data.indexedEvents.length>1000))throw Error('Invalid private snapshot');
 trackingStatus(data.status);if(eventDeltas===true){trackingRows(data.events);trackingRows(data.indexedEvents||[]);}
 if(new TextEncoder().encode(`event: tracking\ndata: ${JSON.stringify({type:'snapshot',revision:frame.revision,data})}\n\n`).length>maxFrameBytes)throw Error('Private snapshot limit');
 return{data,revision:frame.revision};
}

  function parser(maxBytes,onEvent){
    const decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();let pending='',event='message',data=[],size=0;
    function line(value){
      size+=encoder.encode(value).length+1;if(size>maxBytes)throw Error('Frame limit');
      if(value===''){if(data.length)onEvent(event,data.join('\n'));event='message';data=[];size=0;return;}
      if(value.startsWith(':'))return;const at=value.indexOf(':'),key=at<0?value:value.slice(0,at);let body=at<0?'':value.slice(at+1);if(body.startsWith(' '))body=body.slice(1);
      if(key==='event')event=body;else if(key==='data')data.push(body);
    }
    return chunk=>{if(chunk.byteLength>maxBytes*2)throw Error('Chunk limit');pending+=decoder.decode(chunk,{stream:true});let at;while((at=pending.search(/[\r\n]/))>=0){if(pending[at]==='\r'&&at===pending.length-1)break;const width=pending[at]==='\r'&&pending[at+1]==='\n'?2:1;line(pending.slice(0,at));pending=pending.slice(at+width);}if(size+encoder.encode(pending).length>maxBytes)throw Error('Buffer limit');};
  }
  /** Same-origin fixed endpoints. Private tracking uses fetch streaming so its
   * connection can carry a captured X-Account-Context from getHeaders().
   * onMarket receives a full reconstructed snapshot; onTracking receives opaque
   * full tracking data; onState/onFallback receive {channel,state,reason,...}.
   * Fallback hooks let the application keep its existing bounded polling policy.
   */
  window.createLiveUpdates = function createLiveUpdates(options={}) {
    const doc=options.document||document,nav=options.navigator||navigator,events=options.window||window;
    const fetcher=options.fetch||globalThis.fetch,later=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout;
    const retryMs=bounded(options.retryMs,1000,1,60000),maxRetryMs=bounded(options.maxRetryMs,30000,retryMs,300000),idleMs=bounded(options.idleMs,45000,10,300000),maxFrameBytes=bounded(options.maxFrameBytes,2*1024*1024,128,8*1024*1024),maxRetries=bounded(options.maxRetries,8,0,100);
    let running=false,generation=0,listening=false,trackingRevoked=false,enabled={market:options.market!==false,tracking:options.tracking===true};const connections=new Map();
    function notify(callback,...args){try{callback?.(...args);}catch{ /* UI consumers do not own the transport lifecycle. */ }}
    function state(channel,value,details={}){notify(options.onState,{channel,state:value,...details});}
    function paused(){return doc.hidden||doc.visibilityState==='hidden'||nav.onLine===false;}
    function cancelConnections(){generation++;for(const item of connections.values()){cancel(item.retryTimer);cancel(item.idleTimer);item.controller?.abort();void item.reader?.cancel().catch(()=>{});}connections.clear();}
    async function connect(channel,expected,attempt=0){
      if(!running||expected!==generation||!enabled[channel]||paused()||channel==='tracking'&&trackingRevoked)return;
      const item={controller:new AbortController(),reader:null,retryTimer:null,idleTimer:null};connections.set(channel,item);
      const active=()=>running&&expected===generation&&connections.get(channel)===item&&!item.controller.signal.aborted&&!paused();
      let accepted=null,revision=0;
      const touch=()=>{cancel(item.idleTimer);item.idleTimer=later(()=>item.controller.abort(),idleMs);};
      state(channel,'connecting',{attempt});
      if(!active())return;
      try {
        const headers=new Headers(channel==='tracking'?(options.getHeaders?.()||{}):{});headers.set('Accept','text/event-stream');
        touch();const response=await fetcher(channel==='market'?'/api/market-stream':'/api/tracking-stream',{method:'GET',headers,credentials:channel==='market'?'omit':'same-origin',redirect:'error',cache:'no-store',signal:item.controller.signal});
        if(!active()){void response.body?.cancel().catch(()=>{});return;}
        if(channel==='tracking'&&(response.status===401||response.status===409)){
          trackingRevoked=true;void response.body?.cancel().catch(()=>{});
          state(channel,'stopped',{reason:'auth-revoked',status:response.status});
          if(active())notify(options.onAuthError,{channel:'tracking',status:response.status});
          return;
        }
        if(!response.ok||!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type')||'')||!response.body?.getReader)throw Error('Stream unavailable');
        const consume=parser(maxFrameBytes,(event,text)=>{
          if(!active())return;if(event==='status')throw Error('Source unavailable');if(event!==channel)return;
          const frame=JSON.parse(text);
          if(channel==='market'){
            const result=patch(accepted,revision,frame);accepted=result.data;revision=result.revision;notify(options.onMarket,clone(accepted),{type:frame.type,revision});
          } else {
            const result=tracking(accepted,revision,frame,maxFrameBytes,{eventDeltas:options.trackingDeltas===true});accepted=result.data;revision=result.revision;
            notify(options.onTracking,clone(accepted),{type:frame.type,revision});
          }
          if(active()){attempt=0;state(channel,'live');}
        });
        item.reader=response.body.getReader();
        while(active()) {const {value,done}=await item.reader.read();if(!active())return;if(done)throw Error('Stream ended');touch();consume(value);}
      } catch {
        if(running&&expected===generation&&connections.get(channel)===item&&!paused()){
          const retryInMs=attempt<maxRetries?Math.min(maxRetryMs,retryMs*2**Math.min(attempt,16)):null;
          const status={channel,state:'fallback',reason:'stream-unavailable',attempt,retryInMs};state(channel,'fallback',{reason:status.reason,attempt,retryInMs});notify(options.onFallback,status);
          if(retryInMs!==null&&running&&expected===generation&&connections.get(channel)===item)item.retryTimer=later(()=>connect(channel,expected,attempt+1),retryInMs);
        }
      } finally {cancel(item.idleTimer);item.controller.abort();void item.reader?.cancel().catch(()=>{});}
    }
    function launch(){if(!running)return;if(paused()){for(const channel of ['market','tracking'])if(enabled[channel])state(channel,'paused',{reason:nav.onLine===false?'offline':'hidden'});return;}for(const channel of ['market','tracking'])if(enabled[channel])void connect(channel,generation);}
    function environmentChanged(){if(!running)return;cancelConnections();launch();}
    function listen(){if(listening)return;listening=true;doc.addEventListener?.('visibilitychange',environmentChanged);events.addEventListener?.('online',environmentChanged);events.addEventListener?.('offline',environmentChanged);}
    function unlisten(){if(!listening)return;listening=false;doc.removeEventListener?.('visibilitychange',environmentChanged);events.removeEventListener?.('online',environmentChanged);events.removeEventListener?.('offline',environmentChanged);}
    return {
      start(){if(running)return;running=true;listen();launch();},
      stop(){if(!running)return;running=false;cancelConnections();unlisten();for(const channel of ['market','tracking'])state(channel,'stopped');},
      reset(){trackingRevoked=false;cancelConnections();for(const channel of ['market','tracking'])state(channel,'reset');launch();},
      update(next={}){const updated={market:typeof next.market==='boolean'?next.market:enabled.market,tracking:typeof next.tracking==='boolean'?next.tracking:enabled.tracking};if(updated.market===enabled.market&&updated.tracking===enabled.tracking)return;cancelConnections();enabled=updated;for(const channel of ['market','tracking'])if(!enabled[channel])state(channel,'stopped',{reason:'disabled'});launch();},
    };
  };
})();
