'use strict';
window.createTradeApprovals=({api,getOwner,isLive})=>{
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const panel=node('details');panel.className='dev-details preapproval-settings';const title=node('summary','交易授权加速');
 const label=node('label'),toggle=node('input');toggle.type='checkbox';label.append(toggle,document.createTextNode(' 买入确认后预授权当前持仓'));
 const help=node('p','默认关闭。开启后仅向已核验卖出合约授权当前持仓，减少下次卖出等待。币安聚合的授权由钱包管理；关闭本选项不会撤销已有链上额度。');help.className='field-help';
 const autoLabel=node('label'),autoToggle=node('input');autoToggle.type='checkbox';autoLabel.append(autoToggle,document.createTextNode(' 授权完成后自动继续本次买卖'));
 const autoHelp=node('p','默认关闭。开启后，点击买卖即同意先授权本次精确额度，确认后自动继续原订单，无需再次点击；已有授权正在确认时会等待它。授权与交易分别产生 Gas，原最低到账仍有效。');autoHelp.className='field-help';
 const refresh=node('button','刷新授权记录');refresh.type='button';refresh.className='button subtle';const list=node('div'),message=node('p');message.className='field-help';
 panel.append(title,label,help,autoLabel,autoHelp,refresh,message,list);document.querySelector('.wallet-content')?.append(panel);
 let owner=null,epoch=0,busy=false,data={enabled:false,approvals:[]};
 function render(){toggle.checked=data.enabled===true;autoToggle.checked=data.automaticSetup===true;toggle.disabled=autoToggle.disabled=busy||!owner;refresh.disabled=busy||!owner;list.replaceChildren();const latest=new Map();for(const row of data.approvals||[]){const k=row.token+':'+row.spender;if(!latest.has(k))latest.set(k,row);}for(const row of latest.values()){
   const el=node('div');el.className='approval-record';el.append(node('p',`${row.token.slice(0,8)}… → ${row.spender.slice(0,8)}…`),node('small',`${row.revoke?'撤销':'授权'}额度 ${row.amountRaw}（原始单位） · ${row.status}`));
   if(!row.revoke&&row.status==='CONFIRMED'){const revoke=node('button','撤销此额度');revoke.type='button';revoke.className='button subtle';revoke.disabled=busy||!isLive();revoke.title=isLive()?'将发送 approve(0)，需支付 Gas':'实盘关闭，撤销不会发送';revoke.addEventListener('click',()=>act('/api/approvals/revoke',{orderId:row.orderId}));el.append(revoke);}list.append(el);
  }}
 async function load(){const e=epoch;if(!owner||busy)return;busy=true;render();try{const value=await api('/api/settings/preapproval');if(e!==epoch)return;data=value;message.textContent=value.message||'';}catch(err){if(e===epoch)message.textContent=err.message;}finally{if(e===epoch){busy=false;render();}}}
 async function act(path,body){if(busy||!owner)return;const e=epoch;busy=true;render();try{const result=await api(path,body);if(e!==epoch)return;if(path.includes('/settings/'))data=result;message.textContent=path.includes('/revoke')?'撤销已提交，等待链上确认；可刷新记录。':body.automaticSetup!==undefined?(data.automaticSetup?'已开启：以后点击买卖，必要的精确授权确认后将自动继续。':'已关闭授权后的自动买卖。'):data.enabled?'已开启；只对之后确认的买入生效。':'已关闭新的后台预授权。';}catch(err){if(e===epoch)message.textContent=err.message;}finally{if(e===epoch){busy=false;render();}}}
 toggle.addEventListener('change',()=>act('/api/settings/preapproval',{enabled:toggle.checked}));refresh.addEventListener('click',load);panel.addEventListener('toggle',()=>{if(panel.open)void load();});
 autoToggle.addEventListener('change',()=>act('/api/settings/preapproval',{automaticSetup:autoToggle.checked}));
 return{update(){const next=getOwner()||null;if(next!==owner){epoch++;owner=next;busy=false;data={enabled:false,approvals:[]};message.textContent='';if(panel.open)void load();}render();},clear(){epoch++;owner=null;busy=false;data={enabled:false,approvals:[]};message.textContent='';render();}};
};
