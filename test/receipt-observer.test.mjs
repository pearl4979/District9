import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradeService } from '../src/trades.mjs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createReceiptObserver } = await import('../src/receipt-observer.mjs').catch(() => ({}));
const A='0x'+'1'.repeat(40), T='0x'+'2'.repeat(40), H='0x'+'a'.repeat(64);
const input={token:T,side:'buy',amount:'0.01',slippageBps:100};
const tx={from:A,to:T,value:'1',data:'0x1234'};
const BLOCK='0x'+'c'.repeat(64);
const chainTransaction={...tx,hash:H,chainId:56n,blockNumber:10,blockHash:BLOCK};
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(setImmediate);};
function setup(){
 let time=100000,head=10,receipt=null,error=false,reads=0;const timers=new Map();let seq=0;
 const protocol={buildTrade:async()=>({transaction:tx,summary:{}}),provider:{getTransactionReceipt:async()=>{reads++;if(error)throw Error('429');return receipt;},getNetwork:async()=>({chainId:56n}),getTransaction:async()=>chainTransaction,getBlock:async()=>({number:10,hash:BLOCK}),getBlockNumber:async()=>head}};
 const baw={wallet:async()=>({available:true,address:A}),preview:async()=>({requestId:'r',expiresAt:999999}),execute:async()=>({txHash:H})};
 const trades=createTradeService({protocol,baw,liveExecution:true,now:()=>time,performanceNow:()=>time});
 assert.equal(typeof createReceiptObserver,'function');
 const observer=createReceiptObserver({trades,now:()=>time,setTimer:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimer:id=>timers.delete(id)});
 return {trades,observer,timers,reads:()=>reads,advance:ms=>time+=ms,setError:x=>error=x,setReceipt:(r,h)=>{receipt=r?{hash:H,blockHash:BLOCK,...r}:null;head=h;},async run(){const [id,t]=timers.entries().next().value;timers.delete(id);time+=t.ms;t.fn();await flush();}};
}
test('observes a new hash immediately, backs off errors, and stops after three confirmations',async()=>{
 const h=setup();h.observer.start();assert.equal(h.timers.size,0);
 const p=await h.trades.preview(input);const order=await h.trades.execute({previewId:p.id,confirmed:true});
 assert.equal([...h.timers.values()][0].ms,0);assert.equal(order.firstHashObservedAt,new Date(100000).toISOString());
 await h.run();assert.equal(h.reads(),1);assert.equal([...h.timers.values()][0].ms,750);
 h.setError(true);await h.run();assert.equal([...h.timers.values()][0].ms,1500);
 h.setError(false);h.setReceipt({blockNumber:10,status:1},10);await h.run();
 let latest=h.trades.list()[0];assert.equal(latest.status,'MINED');assert.equal(latest.receiptStatus,1);assert.equal(latest.timings.firstReceiptWaitMs,2250);assert.equal(latest.timings.firstHashMs,0);
 const first=latest.successfulReceiptObservedAt;h.setReceipt({blockNumber:10,status:1},12);await h.run();
 latest=h.trades.list()[0];assert.equal(latest.status,'CONFIRMED');assert.equal(latest.successfulReceiptObservedAt,first);assert.equal(h.timers.size,0);
 h.observer.stop();
});
test('unknown without hash never triggers RPC; shutdown cancels observation and late rescheduling',async()=>{
 const h=setup();h.observer.start();const p=await h.trades.preview(input);await h.trades.execute({previewId:p.id,confirmed:true});
 h.observer.stop();assert.equal(h.timers.size,0);assert.equal(h.reads(),0);
 const noHash=createTradeService({protocol:{},baw:{},demo:true});assert.equal(noHash.receiptPending(),0);
});
test('disappearing mined receipt returns to broadcast waiting, never fabricates confirmation',async()=>{
 const h=setup();const p=await h.trades.preview(input);await h.trades.execute({previewId:p.id,confirmed:true});
 h.setReceipt({blockNumber:10,status:1},10);await h.trades.refresh();assert.equal(h.trades.list()[0].status,'MINED');
 h.setReceipt(null,12);await h.trades.refresh();const o=h.trades.list()[0];assert.equal(o.status,'BROADCASTED');assert.equal(o.confirmations,0);assert.equal(o.receiptStatus,undefined);assert.equal(o.confirmedAt,undefined);
});

