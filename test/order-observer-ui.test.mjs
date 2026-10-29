import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
const source=await readFile(new URL('../public/order-observer.js',import.meta.url),'utf8').catch(()=> '');
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
function page(){
 const {window,document}=parseHTML('<p></p>');let owner='a',online=true,visible=true,clock=0;const calls=[],renders=[],receipts=[],statuses=[],timers=new Map();let seq=0;
 const context=vm.createContext({window,document,AbortController,performance:{now:()=>clock},setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)});vm.runInContext(source,context);
 assert.equal(typeof window.createOrderObserver,'function');
 const observer=window.createOrderObserver({api:(path,body,options)=>new Promise((resolve,reject)=>calls.push({path,options,resolve,reject})),getOwner:()=>owner,isActive:()=>online&&visible,onOrders:x=>renders.push(x),onReceipt:x=>receipts.push(x),onStatus:x=>statuses.push(x)});
 return {window,document,calls,renders,receipts,statuses,timers,observer,setOwner:x=>{owner=x;observer.update();},hide(){visible=false;observer.update();},show(){visible=true;observer.update();},offline(){online=false;observer.update();},advance:ms=>clock+=ms,async run(){const[id,t]=timers.entries().next().value;timers.delete(id);t.fn();await flush();}};
}
const pending={id:'one',status:'BROADCASTED',txHash:'0x'+'a'.repeat(64)};
test('only pending hash uses fast reads and a successful receipt triggers one asset refresh',async()=>{
 const p=page();p.observer.start();await p.run();p.calls[0].resolve({orders:[pending]});await flush();assert.equal([...p.timers.values()][0].ms,500);
 await p.run();p.calls[1].resolve({orders:[{...pending,status:'MINED',receiptStatus:1,firstReceiptObservedAt:'first'}]});await flush();assert.equal(p.receipts.length,1);assert.equal([...p.timers.values()][0].ms,500);
 await p.run();p.calls[2].resolve({orders:[{...pending,status:'CONFIRMED',receiptStatus:1,firstReceiptObservedAt:'first'}]});await flush();assert.equal(p.receipts.length,2);assert.equal([...p.timers.values()][0].ms,5000);
 p.observer.stop();assert.equal(p.timers.size,0);
});
test('owner change aborts old read and late data cannot repaint or refresh the new owner',async()=>{
 const p=page();p.observer.start();await p.run();const old=p.calls[0];p.setOwner('b');assert.equal(old.options.signal.aborted,true);
 old.resolve({orders:[{...pending,status:'MINED',receiptStatus:1}]});await flush();assert.equal(p.renders.length,0);assert.equal(p.receipts.length,0);
 await p.run();p.calls.at(-1).resolve({orders:[]});await flush();assert.equal(p.renders.length,1);p.observer.stop();
});
test('hidden or offline tabs stop reads; failures back off and App pending never looks broadcast',async()=>{
 const p=page();p.observer.start();await p.run();p.calls[0].reject(Error('429'));await flush();assert.equal([...p.timers.values()][0].ms,10000);
 p.hide();assert.equal(p.timers.size,0);p.show();await p.run();p.calls.at(-1).resolve({orders:[{id:'app',status:'PENDING_CONFIRMATION',txHash:null}]});await flush();assert.equal([...p.timers.values()][0].ms,2000);
 p.offline();assert.equal(p.timers.size,0);assert.equal(p.receipts.length,0);p.observer.stop();
});

