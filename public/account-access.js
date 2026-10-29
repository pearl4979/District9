'use strict';

window.createAccountAccess = ({api,onSessionChange=()=>{}}) => {
  const $=id=>document.getElementById(id);
  let session=null,busy=false,loggingOut=false,challenge=null,pairing=null,timer=null,controller=null,epoch=0,previousFocus=null;
  const hosted=()=>session?.capabilities?.hosted===true;
  const short=address=>`${address.slice(0,6)}…${address.slice(-4)}`;
  function stop(){epoch++;clearTimeout(timer);timer=null;controller?.abort();controller=null;challenge=null;pairing=null;busy=false;}
  function error(message){$('account-error').textContent=message;$('account-error').hidden=!message;}
  function render(){
    const account=session?.account,verified=Boolean(account?.walletAddress);
    $('account-open').hidden=!hosted();$('account-open').textContent=verified?short(account.walletAddress):account?'绑定钱包':'钱包登录';
    $('account-form').hidden=verified||Boolean(pairing);$('account-submit').disabled=busy;$('account-submit').textContent=busy?'正在准备配对…':account?'验证并绑定 Binance 钱包':'使用 Binance 钱包登录';
    $('account-pairing').hidden=!pairing;$('account-identity').hidden=!account;$('account-logout').hidden=!account;$('account-logout').disabled=busy;
    $('account-identity').textContent=verified?`已验证钱包 · ${account.walletAddress}\n交易连接状态以 Agent 钱包面板为准；失效时需重新连接。`:account?'旧账号记录已保留。完成本次钱包验证后，将这些记录绑定到你的钱包。':'';
    $('account-open').setAttribute('aria-expanded',String(!$('account-modal').hidden));
    if(pairing){
      $('account-wallet-status').textContent=pairing.status==='WAITING_APP'?'请打开 Binance 官方页面，核对配对码并在 App 确认。':'正在准备安全配对…';
      let link;try{const u=new URL(pairing.urlForWeb);if(u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&(u.hostname==='binance.com'||u.hostname.endsWith('.binance.com')))link=u.href;}catch{}
      $('account-wallet-link').hidden=!link;if(link)$('account-wallet-link').href=link;else $('account-wallet-link').removeAttribute('href');
      const code=typeof pairing.pairingCode==='string'&&/^[A-Za-z0-9-]{1,32}$/.test(pairing.pairingCode)?pairing.pairingCode:'';
      $('account-wallet-code').hidden=!code;$('account-wallet-code').textContent=code?`配对码 · ${code}`:'';
      $('account-wallet-expiry').textContent=pairing.expireAt?`本次登录最迟于 ${new Date(Number(pairing.expireAt)).toLocaleTimeString('zh-CN',{hour12:false})} 过期`:'';
    }else {['account-wallet-status','account-wallet-code','account-wallet-expiry'].forEach(id=>$(id).textContent='');$('account-wallet-link').removeAttribute('href');}
  }
  async function cancel({close=false,unloading=false}={}){
    const pending=busy||Boolean(challenge)||Boolean(pairing),oldChallenge=challenge;stop();render();
    if(close){$('account-modal').hidden=true;render();previousFocus?.focus?.();}
    if(pending&&hosted())try{await api('/api/account/wallet/cancel',oldChallenge?{challenge:oldChallenge}:{},{keepalive:unloading});}catch(e){if(!close&&!unloading)error(`取消状态暂未确认：${e.message}。本次登录将在五分钟内过期。`);}
  }
  function publish(next){if(!next?.account?.walletAddress||typeof next.csrf!=='string'||next.capabilities?.hosted!==true)throw new Error('钱包会话未刷新，请重新登录。');stop();session=next;$('account-modal').hidden=true;error('');render();onSessionChange(next);}
  async function poll(expected){
    if(expected!==epoch||!challenge)return;
    if(Number(pairing?.expireAt)<=Date.now()){await cancel();error('本次登录已过期，请重新发起。');return;}
    controller=new AbortController();
    try{
      const next=await api('/api/account/wallet/status',{challenge},{signal:controller.signal});if(expected!==epoch)return;
      if(next.account){publish(next);return;}
      if(['ERROR','EXPIRED','CANCELLED'].includes(next.status)){await cancel();error(next.message||'钱包配对未完成，请重新登录。');return;}
      pairing={...pairing,...next};render();timer=setTimeout(()=>poll(expected),1500);
    }catch(e){if(expected!==epoch)return;await cancel();error(e.message||'钱包验证暂时不可用，请重新登录。');}
  }
  async function start(){
    if(!hosted()||busy||challenge||session?.account?.walletAddress)return;
    const expected=++epoch;busy=true;error('');controller=new AbortController();render();
    try{
      const result=await api('/api/account/wallet/start',{}, {signal:controller.signal});if(expected!==epoch)return;
      if(!/^[a-f0-9]{64}$/.test(result.challenge??''))throw new Error('登录挑战无效，请重新发起。');
      challenge=result.challenge;pairing=result;busy=false;render();timer=setTimeout(()=>poll(expected),1000);
    }catch(e){if(expected!==epoch)return;await cancel();error(e.message||'无法开始钱包登录。');}
  }
  function open(){if(!hosted())return;previousFocus=document.activeElement;$('account-modal').hidden=false;error('');render();(session?.account?.walletAddress?$('account-logout'):$('account-submit')).focus();}
  $('account-form').addEventListener('submit',event=>{event.preventDefault();void start();});
  $('account-open').addEventListener('click',open);$('account-close').addEventListener('click',()=>{void cancel({close:true});});
  $('account-wallet-cancel').addEventListener('click',()=>{void cancel();});
  $('account-modal').addEventListener('click',event=>{if(event.target===$('account-modal'))void cancel({close:true});});
  $('account-logout').addEventListener('click',async()=>{
    if(busy||loggingOut||!session?.account)return;loggingOut=true;await cancel();busy=true;render();
    try{const next=await api('/api/account/logout',{});if(typeof next?.csrf!=='string'||next.account!==null)throw new Error('退出会话未刷新');session=next;$('account-modal').hidden=true;render();onSessionChange(next);}catch(e){error(e.message);}finally{busy=false;loggingOut=false;render();}
  });
  document.addEventListener('keydown',event=>{
    if($('account-modal').hidden)return;
    if(event.key==='Escape'){event.preventDefault();void cancel({close:true});}
    if(event.key==='Tab'){const items=[...$('account-modal').querySelectorAll('button,a[href],input')].filter(el=>!el.disabled&&!el.hidden&&!el.closest('[hidden]')),index=items.indexOf(document.activeElement);if(event.shiftKey&&index<=0){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&(index===items.length-1||index<0)){event.preventDefault();items[0]?.focus();}}
  });
  window.addEventListener('pagehide',()=>{void cancel({unloading:true});});
  render();
  return {setSession(next){if(session?.account?.id!==next?.account?.id)stop();session=next;render();},open,requireAccount(){if(!hosted()||session?.account)return true;open();return false;}};
};
