'use strict';

window.createFairProgress=({before,getPosition=()=>({}),onRefresh=async()=>{},api,copy})=>{
  const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);return el;};
  const field=(id,tag='span',cls='')=>{const el=node(tag,cls);el.id=id;return el;};
  const panel=field('fair-progress-panel','section','panel fair-progress-panel');panel.hidden=true;panel.setAttribute('aria-label','Fair 打新认购进度');
  const heading=node('div','fair-heading'),headingText=node('div');headingText.append(node('span','eyebrow','FAIR LAUNCH'),node('h2','','打新进度'));
  const status=field('fair-status','span','badge yellow'),refresh=field('fair-refresh','button','button subtle compact');refresh.type='button';refresh.textContent='刷新进度';
  heading.append(headingText,status,refresh);
  const hero=node('div','fair-hero'),percent=field('fair-progress-percent','strong'),counts=field('fair-progress-counts','p');hero.append(percent,counts);
  const progress=field('fair-progress-bar','progress');progress.setAttribute('aria-label','Fair 有效认购进度');
  const grid=node('dl','fair-facts'),facts={};
  for(const[key,label]of Object.entries({remaining:'剩余份额',price:'每份价格',allocation:'每份分配',cap:'单钱包上限',raised:'有效认购本金',target:'目标本金',mintFee:'认购手续费',exitFee:'退出手续费'})){
    facts[key]=node('dd','','—');grid.append(node('dt','',label),facts[key]);
  }
  const mine=node('section','fair-mine');mine.append(node('h3','','我的认购'));
  const myStatus=field('fair-my-status','p','quiet'),myShares=field('fair-my-shares','strong'),myPrincipal=field('fair-my-principal','strong'),myAllocation=field('fair-my-allocation','strong');
  const myGrid=node('div','fair-my-grid');for(const[label,el]of [['当前认购',myShares],['对应本金',myPrincipal],['对应代币',myAllocation]]){const box=node('div');box.append(node('span','quiet',label),el);myGrid.append(box);}mine.append(myStatus,myGrid);
  const dataStatus=field('fair-data-status','p','fair-data-status'),note=node('p','fair-note','进度按当前有效认购份数计算，退出会减少进度。本金不含手续费；打满后以链上发射状态为准。');
  panel.append(heading,hero,progress,grid,mine,note,dataStatus);before.before(panel);
  const participants=window.createFairParticipantsView?.({before:note,api,copy});
  let token=null,refreshing=false;
  const matches=t=>t?.platformId==='gang'&&t.pad==='merged'&&t.launchType==='fair'&&['bonding','launching'].includes(t.phase);
  const uint=v=>{if(typeof v!=='string'||!/^\d{1,78}$/.test(v))throw Error('Invalid integer');return BigInt(v);};
  const units=(value,decimals)=>{if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value)||value.length>80)throw Error('Invalid amount');const[w,f='']=value.split('.');if(f.length>decimals)throw Error('Invalid precision');return BigInt(w+f.padEnd(decimals,'0'));};
  const amount=value=>String(value).replace(/\.0+$/,'').replace(/(\.\d*?[1-9])0+$/,'$1');
  const integer=value=>BigInt(value).toLocaleString('en-US');
  function verifiedSale(t){
    const s=t.fairSale;if(s?.verified!==true||t.quoteDecimals!==18)return null;
    try{
      const sold=uint(s.soldShares),total=uint(s.totalShares),remaining=uint(s.remainingShares),price=uint(s.sharePriceRaw),cap=uint(s.walletCapShares);
      if(total!==10000n||sold>total||remaining!==total-sold||price<=0n||cap<=0n||cap>total||units(s.tokensPerShare,18)!==50000n*10n**18n||units(s.sharePrice,18)!==price||units(s.subscribedPrincipal,18)!==price*sold||units(s.targetPrincipal,18)!==price*total||!['mintFeeBps','exitFeeBps'].every(k=>Number.isInteger(s[k])&&s[k]>=0&&s[k]<=10000)||!s.demo&&(!Number.isSafeInteger(s.sourceBlock)||s.sourceBlock<=0))return null;
      return {s,sold,total,remaining,price,cap};
    }catch{return null;}
  }
  function renderPersonal(t,valid){
    myShares.textContent=myPrincipal.textContent=myAllocation.textContent='—';
    const c=getPosition()||{},wallet=c.wallet;
    if(!wallet?.address||wallet.available!==true||wallet.status!=='CONNECTED'){myStatus.textContent='连接钱包后查看自己的认购';return;}
    if(c.positionBusy){myStatus.textContent='正在读取当前钱包认购…';myShares.textContent='读取中';return;}
    const p=c.position;
    if(c.walletError||c.positionError){myStatus.textContent='认购读取失败，暂不可用；可点击刷新重试';return;}
    const updated=Date.parse(p?.updatedAt);
    if(p&&(!Number.isFinite(updated)||Date.now()-updated>90000||updated>Date.now()+5000)){myStatus.textContent='我的认购数据已过期或延迟，请刷新后查看';return;}
    try{
      if(!valid||p?.address?.toLowerCase()!==wallet.address.toLowerCase()||p?.token?.toLowerCase()!==t.address.toLowerCase()||p.quoteSymbol!==t.quoteSymbol)throw Error('Mismatch');
      const shares=uint(p.fairShares),principal=uint(p.fairPrincipalRaw);
      if(shares>10000n||principal!==shares*valid.price||units(p.fairPrincipal,18)!==principal)throw Error('Invalid principal');
      myShares.textContent=`${integer(shares)} 份`;myPrincipal.textContent=`${amount(p.fairPrincipal)} ${t.quoteSymbol}`;myAllocation.textContent=`${integer(shares*50000n)} ${t.symbol||'代币'}`;
      myStatus.textContent=`当前有效认购 · 更新 ${new Date(updated).toLocaleTimeString('zh-CN',{hour12:false})} · 本金不含手续费，不代表历史累计投入${p.sourceBlock?` · 区块 ${p.sourceBlock}`:''}`;
    }catch{myStatus.textContent='当前钱包认购待核验，暂不可用';myShares.textContent='待核验';}
  }
  function render(value){
    token=value;panel.hidden=!matches(token);if(panel.hidden){participants?.close();return;}
    participants?.open(token);
    const v=verifiedSale(token),q=token.quoteSymbol||'未知底币';
    for(const el of Object.values(facts))el.textContent='—';
    percent.textContent='—';counts.textContent='等待链上有效认购数据';progress.hidden=!v;
    status.textContent=v?v.sold===v.total?'已满额，等待发射':token.phase==='launching'?'等待发射':'认购进行中':'打新数据待核验';
    if(v){
      percent.textContent=`${(Number(v.sold*10000n/v.total)/100).toFixed(2).replace(/\.00$/,'')}%`;
      counts.textContent=`已认购 ${integer(v.sold)} / ${integer(v.total)} 份`;progress.max=Number(v.total);progress.value=Number(v.sold);
      facts.remaining.textContent=`${integer(v.remaining)} 份`;facts.price.textContent=`${amount(v.s.sharePrice)} ${q}`;facts.allocation.textContent=`${integer(50000)} ${token.symbol||'代币'}`;facts.cap.textContent=`${integer(v.cap)} 份`;
      facts.raised.textContent=`${amount(v.s.subscribedPrincipal)} ${q}`;facts.target.textContent=`${amount(v.s.targetPrincipal)} ${q}`;facts.mintFee.textContent=`${v.s.mintFeeBps/100}%`;facts.exitFee.textContent=`${v.s.exitFeeBps/100}%`;
    }
    const updated=Date.parse(token.sourceUpdatedAt||token.fairSale?.updatedAt),stale=token.sourceUnavailable||!Number.isFinite(updated)||Date.now()-updated>90000;
    dataStatus.textContent=token.fairSale?.demo?'DEMO · 独立演示认购数据，无真实交易':`${stale?'数据延迟 · 保留上次核验':'链上核验'}${v?` · 区块 ${v.s.sourceBlock}`:''}${Number.isFinite(updated)?` · 更新 ${new Date(updated).toLocaleTimeString('zh-CN',{hour12:false})}`:''}`;
    dataStatus.classList.toggle('caution',Boolean(stale));renderPersonal(token,v);
  }
  refresh.addEventListener('click',async()=>{if(refreshing)return;refreshing=true;refresh.disabled=true;try{await onRefresh();await participants?.refresh();}catch{if(token)dataStatus.textContent='刷新失败，当前保留上次数据';}finally{refreshing=false;refresh.disabled=false;}});
  return {matches,render,hide(){token=null;panel.hidden=true;participants?.close();},updatePosition(){if(token&&!panel.hidden)renderPersonal(token,verifiedSale(token));}};
};
