import test from'node:test';import assert from'node:assert/strict';import{createTokenInsights}from'../src/token-insights.mjs';
const A='0x1111111111111111111111111111111111111111',D='0x2222222222222222222222222222222222222222',Q='0x3333333333333333333333333333333333333333';
const token={address:A,verified:true,platformId:'flap',phase:'bonding',creator:D,quoteAsset:Q,quoteSymbol:'QQQB',quoteDecimals:18,buyTaxBps:'0',sellTaxBps:'100',taxAllocation:[{label:'项目收益',bps:10000}],taxBeneficiary:D};
const opts={snapshot:()=>({tokens:[token,{...token,address:'0x4444444444444444444444444444444444444444',name:'Earlier'}]}),resolveName:async address=>({address,name:'alice.ai',verified:true,nameSource:'chain'}),read:async()=>{throw Error('offline');},getJson:async()=>({items:[]}),poolInspector:{inspect:async()=>[]}};
test('only verified markets can request insights; unrelated addresses never issue remote reads',async()=>{
 let calls=0;const s=createTokenInsights({...opts,getJson:async()=>{calls++;return {items:[]};}});await assert.rejects(()=>s.get(Q));assert.equal(calls,0);
});
test('zero Flap project tax stays zero, creator/beneficiary roles differ and history scope stays explicit',async()=>{
 const s=createTokenInsights(opts);const x=await s.get(A);assert.equal(x.fees.tokenBuyBps,0);assert.equal(x.fees.tokenSellBps,100);assert.match(x.fees.tokenTaxScope,/发射/);assert.equal(x.dev.name,'alice.ai');assert.equal(x.tax.allocations[0].bps,10000);assert.equal(x.tax.recipients[0].type,'unknown');assert.equal(x.history.items.length,2);assert.equal(x.history.complete,false);assert.equal(x.firstBuyer.address,null);
});
test('an unlaunched Flap market never uses predicted CA for external pool discovery',async()=>{
 let calls=0;const s=createTokenInsights({...opts,snapshot:()=>({tokens:[{...token,quoteSymbol:'BNB',quoteAsset:'0x0000000000000000000000000000000000000000',predictedToken:Q}]}),poolInspector:{inspect:async()=>{calls++;return [];}}});await s.get(A);assert.equal(calls,0);
});


