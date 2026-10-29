'use strict';

window.createTradeFeedback=({api,onLimitChange=()=>{},now=Date.now,performanceNow=()=>globalThis.performance?.now?.()??now()})=>{
 const $=id=>document.getElementById(id),node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
 const form=$('trade-form'),control=node('div','impact-limit-row'),label=node('label','','买入冲击上限'),input=node('input');
 input.id='impact-limit-input';input.type='number';input.min='0.5';input.max='5';input.step='0.01';input.value='3';input.setAttribute('aria-describedby','impact-limit-help');label.htmlFor=input.id;
 try{const saved=Number(window.localStorage?.getItem('agent-terminal.impact-limit'));if(Number.isInteger(saved)&&saved>=50&&saved<=500)input.value=String(saved/100);}catch{}
 const value=node('div');value.append(input,node('span','','%'));control.append(label,value);
 const help=node('p','field-help','限制本次买入造成的曲线价格冲击，与滑点分别计算；卖出高冲击会提示。');help.id='impact-limit-help';
 const anchor=form.querySelector('.mev-line')||$('trade-hint');anchor.before(control,help);
 const panel=node('section','trade-risk-panel');panel.id='trade-risk-panel';panel.hidden=true;panel.setAttribute('aria-label','本次交易风险与净到账');
 const wait=node('p','trade-wait-status');wait.id='trade-wait-status';wait.hidden=true;wait.setAttribute('role','status');wait.setAttribute('aria-live','polite');
 const timing=node('dl','trade-timings');timing.id='trade-timings';timing.hidden=true;
 $('preview-button').before(panel,wait,timing);
 const stages={'wallet-check':'核对钱包账户与权限','quote-simulation':'读取报价与模拟','wallet-preview':'等待钱包返回预览','execution-check':'执行前复核报价与模拟',submission:'等待提交请求返回',idle:'连接本地服务'};
 let generation=0,operation=null,startedAt=0,startedTick=0,stage='idle',pollTimer=null,clockTimer=null,pending=null;
 function limitBps(){const raw=input.value.trim(),match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(raw),bps=match?Number(match[1])*100+Number((match[2]||'').padEnd(2,'0')):NaN;if(!Number.isSafeInteger(bps)||bps<50||bps>500)throw Error('买入冲击上限须为0.5%–5%，最多两位小数');return bps;}
 input.addEventListener('change',()=>{try{window.localStorage?.setItem('agent-terminal.impact-limit',String(limitBps()));}catch{}onLimitChange();});
 function showRisk(risk){
  panel.replaceChildren();panel.hidden=!risk;if(!risk)return;
  panel.className=`trade-risk-panel ${['blocked','warning','unknown'].includes(risk.status)?risk.status:'ok'}`;
  const title=node('strong','trade-risk-title',({blocked:'本次买入已拦截',warning:'请核对本次交易风险',unknown:'部分风险数据未核验',ok:'本次交易预估'})[risk.status]||'本次交易预估');panel.append(title);
  const list=node('dl','trade-risk-grid'),quote=risk.quoteSymbol||'未知底币',out=risk.outputSymbol||'未知资产';
  const row=(name,value)=>list.append(node('dt','',name),node('dd','',value));
  const amount=(v,unit)=>v===null||v===undefined||v===''?'未知':`${v} ${unit}`;
  row('预计净收到',amount(risk.estimatedNetOutput,out));row('最低收到',amount(risk.minimumNetOutput,out));
  if(risk.estimatedNetOutput==null&&risk.contractQuotedOutput!=null)row('合约报价 · 未扣转账税',amount(risk.contractQuotedOutput,out));
  if(risk.minimumNetOutput==null&&risk.contractMinimumOutput!=null)row('合约最低值 · 非净到账保证',amount(risk.contractMinimumOutput,out));
  row('本次价格冲击',risk.priceImpactBps===null||risk.priceImpactBps===undefined?'未知':`${Number(risk.priceImpactBps)/100}%`);
  row('买入冲击上限',`${Number(risk.limitBps??300)/100}%`);
  row('实际底币储备',amount(risk.realQuoteReserve,quote));row('储备核验',risk.depthVerified===true?'已读取实际路径储备':'未核验');
  if(risk.virtualQuoteReserve!=null)row('虚拟曲线参数 · 不可提现',amount(risk.virtualQuoteReserve,quote));
  if(risk.curveQuoteLiquidity!=null)row('曲线计价参数 · 非可提取储备',amount(risk.curveQuoteLiquidity,quote));
  row(risk.feeScope==='probe-reported-fee'?'探针报告费用':'已知交易费用',amount(risk.feeAmount,risk.feeSymbol||quote));row('预估 Gas 预算',amount(risk.nativeGasBudget,'BNB'));
  if(risk.netAfterGas!=null&&out==='BNB')row('扣 Gas 预算后预计净额',amount(risk.netAfterGas,'BNB'));
  panel.append(list);
  if(risk.priceImpactMethod)panel.append(node('p','trade-risk-note',risk.priceImpactMethod));
  for(const text of [...(risk.blockReasons||[]),...(risk.warnings||[])])panel.append(node('p','trade-risk-note',text));
  panel.append(node('p','trade-risk-note','预计到账来自当前合约报价，Gas 为预算；实际结果以成功回执和资产变动为准。'));
 }
 function renderWait(){if(!operation)return;wait.hidden=false;wait.textContent=`${stages[stage]||'正在处理请求'} · 已等待 ${Math.max(0,(performanceNow()-startedTick)/1000).toFixed(1)} 秒`;}
 function clearTimers(){clearTimeout(pollTimer);clearInterval(clockTimer);pollTimer=null;clockTimer=null;pending?.abort();pending=null;}
 function start(kind){
  clearTimers();generation++;operation=kind;startedAt=now();startedTick=performanceNow();stage='idle';timing.hidden=true;renderWait();clockTimer=setInterval(renderWait,250);
  const version=generation;
  async function poll(){
   clearTimeout(pollTimer);pollTimer=null;if(version!==generation||!operation)return;
   const controller=new AbortController();pending=controller;
   try{const status=await api('/api/trade-progress',undefined,{signal:controller.signal});if(version===generation&&(status.operation===operation||operation==='place'&&['preview','execute'].includes(status.operation))&&status.startedAt>=startedAt-1000){stage=status.stage;renderWait();}}
   catch{/* The original trade request owns errors; a progress read never changes it. */}
   finally{if(version===generation&&operation){pending=null;pollTimer=setTimeout(poll,750);}}
  }
  void poll();
 }
 function finish(timings,message='本次请求已返回'){
  const elapsed=Math.max(0,performanceNow()-startedTick);operation=null;generation++;clearTimers();wait.hidden=false;wait.textContent=`${message} · 页面等待 ${(elapsed/1000).toFixed(2)} 秒`;
  timing.replaceChildren();const labels={gatewayQueueMs:'网关排队',initialWalletCheckMs:'初始钱包核对',walletCheckMs:'钱包检查',quoteSimulationMs:'报价与模拟',walletPreviewMs:'钱包预览',walletAuthorizationMs:'最终钱包核对',protocolCheckMs:'合约复核',executionCheckMs:'执行前复核（并行合计）',submissionMs:'提交请求',totalMs:'工作进程处理合计',gatewayTotalMs:'网关请求合计（含排队）'};
  for(const[key,label]of Object.entries(labels)){const ms=timings?.[key];if(typeof ms==='number'&&Number.isFinite(ms)&&ms>=0)timing.append(node('dt','',label),node('dd','',`${(ms/1000).toFixed(2)} 秒`));}
  timing.hidden=!timing.childElementCount;
 }
 return{limitBps,showRisk,start,finish,setBusy(value){input.disabled=value;},clearRisk(){showRisk(null);},stop(){operation=null;generation++;clearTimers();}};
};
