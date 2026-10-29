import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradeService } from '../src/trades.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const A='0x'+'1'.repeat(40), T='0x'+'3'.repeat(40);
const input={token:T,platformId:'four',side:'buy',amount:'0.01',slippageBps:50,maxPriceImpactBps:300};
function setup({live=false,demo=false,journalPath,now}={}) {
  const counts={builds:0,previews:0,sends:0,checks:0};
  const protocol={buildTrade:async i=>{counts.builds++;return {kind:i.side,transaction:{from:A,to:T,value:'1',data:'0x1234'},summary:{walletAddress:A,amount:i.amount,tradeRisk:{status:'ok'}}};},validateExecution:async()=>{counts.checks++;}};
  const baw={wallet:async()=>({available:true,address:A}),preview:async()=>{counts.previews++;return {requestId:'r1',expiresAt:(now||Date.now)()+30000,risks:{riskDetails:[],addresses:{}},simulationResult:{authorityChanges:[],allowanceChanges:[]}};},execute:async()=>{counts.sends++;return {status:'PENDING_CONFIRMATION'};}};
  return {service:createTradeService({protocol,baw,liveExecution:live,demo,journalPath,...(now?{now}: {})}),protocol,baw,counts};
}
test('closed live direct order only quotes/simulates locally; never creates wallet preview or sends',async()=>{
  const h=setup();const r=await h.service.place(input,{intentId:'closed-intent-0001'});
  assert.equal(r.status,'PREVIEW_ONLY');assert.equal(r.submitted,false);assert.equal(r.readOnly,true);assert.equal(r.summary.amount,'0.01');assert.deepEqual(h.counts,{builds:1,previews:0,sends:0,checks:0});assert.deepEqual(h.service.list(),[]);
});
test('original displayed wallet is bound before any quote or wallet request',async()=>{
 const h=setup({live:true});await assert.rejects(h.service.place(input,{intentId:'wallet-bound-0001',expectedWallet:'0x'+'b'.repeat(40)}),/钱包/);assert.equal(h.counts.builds,0);assert.equal(h.counts.sends,0);
});
test('submitted intent IDs remain immutable after TTL pruning and service restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'d9-direct-'));t.after(()=>rm(dir,{recursive:true,force:true}));const journalPath=join(dir,'orders.json');let time=Date.now();const h=setup({demo:true,journalPath,now:()=>time});
 const first=await h.service.place(input,{intentId:'durable-intent-001',expectedWallet:A});time+=300001;await h.service.place(input,{intentId:'durable-intent-002',expectedWallet:A});
 await assert.rejects(h.service.place({...input,amount:'0.02'},{intentId:'durable-intent-001',expectedWallet:A}),/绑定|不同/);assert.equal((await h.service.place(input,{intentId:'durable-intent-001',expectedWallet:A})).order.id,first.order.id);
 const restarted=setup({demo:true,journalPath});assert.equal((await restarted.service.place(input,{intentId:'durable-intent-001',expectedWallet:A})).order.id,first.order.id);assert.equal(restarted.counts.sends,0);
 await assert.rejects(restarted.service.place(input,{intentId:'durable-intent-001',expectedWallet:'0x'+'b'.repeat(40)}),/钱包|绑定/);
});
test('one click runs backend preview and fresh execution checks, with replay sharing the same result',async()=>{
  const h=setup({live:true});const one=h.service.place(input,{intentId:'live-intent-000001'}),two=h.service.place(input,{intentId:'live-intent-000001'});
  const [a,b]=await Promise.all([one,two]);assert.equal(a.order.id,b.order.id);assert.equal(a.order.status,'PENDING_CONFIRMATION');assert.equal(a.submitted,true);assert.equal(h.counts.sends,1);assert.equal(h.counts.checks,1);
  await assert.rejects(h.service.place({...input,amount:'0.02'},{intentId:'live-intent-000001'}),/绑定|不同/);
});
test('another click cannot race a pending pipeline and unknown submission is never retried',async()=>{
  const h=setup({live:true});let release;h.baw.execute=async()=>{h.counts.sends++;await new Promise(r=>release=r);throw Error('timeout');};
  const pending=h.service.place(input,{intentId:'pending-intent-001'});while(!release)await new Promise(setImmediate);
  await assert.rejects(h.service.place(input,{intentId:'pending-intent-002'}),/处理|未完成/);release();const r=await pending;assert.equal(r.order.status,'UNKNOWN');assert.equal((await h.service.place(input,{intentId:'pending-intent-001'})).order.id,r.order.id);assert.equal(h.counts.sends,1);
  await assert.rejects(h.service.place(input,{intentId:'pending-intent-003'}),/未完成|未知/);
});
test('same-intent retry waits for fresh risk checks instead of reporting provisional submission',async()=>{
 const h=setup({live:true});let release;h.protocol.validateExecution=async()=>{await new Promise(resolve=>release=resolve);throw Error('fresh risk failed');};
 const first=h.service.place(input,{intentId:'risk-wait-intent01'});while(!release)await new Promise(setImmediate);
 let settled=false;const second=h.service.place(input,{intentId:'risk-wait-intent01'}).finally(()=>settled=true);const results=Promise.allSettled([first,second]);await new Promise(setImmediate);assert.equal(settled,false);release();assert.deepEqual((await results).map(r=>r.status),['rejected','rejected']);assert.equal(h.counts.sends,0);assert.deepEqual(h.service.list(),[]);
});
test('approval is an explicit setup action and wallet warnings or changed risk never auto-execute',async()=>{
  const h=setup({live:true});const build=h.protocol.buildTrade;h.protocol.buildTrade=async i=>({...await build(i),kind:'approve'});
  const r=await h.service.place(input,{intentId:'approval-intent-01'});assert.equal(r.status,'ACTION_REQUIRED');assert.equal(r.action.kind,'approve');assert.equal(h.counts.sends,0);
  for(const mode of ['risk','authority','unknown','fresh-risk']){
    const k=setup({live:true}),preview=k.baw.preview;
    k.baw.preview=async()=>{const p=await preview();if(mode==='risk')p.risks.riskDetails=[{title:'Caution'}];if(mode==='authority')p.simulationResult.authorityChanges=[{authority:T}];if(mode==='unknown')delete p.risks;return p;};
    if(mode==='fresh-risk')k.protocol.validateExecution=async()=>{throw Error('impact changed');};
    await assert.rejects(k.service.place(input,{intentId:'risk-intent-'+mode}),/风险|权限|impact/);assert.equal(k.counts.sends,0,mode);
  }
});
test('demo direct order is unmistakably simulated and cached failures do not auto retry',async()=>{
  const h=setup({demo:true});const r=await h.service.place(input,{intentId:'demo-intent-00001'});assert.equal(r.order.status,'DEMO_COMPLETED');assert.equal(r.demo,true);
  const k=setup();k.protocol.buildTrade=async()=>{k.counts.builds++;throw Error('depth unknown');};
  for(let i=0;i<2;i++)await assert.rejects(k.service.place(input,{intentId:'failed-intent-0001'}),/depth/);assert.equal(k.counts.builds,1);
});
