'use strict';

window.createFairParticipantsView=({before,api,copy=()=>{}})=>{
  const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
  const panel=node('section','fair-participants');panel.id='fair-participants-panel';panel.hidden=true;panel.setAttribute('aria-label','当前有效认购地址明细');
  const heading=node('div','fair-participant-heading'),title=node('h3','','认购地址明细'),refresh=node('button','button subtle compact','刷新明细');refresh.type='button';heading.append(title,refresh);
  const wrap=node('div','fair-participant-scroll'),table=node('table'),head=node('thead'),tr=node('tr');
  for(const text of ['钱包地址','当前认购份数','对应代币数量','认购本金']){const th=node('th','',text);th.scope='col';tr.append(th);}head.append(tr);
  const body=node('tbody');body.id='fair-participant-rows';table.append(head,body);wrap.append(table);
  const status=node('p','fair-participant-status');status.id='fair-participant-status';status.setAttribute('role','status');
  const more=node('button','button subtle compact','加载更多');more.id='fair-participant-more';more.type='button';more.hidden=true;more.setAttribute('aria-controls',body.id);
  panel.append(heading,wrap,status,more);before.before(panel);
  const addr=v=>typeof v==='string'&&/^0x[\da-f]{40}$/i.test(v)&&!/^0x0{40}$/i.test(v);
  let token=null,generation=0,pending=null,timer=null,busy=false,rows=new Map(),block=null,nextOffset=null,indexedTotal=null,updatedAt=null,demo=false,multiplePages=false;
  function cancel(){generation++;pending?.abort();pending=null;clearTimeout(timer);timer=null;busy=false;}
  function render(){
    body.replaceChildren();
    const sorted=[...rows.values()].sort((a,b)=>Number(BigInt(b.shares)-BigInt(a.shares))||a.address.localeCompare(b.address));
    for(const r of sorted){
      const tr=node('tr'),wallet=node('td','fair-participant-wallet'),button=node('button','fair-participant-address',`${r.address.slice(0,8)}…${r.address.slice(-6)}`);button.type='button';button.title=r.address;button.setAttribute('aria-label',`复制完整认购地址 ${r.address}`);button.addEventListener('click',()=>copy(r.address));wallet.append(button);
      if(!demo){const link=node('a','','↗');link.href=`https://bscscan.com/address/${r.address}`;link.target='_blank';link.rel='noopener noreferrer';link.title='在 BscScan 查看地址';wallet.append(link);}
      tr.append(wallet,node('td','',BigInt(r.shares).toLocaleString('en-US')),node('td','',`${BigInt(r.tokenAmount).toLocaleString('en-US')} ${token.symbol||''}`),node('td','',`${r.principal} ${token.quoteSymbol}`));body.append(tr);
    }
    more.hidden=nextOffset===null;more.disabled=busy;refresh.disabled=busy;
  }
  function validate(data,offset){
    if(!data||data.token?.toLowerCase()!==token.address.toLowerCase()||data.offset!==offset||!Number.isSafeInteger(data.block)||data.block<=0||offset>0&&data.block!==block||data.demo!==Boolean(token.demo||token.fairSale?.demo)||data.quoteSymbol!==token.quoteSymbol||!Array.isArray(data.items)||data.items.length>50||!Number.isSafeInteger(data.indexedTotal)||data.indexedTotal<0||typeof data.hasMore!=='boolean'||data.hasMore&&data.nextOffset!==offset+50||offset>0&&data.indexedTotal!==indexedTotal)throw Error('认购快照或地址索引已变化，请刷新明细');
    const time=Date.parse(data.updatedAt);if(!Number.isFinite(time)||time>Date.now()+5000||Date.now()-time>60000)throw Error('认购快照已过期，请刷新明细');
    const seen=new Set();for(const r of data.items){
      if(!addr(r.address)||!/^[1-9]\d{0,4}$/.test(r.shares)||BigInt(r.shares)>10000n||!/^[1-9]\d{0,9}$/.test(r.tokenAmount)||BigInt(r.tokenAmount)!==BigInt(r.shares)*50000n||typeof r.principal!=='string'||!/^\d+(\.\d{1,18})?$/.test(r.principal)||r.principal.length>80||!/[1-9]/.test(r.principal)||seen.has(r.address.toLowerCase()))throw Error('认购地址或数量未通过核对');
      seen.add(r.address.toLowerCase());const old=rows.get(r.address.toLowerCase());if(offset>0&&old&&(old.shares!==r.shares||old.principal!==r.principal))throw Error('认购快照数量不一致，请刷新明细');
    }
  }
  async function load({reset=false}={}){
    if(!token||panel.hidden||document.visibilityState==='hidden'||busy)return;
    if(reset){cancel();rows=new Map();block=null;nextOffset=null;indexedTotal=null;multiplePages=false;render();}
    const offset=reset?0:nextOffset??0,epoch=generation,address=token.address,controller=new AbortController();pending=controller;busy=true;more.disabled=true;refresh.disabled=true;clearTimeout(timer);timer=null;
    status.textContent='正在核对认购地址与链上有效份数…';
    try{
      const data=await api(`/api/fair-participants?token=${encodeURIComponent(address)}&offset=${offset}${offset>0?`&block=${block}`:''}`,undefined,{signal:controller.signal});
      if(epoch!==generation||controller.signal.aborted||token?.address!==address||panel.hidden)return;
      validate(data,offset);block=data.block;indexedTotal=data.indexedTotal;updatedAt=data.updatedAt;demo=data.demo;multiplePages ||= offset>0;
      for(const r of data.items)rows.set(r.address.toLowerCase(),r);
      nextOffset=data.hasMore?data.nextOffset:null;render();
      status.textContent=`${demo?'DEMO · 演示地址与认购数量':'链上数量已核对'} · 当前加载 ${rows.size} 个有效地址 · 地址索引 ${indexedTotal} 个 · 更新 ${new Date(updatedAt).toLocaleTimeString('zh-CN',{hour12:false})}${!demo?` · 区块 ${block}`:''}。${data.inactiveOnPage?`本页 ${data.inactiveOnPage} 个零份额地址已排除。`:''}地址索引可能延迟，本金不含手续费${data.truncated?'；已达本次读取上限':''}。`;
      if(!rows.size){const empty=node('tr'),cell=node('td','','当前索引页未发现有效认购，地址索引可能延迟');cell.colSpan=4;empty.append(cell);body.append(empty);}
    }catch(error){if(epoch===generation&&!controller.signal.aborted){status.textContent=`认购明细读取失败：${error.message}${rows.size?'；当前保留上次读取结果':''}`;nextOffset=null;more.hidden=true;}}
    finally{if(epoch===generation){pending=null;busy=false;more.disabled=false;refresh.disabled=false;if(!panel.hidden)timer=setTimeout(()=>load({reset:true}),15000);}}
  }
  function open(value){
    if(token?.address.toLowerCase()===value.address.toLowerCase()&&!panel.hidden){const advanced=Number.isSafeInteger(value.fairSale?.sourceBlock)&&value.fairSale.sourceBlock>(token.fairSale?.sourceBlock||0);token=value;if(multiplePages&&(advanced||Date.now()-Date.parse(updatedAt)>60000))void load({reset:true});return;}
    cancel();token=value;panel.hidden=false;void load({reset:true});
  }
  function close(){cancel();token=null;panel.hidden=true;rows.clear();body.replaceChildren();}
  refresh.addEventListener('click',()=>load({reset:true}));more.addEventListener('click',()=>{if(!more.disabled&&nextOffset!==null)void load();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){clearTimeout(timer);timer=null;}else if(token&&!panel.hidden&&!busy)void load({reset:true});});
  return {open,close,refresh:()=>load({reset:true})};
};
