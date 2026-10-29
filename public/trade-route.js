'use strict';
window.createTradeRouteView=({onChange=()=>{}}={})=>{
 const $=id=>document.getElementById(id),node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
 const WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',ZERO='0x'+'0'.repeat(40);
 let choice='bnb',enabled=false,current=null,side='buy';
 const control=node('div','route-currency-control');control.id='route-currency-control';control.hidden=true;
 const label=node('span');label.id='route-currency-label';const group=node('div');group.setAttribute('role','group');group.setAttribute('aria-label','支付或到账币种');
 const buttons=['bnb','quote'].map(value=>{const b=node('button','','');b.type='button';b.dataset.settlement=value;b.addEventListener('click',()=>{if(b.disabled||choice===value)return;choice=value;update({token:current,side,enabled});onChange(value);});group.append(b);return b;});
 control.append(label,group);$('trade-form')?.querySelector('.field-heading')?.before(control);
 const panel=node('section','trade-route-plan');panel.id='trade-route-plan';panel.hidden=true;panel.setAttribute('aria-label','自动兑换路线');$('preview-button')?.before(panel);
 function available(token,s){
  if(!enabled||!token||token.phase==='graduated'||!['gang','flap'].includes(token.platformId))return false;
  const asset=String(token.quoteAsset||'').toLowerCase();if(!asset||asset===ZERO)return false;
  if(asset===WBNB)return token.platformId==='gang'&&token.pad==='merged'&&token.phase==='graduated';
  return true;
 }
 function settlement(token=current,s=side){if(enabled&&token?.phase==='graduated')return 'bnb';return available(token,s)?choice:'quote';}
 function update({token,side:s='buy',enabled:e=false,busy=false}){
  current=token;side=s;enabled=e===true;control.hidden=!available(token,s);label.textContent=s==='buy'?'支付币种':'到账币种';
  buttons[0].textContent='BNB';buttons[1].textContent=token?.quoteSymbol||'底币';
  for(const b of buttons){b.disabled=busy;b.setAttribute('aria-pressed',String(b.dataset.settlement===choice));}
 }
 const labels={PLANNED:'未执行',PREPARING:'报价与模拟',SUBMITTING:'提交中',MARKET_PENDING:'币安处理中 · 等待真实到账',BROADCASTED:'已广播 · 等待回执',MINED:'已入块 · 等待确认',CONFIRMED:'已确认',UNKNOWN:'结果未知 · 不会重发',PENDING_CONFIRMATION:'等待钱包确认',STOPPED:'已停止',REVERTED:'已回滚'};
 function stepList(steps=[]){const list=node('ol','route-steps');for(const step of steps){const row=node('li',`route-step ${step.status==='CONFIRMED'?'confirmed':''}`);row.append(node('span','',step.label||'交易步骤'),node('small','',labels[step.status]||'未完成'));
   if(/^0x[0-9a-f]{64}$/i.test(step.txHash||'')){const link=node('a','','查看交易 ↗');link.href=`https://bscscan.com/tx/${step.txHash}`;link.target='_blank';link.rel='noopener noreferrer';row.append(link);}
   if(step.error)row.append(node('p','route-step-error',step.error));list.append(row);}return list;}
 function showPlan(plan){panel.replaceChildren();panel.hidden=!plan;if(!plan)return;const s=plan.summary||{};panel.append(node('strong','','路线仅预演 · 尚未执行'),stepList(plan.steps));
  const expected=plan.input?.side==='sell'?s.estimatedReceive:s.estimatedTokens||s.estimatedShares||s.tradeRisk?.estimatedNetOutput;
  const minimum=plan.input?.side==='sell'?s.minReceive:s.minTokens||s.minShares||s.tradeRisk?.minimumNetOutput;
  const unit=plan.input?.side==='sell'?'BNB':s.tradeRisk?.outputSymbol||s.symbol||'目标持仓';
  panel.append(node('p','',`预计收到 ${expected??'待核验'} ${unit} · 最低 ${minimum??'待核验'} ${unit}`));
  if(plan.kind==='binance-sequential')panel.append(node('p','field-help','币安聚合提交时会重新报价；这里的最低到账为估计。订单 ID 不代表成交，后台等待实际到账后才继续。'));
  if(s.estimatedGasReserve)panel.append(node('p','',`整条路线预留 Gas ${s.estimatedGasReserve} BNB；预留额不等于实际费用。`));
  panel.append(node('p','field-help','多步之间会等待链上确认并重新报价；后一步失败时，已收到的底币留在你的钱包。报价不等于已成交。'));
 }
 function renderOrder(order){const el=node('section','route-order-progress');el.setAttribute('aria-label','多步骤交易进度');const complete=order.status==='CONFIRMED';el.append(node('strong','',complete?'整条路线已确认':'后续步骤未完成，请查看进度'),stepList(order.steps));
  for(const asset of order.retainedBalances||[]){el.append(node('p','route-retained',`本路线留存：${asset.amount??'待核对'} ${asset.symbol||'底币'}`));}
  if(order.retainedBalances?.length)el.append(node('p','field-help','余额为上一步确认时的观察快照；请刷新钱包核对当前余额。不会自动重试或退款。'));
  return el;
 }
 return{update,settlement,showPlan,renderOrder,choose(value){if(!['bnb','quote'].includes(value)||choice===value)return;choice=value;update({token:current,side,enabled});onChange(value);},canSettle:available,clear(){panel.hidden=true;panel.replaceChildren();}};
};
