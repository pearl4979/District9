import test from 'node:test';import assert from 'node:assert/strict';import{keccak256,parseEther as E}from'ethers';
const mod=await import('../src/gang-merged.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),PAD=addr(90),QUOTE=addr(91),FACTORY=addr(92),TOKEN=addr(1),PAIR=addr(93),CREATOR=addr(94),T=1793118900000;
function harness(){
 const tokens=new Map([[TOKEN,{kind:1,graduated:true,creator:CREATOR,quote:QUOTE,pair:PAIR,realQuote:0n,sold:E('800000000'),gradAmt:E('15'),virtualQuote:E('5'),buyTaxBps:100n,sellTaxBps:100n,dividendBps:10000n}],[addr(2),{kind:2,launched:false,creator:CREATOR,quote:QUOTE,pair:addr(0),sold:200n,capShares:100n,holdBps:6000n,mintFeeBps:100n,exitFeeBps:100n,sharePrice:E('.0005')}]]);
 let broken='',clock=T;const requests=[],reads=[];
 const hints=()=>[...tokens].map(([address,s])=>({address,chainId:56,createdAt:T/1000-10,creator:s.creator,quoteAddress:QUOTE,priceQuote:'99999',fdvUsd:999999,progressPct:90,graduated:s.graduated||s.launched,status:s.launched?'launched':'minting'}));
 const provider={getNetwork:async()=>({chainId:56n}),getBlockNumber:async()=>100,getCode:async address=>address===PAD?'0x6000':'0x6001'};
 const config={pad:PAD,codeHash:keccak256('0x6000'),factory:FACTORY};
 const fetchJson=async url=>{requests.push(new URL(url));if(broken&&url.includes(broken))throw Error('offline');return {items:hints().filter(h=>url.includes('/v3/')?tokens.get(h.address).kind===1:tokens.get(h.address).kind===2&&(url.includes('launched')?tokens.get(h.address).launched:!tokens.get(h.address).launched)),hasMore:false};};
 const read=async(address,_abi,fn,args=[],block)=>{reads.push({address,fn,args,block});const s=tokens.get(args[0]||address);if(address===PAD){if(fn==='exitFeeBpsOf')return s.exitFeeBps;if(fn==='TOTAL_SHARES')return 10000n;if(fn==='TOKENS_PER_SHARE')return E('50000');if(fn==='kindOf')return BigInt(s?.kind||0);if(fn==='curves'||fn==='sales')return s;if(fn==='status')return s.launched?2n:1n;if(fn==='pairFactory')return FACTORY;}
 if(address===FACTORY&&fn==='getPair')return PAIR;if(address===PAIR){return {token0:TOKEN,token1:QUOTE,factory:FACTORY,getReserves:[E('1000000'),E('2'),0n]}[fn];}
 if(address===QUOTE)return {symbol:'WBNB',decimals:18n}[fn];if(tokens.has(address))return{launchpad:PAD,locked:!(s.graduated||s.launched),decimals:18n,totalSupply:E('1000000000'),name:'Token '+address.slice(-1),symbol:'T'+address.slice(-1),pair:s.pair}[fn];throw Error('unexpected '+fn);};
 return{provider,config,fetchJson,read,requests,reads,tokens,clock:()=>clock,advance:ms=>clock+=ms,fail:part=>broken=part};
}

test('preview-enabled merged discovery exposes supported phases and disables retained stale rows',async()=>{
 const h=harness(),s=mod.createGangMergedSource({...h,previewTrading:true});
 const initial=await s.load();assert.ok(initial.tokens.length);assert.ok(initial.tokens.every(t=>t.tradable===true));
 h.fail('/v3/');h.advance(30000);const stale=(await s.load()).tokens.find(t=>t.address===TOKEN);
 assert.equal(stale.sourceUnavailable,true);assert.equal(stale.tradable,false);
});
function source(h){assert.equal(typeof mod.createGangMergedSource,'function','merged discovery must be available');return mod.createGangMergedSource({...h,now:h.clock});}

test('Fair progress exposes verified effective shares, fixed price and principal independently of wallet cap',async()=>{
 const h=harness(),read=h.read;h.read=async(a,b,m,args,block)=>m==='TOTAL_SHARES'?10000n:m==='TOKENS_PER_SHARE'?E('50000'):read(a,b,m,args,block);
 const s=source(h),fair=(await s.load()).tokens.find(t=>t.address===addr(2));
 assert.ok(fair.fairSale,'Fair sale details must be available');assert.equal(fair.fairSale.soldShares,'200');assert.equal(fair.fairSale.totalShares,'10000');assert.equal(fair.fairSale.walletCapShares,'100');assert.equal(fair.fairSale.remainingShares,'9800');assert.equal(fair.fairSale.sharePrice,'0.0005');assert.equal(fair.fairSale.subscribedPrincipal,'0.1');assert.equal(fair.fairSale.targetPrincipal,'5.0');assert.equal(fair.fairSale.tokensPerShare,'50000.0');assert.equal(fair.fairSale.sourceBlock,100);assert.equal(fair.progress,2);
 h.tokens.get(addr(2)).sold=100n;h.advance(30000);const after=(await s.load()).tokens.find(t=>t.address===addr(2));assert.equal(after.fairSale.soldShares,'100');assert.equal(after.progress,1);
});
test('Fair invalid share counts or incompatible allocation constants never produce verified progress',async()=>{
 for(const issue of ['sold','allocation']){
  const h=harness(),read=h.read;h.read=async(a,b,m,args,block)=>m==='TOTAL_SHARES'?10000n:m==='TOKENS_PER_SHARE'?E(issue==='allocation'?'1':'50000'):read(a,b,m,args,block);
  if(issue==='sold')h.tokens.get(addr(2)).sold=10001n;assert.equal((await source(h).load()).tokens.some(t=>t.address===addr(2)),false);
 }
});
test('Fair progress displays the effective exit fee rather than the configured fee for inactive sales',async()=>{
 const h=harness(),read=h.read;h.read=async(a,b,m,args,block)=>m==='exitFeeBpsOf'?0n:read(a,b,m,args,block);
 const t=(await source(h).load()).tokens.find(t=>t.address===addr(2));assert.equal(t.fairSale.exitFeeBps,0);assert.equal(t.fairSale.configuredExitFeeBps,100);
});

test('merged discovery verifies finalized Curve and locked Fair as separate read-only types and ignores API valuation',async()=>{
 const h=harness(),s=source(h),out=await s.load();assert.equal(out.tokens.length,2);const curve=out.tokens.find(t=>t.address===TOKEN),fair=out.tokens.find(t=>t.address===addr(2));
 assert.equal(curve.launchType,'curve-v3');assert.equal(curve.launchTypeLabel,'V3 曲线');assert.equal(curve.phase,'graduated');assert.equal(curve.price,'0.000002');assert.equal(curve.priceSource,'verified-pool');assert.equal(curve.indexedMarketCapUsd,null);assert.equal(curve.sourceBlock,100);
 assert.equal(fair.launchType,'fair');assert.equal(fair.launchTypeLabel,'Fair 打新');assert.equal(fair.phase,'bonding');assert.equal(fair.positionKind,'token');assert.equal(fair.locked,true);assert.equal(fair.price,null);assert.equal(fair.nativeCandleUnitVerified,false);assert.equal(fair.chartSupply,'1000000000');assert.match(fair.reason,/打新|锁定/);
 assert.ok(out.tokens.every(t=>t.tradable===false&&t.verified===true));assert.ok(h.reads.every(r=>r.block===100));assert.equal(out.tracks.length,3);assert.equal(out.status,'live');
});

test('one merged feed outage preserves that feed freshness while other feeds and signals continue',async()=>{
 const h=harness(),s=source(h),first=await s.load();h.advance(30000);h.fail('/v3/');const next=await s.load();
 const old=next.tokens.find(t=>t.address===TOKEN),fresh=next.tokens.find(t=>t.address===addr(2));assert.equal(old.sourceUnavailable,true);assert.equal(old.sourceUpdatedAt,first.tokens.find(t=>t.address===TOKEN).sourceUpdatedAt);assert.equal(fresh.sourceUnavailable,false);assert.notEqual(fresh.sourceUpdatedAt,old.sourceUpdatedAt);assert.equal(next.status,'degraded');assert.match(next.message,/V3.*异常/);
});

test('wrong kind, fake token, wrong launchpad and unregistered pools cannot become verified discovery',async()=>{
 for(const failure of ['kind','code','launchpad','pair']){const h=harness(),original=h.read;if(failure==='code')h.provider.getCode=async address=>address===PAD?'0x6000':'0x';
 h.read=async(a,b,fn,args,block)=>{if(failure==='kind'&&fn==='kindOf')return 0n;if(failure==='launchpad'&&fn==='launchpad')return addr(99);if(failure==='pair'&&fn==='getPair')return addr(99);return original(a,b,fn,args,block);};
 const out=await source(h).load();assert.ok(!out.tokens.some(t=>t.address===TOKEN),failure);}
 const h=harness();h.provider.getCode=async()=> '0x6002';const out=await source(h).load();assert.equal(out.tokens.length,0);assert.equal(out.status,'error');assert.equal(h.requests.length,0);
});

test('candidate reservation protects graduated, progress and recent rows within bounded per-type selection',()=>{
 assert.equal(typeof mod.selectMergedCandidates,'function');
 const recent=Array.from({length:100},(_,i)=>({address:addr(i+1),createdAt:1000-i,chainId:56}));const grad={address:addr(1001),graduated:true,graduatedAt:2,createdAt:1,chainId:56},progress={address:addr(1002),progressPct:99,createdAt:1,chainId:56};
 const rows=mod.selectMergedCandidates([...recent,grad,progress],12);assert.equal(rows.length,12);assert.ok(rows.some(r=>r.address===grad.address));assert.ok(rows.some(r=>r.address===progress.address));assert.ok(rows.some(r=>r.address===recent[0].address));
});

test('merged candidate pagination is bounded and invalid cursor loops become visible feed errors',async()=>{
 const h=harness();h.fetchJson=async url=>{h.requests.push(new URL(url));return{items:[{address:TOKEN,chainId:56,createdAt:1}],hasMore:true,nextOffset:0};};const out=await source(h).load();assert.equal(out.status,'error');assert.ok(h.requests.length<=3);assert.equal(out.tokens.length,0);
});


test('market hub preserves per-track stale evidence and readonly rows never reach quote or execute adapters',async()=>{
 const{createMarketHub,createMarketRouter}=await import('../src/market-hub.mjs');
 const h=harness(),merged=source(h),initial=await merged.load();h.advance(30000);h.fail('/v3/');const degraded=await merged.load();
 const hub=createMarketHub({sources:{gang:{load:async()=>degraded}},now:h.clock});await hub.refresh();const snapshot=hub.snapshot(),old=snapshot.tokens.find(t=>t.address===TOKEN);
 assert.equal(old.sourceUnavailable,true);assert.equal(old.sourceUpdatedAt,initial.tokens.find(t=>t.address===TOKEN).sourceUpdatedAt);assert.equal(snapshot.monitor.sources[0].tracks.length,3);
 let calls=0;const router=createMarketRouter({providers:{gang:{buildTrade(){calls++;},validateExecution(){calls++;}}},snapshot:()=>snapshot});
 await assert.rejects(()=>router.buildTrade({token:addr(2),platformId:'gang'}),/只读/);await assert.rejects(()=>router.validateExecution({}, {token:addr(2),platformId:'gang'}),/只读/);assert.equal(calls,0);hub.stop();
});


test('positive reserves and verified curve values below display precision stay unknown instead of reporting a zero price',async()=>{
 for(const finalized of [true,false]){
  const h=harness(),original=h.read;h.tokens.get(TOKEN).graduated=finalized;h.tokens.get(TOKEN).virtualQuote=1n;
  h.read=async(a,b,fn,args,block)=>fn==='getReserves'?[10n**30n,1n,0n]:original(a,b,fn,args,block);
  const row=(await source(h).load()).tokens.find(t=>t.address===TOKEN);assert.ok(row);assert.equal(row.price,null);assert.equal(row.priceSource,null);assert.equal(row.priceUpdatedAt,null);
 }
});

test('partial candidate read failures retain only that candidate as stale without refreshing its timestamp',async()=>{
 const h=harness(),original=h.read;let failing=false;h.tokens.set(addr(3),{...h.tokens.get(TOKEN),graduated:false,pair:addr(0)});
 h.read=async(a,b,fn,args,block)=>{if(failing&&a===TOKEN&&fn==='symbol')throw Error('temporary read failure');return original(a,b,fn,args,block);};
 const s=source(h),initial=await s.load();failing=true;h.advance(30000);const out=await s.load(),old=out.tokens.find(t=>t.address===TOKEN),fresh=out.tokens.find(t=>t.address===addr(3));
 assert.ok(old);assert.equal(old.sourceUnavailable,true);assert.equal(old.sourceUpdatedAt,initial.tokens.find(t=>t.address===TOKEN).sourceUpdatedAt);assert.equal(fresh.sourceUnavailable,false);assert.notEqual(fresh.sourceUpdatedAt,old.sourceUpdatedAt);assert.equal(out.tracks.find(t=>t.id==='v3').status,'degraded');assert.equal(out.tracks.find(t=>t.id==='v3').count,2);assert.equal(out.tracks.find(t=>t.id==='v3').unavailable,1);
});
