import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { createDemo } from '../src/demo.mjs';
import { createTradeService } from '../src/trades.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const insightsScript = await readFile(new URL('../public/token-insights.js', import.meta.url),'utf8');
const detailScript = await readFile(new URL('../public/token-detail.js', import.meta.url), 'utf8');
const fairScript = await readFile(new URL('../public/fair-progress.js', import.meta.url), 'utf8');
const feedbackScript = await readFile(new URL('../public/trade-feedback.js', import.meta.url), 'utf8');
const routeScript = await readFile(new URL('../public/trade-route.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 18; i++) await new Promise(setImmediate); };

async function page({ wrap = false, approval=false,markets, position, deferCandles = false,deferPositions=false,holdBackground=false,orders,executeRisk,previewWallet,clock=Date,directOrders=false,liveClosed=false,bnbRoutes=false,routeResponse=false,sessionState,stream=false,deferTokens=false } = {}) {
  const { window, document } = parseHTML(html);
  window.location = { origin: 'http://127.0.0.1:4319' }; window.innerWidth = 1400;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  document.getElementById('bonding-only').checked = false;
  const demo = createDemo();
  const originalWallet=demo.baw.wallet;let backendWallet=null;demo.baw.wallet=async()=>({...await originalWallet(),...(backendWallet?{address:backendWallet}:{})});
  if (wrap) demo.protocol.buildTrade = async input => ({ kind: 'wrap', transaction: { from: input.walletAddress, to: '0x0000000000000000000000000000000000000009', value: '100', data: '0xd0e30db0' }, summary: { platformId: 'gang', quoteSymbol: 'WBNB',amount:input.amount, action: '本次仅包装，完成后重新预览买入' } });
  if(approval)demo.protocol.buildTrade=async input=>({kind:'approve',transaction:{from:input.walletAddress,to:input.token,value:'0',data:'0x'},summary:{spender:'0x'+'c'.repeat(40),allowance:'123.45',action:'仅授权本次卖出数量'}});
  const trades = createTradeService({ ...demo, demo: !liveClosed });
  if(bnbRoutes)demo.protocol.planRoute=async input=>input.settlement==='bnb'?{input,walletAddress:input.walletAddress,kind:'bnb-sequential',deadline:Math.floor(Date.now()/1000)+120,summary:{tradeRisk:{status:'ok',priceImpactBps:20,limitBps:300},estimatedShares:'123',minShares:'120'},steps:[{label:'BNB → QQQB',status:'PLANNED'},{label:'QQQB → 目标份额',status:'PLANNED'}]}:null;
  const requests = [], chartSeries = [], candleWaiters = [],backgroundWaiters=[],positionWaiters=[],tokenWaiters=[];let executed=false;
  let liveCallbacks=null,streamStopped=false;
  if(stream)window.createLiveUpdates=options=>{liveCallbacks=options;return{start(){},stop(){streamStopped=true;},reset(){},update(){}};};
  window.AgentCandleChart = { create: () => ({ setData: value => chartSeries.push(value), clear() {} }) };
  const fetcher = async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ path, body });
    if(holdBackground&&executed&&['/api/tokens','/api/wallet','/api/orders'].includes(path))return new Promise(resolve=>backgroundWaiters.push(()=>resolve({ok:true,json:async()=>path==='/api/orders'?{orders:trades.list()}:path==='/api/wallet'?await demo.baw.wallet():demo.monitor.snapshot()})));
    let result;
    if (path === '/api/session') result = { csrf: 'test', mode: liveClosed?'live':'demo', liveExecution: !liveClosed,...(directOrders?{liveExecutionAllowed:!liveClosed,capabilities:{directOrders:true,bnbRoutes}}:{}),...sessionState };
    else if (path === '/api/tokens') { if(deferTokens&&requests.filter(r=>r.path===path).length>1) await new Promise((resolve,reject)=>tokenWaiters.push({resolve,reject})); result = demo.monitor.snapshot(); if (markets) result.tokens = markets; }
    else if (path === '/api/wallet'||path==='/api/wallet?refresh=1') result = await demo.baw.wallet();
    else if (path === '/api/orders') result = { orders: orders||trades.list() };
    else if (path.startsWith('/api/positions?')) {result = { ...await demo.protocol.positions(new URL(path, window.location.origin).searchParams.get('token'), (await demo.baw.wallet()).address), ...position, updatedAt: new Date().toISOString() };if(deferPositions)await new Promise(resolve=>positionWaiters.push(resolve));}
    else if (path === '/api/preview') {result = await trades.preview(body);if(previewWallet)result.walletAddress=previewWallet;}
    else if (path === '/api/execute') {if(executeRisk)return{ok:false,json:async()=>({error:'执行前深度变化',tradeRisk:executeRisk})};result=await trades.execute(body);executed=true;}
    else if (path === '/api/order') {result=routeResponse?{intentId:body.intentId,walletAddress:body.expectedWallet,demo:!liveClosed,submitted:true,status:'ROUTE_RUNNING',route:{input:body.input,steps:[{label:'BNB → QQQB',status:'PLANNED'}]},order:{id:'route-in-flight',demo:!liveClosed,kind:'route',amount:body.input.amount,side:body.input.side,token:body.input.token,status:'ROUTE_RUNNING',steps:[{label:'BNB → QQQB',status:'BROADCASTED',txHash:'0x'+'a'.repeat(64)}]}}:await trades.place(body.input,{intentId:body.intentId,expectedWallet:body.expectedWallet});executed=result.submitted;}
    else if(path==='/api/settings/execution')result={liveExecution:false,liveExecutionAllowed:false};
    else if (path === '/api/trade-progress') result=trades.progress();
    else if (path.startsWith('/api/token-insights?')) result=await demo.insights.get(new URL(path,window.location.origin).searchParams.get('token'));
    else if (path.startsWith('/api/candles?')) {
      if (deferCandles) result = await new Promise(resolve => candleWaiters.push(resolve));
      else { const q = new URL(path, window.location.origin); result = await demo.charts.get(q.searchParams.get('token'), q.searchParams.get('interval'),q.searchParams.get('mode')||'price'); }
    }
    else throw new Error(`unexpected API ${path}`);
    return { ok: true, json: async () => result };
  };
  const ctx = vm.createContext({ window, document, navigator: {}, crypto:webcrypto,fetch: fetcher, AbortController, URL, Date:clock, Intl, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, console });
  vm.runInContext(insightsScript, ctx); vm.runInContext(fairScript,ctx);vm.runInContext(detailScript, ctx); if(executeRisk)vm.runInContext(feedbackScript,ctx);if(bnbRoutes)vm.runInContext(routeScript,ctx);vm.runInContext(script, ctx); await settle();
  return { document, window, requests, tokenWaiters, chartSeries, candleWaiters,backgroundWaiters,positionWaiters,trades,liveCallbacks,streamStopped:()=>streamStopped,setWallet:address=>backendWallet=address, $: id => document.getElementById(id), row: symbol => [...document.querySelectorAll('#token-rows .token-card')].find(r => r.textContent.includes(symbol)) };
}

