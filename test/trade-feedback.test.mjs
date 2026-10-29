import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const source=await readFile(new URL('../public/trade-feedback.js',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
function page(){
 const{window,document}=parseHTML(html),requests=[],timers=new Map();let clock=1000,n=0,changes=0;
 const api=(path,body,options)=>new Promise((resolve,reject)=>requests.push({path,body,options,resolve,reject}));
 const context=vm.createContext({window,document,AbortController,console,setTimeout(fn,ms){const id=++n;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},setInterval(fn,ms){const id=++n;timers.set(id,{fn,ms,interval:true});return id;},clearInterval(id){timers.delete(id);}});
 vm.runInContext(source,context);assert.equal(typeof window.createTradeFeedback,'function','trade feedback exists');
 const feedback=window.createTradeFeedback({api,now:()=>clock,onLimitChange:()=>changes++});
 return{window,document,feedback,requests,timers,advance(ms){clock+=ms;},changes:()=>changes,$:id=>document.getElementById(id)};
}
const risk={status:'warning',limitBps:300,priceImpactBps:125,priceImpactMethod:'已核验曲线',depthVerified:true,realQuoteReserve:'2.000000000000000001',virtualQuoteReserve:'100',curveQuoteLiquidity:'102',quoteSymbol:'GANG',estimatedNetOutput:'0.123456789012345678',minimumNetOutput:'0.12',outputSymbol:'GANG',feeAmount:'0.001',feeSymbol:'GANG',nativeGasBudget:'0.000005',netAfterGas:null,warnings:['卖出到 GANG，需要另行换底币'],blockReasons:[]};

test('risk panel preserves exact output currency and separates real from virtual depth and Gas',()=>{
 const p=page();p.feedback.showRisk(risk);const text=p.$('trade-risk-panel').textContent;
 assert.match(text,/0\.123456789012345678 GANG/);assert.match(text,/2\.000000000000000001 GANG/);assert.match(text,/虚拟/);assert.match(text,/100 GANG/);assert.match(text,/1\.25%/);assert.match(text,/0\.000005 BNB/);assert.doesNotMatch(text,/0\.123456789012345678 BNB/);
});

test('partial Probe fee is labelled as a reported item rather than the full trading fee',()=>{
 const p=page();p.feedback.showRisk({...risk,feeScope:'probe-reported-fee'});const text=p.$('trade-risk-panel').textContent;
 assert.match(text,/探针报告费用0\.001 GANG/);assert.doesNotMatch(text,/已知交易费用/);
});

test('unknown and blocked risk data never become zero, safe, or a fabricated net BNB value',()=>{
 const p=page();p.feedback.showRisk({...risk,status:'blocked',priceImpactBps:null,realQuoteReserve:null,virtualQuoteReserve:null,depthVerified:false,estimatedNetOutput:null,warnings:['<img src=x onerror=bad>'],blockReasons:['深度未核验']});
 const panel=p.$('trade-risk-panel');assert.match(panel.textContent,/未知|未核验/);assert.match(panel.textContent,/已拦截|阻止/);assert.match(panel.textContent,/深度未核验/);assert.equal(panel.querySelectorAll('img,script,iframe').length,0);assert.doesNotMatch(panel.textContent,/0%|0 GANG|安全/);
});

test('unverified quote transfer shows nominal contract outputs separately from unknown net receipts',()=>{
 const p=page();p.feedback.showRisk({...risk,estimatedNetOutput:null,minimumNetOutput:null,contractQuotedOutput:'0.9801',contractMinimumOutput:'0.970299'});const text=p.$('trade-risk-panel').textContent;
 assert.match(text,/预计净收到未知/);assert.match(text,/最低收到未知/);assert.match(text,/合约报价 · 未扣转账税0\.9801 GANG/);assert.match(text,/合约最低值 · 非净到账保证0\.970299 GANG/);
});

test('impact limit is independent from slippage, validates exact bps and invalidates old preview on change',()=>{
 const p=page();assert.equal(p.feedback.limitBps(),300);p.$('impact-limit-input').value='1.25';p.$('impact-limit-input').dispatchEvent(new p.window.Event('change'));assert.equal(p.feedback.limitBps(),125);assert.equal(p.changes(),1);assert.equal(p.$('slippage-input').value,'50');
 for(const [value,bps] of [['0.55',55],['1.1',110],['1.15',115],['1.23',123],['2.3',230]]){p.$('impact-limit-input').value=value;assert.equal(p.feedback.limitBps(),bps);}
 assert.equal(p.$('impact-limit-input').step,'0.01');
 p.$('impact-limit-input').value='6';assert.throws(()=>p.feedback.limitBps(),/0.5.*5/);p.feedback.setBusy(true);assert.equal(p.$('impact-limit-input').disabled,true);
});

test('active request displays elapsed time and server stage; completion stops polls and rejects late stage response',async()=>{
 const p=page();p.feedback.start('preview');assert.equal(p.requests[0].path,'/api/trade-progress');
 p.requests[0].resolve({operation:'preview',stage:'quote-simulation',startedAt:1000,elapsedMs:500});await flush();p.advance(2500);for(const timer of p.timers.values())if(timer.interval)timer.fn();
 assert.match(p.$('trade-wait-status').textContent,/报价|模拟/);assert.match(p.$('trade-wait-status').textContent,/2\.5/);
 const poll=[...p.timers.values()].find(t=>!t.interval);poll.fn();const late=p.requests.at(-1);p.feedback.finish({walletCheckMs:100,quoteSimulationMs:500,walletPreviewMs:200,totalMs:800},'预览已就绪');late.resolve({operation:'preview',stage:'wallet-preview',startedAt:1000,elapsedMs:3000});await flush();
 assert.match(p.$('trade-wait-status').textContent,/预览已就绪/);assert.doesNotMatch(p.$('trade-wait-status').textContent,/正在/);assert.match(p.$('trade-timings').textContent,/0\.50/);assert.equal(p.timers.size,0);
});
