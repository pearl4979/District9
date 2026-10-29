import test from 'node:test';
import assert from 'node:assert/strict';
import {createWalletTracking} from '../src/wallet-tracking.mjs';

let createIndexedTracking;
try {({createIndexedTracking}=await import('../src/indexed-tracking.mjs'));} catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const a=n=>`0x${String(n).padStart(40,'0')}`,hash=`0x${'ab'.repeat(32)}`;
const time=Date.parse('2026-10-28T01:00:00Z');
const market={address:a(2),verified:true,platformId:'gang',name:'Known',symbol:'KNOWN',phase:'bonding'};
const observed=(extra={})=>({id:'indexed:trade',evidence:'binance-indexed',confirmed:false,demo:false,walletAddress:a(1),tokenAddress:a(2),assetAddress:a(2),platformId:'gang',side:'buy',timestamp:new Date(time-1000).toISOString(),txHash:hash,price:'0.125',priceUnit:'USD',tokenAmount:null,quoteAmount:null,source:'Binance Web3 索引推送',...extra});
async function fixture({events=[observed()],feedStatus={state:'live',message:'币安实时流',updatedAt:new Date(time).toISOString()},confirmed=[],read}={}){
 assert.equal(typeof createIndexedTracking,'function','indexed signal wrapper exists');
 const tracking=createWalletTracking({snapshot:()=>({tokens:[market]}),now:()=>time,poll:async()=>({events:confirmed,cursor:100,status:{state:'live'}})});
 await tracking.saveWallet({address:a(1),note:'Private note'});
 const feed={snapshot:read||(()=>({events,status:feedStatus}))};
 const wrapped=createIndexedTracking({tracking,feed,snapshot:()=>({tokens:[market]}),now:()=>time});
 return {tracking,wrapped,events};
}
test('indexed observations are private display data and never become confirmed chain history',async()=>{
 const {wrapped,tracking}=await fixture();const state=await wrapped.snapshot();
 assert.equal(state.indexedEvents.length,1);assert.equal(state.events.length,0);assert.equal((await tracking.snapshot()).events.length,0);
 const e=state.indexedEvents[0];assert.equal(e.confirmed,false);assert.equal(e.evidence,'binance-indexed');assert.equal(e.price,'0.125');assert.equal(e.priceUnit,'USD');
 assert.equal(e.blockNumber,null);assert.equal(e.logIndex,null);assert.equal(e.tokenAmount,null);assert.equal(e.quoteAmount,null);assert.equal(e.market.symbol,'KNOWN');
 assert.equal(state.status.indexer.state,'live');
});
test('private filtering rejects other wallets, unverified markets, forged confirmed flags and repeated updates',async()=>{
 const {wrapped}=await fixture({events:[observed(),observed({price:'0.126'}),observed({id:'foreign',walletAddress:a(3)}),observed({id:'unknown',tokenAddress:a(9)}),observed({id:'forged',confirmed:true}),observed({id:'future',timestamp:new Date(time+120000).toISOString()})]});
 const state=await wrapped.snapshot();assert.equal(state.indexedEvents.length,1);assert.equal(state.indexedEvents[0].price,'0.126');
 assert.equal(JSON.stringify(state.indexedEvents).includes(a(3)),false);
});
test('confirmed receipt supersedes the matching indexed trade without removing another side or transaction',async()=>{
 const chain={...observed(),confirmed:true,evidence:undefined,id:'chain',blockNumber:100,logIndex:3,transactionIndex:0,tokenAmount:'12',quoteAmount:'0.1',quoteSymbol:'BNB',source:'BSC gang 原生Buy成功回执'};
 const {wrapped,tracking}=await fixture({confirmed:[chain],events:[observed(),observed({id:'sell',side:'sell'}),observed({id:'other',txHash:`0x${'cd'.repeat(32)}`})]});
 await tracking.tick();const state=await wrapped.snapshot();assert.equal(state.events.length,1);assert.deepEqual(state.indexedEvents.map(e=>e.side).sort(),['buy','sell']);
 assert.ok(state.indexedEvents.every(e=>e.txHash!==hash||e.side!=='buy'));
});
test('removing a wallet while shared feed read is pending cannot revive its notes or observations',async()=>{
 let release,entered;const pendingRead=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const {wrapped,tracking}=await fixture({read:()=>{entered();return pendingRead;}});
 const pending=wrapped.snapshot();await started;await tracking.removeWallet({address:a(1)});release({events:[observed()],status:{state:'live'}});
 const state=await pending;assert.deepEqual(state.wallets,[]);assert.deepEqual(state.indexedEvents,[]);assert.equal(JSON.stringify(state).includes('Private note'),false);
});
test('upstream failure preserves independent chain data and reports unavailable indexed evidence',async()=>{
 const {wrapped}=await fixture({read:()=>{throw Error('private upstream detail must not leak');}});const state=await wrapped.snapshot();
 assert.equal(state.indexedEvents.length,0);assert.equal(state.status.indexer.state,'error');assert.equal(JSON.stringify(state).includes('private upstream detail'),false);
});
test('stale indexed observations expire and a stopped private wrapper ignores shared updates',async()=>{
 const {wrapped}=await fixture({events:[observed({timestamp:new Date(time-11*60000).toISOString()})]});
 assert.deepEqual((await wrapped.snapshot()).indexedEvents,[]);wrapped.stop();assert.deepEqual((await wrapped.snapshot()).indexedEvents,[]);
});
test('actual Binance collector observing status is represented truthfully without converting it to RPC confirmation',async()=>{
 const {wrapped}=await fixture({feedStatus:{state:'observing',lastMessageAt:new Date(time).toISOString(),updatedAt:new Date(time).toISOString()}});
 const data=await wrapped.snapshot();assert.equal(data.status.indexer.state,'observing');assert.equal(data.indexedEvents[0].confirmed,false);assert.match(data.status.indexer.message,/索引.*核验/);
});
