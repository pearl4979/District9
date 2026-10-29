import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {parseHTML} from 'linkedom';
const source=await readFile(new URL('../public/trade-route.js',import.meta.url),'utf8').catch(()=> '');
const token={platformId:'gang',pad:'merged',phase:'bonding',quoteSymbol:'GANG',quoteAsset:'0x'+'1'.repeat(40),symbol:'TEST'};
function page(){const{window,document}=parseHTML('<form id="trade-form"><div class="field-heading"></div><button id="preview-button"></button></form>');const changes=[];vm.runInContext(source,vm.createContext({window,document}));assert.equal(typeof window.createTradeRouteView,'function');const view=window.createTradeRouteView({onChange:s=>changes.push(s)});return{window,document,view,changes};}
test('BNB selection identifies buy budget while sell keeps token units; unsupported WBNB sell stays quote',()=>{
 const p=page();p.view.update({token,side:'buy',enabled:true});assert.equal(p.view.settlement(token,'buy'),'bnb');assert.match(p.document.getElementById('route-currency-label').textContent,/支付/);
 p.document.querySelector('[data-settlement="quote"]').click();assert.equal(p.view.settlement(token,'buy'),'quote');assert.deepEqual(p.changes,['quote']);
 p.view.update({token,side:'sell',enabled:true});assert.match(p.document.getElementById('route-currency-label').textContent,/到账/);
 assert.equal(p.view.settlement({...token,quoteSymbol:'WBNB',quoteAsset:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'},'sell'),'quote');
});
test('read-only route shows planned steps without a fake fill and escapes symbols',()=>{
 const p=page();p.view.showPlan({summary:{estimatedTokens:'100',minTokens:'99',symbol:'<img onerror=x>',estimatedGasReserve:'0.001'},steps:[{label:'BNB → GANG',status:'PLANNED'},{label:'GANG → TEST',status:'PLANNED'}]});
 const el=p.document.getElementById('trade-route-plan');assert.match(el.textContent,/仅预演|未执行/);assert.match(el.textContent,/BNB → GANG/);assert.equal(el.querySelector('img'),null);assert.doesNotMatch(el.textContent,/成交成功|整条.*完成/);p.view.clear();assert.equal(el.hidden,true);
});
test('partial route displays retained asset, wallet balance timestamp and safe per-step transaction links',()=>{
 const p=page();const el=p.view.renderOrder({status:'ROUTE_PAUSED',steps:[{label:'兑换底币',status:'CONFIRMED',txHash:'0x'+'a'.repeat(64)},{label:'购买目标',status:'STOPPED',error:'价格变化'}],retainedBalances:[{symbol:'GANG',amount:'25',walletBalanceRaw:'26000000000000000000',decimals:18,observedAt:'2026-10-28T00:00:00.000Z'}]});
 assert.match(el.textContent,/25 GANG/);assert.match(el.textContent,/观察|快照/);assert.match(el.textContent,/后续步骤未完成/);assert.equal(el.querySelector('a').href,'https://bscscan.com/tx/0x'+'a'.repeat(64));assert.match(el.textContent,/价格变化/);
});
