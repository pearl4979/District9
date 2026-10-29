'use strict';

window.createTokenInsights = ({api,onSelect=()=>{}}) => {
  const $=id=>document.getElementById(id),root=$('token-insights'),content=$('insights-content');
  const launchLabels={'curve-v3':'V3 曲线',fair:'Fair 打新'};
  const hosts={four:'four.meme',gang:'gang.fun',flap:'flap.sh'};
  const validAddress=value=>typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value);
  const words=(value,fallback='待核验')=>typeof value==='string'&&value.trim()?value:fallback;
  const rows=value=>Array.isArray(value)?value:[];
  const percent=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?`${Number((value/100).toFixed(4))}%`:'待核验';
  const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?`$${value.toLocaleString('en-US',{maximumFractionDigits:2})}`:'待核验';
  let token=null,version=0,pending=null,timer=null,latest=null;

  function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
  function link(href,label,title){const el=node('a','insights-link',label);el.href=href;el.target='_blank';el.rel='noopener noreferrer';if(title)el.title=title;return el;}
  function addressLink(address){return validAddress(address)?link(`https://bscscan.com/address/${address}`,`${address.slice(0,6)}…${address.slice(-4)}`,address):node('span','quiet','待核验');}
  function officialLink(item){
    try{const url=new URL(item.officialUrl);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&Object.values(hosts).includes(url.hostname)&&(!hosts[item.platformId]||hosts[item.platformId]===url.hostname))return link(url.href,'官方记录 ↗');}catch{}
    return validAddress(item.address)?addressLink(item.address):node('span','quiet','地址待核验');
  }
  function note(parent,label,value){parent.append(node('p','insights-note',`${label}${words(value)}`));}
  function fact(list,label,value,field){const term=node('dt','',label),description=node('dd','',value);if(field)description.dataset.field=field;list.append(term,description);}
  function person(parent,label,value={}){
    const person=value||{},row=node('div','insights-person'),heading=node('p','insights-person-heading');
    heading.append(node('span','quiet',label),node('strong','',words(person.name)),node('span',person.verified===true?'insights-verified':'quiet',person.verified===true?'记录已核验':'待核验'));
    row.append(heading,addressLink(person.address));parent.append(row);return row;
  }
  function fold(key,title){const el=node('details',`insights-fold insights-${key}`);el.dataset.section=key;el.append(node('summary','',title));if(content.querySelector(`details[data-section="${key}"]`)?.hasAttribute('open'))el.setAttribute('open','');return el;}
  function render(data){
    const fees=data.fees||{},tax=data.tax||{},history=data.history||{},route=data.route||{},dev=data.dev||{},buyer=data.firstBuyer||{};
    const summary=node('div','insights-summary'),feeBlock=node('div','insights-summary-column'),people=node('div','insights-summary-column');
    feeBlock.append(node('h3','','税率与费用'));
    const projectFees=node('dl','insights-facts');fact(projectFees,'项目税 · 买入',percent(fees.tokenBuyBps),'token-buy');fact(projectFees,'项目税 · 卖出',percent(fees.tokenSellBps),'token-sell');feeBlock.append(projectFees);
    note(feeBlock,'项目税适用范围：',fees.tokenTaxScope);feeBlock.append(node('h4','','内盘平台费用'));
    const platformFees=node('dl','insights-facts');fact(platformFees,'平台 · 买入',percent(fees.platformBuyBps),'platform-buy');fact(platformFees,'平台 · 卖出',percent(fees.platformSellBps),'platform-sell');fact(platformFees,'Agent 服务费',percent(fees.agentBps),'agent');feeBlock.append(platformFees);note(feeBlock,'说明：',fees.note);
    people.append(node('h3','','创建者与最早买家'));const creator=person(people,'创建者 Dev',dev);note(creator,'名称来源：',dev.nameSource);
    const first=person(people,'最早买家',buyer);note(first,'来源：',buyer.source);note(first,'覆盖范围：',buyer.coverage);note(first,'说明：',buyer.note);
    if(typeof buyer.txHash==='string'&&/^0x[0-9a-f]{64}$/i.test(buyer.txHash))first.append(link(`https://bscscan.com/tx/${buyer.txHash}`,'成交记录 ↗',buyer.txHash));
    summary.append(feeBlock,people);

    const taxBlock=node('div','insights-tax');taxBlock.append(node('h3','','税收去向'));
    note(taxBlock,'税额分配：',rows(tax.allocations).map(item=>`${words(item.label)} ${percent(item.bps)}`).join(' · '));
    const recipients=node('ul','insights-list');
    for(const item of rows(tax.recipients)){
      const row=node('li','insights-recipient'),identity=node('div','insights-row');identity.append(node('span','',words(item.label)),addressLink(item.address),node('span','quiet',item.type==='external'?'外部地址，归属未知':item.type==='contract'?'合约地址':'地址类型待核验'));
      row.append(identity);note(row,'来源：',item.source);recipients.append(row);
    }
    if(!recipients.children.length)recipients.append(node('li','quiet','收税地址待核验'));
    taxBlock.append(recipients);note(taxBlock,'说明：',tax.note);

    const items=rows(history.items),historyBlock=fold('history',`Dev 发币记录 · 当前 ${items.length} 项`);
    note(historyBlock,'当前覆盖范围：',`${words(history.scope)} · 不是全部历史`);
    note(historyBlock,'已知总数：',typeof history.totalKnown==='number'&&Number.isSafeInteger(history.totalKnown)&&history.totalKnown>=0?String(history.totalKnown):null);
    const historyList=node('ul','insights-list');
    for(const item of items){
      const row=node('li','insights-history-row'),eligible=validAddress(item.address)&&item.verified===true&&item.inCurrentWindow===true;
      const label=`${words(item.name,'未命名代币')}${item.symbol?` · ${words(item.symbol,'')}`:''}`,title=node(eligible?'button':'span',eligible?'insights-select':'',label);
      if(eligible){title.type='button';title.title=item.address;title.addEventListener('click',()=>onSelect(item.address));}
      const phaseLabel=item.platformId==='gang'&&item.launchType==='fair'&&item.phase==='bonding'?'打新中':({bonding:'内盘',graduated:'已毕业',launching:'发射中'}[item.phase]||'阶段待核验');
      row.append(title,node('span','quiet',`${item.verified===true&&validAddress(item.address)?'已核验':'待核验'} · ${item.inCurrentWindow===true?'当前窗口':'窗口外'} · ${phaseLabel}`),eligible?addressLink(item.address):officialLink(item));
      historyList.append(row);
    }
    if(!items.length)historyList.append(node('li','quiet','当前覆盖范围内暂无记录；不能据此判断 Dev 没有其他发币历史。'));
    historyBlock.append(historyList);

    const pools=rows(route.pools),poolBlock=fold('pools',`路由与流动性参考 · ${pools.length} 个池子`);
    note(poolBlock,route.kind==='bonding'?'当前实际交易路由：':'路由参考：',route.label);
    if(route.kind==='readonly')poolBlock.append(node('p','insights-note caution','仅只读，未接入执行'));
    else if(route.kind==='dex-reference')poolBlock.append(node('p','insights-note caution','外盘执行未接入 · 以下池子仅为流动性参考'));
    else if(route.kind!=='bonding')poolBlock.append(node('p','insights-note','交易路由待核验'));
    const routeFacts=node('dl','insights-facts insights-route');
    for(const [label,value]of [['执行目标',route.target],['报价资产',route.quoteAsset||data.quote?.address],['参考交易对',route.pair]]){const description=node('dd');description.append(label==='报价资产'&&/^0x0{40}$/i.test(value||'')?node('span','','BNB（原生）'):addressLink(value));routeFacts.append(node('dt','',label),description);}
    poolBlock.append(routeFacts);note(poolBlock,'说明：',route.note);
    const poolList=node('ul','insights-list');
    for(const pool of pools){
      const row=node('li','insights-pool');row.append(node('strong','',`${words(pool.dex)} · ${words(pool.quoteSymbol)}`),addressLink(pool.address));
      note(row,'流动性参考：',amount(pool.liquidityUsd));note(row,'状态：',`${pool.verified===true?'池信息已核验':'池信息待核验'} · ${pool.official===true?'官方来源':'来源待核验'}`);note(row,'依据：',pool.reason);poolList.append(row);
    }
    if(!pools.length)poolList.append(node('li','quiet','暂无已读取的池子参考'));
    poolBlock.append(poolList);
    const warnings=node('ul','insights-warnings');for(const warning of rows(data.warnings))warnings.append(node('li','',words(warning)));
    const sources=node('p','insights-sources');sources.textContent=`来源：${rows(data.sources).map(source=>words(source)).join('；')||'待核验'}`;
    const timestamp=new Date(data.updatedAt),updated=data.updatedAt&&Number.isFinite(timestamp.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(timestamp):'待核验';
    const launchLabel=data.platformId==='gang'?(Object.hasOwn(launchLabels,data.launchType)?launchLabels[data.launchType]:data.status==='partial'?'合并版':''):'';
    $('insights-context').textContent=`${{four:'Four.meme',gang:'Gang',flap:'Flap'}[data.platformId]||'平台待核验'}${launchLabel?` · ${launchLabel}`:''} · 报价 ${words(data.quote?.symbol)} · ${data.status==='partial'?'快照时间':'更新时间'} ${updated}${data.status==='partial'&&Number.isSafeInteger(data.sourceBlock)&&data.sourceBlock>0?` · 区块 ${data.sourceBlock}`:''} · 每 30 秒刷新`;
    content.replaceChildren(summary,taxBlock,historyBlock,poolBlock,...(warnings.children.length?[warnings]:[]),sources);
  }
  function cancel(){version++;pending?.abort();pending=null;if(timer!==null)clearTimeout(timer);timer=null;}
  async function load(){
    if(!token)return;cancel();const current=version,address=token.address,request=new AbortController();pending=request;
    $('insights-state').textContent=latest?'正在刷新':'正在读取';$('insights-refresh').disabled=true;$('insights-error').hidden=true;
    try{
      const data=await api(`/api/token-insights?token=${encodeURIComponent(address)}`,undefined,{signal:request.signal});
      if(current!==version||!token)return;
      if(!validAddress(data?.address)||data.address.toLowerCase()!==address.toLowerCase())throw new Error('档案地址归属不一致，已忽略返回数据。');
      render(data);latest=data;$('insights-state').textContent=data.status==='partial'?'资料部分可用 · 只读':'已更新 · 只读';
    }catch(error){
      if(current!==version||!token)return;
      $('insights-state').textContent=latest?'刷新失败':'读取失败';$('insights-error').textContent=latest?'刷新失败，当前保留上次数据；请留意更新时间。':`档案暂时不可用：${words(error?.message,'请稍后刷新')}`;$('insights-error').hidden=false;
    }finally{
      if(current===version&&token){pending=null;$('insights-refresh').disabled=false;timer=setTimeout(()=>{if(current===version&&token)load();},30000);}
    }
  }
  function open(value){
    if(!validAddress(value?.address)){close();return;}
    if(token?.address.toLowerCase()===value.address.toLowerCase())return;
    cancel();token=value;latest=null;content.replaceChildren();$('insights-context').textContent='正在读取该代币的档案…';$('insights-error').hidden=true;root.hidden=false;load();
  }
  function close(){cancel();token=null;latest=null;content.replaceChildren();root.hidden=true;$('insights-error').hidden=true;$('insights-context').textContent='等待档案';$('insights-state').textContent='未读取';$('insights-refresh').disabled=false;}
  $('insights-refresh').addEventListener('click',load);
  $('insights-toggle').addEventListener('click',()=>{const body=$('insights-body');body.hidden=!body.hidden;$('insights-toggle').setAttribute('aria-expanded',String(!body.hidden));});
  return {open,close};
};
