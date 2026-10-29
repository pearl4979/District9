import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpServer} from '../src/server.mjs';
import {createDemo} from '../src/demo.mjs';

test('independent demo supplies reviewable risk data and blocks a large simulated buy before preview',async()=>{
 const d=createDemo(),t=d.monitor.snapshot().tokens[0],wallet=(await d.baw.wallet()).address;
 const small=await d.protocol.buildTrade({token:t.address,walletAddress:wallet,side:'buy',amount:'0.01',slippageBps:50,maxPriceImpactBps:300});
 assert.equal(small.summary.tradeRisk.outputSymbol,'SIGNAL');assert.equal(small.summary.tradeRisk.feeAmount,'0.0001');assert.equal(small.summary.tradeRisk.nativeGasBudget,'0.000005');assert.match(small.summary.tradeRisk.warnings.join(' '),/演示/);
 await assert.rejects(d.protocol.buildTrade({token:t.address,walletAddress:wallet,side:'buy',amount:'1',slippageBps:50,maxPriceImpactBps:300}),e=>e.tradeRisk?.status==='blocked');
});

test('progress endpoint is read-only and blocked preview exposes structured risk without a wallet operation',async t=>{
 let previews=0;const tradeRisk={status:'blocked',priceImpactBps:900,blockReasons:['价格冲击超过上限']};
 const trades={progress:()=>({operation:'preview',stage:'quote-simulation',startedAt:1000,elapsedMs:200}),preview:async()=>{previews++;throw Object.assign(Error('价格冲击过高'),{tradeRisk});},list:()=>[]};
 const server=createHttpServer({monitor:{snapshot:()=>({tokens:[]})},baw:{wallet:()=>{throw Error('must not call wallet');}},protocol:{},trades});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;const progress=await(await fetch(base+'/api/trade-progress')).json();assert.equal(progress.stage,'quote-simulation');assert.equal(previews,0);
 const session=await(await fetch(base+'/api/session')).json();const result=await fetch(base+'/api/preview',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:'{}'});assert.equal(result.status,400);assert.deepEqual((await result.json()).tradeRisk,tradeRisk);
});
