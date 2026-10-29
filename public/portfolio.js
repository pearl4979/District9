'use strict';
window.createPortfolio=({api,getContext,onOpen=()=>{}})=>{
 const $=id=>document.getElementById(id),node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
 let owner=null,epoch=0,pending=null,timer=null,data=null,lastRead=0,stopped=false,receiptNotice=false;
 const value=x=>typeof x==='string'&&/^-?\d+(?:\.\d+)?$/.test(x)&&Number.isFinite(Number(x))?Number(x):null;
 const money=(x,signed=false)=>{const n=value(x);return n===null?'—':`${signed&&n>0?'+':''}${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:Math.abs(n)>0&&Math.abs(n)<.01?6:2}).format(n)}`;};
 const amount=x=>value(x)===null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:8}).format(Number(x));
 const tone=(e,x)=>{const n=value(x);e.classList.toggle('profit',n!==null&&n>0);e.classList.toggle('loss',n!==null&&n<0);};
 function resetView(){data=null;lastRead=0;$('portfolio-rows').replaceChildren();for(const id of ['native','value','pnl','realized','unrealized']){$(`portfolio-${id}`).textContent='—';tone($(`portfolio-${id}`),null);}$('portfolio-count').textContent='0';$('portfolio-empty').hidden=false;$('portfolio-empty').textContent='连接 Agent 钱包后查看持仓与 PNL。';$('portfolio-owner').textContent='未连接钱包';$('portfolio-updated').textContent='尚未读取';$('portfolio-pnl-coverage').textContent='成本记录待核验';$('portfolio-error').hidden=true;$('portfolio-refresh').disabled=true;}
 function invalidate(){epoch++;pending?.controller.abort();pending=null;clearTimeout(timer);timer=null;}
 function clear(){invalidate();owner=null;receiptNotice=false;resetView();}
 function render(result){
  data=result;const s=result.summary||{};$('portfolio-owner').textContent=result.address?`${result.address.slice(0,6)}…${result.address.slice(-4)} · BNB Chain`:'未连接钱包';
  $('portfolio-updated').textContent=result.updatedAt?`${result.stale?'历史快照':'更新'} ${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(result.updatedAt))}`:'尚未读取';
  if(receiptNotice)$('portfolio-updated').textContent+=' · 已读取，余额索引可能延迟';
  $('portfolio-mode').textContent=result.demo?'DEMO · 模拟持仓':'只读 · 真实交易关闭';
  $('portfolio-native').textContent=s.nativeBalance===null||s.nativeBalance===undefined?'—':`${amount(s.nativeBalance)} BNB`;
  for(const [id,field,signed]of [['value','valueUsd',false],['pnl','pnlUsd',true],['realized','realizedUsd',true],['unrealized','unrealizedUsd',true]]){$(`portfolio-${id}`).textContent=money(s[field],signed);tone($(`portfolio-${id}`),signed?s[field]:null);}
  $('portfolio-pnl-coverage').textContent=`${s.knownPnlCount||0} 项成本已知 · ${s.unknownPnlCount||0} 项待核验`;
  const rows=Array.isArray(result.holdings)?result.holdings:[];$('portfolio-count').textContent=String(rows.length);$('portfolio-rows').replaceChildren();
  for(const holding of rows){
   const tr=node('tr'),identity=node('td'),button=node('button','portfolio-token');button.type='button';button.disabled=!holding.canOpen;
   const visual=node('span','portfolio-token-icon',String(holding.symbol||'?').slice(0,1));if(/^\/api\/token-image\/0x[0-9a-f]{40}$/i.test(holding.imageUrl||'')){const img=node('img');img.src=holding.imageUrl;img.alt='';img.addEventListener('error',()=>img.remove());visual.append(img);}
   const label=node('span');label.append(node('strong','',holding.symbol||'TOKEN'),node('small','',holding.positionKind==='shares'?'内盘市场份额':holding.platformId?({gang:'Gang',four:'Four.meme',flap:'Flap'}[holding.platformId]||'BSC'):'BSC 代币'));button.append(visual,label);button.addEventListener('click',()=>onOpen(holding.address));identity.append(button);
   const balance=node('td','mono',amount(holding.balance));balance.title=String(holding.balance||'');balance.append(node('small','',holding.positionKind==='shares'?'份额':'TOKEN'));
   const price=node('td','mono',money(holding.priceUsd)),worth=node('td','mono',money(holding.valueUsd)),pnl=node('td','portfolio-row-pnl');
   if(holding.pnl?.status==='known'){const total=node('strong','mono',money(holding.pnl.totalUsd,true));tone(total,holding.pnl.totalUsd);pnl.append(total,node('small','',holding.pnl.percent!==null&&holding.pnl.percent!==undefined?`${new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(Number(holding.pnl.percent))}% 浮盈亏`:'已知成本'));pnl.title=`已实现 ${money(holding.pnl.realizedUsd,true)} · 未实现 ${money(holding.pnl.unrealizedUsd,true)}`;}
   else {pnl.append(node('span','quiet','暂不可核算'));pnl.title=holding.pnl?.reason||'成本或估值未知';}
   tr.append(identity,balance,price,worth,pnl);$('portfolio-rows').append(tr);
  }
  $('portfolio-empty').hidden=rows.length>0;$('portfolio-empty').textContent=result.connected?'当前来源未返回可展示持仓；不代表钱包所有资产余额为零。':'连接 Agent 钱包后查看持仓与 PNL。';
  $('portfolio-coverage').textContent=result.coverage?.description||'当前数据覆盖范围未知';$('portfolio-pnl-note').textContent=result.coverage?.pnlDescription||'缺少历史成本时不估算盈亏。';
 }
 function active(){return !stopped&&window.location.hash==='#orders';}
 function schedule(){clearTimeout(timer);if(active()&&owner)timer=setTimeout(()=>{void refresh();},15000);}
 async function refresh(explicit=false){
  if(!active()||!owner||pending)return;const revision=epoch,expected=owner,controller=new AbortController(),request={controller};pending=request;$('portfolio-refresh').disabled=true;$('portfolio-error').hidden=true;if(!data)$('portfolio-empty').textContent='正在读取钱包持仓…';
  try{const result=await api(`/api/portfolio${explicit===true&&getContext().session?.viewMode==='shared'?'?refresh=1':''}`,undefined,{signal:controller.signal});const current=getContext();if(revision!==epoch||controller.signal.aborted||expected!==owner)return;
   if(result.connected&&String(result.address).toLowerCase()!==String(current.wallet?.address).toLowerCase())throw Error('持仓地址与当前钱包不一致');
   if(Boolean(result.demo)!==(current.session?.mode==='demo')&&result.connected)throw Error('持仓模式与当前会话不一致');
   render(result);lastRead=Date.now();
  }catch(error){if(revision===epoch&&!controller.signal.aborted){$('portfolio-error').textContent=`${error.message}${data?' · 保留上次数据，暂未刷新':' · 未读取到持仓数据'}`;$('portfolio-error').hidden=false;if(!data)$('portfolio-empty').textContent='持仓读取失败，可点击刷新重试。';}}
  finally{if(pending===request){pending=null;$('portfolio-refresh').disabled=!owner;schedule();}}
 }
 function update(){const c=getContext(),w=c.wallet,next=(w?.status==='CONNECTED'||c.session?.viewMode==='shared'&&w?.status==='SLEEPING')&&/^0x[0-9a-f]{40}$/i.test(w.address||'')?`${c.session?.mode}:${c.session?.account?.id||'local'}:${w.address.toLowerCase()}`:null;
  if(next!==owner){invalidate();owner=next;receiptNotice=false;resetView();}if(!next)return;$('portfolio-refresh').disabled=Boolean(pending);if(active()&&!pending&&(!data||Date.now()-lastRead>=15000))void refresh();
 }
 $('portfolio-refresh').addEventListener('click',()=>void refresh(true));window.addEventListener('hashchange',()=>{if(active())update();else{invalidate();$('portfolio-refresh').disabled=!owner;}});
 resetView();return{update,refresh,clear,receiptObserved(){invalidate();lastRead=0;receiptNotice=true;$('portfolio-updated').textContent='已观察成功回执 · 正在刷新余额，索引可能延迟';void refresh();},stop(){stopped=true;clear();}};
};
