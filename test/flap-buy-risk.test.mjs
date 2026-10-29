import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEther} from 'ethers';
import {flapTradeRisk,enforceTradeRisk} from '../src/trade-risk.mjs';

const rows=JSON.parse(readFileSync(new URL('./fixtures/flap-buy-quotes-20261029.json',import.meta.url))).rows;
const ints=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==='string'&&/^\d+$/.test(v)?BigInt(v):v]));
function args(row){
 const detail=ints(row.detail),settings=ints(row.settings),q=ints(row.full.fields),r=ints(row.reference.fields),suffix=q.ACCEPT_WEI!==undefined?'WEI':'RAW';
 const quote=(f,amount)=>({input:parseEther(amount),output:f.SHARES,accepted:f['ACCEPT_'+suffix],fee:f['FEE_'+suffix],refund:f['REFUND_'+suffix],quotedBlock:String(f.BLOCK)});
 return{side:'buy',limitBps:300,detail,settings,plan:{...quote(q,row.full.amount),minimum:q.SHARES*9950n/10000n,reference:quote(r,row.reference.amount)},quoteSymbol:suffix==='WEI'?'BNB':'NVDAB',quoteDecimals:18,tokenSymbol:'SHARE'};
}
test('captured BNB and stock-quote inner buys verify impact without requiring unminted ERC20 inventory',()=>{
 for(const row of rows){const a=args(row),risk=flapTradeRisk(a);assert.equal(a.detail.inventoryKnown,false);assert.equal(risk.status,'ok');assert.equal(risk.depthVerified,true);assert.ok(risk.priceImpactBps>0&&risk.priceImpactBps<100);assert.equal(risk.feeAmount,String(Number(a.plan.fee)/1e18));assert.doesNotThrow(()=>enforceTradeRisk(risk,'buy'));assert.equal(risk.inventoryScope,'unminted-ledger-shares');}
});
test('unverified quote arithmetic, model or backing blocks new buys instead of treating unknown as zero',()=>{
 const changes=[a=>{a.plan.accepted++;},a=>{a.plan.fee++;a.plan.fee+=10n**12n;},a=>{a.plan.reference.output*=2n;},a=>{a.settings.curveK*=2n;},a=>{a.plan.reference.quotedBlock='1';},a=>{a.detail.quoteBackingEnough=false;},a=>{a.detail.quoteBalanceRaw=0n;},a=>{a.detail.token='0x1111111111111111111111111111111111111111';},a=>{a.detail.claimedShares=1n;},a=>{delete a.plan.reference;}];
 for(const change of changes){const a=args(rows[0]);change(a);const risk=flapTradeRisk(a);assert.throws(()=>enforceTradeRisk(risk,'buy'),/买入风险/);}
});
test('verified model still enforces the independent price impact limit',()=>{
 const a=args(rows[1]);a.limitBps=50;const risk=flapTradeRisk(a);assert.ok(risk.priceImpactBps>50);assert.throws(()=>enforceTradeRisk(risk,'buy'),/价格冲击/);
});