test('a hash remains observed when submission succeeded but the final journal save failed',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-save-')),journalPath=join(dir,'orders.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));let reads=0,wakes=0;
 const protocol={buildTrade:async()=>({transaction:tx,summary:{}}),provider:{getTransactionReceipt:async()=>{reads++;return{hash:H,blockHash:BLOCK,blockNumber:10,status:1};},getNetwork:async()=>({chainId:56n}),getTransaction:async()=>chainTransaction,getBlock:async()=>({number:10,hash:BLOCK}),getBlockNumber:async()=>10}};
 const baw={wallet:async()=>({available:true,address:A}),preview:async()=>({requestId:'r',expiresAt:999999}),execute:async()=>{mkdirSync(journalPath+'.tmp');return{txHash:H};}};
 const trades=createTradeService({protocol,baw,liveExecution:true,journalPath,now:()=>100000});trades.watchReceipts(()=>wakes++);
 const p=await trades.preview(input);await assert.rejects(trades.execute({previewId:p.id,confirmed:true}),/directory|EISDIR/i);
 assert.equal(trades.list()[0].status,'BROADCASTED');assert.equal(trades.receiptPending(),1);assert.equal(wakes,1);
 await assert.rejects(trades.refresh(),/directory|EISDIR/i);assert.equal(reads,1);assert.equal(trades.list()[0].status,'MINED');
});
test('ordinary and atomic BNB orders require matching BSC transaction, receipt and canonical block',async()=>{
 const BAD='0x'+'9'.repeat(64),B='0x'+'b'.repeat(64);
 for(const mode of ['network','tx-chain','tx-hash','receipt-hash','tx-block','tx-blockhash','canonical-hash','canonical-number','receipt-from','receipt-to']){
  let sends=0;
  const receipt={hash:H,blockHash:B,blockNumber:10,status:1,from:A,to:T},chainTx={...tx,hash:H,chainId:56n,blockNumber:10,blockHash:B},block={hash:B,number:10};
  if(mode==='tx-chain')chainTx.chainId=1n;if(mode==='tx-hash')chainTx.hash=BAD;if(mode==='receipt-hash')receipt.hash=BAD;if(mode==='tx-block')chainTx.blockNumber=11;if(mode==='tx-blockhash')chainTx.blockHash=BAD;if(mode==='canonical-hash')block.hash=BAD;if(mode==='canonical-number')block.number=11;if(mode==='receipt-from')receipt.from=T;if(mode==='receipt-to')receipt.to=A;
  const provider={getNetwork:async()=>({chainId:mode==='network'?1n:56n}),getTransactionReceipt:async()=>receipt,getTransaction:async()=>chainTx,getBlock:async()=>block,getBlockNumber:async()=>12};
  const protocol={provider,buildTrade:async()=>({kind:'sell',transaction:tx,summary:{platformId:'gang',routeKind:'pool',settlement:'bnb'}})};
  const baw={wallet:async()=>({available:true,address:A}),preview:async()=>({requestId:'r',expiresAt:Date.now()+30000}),execute:async()=>{sends++;return{txHash:H};}};
  const trades=createTradeService({protocol,baw,liveExecution:true}),p=await trades.preview({...input,side:'sell',platformId:'gang',settlement:'bnb'});await trades.execute({previewId:p.id,confirmed:true});await trades.refresh();
  const order=trades.list()[0];assert.equal(order.status,'UNKNOWN',mode);assert.equal(order.receiptMismatch,true,mode);assert.equal(order.confirmedAt,undefined,mode);assert.equal(trades.receiptPending(),0,mode);await trades.refresh();assert.equal(sends,1,mode);
  await assert.rejects(trades.place({...input,platformId:'gang'},{intentId:'receipt-block-'+mode+'-01'}),/未完成|未知/);
 }
});
