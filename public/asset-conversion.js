'use strict';
window.createAssetConversionView=({api,getContext,getBusy=()=>false,onBusy=()=>{},onResult=()=>{}})=>{
 const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const panel=node('details');panel.id='asset-conversion';panel.className='dev-details';panel.append(node('summary','GANG / WBNB 换回 BNB'));
 const select=node('select');select.id='conversion-asset';select.setAttribute('aria-label','兑换资产');for(const value of['GANG','WBNB']){const option=node('option',value+' → BNB');option.value=value;select.append(option);}
 const available=node('p','展开后读取余额');available.className='field-help';const amount=node('input');amount.id='conversion-amount';amount.type='text';amount.inputMode='decimal';amount.placeholder='兑换数量';amount.setAttribute('aria-label','兑换数量');
 const max=node('button','填入全部'),refresh=node('button','刷新余额'),submit=node('button','换回 BNB');for(const b of[max,refresh,submit]){b.type='button';b.className='button subtle compact';}submit.id='conversion-submit';submit.className='button primary full';
 const slipLabel=node('label','聚合滑点（bps）'),slip=node('input');slip.id='conversion-slippage';slip.type='number';slip.min='10';slip.max='5000';slip.value='50';slip.setAttribute('aria-label','兑换滑点');slipLabel.append(slip);
 const help=node('p'),status=node('p');help.className=status.className='field-help';status.id='conversion-status';status.setAttribute('role','status');panel.append(select,available,amount,max,refresh,slipLabel,help,status,submit);document.querySelector('.balance-row')?.after(panel);
 let owner=null,epoch=0,busy=false,assets=[],disabledNotice=false;
 const source=()=>[...select.children].find(o=>o.selected)?.value||'GANG';
 function render(){const c=getContext(),asset=source(),row=assets.find(a=>a.asset===asset);available.textContent=row?`可用 ${row.balance} ${asset}`:'展开或刷新后读取余额';slipLabel.hidden=asset==='WBNB';help.textContent=asset==='WBNB'?'WBNB 按 1:1 解包为 BNB，无需兑换授权；Gas 另付 BNB。':'GANG 通过币安聚合兑换为原生 BNB，使用所设滑点；Gas 另付 BNB。';submit.textContent=asset==='WBNB'?'将 WBNB 解包为 BNB':'将 GANG 换回 BNB';for(const e of[select,amount,slip,max,refresh])e.disabled=busy||!owner;submit.disabled=busy||getBusy()||!owner||!c.live||c.blocked===true;if(!busy){const reason=!owner?'请先连接钱包。':!c.live?'请先开启真实交易，再使用兑换按钮。':c.blocked===true?'存在待核对的订单，请先核对分步路线；完成后兑换按钮会自动恢复。':null;if(reason){status.textContent=reason;disabledNotice=true;}else if(disabledNotice){status.textContent='已就绪，可以兑换。';disabledNotice=false;}}}
 async function load(){if(busy||!owner)return;const e=epoch;busy=true;render();try{const r=await api('/api/conversion/balances?refresh=1');if(e===epoch)assets=r.assets||[];}catch(error){if(e===epoch)status.textContent=error.message;}finally{if(e===epoch){busy=false;render();}}}
 select.addEventListener('change',()=>{amount.value='';render();});max.addEventListener('click',()=>{amount.value=assets.find(a=>a.asset===source())?.balance||'';});refresh.addEventListener('click',load);panel.addEventListener('toggle',()=>{if(panel.open)void load();});
 submit.addEventListener('click',async()=>{
  if(submit.disabled)return;const value=amount.value.trim(),bps=Number(slip.value),c=getContext();if(!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value)||value.length>80||!/[1-9]/.test(value)||!Number.isInteger(bps)||bps<10||bps>5000){status.textContent='请填写有效数量与滑点';return;}
  const e=epoch,intentId=crypto.randomUUID();busy=true;onBusy(true);render();status.textContent='正在报价并提交兑换…';
  try{const r=await api('/api/conversion',{asset:source(),amount:value,slippageBps:bps,intentId,expectedWallet:c.address});if(e!==epoch)return;if(r.intentId!==intentId||r.walletAddress?.toLowerCase()!==c.address.toLowerCase())throw Error('兑换返回的意图或钱包不匹配');await onResult(r);status.textContent=r.order?.error||r.order?.message||'兑换已提交，实际到账请查看交易明细与回执。';amount.value='';}
  catch(error){if(e===epoch)status.textContent=error.message;}
  finally{if(e===epoch){busy=false;onBusy(false);render();}}
 });
 return{update(){const next=getContext().address?.toLowerCase()||null;if(next!==owner){epoch++;owner=next;busy=false;assets=[];amount.value='';status.textContent='';if(panel.open)void load();}render();},clear(){epoch++;owner=null;busy=false;assets=[];amount.value='';status.textContent='';render();}};
};
