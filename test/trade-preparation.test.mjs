import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradeService } from '../src/trades.mjs';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),T='0x'+'3'.repeat(40);
const input={token:T,platformId:'four',side:'buy',amount:'0.01',slippageBps:100,maxPriceImpactBps:300};
function setup(){let time=10000,address=A,route='inner-v1',builds=0,checks=0,previews=0,sends=0;
 const protocol={preparationKey:async()=>route,buildTrade:async i=>{builds++;return{kind:'buy',transaction:{from:i.walletAddress,to:T,value:'1',data:'0x1234'},summary:{amount:i.amount,tradeRisk:{status:'ok'}}};},validateExecution:async()=>{checks++;}};
 const baw={executionContext:async()=>({address,available:true}),preview:async()=>{previews++;return{requestId:'request',expiresAt:100000};},execute:async()=>{sends++;return {status:'PENDING_CONFIRMATION'};}};
 const service=createTradeService({baw,protocol,liveExecution:true,now:()=>time,performanceNow:()=>time});
 return {service,protocol,baw,counts:()=>({builds,checks,previews,sends}),advance:ms=>time+=ms,setAddress:x=>address=x,setRoute:x=>route=x};
}
test('read-only preparation never creates a wallet request; matching preview consumes one short-lived quote',async()=>{
 const h=setup();assert.equal(typeof h.service.prepare,'function');const ready=await h.service.prepare(input);
 assert.equal(ready.readOnly,true);assert.equal(ready.expiresAt,13000);assert.equal(ready.raw,undefined);assert.equal(ready.transaction,undefined);assert.equal(ready.id,undefined);assert.equal(h.counts().previews,0);assert.equal(h.counts().sends,0);
 h.advance(200);const p=await h.service.preview(input);assert.equal(p.preparation.reused,true);assert.equal(p.preparation.ageMs,200);assert.equal(h.counts().builds,1);assert.equal(h.counts().previews,1);
 await assert.rejects(h.service.execute({previewId:p.id,confirmed:false}),/确认/);await h.service.execute({previewId:p.id,confirmed:true});assert.equal(h.counts().checks,1);assert.equal(h.counts().sends,1);
});
test('wallet, route, quote TTL, input, or execution version changes prevent reuse',async()=>{
 for(const mode of ['wallet','route','expiry','amount','slippage','impact','side','switch']){
  const h=setup();assert.equal(typeof h.service.prepare,'function');await h.service.prepare(input);let next={...input};
  if(mode==='wallet')h.setAddress(B);if(mode==='route')h.setRoute('graduated');if(mode==='expiry')h.advance(3000);if(mode==='amount')next.amount='0.02';if(mode==='slippage')next.slippageBps=101;if(mode==='impact')next.maxPriceImpactBps=200;if(mode==='side')next.side='sell';if(mode==='switch')h.service.setLiveExecution(false);
  const p=await h.service.preview(next);assert.equal(p.preparation?.reused,false,mode);assert.equal(h.counts().builds,2,mode);
 }
});
test('preparation failure does not become a successful preview and changed risk is checked at execution',async()=>{
 const h=setup();assert.equal(typeof h.service.prepare,'function');h.protocol.buildTrade=async()=>{throw Error('depth unknown');};await assert.rejects(h.service.prepare(input),/depth/);assert.equal(h.counts().previews,0);
 const k=setup();await k.service.prepare(input);const p=await k.service.preview(input);k.protocol.validateExecution=async()=>{throw Error('impact changed');};await assert.rejects(k.service.execute({previewId:p.id,confirmed:true}),/impact/);assert.equal(k.counts().sends,0);
});
function routeSetup(){const h=setup();let plans=0;h.protocol.planRoute=async i=>{plans++;return{kind:'binance-sequential',walletAddress:i.walletAddress,input:i,deadline:Math.floor(10000/1000)+120,steps:[{role:'market',label:'funding',status:'PLANNED'}],summary:{walletAddress:i.walletAddress,amount:i.amount}};};h.service.setLiveExecution(false);return{...h,plans:()=>plans};}
test('one-click reuses a matching just-completed route preparation without repeating its entire plan',async()=>{const h=routeSetup();await h.service.prepare(input);h.advance(200);const r=await h.service.place(input,{intentId:'warm-route-click-0001',expectedWallet:A});assert.equal(h.plans(),1);assert.equal(r.preparation.reused,true);assert.equal(r.submitted,false);assert.equal(r.status,'PREVIEW_ONLY');assert.equal(h.counts().previews,0);assert.equal(h.counts().sends,0);});
test('expired route preparation, changed wallet, route, input or switch cannot bypass fresh planning',async()=>{for(const mode of ['expiry','wallet','route','amount','switch']){const h=routeSetup();await h.service.prepare(input);let next={...input};if(mode==='expiry')h.advance(3000);if(mode==='wallet')h.setAddress(B);if(mode==='route')h.setRoute('new phase');if(mode==='amount')next.amount='0.02';if(mode==='switch')h.service.setLiveExecution(false);await h.service.place(next,{intentId:'warm-invalid-'+mode+'-0001'});assert.equal(h.plans(),2,mode);assert.equal(h.counts().sends,0);}});
test('warm route still runs fresh execution guards before any wallet request',async()=>{const h=routeSetup();h.service.setLiveExecution(true);let checks=0;h.protocol.buildRouteStep=async()=>{checks++;throw Error('fresh impact changed');};await h.service.prepare(input);h.advance(200);const r=await h.service.place(input,{intentId:'warm-fresh-guard-0001',expectedWallet:A});assert.equal(h.plans(),1);assert.equal(checks,1);assert.equal(r.order.status,'ROUTE_FAILED');assert.match(r.order.error,/impact changed/);assert.equal(h.counts().sends,0);assert.equal(h.counts().previews,0);});
test('slow background plan is reusable briefly after completion, not only from its original start',async()=>{const h=routeSetup(),plan=h.protocol.planRoute;h.protocol.planRoute=async i=>{h.advance(10000);return plan(i);};await h.service.prepare(input);h.advance(100);const r=await h.service.place(input,{intentId:'warm-slow-prepare-001'});assert.equal(r.preparation.reused,true);assert.equal(h.plans(),1);assert.equal(h.counts().sends,0);});

