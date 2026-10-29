import test from 'node:test';import assert from 'node:assert/strict';
const module=await import('../src/portfolio.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const A='0x'+'a'.repeat(40),W='0x'+'b'.repeat(40),other='0x'+'c'.repeat(40);
const fills=[{id:'one',side:'buy',quantity:'10',costUsd:'100',confirmed:true},{id:'two',side:'sell',quantity:'4',proceedsUsd:'60',confirmed:true}];
test('weighted average uses confirmed net fills and checks the exact remaining balance',()=>{assert.equal(typeof module.calculatePnl,'function');const p=module.calculatePnl({fills,balance:'6',valueUsd:'90',historyComplete:true});assert.equal(p.realizedUsd,'20');assert.equal(p.unrealizedUsd,'30');assert.equal(p.costUsd,'60');assert.equal(p.totalUsd,'50');});
test('missing basis, transfers, balance drift, unconfirmed or duplicate fills cannot fabricate profit',()=>{assert.equal(typeof module.calculatePnl,'function');for(const change of [{historyComplete:false},{balance:'7'},{fills:[...fills,{id:'x',side:'transfer-in',quantity:'1',confirmed:true}]},{fills:[{...fills[0],confirmed:false}]},{fills:[...fills,fills[0]]},{fills:[{...fills[0],costUsd:null},fills[1]]}]){const p=module.calculatePnl({fills,balance:'6',valueUsd:'90',historyComplete:true,...change});assert.equal(p.totalUsd,null);assert.equal(p.realizedUsd,null);}});
test('PNL handles loss, zero balance and decimal amounts without binary float arithmetic',()=>{assert.equal(typeof module.calculatePnl,'function');const p=module.calculatePnl({historyComplete:true,balance:'0',valueUsd:'0',fills:[{id:'1',side:'buy',quantity:'0.3',costUsd:'0.3',confirmed:true},{id:'2',side:'sell',quantity:'0.3',proceedsUsd:'0.2',confirmed:true}]});assert.equal(p.totalUsd,'-0.1');});
test('portfolio reads only the connected wallet, filters chains and preserves unknown cost/coverage',async()=>{
 assert.equal(typeof module.createPortfolioService,'function');let trades=0;
 const service=module.createPortfolioService({wallet:async()=>({status:'CONNECTED',address:W,balance:'1',raw:{balance:[{address:A,symbol:'A',binanceChainId:'56',balance:'6',price:'15'},{address:other,symbol:'OTHER',binanceChainId:'1',balance:'100',price:'2'}]}}),snapshot:async()=>({tokens:[{address:A,verified:true,platformId:'four',symbol:'A'}]}),protocol:{execute(){trades++;}},orders:()=>[]});
 const p=await service.get();assert.equal(p.address,W);assert.equal(p.holdings.length,1);assert.equal(p.holdings[0].balance,'6');assert.equal(p.holdings[0].valueUsd,'90');assert.equal(p.holdings[0].pnl.totalUsd,null);assert.equal(p.summary.valueUsd,'90');assert.equal(p.summary.pnlUsd,null);assert.equal(p.coverage.complete,false);assert.equal(trades,0);
});
test('real portfolio rejects demo ledger values and disconnected states never read positions',async()=>{
 assert.equal(typeof module.createPortfolioService,'function');let calls=0;
 const s=module.createPortfolioService({wallet:async()=>({status:'UNCONNECTED',address:null}),snapshot:async()=>{calls++;return{tokens:[]};},protocol:{positions(){calls++;}}});const p=await s.get();assert.equal(p.connected,false);assert.equal(p.summary.pnlUsd,null);assert.equal(calls,0);
});
test('a retained wallet response with the wrong owner cannot value another account balance',async()=>{
 assert.equal(typeof module.createPortfolioService,'function');
 const s=module.createPortfolioService({wallet:async()=>({status:'CONNECTED',address:W,balance:'1',assets:[{address:A,balance:'6',price:'15',symbol:'A',binanceChainId:'56'}]}),snapshot:async()=>({tokens:[]}),ledger:async()=>({address:other,complete:true,assets:[{address:A,fills}]}),demo:false});const p=await s.get();assert.equal(p.holdings[0].pnl.totalUsd,null);
});

test('one failing share source stays unknown while another verified position still displays',async()=>{
 const shareA={address:A,verified:true,positionKind:'shares',platformId:'flap',symbol:'A'},shareB={...shareA,address:other,symbol:'B'};
 const s=module.createPortfolioService({wallet:async()=>({status:'CONNECTED',address:W,balance:'1'}),snapshot:async()=>({tokens:[shareA,shareB]}),orders:()=>[{token:A,positionKind:'shares'},{token:other,positionKind:'shares'}],protocol:{positions:async id=>{if(id===A)throw Error('RPC');return{address:W,token:id,positionKind:'shares',balance:'1230000000000000000',decimals:18};}}});const p=await s.get();assert.equal(p.holdings.length,1);assert.equal(p.holdings[0].balance,'1.23');assert.equal(p.holdings[0].valueUsd,null);assert.equal(p.coverage.invalidCount,1);assert.equal(p.summary.pnlUsd,null);
});

test('a stalled position provider cannot hold the portfolio response indefinitely',async()=>{
 const service=module.createPortfolioService({timeoutMs:20,wallet:async()=>({status:'CONNECTED',address:W}),snapshot:async()=>({tokens:[{address:A,verified:true,positionKind:'shares',platformId:'flap',symbol:'A'}]}),orders:()=>[{token:A,positionKind:'shares'}],protocol:{positions:()=>new Promise(()=>{})}});
 const p=await Promise.race([service.get(),new Promise((_,reject)=>setTimeout(()=>reject(Error('portfolio source did not time out')),150))]);assert.equal(p.coverage.invalidCount,1);assert.equal(p.holdings.length,0);
});