test('shared market pushes update changed cards while retaining untouched DOM and never submit orders',async()=>{
 const tokens=createDemo().monitor.snapshot().tokens,p=await page({markets:tokens,stream:true,liveClosed:true});
 assert.ok(p.liveCallbacks,'app starts shared updates');
 const before=new Map([...p.document.querySelectorAll('.token-card')].map(row=>[row.dataset.token,row]));
 p.liveCallbacks.onMarket({tokens,monitor:{status:'live'}});p.liveCallbacks.onState({channel:'market',state:'live'});
 for(const row of p.document.querySelectorAll('.token-card'))assert.equal(row,before.get(row.dataset.token),'unchanged market keeps its card');
 const changed=tokens.map((token,index)=>index===0?{...token,price:'123.456'}:token);p.liveCallbacks.onMarket({tokens:changed,monitor:{status:'live'}});
 const first=changed[0].address.toLowerCase();assert.notEqual(p.document.querySelector(`[data-token="${first}"]`),before.get(first));
 for(const row of p.document.querySelectorAll('.token-card'))if(row.dataset.token!==first)assert.equal(row,before.get(row.dataset.token));
 assert.match(p.$('connection-label').textContent,/实时推送/);assert.equal(p.requests.some(r=>['/api/order','/api/execute'].includes(r.path)),false);
 p.window.dispatchEvent(new p.window.Event('pagehide'));assert.equal(p.streamStopped(),true);
});

test('a rejected obsolete tokens poll cannot block newer healthy streamed market controls',async()=>{
 const tokens=createDemo().monitor.snapshot().tokens,p=await page({stream:true,deferTokens:true});
 p.$('refresh-button').click();await settle();
 assert.equal(p.tokenWaiters.length,1,'fallback read is pending');
 p.liveCallbacks.onMarket({tokens,monitor:{status:'live'}});p.liveCallbacks.onState({channel:'market',state:'live'});
 const row=p.row('SIGNAL');assert.equal(row.querySelector('.row-action').disabled,false);
 row.querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';p.$('amount-input').dispatchEvent(new p.window.Event('input'));
 assert.equal(p.$('preview-button').disabled,false);const healthyRow=p.row('SIGNAL');
 p.tokenWaiters[0].reject(Error('obsolete polling outage'));await settle();
 assert.equal(p.row('SIGNAL')===healthyRow,true,'obsolete failure retains healthy card');
 assert.equal(p.row('SIGNAL').querySelector('.row-action').disabled,false);
 assert.equal(p.$('preview-button').disabled,false,'healthy market still permits its existing preview');
 assert.doesNotMatch(p.$('connection-label').textContent,/连接需检查/);
 assert.doesNotMatch(p.document.body.textContent,/obsolete polling outage/);
 assert.equal(p.requests.some(r=>['/api/execute','/api/order'].includes(r.path)),false);
});

