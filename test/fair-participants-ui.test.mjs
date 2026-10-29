import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {parseHTML} from 'linkedom';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const source=await readFile(new URL('../public/fair-participants.js',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40),X='0x'+'1'.repeat(40),Y='0x'+'2'.repeat(40);
const token=address=>({address,platformId:'gang',pad:'merged',launchType:'fair',phase:'bonding',quoteSymbol:'WBNB',symbol:'FAIR'});
const row=(address,shares='3')=>({address,shares,tokenAmount:String(BigInt(shares)*50000n),principal:shares==='3'?'0.0015':'0.001'});
const page=(address=A,extra={})=>({token:address,block:100,updatedAt:new Date().toISOString(),demo:false,items:[row(X)],indexedTotal:60,checkedOnPage:50,inactiveOnPage:49,offset:0,hasMore:true,nextOffset:50,truncated:false,complete:false,quoteSymbol:'WBNB',symbol:'FAIR',coverage:'官方索引可能延迟',...extra});
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
async function fixture({hold=false}={}){
 const {window,document}=parseHTML(html),requests=[],pending=[],copies=[],anchor=document.createElement('p');document.body.append(anchor);let response=page(),failure=null,timerId=0;const timers=new Map();
 vm.runInContext(source,vm.createContext({window,document,Date,Intl,URL,AbortController,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),console}));assert.equal(typeof window.createFairParticipantsView,'function');
 const api=async(path,body,options)=>{requests.push({path,body,options});if(hold)return new Promise(resolve=>pending.push(resolve));if(failure)throw Error(failure);return structuredClone(response);};
 const view=window.createFairParticipantsView({before:anchor,api,copy:address=>copies.push(address)});
 return {view,window,requests,pending,copies,document,timers,runTimer:()=>{const [id,fn]=timers.entries().next().value||[];assert.equal(typeof fn,'function','visible participant polling remains scheduled');timers.delete(id);fn();},$:id=>document.getElementById(id),setResponse:r=>response=r,fail:msg=>failure=msg};
}
test('participant table renders current address/share/allocation/principal and pins more pages to one block',async()=>{
 const p=await fixture();p.view.open(token(A));await settle();assert.match(p.$('fair-participant-rows').textContent,/3.*150,000.*0.0015/);p.$('fair-participant-rows').querySelector('button').click();assert.deepEqual(p.copies,[X]);assert.equal(p.$('fair-participant-rows').querySelector('a').href,`https://bscscan.com/address/${X}`);
 p.setResponse(page(A,{offset:50,items:[row(Y,'2')],checkedOnPage:10,inactiveOnPage:9,hasMore:false,nextOffset:null}));p.$('fair-participant-more').click();await settle();assert.match(p.requests.at(-1).path,/offset=50&block=100/);assert.equal(p.$('fair-participant-rows').children.length,2);assert.equal(p.$('fair-participant-more').hidden,true);assert.match(p.$('fair-participant-status').textContent,/索引.*延迟|当前加载/);
});
test('switching token or closing aborts old reads and cannot display a previous token address',async()=>{
 const p=await fixture({hold:true});p.view.open(token(A));await settle();p.view.open(token(B));assert.equal(p.requests[0].options.signal.aborted,true);p.pending[0](page());await settle();assert.equal(p.$('fair-participant-rows').children.length,0);p.pending[1](page(B));await settle();assert.equal(p.$('fair-participant-rows').children.length,1);p.view.close();assert.equal(p.$('fair-participants-panel').hidden,true);
});
test('unknown, failed and changing-block pages never masquerade as an empty complete subscription list',async()=>{
 const p=await fixture();p.fail('upstream offline');p.view.open(token(A));await settle();assert.match(p.$('fair-participant-status').textContent,/失败|不可用/);assert.doesNotMatch(p.$('fair-participant-status').textContent,/暂无认购/);
 const q=await fixture();q.view.open(token(A));await settle();q.setResponse(page(A,{offset:50,block:101,items:[row(Y,'2')],checkedOnPage:10,inactiveOnPage:9,hasMore:false,nextOffset:null}));q.$('fair-participant-more').click();await settle();assert.equal(q.$('fair-participant-rows').children.length,1);assert.match(q.$('fair-participant-status').textContent,/刷新|快照/);
});
test('repeated opens do not duplicate polling and demo rows never claim real explorer balances',async()=>{
 const p=await fixture();p.setResponse(page(A,{demo:true}));const t={...token(A),demo:true};p.view.open(t);p.view.open(t);await settle();assert.equal(p.requests.length,1);assert.match(p.$('fair-participant-status').textContent,/DEMO|演示/);assert.equal(p.$('fair-participant-rows').querySelector('a'),null);
});
test('a hidden participant view resumes its read when visible and stays stopped after close',async()=>{
 const p=await fixture();Object.defineProperty(p.document,'visibilityState',{value:'hidden',writable:true,configurable:true});p.view.open(token(A));await settle();assert.equal(p.requests.length,0);p.document.visibilityState='visible';p.document.dispatchEvent(new p.window.Event('visibilitychange'));await settle();assert.equal(p.requests.length,1);p.view.close();p.document.dispatchEvent(new p.window.Event('visibilitychange'));await settle();assert.equal(p.requests.length,1);
});

test('paginated views refresh to a new first-page snapshot on the visible timer',async()=>{
 const p=await fixture();p.view.open(token(A));await settle();
 p.setResponse(page(A,{offset:50,items:[row(Y,'2')],hasMore:false,nextOffset:null}));p.$('fair-participant-more').click();await settle();assert.equal(p.$('fair-participant-rows').children.length,2);
 p.setResponse(page(A,{block:101,items:[row(X,'2')]}));p.runTimer();await settle();assert.match(p.requests.at(-1).path,/offset=0$/);assert.equal(p.$('fair-participant-rows').children.length,1);assert.match(p.$('fair-participant-status').textContent,/区块 101/);assert.equal(p.timers.size,1);p.view.close();assert.equal(p.timers.size,0);
});
test('an advancing Fair source block resets loaded pages instead of mixing snapshots',async()=>{
 const p=await fixture();p.view.open({...token(A),fairSale:{sourceBlock:99}});await settle();
 p.setResponse(page(A,{offset:50,items:[row(Y,'2')],hasMore:false,nextOffset:null}));p.$('fair-participant-more').click();await settle();
 p.setResponse(page(A,{block:102,items:[row(X,'2')]}));p.view.open({...token(A),fairSale:{sourceBlock:101}});await settle();assert.equal(p.requests.length,3);assert.match(p.requests.at(-1).path,/offset=0$/);assert.equal(p.$('fair-participant-rows').children.length,1);assert.match(p.$('fair-participant-status').textContent,/区块 102/);
});
