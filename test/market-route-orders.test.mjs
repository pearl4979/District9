import test from 'node:test';import assert from 'node:assert/strict';
import {createTradeService} from '../src/trades.mjs';
const A='0x'+'1'.repeat(40),T='0x'+'2'.repeat(40),H='0x'+'4'.repeat(64),N='0x'+'e'.repeat(40);
const input={token:T,platformId:'gang',side:'buy',amount:'0.01',slippageBps:50,maxPriceImpactBps:300};
function setup(){let now=1700000000000,record=null,receipt=null,sends=0,observed=0;const q={walletAddress:A,fromToken:N,toToken:T,fromRaw:'10000000000000000',amount:'0.01',slippageBps:50};
 const plan={kind:'binance-sequential',walletAddress:A,input,deadline:1700001000,summary:{},steps:[{id:'one',role:'market',quote:q,label:'聚合',status:'PLANNED'}]};
 const transaction={from:A,to:T,hash:H,chainId:56n,data:'0x1234',value:10000000000000000n,blockHash:H,blockNumber:100};
 const protocol={provider:{getNetwork:async()=>({chainId:56n}),getBlock:async()=>({number:100,hash:H,timestamp:1700000000}),getBlockNumber:async()=>102,getTransaction:async()=>transaction,getTransactionReceipt:async()=>receipt},planRoute:async()=>structuredClone(plan),buildRouteStep:async(p,s)=>({kind:'market',marketInput:s.quote,summary:{minimumOutputRaw:'10'}}),validateRouteStep:async()=>({}),observeRouteStep:async()=>{observed++;return{ownedAssets:{[T]:'12'},retainedBalances:[]};}};
 const baw={executionContext:async()=>({available:true,address:A}),marketSwap:async()=>{sends++;return{orderId:'binance-123'};},marketOrder:async()=>record,preview:async()=>{throw Error('market step cannot use contract preview');}};
 const service=createTradeService({protocol,baw,liveExecution:true,now:()=>now});return{service,protocol,baw,plan,setRecord:r=>record=r,mine(){receipt={hash:H,blockHash:H,blockNumber:100,status:1,from:A,to:T,logs:[]};record={orderId:'binance-123',chain:'56',fromToken:N,toToken:T,fromTokenQty:'0.01',toTokenActualQty:'12',slippage:'0.005',status:'FINISHED',txHash:H};},tick(){now+=2100;},sends:()=>sends,observed:()=>observed};}
test('aggregator order ID is pending; canonical receipt and matched order required before confirmed',async()=>{const h=setup(),r=await h.service.place(input,{intentId:'market-order-0001'});assert.equal(r.submitted,true);assert.equal(r.order.steps[0].status,'MARKET_PENDING');assert.equal(h.service.receiptPending(),1);await h.service.refresh();assert.equal(h.observed(),0);h.mine();h.tick();await h.service.refresh();assert.equal(h.observed(),1);assert.equal(h.service.list()[0].status,'CONFIRMED');assert.equal(h.sends(),1);});
test('ambiguous market submission is never retried or sent to fallback',async()=>{const h=setup();h.baw.marketSwap=async()=>{throw Error('timeout');};const r=await h.service.place(input,{intentId:'market-unknown-01'});assert.equal(r.order.status,'UNKNOWN');await h.service.place(input,{intentId:'market-unknown-01'});assert.equal(h.service.list().length,1);assert.equal(h.observed(),0);});
test('mismatched market tokens and wallet receipt cannot advance',async()=>{for(const mode of ['token','wallet','qty']){const h=setup();await h.service.place(input,{intentId:'market-mismatch-'+mode});h.mine();if(mode==='wallet')h.protocol.provider.getTransaction=async()=>({from:T});else h.setRecord({orderId:'binance-123',chain:'56',fromToken:N,toToken:mode==='token'?A:T,fromTokenQty:mode==='qty'?'1':'0.01',status:'FINISHED',toTokenActualQty:'12',slippage:'0.005',txHash:H});h.tick();await h.service.refresh();assert.equal(h.observed(),0);assert.equal(h.service.list()[0].status,'UNKNOWN');}});

test('route construction does not reread signing permissions; the send gets one fresh bound context',async()=>{
 const h=setup();let reads=0,provided;
 h.baw.executionContext=async()=>{reads++;return{available:true,address:A};};
 h.baw.marketSwap=async(_input,options)=>{provided=options.context;options.beforeSubmit();return{orderId:'bound-context-order'};};
 await h.service.place(input,{intentId:'market-fresh-context-01'});assert.equal(reads,2);assert.equal(provided.address,A);
});
test('identity changes during read-only construction cannot reach a market submission',async()=>{
 const h=setup(),build=h.protocol.buildRouteStep;let changed=false;
 h.protocol.buildRouteStep=async(...args)=>{const r=await build(...args);changed=true;return r;};
 h.baw.executionContext=async()=>({available:true,address:changed?T:A});
 const r=await h.service.place(input,{intentId:'market-changed-context'});assert.equal(r.submitted,false);assert.equal(h.sends(),0);assert.match(r.order.error,/钱包/);
});
