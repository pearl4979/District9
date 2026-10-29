import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../src/demo.mjs';
test('opt-in Fair demo has explicit fake progress and matching private principal while legacy demos stay stable',async()=>{
 assert.equal(createDemo().monitor.snapshot().tokens.length,5);
 const d=createDemo({fairLaunch:true}),t=d.monitor.snapshot().tokens.find(t=>t.launchType==='fair');assert.ok(t);assert.equal(t.fairSale.demo,true);assert.equal(t.fairSale.soldShares,'6800');assert.equal(t.fairSale.totalShares,'10000');
 const wallet=await d.baw.wallet(),p=await d.protocol.positions(t.address,wallet.address);assert.equal(p.fairShares,'3');assert.equal(p.fairPrincipal,'0.0015');
 const trade=await d.protocol.buildTrade({token:t.address,walletAddress:wallet.address,side:'buy',amount:'0.01',slippageBps:50});assert.equal(trade.kind,'buy');assert.equal(trade.summary.fairShares,'19');assert.equal(trade.summary.tokensPerShare,'50000');assert.equal(trade.transaction.value,'9595000000000000');assert.match(trade.summary.mode,/演示/);
});
test('Fair demo participant pages contain only labeled synthetic quantities and reconcile with its progress',async()=>{
 const d=createDemo({fairLaunch:true}),t=d.monitor.snapshot().tokens.find(t=>t.launchType==='fair');assert.equal(typeof d.fairParticipants?.get,'function');
 const first=await d.fairParticipants.get(t.address),next=await d.fairParticipants.get(t.address,{offset:50,block:first.block});assert.equal(first.demo,true);assert.equal(first.items.length,50);assert.equal(next.items.length,19);assert.equal(first.indexedTotal,69);assert.equal([...first.items,...next.items].reduce((s,r)=>s+BigInt(r.shares),0n),6800n);assert.ok([...first.items,...next.items].every(r=>BigInt(r.shares)<=100n));
});
