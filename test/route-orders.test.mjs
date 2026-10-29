import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTradeService,validateInput} from '../src/trades.mjs';
const A='0x'+'1'.repeat(40),T='0x'+'2'.repeat(40),Q='0x'+'3'.repeat(40),H='0x'+'4'.repeat(64);
const input={platformId:'gang',token:T,side:'buy',amount:'0.01',slippageBps:50,maxPriceImpactBps:300,settlement:'bnb'};
function setup({live=false,journalPath}={}){
 const calls=[];let head=100,receipt=null,tx=null,wallet=A;
 const plan={kind:'bnb-sequential',walletAddress:A,input:{...input,walletAddress:A},quoteAsset:Q,quoteSymbol:'Q',quoteDecimals:18,deadline:Math.floor(Date.now()/1000)+300,originalMinimumOutputRaw:'99',summary:{settlement:'bnb',minimumOutputRaw:'99'},steps:[{id:'1',role:'bridge',label:'BNB → Q',status:'PLANNED'},{id:'2',role:'target',label:'Q → target',status:'PLANNED'}]};
 const protocol={provider:{getNetwork:async()=>({chainId:56n}),getBlock:async()=>({number:100,hash:H}),getBlockNumber:async()=>head,getTransactionReceipt:async()=>receipt,getTransaction:async()=>tx},planRoute:async()=>{calls.push('plan');return structuredClone(plan);},buildRouteStep:async(p,state)=>{calls.push('build:'+state.role);return{kind:state.role==='bridge'?'bridge-buy':'buy',transaction:{from:A,to:T,value:'0',data:state.role==='bridge'?'0x1234':'0x5678'},beforeQuoteBalanceRaw:'1000',summary:{minimumOutputRaw:'99'}};},validateRouteStep:async()=>{calls.push('validate');},observeRouteStep:async(p,step,r,state)=>{calls.push('observe:'+step.role);return{ownedQuoteRaw:'101',retainedBalances:[{asset:Q,symbol:'Q',amountRaw:'101'}]};},buildTrade:async()=>{throw Error('not single step');}};
 const baw={wallet:async()=>({available:true,address:wallet}),preview:async t=>{calls.push('preview');tx={...t,hash:H,chainId:56n,blockHash:H,blockNumber:100};return{requestId:'request-'+calls.length,expiresAt:Date.now()+30000,risks:{riskDetails:[],addresses:{}},simulationResult:{authorityChanges:[],allowanceChanges:[]}};},execute:async()=>{calls.push('send');return{txHash:H};}};
 const service=createTradeService({protocol,baw,liveExecution:live,journalPath});
 return{service,protocol,baw,calls,plan,setWallet:x=>wallet=x,mine:(confirmations=3,status=1)=>{head=100+confirmations-1;receipt={hash:H,blockHash:H,status,blockNumber:100,from:A,to:tx?.to||T,logs:[]};}};
}
test('settlement validated and closed multi-step orders never request BAW preview or submission',async()=>{
 assert.doesNotThrow(()=>validateInput(input));assert.throws(()=>validateInput({...input,settlement:'usd'}),/结算|settlement/);
 const h=setup(),r=await h.service.place(input,{intentId:'route-closed-00001'});assert.equal(r.status,'PREVIEW_ONLY');assert.equal(r.route.kind,'bnb-sequential');assert.equal(r.route.steps.length,2);assert.equal(r.submitted,false);assert.deepEqual(h.calls,['plan']);assert.deepEqual(h.service.list(),[]);
});
test('manual preview rejects future-funded route before requesting wallet preview',async()=>{
 const h=setup();await assert.rejects(h.service.preview(input),/多步骤|路线|逐步/);assert.equal(h.calls.includes('preview'),false);
});
test('bridge receipt waits three confirmations before target build and no success until final receipt',async()=>{
 const h=setup({live:true}),first=await h.service.place(input,{intentId:'route-live-000001'});assert.equal(first.order.kind,'route');assert.equal(first.order.status,'ROUTE_RUNNING');assert.deepEqual(h.calls,['plan','build:bridge','preview','validate','send']);
 h.mine(2);await h.service.refresh();assert.equal(h.calls.includes('build:target'),false);h.mine(3);await h.service.refresh();assert.ok(h.calls.indexOf('observe:bridge')<h.calls.indexOf('build:target'));assert.equal(h.service.list()[0].status,'ROUTE_RUNNING');assert.equal(h.service.list()[0].steps[0].status,'CONFIRMED');await h.service.refresh();assert.equal(h.service.list()[0].status,'CONFIRMED');
});
test('unknown bridge never advances or retries and settlement is part of immutable intent',async()=>{
 const h=setup({live:true});h.baw.execute=async()=>{h.calls.push('send');throw Error('timeout');};const r=await h.service.place(input,{intentId:'route-unknown-001'});assert.equal(r.order.status,'UNKNOWN');await h.service.refresh();await h.service.place(input,{intentId:'route-unknown-001'});assert.equal(h.calls.filter(x=>x==='send').length,1);assert.equal(h.calls.includes('build:target'),false);await assert.rejects(h.service.place({...input,settlement:'quote'},{intentId:'route-unknown-001'}),/绑定|不同/);
});
test('durable steps are persisted before send and restart pauses instead of auto advancing',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'bnb-routes-'));t.after(()=>rm(dir,{recursive:true,force:true}));const journalPath=join(dir,'orders.json'),h=setup({live:true,journalPath});const send=h.baw.execute;h.baw.execute=async()=>{const [o]=JSON.parse(await readFile(journalPath));assert.equal(o.steps[0].status,'SUBMITTING');assert.equal(o.steps[0].transaction.from,A);return send();};await h.service.place(input,{intentId:'route-restart-001'});
 const restarted=setup({live:true,journalPath});restarted.protocol.provider.getTransaction=h.protocol.provider.getTransaction;restarted.mine();await restarted.service.refresh();assert.equal(restarted.service.list()[0].status,'ROUTE_PAUSED');assert.equal(restarted.calls.includes('send'),false);const r=await restarted.service.place(input,{intentId:'route-restart-001'});assert.equal(r.order.status,'ROUTE_PAUSED');
});
test('later risk failure, kill switch and changed wallet retain bridge result and stop target send',async()=>{
 for(const mode of ['risk','kill','wallet']){const h=setup({live:true});await h.service.place(input,{intentId:'route-stop-'+mode+'-0001'});h.mine();if(mode==='risk'){const build=h.protocol.buildRouteStep;h.protocol.buildRouteStep=async(p,s)=>{if(s.role==='target')throw Error('risk changed');return build(p,s);};}if(mode==='kill')h.service.setLiveExecution(false);if(mode==='wallet')h.setWallet(Q);await h.service.refresh();const o=h.service.list()[0];assert.match(o.status,/ROUTE_FAILED|ROUTE_PAUSED/);assert.equal(o.retainedBalances[0].amountRaw,'101');assert.equal(h.calls.filter(x=>x==='send').length,1);}
});
test('receipt chain mismatch never advances route',async()=>{
 const h=setup({live:true});await h.service.place(input,{intentId:'route-chain-00001'});h.mine();h.protocol.provider.getNetwork=async()=>({chainId:1n});await h.service.refresh();assert.equal(h.calls.filter(x=>x==='send').length,1);assert.equal(h.service.list()[0].status,'UNKNOWN');
});
test('route approval auto-advance requires exact proven allowance; unknown or excessive changes stop',async()=>{
 for(const mode of ['unknown','excess','authority']){
 const h=setup({live:true});h.protocol.buildRouteStep=async()=>({kind:'approve',transaction:{from:A,to:Q,value:'0',data:'0x095ea7b300000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000064'},summary:{approvalAsset:Q,spender:T,approvalAmountRaw:'100'}});
 const original=h.baw.preview;h.baw.preview=async tx=>{const r=await original(tx);r.simulationResult.allowanceChanges=mode==='unknown'?[{}]:[{tokenAddress:Q,owner:A,spender:T,newAllowanceRaw:mode==='excess'?'1000':'100'}];if(mode==='authority')r.simulationResult.authorityChanges=[{}];return r;};
 const r=await h.service.place(input,{intentId:'route-approve-'+mode+'-001'});assert.equal(r.submitted,false);assert.equal(h.calls.includes('send'),false);assert.match(r.order.error,/授权|权限/);
 }
});
test('reverted first step stops without calling target builder',async()=>{
 const h=setup({live:true});await h.service.place(input,{intentId:'route-reverted-001'});h.mine(3,0);await h.service.refresh();assert.equal(h.service.list()[0].status,'ROUTE_FAILED');assert.equal(h.calls.includes('build:target'),false);
});
test('kill switch changed during step build prevents even wallet preview',async()=>{
 const h=setup({live:true}),build=h.protocol.buildRouteStep;h.protocol.buildRouteStep=async(...args)=>{const b=await build(...args);h.service.setLiveExecution(false);return b;};
 await h.service.place(input,{intentId:'route-kill-build01'});assert.equal(h.calls.includes('preview'),false);assert.equal(h.calls.includes('send'),false);
});
test('canonical receipt block mismatch stops advancement despite matching calldata',async()=>{
 const h=setup({live:true});await h.service.place(input,{intentId:'route-block-match01'});h.mine();h.protocol.provider.getBlock=async()=>({number:100,hash:'0x'+'9'.repeat(64)});await h.service.refresh();assert.equal(h.service.list()[0].status,'UNKNOWN');assert.equal(h.calls.filter(x=>x==='send').length,1);
});
test('canonical exact approval with empty risk and opaque-change arrays can advance only after receipt',async()=>{
 const h=setup({live:true}),build=h.protocol.buildRouteStep;let approved=false;
 h.protocol.buildRouteStep=async(p,s)=>{if(!approved)return{kind:'approve',beforeQuoteBalanceRaw:'1000',transaction:{from:A,to:Q,value:'0',data:'0x095ea7b300000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000064'},summary:{approvalAsset:Q,spender:T,approvalAmountRaw:'100',inputRaw:'100'}};return build(p,s);};
 const observe=h.protocol.observeRouteStep;h.protocol.observeRouteStep=async(...args)=>{approved=true;return observe(...args);};
 await h.service.place(input,{intentId:'route-exact-approve01'});assert.equal(h.calls.filter(x=>x==='send').length,1);assert.equal(h.service.list()[0].steps[0].kind,'approve');h.mine();await h.service.refresh();assert.equal(h.calls.filter(x=>x==='send').length,2);assert.equal(h.service.list()[0].steps[0].status,'CONFIRMED');assert.equal(h.service.list()[0].status,'ROUTE_RUNNING');
});
test('fully confirmed partial route can be followed by new explicit intent but old route never resumes',async()=>{
 const h=setup({live:true}),build=h.protocol.buildRouteStep;await h.service.place(input,{intentId:'route-partial-001'});h.protocol.buildRouteStep=async(p,s)=>{if(s.role==='target')throw Error('target risk changed');return build(p,s);};h.mine();await h.service.refresh();assert.equal(h.service.list()[0].status,'ROUTE_PAUSED');h.protocol.buildRouteStep=build;
 const second=await h.service.place(input,{intentId:'route-new-intent01'});assert.equal(second.order.status,'ROUTE_RUNNING');assert.equal(h.calls.filter(c=>c==='send').length,2);assert.equal((await h.service.place(input,{intentId:'route-partial-001'})).order.status,'ROUTE_PAUSED');
});
test('manual wallet preview cannot race a pending sequential route',async()=>{
 const h=setup({live:true});await h.service.place(input,{intentId:'route-preview-lock1'});h.protocol.planRoute=async()=>null;await assert.rejects(h.service.preview({...input,settlement:'quote'}),/处理中或未完成的 BNB 路线/);assert.equal(h.calls.filter(c=>c==='preview').length,1);
});
test('manual execute cannot acquire submit lock while direct BNB intent is still planning',async()=>{
 const h=setup({live:true}),plan=h.protocol.planRoute;h.protocol.planRoute=async i=>i.settlement==='bnb'?plan(i):null;h.protocol.buildTrade=async()=>({kind:'buy',transaction:{from:A,to:T,value:'0',data:'0x1234'},summary:{kind:'buy'}});h.protocol.validateExecution=async()=>{};
 const preview=await h.service.preview({...input,settlement:'quote'});let release,entered;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);h.protocol.planRoute=async i=>{entered();await hold;return plan(i);};
 const route=h.service.place(input,{intentId:'route-planning-lock1'});await started;
 try{await assert.rejects(h.service.execute({previewId:preview.id,confirmed:true}),/处理|未完成/);}finally{release();await route;}
 assert.equal(h.calls.filter(c=>c==='send').length,1);assert.equal(h.service.list().length,1);assert.equal(h.service.list()[0].kind,'route');
});