test('one-click native order shares its initial wallet check with preview but independently rechecks before sending',async()=>{
 const h=setup();let contexts=0,plans=0;
 h.baw.executionContext=async()=>{contexts++;return{available:true,address:A};};
 h.baw.preview=async()=>({requestId:'direct-request',expiresAt:100000,risks:{addresses:{},riskDetails:[]},simulationResult:{authorityChanges:[],allowanceChanges:[]}});
 h.protocol.planRoute=async()=>{plans++;return null;};
 const r=await h.service.place(input,{intentId:'native-minimal-check-0001',expectedWallet:A});
 assert.equal(r.submitted,true);assert.equal(contexts,2);assert.equal(plans,1);assert.equal(h.counts().checks,1);assert.equal(h.counts().sends,1);
});

test('slow native preparation is reserved on click before wallet loading while original quote deadline stays bounded',async()=>{
 const h=setup(),build=h.protocol.buildTrade;let contexts=0;
 h.protocol.buildTrade=async i=>{h.advance(10000);return build(i);};
 h.baw.executionContext=async()=>{contexts++;h.advance(6000);return{available:true,address:A};};
 h.baw.preview=async()=>({requestId:'warm-native-request',expiresAt:100000,risks:{addresses:{},riskDetails:[]},simulationResult:{authorityChanges:[],allowanceChanges:[]}});
 const ready=await h.service.prepare(input);assert.ok(ready.remainingMs>0);
 const r=await h.service.place(input,{intentId:'native-slow-prepare-0001',expectedWallet:A});
 assert.equal(r.submitted,true);assert.equal(r.preparation.reused,true);assert.equal(h.counts().builds,1);assert.equal(contexts,3);
});