test('a pre-submit read cannot erase the newly submitted order or replace its fast refresh',async()=>{
 const p=page();p.observer.start();await p.run();const old=p.calls[0];p.observer.seed([pending]);assert.equal(old.options.signal.aborted,true);
 old.resolve({orders:[]});await flush();assert.equal(p.renders.length,0);await p.run();p.calls.at(-1).resolve({orders:[pending]});await flush();assert.equal(p.renders.at(-1)[0].id,'one');assert.equal([...p.timers.values()][0].ms,500);p.observer.stop();
});
test('historical cached receipts never trigger automatic wallet refresh or rapid receipt polling',async()=>{
 const p=page();p.observer.start();await p.run();p.calls[0].resolve({orders:[pending],stale:true});await flush();assert.equal([...p.timers.values()][0].ms,15000);
 await p.run();p.calls[1].resolve({orders:[{...pending,status:'CONFIRMED',receiptStatus:1}],stale:true});await flush();assert.equal(p.receipts.length,0);assert.equal([...p.timers.values()][0].ms,15000);p.observer.stop();
});
test('persistent trade notices distinguish receipt success, pending, approvals and uncertain results',()=>{
 const {window,document}=parseHTML('<body></body>');vm.runInContext(source,vm.createContext({window,document}));
 assert.equal(typeof window.createTradeNotifications,'function');const notices=window.createTradeNotifications({getSymbol:()=> 'AGENT'});
 notices.update({...pending,side:'sell',kind:'sell'});assert.match(document.body.textContent,/已提交|等待/);assert.doesNotMatch(document.body.textContent,/卖出成功/);
 notices.update({...pending,side:'sell',kind:'sell',status:'CONFIRMED',receiptStatus:1});assert.match(document.body.textContent,/卖出成功.*AGENT/);assert.equal(document.querySelectorAll('.trade-notice').length,1);
 notices.update({...pending,id:'approval',kind:'approve',side:'sell',status:'CONFIRMED',receiptStatus:1});assert.match(document.body.textContent,/授权完成/);
 notices.update({...pending,id:'unknown',kind:'buy',side:'buy',status:'UNKNOWN'});assert.match(document.body.textContent,/勿重复/);assert.doesNotMatch(document.body.textContent,/买入成功/);
 notices.clear();assert.equal(document.querySelectorAll('.trade-notice').length,0);
});
test('new status notifications come from live transitions, never initial or cached historical success',async()=>{
 const p=page();p.observer.start();await p.run();p.calls.at(-1).resolve({orders:[{...pending,status:'CONFIRMED',receiptStatus:1}]});await flush();assert.equal(p.statuses.length,0);
 p.observer.seed([pending]);await p.run();p.calls.at(-1).resolve({orders:[{...pending,status:'CONFIRMED',receiptStatus:1}],stale:true});await flush();assert.equal(p.statuses.length,0);
 p.observer.seed([pending]);await p.run();p.calls.at(-1).resolve({orders:[{...pending,status:'CONFIRMED',receiptStatus:1}]});await flush();assert.equal(p.statuses.length,1);p.observer.stop();
});
test('automatic setup shows approval progress, then trade submission, without claiming an early sale',async()=>{
 const p=page(),route={id:'auto',kind:'route',side:'sell',status:'ROUTE_RUNNING',route:{kind:'single-setup'},steps:[{role:'approval',status:'WAITING_APPROVAL'},{role:'target',status:'PLANNED'}]};
 p.observer.seed([route]);p.observer.start();await p.run();
 p.calls.at(-1).resolve({orders:[route]});await flush();assert.equal([...p.timers.values()][0].ms,1000);
 await p.run();p.calls.at(-1).resolve({orders:[{...route,steps:[{role:'approval',status:'CONFIRMED'},{role:'target',status:'BROADCASTED',submissionAttempted:true}]}]});await flush();assert.equal(p.statuses.length,1);
 const {window,document}=parseHTML('<body></body>');vm.runInContext(source,vm.createContext({window,document}));const notices=window.createTradeNotifications();notices.update(route);assert.match(document.body.textContent,/授权/);assert.doesNotMatch(document.body.textContent,/卖出已提交|卖出成功/);
 notices.update(p.statuses[0]);assert.match(document.body.textContent,/卖出已提交/);
 await p.run();p.calls.at(-1).resolve({orders:[{...route,status:'CONFIRMED',steps:route.steps.map(s=>({...s,status:'CONFIRMED'}))}]});await flush();assert.equal(p.receipts.length,1);p.observer.stop();
});
