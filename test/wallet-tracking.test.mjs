import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

let createWalletTracking;
try { ({createWalletTracking}=await import('../src/wallet-tracking.mjs')); } catch(e) { if(e.code!=='ERR_MODULE_NOT_FOUND')throw e; }
const a=n=>`0x${String(n).padStart(40,'0')}`, tx=`0x${'ab'.repeat(32)}`;
const market={address:a(2),platformId:'gang',verified:true,name:'Known',symbol:'KNOWN',phase:'bonding',decimals:18,quoteSymbol:'WBNB'};
const event=(extra={})=>({id:`${tx}:1:${a(1)}`,walletAddress:a(1),tokenAddress:a(2),platformId:'gang',side:'buy',timestamp:'2026-10-27T10:00:00.000Z',txHash:tx,blockNumber:100,logIndex:1,transactionIndex:0,confirmed:true,tokenAmount:'12',quoteAmount:'0.1',quoteSymbol:'WBNB',source:'Gang Buy',...extra});
const now=()=>Date.parse('2026-10-27T10:01:00.000Z');
const create=opts=>{assert.equal(typeof createWalletTracking,'function','tracking service is implemented');return createWalletTracking({snapshot:()=>({tokens:[market]}),now,...opts});};
const valuation=(extra={})=>({kind:'event-snapshot',value:'8333333.333333333333333333333333333333333333',unit:'WBNB',basis:'execution-FDV',source:'Gang Buy 用户含费用成交均价 × 已核验最大供应量；非现货市值',blockNumber:100,timestamp:'2026-10-27T10:00:00.000Z',...extra});

test('event-time valuation survives private storage and latest market refresh without being replaced',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-valuation-'));t.after(()=>rm(dir,{recursive:true,force:true}));const storagePath=join(dir,'tracking.json');
 let current={...market,marketCap:{value:999999,unit:'USD'}};
 const service=create({storagePath,snapshot:()=>({tokens:[current]}),poll:async()=>({events:[event({source:'BSC gang 原生Buy成功回执',phase:'bonding',valuation:valuation()})],cursor:100,status:{state:'live'}})});
 await service.saveWallet({address:a(1)});await service.tick();
 assert.deepEqual((await service.snapshot()).events[0].valuation,valuation());
 current={...current,marketCap:{value:888888,unit:'USD'}};await service.tick();
 const restored=create({storagePath});await restored.ready;
 const e=(await restored.snapshot()).events[0];assert.deepEqual(e.valuation,valuation());assert.equal(e.market.marketCap.value,888888);
 const disk=JSON.parse(await readFile(storagePath,'utf8'));assert.deepEqual(disk.events[0].valuation,valuation());
 disk.events[0].valuation={...valuation(),timestamp:'2026-10-27T09:59:59.000Z'};await writeFile(storagePath,JSON.stringify(disk));
 const invalid=create({storagePath});await invalid.ready;assert.equal((await invalid.snapshot()).events[0].valuation,null,'storage recovery revalidates event snapshots');
});

test('mismatched, latest-market, foreign-source and transfer valuation snapshots are rejected at ingestion',async()=>{
 const variants=[
  {valuation:valuation({blockNumber:101})},{valuation:valuation({timestamp:'2026-10-27T09:59:59.000Z'})},{valuation:valuation({unit:'USD'})},
  {valuation:valuation({kind:'latest-market'})},{valuation:valuation({basis:'circulating-market-cap'})},{valuation:valuation({source:'current market cap'})},
  {valuation:valuation({value:'NaN'})},{valuation:valuation({value:'0'})},{valuation:valuation({value:'1e9'})},
  {source:'BSC Pancake V2 已核验Swap；钱包与池直接代币量；池计价量',valuation:valuation()},{side:'transfer-in',valuation:valuation()},
 ];
 for(const extra of variants){
  const service=create({poll:async()=>({events:[event({source:'BSC gang 原生Buy成功回执',phase:'bonding',valuation:valuation(),...extra})],cursor:100,status:{state:'live'}})});
  await service.saveWallet({address:a(1)});await service.tick();assert.equal((await service.snapshot()).events[0].valuation,null,JSON.stringify(extra));
 }
});

test('legacy events and demo signals remain without fabricated valuation',async()=>{
 for(const demo of [false,true]){
  const service=create({demo,poll:async()=>({events:[event({demo,source:demo?'DEMO · 独立模拟信号':'BSC gang 原生Buy成功回执',valuation:demo?valuation():undefined})],cursor:100,status:{state:'live'}})});
  await service.saveWallet({address:a(1)});await service.tick();assert.equal((await service.snapshot()).events[0].valuation,null);
 }
});

