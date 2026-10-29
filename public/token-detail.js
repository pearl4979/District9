'use strict';

window.gangLaunchTypeLabel = value => {
  if(value?.platformId!=='gang')return null;
  const known={'curve-v3':'V3 曲线',fair:'Fair 打新','legacy-v2':'旧版 V2','legacy-u':'旧版 U','legacy-s':'旧版 S'};
  return known[value.launchType]||({v2:'旧版 V2',u:'旧版 U',s:'旧版 S',soft:'Soft 存量'}[value.pad])||null;
};

// 图表观察与资金执行分别处理，切币/周期/返回都会废弃旧行情请求。
window.createTokenDetail = ({ api, avatar, copy, canClose, onBack, onTrade, onSelect, getPosition, onRefresh }) => {
  const $ = id => document.getElementById(id);
  const sourceBadge=document.createElement('span');sourceBadge.id='detail-source-trust';sourceBadge.className='token-launch-type';sourceBadge.hidden=true;
  sourceBadge.title='仅表示已核验的平台归属；交易风险数据未知时仍会拦截下单。';$('detail-launch-type').after(sourceBadge);
  let token = null, interval = '1min', mode='marketcap', currency='BNB', fitTarget=true, version = 0, pending = null, timer = null, latest = null;
  let viewEpoch=0,historyPending=null,historyBusy=false,loadedBars=[],currentSeriesKey=null,pagination=null,hasHistory=false,historyRecovery=false,transitionMessage='',historyMessage='',timeMode='activity';
  const intervals={'1s':1000,'5s':5000,'15s':15000,'1min':60000,'5min':300000,'15min':900000,'1h':3600000,'4h':14400000,'1d':86400000};
  const format = value => {
    if(!Number.isFinite(value))return '—';if(value===0)return '0';
    if(mode==='marketcap'&&value>=1000){for(const [n,s]of [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']])if(value>=n)return `${(value/n).toFixed(2)}${s}`;}
    if(value<.0001){const [zeros,digits]=value.toFixed(24).slice(2).match(/^(0*)(\d+)/)?.slice(1)||[];if(zeros&&digits)return `0.0${String(zeros.length).replace(/\d/g,d=>'₀₁₂₃₄₅₆₇₈₉'[d])}${digits.slice(0,5)}`;}
    return Number(value.toPrecision(7)).toLocaleString('en-US',{maximumFractionDigits:9});
  };
  const date = value => value ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)) : '—';
  const insights = window.createTokenInsights({api,onSelect});
  let tracking=window.walletTracker?.snapshot?.()||{wallets:[],events:[],preferences:{showAvatars:true}},layout=null,markerSignature='',pendingFocus=null,preferenceSaving=false,selectedGroup=null,detailsSignature='';
  const chartPanel=$('candle-canvas').closest('.chart-panel'),markerLayer=document.createElement('div'),markerDetails=document.createElement('div'),markerStatus=document.createElement('p'),markerHover=document.createElement('div');
  const fairProgress=window.createFairProgress?.({before:chartPanel,getPosition,onRefresh,api,copy});
  const isFair=()=>fairProgress?.matches(token)===true;
  let hoverAnchor=null;
  markerLayer.id='wallet-chart-markers';markerLayer.className='wallet-chart-markers';markerLayer.setAttribute('aria-label','关注钱包成交标记');
  $('candle-canvas').parentElement.append(markerLayer);
  markerDetails.id='wallet-marker-details';markerDetails.className='wallet-marker-details';markerDetails.hidden=true;markerDetails.setAttribute('aria-label','钱包信号明细');
  markerStatus.id='wallet-marker-status';markerStatus.className='wallet-marker-status';markerStatus.hidden=true;markerStatus.setAttribute('role','status');
  chartPanel.append(markerDetails,markerStatus);
  markerHover.id='wallet-marker-hover';markerHover.className='wallet-marker-hover';markerHover.hidden=true;markerHover.setAttribute('role','tooltip');document.body.append(markerHover);
  const avatarLabel=document.createElement('label'),avatarToggle=document.createElement('input');
  avatarLabel.className='chart-wallet-toggle';avatarToggle.id='chart-wallet-avatars';avatarToggle.type='checkbox';avatarToggle.checked=tracking.preferences?.showAvatars!==false;
  avatarLabel.append(avatarToggle,document.createTextNode('钱包头像'));chartPanel.querySelector('.chart-tools').prepend(avatarLabel);
  const eventTime=value=>{const n=typeof value==='number'?value:typeof value==='string'&&/^\d+(\.\d+)?$/.test(value)?Number(value):Date.parse(value);return Number.isFinite(n)?n<1e11?n*1000:n:NaN;};
  const walletFor=address=>(tracking.wallets||[]).find(wallet=>wallet.address?.toLowerCase()===address?.toLowerCase());
  const eventSide=side=>({buy:'买入',sell:'卖出','transfer-in':'转入','transfer-out':'转出',transfer_in:'转入',transfer_out:'转出',transfer:'转账'}[side]||'转账');
  function markerMessage(message=''){markerStatus.textContent=message;markerStatus.hidden=!message;}
  function hideMarkerHover(){hoverAnchor?.removeAttribute('aria-describedby');hoverAnchor=null;markerHover.hidden=true;markerHover.replaceChildren();}
  function hideMarkerDetails(){selectedGroup=null;detailsSignature='';markerDetails.hidden=true;markerDetails.replaceChildren();}
  function clearMarkers({keepDetails=false}={}){hideMarkerHover();layout=null;markerSignature='';markerLayer.replaceChildren();$('chart-graduation-event').hidden=true;if(!keepDetails)hideMarkerDetails();}
  function safeX(value){try{const u=new URL(value);if(u.protocol==='https:'&&u.hostname==='x.com'&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/[A-Za-z0-9_]{1,15}\/?$/.test(u.pathname))return `https://x.com/${u.pathname.split('/')[1]}`;}catch{}return null;}
  function addLink(parent,label,href){const link=document.createElement('a');link.textContent=label;link.href=href;link.target='_blank';link.rel='noopener noreferrer';parent.append(link);}
  function showMarkerDetails(group){
    selectedGroup={walletAddress:group.wallet.address,ids:group.events.map(event=>event.id)};refreshMarkerDetails();
  }
  function markerDate(value){
    const timestamp=eventTime(value),parsed=new Date(timestamp+8*3600000);
    return Number.isFinite(timestamp)&&Number.isFinite(parsed.getTime())?`${parsed.toISOString().slice(0,19).replace('T',' ')} UTC+8`:'时间未知';
  }
  function markerValuation(event){
    // A market object is a latest snapshot, never a historical event valuation.
    const value=event.valuation,raw=typeof value?.value==='number'?String(value.value):value?.value;
    const bases={FDV:'FDV','circulating-market-cap':'流通市值','share-equivalent-FDV':'份额等值 FDV','execution-FDV':'成交价折算 FDV'};
    if(value?.kind!=='event-snapshot'||!Object.hasOwn(bases,value.basis)||value.blockNumber!==event.blockNumber||!Number.isSafeInteger(value.blockNumber)||eventTime(value.timestamp)!==eventTime(event.timestamp)||typeof raw!=='string'||!/^\d{1,90}(?:\.\d{1,90})?$/.test(raw)||!(Number(raw)>0)||!Number.isFinite(Number(raw))||typeof value.unit!=='string'||!value.unit.trim()||value.unit.length>32||typeof value.source!=='string'||!value.source.trim()||value.source.length>160)return '当时市值未知';
    return `当时市值（${bases[value.basis]}） ${raw} ${value.unit} · ${value.source}`;
  }
  function markerQuantities(event){
    const amount=event.tokenAmount===null||event.tokenAmount===undefined?'数量未知':`${event.tokenAmount} ${event.tokenSymbol||'TOKEN'}`,quote=event.quoteAmount===null||event.quoteAmount===undefined?'计价数量未知':`${event.quoteAmount} ${event.quoteSymbol||'计价币未知'}`;
    return `${amount} · ${/dex|池计价量/i.test(event.source||'')?'池计价量 ':''}${quote}`;
  }
  function showMarkerHover(groups,button,allWallets=false){
    const current=markerGroups(tracking.events||[],layout?.intervalMs||intervals[interval]).filter(group=>group.t===groups[0]?.t&&(allWallets||group.wallet.address.toLowerCase()===groups[0].wallet.address.toLowerCase()));
    if(!current.length){hideMarkerHover();return;}
    hideMarkerHover();hoverAnchor=button;button.setAttribute('aria-describedby',markerHover.id);markerHover.hidden=false;
    const heading=document.createElement('strong');heading.className='wallet-hover-heading';heading.textContent=allWallets?`${current.length} 个关注钱包`:current[0].wallet.note||`${current[0].wallet.address.slice(0,6)}…${current[0].wallet.address.slice(-4)}`;markerHover.append(heading);
    const rows=current.flatMap(group=>group.events.map(event=>({wallet:group.wallet,event}))),hint=document.createElement('p');hint.className='wallet-hover-hint';hint.textContent=`点击头像查看完整 ${rows.length} 笔 · 区块时间精度为秒`;markerHover.append(hint);
    const viewportWidth=Math.max(1,window.innerWidth||1024),viewportHeight=Math.max(1,window.innerHeight||768),limit=viewportHeight<380?1:3;
    for(const {wallet,event}of rows.slice(0,limit)){
      const row=document.createElement('div');row.className=`wallet-hover-event ${event.side==='buy'||event.side==='sell'?event.side:'transfer'}`;
      const side=document.createElement('strong');side.textContent=`${event.demo?'演示 · ':''}${allWallets?`${wallet.note||wallet.address} · `:''}${eventSide(event.side)}`;row.append(side);
      for(const text of [markerValuation(event),markerQuantities(event),`区块时间 ${markerDate(event.timestamp)}`]){const line=document.createElement('p');line.textContent=text;row.append(line);}markerHover.append(row);
    }
    if(rows.length>limit){const more=document.createElement('p');more.className='wallet-hover-hint';more.textContent=`另有 ${rows.length-limit} 笔，点击查看全部`;markerHover.append(more);}
    const width=Math.min(300,Math.max(1,viewportWidth-16));markerHover.style.width=`${width}px`;markerHover.style.maxHeight=`${Math.max(1,viewportHeight-16)}px`;
    const anchor=button.getBoundingClientRect?.()||{left:8,right:8,top:8,bottom:8},box=markerHover.getBoundingClientRect?.(),height=Math.min(box?.height||220,Math.max(1,viewportHeight-16));
    const preferred=(anchor.right||anchor.left||0)+10,left=preferred+width<=viewportWidth-8?preferred:(anchor.left||0)-width-10;
    markerHover.style.left=`${Math.max(8,Math.min(Math.max(8,viewportWidth-width-8),left))}px`;markerHover.style.top=`${Math.max(8,Math.min(Math.max(8,viewportHeight-height-8),anchor.top||8))}px`;
  }
  function bindMarkerInteractions(button,groups,allWallets=false){
    const bound=Boolean(button._district9Marker);button._district9Marker={groups,allWallets};if(bound)return;
    const show=()=>{const current=button._district9Marker;showMarkerHover(current.groups,button,current.allWallets);};
    button.addEventListener('pointerenter',show);button.addEventListener('pointerleave',hideMarkerHover);
    button.addEventListener('focus',show);button.addEventListener('blur',hideMarkerHover);
    button.addEventListener('click',()=>{const current=button._district9Marker;current.allWallets?showBucketMarkerDetails(current.groups):showMarkerDetails(current.groups[0]);});
  }
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hideMarkerHover();});window.addEventListener('resize',hideMarkerHover);window.addEventListener('scroll',hideMarkerHover,true);
  function compareMarkerEvents(a,b){
    const time=eventTime(a.timestamp)-eventTime(b.timestamp);if(time)return time;
    for(const field of ['transactionIndex','logIndex']){
      const index=value=>typeof value==='number'&&Number.isInteger(value)&&value>=0?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):Infinity;
      const left=index(a[field]),right=index(b[field]);if(left!==right)return left<right?-1:1;
    }
    return String(a.id||'').localeCompare(String(b.id||''))||String(a.walletAddress||'').toLowerCase().localeCompare(String(b.walletAddress||'').toLowerCase());
  }
  function markerGroups(events,intervalMs,buckets=null){
    const groups=new Map();
    for(const event of events){
      if(event.tokenAddress?.toLowerCase()!==token?.address.toLowerCase()||!(event.confirmed===true||event.demo===true))continue;
      const timestamp=eventTime(event.timestamp),t=Math.floor(timestamp/intervalMs)*intervalMs,wallet=walletFor(event.walletAddress);
      if(!Number.isFinite(timestamp)||!wallet||(buckets&&!buckets.has(t)))continue;
      const key=`${t}:${wallet.address.toLowerCase()}`;
      if(!groups.has(key))groups.set(key,{key,t,bucket:buckets?.get(t),wallet,events:[]});groups.get(key).events.push(event);
    }
    for(const group of groups.values()){group.events.sort(compareMarkerEvents);group.firstPurchase=group.events.find(event=>event.side==='buy')||group.events[0];}
    return [...groups.values()].sort((a,b)=>a.t-b.t||compareMarkerEvents(a.firstPurchase,b.firstPurchase)||a.wallet.address.toLowerCase().localeCompare(b.wallet.address.toLowerCase()));
  }
  function showBucketMarkerDetails(groups){
    selectedGroup={allWallets:true,ids:groups.flatMap(group=>group.events.map(event=>event.id))};refreshMarkerDetails();
  }
  function refreshMarkerDetails(){
    if(!selectedGroup)return;
    const events=(tracking.events||[]).filter(event=>token&&event.tokenAddress?.toLowerCase()===token.address.toLowerCase()&&(selectedGroup.allWallets||event.walletAddress?.toLowerCase()===selectedGroup.walletAddress?.toLowerCase())&&(event.confirmed===true||event.demo===true)),seed=events.find(event=>selectedGroup.ids.includes(event.id));
    if(!seed){hideMarkerDetails();return;}
    const intervalMs=layout?.intervalMs||intervals[interval],t=Math.floor(eventTime(seed.timestamp)/intervalMs)*intervalMs,groups=markerGroups(events,intervalMs).filter(group=>group.t===t);
    if(!groups.length){hideMarkerDetails();return;}
    selectedGroup.ids=groups.flatMap(group=>group.events.map(event=>event.id));
    const signature=JSON.stringify([selectedGroup.allWallets,groups.map(group=>[group.wallet.address,group.wallet.note,group.wallet.xUrl,group.wallet.social,group.events.map(event=>[event.id,event.side,event.timestamp,event.transactionIndex,event.logIndex,event.tokenAmount,event.tokenSymbol,event.quoteAmount,event.quoteSymbol,event.platformId,event.price,event.priceUnit,event.valuation,event.source,event.demo,event.txHash])])]);
    if(signature===detailsSignature&&!markerDetails.hidden)return;detailsSignature=signature;
    markerDetails.replaceChildren();markerDetails.hidden=false;
    const heading=document.createElement('div');heading.className='wallet-marker-heading';
    const name=document.createElement('strong');name.textContent=selectedGroup.allWallets?`${groups.length} 个关注钱包 · ${selectedGroup.ids.length} 条信号`:(groups[0].wallet.note||`${groups[0].wallet.address.slice(0,6)}…${groups[0].wallet.address.slice(-4)}`);
    const close=document.createElement('button');close.type='button';close.textContent='关闭';close.setAttribute('aria-label','关闭钱包信号明细');close.addEventListener('click',hideMarkerDetails);
    heading.append(name,close);markerDetails.append(heading);
    for(const group of groups){
    const identity=document.createElement('p');identity.textContent=selectedGroup.allWallets?`${group.wallet.note||group.wallet.address} · ${group.wallet.address}`:group.wallet.address;
    const binding=window.AgentWalletAvatar?.verified(group.wallet),x=safeX(binding?.xUrl||group.wallet.xUrl);if(x){identity.append(document.createTextNode(' · '));addLink(identity,binding?'X 主页 · 已绑定':'X 主页 · 手动关联',x);}markerDetails.append(identity);
    for(const event of group.events){
      const row=document.createElement('p'),amount=event.tokenAmount===null||event.tokenAmount===undefined?'数量未知':`${event.tokenAmount} ${event.tokenSymbol||''}`,quote=event.quoteAmount===null||event.quoteAmount===undefined?'计价数量未知':`${event.quoteAmount} ${event.quoteSymbol||''}`;
      const pool=/dex|池计价量/i.test(event.source||''),rawPrice=typeof event.price==='number'?String(event.price):typeof event.price==='string'?event.price.trim():'',hasPrice=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawPrice)&&Number.isFinite(Number(rawPrice))&&Number(rawPrice)>0&&typeof event.priceUnit==='string'&&event.priceUnit.trim(),price=hasPrice?`${pool?'池成交参考价':'事件成交价'} ${rawPrice} ${event.priceUnit}`:'成交价未知';
      row.textContent=`${event.demo?'演示 · ':''}${eventSide(event.side)} · ${markerDate(event.timestamp)} · ${amount} · ${pool?'池计价量 ':''}${quote} · ${price} · ${markerValuation(event)} · ${{four:'Four.meme',gang:'Gang',flap:'Flap'}[event.platformId]||event.platformId||'未知平台'} · 来源 ${event.source||'未知'} · 按时间桶定位`;
      if(!event.demo&&/^0x[a-fA-F0-9]{64}$/.test(event.txHash||'')){row.append(document.createTextNode(' · '));addLink(row,'交易凭证 ↗',`https://bscscan.com/tx/${event.txHash}`);}markerDetails.append(row);
    }
    }
  }
  function renderMarkers(){
    if(!token||$('token-detail').hidden||!avatarToggle.checked){hideMarkerHover();if(markerSignature||markerLayer.childElementCount){markerLayer.replaceChildren();markerSignature='';}hideMarkerDetails();return;}
    refreshMarkerDetails();
    if(!layout?.buckets?.length){hideMarkerHover();if(markerSignature||markerLayer.childElementCount){markerLayer.replaceChildren();markerSignature='';}return;}
    const buckets=new Map(layout.buckets.map(bucket=>[bucket.t,bucket])),intervalMs=layout.intervalMs;
    if(!(intervalMs>0))return;
    const sorted=markerGroups(tracking.events||[],intervalMs,buckets),size=Number((3.4*Math.max(5,Math.min(14,Number.isFinite(layout.barWidth)&&layout.barWidth>0?layout.barWidth:6))).toFixed(4));
    const signature=JSON.stringify([layout.width,layout.height,layout.barWidth,sorted.map(group=>[group.key,group.bucket,group.wallet.address,group.wallet.note,group.wallet.avatar,group.wallet.social,group.events.map(event=>[event.id,event.side,event.timestamp,event.transactionIndex,event.logIndex,event.tokenAmount,event.quoteAmount,event.quoteSymbol,event.valuation,event.source,event.demo])])]);
    if(signature===markerSignature)return;markerSignature=signature;
    // Keep connected nodes for surviving wallet/bucket pairs so live polling
    // cannot dismiss a stationary hover card or steal its keyboard focus.
    const existing=new Map([...markerLayer.children].map(button=>[`${button.dataset.bucket}:${button.dataset.wallet?.toLowerCase()||'overflow'}`,button])),used=new Set();
    const markerButton=(t,wallet)=>{const key=`${t}:${wallet?.toLowerCase()||'overflow'}`,button=existing.get(key)||document.createElement('button');used.add(button);if(button.parentElement!==markerLayer)markerLayer.append(button);return button;};
    const stacks=new Map();for(const group of sorted){if(!stacks.has(group.t))stacks.set(group.t,[]);stacks.get(group.t).push(group);}
    const plans=[...stacks.values()].map(groups=>{const bucket=groups[0].bucket,anchorY=Math.min(bucket.yTop,layout.plotHeight||layout.height),capacity=Math.max(0,Math.floor((anchorY-4-size-2)/(size+2))+1);return {groups,bucket,anchorY,count:Math.max(1,Math.min(groups.length,capacity)),compact:false};});
    const xs=plans.map(plan=>plan.bucket.x).sort((a,b)=>a-b),minSpacing=xs.slice(1).reduce((gap,x,index)=>x>xs[index]?Math.min(gap,x-xs[index]):gap,Infinity);
    let narrow=false;
    const positionStack=(plan,occupied)=>{
      const overflow=plan.compact||plan.count<plan.groups.length,visible=plan.compact?[]:overflow?plan.groups.slice(0,plan.count-1):plan.groups;
      const shapes=visible.map(group=>({group,x:plan.bucket.x,width:size,height:size}));
      if(overflow)shapes.push({x:plan.bucket.x,width:plan.compact?Math.min(14,narrow?minSpacing:Infinity):Math.max(14,size),height:plan.compact?8:Math.max(8,size)});
      const positions=[];
      // The earliest buyer is placed last while packing upward, keeping it
      // uppermost without shifting any avatar away from its real candle x.
      for(const shape of [...shapes].reverse()){
        let y=Math.max(plan.compact?shape.height+6:0,plan.anchorY)-4-shape.height/2;
        const obstacles=[...occupied,...positions];let clear=false;
        for(let attempt=0;attempt<=obstacles.length;attempt++){
          const hits=obstacles.filter(other=>Math.abs(shape.x-other.x)<(shape.width+other.width)/2&&Math.abs(y-other.y)<(shape.height+other.height)/2+2);
          if(!hits.length){clear=true;break;}
          // Clear the boundary by a subpixel amount. Decimal chart coordinates
          // can round an exact subtraction back inside the same obstacle.
          const next=Math.min(...hits.map(other=>other.y-(shape.height+other.height)/2-2))-.001;
          if(!(next<y))return null;y=next;
        }
        if(!clear||y<shape.height/2+2)return null;
        positions.push({...shape,y});
      }
      return {visible,overflow,positions:positions.reverse()};
    };
    // A collision can reduce usable space in a neighboring bucket. Retry with
    // fewer visible wallets, retaining every real event in that bucket's +N.
    const budget=plans.reduce((total,plan)=>total+plan.count+2,1);
    for(let pass=0;pass<budget;pass++){
      const occupied=[];let failed=-1;
      for(const [index,plan]of plans.entries()){
        const positioned=positionStack(plan,occupied);if(!positioned){failed=index;break;}
        plan.positioned=positioned;occupied.push(...positioned.positions);
      }
      if(failed<0)break;
      let reduce=plans[failed];
      if(reduce.count===1&&reduce.compact)reduce=plans.slice(0,failed).reverse().find(plan=>plan.count>1||!plan.compact);
      if(reduce){if(reduce.count>1)reduce.count--;else reduce.compact=true;}
      else {narrow=true;for(const plan of plans){plan.count=1;plan.compact=true;}}
    }
    for(const plan of plans){
      const {groups,bucket}=plan,{visible,overflow,positions}=plan.positioned;
      for(const [index,group]of visible.entries()){
      const latestTrade=group.events.filter(event=>event.side==='buy'||event.side==='sell').at(-1),side=latestTrade?.side||'transfer';
      const button=markerButton(group.t,group.wallet.address);button.type='button';button.className=`wallet-chart-marker ${side}`;button.dataset.wallet=group.wallet.address;button.dataset.bucket=String(group.t);button.dataset.count=String(group.events.length);button.style.left=`${bucket.x}px`;button.style.top=`${positions[index].y}px`;button.style.width=`${size}px`;button.style.height=`${size}px`;button.style.fontSize=`${Math.max(4,Math.floor(size*.55))}px`;
      const summary=`${group.wallet.note||group.wallet.address} · ${group.events.map(event=>eventSide(event.side)).join(' / ')} · ${group.events.length} 条 · ${date(group.t)}${group.events.some(event=>event.demo)?' · 演示':''}`;
      button.title=summary;button.setAttribute('aria-label',summary);button.setAttribute('aria-controls','wallet-marker-details');
      const avatarKey=JSON.stringify([group.wallet.address.toLowerCase(),group.wallet.avatar,group.wallet.social]);
      if(button._district9Avatar!==avatarKey){button._district9Avatar=avatarKey;button.replaceChildren();
      if(window.AgentWalletAvatar?.create)button.append(window.AgentWalletAvatar.create(group.wallet));
      else if(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(group.wallet.avatar||'')&&group.wallet.avatar.length<=150000){const img=document.createElement('img');img.src=group.wallet.avatar;img.alt='';button.append(img);}
      else if(window.AgentWalletAvatar?.createDefault)button.append(window.AgentWalletAvatar.createDefault(group.wallet.address));
      else{const initial=document.createElement('span');initial.textContent=Array.from(group.wallet.note?.trim()||group.wallet.address.slice(2))[0]||'?';button.append(initial);}
      }
      bindMarkerInteractions(button,[group]);
      }
      if(overflow){
        const box=positions.at(-1),button=markerButton(groups[0].t,null),hidden=groups.length-visible.length;button.type='button';button.className='wallet-chart-marker wallet-marker-overflow';button.dataset.wallet='';button.dataset.bucket=String(groups[0].t);button.dataset.count=String(groups.reduce((total,group)=>total+group.events.length,0));button.textContent=`+${hidden}`;button.style.left=`${bucket.x}px`;button.style.top=`${box.y}px`;button.style.width=`${box.width}px`;button.style.height=`${box.height}px`;button.style.fontSize=`${Math.max(1,Math.min(9,box.width/2))}px`;
        button.title=`本根 K 线另有 ${hidden} 个钱包；查看全部 ${groups.length} 个钱包的信号`;button.setAttribute('aria-label',button.title);button.setAttribute('aria-controls','wallet-marker-details');
        bindMarkerInteractions(button,groups,true);
      }
    }
    for(const button of existing.values())if(!used.has(button)){if(hoverAnchor===button)hideMarkerHover();button.remove();}
    if(hoverAnchor&&used.has(hoverAnchor)){const current=hoverAnchor._district9Marker;showMarkerHover(current.groups,hoverAnchor,current.allWallets);}
  }
  avatarToggle.addEventListener('change',async()=>{
    const previous=tracking.preferences?.showAvatars!==false,showAvatars=avatarToggle.checked;
    tracking={...tracking,preferences:{...tracking.preferences,showAvatars}};preferenceSaving=true;avatarToggle.disabled=true;renderMarkers();markerMessage();
    let saved=false;
    try{await api('/api/tracking/preferences',{showAvatars});saved=true;await window.walletTracker?.refresh?.({discardPending:true});}
    catch(error){if(saved)markerMessage(`头像显示设置已保存；信号刷新失败：${error.message}`);else{avatarToggle.checked=previous;tracking={...tracking,preferences:{...tracking.preferences,showAvatars:previous}};renderMarkers();markerMessage(`头像显示设置保存失败：${error.message}`);}}
    finally{preferenceSaving=false;avatarToggle.disabled=false;}
  });
  window.addEventListener('wallet-tracking-update',event=>{if(!event.detail)return;tracking=event.detail;if(!preferenceSaving)avatarToggle.checked=tracking.preferences?.showAvatars!==false;renderMarkers();});
  const chart = window.AgentCandleChart.create($('candle-canvas'), { onHover: candle => {
    const price=value=>`${/^USD(?:\/份额)?$/.test(latest?.priceUnit||'')?'$':''}${format(value)}`;
    $('chart-ohlc').textContent = candle ? `O ${price(candle.o)}  H ${price(candle.h)}  L ${price(candle.l)}  C ${price(candle.c)}  V ${candle.v === null ? '未知' : Number(candle.v.toPrecision(5))}${latest?.volumeUnit === 'source-reported' ? '（源口径）' : latest?.volumeUnit?` ${latest.volumeUnit}`:''}` : '等待行情';
    $('chart-ohlc').title=candle?`${date(candle.t)}${candle.display==='prior-close'?' · 连续开盘显示：开盘沿前收':''}${candle.raw&&!candle.idle?` · 原始行情 O ${price(candle.raw.o)}  H ${price(candle.raw.h)}  L ${price(candle.raw.l)}  C ${price(candle.raw.c)}`:''}${candle.idle?latest?.source==='local-curve'?' · 无新采样，沿用前值':' · 无成交，沿用前收，量为0':''}`:'';
  }, onLayout: value=>{layout=value;renderMarkers();renderGraduationEvent();}, onHistoryNeeded: request=>loadOlder(request) });
  function graduationEvent(){
    const e=latest?.graduationEvent;
    return e&&Number.isSafeInteger(e.at)&&e.at>=1e12&&['chain-event','official-index'].includes(e.proof)?e:null;
  }
  function renderGraduationEvent(){
    const el=$('chart-graduation-event'),event=graduationEvent(),point=layout?.graduationEvent;
    el.hidden=true;
    if(!event||!point||point.at!==event.at||!token||$('token-detail').hidden||!Number.isFinite(point.x)||point.x<0||point.x>layout.plotWidth||!(layout.plotHeight>24))return;
    el.style.left=`${point.x}px`;el.style.height=`${Math.max(0,layout.plotHeight-20)}px`;
    el.classList.toggle('align-right',point.x>layout.plotWidth-100);
    const provenance=event.proof==='chain-event'&&event.verified===true?'链上事件':event.proof==='official-index'?'平台记录':'时间待核验';
    el.firstElementChild.textContent='毕业';el.title=`毕业 · ${date(event.at)} UTC+8 · ${provenance}`;el.hidden=false;
  }
  function empty(title, message) { $('chart-empty').hidden=false; $('chart-empty-title').textContent=title; $('chart-empty-message').textContent=message; }
  function cancel({view=false}={}) { version++; pending?.abort(); pending=null; clearTimeout(timer); timer=null;if(view){viewEpoch++;historyPending?.abort();historyPending=null;historyBusy=false;} }
  function seriesKey(data) {return JSON.stringify([token?.address.toLowerCase(),interval,mode,currency,data.seriesKey??[data.chartAddress||data.address,token?.phase,data.source,data.priceUnit,data.capBasis||'',data.volumeUnit]]);}
  function validSeries(data) {
    if(!Array.isArray(data.candles)||data.address?.toLowerCase()!==token?.address.toLowerCase()||(data.interval&&data.interval!==interval)||(data.mode&&data.mode!==mode))throw new Error('K线归属或周期无效');
    if(data.currency!==undefined&&data.currency!==currency)throw new Error('K线计价单位与请求不一致');
    if(data.candles.some(c=>!Number.isSafeInteger(c.t)||c.t%intervals[interval]!==0||![c.o,c.h,c.l,c.c].every(n=>Number.isFinite(n)&&n>0)||c.l>Math.min(c.o,c.c)||c.h<Math.max(c.o,c.c)||(c.v!==null&&(!Number.isFinite(c.v)||c.v<0))))throw new Error('K线数值无效');
  }
  function mergeBars(old,added) {const rows=new Map(old.map(c=>[c.t,c]));for(const c of added)rows.set(c.t,c);return [...rows.values()].sort((a,b)=>a.t-b.t).slice(-5000);}
  function renderHistory() {
    const more=(Boolean(pagination?.hasMore)||historyRecovery)&&loadedBars.length<5000;
    $('chart-history-load').hidden=!more;$('chart-history-load').disabled=historyBusy;
    $('chart-history-load').textContent=historyBusy?'正在读取…':historyRecovery?'重新载入':historyMessage?'重试历史':'加载更早';
    const scope=pagination?.scope,scopeLabel=scope==='retained-samples'?'本机已观察采样':scope==='indexed-window'?'行情源已收录窗口':scope==='demo'?'演示历史':'已加载历史';
    $('chart-history-status').textContent=historyBusy?'正在读取更早的完整时间桶…':historyMessage||`${scopeLabel} · ${loadedBars.length} 根${more?' · 向左拖动加载更早':loadedBars.length>=5000?' · 已达本次5000根上限':' · 已到当前可用历史边界'}`;
    $('chart-series-status').textContent=transitionMessage;$('chart-series-status').hidden=!transitionMessage;
  }
  function paintSeries({reset=false}={}) {
    if(!latest)return;
    const activity=latest.timeline==='activity',continuous=activity&&timeMode==='continuous';
    $('chart-timeline-toggle').hidden=!activity;$('chart-timeline-toggle').setAttribute('aria-pressed',String(continuous));
    $('chart-timeline-status').hidden=!activity;$('chart-timeline-status').textContent=continuous?'连续时间 · 空桶沿前收':'成交时段 · 无成交区间压缩';
    chart.setData(loadedBars,{seriesKey:currentSeriesKey,reset,timeMode:activity?timeMode:'continuous',hasMore:Boolean(pagination?.hasMore)&&loadedBars.length<5000,mode,intervalMs:intervals[interval],until:latest.endAt??(latest.stale?Date.parse(latest.lastCandleAt||latest.updatedAt):Date.now()),graduation:latest.graduation,graduationEvent:graduationEvent(),fitTarget,priceUnit:latest.priceUnit,volumeKnown:latest.volumeUnit!==null});
    renderHistory();
  }
  async function loadOlder(request={}) {
    if(historyRecovery){if(request.before===undefined)await load({reset:true});return;}
    if(!token||!latest||!loadedBars.length||historyBusy||!pagination?.hasMore||loadedBars.length>=5000||$('token-detail').hidden)return;
    if(request.seriesKey&&request.seriesKey!==currentSeriesKey)return;
    const before=loadedBars[0].t,epoch=viewEpoch,key=currentSeriesKey,address=token.address;
    if(request.before!==undefined&&request.before!==before)return;
    const controller=new AbortController();historyPending=controller;historyBusy=true;historyMessage='';renderHistory();
    try {
      const data=await api(`/api/candles?token=${encodeURIComponent(address)}&interval=${interval}&mode=${mode}&currency=${currency}&before=${before}`,undefined,{signal:controller.signal});
      if(epoch!==viewEpoch||key!==currentSeriesKey||$('token-detail').hidden)return;
      validSeries(data);
      if(data.currencyConversion?.status==='unavailable') {historyMessage=`历史汇率暂不可用：${data.currencyConversion.warning||'缺少对应时间桶'}，当前图表已保留，可重试历史。`;return;}
      if(seriesKey(data)!==key) {historyRecovery=true;historyMessage='该段历史的来源或计价口径已变化，点击“重新载入”重建历史。';return;}
      if(data.candles.some(c=>c.t>=before))throw new Error('历史页超出请求的时间范围');
      const older=data.candles.length;
      loadedBars=mergeBars(loadedBars,data.candles);hasHistory=hasHistory||older>0;
      pagination=data.pagination||{hasMore:false};
      if(!older){
        const reason=pagination.reason;
        if(['cursor-expired','cursor-unavailable','offset-anchor-changed'].includes(reason)){
          historyRecovery=true;historyMessage=reason==='offset-anchor-changed'?'历史位置因新增成交发生变化，点击“重新载入”重建历史。':'历史定位已过期或不可用，点击“重新载入”重建历史。';
        }else if(reason==='upstream-unavailable')historyMessage='历史来源暂时不可用，当前图表已保留，可重试历史。';
        else if(pagination.hasMore)historyMessage='本次尚未取得更早的完整历史，可点“重试历史”继续读取。';
        else if(data.historyPartial)historyMessage='已达到当前历史读取范围，已加载的图表保留；这不代表完整链上历史。';
      }
      latest={...latest,candles:loadedBars};paintSeries();
    } catch(error) {
      if(epoch===viewEpoch&&key===currentSeriesKey&&!controller.signal.aborted)historyMessage=`历史读取失败：${error.message}，当前图表已保留。`;
    } finally {
      if(historyPending===controller){historyPending=null;historyBusy=false;renderHistory();}
    }
  }
  function renderChartTitle() {
    const label=mode==='marketcap'?'市值':'价格',kind=latest?.source==='local-curve'?'采样图':' K 线';
    const identity=token&&document.body.classList.contains('chart-expanded')?` · ${token.symbol||token.name||'未命名代币'}`:'';
    $('chart-title').textContent=`${label}${kind}${identity}`;
  }
  function renderIdentity() {
    if(!token)return;
    document.querySelector('.detail-stat-grid').hidden=isFair();
    renderChartTitle();
    $('detail-name').textContent=token.name||token.symbol||'未命名代币';
    $('detail-symbol').textContent=`${token.symbol||'—'} · ${token.platformName||{four:'Four.meme',gang:'Gang',flap:'Flap'}[token.platformId]||'未知平台'}`;
    const key=JSON.stringify([token.address,token.imageUrl,token.sourceImageUrl,token.sourceImageFallbackUrl,token.tokenMetaUri]);
    if($('detail-avatar').dataset.key!==key) { $('detail-avatar').replaceChildren(avatar(token)); $('detail-avatar').dataset.key=key; }
    const launchType=window.gangLaunchTypeLabel(token);
    $('detail-launch-type').textContent=launchType||'';$('detail-launch-type').hidden=!launchType;
    const trusted=token.verified===true&&!token.sourceUnavailable&&token.demo!==true&&token.metadataStatus!=='demo'&&token.phase==='bonding'&&['four','gang','flap'].includes(token.platformId);
    sourceBadge.textContent=trusted?'可信平台来源':'';sourceBadge.hidden=!trusted;
    $('detail-price-label').textContent=isFair()?'每份认购价格':token.priceSource==='verified-pool'?'池子参考价':'链上曲线价';
    $('detail-phase').textContent={bonding:token.launchType==='fair'?'打新中':'内盘',graduated:'已毕业',launching:'发射中'}[token.phase]||'待确认';
    $('detail-phase').className=`badge ${token.phase==='bonding'?'green':'neutral'}`;
    $('detail-address').textContent=`${token.addressKind==='market'?'Market':'CA'} · ${token.address}`;
    $('detail-curve-price').textContent=`${isFair()?(token.fairSale?.verified?token.fairSale.sharePrice:'—'):token.price ?? '—'} ${token.priceUnit||token.quoteSymbol||''}`;
    $('detail-progress').previousElementSibling.textContent=isFair()?'打新进度':'曲线进度';
    const cap=token.marketCap;
    $('detail-market-cap').textContent=cap?`${cap.unit==='USD'?'$':''}${Number(cap.value).toLocaleString('en-US',{maximumFractionDigits:2})} ${cap.unit} · ${cap.label}`:'待核验';
    $('detail-progress').textContent=token.progress===null||token.progress===undefined?'未知':`${Number(token.progress).toFixed(1)}%`;
    $('detail-kind').textContent=token.positionKind==='shares'?'Flap 内盘份额':'ERC20 代币';
    let funding=$('detail-funding');if(!funding){funding=document.createElement('p');funding.className='field-help';funding.id='detail-funding';document.querySelector('.detail-address-row').after(funding);}
    funding.textContent=`底币：${token.quoteSymbol||'待核验'}${token.quoteAsset?' · '+token.quoteAsset:''} · ${token.phase==='graduated'?'外盘：币安聚合，必要时经 USDT；下单时核验储备和路径':'内盘：协议曲线；非 BNB 底币可先聚合兑换，支持状态以后台报价为准'}`;
    const link=$('detail-official'); link.hidden=true; link.removeAttribute('href');
    try {const url=new URL(token.officialUrl);if(url.protocol==='https:'&&url.hostname==={four:'four.meme',gang:'gang.fun',flap:'flap.sh'}[token.platformId]&&!url.username&&!url.password){link.href=url.href;link.hidden=false;}}catch{}
  }
  function renderSeries(data) {
    validSeries(data);
    const key=seriesKey(data),changed=currentSeriesKey!==null&&currentSeriesKey!==key,reset=currentSeriesKey!==key;
    if(reset){if(changed){viewEpoch++;historyPending?.abort();historyPending=null;historyBusy=false;transitionMessage='行情来源或计价口径已切换，当前图表从新分段显示。';clearMarkers();}loadedBars=[];hasHistory=false;historyRecovery=false;pagination=null;historyMessage='';currentSeriesKey=key;timeMode='activity';}
    loadedBars=mergeBars(loadedBars,data.candles);
    if(!hasHistory)pagination=data.pagination||{hasMore:false};
    latest={...data,candles:loadedBars};
    $('chart-source').textContent=data.sourceLabel||'未知行情源';
    $('chart-source').className=`badge ${data.stale?'yellow':data.kind==='demo'?'yellow':'neutral'}`;
    const sampled=data.source==='local-curve';
    chartPanel.dataset.stale=String(Boolean(data.stale));
    $('chart-data-label').textContent=data.stale?'旧数据':data.kind==='demo'?'演示说明':sampled?'采样说明':'数据说明';
    $('chart-unit').textContent=`${data.priceUnit} · ${mode==='marketcap'?(data.capBasis==='source'?'市值 · 源口径 · ':data.capBasis==='share-equivalent-FDV'?'份额等值 FDV · ':'市值 / FDV · '):''}${sampled?'曲线采样':data.kind==='demo'?'演示行情':data.kind==='initial'?'初始曲线参考':data.semantics==='official-composite-reference'?'官方综合行情':'成交K线'} · 连续开盘`;
    $('chart-unit').title='显示开盘沿上一根收盘，影线按需扩展；收盘、时间和成交量沿用行情源，悬浮查看原始 OHLC。缺失行情与来源断点分段显示。';
    const conversion=data.currencyConversion,status=$('chart-currency-status');status.hidden=!conversion||!['estimated','unavailable'].includes(conversion.status);status.textContent=conversion?.status==='estimated'?conversion.partial?'历史汇率估算 · 尾部待更新':'历史汇率折算 · 估算':conversion?.status==='unavailable'?'历史汇率暂不可用':'';status.title=conversion?.warning||'';
    const event=graduationEvent(),eventInfo=$('chart-graduation-info');$('chart-graduation-locate').hidden=!event;
    eventInfo.hidden=!event&&token.phase!=='graduated';eventInfo.textContent=event?`毕业 · ${date(event.at)} · ${event.proof==='chain-event'&&event.verified===true?'链上事件':'平台记录'}`:token.phase==='graduated'?'毕业时间待核验':'';
    $('chart-warning').textContent=data.warning||''; $('chart-warning').hidden=!data.warning;
    $('chart-updated').textContent=data.updatedAt?`${data.stale?'旧数据 · ':''}更新 ${date(data.updatedAt)}${data.lastCandleAt?` · 最后行情柱 ${date(data.lastCandleAt)}`:''}`:'尚无历史数据';
    if(loadedBars.length) $('chart-empty').hidden=true;
    else empty('暂时没有 K 线',data.warning||'行情源尚未收录，等待成交或本机开始曲线采样。');
    $('candle-canvas').setAttribute('aria-label',`代币${mode==='marketcap'?'市值':'价格'}蜡烛图与成交量`);
    renderChartTitle();
    $('chart-graduation').textContent=data.graduation?`${data.graduation.label} ${format(data.graduation.value)} ${data.priceUnit}${data.graduation.referenceFx?' · 当前汇率参考':data.graduation.historicalFx?' · 历史汇率参考':''}`:data.graduationUnavailable||'毕业线待核验 · 缺少曲线模型或换算汇率';
    $('chart-graduation').title=data.graduation?.note||'';
    $('chart-fit-target').disabled=!data.graduation;
    $('chart-fit-target').title=$('chart-graduation').textContent;
    paintSeries({reset});
    if(pendingFocus){const event=pendingFocus;pendingFocus=null;focusEvent(event);}
  }
  async function load({ reset = false } = {}) {
    if(!token||$('token-detail').hidden||isFair())return;
    cancel({view:reset}); const current=version; pending=new AbortController();
    if(reset) {latest=null;loadedBars=[];currentSeriesKey=null;pagination=null;hasHistory=false;historyRecovery=false;transitionMessage='';historyMessage='';timeMode='activity';$('chart-timeline-toggle').hidden=true;$('chart-timeline-status').hidden=true;clearMarkers({keepDetails:true});chart.setData([]);renderHistory();empty('正在加载 K 线','正在读取公开行情…');$('chart-source').textContent='正在读取';$('chart-warning').hidden=true;$('chart-unit').textContent='—';$('chart-updated').textContent='等待数据';$('chart-graduation').textContent='正在读取毕业参考…';$('chart-fit-target').disabled=true;}
    $('chart-refresh').disabled=true;
    try {
      const data=await api(`/api/candles?token=${encodeURIComponent(token.address)}&interval=${interval}&mode=${mode}&currency=${currency}`,undefined,{signal:pending.signal});
      if(current!==version||$('token-detail').hidden)return;
      validSeries(data);
      if(data.currencyConversion?.status==='unavailable'&&latest?.currency===currency&&latest.currencyConversion?.basisKey&&latest.currencyConversion.basisKey===data.currencyConversion.basisKey){
        const status=$('chart-currency-status');status.hidden=false;status.textContent='历史汇率暂不可用 · 保留上次换算';status.title=data.currencyConversion.warning||'';
        throw new Error(data.currencyConversion.warning||'历史汇率暂不可用');
      }
      renderSeries(data);
    } catch(error) {
      if(current!==version||$('token-detail').hidden)return;
      $('chart-source').textContent='读取失败';$('chart-source').className='badge red';
      chartPanel.dataset.stale='true';$('chart-data-label').textContent='读取失败';
      $('chart-warning').textContent=latest?'行情刷新失败，当前仍为上次数据；请留意更新时间。':error.message;$('chart-warning').hidden=false;
      if(!latest)empty('K 线暂时不可用',error.message);
    } finally {
      if(current===version) {pending=null;$('chart-refresh').disabled=false;timer=setTimeout(()=>load(),intervals[interval]<60000?2500:5000);}
    }
  }
  function open(value) {
    const wasFair=isFair(),changed=token?.address.toLowerCase()!==value.address.toLowerCase(); token=value;
    if(changed){pendingFocus=null;clearMarkers();markerMessage();}
    $('token-detail').hidden=false;$('market').hidden=true;document.body.classList.add('detail-open');
    renderIdentity(); insights.open(value);
    chartPanel.hidden=isFair();
    if(isFair()){setChartExpanded(false);cancel({view:true});latest=null;loadedBars=[];clearMarkers();chart.setData([]);fairProgress.render(token);}
    else {fairProgress?.hide();if(changed||wasFair||!latest)load({reset:true});}
    $('detail-back').focus({preventScroll:true});
    $('token-detail').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function setChartExpanded(expanded) {
    document.body.classList.toggle('chart-expanded',expanded);
    $('chart-expand').setAttribute('aria-pressed',String(expanded));
    $('chart-expand').textContent=expanded?'还原布局':'放大K线';
    renderChartTitle();
  }
  function close() {setChartExpanded(false);fairProgress?.hide();insights.close();cancel({view:true});token=null;latest=null;loadedBars=[];currentSeriesKey=null;pagination=null;hasHistory=false;historyRecovery=false;transitionMessage='';historyMessage='';renderChartTitle();pendingFocus=null;clearMarkers();markerMessage();chart.setData([]);$('token-detail').hidden=true;$('market').hidden=false;document.body.classList.remove('detail-open');}
  function focusEvent(event){
    if(!token||event?.tokenAddress?.toLowerCase()!==token.address.toLowerCase())return {focused:false,message:'信号不属于当前代币'};
    if(!latest){pendingFocus=event;markerMessage('正在读取该信号附近的 K 线…');return {focused:false,pending:true};}
    const timestamp=eventTime(event.timestamp),focused=chart.focusTime?.(timestamp)===true;
    if(!focused){const message='该信号超出当前已加载的历史范围；没有补造历史 K 线。';markerMessage(message);return {focused:false,message};}
    markerMessage();
    const bucket=Math.floor(timestamp/intervals[interval])*intervals[interval],buttons=[...markerLayer.querySelectorAll('.wallet-chart-marker')],button=buttons.find(row=>row.dataset.bucket===String(bucket)&&row.dataset.wallet?.toLowerCase()===event.walletAddress?.toLowerCase())||buttons.find(row=>row.dataset.bucket===String(bucket)&&row.classList.contains('wallet-marker-overflow'));
    button?.focus({preventScroll:true});button?.click();return {focused:true};
  }
  function back(){if(!canClose())return;close();onBack();}
  $('detail-back').addEventListener('click',back);
  $('detail-trade-open').addEventListener('click',onTrade);
  $('detail-address').addEventListener('click',()=>{if(token)copy(token.address);});
  $('chart-expand').addEventListener('click',()=>{if(token&&!$('token-detail').hidden)setChartExpanded(!document.body.classList.contains('chart-expanded'));});
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!document.body.classList.contains('chart-expanded'))return;
    event.preventDefault();setChartExpanded(false);$('chart-expand').focus({preventScroll:true});
  });
  $('chart-refresh').addEventListener('click',()=>load({reset:historyRecovery})); $('chart-reset').addEventListener('click',()=>chart.reset?.());
  $('chart-latest').addEventListener('click',()=>{if(typeof chart.scrollToLatest==='function')chart.scrollToLatest();else chart.reset?.();});
  $('chart-overview').addEventListener('click',()=>chart.fitAll?.());
  $('chart-history-load').addEventListener('click',()=>loadOlder());
  $('chart-graduation-locate').addEventListener('click',()=>{const e=graduationEvent();if(e&&!chart.focusTime?.(e.at))$('chart-graduation-info').textContent='当前加载窗口中没有毕业时段，可向左加载更早历史。';});
  $('chart-timeline-toggle').addEventListener('click',()=>{if(latest?.timeline!=='activity')return;timeMode=timeMode==='activity'?'continuous':'activity';clearMarkers({keepDetails:true});paintSeries();});
  $('chart-fit-target').addEventListener('click',()=>{fitTarget=!fitTarget;$('chart-fit-target').setAttribute('aria-pressed',String(fitTarget));if(latest)renderSeries(latest);});
  document.querySelectorAll('[data-chart-mode]').forEach(button=>button.addEventListener('click',()=>{
    if(mode===button.dataset.chartMode)return;
    mode=button.dataset.chartMode;
    document.querySelectorAll('[data-chart-mode]').forEach(b=>{const active=b.dataset.chartMode===mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    load({reset:true});
  }));
  document.querySelectorAll('[data-chart-currency]').forEach(button=>button.addEventListener('click',()=>{
    if(!['BNB','USD'].includes(button.dataset.chartCurrency)||currency===button.dataset.chartCurrency)return;
    currency=button.dataset.chartCurrency;
    document.querySelectorAll('[data-chart-currency]').forEach(b=>{const active=b.dataset.chartCurrency===currency;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    load({reset:true});
  }));
  document.querySelectorAll('[data-chart-interval]').forEach(button=>button.addEventListener('click',()=>{
    if(interval===button.dataset.chartInterval)return;
    interval=button.dataset.chartInterval;
    document.querySelectorAll('[data-chart-interval]').forEach(b=>{const active=b.dataset.chartInterval===interval;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    load({reset:true});
  }));
  return {open,close,back,focusEvent,updatePosition(){fairProgress?.updatePosition();},update(value){if(token&&value&&token.address.toLowerCase()===value.address.toLowerCase()){const wasFair=isFair();token=value;renderIdentity();if(isFair()){if(!wasFair){cancel({view:true});latest=null;loadedBars=[];clearMarkers();chart.setData([]);setChartExpanded(false);}chartPanel.hidden=true;fairProgress.render(token);}else{fairProgress?.hide();chartPanel.hidden=false;if(wasFair)load({reset:true});}}}};
};
