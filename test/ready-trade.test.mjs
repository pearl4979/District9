import test from 'node:test';
import assert from 'node:assert/strict';
import {createTradeService} from '../src/trades.mjs';
import {createBaw} from '../src/baw.mjs';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),T='0x'+'3'.repeat(40),EPOCH=2_000_000_000_000;
const input={token:T,side:'buy',amount:'0.01',slippageBps:50,maxPriceImpactBps:300};
function setup({enabled=true,warm=true}={}){
 let time=EPOCH,owner=A,route='v1',contexts=0,builds=0,plans=0,previews=0,sends=0,checks=0;
 const baw={executionContext:async()=>{contexts++;return{available:true,address:owner};},preview:async()=>{previews++;return{requestId:'warm-request-'+previews,expiresAt:time+60000,risks:{addresses:{},riskDetails:[]},simulationResult:{authorityChanges:[],allowanceChanges:[]}};},execute:async()=>{sends++;return{status:'PENDING_CONFIRMATION',orderId:'one-order'};}};
 const protocol={preparationKey:async()=>route,planRoute:async()=>{plans++;return null;},buildTrade:async i=>{builds++;return{kind:i.side,transaction:{from:i.walletAddress,to:T,value:'1',data:'0x1234'},summary:{walletAddress:i.walletAddress,amount:i.amount}};},validateExecution:async()=>{checks++;}};
 const service=createTradeService({protocol,baw,liveExecution:enabled,warmPreviews:warm,now:()=>time,performanceNow:()=>time});
 return{service,baw,protocol,counts:()=>({contexts,builds,plans,previews,sends,checks}),advance:ms=>time+=ms,owner:x=>owner=x,route:x=>route=x};
}
test('live preparation obtains a private executable preview without submitting; click consumes it once',async()=>{
 const h=setup(),ready=await h.service.prepare(input);assert.equal(ready.executionReady,true);assert.ok(ready.remainingMs>3000);assert.equal(ready.raw,undefined);assert.equal(ready.transaction,undefined);assert.equal(ready.previewId,undefined);assert.equal(h.counts().sends,0);
 const result=await h.service.place(input,{intentId:'ready-single-click-0001',expectedWallet:A});
 assert.equal(result.preparation.executionReady,true);assert.equal(result.submitted,true);assert.deepEqual(h.counts(),{contexts:2,builds:1,plans:1,previews:1,sends:1,checks:1});
 await h.service.place(input,{intentId:'ready-single-click-0001',expectedWallet:A});assert.equal(h.counts().sends,1);
});
test('read-only mode never warms a wallet request',async()=>{const h=setup({enabled:false});const r=await h.service.prepare(input);assert.notEqual(r.executionReady,true);assert.equal(h.counts().previews,0);assert.equal(h.counts().sends,0);});
test('ready transactions still reject changed accounts and protocol state before sending',async()=>{
 for(const mode of ['wallet','protocol']){const h=setup();await h.service.prepare(input);if(mode==='wallet')h.owner(B);else h.protocol.validateExecution=async()=>{throw Error('route changed');};await assert.rejects(h.service.place(input,{intentId:'ready-reject-'+mode+'-001',expectedWallet:A}));assert.equal(h.counts().sends,0);}
});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('final wallet and protocol checks start together and both finish before submission',async()=>{
 const h=setup();await h.service.prepare(input);const wallet=deferred(),chain=deferred(),started=[];
 h.baw.executionContext=()=>{started.push('wallet');return wallet.promise;};h.protocol.validateExecution=()=>{started.push('chain');return chain.promise;};
 const order=h.service.place(input,{intentId:'parallel-final-00001',expectedWallet:A});for(let i=0;i<5;i++)await new Promise(setImmediate);assert.deepEqual(started,['wallet','chain']);assert.equal(h.counts().sends,0);
 wallet.resolve({available:true,address:A});await new Promise(setImmediate);assert.equal(h.counts().sends,0);chain.resolve({});await order;assert.equal(h.counts().sends,1);
});
test('expiry, changed input or route never reuses the old wallet preview and OFF prevents submission',async()=>{
 for(const change of ['expiry','input','route','off']){
  const h=setup();await h.service.prepare(input);let request=input;
  if(change==='expiry')h.advance(10001);if(change==='input')request={...input,amount:'0.02'};if(change==='route')h.route('v2');if(change==='off')h.service.setLiveExecution(false);
  await h.service.place(request,{intentId:'changed-ready-'+change+'-001',expectedWallet:A});
  assert.equal(h.counts().previews,change==='off'?1:2);assert.equal(h.counts().sends,change==='off'?0:1);
 }
});
test('address and authenticated settings reads start together without financial commands',async()=>{
 const gate=deferred(),calls=[];const baw=createBaw({binary:'/mock/baw',now:()=>EPOCH,run:async(_,args)=>{const key=args.slice(0,2).join(' ');calls.push(key);await gate.promise;const data=key==='wallet status'?{status:'CONNECTED'}:key==='wallet address'?{addresses:[{binanceChainId:'56',address:A}]}:{sessionExpireTime:EPOCH+60000,devMode:{enabled:true,expiresAt:EPOCH+60000}};return{stdout:JSON.stringify({success:true,data}),stderr:''};}});
 const context=baw.executionContext();await new Promise(setImmediate);assert.deepEqual(calls,['wallet address','wallet settings']);gate.resolve();assert.equal((await context).address,A);
});
test('click during live preparation waits for its original executable preview without building it again',async()=>{
 const h=setup(),gate=deferred(),original=h.protocol.buildTrade;h.protocol.buildTrade=async i=>{await gate.promise;return original(i);};const preparing=h.service.prepare(input);await new Promise(setImmediate);
 const order=h.service.place(input,{intentId:'during-prepare-00001',expectedWallet:A});gate.resolve();await preparing;const result=await order;assert.equal(result.preparation.executionReady,true);assert.equal(h.counts().previews,1);assert.equal(h.counts().builds,1);assert.equal(h.counts().contexts,2);
});
test('a slow final validation refreshes expired wallet evidence before sending',async()=>{
 const h=setup();await h.service.prepare(input);const gate=deferred();h.protocol.validateExecution=()=>gate.promise;const order=h.service.place(input,{intentId:'slow-wallet-check-001',expectedWallet:A});for(let i=0;i<5;i++)await new Promise(setImmediate);h.owner(B);h.advance(5001);gate.resolve();await assert.rejects(order,/钱包/);assert.equal(h.counts().sends,0);assert.equal(h.counts().contexts,3);
});
test('a server-bound wallet overlaps cold construction with authorization and persists the complete worker request timing',async()=>{
 const h=setup(),gate=deferred(),started=[];h.baw.executionContext=()=>{started.push('wallet');return gate.promise;};const original=h.protocol.buildTrade;h.protocol.buildTrade=async i=>{started.push('build');return original(i);};
 const service=createTradeService({protocol:h.protocol,baw:h.baw,liveExecution:true,trustedWalletAddress:A,now:()=>EPOCH});
 const order=service.place(input,{intentId:'bound-cold-overlap-001',expectedWallet:A});for(let i=0;i<5;i++)await new Promise(setImmediate);assert.ok(started.includes('build'));assert.equal(h.counts().sends,0);gate.resolve({available:true,address:A});const r=await order;assert.equal(r.order.timings.requestTotalMs>=r.order.timings.executionTotalMs,true);assert.equal(service.list()[0].timings.requestTotalMs,r.order.timings.requestTotalMs);assert.equal(h.counts().builds,1);
});
test('a browser-provided expectedWallet cannot enable early construction or bypass a mismatched server wallet',async()=>{
 const h=setup(),gate=deferred();h.baw.executionContext=()=>gate.promise;const pending=h.service.place(input,{intentId:'browser-wallet-no-trust',expectedWallet:A});await new Promise(setImmediate);assert.equal(h.counts().builds,0);gate.resolve({available:true,address:B});await assert.rejects(pending,/钱包/);assert.equal(h.counts().sends,0);
});
test('session expiration during final validation refreshes identity even inside the five-second freshness window',async()=>{
 const h=setup();await h.service.prepare(input);const gate=deferred();let reads=0;h.baw.executionContext=async()=>{reads++;return{available:true,address:reads===1?A:B,sessionExpiresAt:EPOCH+1};};h.protocol.validateExecution=()=>gate.promise;
 const pending=h.service.place(input,{intentId:'expiry-inside-window-01',expectedWallet:A});for(let i=0;i<5;i++)await new Promise(setImmediate);h.advance(2);gate.resolve();await assert.rejects(pending,/钱包/);assert.equal(h.counts().sends,0);assert.equal(reads,2);
});
