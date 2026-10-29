import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {createTradeService} from '../src/trades.mjs';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const mod=await import('../src/automatic-setup.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const A='0x'+'1'.repeat(40),T='0x'+'2'.repeat(40),S='0x'+'3'.repeat(40),erc=new Interface(['function approve(address,uint256)']);
const input={token:T,platformId:'gang',side:'sell',amount:'1000',slippageBps:50};
function setup({journalPath}={}){
 let allowance=0n,sends=0,head=100,latest,previews=0,builds=0;const records=new Map();
 const provider={getNetwork:async()=>({chainId:56n}),getBlockNumber:async()=>head,getBlock:async n=>({number:n,hash:'0x'+'a'.repeat(64)}),getTransaction:async h=>records.get(h)?.tx,getTransactionReceipt:async h=>records.get(h)?.receipt||null};
 const approve={from:A,to:T,value:'0',data:erc.encodeFunctionData('approve',[S,1000n])};
 const base={provider,buildTrade:async(i,guards={})=>{builds++;const summary={kind:i.side==='buy'?'buy':allowance<1000n?'approve':'sell',platformId:'gang',token:T,walletAddress:A,side:i.side,amount:i.amount,inputRaw:'1000',minimumOutputRaw:guards.minimumOutputRaw||'99',expectedOutputRaw:'100',deadline:Math.floor(Date.now()/1000)+120,spender:S,approvalAsset:T,approvalAmountRaw:'1000',simulated:true};return{kind:summary.kind,summary,transaction:summary.kind==='approve'?approve:{from:A,to:S,value:'0',data:'0x1234'}};},validateExecution:async()=>({simulated:true}),positions:async()=>({spender:S,allowance:String(allowance),balance:'1000',positionKind:'token'}),planPreapproval:async i=>({kind:'preapproval',walletAddress:A,input:i,spender:S,amountRaw:'1000',consentVersion:i.consentVersion,deadline:Math.floor(Date.now()/1000)+120,steps:[{id:'approval',role:'approval',status:'PLANNED'}],summary:{}}),buildRouteStep:async()=>({kind:'approve',transaction:approve,summary:{spender:S,approvalAsset:T,approvalAmountRaw:'1000'}}),validateRouteStep:async()=>({}),observeRouteStep:async()=>({retainedBalances:[],allowanceRaw:String(allowance)})};
 assert.equal(typeof mod.createAutomaticSetupProtocol,'function');const protocol=mod.createAutomaticSetupProtocol({protocol:base});
 const baw={wallet:async()=>({available:true,address:A}),executionContext:async()=>({available:true,address:A}),preview:async tx=>{previews++;latest=tx;return{requestId:'preview-'+(sends+1),expiresAt:Date.now()+30000,risks:{riskDetails:[],addresses:{}},simulationResult:{authorityChanges:[],allowanceChanges:[]}};},execute:async()=>{const h='0x'+String(++sends).repeat(64),block=100+sends;records.set(h,{tx:{...latest,hash:h,chainId:56n,blockHash:'0x'+'a'.repeat(64),blockNumber:block}});return{txHash:h};}};
 const service=createTradeService({protocol,baw,liveExecution:true,journalPath});
 return{service,base,previews:()=>previews,builds:()=>builds,sends:()=>sends,mine(){for(const[h,r]of records)if(!r.receipt){r.receipt={hash:h,blockHash:'0x'+'a'.repeat(64),blockNumber:r.tx.blockNumber,from:A,to:r.tx.to,status:1,logs:[]};head=r.tx.blockNumber+2;if(r.tx.to===T)allowance=1000n;}},setAllowance:n=>allowance=n};
}
test('automatic setup is opt-in; a consenting sell continues only after exact approval receipt',async()=>{
 const h=setup();await h.service.setApprovalSettings({automaticSetup:true});
 const result=await h.service.place(input,{intentId:'automatic-sell-000001',expectedWallet:A});assert.equal(result.order.route.kind,'single-setup');assert.equal(h.sends(),1);assert.equal(h.previews(),1);assert.equal(h.builds(),1);assert.equal(result.order.steps[0].kind,'approve');
 h.mine();await h.service.refresh();assert.equal(h.sends(),2);assert.equal(h.service.list()[0].steps.at(-1).kind,'sell');
 h.mine();await h.service.refresh();assert.equal(h.service.list()[0].status,'CONFIRMED');
});
test('default off still returns an action without sending an approval',async()=>{const h=setup(),result=await h.service.place(input,{intentId:'manual-setup-0000001'});assert.equal(result.status,'ACTION_REQUIRED');assert.equal(h.sends(),0);});
test('turning off automatic continuation after approval submission prevents the sell',async()=>{const h=setup();await h.service.setApprovalSettings({automaticSetup:true});await h.service.place(input,{intentId:'automatic-cancel-001'});await h.service.setApprovalSettings({automaticSetup:false});h.mine();await h.service.refresh();assert.equal(h.sends(),1);assert.notEqual(h.service.list()[0].status,'CONFIRMED');});
async function pending(h){await h.service.setApprovalSettings({enabled:true,automaticSetup:true});await h.service.place({...input,side:'buy'},{intentId:'buy-before-approval-001'});h.mine();await h.service.refresh();assert.equal(h.sends(),2);}
test('a sell waits for the existing own approval then sends the target exactly once without another approval',async()=>{
 const h=setup();await pending(h);const r=await h.service.place(input,{intentId:'queue-original-sell-01',expectedWallet:A});assert.equal(r.queued,true);assert.equal(r.submitted,false);assert.equal(r.order.steps[0].status,'WAITING_APPROVAL');assert.equal(h.sends(),2);
 h.mine();await h.service.refresh();await h.service.refresh();assert.equal(h.sends(),3);assert.equal(h.service.list()[0].steps.at(-1).kind,'sell');
 h.mine();await h.service.refresh();await h.service.refresh();assert.equal(h.sends(),3);assert.equal(h.service.list()[0].status,'CONFIRMED');
});
test('restart stops a queued sell and disabling opt-in prevents its continuation',async t=>{
 for(const mode of ['restart','disabled']){const dir=mkdtempSync(join(tmpdir(),'d9-setup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const journalPath=join(dir,'orders.json'),h=setup({journalPath});await pending(h);await h.service.place(input,{intentId:'queue-stop-test-'+mode,expectedWallet:A});
  if(mode==='restart'){const restored=setup({journalPath});assert.equal(restored.service.list()[0].status,'ROUTE_FAILED');assert.equal(restored.sends(),0);}
  else{await h.service.setApprovalSettings({automaticSetup:false});h.mine();await h.service.refresh();assert.equal(h.sends(),2);assert.equal(h.service.list()[0].status,'ROUTE_FAILED');}
 }
});