test('BNB route input and read-only steps are wired into one-click form without platform confirmation',async()=>{
 const p=await page({directOrders:true,liveClosed:true,bnbRoutes:true});
 const row=[...p.document.querySelectorAll('#token-rows .token-card')].find(r=>r.textContent.includes('QQQB'));assert.ok(row);row.querySelector('.row-action').click();await settle();
 assert.equal(p.$('route-currency-control').hidden,false);assert.equal(p.$('amount-unit').textContent,'BNB');
 p.$('amount-input').value='0.01';p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 const sent=p.requests.find(r=>r.path==='/api/order');assert.equal(sent.body.input.settlement,'bnb');assert.equal(sent.body.input.amount,'0.01');assert.match(p.$('trade-route-plan').textContent,/BNB → QQQB/);assert.equal(p.$('preview-panel').hidden,true);assert.equal(p.trades.list().length,0);
 p.document.querySelector('[data-settlement="quote"]').click();assert.equal(p.$('amount-input').value,'');assert.equal(p.$('amount-unit').textContent,'QQQB');assert.equal(p.$('trade-route-plan').hidden,true);
});
test('submitted route never renders an unsent preview and uses actual step progress',async()=>{
 const p=await page({directOrders:true,bnbRoutes:true,routeResponse:true,holdBackground:true});p.row('NOVA').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 assert.equal(p.$('trade-route-plan').hidden,true);assert.match(p.$('order-list').textContent,/已广播/);assert.doesNotMatch(p.$('order-list').textContent,/路线仅预演|尚未执行/);
});
test('policy downgrade or unknown worker state preserves a working explicit stop control',async()=>{
 for(const liveExecution of [true,null]){
  const p=await page({directOrders:true,bnbRoutes:true,sessionState:{mode:'live',liveExecution,liveExecutionAllowed:false,capabilities:{directOrders:true,bnbRoutes:true,liveExecutionAllowed:false},executionRollout:{stopRequired:liveExecution===true,repairRequired:true}}});
  assert.equal(p.$('execution-toggle').disabled,false);p.$('execution-toggle').click();await settle();assert.equal(p.requests.find(r=>r.path==='/api/settings/execution').body.enabled,false);
 }
});
test('direct-order page submits once without the platform preview dialog or checkbox',async()=>{
 const p=await page({directOrders:true,holdBackground:true});p.row('SIGNAL').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';
 assert.match(p.$('preview-button').textContent,/模拟买入/);
 p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 assert.equal(p.requests.filter(r=>r.path==='/api/order').length,1);assert.equal(p.requests.some(r=>['/api/preview','/api/execute'].includes(r.path)),false);assert.equal(p.$('preview-panel').hidden,true);assert.equal(p.$('confirm-preview').checked,false);assert.match(p.$('order-list').textContent,/模拟完成/);assert.equal(p.$('amount-input').disabled,false);
 p.backgroundWaiters.forEach(resolve=>resolve());await settle();
});
test('closed live direct-order page clearly reports a read-only result without a fake fill',async()=>{
 const p=await page({directOrders:true,liveClosed:true});p.row('SIGNAL').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 assert.equal(p.requests.filter(r=>r.path==='/api/order').length,1);assert.match(p.$('direct-order-status').textContent,/仅预演.*未提交/);assert.equal(p.$('preview-panel').hidden,true);assert.doesNotMatch(p.$('order-list').textContent,/模拟完成|成交成功/);
});
test('configured card quick buy and sell use visible presets and one captured input',async()=>{
 const p=await page({directOrders:true});p.$('quick-buy-value').value='0.01';p.$('quick-sell-value').value='25';p.$('card-quick-enabled').checked=true;p.$('card-quick-enabled').dispatchEvent(new p.window.Event('change'));await settle();
 p.row('SIGNAL').querySelector('.row-action').click();await settle();let calls=p.requests.filter(r=>r.path==='/api/order');assert.equal(calls.length,1);assert.equal(calls[0].body.input.amount,'0.01');assert.equal(calls[0].body.input.side,'buy');
 p.row('SIGNAL').querySelector('.row-action.sell').click();await settle();calls=p.requests.filter(r=>r.path==='/api/order');assert.equal(calls.length,2,JSON.stringify({error:p.$('trade-error').textContent,position:p.$('position-error').textContent,amount:p.$('amount-input').value,disabled:p.$('preview-button').disabled,paths:p.requests.map(r=>r.path)}));assert.equal(calls[1].body.input.side,'sell');assert.notEqual(calls[1].body.intentId,calls[0].body.intentId);
});
test('direct setup action is displayed inline and never auto executes or masquerades as a swap',async()=>{
 const p=await page({directOrders:true,wrap:true});p.row('SIGNAL').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 assert.match(p.$('direct-order-status').textContent,/包装数量 0\.0000000000000001 BNB/);assert.doesNotMatch(p.$('direct-order-status').textContent,/包装数量 0\.01 BNB/);assert.equal(p.$('direct-setup-button').hidden,false);assert.equal(p.$('preview-panel').hidden,true);assert.equal(p.requests.some(r=>r.path==='/api/execute'),false);
 p.$('amount-input').value='0.02';p.$('amount-input').dispatchEvent(new p.window.Event('input'));assert.equal(p.$('direct-setup-button').hidden,true);
});
test('a backend wallet change cannot use the previous displayed wallet click to trade another wallet',async()=>{
 const p=await page({directOrders:true});p.row('SIGNAL').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';p.setWallet('0x'+'b'.repeat(40));p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 assert.equal(p.trades.list().length,0);assert.equal(p.requests.find(r=>r.path==='/api/order').body.expectedWallet.toLowerCase(),'0x000000000000000000000000000000000000dead');assert.match(p.$('trade-error').textContent,/钱包/);
});
test('quick sell cancels the original click when the wallet refresh changes while positions load',async()=>{
 const p=await page({directOrders:true,deferPositions:true});p.$('quick-sell-value').value='25';p.$('card-quick-enabled').checked=true;p.$('card-quick-enabled').dispatchEvent(new p.window.Event('change'));p.row('SIGNAL').querySelector('.row-action.sell').click();await settle();assert.equal(p.positionWaiters.length,1);
 p.setWallet('0x'+'b'.repeat(40));p.$('wallet-refresh').click();await settle();p.positionWaiters.forEach(resolve=>resolve());await settle();assert.equal(p.requests.some(r=>r.path==='/api/order'),false);assert.equal(p.trades.list().length,0);
});
test('explicit authorization shows asset, spender and exact allowance before a separate setup click',async()=>{
 const p=await page({directOrders:true,approval:true});p.row('SIGNAL').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 const text=p.$('direct-order-status').textContent;assert.match(text,/0xcccccccccccccccccccccccccccccccccccccccc/);assert.match(text,/123\.45/);assert.match(text,/钱包风险与权限/);assert.equal(p.requests.some(r=>r.path==='/api/execute'),false);
});