test('wallet management validates profiles and persists local notes and separate avatar preference',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const storagePath=join(dir,'tracking.json');
 const service=create({storagePath});await service.ready;
 await assert.rejects(service.saveWallet({address:'invalid'}),/地址/);
 await assert.rejects(service.saveWallet({address:a(1),xUrl:'https://x.com.evil.example/name'}),/X/);
 await assert.rejects(service.saveWallet({address:a(1),xUrl:'https://x.com/name/status/1'}),/X/);
 await assert.rejects(service.saveWallet({address:a(1),avatar:'https://example.com/avatar.png'}),/头像/);
 await service.saveWallet({address:a(1),note:'<img onerror=bad>',xUrl:'https://twitter.com/trader_1'});
 await service.setPreferences({showAvatars:false});
 const restored=create({storagePath});await restored.ready;const state=await restored.snapshot();
 assert.equal(state.wallets[0].note,'<img onerror=bad>');assert.equal(state.wallets[0].xUrl,'https://x.com/trader_1');assert.equal(state.preferences.showAvatars,false);
 assert.equal(JSON.parse(await readFile(storagePath,'utf8')).wallets.length,1);
 await restored.removeWallet({address:a(1)});assert.equal((await restored.snapshot()).wallets.length,0);
});

test('successful polls deduplicate verified signals, retain known graduated markets and reject foreign events',async()=>{
 let tokens=[market],calls=0;const signal=event();const service=create({snapshot:()=>({tokens}),poll:async()=>{calls++;return{events:[signal,signal,event({id:'foreign',tokenAddress:a(9)}),event({id:'not-confirmed',confirmed:false})],cursor:100,status:{state:'live',coveredFromBlock:80,lastBlock:100,lagBlocks:0,coverage:'区块80起'}};}});
 await service.saveWallet({address:a(1),note:'Alice'});await service.tick();await service.tick();let state=await service.snapshot();
 assert.equal(state.events.length,1);assert.equal(state.events[0].market.symbol,'KNOWN');assert.equal(state.status.state,'live');assert.equal(calls,2);
 tokens=[{...market,phase:'graduated',pair:a(4)}];await service.tick();tokens=[];await service.tick();
 assert.equal(service.getToken(a(2)).phase,'graduated');assert.equal(service.getToken(a(2)).pair,a(4));
 await service.removeWallet({address:a(1)});await service.tick();state=await service.snapshot();assert.equal(calls,5);assert.equal(state.events.length,0);assert.equal(state.status.state,'idle');
});

test('removing a wallet during a poll discards late events instead of reviving tracking',async()=>{
 let resolve,entered;const started=new Promise(r=>entered=r);const service=create({poll:async()=>{entered();return new Promise(r=>resolve=r);}});
 await service.saveWallet({address:a(1)});const polling=service.tick();await started;await service.removeWallet({address:a(1)});
 resolve({events:[event()],cursor:100,status:{state:'live'}});await polling;const state=await service.snapshot();
 assert.equal(state.wallets.length,0);assert.equal(state.events.length,0);assert.equal(state.status.state,'idle');
});

test('source failure preserves cursor and previous signals and exposes delayed data',async()=>{
 let fail=false;const cursors=[];const service=create({poll:async input=>{cursors.push(input.cursor);if(fail)throw Error('RPC unavailable');return{events:[event()],cursor:100,status:{state:'live',coveredFromBlock:80}};}});
 await service.saveWallet({address:a(1)});await service.tick();fail=true;await service.tick();await service.tick();const state=await service.snapshot();
 assert.deepEqual(cursors,[null,100,100]);assert.equal(state.events.length,1);assert.equal(state.status.state,'delayed');assert.match(state.status.message,/RPC unavailable/);
});

test('discovery and graduation replay recent swaps while the committed cursor keeps moving forward',async()=>{
 let tokens=[market];const cursors=[],results=[
  {cursor:1000,replaceFromBlock:873,events:[]},
  {cursor:1116,replaceFromBlock:989,events:[]},
  {cursor:1000,replaceFromBlock:873,events:[event({blockNumber:950,phase:'graduated'})]},
  {cursor:1232,replaceFromBlock:1105,events:[]},
  {cursor:1116,replaceFromBlock:989,events:[]},
  {cursor:1348,replaceFromBlock:1221,events:[]},
 ];const service=create({snapshot:()=>({tokens}),poll:async input=>{cursors.push(input.cursor);const result=results.shift();return{...result,status:{state:'syncing',lastBlock:result.cursor,coveredFromBlock:result.replaceFromBlock,lagBlocks:200}};}});
 await service.saveWallet({address:a(1)});await service.tick();
 tokens=[{...market,phase:'graduated',tokenAddress:a(8)}];await service.tick();
 assert.equal((await service.snapshot()).events[0].blockNumber,950);assert.equal((await service.snapshot()).status.lastBlock,1116);
 tokens=[{...market,phase:'graduated'},{...market,address:a(3)}];await service.tick();
 await service.tick();
 assert.deepEqual(cursors,[null,1000,884,1116,1000,1232]);assert.equal((await service.snapshot()).status.lastBlock,1348);
 assert.equal((await service.snapshot()).status.coveredFromBlock,873);
});

