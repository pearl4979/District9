import test from 'node:test';import assert from 'node:assert/strict';
import {createTradeService} from '../src/trades.mjs';
const A='0x'+'1'.repeat(40),T='0x'+'2'.repeat(40),H='0x'+'4'.repeat(64),N='0x'+'e'.repeat(40);
const input={token:T,platformId:'gang',side:'buy',amount:'0.01',slippageBps:50,maxPriceImpactBps:300};
function setup(){let now=1700000000000,record=null,receipt=null,sends=0,observed=0;const q={walletAddress:A,fromToken:N,toToken:T,fromRaw:'10000000000000000',amount:'0.01',slippageBps:50};
 const plan={kind:'binance-sequential',walletAddress:A,input,deadline:1700001000,summary:{},steps:[{id:'one',role:'market',quote:q,label:'聚合',status:'PLANNED'}]};
 const transaction={from:A,to:T,hash:H,chainId:56n,data:'0x1234',value:10000000000000000n,blockHash:H,blockNumber:100};
 const protocol={provider:{getNetwork:async()=>({chainId:56n}),getBlock:async()=>({number:100,hash:H,timestamp:1700000000}),getBlockNumber:async()=>102,getTransaction:async()=>transaction,getTransactionReceipt:async()=>receipt},planRoute:async()=>structuredClone(plan),buildRouteStep:async(p,s)=>({kind:'market',marketInput:s.quote,summary:{minimumOutputRaw:'10'}}),validateRouteStep:async()=>({}),observeRouteStep:async()=>{observed++;return{ownedAssets:{[T]:'12'},retainedBalances:[]};}};
 const baw={executionContext:async()=>({available:true,address:A}),marketSwap:async()=>{sends++;return{orderId:'binance-123'};},marketOrder:async()=>record,preview:async()=>{throw Error('market step cannot use contract preview');}};
 const service=createTradeService({protocol,baw,liveExecution:true,now:()=>now});return{service,protocol,baw,plan,setRecord:r=>record=r,mine(){receipt={hash:H,blockHash:H,blockNumber:100,status:1,from:A,to:T,logs:[]};record={orderId:'binance-123',chain:'56',fromToken:N,toToken:T,fromTokenQty:'0.01',toTokenActualQty:'12',slippage:'0.5',status:'FINISHED',txHash:H};},tick(){now+=2100;},record:()=>structuredClone(record),advanceTime:ms=>now+=ms,sends:()=>sends,observed:()=>observed};}
test('aggregator order ID is pending; canonical receipt and matched order required before confirmed',async()=>{const h=setup(),r=await h.service.place(input,{intentId:'market-order-0001'});assert.equal(r.submitted,true);assert.equal(r.order.steps[0].status,'MARKET_PENDING');assert.equal(h.service.receiptPending(),1);await h.service.refresh();assert.equal(h.observed(),0);h.mine();h.tick();await h.service.refresh();assert.equal(h.observed(),1);assert.equal(h.service.list()[0].status,'CONFIRMED');assert.equal(h.sends(),1);});
test('ambiguous market submission is never retried or sent to fallback',async()=>{const h=setup();h.baw.marketSwap=async()=>{throw Error('timeout');};const r=await h.service.place(input,{intentId:'market-unknown-01'});assert.equal(r.order.status,'UNKNOWN');await h.service.place(input,{intentId:'market-unknown-01'});assert.equal(h.service.list().length,1);assert.equal(h.observed(),0);});
test('mismatched market tokens and wallet receipt cannot advance',async()=>{for(const mode of ['token','wallet','qty']){const h=setup();await h.service.place(input,{intentId:'market-mismatch-'+mode});h.mine();if(mode==='wallet')h.protocol.provider.getTransaction=async()=>({from:T});else h.setRecord({orderId:'binance-123',chain:'56',fromToken:N,toToken:mode==='token'?A:T,fromTokenQty:mode==='qty'?'1':'0.01',status:'FINISHED',toTokenActualQty:'12',slippage:'0.5',txHash:H});h.tick();await h.service.refresh();assert.equal(h.observed(),0);assert.equal(h.service.list()[0].status,'UNKNOWN');}});

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

