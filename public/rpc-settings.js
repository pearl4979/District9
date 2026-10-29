'use strict';
window.createRpcSettingsView=({api,getOwner,getBusy=()=>false,onSwitch=()=>{}})=>{
 const node=(tag,text)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
 const panel=node('details');panel.id='rpc-settings';panel.className='dev-details';
 const title=node('summary','RPC 节点 · 默认'),status=node('p','使用现有平台节点');status.className='field-help';status.id='rpc-settings-status';status.setAttribute('role','status');
 const mode=node('select');mode.id='rpc-mode';mode.setAttribute('aria-label','RPC 节点来源');for(const[value,text]of[['default','平台默认 RPC'],['custom','使用自己的 RPC']]){const option=node('option',text);option.value=value;mode.append(option);}
 const fields=node('div');fields.hidden=true;
 const input=(id,label,placeholder)=>{const wrap=node('label',label),element=node('input');element.id=id;element.type='password';element.autocomplete='off';element.spellcheck=false;element.placeholder=placeholder;element.style.width='100%';element.setAttribute('aria-label',label);wrap.append(element);fields.append(wrap);return element;};
 const http=input('rpc-http-url','HTTPS RPC','https://…（完整地址仅保存在后端）'),ws=input('rpc-ws-url','WebSocket（选填）','wss://…（加速回执观察）');
 const help=node('p','个人 RPC 用于余额、报价、模拟及回执；公共行情继续共享。保存时核验 BSC 主网，不增加每笔交易的检查。留空 WebSocket 会保留原有回执轮询。');help.className='field-help';
 const test=node('button','测试连接'),save=node('button','保存并使用'),refresh=node('button','刷新设置');
 for(const button of[test,save,refresh]){button.type='button';button.className='button subtle compact';}
 test.id='rpc-test';save.id='rpc-save';refresh.id='rpc-refresh';panel.append(title,status,mode,fields,help,test,save,refresh);document.querySelector('.wallet-content')?.append(panel);
 let owner=null,epoch=0,busy=false,current={mode:'default'};
 const choose=value=>{for(const option of mode.children)option.selected=option.value===value;};
 const selected=()=>[...mode.children].find(option=>option.selected)?.value||'default';
 function render(){const custom=selected()==='custom';fields.hidden=!custom;for(const button of[test,save,refresh])button.disabled=busy||!owner||getBusy();test.disabled||=!custom||!http.value.trim();save.disabled||=custom&&!http.value.trim();mode.disabled=busy||!owner;http.disabled=ws.disabled=busy||!owner;}
 const clearSecrets=()=>{http.value='';ws.value='';};
 function show(value){current=value;choose(value.mode==='custom'?'custom':'default');title.textContent=`RPC 节点 · ${value.mode==='custom'?'个人':value.mode==='unavailable'?'待读取':'默认'}`;status.textContent=value.message||(value.mode==='custom'?`已使用 ${value.host||'个人节点'}${Number.isFinite(value.latencyMs)?` · 测试 ${value.latencyMs}ms`:''}${value.webSocket==='connected'?' · WSS 已连接':value.webSocket==='unavailable'?' · WSS 已断开，回执轮询继续':''}`:'使用现有平台节点；交易流程保持原样');render();}
 async function load(){if(busy||!owner)return;const version=epoch;busy=true;render();try{const value=await api('/api/settings/rpc?refresh=1');if(version===epoch){clearSecrets();show(value);}}catch(error){if(version===epoch)status.textContent=error.message;}finally{if(version===epoch){busy=false;render();}}}
 async function act(testOnly){if(busy||!owner||getBusy())return;const version=epoch,custom=selected()==='custom';const body=custom?{mode:'custom',httpUrl:http.value.trim(),...(ws.value.trim()?{wsUrl:ws.value.trim()}:{})}:{mode:'default'};busy=true;render();status.textContent=testOnly?'正在测试连接…':'正在保存…';
  try{const value=await api(testOnly?'/api/settings/rpc/test':'/api/settings/rpc',body);if(version!==epoch)return;if(testOnly)status.textContent=`BSC 主网 · 区块 ${value.blockNumber} · 测试 ${value.latencyMs}ms${value.webSocket==='connected'?' · WSS 已连接':''}；尚未切换`;
   else{clearSecrets();show(value);onSwitch();}}
  catch(error){if(version===epoch){clearSecrets();status.textContent=error.message;}}
  finally{if(version===epoch){busy=false;render();}}
 }
 mode.addEventListener('change',render);for(const element of[http,ws])element.addEventListener('input',render);
 test.addEventListener('click',()=>act(true));save.addEventListener('click',()=>act(false));refresh.addEventListener('click',load);
 panel.addEventListener('toggle',()=>{if(panel.open)void load();else clearSecrets();});
 return{update(){const next=getOwner()||null;if(next!==owner){epoch++;owner=next;busy=false;clearSecrets();show({mode:'default',message:owner?'展开后读取当前 RPC 设置':'登录后可设置自己的 RPC'});if(panel.open)void load();}render();},clear(){epoch++;owner=null;busy=false;clearSecrets();show({mode:'default',message:'登录后可设置自己的 RPC'});}};
};
