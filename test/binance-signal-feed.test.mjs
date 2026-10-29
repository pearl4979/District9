import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {existsSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {spawn as nativeSpawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const module = await import('../src/binance-signal-feed.mjs').catch(e => e.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(e));
const A='0x'+'a'.repeat(40), B='0x'+'b'.repeat(40), C='0x'+'c'.repeat(40), W='0x'+'d'.repeat(40), TX='0x'+'e'.repeat(64);
const NOW=1793152294000;
const row={address:A,tokenAddress:A,verified:true,platformId:'flap',phase:'bonding',symbol:'TEST',name:'Test'};
// Exact wallet-stream field names/types observed from CLI 1.11.0, with public identities replaced.
const trade=(extra={})=>({stream:'w3w@tracker@wallet@BSC',data:{chainId:'56',txHash:TX,logId:'127',address:W,label:null,toAddress:null,toAddressLabel:null,ts:1793152293,tradeSideCategory:19,txUsdValue:'72.0751856766768191128096579219167936',nativePrice:'744.6080454729346',tokenSupply:'989999794.41286434050485813',tokenPrice:'0.0446009812355673385599069665358396',currentPrice:null,txNativeTokenQty:'1616.000000000000000000',ca:A,tokenName:'TEST',tokenDecimals:18,marketCap:'44154962.2538',launchTime:1759431276750,groupList:null,...extra}});
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function setup(t,options={}) {
 assert.equal(typeof module.createBinanceSignalFeed,'function','public Binance feed factory must exist');
 const calls=[],children=[],scheduled=new Map();let timerId=0,clock=NOW,markets=[row];
 const spawn=(binary,args,opts)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];child.kill=signal=>{child.kills.push(signal);queueMicrotask(()=>child.emit('close',null,signal));return true;};calls.push({binary,args,opts});children.push(child);return child;};
 const feed=module.createBinanceSignalFeed({snapshot:()=>({tokens:markets}),spawn,now:()=>clock,env:{PATH:process.env.PATH,HOME:'/private-wallet-home',BINANCE_BAW_DIR:'/private-state',NODE_OPTIONS:'--require /credential-leak',WALLET_API_URL:'https://unsafe.invalid',AGENT_SESSION_ID:'private-session',ENABLE_LIVE_TRADING:'true'},setTimeout:(fn,ms)=>{const id=++timerId;scheduled.set(id,{fn,ms});return id;},clearTimeout:id=>scheduled.delete(id),...options});
 t.after(()=>feed.stop());
 return {feed,calls,children,scheduled,setMarkets:v=>markets=v,setClock:v=>clock=v,send:p=>children.at(-1).stdout.write(JSON.stringify(p)+'\n'),fire:async()=>{const [id,job]=scheduled.entries().next().value;scheduled.delete(id);job.fn();await flush();}};
}