test('verified graduated merged markets open trade previews while unsupported graduated markets remain disabled',async()=>{
 const base=createDemo().monitor.snapshot().tokens[1];
 const p=await page({markets:[{...base,symbol:'NEWPOOL',pad:'merged',launchType:'curve-v3',phase:'graduated',tradable:true},{...base,address:'0x'+'a'.repeat(40),symbol:'OLDPOOL',phase:'graduated',tradable:false}]});
 assert.equal(p.row('NEWPOOL').querySelector('.row-action').disabled,false);assert.equal(p.row('OLDPOOL').querySelector('.row-action').disabled,true);
 assert.doesNotMatch(p.row('NEWPOOL').textContent,/外盘暂未接入/);
});
test('Fair sell percentages floor to complete redeemable shares and show the actual token amount',async()=>{
 const base=createDemo().monitor.snapshot().tokens[1],p=await page({markets:[{...base,symbol:'NEWMINT',pad:'merged',launchType:'fair',phase:'bonding',tradable:true}],position:{balance:'150000000000000000000000',decimals:18,positionKind:'token',sellUnitRaw:'50000000000000000000000',fairShares:'3'}});
 p.row('NEWMINT').querySelectorAll('.row-action')[1].click();await settle();p.$('amount-input').value='50';p.$('amount-input').dispatchEvent(new p.window.Event('input',{bubbles:true}));await settle();
 assert.match(p.$('sell-estimate').textContent,/50000/);assert.match(p.$('sell-estimate').textContent,/整份/);
 p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(p.requests.find(r=>r.path==='/api/preview').body.amount,'50000');
});

test('Fair cards show subscription metrics and opening details receives only the current wallet position',async()=>{
 const base=createDemo().monitor.snapshot().tokens[1],fairSale={verified:true,soldShares:'200',totalShares:'10000',remainingShares:'9800',walletCapShares:'100',sharePrice:'0.0005',sharePriceRaw:'500000000000000',tokensPerShare:'50000.0',subscribedPrincipal:'0.1',targetPrincipal:'5.0',mintFeeBps:100,exitFeeBps:100,sourceBlock:123};
 const p=await page({markets:[{...base,symbol:'FAIR',pad:'merged',launchType:'fair',fairSale,phase:'bonding'}],position:{fairShares:'3',fairPrincipal:'0.0015',fairPrincipalRaw:'1500000000000000'}});
 assert.equal(p.row('FAIR').querySelector('.price-cell .metric-label').textContent,'每份价格');assert.match(p.row('FAIR').textContent,/200.*10,000/);p.row('FAIR').querySelector('.avatar-trigger').click();await settle();assert.equal(p.$('fair-progress-panel').hidden,false);assert.match(p.$('fair-my-shares').textContent,/3 份/);assert.match(p.$('fair-my-principal').textContent,/0.0015 WBNB/);assert.equal(p.requests.some(r=>r.path.startsWith('/api/candles?')),false);
});

