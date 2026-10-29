import test from 'node:test';
import assert from 'node:assert/strict';
import {recordAllowanceConsumption,verifiedAllowanceChanges} from '../src/allowance-consumption.mjs';
import {verifyRouteWalletPreview} from '../src/route-orders.mjs';
import {Interface} from 'ethers';
const owner='0x'+'1'.repeat(40),asset='0x'+'2'.repeat(40),spender='0x'+'3'.repeat(40),other='0x'+'4'.repeat(40);
const actual=1978188419586760560084435n;
function fixture(before=actual,amount=before){
 const transaction={from:owner,to:spender,value:'0',data:'0x12345678'};
 recordAllowanceConsumption(transaction,{asset,owner,spender,before,amount});
 const change={tokenAddress:asset,owner,spender,preAmount:Number(before),postAmount:Number(before-amount),tokenType:'Erc20',tokenId:null};
 return{transaction,change};
}
test('full and partial sells use exact independent amounts despite unsafe wallet JSON numbers',()=>{
 for(const [before,amount] of [[actual,actual],[actual,1000000000000000000000n],[1000n,400n]]){
  const {transaction,change}=fixture(before,amount);
  assert.equal(verifiedAllowanceChanges([change],transaction),true);
  assert.equal(verifiedAllowanceChanges([{...change,preAmount:String(before),postAmount:String(before-amount)}],transaction),true);
 }
 const {transaction,change}=fixture((1n<<256n)-1n,100n);
 assert.equal(verifiedAllowanceChanges([{...change,postAmount:change.preAmount}],transaction),true,'infinite allowance may stay unchanged');
});
test('foreign owners, tokens, spenders, increases and imprecise string amounts cannot pass as consumption',()=>{
 const {transaction,change}=fixture();
 for(const delta of [{owner:other},{tokenAddress:other},{spender:other},{postAmount:Number(actual*2n)},{preAmount:0},{preAmount:String(actual+1n)},{postAmount:'1'},{tokenType:'Erc721'},{tokenId:'1'}])assert.equal(verifiedAllowanceChanges([{...change,...delta}],transaction),false,JSON.stringify(delta));
 assert.equal(verifiedAllowanceChanges([change,change],transaction),false);
 assert.equal(verifiedAllowanceChanges(null,transaction),false);
});
test('transaction copies and mutations cannot forge builder consumption evidence',()=>{
 const {transaction,change}=fixture();
 assert.equal(verifiedAllowanceChanges([change],{...transaction}),false);
 transaction.data='0xdeadbeef';assert.equal(verifiedAllowanceChanges([change],transaction),false);
 assert.throws(()=>recordAllowanceConsumption(transaction,{asset,owner,spender,before:Number(actual),amount:1n}),/evidence/);
});
test('ambiguous rounded finite changes cannot conceal an increase; exact string consumption still works',()=>{
 const {transaction,change}=fixture(actual,1n);
 const increased={...change,postAmount:Number(actual+1000000n)};
 assert.equal(increased.preAmount,increased.postAmount,'real uint256 JSON rounding collision');
 assert.equal(verifiedAllowanceChanges([increased],transaction),false);
 assert.equal(verifiedAllowanceChanges([{...change,postAmount:String(actual-1n)}],transaction),true);
});
test('valid allowance consumption never overrides wallet risk or authority changes',()=>{
 const {transaction,change}=fixture(),raw={risks:{addresses:{},riskDetails:[]},simulationResult:{authorityChanges:[],allowanceChanges:[change]}};
 assert.doesNotThrow(()=>verifyRouteWalletPreview(raw,{kind:'sell',transaction}));
 for(const changed of [{...raw,risks:{addresses:{[other]:{}},riskDetails:[]}},{...raw,simulationResult:{...raw.simulationResult,authorityChanges:[{}]}},{...raw,risks:null}])assert.throws(()=>verifyRouteWalletPreview(changed,{kind:'sell',transaction}));
});
test('an exact approve simulation may describe only the calldata-bound asset owner spender and cap',()=>{
 const amount=123456789012345678901234n,transaction={from:owner,to:asset,value:'0',data:new Interface(['function approve(address,uint256)']).encodeFunctionData('approve',[spender,amount])};
 const step={kind:'approve',transaction,summary:{approvalAsset:asset,spender,approvalAmountRaw:String(amount)}};
 const change={tokenType:'Erc20',tokenId:null,tokenAddress:asset,owner,spender,preAmount:0,postAmount:Number(amount)};
 const raw=c=>({risks:{addresses:{},riskDetails:[]},simulationResult:{authorityChanges:[],allowanceChanges:c}});
 assert.doesNotThrow(()=>verifyRouteWalletPreview(raw([change]),step));
 for(const delta of [{owner:other},{spender:other},{tokenAddress:other},{postAmount:String(amount+1n)},{tokenType:'Erc721'},{preAmount:-1}])assert.throws(()=>verifyRouteWalletPreview(raw([{...change,...delta}]),step));
 assert.throws(()=>verifyRouteWalletPreview(raw([change,change]),step));
});