test('one public CLI child starts without wallet/session environment or existing state',async t=>{
 const h=setup(t);await h.feed.start();await h.feed.start();assert.equal(h.calls.length,1);
 const c=h.calls[0];assert.deepEqual(c.args.slice(-7),['tracker','ws','--wallet','BSC','--duration','0','--json']);assert.equal(c.opts.shell,false);assert.equal(c.opts.stdio[0],'ignore');
 assert.notEqual(c.opts.env.HOME,'/private-wallet-home');assert.notEqual(c.opts.env.BINANCE_BAW_DIR,'/private-state');assert.deepEqual(readdirSync(c.opts.env.HOME),[]);assert.deepEqual(readdirSync(c.opts.env.BINANCE_BAW_DIR),[]);
 assert.deepEqual(Object.keys(c.opts.env).sort(),['BINANCE_BAW_DIR','HOME','LANG','PATH']);assert.equal(c.opts.cwd,c.opts.env.HOME);
 await h.feed.stop();assert.equal(existsSync(c.opts.env.HOME),false);assert.equal(existsSync(c.opts.env.BINANCE_BAW_DIR),false);assert.equal((await h.feed.snapshot()).status.state,'stopped');
});
test('actual envelope normalizes identities and seconds without manufacturing historical quantities',async t=>{
 const h=setup(t);await h.feed.start();h.send(trade({address:W.toUpperCase().replace('0X','0x'),ca:A.toUpperCase().replace('0X','0x')}));await flush();
 const view=await h.feed.snapshot();assert.equal(view.status.state,'observing');assert.equal(view.events.length,1);const e=view.events[0];
 assert.equal(e.walletAddress,W);assert.equal(e.tokenAddress,A);assert.equal(e.assetAddress,A);assert.equal(e.txHash,TX);assert.equal(e.side,'buy');assert.equal(e.timestamp,'2026-10-28T01:51:33.000Z');assert.equal(e.evidence,'binance-indexed');assert.equal(e.confirmed,false);assert.equal(e.indexerLogId,'127');
 assert.equal(e.tokenAmount,null);assert.equal(e.quoteAmount,null);assert.equal(e.price,null);assert.equal(e.priceUnit,null);
 assert.deepEqual(e.indexerFields,{ts:1793152293,tradeSideCategory:19,txUsdValue:'72.0751856766768191128096579219167936',tokenPrice:'0.0446009812355673385599069665358396',txNativeTokenQty:'1616.000000000000000000',nativePrice:'744.6080454729346'});
 for(const k of ['logIndex','blockNumber','transactionIndex','marketCap','currentPrice','label','groupList','valuation'])assert.equal(Object.hasOwn(e,k),false,k);
});
test('partial NDJSON and UTF8 boundaries retain the complete event',async t=>{
 const h=setup(t);await h.feed.start();const bytes=Buffer.from(JSON.stringify(trade({tokenName:'火蚁'}))+'\n');const cut=bytes.indexOf(Buffer.from('火'))+1;h.children[0].stdout.write(bytes.subarray(0,cut));await flush();assert.equal((await h.feed.snapshot()).events.length,0);h.children[0].stdout.write(bytes.subarray(cut));await flush();assert.equal((await h.feed.snapshot()).events.length,1);
});
test('deduplicates matching observations and merges missing historical fields',async t=>{
 const h=setup(t);await h.feed.start();h.send(trade({txUsdValue:null}));h.send(trade());h.send(trade());await flush();const events=(await h.feed.snapshot()).events;assert.equal(events.length,1);assert.equal(events[0].indexerFields.txUsdValue,'72.0751856766768191128096579219167936');h.send(trade({txUsdValue:null,tokenPrice:null}));await flush();assert.equal((await h.feed.snapshot()).events[0].indexerFields.tokenPrice,'0.0446009812355673385599069665358396');
});
test('rejects wrong chain/stream, malformed identity, unknown side and missing/future timestamps',async t=>{
 const h=setup(t);await h.feed.start();for(const overrides of [{chainId:'1'},{chainId:null},{address:'0x123'},{address:'0x'+'0'.repeat(40)},{ca:'0x123'},{txHash:'0x123'},{tradeSideCategory:99},{ts:null},{ts:1793152394},{ts:1793152293000},{logId:{bad:true}}])h.send(trade(overrides));h.send({...trade(),stream:'w3w@signal_smart_money'});h.send(trade({chainId:56,logId:null,tradeSideCategory:29}));await flush();const events=(await h.feed.snapshot()).events;assert.equal(events.length,1);assert.equal(events[0].side,'sell');assert.equal(events[0].indexerLogId,null);
});
test('filters unverified and ambiguous markets and resolves a unique Flap asset to its market',async t=>{
 const h=setup(t);await h.feed.start();h.setMarkets([{...row,verified:false}]);h.send(trade());await flush();assert.equal((await h.feed.snapshot()).events.length,0);h.setMarkets([{...row,address:B,tokenAddress:A},{...row,address:C,tokenAddress:A}]);h.send(trade());await flush();assert.equal((await h.feed.snapshot()).events.length,0);h.setMarkets([{...row,address:B,tokenAddress:A}]);h.send(trade());await flush();const event=(await h.feed.snapshot()).events[0];assert.equal(event.tokenAddress,B);assert.equal(event.assetAddress,A);h.setMarkets([]);assert.equal((await h.feed.snapshot()).events.length,0);
});
test('filters explicitly foreign-chain or unknown platform verified rows',async t=>{
 const h=setup(t);await h.feed.start();h.setMarkets([{...row,chainId:'1'},{...row,platformId:'unknown'}]);h.send(trade());await flush();assert.equal((await h.feed.snapshot()).events.length,0);
});
test('never substitutes current price, current market cap, or malformed numeric strings',async t=>{
 const h=setup(t);await h.feed.start();h.send(trade({txUsdValue:'NaN',tokenPrice:'-1',txNativeTokenQty:123,nativePrice:'1e999',currentPrice:'20',marketCap:'999'}));await flush();assert.deepEqual((await h.feed.snapshot()).events[0].indexerFields,{ts:1793152293,tradeSideCategory:19});
});
test('keeps only bounded latest observations and expires cache by receive time',async t=>{
 const h=setup(t,{maxEvents:2,retentionMs:1000});await h.feed.start();for(const logId of ['1','2','3'])h.send(trade({logId}));await flush();assert.deepEqual((await h.feed.snapshot()).events.map(e=>e.indexerLogId),['3','2']);h.setClock(NOW+1001);assert.equal((await h.feed.snapshot()).events.length,0);
});
test('subscribers get detached snapshots, unsubscribe, tolerate exceptions, and have a limit',async t=>{
 const h=setup(t,{maxSubscribers:2});const seen=[];const un=h.feed.subscribe(v=>{seen.push(v);if(v.events[0])v.events[0].walletAddress='mutated';});h.feed.subscribe(()=>{throw Error('listener broke');});assert.throws(()=>h.feed.subscribe(()=>{}),/subscriber/i);await h.feed.start();h.send(trade());await flush();assert.equal((await h.feed.snapshot()).events[0].walletAddress,W);const count=seen.length;un();h.send(trade({logId:'128'}));await flush();assert.equal(seen.length,count);
});
test('unexpected process close schedules bounded restart without duplicating an error+close',async t=>{
 const h=setup(t,{restartDelayMs:10,maxRestartDelayMs:20,maxRestarts:2});await h.feed.start();h.children[0].emit('error',Error('secret session:never expose'));h.children[0].emit('close',1,null);assert.equal(h.scheduled.size,1);assert.equal((await h.feed.snapshot()).status.state,'reconnecting');assert.equal(JSON.stringify(await h.feed.snapshot()).includes('never expose'),false);await h.fire();assert.equal(h.calls.length,2);h.children[1].emit('close',1,null);await h.fire();assert.equal(h.calls.length,3);h.children[2].emit('close',1,null);assert.equal(h.scheduled.size,0);assert.equal((await h.feed.snapshot()).status.state,'unavailable');
});
test('stop cancels pending retry, clears subscriptions and suppresses stale transport callbacks',async t=>{
 const h=setup(t);let count=0;h.feed.subscribe(()=>count++);await h.feed.start();h.children[0].emit('close',1,null);await h.feed.stop();assert.equal(h.scheduled.size,0);const stoppedCount=count;h.children[0].stdout.emit('data',Buffer.from(JSON.stringify(trade())+'\n'));await flush();assert.equal(h.calls.length,1);assert.equal(count,stoppedCount);assert.equal((await h.feed.snapshot()).events.length,0);
});
test('oversized unterminated frame kills process instead of growing its buffer',async t=>{
 const h=setup(t,{maxLineBytes:1024});await h.feed.start();h.children[0].stdout.write('x'.repeat(1025));await flush();assert.ok(h.children[0].kills.length);assert.equal((await h.feed.snapshot()).events.length,0);assert.equal(h.scheduled.size,1);
});
test('malformed NDJSON does not corrupt subsequent valid frames or leak its raw text',async t=>{
 const h=setup(t);await h.feed.start();h.children[0].stdout.write('private-note definitely not json\n');h.send(trade());await flush();assert.equal((await h.feed.snapshot()).events.length,1);assert.equal(JSON.stringify(await h.feed.snapshot()).includes('private-note'),false);
});
test('bounds pending normalization while asynchronous verified market snapshot is stalled',async t=>{
 let resolve;const waiting=new Promise(r=>resolve=r);const h=setup(t,{maxPendingMessages:2,snapshot:()=>waiting});await h.feed.start();for(let i=0;i<20;i++)h.send(trade({logId:String(i)}));await flush();resolve({tokens:[row]});await flush();const v=await h.feed.snapshot();assert.ok(v.events.length<=2);assert.ok(v.status.droppedMessages>=18);
});
test('stop invalidates a market read already in flight',async t=>{
 let resolve;const waiting=new Promise(r=>resolve=r);const h=setup(t,{snapshot:()=>waiting});await h.feed.start();h.send(trade());await flush();await h.feed.stop();resolve({tokens:[row]});await flush();assert.equal((await h.feed.snapshot()).events.length,0);
});
test('market snapshot failure fails closed and does not expose provider error text',async t=>{
 let bad=false;const h=setup(t,{snapshot:()=>{if(bad)throw Error('tenant-secret');return{tokens:[row]};}});await h.feed.start();h.send(trade());await flush();assert.equal((await h.feed.snapshot()).events.length,1);bad=true;assert.equal((await h.feed.snapshot()).events.length,0);assert.equal(JSON.stringify(await h.feed.snapshot()).includes('tenant-secret'),false);
});
test('rejects unsafe resource limits before creating any transport',t=>{
 assert.equal(typeof module.createBinanceSignalFeed,'function');for(const value of [0,-1,Infinity,1.5,'10'])assert.throws(()=>module.createBinanceSignalFeed({maxEvents:value}),/limit/i);
});
test('restart after stop is not blocked by a market read left pending in the previous run',async t=>{
 let resolve;let reads=0;const waiting=new Promise(r=>resolve=r);const h=setup(t,{snapshot:()=>++reads===1?waiting:{tokens:[row]}});await h.feed.start();h.send(trade());await flush();await h.feed.stop();await h.feed.start();h.send(trade({logId:'128'}));await flush();assert.equal((await h.feed.snapshot()).events.length,1);resolve({tokens:[row]});await flush();assert.equal((await h.feed.snapshot()).events[0].indexerLogId,'128');
});
test('new subscriber cannot receive an observation for a market removed since the last push',async t=>{
 const h=setup(t);await h.feed.start();h.send(trade());await flush();h.setMarkets([]);const snapshots=[];h.feed.subscribe(v=>snapshots.push(v));await flush();assert.ok(snapshots.length>0);assert.ok(snapshots.every(v=>v.events.length===0));
});