test('a preview from a changed wallet cannot be confirmed against the stale displayed wallet',async()=>{
 const p=await page({previewWallet:'0x'+'b'.repeat(40)});p.row('SIGNAL').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(p.$('preview-panel').hidden,true);assert.equal(p.$('execute-button').disabled,true);assert.match(p.$('trade-error').textContent,/钱包.*变化/);assert.equal(p.requests.some(r=>r.path==='/api/execute'),false);
});

test('execution risk rejection replaces old preview figures with fresh blocked data',async()=>{
 const p=await page({executeRisk:{status:'blocked',priceImpactBps:900,limitBps:300,depthVerified:false,quoteSymbol:'BNB',outputSymbol:'SIGNAL',estimatedNetOutput:null,minimumNetOutput:null,blockReasons:['执行前实际储备不足']}});p.row('SIGNAL').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();p.$('confirm-preview').checked=true;p.$('confirm-preview').dispatchEvent(new p.window.Event('change'));p.$('execute-button').click();await settle();assert.match(p.$('trade-risk-panel').textContent,/已拦截/);assert.match(p.$('trade-risk-panel').textContent,/9%/);assert.match(p.$('trade-risk-panel').textContent,/执行前实际储备不足/);assert.equal(p.$('preview-panel').hidden,true);
});

test('orders distinguish request duration, chain waiting and unknown submission without inventing a fill',async()=>{
 const now=Date.now();const clock=class extends Date {static now(){return now;}};
 const base={side:'buy',amount:'0.01',platformId:'four',token:'0x1',createdAt:new Date().toISOString(),timings:{totalMs:1250}};
 const p=await page({clock,orders:[{...base,id:'chain',status:'BROADCASTED',submittedAt:new Date(now-10000).toISOString()},{...base,id:'unknown',status:'UNKNOWN'},{...base,id:'done',status:'CONFIRMED',confirmedAt:new Date().toISOString(),timings:{totalMs:1250,confirmationWaitMs:4500}}]});
 const rows=[...p.document.querySelectorAll('.order-row')];assert.match(rows[0].textContent,/执行阶段处理（不含此前准备\/排队） 1\.25 秒/);assert.match(rows[0].textContent,/链上等待 10\./);assert.match(rows[0].textContent,/尚未确认/);assert.match(rows[1].textContent,/提交结果未知/);assert.doesNotMatch(rows[1].textContent,/链上等待/);assert.match(rows[2].textContent,/链上确认耗时 4\.50 秒/);
});

