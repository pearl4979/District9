import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {parseHTML} from 'linkedom';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const handler=app.slice(app.indexOf('  async function requestDirectOrder(){'),app.indexOf('  async function requestDirectSetup(){'));
const A='0x'+'1'.repeat(40),I='result-intent-000001';
async function renderResult({status='ROUTE_FAILED',submitted=false,error='聚合报价已到期',retainedBalances=[],refreshDuringRequest=false}={}){
 const{window,document}=parseHTML('<button id="preview-button"></button><p id="trade-error" hidden></p><p id="direct-status" hidden></p>');
 const order={id:'persisted-order',intentId:I,walletAddress:A,kind:'route',status,error,retainedBalances,steps:[{status:submitted?'CONFIRMED':'STOPPED',submissionAttempted:submitted,error}]};
 const result={intentId:I,demo:false,walletAddress:A,status,submitted,order,summary:{tradeRisk:{status:'ok'}}};
 const accepted=[],messages=[],state={previewVersion:1,previewBusy:false,executeBusy:false,session:{mode:'live'},wallet:{address:A}};
 const context=vm.createContext({window,document,$:id=>document.getElementById(id),state,accountEpoch:1,crypto:{randomUUID:()=>I},browserNow:()=>1000,
 tradeInput:()=>({amount:'0.01'}),invalidatePreview:()=>{},tradePreparation:{cancel(){}},renderControls(){},tradeFeedback:{start(){},showRisk(){},finish:(timings,message)=>messages.push(message)},
 api:async()=>{if(refreshDuringRequest)state.previewVersion++;return result;},acceptDirectOrder:order=>accepted.push(order),statusLabels:{ROUTE_PAUSED:'路线暂停',ROUTE_FAILED:'路线失败',UNKNOWN:'结果未知'},routeView:{showPlan(){}},directStatus:document.getElementById('direct-status'),setupButton:document.createElement('button'),showToast:message=>messages.push(message),loadOrders:async()=>{}});
 vm.runInContext(handler+';globalThis.place=requestDirectOrder;',context);await context.place();
 return{accepted,messages,error:document.getElementById('trade-error').textContent,errorVisible:!document.getElementById('trade-error').hidden,status:document.getElementById('direct-status').textContent};
}
test('persisted pre-submission route failure displays the real reason and retains its order',async()=>{
 const r=await renderResult();assert.equal(r.accepted.length,1);assert.equal(r.errorVisible,true);assert.match(r.error,/聚合报价已到期/);assert.match(r.messages.join(' '),/未提交/);assert.doesNotMatch(r.error,/未知下单结果/);
});
test('a partial route failure displays the cause and does not claim no transaction was sent',async()=>{
 const r=await renderResult({status:'ROUTE_PAUSED',submitted:true,error:'买入最低到账条件改变',retainedBalances:[{symbol:'GANG',amount:'10'}]});assert.equal(r.accepted.length,1);assert.equal(r.errorVisible,true);assert.match(r.error,/最低到账条件改变/);assert.match(r.messages.join(' '),/步骤|余额|留存/);assert.doesNotMatch(r.messages.join(' '),/未提交交易/);
});
test('an ambiguous submitted route remains a recorded result and is never labelled unsubmitted',async()=>{
 const r=await renderResult({status:'UNKNOWN',submitted:true,error:'提交超时'});assert.equal(r.accepted.length,1);assert.doesNotMatch(r.messages.join(' '),/未提交交易|成交成功/);
});
test('a same-wallet background refresh cannot discard an already submitted order response',async()=>{
 const r=await renderResult({status:'CONFIRMED',submitted:true,refreshDuringRequest:true});assert.equal(r.accepted.length,1);assert.ok(r.status);
});
