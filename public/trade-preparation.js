'use strict';
window.createTradePreparation=({api,getOwner,getInput,canPrepare,onReady,onStatus=()=>{},onError=()=>{},now=()=>performance.now()})=>{
 let version=0,timer=null,pending=null,expires=0,executable=false;
 function cancel(){version++;clearTimeout(timer);timer=null;pending?.abort();pending=null;expires=0;onStatus('');}
 function handoff(){version++;clearTimeout(timer);timer=null;pending=null;expires=0;executable=false;onStatus('');}
 function tick(){if(expires&&now()>=expires){expires=0;onStatus('只读预取已过期 · 操作时刷新报价');if(executable&&!pending&&canPrepare()){executable=false;schedule();}}}
 function schedule(){
  cancel();if(!canPrepare())return;let input;try{input=getInput();}catch{return;}
  const revision=version,owner=getOwner(),key=JSON.stringify(input);onStatus('即将读取报价、授权需求与 Gas…');
  timer=setTimeout(async()=>{
   timer=null;if(revision!==version||!canPrepare()||owner!==getOwner())return;
   const controller=new AbortController();pending=controller;const start=now();onStatus('只读准备中 · 不会发起交易');
   try{
    const result=await api('/api/trade-prepare',input,{signal:controller.signal});
    if(revision!==version||controller.signal.aborted||owner!==getOwner()||!canPrepare()||JSON.stringify(getInput())!==key)return;
    const elapsed=Math.max(0,now()-start),serverDuration=Number.isFinite(result.timings?.totalMs)?Math.max(0,Math.min(elapsed,result.timings.totalMs)):0;
    // Durations are comparable; absolute browser/server clocks are never mixed.
    // remainingMs already excludes server work, so subtract only transport overhead.
    const remaining=Number.isFinite(result.remainingMs)?Math.min(result.executionReady===true?10000:3000,result.remainingMs)-Math.max(0,elapsed-serverDuration):0;
    if(remaining<=0){onStatus('只读预取已过期 · 操作时刷新报价');return;}
    if(onReady(result)===false){onStatus('钱包或会话已变化 · 请刷新钱包后重新预览');return;}
    expires=now()+remaining;
    executable=result.executionReady===true;
    onStatus(executable?'交易预备就绪 · 可直接点击提交':result.kind==='approve'?'需要授权 · 按自动授权设置处理':result.kind==='wrap'?'需要先包装 BNB → WBNB · 请单独预览确认':'报价预取完成 · 执行前核对当前余额和价格');
   }catch(error){if(revision===version&&!controller.signal.aborted&&owner===getOwner()){onStatus('预取未就绪 · 点击预览时重新检查');onError(error);}}
   finally{if(revision===version)pending=null;}
  },600);
 }
 return{schedule,cancel,tick,handoff};
};