test('25 bps market order uses API percentage 0.2500 rather than quote fraction 0.0025',async()=>{
 const h=setup();h.plan.steps[0].quote.slippageBps=25;await h.service.place(input,{intentId:'market-percent-25bps'});h.mine();h.setRecord({...h.record(),slippage:'0.2500'});h.tick();await h.service.refresh();assert.equal(h.service.list()[0].status,'CONFIRMED');assert.equal(h.sends(),1);
});
test('fraction-shaped or mismatched slippage cannot stand in for the order API percentage',async()=>{
 for(const slip of ['0.005','5','NaN','',null]){const h=setup();await h.service.place(input,{intentId:'market-bad-percent-'+['0.005','5','NaN','',null].indexOf(slip)});h.mine();h.setRecord({...h.record(),slippage:slip});h.tick();await h.service.refresh();assert.equal(h.service.list()[0].status,'UNKNOWN');assert.equal(h.observed(),0);}
});
test('read-only reconciliation resolves an old mismatched order after expiry without submitting its next step',async()=>{
 const h=setup();h.plan.steps.push({id:'target',role:'target',label:'目标买入',status:'PLANNED'});await h.service.place(input,{intentId:'market-reconcile-001'});h.mine();const actual=h.record();h.setRecord({...actual,slippage:'0.005'});h.tick();await h.service.refresh();const id=h.service.list()[0].id;assert.equal(h.service.list()[0].status,'UNKNOWN');
 h.advanceTime(2000000);h.setRecord(actual);h.service.setLiveExecution(false);const r=await h.service.reconcileRoute({orderId:id});assert.equal(r.readOnly,true);assert.equal(r.order.status,'ROUTE_PAUSED');assert.equal(r.order.steps[0].status,'CONFIRMED');assert.equal(r.order.steps[1].status,'PLANNED');assert.equal(r.order.blocksNewOrders,false);assert.equal(h.sends(),1);assert.equal(h.observed(),1);
 await h.service.reconcileRoute({orderId:id});assert.equal(h.observed(),1);assert.equal(h.sends(),1);
});
test('read-only reconciliation keeps blocking on mismatched wallet or token evidence',async()=>{
 for(const mode of ['token','wallet']){const h=setup();await h.service.place(input,{intentId:'reconcile-untrusted-'+mode});h.mine();const good=h.record();h.setRecord({...good,toToken:A});h.tick();await h.service.refresh();if(mode==='wallet'){h.setRecord(good);h.protocol.provider.getTransaction=async()=>({from:T});}const r=await h.service.reconcileRoute({orderId:h.service.list()[0].id});assert.equal(r.order.status,'UNKNOWN');assert.equal(h.observed(),0);assert.equal(h.sends(),1);}
});
test('temporary balance failure keeps the step observable and successful recheck records proceeds only once',async()=>{
 const h=setup();h.plan.steps.push({id:'target',role:'target',status:'PLANNED'});await h.service.place(input,{intentId:'reconcile-balance-retry'});h.mine();const actual=h.record();h.setRecord({...actual,slippage:'0.005'});h.tick();await h.service.refresh();h.setRecord(actual);let observations=0;
 h.protocol.observeRouteStep=async()=>{observations++;if(observations===1)throw Error('temporary balance RPC');return{ownedAssets:{[T]:'12'},retainedBalances:[{asset:T,amountRaw:'12',amount:'0.000000000000000012'}]};};
 const id=h.service.list()[0].id,first=await h.service.reconcileRoute({orderId:id});assert.equal(first.order.steps[0].status,'MINED');assert.equal(first.order.blocksNewOrders,true);
 const second=await h.service.reconcileRoute({orderId:id});assert.equal(second.order.steps[0].status,'CONFIRMED');assert.equal(second.order.retainedBalances[0].amountRaw,'12');assert.equal(second.order.blocksNewOrders,false);await h.service.reconcileRoute({orderId:id});assert.equal(observations,2);assert.equal(h.sends(),1);
});