test('bounded probe handles parent cancellation and removes only its own temporary state',async t=>{
 const temp=mkdtempSync(join(tmpdir(),'district9-probe-cancel-test-'));const script=fileURLToPath(new URL('../scripts/probe-binance-signals.mjs',import.meta.url));
 const child=nativeSpawn(process.execPath,[script,'--duration','1'],{detached:true,env:{TMPDIR:temp,PATH:dirname(process.execPath)+':/usr/bin:/bin'},stdio:['ignore','pipe','pipe','ipc']});let stdout='';child.stdout.on('data',b=>stdout+=b);child.stderr.resume();
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}rmSync(temp,{recursive:true,force:true});});
 const deadline=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},8000);
 t.after(()=>clearTimeout(deadline));
 const result=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
 await new Promise((resolve,reject)=>{child.on('message',message=>{if(message?.type==='binance-public-probe-ready')resolve();});child.once('error',reject);child.once('close',()=>reject(Error('Probe exited before readiness acknowledgement')));});
 child.kill('SIGTERM');const closed=await result;clearTimeout(deadline);assert.equal(closed.code,0);const evidence=JSON.parse(stdout);assert.equal(evidence.stopReason,'parent-signal');assert.equal(evidence.cleanedUp,true);assert.deepEqual(readdirSync(temp),[]);
});