test('Gang indexed buyer pages filter sell rows and sort client-side; identity cannot prove full first-buy history',async()=>{
 const t={...token,platformId:'gang',manager:'0x4444444444444444444444444444444444444444',pad:'v2',taxed:false,creationTransaction:null};let pages=0;
 const s=createTokenInsights({...opts,snapshot:()=>({tokens:[t]}),getJson:async url=>{
  if(!url.includes('/trades?'))return {address:A,creator:D};pages++;
  return url.includes('offset=200')?{items:[{side:'buy',trader:D,tx:'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ts:5,block:1}],hasMore:false}:{items:[{side:'sell',trader:Q,tx:'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ts:1},{side:'buy',trader:Q,tx:'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ts:9}],hasMore:true,nextOffset:200};
 }});
 const x=await s.get(A);assert.equal(pages,2);assert.equal(x.firstBuyer.address,D);assert.equal(x.firstBuyer.name,'alice.ai');assert.equal(x.firstBuyer.verified,false);assert.match(x.firstBuyer.coverage,/全历史未独立/);
});

test('Four tax quote mismatch preserves unknown allocation; never labels an arbitrary founder as private profit',async()=>{
 const t={...token,platformId:'four'};const s=createTokenInsights({...opts,snapshot:()=>({tokens:[t]}),provider:{getBlockNumber:async()=>100},read:async(a,b,m)=>m==='quote'?D:m==='founder'?D:25n});
 const x=await s.get(A);assert.deepEqual(x.tax.allocations,[]);assert.deepEqual(x.tax.recipients,[]);assert.match(x.warnings.join(),/税务/);
});

test('Gang separates platform fee bucket allocation from post-graduation holder tax',async()=>{
 const B='0x5555555555555555555555555555555555555555',H='0x6666666666666666666666666666666666666666';
 const t={...token,platformId:'gang',manager:'0x4444444444444444444444444444444444444444',pad:'v2',taxed:true,tokenTaxBuyBps:'100',tokenTaxSellBps:'100'};
 const s=createTokenInsights({...opts,snapshot:()=>({tokens:[t]}),provider:{getBlockNumber:async()=>100,getCode:async()=> '0x1234'},read:async(a,b,m)=>({platformBucket:B,dividendVault:Q,taxHandler:H,feeVault:D,burner:D,BUYBACK_BPS:8000n,DIV_SHARE_BPS:5000n,OUTER_TAX_BPS:100n}[m])});
 const x=await s.get(A);assert.equal(x.fees.platformBuyBps,100);assert.equal(x.fees.tokenBuyBps,100);assert.equal(x.tax.allocations[0].bps,8000);assert.match(x.tax.allocations[0].label,/内盘平台费/);assert.match(x.tax.note,/50%进入分红合约/);assert.match(x.tax.note,/不表示内盘有分红/);assert.equal(x.tax.recipients[0].type,'contract');
});

test('same-second same-block indexed buys stay ambiguous without receipts instead of choosing the latest returned row',async()=>{
 const t={...token,platformId:'gang',manager:'0x4444444444444444444444444444444444444444',pad:'v2'};
 const s=createTokenInsights({...opts,snapshot:()=>({tokens:[t]}),getJson:async url=>url.includes('/trades?')?{items:[{side:'buy',trader:Q,tx:'0x'+'a'.repeat(64),ts:100,block:80},{side:'buy',trader:D,tx:'0x'+'b'.repeat(64),ts:100,block:80}],hasMore:false}:{address:A,creator:D}});
 const x=await s.get(A);assert.equal(x.firstBuyer.address,null);assert.match(x.firstBuyer.note,/顺序/);
});

test('tied Gang index entries are resolved by successful receipt transaction and Buy log order, not response order',async()=>{
 const {Interface}=await import('ethers');const g=new Interface(['event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 taxDividend,uint256 taxPlatform,uint256 tokensOut,uint256 realQuote)']);
 const M='0x4444444444444444444444444444444444444444',TX1='0x'+'a'.repeat(64),TX2='0x'+'b'.repeat(64),t={...token,platformId:'gang',manager:M,pad:'v2'};
 const receipt=(trader,index)=>{const e=g.encodeEventLog(g.getEvent('Buy'),[A,trader,1n,0n,0n,1n,1n]);return{status:1,index,blockNumber:80,logs:[{address:M,index:index+5,...e}]};};
 const s=createTokenInsights({...opts,snapshot:()=>({tokens:[t]}),provider:{getTransactionReceipt:async tx=>tx===TX1?receipt(Q,8):receipt(D,2)},getJson:async url=>url.includes('/trades?')?{items:[{side:'buy',trader:Q,tx:TX1,ts:100,block:80},{side:'buy',trader:D,tx:TX2,ts:100,block:80}],hasMore:false}:{address:A,creator:D}});
 const x=await s.get(A);assert.equal(x.firstBuyer.address,D);assert.match(x.firstBuyer.note,/回执/);assert.equal(x.firstBuyer.verified,false);
});

test('launching phase is pending, never mislabeled as external trading or inspected using a predicted token',async()=>{
 let calls=0;const s=createTokenInsights({...opts,snapshot:()=>({tokens:[{...token,phase:'launching',predictedToken:Q}]}),poolInspector:{inspect:async()=>{calls++;return [];}}});const x=await s.get(A);assert.equal(x.route.kind,'pending');assert.equal(calls,0);assert.equal(x.route.target,null);
});


test('merged Gang dossiers use only verified snapshots and never consume legacy APIs, events, fees or route claims',async()=>{
 for(const [launchType,phase]of [['curve-v3','bonding'],['curve-v3','graduated'],['fair','bonding'],['fair','graduated'],[undefined,'bonding']]){
  const touched=[],trap=name=>async()=>{touched.push(name);throw Error('legacy path must not run');},updatedAt='2026-10-27T16:00:00.000Z';
  const t={...token,pad:'merged',platformId:'gang',launchType,phase,manager:Q,locked:phase==='bonding',pair:phase==='graduated'?Q:null,tokenTaxBuyBps:'100',tokenTaxSellBps:'0',tokenTaxScope:'毕业 / 发射后',protocolBuyFeeBps:'9999',agentFeeBps:'9999',sourceUpdatedAt:updatedAt,sourceBlock:130122898,sourceUnavailable:true};
  const s=createTokenInsights({snapshot:()=>({tokens:[t,{...t,address:Q}]}),provider:{getBlockNumber:trap('block'),getCode:trap('code'),getLogs:trap('logs'),getTransactionReceipt:trap('receipt')},read:trap('read'),getJson:trap('http'),resolveName:trap('name'),poolInspector:{inspect:trap('pools')},now:()=>1793120000000});
  const x=await s.get(A);assert.equal(x.status,'partial');assert.deepEqual(touched,[]);assert.equal(x.launchType,launchType??null);assert.equal(x.sourceBlock,130122898);assert.equal(x.updatedAt,updatedAt);assert.equal(x.sourceUnavailable,true);
  assert.equal(x.fees.tokenBuyBps,100);assert.equal(x.fees.tokenSellBps,0);assert.equal(x.fees.platformBuyBps,null);assert.equal(x.fees.platformSellBps,null);assert.equal(x.fees.agentBps,null);assert.equal(x.fees.tokenTaxScope,'毕业 / 发射后');
  assert.deepEqual(x.tax.allocations,[]);assert.deepEqual(x.tax.recipients,[]);assert.equal(x.tax.status,'unavailable');assert.equal(x.firstBuyer.address,null);assert.equal(x.firstBuyer.status,'unavailable');assert.equal(x.dev.address,D);assert.equal(x.dev.name,null);
  assert.equal(x.route.kind,'readonly');assert.equal(x.route.target,null);assert.deepEqual(x.route.pools,[]);assert.equal(x.history.items.length,2);assert.equal(x.history.complete,false);assert.equal(x.history.totalKnown,null);assert.doesNotMatch(x.history.scope,/官方索引/);
  assert.doesNotMatch(JSON.stringify(x),/Gang V2|LaunchpadV2|当前买卖调用固定/);assert.match(x.warnings.join(),/快照|不可用/);assert.ok(x.sources.every(v=>!v.includes('handleOf')&&!v.includes('Gang 官方索引')));
 }
});

test('a newly typed merged dossier cannot reuse a cached V2 response for the same address, phase and creator',async()=>{
 let current={...token,platformId:'gang',pad:'v2',taxed:false},requests=0;const s=createTokenInsights({...opts,snapshot:()=>({tokens:[current]}),getJson:async()=>{requests++;return{items:[],address:A,creator:D};}});
 const legacy=await s.get(A);assert.match(legacy.fees.note,/Gang V2/);requests=0;current={...current,pad:'merged',launchType:'curve-v3',sourceUpdatedAt:'2026-10-27T16:00:00.000Z',sourceBlock:100};
 const merged=await s.get(A);assert.equal(merged.status,'partial');assert.equal(requests,0);assert.doesNotMatch(merged.fees.note,/Gang V2/);
 current={...current,sourceUnavailable:true};const stale=await s.get(A);assert.equal(stale.sourceUnavailable,true);assert.match(stale.warnings.join(),/不可用|快照/);
});
test('merged dossier distinguishes preview support from read-only snapshots without inventing a verified execution target',async()=>{
 let t={...token,platformId:'gang',pad:'merged',launchType:'fair',tradable:true,sourceUnavailable:false,sourceBlock:100};
 const s=createTokenInsights({...opts,snapshot:()=>({tokens:[t]})});
 const ready=await s.get(A);assert.equal(ready.route.kind,'preview-only');assert.equal(ready.route.target,null);assert.match(ready.route.note,/逐笔预览/);
 t={...t,tradable:false};const closed=await s.get(A);assert.equal(closed.route.kind,'readonly');
});