test('adding another watched wallet preserves a backlog cursor and only replays a bounded recent range',async()=>{
 const cursors=[],results=[1000,1116,1000,1232];const service=create({poll:async input=>{cursors.push(input.cursor);const cursor=results.shift();return{events:input.cursor===884?[event({walletAddress:a(3),blockNumber:950})]:[],cursor,status:{state:'syncing',lastBlock:cursor,lagBlocks:1000}};}});
 await service.saveWallet({address:a(1)});await service.tick();await service.saveWallet({address:a(3)});await service.tick();
 assert.equal((await service.snapshot()).events[0].walletAddress,a(3));await service.tick();
 assert.deepEqual(cursors,[null,1000,884,1116]);assert.equal((await service.snapshot()).status.lastBlock,1232);
});

test('a new market every tick cannot consume forward progress while the confirmed tip grows',async()=>{
 let tokens=[market],tip=1000;const cursors=[],progress=[];
 const service=create({snapshot:()=>({tokens}),poll:async input=>{
  cursors.push(input.cursor);const from=input.cursor===null?tip-127:Math.max(0,input.cursor-11),cursor=Math.min(tip,from+127);
  return{events:[],cursor,replaceFromBlock:from,status:{state:cursor<tip?'syncing':'live',lastBlock:cursor,coveredFromBlock:from,lagBlocks:tip-cursor}};
 }});
 await service.saveWallet({address:a(1)});await service.tick();progress.push((await service.snapshot()).status.lastBlock);
 for(const n of [3,4,5]){tokens=[...tokens,{...market,address:a(n)}];tip+=200;await service.tick();progress.push((await service.snapshot()).status.lastBlock);}
 assert.deepEqual(progress,[1000,1116,1232,1348]);
 assert.deepEqual(cursors,[null,1000,884,1116,1000,1232,1116]);
});

test('failed replay atomically retains forward cursor and signals, then retries after restoring local state',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-replay-'));t.after(()=>rm(dir,{recursive:true,force:true}));const storagePath=join(dir,'tracking.json');
 let calls=0;const service=create({storagePath,poll:async()=>{
  calls++;if(calls===3)throw Error('replay RPC unavailable');
  return{events:calls===2?[event({blockNumber:1100})]:[],cursor:calls===1?1000:1116,status:{state:'syncing',lastBlock:calls===1?1000:1116}};
 }});
 await service.saveWallet({address:a(1)});await service.tick();await service.saveWallet({address:a(3)});await service.tick();
 let state=await service.snapshot();assert.equal(state.events.length,0);assert.equal(state.status.state,'delayed');assert.match(state.status.message,/replay RPC unavailable/);
 assert.equal(JSON.parse(await readFile(storagePath,'utf8')).cursor,1000);
 const cursors=[],results=[1116,1000,1232];const restored=create({storagePath,poll:async input=>{cursors.push(input.cursor);const cursor=results.shift();return{events:[],cursor,status:{state:'syncing',lastBlock:cursor}};}});
 await restored.tick();await restored.tick();assert.deepEqual(cursors,[1000,884,1116]);assert.equal((await restored.snapshot()).status.lastBlock,1232);
});

test('a configuration change during replay discards both the forward result and the old replay',async()=>{
 let tokens=[market],calls=0,resolveReplay,entered;const started=new Promise(resolve=>entered=resolve);
 const cursors=[];const service=create({snapshot:()=>({tokens}),poll:async input=>{
  cursors.push(input.cursor);calls++;
  if(calls===3){entered();return new Promise(resolve=>resolveReplay=resolve);}
  return{events:calls===2?[event({blockNumber:1100})]:[],cursor:calls===1?1000:1116,status:{state:'syncing',lastBlock:calls===1?1000:1116}};
 }});
 await service.saveWallet({address:a(1)});await service.tick();tokens=[...tokens,{...market,address:a(3)}];
 const pending=service.tick();await new Promise(setImmediate);assert.equal(calls,3,'forward polling is followed by a separate replay');await started;await service.saveWallet({address:a(4)});
 resolveReplay({events:[event({blockNumber:950})],cursor:1000,status:{state:'live'}});await pending;
 assert.equal((await service.snapshot()).events.length,0);assert.equal((await service.snapshot()).wallets.length,2);
 // The next forward request must still use 1000, never either in-flight result.
 await service.tick();assert.equal(cursors[3],1000);
});

test('corrupt local storage is reported and never overwritten with an empty watchlist',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-corrupt-'));t.after(()=>rm(dir,{recursive:true,force:true}));const storagePath=join(dir,'tracking.json');await writeFile(storagePath,'{broken');
 const service=create({storagePath});await service.ready;assert.equal((await service.snapshot()).status.state,'error');await assert.rejects(service.saveWallet({address:a(1)}),/存储/);assert.equal(await readFile(storagePath,'utf8'),'{broken');
});