test('execute response releases request busy state while background wallet and market reads are still pending',async()=>{
 const p=await page({holdBackground:true});p.row('SIGNAL').querySelector('.row-action').click();await settle();p.$('amount-input').value='0.01';
 p.$('trade-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await settle();p.$('confirm-preview').checked=true;p.$('confirm-preview').dispatchEvent(new p.window.Event('change'));p.$('execute-button').click();await settle();
 assert.ok(p.backgroundWaiters.length>0,'asset display refresh is still pending');assert.equal(p.$('preview-panel').hidden,true);assert.equal(p.$('drawer-close').disabled,false);assert.equal(p.$('amount-input').disabled,false);assert.match(p.$('order-list').textContent,/模拟完成/);assert.equal(p.requests.filter(r=>r.path==='/api/execute').length,1);
 p.$('execute-button').click();await settle();assert.equal(p.requests.filter(r=>r.path==='/api/execute').length,1,'consumed preview cannot resubmit');p.backgroundWaiters.forEach(resolve=>resolve());await settle();
});

test('actual page filters three platforms and puts the matching logo on each token avatar', async () => {
  const p = await page();
  assert.equal(p.document.querySelectorAll('#token-rows .token-card').length, 5);
  assert.equal(p.$('count-all').textContent, '5');
  p.document.querySelector('[data-platform="gang"]').click();
  assert.equal(p.document.querySelectorAll('#token-rows .token-card').length, 1);
  assert.equal(p.document.querySelector('#token-rows .platform-mark img').getAttribute('src'), '/assets/platform-gang.svg');
  p.document.querySelector('[data-platform="flap"]').click();
  assert.equal(p.document.querySelectorAll('#token-rows .token-card').length, 2);
  assert.ok([...p.document.querySelectorAll('#token-rows .platform-mark img')].every(i => i.getAttribute('alt') === 'Flap'));
});

test('Gang launch type appears on cards and details independently of graduation, tax and asset kind',async()=>{
  const base=createDemo().monitor.snapshot().tokens[1];
  const markets=[
    {...base,address:`0x${'a'.repeat(40)}`,symbol:'NEWCURVE',name:'New curve',launchType:'curve-v3',launchTypeLabel:'untrusted label',pad:'merged',phase:'bonding'},
    {...base,address:`0x${'b'.repeat(40)}`,symbol:'NEWFAIR',name:'New fair',launchType:'fair',pad:'merged',phase:'graduated',tradable:false,priceSource:'verified-pool'},
    {...base,address:`0x${'c'.repeat(40)}`,symbol:'LEGACY',name:'Legacy curve',pad:'v2'},
    {...base,address:`0x${'d'.repeat(40)}`,symbol:'OTHER',name:'Other platform',platformId:'four',launchType:'fair'},
  ];
  const p=await page({markets});
  assert.equal(p.row('NEWCURVE').querySelector('.token-launch-type')?.textContent,'V3 曲线');
  assert.equal(p.row('NEWFAIR').querySelector('.token-launch-type')?.textContent,'Fair 打新');
  assert.match(p.row('NEWFAIR').textContent,/已毕业/);
  assert.equal(p.row('NEWFAIR').querySelector('.price-cell .metric-label').textContent,'池子参考价');
  assert.equal(p.row('LEGACY').querySelector('.token-launch-type')?.textContent,'旧版 V2');
  assert.equal(p.row('OTHER').querySelector('.token-launch-type'),null);
  p.row('NEWFAIR').querySelector('.avatar-trigger').click();await settle();
  assert.equal(p.$('detail-launch-type')?.textContent,'Fair 打新');
  assert.equal(p.$('detail-launch-type').hidden,false);
  assert.equal(p.$('detail-phase').textContent,'已毕业');
  assert.equal(p.$('detail-kind').textContent,'ERC20 代币');
  assert.equal(p.$('detail-price-label')?.textContent,'池子参考价');
});

test('soon stage requires USD market cap strictly over 10k; progress cannot override cap or graduation', async () => {
  const base = createDemo().monitor.snapshot().tokens[0];
  const cap=value=>({value,unit:'USD',label:'FDV',source:'test'});
  const markets = [
    { ...base, address: '0x0000000000000000000000000000000000000011', symbol: 'LOW', progress: 79.99, marketCap:cap(9999.99) },
    { ...base, address: '0x0000000000000000000000000000000000000012', symbol: 'EXACT', progress: 99, marketCap:cap(10000) },
    { ...base, address: '0x0000000000000000000000000000000000000013', symbol: 'OVER', progress: 8, marketCap:cap(10000.01) },
    { ...base, address: '0x0000000000000000000000000000000000000014', symbol: 'HIGH', progress: null, marketCap:cap(25000) },
    { ...base, address: '0x0000000000000000000000000000000000000015', symbol: 'DONE', phase: 'graduated', progress: 100, tradable: false, marketCap:cap(50000) },
    { ...base, address: '0x0000000000000000000000000000000000000016', symbol: 'LAUNCHLOW', phase: 'launching', progress: 100, tradable: false, marketCap:cap(9000) },
    { ...base, address: '0x0000000000000000000000000000000000000017', symbol: 'UNKNOWN', progress: 100, marketCap:null },
    { ...base, address: '0x0000000000000000000000000000000000000018', symbol: 'NONUSD', progress: 95, marketCap:{...cap(200000),unit:'BNB'} },
    { ...base, address: '0x0000000000000000000000000000000000000019', symbol: 'INVALID', progress: 100, marketCap:cap(Infinity) },
    { ...base, address: '0x0000000000000000000000000000000000000020', symbol: 'LAUNCHHIGH', phase: 'launching', progress: 100, tradable: false, marketCap:cap(15000) },
  ];
  const p = await page({ markets });
  assert.equal(p.document.querySelectorAll('.stage-column').length, 3);
  assert.equal(p.$('stage-new-list').querySelectorAll('.token-card').length, 6);
  assert.equal(p.$('stage-soon-list').querySelectorAll('.token-card').length, 3);
  assert.equal(p.$('stage-graduated-list').querySelectorAll('.token-card').length, 1);
  assert.deepEqual([...p.$('stage-soon-list').querySelectorAll('.token-symbol')].map(x=>x.textContent),['LAUNCHHIGH','OVER','HIGH']);
  assert.match(p.$('stage-new-list').textContent,/EXACT/);assert.match(p.$('stage-new-list').textContent,/NONUSD/);
  assert.match(p.$('stage-soon').textContent,/市值.*>.*\$10K/);
  assert.equal(p.row('DONE').querySelector('.row-action').disabled, true);
  assert.ok(p.row('DONE').querySelector('a.official-market-link'));
});

test('soon stage ranks finite progress before cap and keeps unknown progress last', async () => {
  const base = createDemo().monitor.snapshot().tokens[0];
  const market = (symbol, progress, value, index, phase = 'bonding') => ({
    ...base, address: `0x${String(index).padStart(40, '0')}`, symbol, progress, phase,
    createdAt: '2026-10-27T00:00:00.000Z', marketCap: { value, unit: 'USD', label: 'FDV', source: 'test' },
  });
  const p = await page({ markets: [
    market('RICHER', 88, 90000, 1),
    market('NEARER', 99, 11000, 2),
    market('TIEHIGH', 88, 95000, 3),
    market('TIEFIRST', 77, 20000, 4),
    market('TIESECOND', 77, 20000, 5),
    market('NULL', null, 900000, 6),
    market('UNDEFINED', undefined, 800000, 7),
    market('NAN', NaN, 700000, 8),
    market('INFINITY', Infinity, 600000, 9),
    market('EMPTY', '', 500000, 10),
    market('ZERO', 0, 15000, 11),
    market('DONE', 100, 990000, 12, 'graduated'),
    market('LOWCAP', 100, 10000, 13),
  ] });
  assert.deepEqual([...p.$('stage-soon-list').querySelectorAll('.token-symbol')].map(x => x.textContent),
    ['NEARER', 'TIEHIGH', 'RICHER', 'TIEFIRST', 'TIESECOND', 'ZERO', 'NULL', 'UNDEFINED', 'NAN', 'INFINITY', 'EMPTY']);
  assert.equal(p.$('stage-graduated-list').querySelector('.token-symbol').textContent, 'DONE');
  assert.equal(p.$('stage-new-list').querySelector('.token-symbol').textContent, 'LOWCAP');
});

test('fresh market progress automatically reorders the soon stage', async () => {
  const base = createDemo().monitor.snapshot().tokens[0];
  const markets = [
    { ...base, address: '0x0000000000000000000000000000000000000031', symbol: 'LEADER', progress: 99, marketCap: { value: 50000, unit: 'USD' } },
    { ...base, address: '0x0000000000000000000000000000000000000032', symbol: 'ADVANCING', progress: 88, marketCap: { value: 15000, unit: 'USD' } },
  ];
  const p = await page({ markets });
  const symbols = () => [...p.$('stage-soon-list').querySelectorAll('.token-symbol')].map(x => x.textContent);
  assert.deepEqual(symbols(), ['LEADER', 'ADVANCING']);
  markets[1] = { ...markets[1], progress: 99.5 };
  p.$('refresh-button').click();
  await settle();
  assert.deepEqual(symbols(), ['ADVANCING', 'LEADER']);
});

test('search and inner-market filter update all stages and their counts without removing the third column', async () => {
  const p = await page();
  assert.equal(p.$('stage-graduated-count').textContent, '1');
  p.$('bonding-only').checked = true;
  p.$('bonding-only').dispatchEvent(new p.window.Event('change'));
  assert.equal(p.$('stage-graduated-count').textContent, '0');
  assert.equal(p.$('stage-graduated-empty').hidden, false);
  assert.equal(p.$('visible-count').textContent, '4');
  p.$('search-input').value = 'CIRCUIT';
  p.$('search-input').dispatchEvent(new p.window.Event('input'));
  assert.equal(p.$('visible-count').textContent, '1');
  assert.match(p.$('stage-new-list').textContent, /CIRCUIT/);
  assert.equal(p.$('stage-soon-count').textContent, '0');
});

test('buy and sell open the drawer; closing it discards a preview and leaves execution untouched', async () => {
  const p = await page();
  assert.equal(p.$('trade-drawer').hidden, true);
  p.row('SIGNAL').querySelector('.row-action').click(); await settle();
  assert.equal(p.$('trade-drawer').hidden, false);
  p.$('amount-input').value = '0.01';
  p.$('trade-form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(p.$('preview-panel').hidden, false);
  p.$('drawer-close').click();
  assert.equal(p.$('trade-drawer').hidden, true);
  assert.equal(p.$('preview-panel').hidden, true);
  assert.equal(p.requests.filter(r => r.path === '/api/execute').length, 0);
  p.$('wallet-open').click();
  assert.equal(p.$('trade-drawer').hidden, false);
});

test('Flap sell submits exact shares plus explicit percentage and preserves all four shortcuts', async () => {
  const p = await page();
  p.row('CIRCUIT').querySelector('.row-action.sell').click(); await settle();
  assert.equal(p.$('position-label').textContent, '持有市场份额');
  assert.match(p.$('selected-address').textContent, /^Market/);
  for (const [percent, amount] of [['10', '1234.567890123456789012'], ['25', '3086.41972530864197253'], ['50', '6172.839450617283945061'], ['100', '12345.678901234567890123']]) {
    p.document.querySelector(`[data-percent="${percent}"]`).click();
    assert.equal(p.$('amount-input').value, percent);
    assert.match(p.$('sell-estimate').textContent, new RegExp(amount.replace('.', '\\.')));
  }
  p.document.querySelector('[data-percent="25"]').click();
  p.$('trade-form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  const request = p.requests.find(r => r.path === '/api/preview').body;
  assert.equal(request.platformId, 'flap'); assert.equal(request.sellPercentBps, 2500);
  assert.equal(request.amount, '3086.41972530864197253');
  assert.equal(p.$('preview-panel').hidden, false);
});

test('switching WBNB to QQQB clears old input and preview; payment balance and presets use the selected quote', async () => {
  const p = await page();
  p.row('NEXUS').querySelector('.row-action').click(); await settle();
  p.$('amount-input').value = '0.1';
  assert.equal(p.$('amount-unit').textContent, 'WBNB');
  p.row('NOVA').querySelector('.row-action').click(); await settle();
  assert.equal(p.$('amount-input').value, ''); assert.equal(p.$('amount-unit').textContent, 'QQQB');
  assert.match(p.$('quote-balance').textContent, /10000 QQQB/);
  assert.equal(p.document.querySelector('[data-amount]').textContent, '10 QQQB');
  assert.equal(p.$('preview-panel').hidden, true);
});

test('WBNB preparation preview explicitly identifies the wrapping step', async () => {
  const p = await page({ wrap: true });
  p.row('NEXUS').querySelector('.row-action').click(); await settle();
  p.$('amount-input').value = '0.1';
  p.$('trade-form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(p.$('preview-title').textContent, 'BNB → WBNB 包装预览');
  assert.equal(p.$('execute-button').textContent, '确认模拟包装');
});

test('token name and avatar open the black-gold detail chart; intervals and back navigation work without executing', async () => {
  const p=await page(); p.row('SIGNAL').querySelector('.token-title').click(); await settle();
  assert.equal(p.$('token-detail').hidden,false); assert.equal(p.$('market').hidden,true);
  assert.match(p.$('detail-name').textContent,/Signal/);
  assert.equal(p.chartSeries.at(-1).length,96);
  p.document.querySelector('[data-chart-interval="5min"]').click(); await settle();
  assert.match(p.requests.filter(r=>r.path.startsWith('/api/candles')).at(-1).path,/interval=5min/);
  p.$('detail-back').click(); assert.equal(p.$('token-detail').hidden,true); assert.equal(p.$('market').hidden,false);
  p.row('NEXUS').querySelector('.avatar-trigger').click(); await settle();
  assert.match(p.$('detail-name').textContent,/Nexus/);
  assert.equal(p.requests.filter(r=>r.path==='/api/execute').length,0);
});

test('a late candle request from an old interval cannot replace the current chart or flash after going back', async () => {
  const p=await page({deferCandles:true}); p.row('SIGNAL').querySelector('.token-title').click(); await settle();
  p.document.querySelector('[data-chart-interval="5min"]').click(); await settle();
  const response=n=>({address:'0x0000000000000000000000000000000000000001',kind:'trades',sourceLabel:'TEST',priceUnit:'USD',updatedAt:new Date().toISOString(),candles:[{t:1793088000000,o:n,h:n,l:n,c:n,v:1}]});
  p.candleWaiters[1](response(5)); await settle();
  p.candleWaiters[0](response(1)); await settle();
  assert.equal(p.chartSeries.at(-1)[0].c,5);
  p.document.querySelector('[data-chart-interval="1h"]').click(); await settle(); p.$('detail-back').click();
  const length=p.chartSeries.length; p.candleWaiters[2](response(9));await settle();
  assert.equal(p.chartSeries.length,length);
});

test('board adds market cap and detail toggles price/FDV and second intervals without touching trade execution',async()=>{
 const p=await page();assert.match(p.row('SIGNAL').querySelector('.market-cap-cell').textContent,/市值/);
 p.row('NEXUS').querySelector('.token-title').click();await settle();
 p.document.querySelector('[data-chart-mode="marketcap"]').click();await settle();
 assert.match(p.requests.filter(r=>r.path.startsWith('/api/candles')).at(-1).path,/mode=marketcap/);
 assert.match(p.$('chart-title').textContent,/市值/);
 p.document.querySelector('[data-chart-interval="1s"]').click();await settle();
 assert.match(p.requests.filter(r=>r.path.startsWith('/api/candles')).at(-1).path,/interval=1s/);
 assert.match(p.$('chart-graduation').textContent,/毕业/);
 assert.equal(p.requests.filter(r=>r.path==='/api/execute').length,0);
});

test('card dossier fields and verified Dev history navigate through the existing token-selection guards without executing',async()=>{
 const p=await page();assert.match(p.row('NEXUS').querySelector('.card-facts').textContent,/税 1% \/ 1%.*外盘.*底币 WBNB.*平台费 1%.*Dev/);
 p.row('NEXUS').querySelector('.avatar-trigger').click();await settle();assert.equal(p.$('token-insights').hidden,false);assert.match(p.$('insights-content').textContent,/全部为独立演示/);
 const target=[...p.document.querySelectorAll('.insights-select')].find(x=>x.textContent.includes('SIGNAL'));assert.ok(target);target.click();await settle();assert.match(p.$('detail-symbol').textContent,/SIGNAL/);assert.equal(p.requests.filter(x=>x.path==='/api/execute').length,0);
 p.$('detail-back').click();assert.equal(p.$('token-insights').hidden,true);
});
