'use strict';
window.createOrderObserver=({api,getOwner,isActive=()=>document.visibilityState!=='hidden'&&window.navigator?.onLine!==false,onOrders,onError=()=>{},onReceipt=()=>{},onStatus=()=>{},onMetrics=()=>{},now=()=>performance.now()})=>{
 let owner=getOwner(),version=0,running=false,timer=null,pending=null,orders=[],failures=0,cachedRead=false;
 const receipts=new Map();
 const unfinished=new Set(['SUBMITTING','UNKNOWN','BROADCASTED','PENDING_CONFIRMATION','MINED']);
 const phase=o=>JSON.stringify([o.status,...(o.steps||[]).map(s=>[s.role,s.kind,s.status,s.txHash])]);
 const delay=()=>cachedRead?15000:orders.some(o=>/^0x[0-9a-f]{64}$/i.test(o.txHash||'')&&unfinished.has(o.status)&&!o.receiptMismatch)?500:orders.some(o=>o.status==='ROUTE_RUNNING')?1000:orders.some(o=>['SUBMITTING','PENDING_CONFIRMATION'].includes(o.status))?2000:5000;
 function cancel(){version++;clearTimeout(timer);timer=null;pending?.controller.abort();pending=null;}
 function schedule(ms=delay()){clearTimeout(timer);timer=null;if(running&&owner&&isActive())timer=setTimeout(()=>{timer=null;void refresh();},ms);}
 function update(){const next=getOwner();if(next!==owner){cancel();owner=next;orders=[];receipts.clear();failures=0;}if(!owner||!isActive())cancel();else if(running&&!pending&&timer===null)schedule(0);}
 async function refresh(){
  update();if(!owner||!isActive()||pending)return;clearTimeout(timer);timer=null;
  const revision=version,expected=owner,controller=new AbortController(),request={controller};pending=request;const start=now();
  try{
   const result=await api('/api/orders',undefined,{signal:controller.signal});
   if(revision!==version||controller.signal.aborted||expected!==getOwner()||!isActive())return;
   const received=now(),previous=new Map(orders.map(o=>[o.id,o]));orders=Array.isArray(result.orders)?result.orders:[];failures=0;cachedRead=result.stale===true;
   onOrders(orders,{stale:cachedRead,cachedAt:result.cachedAt||null});
   onMetrics({requestMs:Math.max(0,received-start),renderMs:Math.max(0,now()-received),updatedAt:Date.now()});
   for(const o of orders){
    if(!cachedRead&&previous.has(o.id)&&phase(previous.get(o.id))!==phase(o))onStatus(o);
    const completeRoute=o.kind==='route'&&o.steps?.length&&o.steps.every(s=>s.status==='CONFIRMED');
    if(cachedRead||!previous.has(o.id)||o.receiptStatus!==1&&!completeRoute||!['MINED','CONFIRMED'].includes(o.status))continue;
    const key=`${o.firstReceiptObservedAt||o.minedAt||''}:${o.status}`;
    if(receipts.get(o.id)!==key){receipts.set(o.id,key);onReceipt(o);}
   }
   if(receipts.size>200)for(const id of [...receipts.keys()].slice(0,receipts.size-200))receipts.delete(id);
  }catch(error){if(revision===version&&!controller.signal.aborted&&expected===getOwner()){failures++;onError(error);}}
  finally{if(pending===request){pending=null;schedule(failures?Math.min(30000,delay()*2**Math.min(failures,6)):delay());}}
 }
 return {start(){if(running)return;running=true;update();},refresh,update,seed(value){cancel();orders=value;schedule(0);},stop(){running=false;cancel();orders=[];receipts.clear();}};
};

window.createTradeNotifications=({getSymbol=()=>''}={})=>{
 const area=document.createElement('section');area.className='trade-notices';area.setAttribute('aria-label','交易进度');area.setAttribute('aria-live','polite');document.body.append(area);
 const cards=new Map();
 function update(order){
  if(!order?.id)return;
  let card=cards.get(order.id);if(!card){card=document.createElement('article');card.className='trade-notice';cards.set(order.id,card);area.prepend(card);}
  const approval=order.kind==='approve'||order.route?.kind==='preapproval',wrap=order.kind==='wrap';
  const verb=approval?'授权':wrap?'包装':order.side==='sell'?'卖出':'买入';
  const routeConfirmed=order.kind==='route'&&order.steps?.length&&order.steps.every(s=>s.status==='CONFIRMED');
  const confirmed=order.status==='CONFIRMED'&&(order.receiptStatus===1||routeConfirmed),failed=['REVERTED','FAILED','ROUTE_FAILED'].includes(order.status);
  const setupPending=order.route?.kind==='single-setup'&&order.status==='ROUTE_RUNNING'&&!order.steps?.some(s=>s.role==='target'&&s.kind!=='approve'&&s.submissionAttempted);
  const title=confirmed?(approval?'授权完成':wrap?'包装完成':verb+'成功'):failed?verb+'失败':order.status==='UNKNOWN'?'结果待核对':order.status==='ROUTE_PAUSED'?'路线已暂停':setupPending?'授权确认中，随后自动'+verb:order.status==='PENDING_CONFIRMATION'?'等待币安确认':order.status==='MINED'?'已打包，等待确认':order.status==='DEMO_COMPLETED'?'模拟完成':verb+'已提交，等待确认';
  card.className='trade-notice '+(confirmed?'success':failed?'failure':'pending');card.replaceChildren();
  const close=document.createElement('button');close.type='button';close.className='trade-notice-close';close.setAttribute('aria-label','关闭订单提示');close.textContent='×';close.onclick=()=>{cards.delete(order.id);card.remove();};
  const heading=document.createElement('strong');heading.textContent=title+' · '+getSymbol(order);
  const detail=document.createElement('p');detail.textContent=order.status==='UNKNOWN'?'请核对订单记录，勿重复提交':failed||order.status==='ROUTE_PAUSED'?order.error||'请查看订单详情':confirmed?'链上已确认':setupPending?'本次买卖已排队，无需再次点击':order.status==='PENDING_CONFIRMATION'?'请在币安完成必要操作，平台会继续跟踪':'交易状态会自动更新';
  card.append(close,heading,detail);
  const tx=order.txHash||order.steps?.findLast(s=>/^0x[0-9a-f]{64}$/i.test(s.txHash||''))?.txHash;
  if(/^0x[0-9a-f]{64}$/i.test(tx||'')){const link=document.createElement('a');link.href='https://bscscan.com/tx/'+tx;link.target='_blank';link.rel='noopener noreferrer';link.textContent='查看链上交易 ↗';card.append(link);}
  while(cards.size>4){const id=cards.keys().next().value;cards.get(id).remove();cards.delete(id);}
 }
 return{update,clear(){cards.clear();area.replaceChildren();}};
};
