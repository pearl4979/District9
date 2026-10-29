import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Interface,parseUnits,ZeroAddress} from 'ethers';
import {createWalletSignalSource} from '../src/wallet-signal-source.mjs';
import {createNativeEventValuation} from '../src/event-valuation.mjs';

const addr=n=>`0x${n.toString(16).padStart(40,'0')}`, hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const W=addr(1), OTHER=addr(2), T=addr(10), F=addr(11), Q=addr(12), P=addr(13), ROUTER=addr(14);
const cfg=JSON.parse(readFileSync(new URL('../config/platforms.json',import.meta.url)));
const manifest=JSON.parse(readFileSync(new URL('../config/manifest.json',import.meta.url)));
const CORE=new Interface(JSON.parse(readFileSync(new URL('../abi/Core.json',import.meta.url))));
const GANG=new Interface(['event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 taxDividend,uint256 taxPlatform,uint256 tokensOut,uint256 realQuote)','event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 taxDividend,uint256 taxPlatform,uint256 quoteOut,uint256 realQuote)']);
const FLAP=new Interface(['event VirtualTrade(uint256 indexed id,address indexed wallet,uint8 side,uint256 shares,uint256 quoteSubmitted,uint256 quoteUser,uint256 agentFee,uint256 quotePool,uint256 quoteCurve,uint256 refund,uint256 launchReserveRefund,uint256 poolAfter,uint256 expectedFlapReserveAfter,uint256 outstandingSharesAfter,uint256 spotPriceBefore,uint256 spotPriceAfter)']);
const ERC=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const V2=new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const V3=new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);
const READ=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)','function getPair(address,address) view returns(address)','function getPool(address,address,uint24) view returns(address)']);
const V2F='0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',V3F='0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const E=v=>parseUnits(v,18);
const market=(platformId='gang',extra={})=>({address:T,platformId,verified:true,manager:platformId==='gang'?cfg.gang.pads.v2.address:platformId==='four'?manifest.core:cfg.flap.portal,phase:'bonding',symbol:'TOK',name:'Token',decimals:18,quoteAsset:Q,quoteSymbol:'QUO',quoteDecimals:18,...extra});
function log(iface,name,args,{address=T,tx=1,index=0,block=990,transactionIndex=0,removed=false}={}){const e=iface.encodeEventLog(iface.getEvent(name),args);return{...e,address,transactionHash:hash(tx),blockHash:hash(block),blockNumber:block,transactionIndex,index,removed};}
const transfer=(from,to,amount,opts={})=>log(ERC,'Transfer',[from,to,E(amount)],opts);
function fixture({logs=[],receipts={},tip=1000,pool={},failLogs=false,failCall=false}={}){
 const calls=[];
 const provider={
  async getBlockNumber(){calls.push({method:'head'});return tip;},
  async getLogs(filter){calls.push({method:'logs',filter});if(failLogs)throw Error('RPC unavailable');return logs.filter(l=>l.blockNumber>=filter.fromBlock&&l.blockNumber<=filter.toBlock&&(!filter.address||[].concat(filter.address).some(a=>a.toLowerCase()===l.address.toLowerCase()))&&(filter.topics||[]).every((v,i)=>v===null||[].concat(v).some(t=>t.toLowerCase()===l.topics[i]?.toLowerCase())));},
  async getTransactionReceipt(tx){calls.push({method:'receipt',tx});if(Object.hasOwn(receipts,tx))return receipts[tx];const entries=logs.filter(l=>l.transactionHash===tx);return{status:1,from:W,blockNumber:entries[0]?.blockNumber,index:0,hash:tx,logs:entries};},
  async getBlock(number){calls.push({method:'block',number});return{number,timestamp:1793090000+number,hash:hash(number)};},
  async call(req){calls.push({method:'call',req});if(failCall)throw Error('RPC call failed');const parsed=READ.parseTransaction(req);const value=parsed.name==='token0'?(pool.token0||T):parsed.name==='token1'?(pool.token1||Q):parsed.name==='factory'?(pool.factory||V2F):parsed.name==='fee'?500:pool.registered||P;return READ.encodeFunctionResult(parsed.name,[value]);}
 };
 return{provider,calls};
}
const source=f=>createWalletSignalSource({provider:f.provider,now:()=>1793100000000});
const poll=(s,markets=[market()],extra={})=>s.poll({wallets:[{address:W}],cursor:null,markets,...extra});

test('no watched wallets performs no RPC',async()=>{const f=fixture();const r=await source(f).poll({wallets:[],cursor:null,markets:[market()]});assert.equal(r.status.state,'idle');assert.deepEqual(f.calls,[]);});

test('Four native buy/sell requires its successful receipt and preserves actual event amounts',async()=>{
 const trade=(buy,tx)=>log(CORE,'TradeExecuted',[T,W,1,buy,Q,OTHER,E('10'),E('10'),E('2'),E(buy?'2.1':'1.9'),1,0,0,0,0,0,0,0],{address:manifest.core,tx,index:tx});
 const logs=[trade(true,1),trade(false,2),trade(true,3),transfer(OTHER,W,'10',{tx:1,index:4})];
 const f=fixture({logs,receipts:{[hash(3)]:{status:0,logs:[logs[2]],blockNumber:990}}});
 const r=await poll(source(f),[market('four')]);assert.deepEqual(r.events.map(e=>[e.side,e.tokenAmount,e.quoteAmount]),[['buy','10.0','2.1'],['sell','10.0','1.9']]);assert.ok(r.events.every(e=>e.confirmed&&!e.demo&&e.platformId==='four'));assert.equal(r.events[0].timestamp,'2026-10-27T08:49:50.000Z');
});

test('Four native valuation uses the event post-price and exact maximum supply, never latest market data',async()=>{
 const l=log(CORE,'TradeExecuted',[T,W,1,true,Q,OTHER,E('10'),E('10'),E('2'),E('2.1'),1n,0,0,0,0,0,0,0],{address:manifest.core,index:1});
 const r=await poll(source(fixture({logs:[l]})),[market('four',{chartSupply:'9007199254740993',price:'999999999',marketCap:{value:999999999,unit:'USD'},valuationQuoteUsd:999})]);
 const e=r.events[0];assert.ok(e.valuation,'verified event price can produce a historical snapshot');
 assert.deepEqual(e.valuation,{kind:'event-snapshot',value:'0.009007199254740993',unit:'QUO',basis:'FDV',source:'Four TradeExecuted.lastPrice × 已核验最大供应量；事件成交后 FDV（非流通市值）',blockNumber:990,timestamp:'2026-10-27T08:49:50.000Z'});
});

test('Flap event post-price respects quote decimals and labels shares as equivalent FDV',async()=>{
 const l=log(FLAP,'VirtualTrade',[1,W,0,E('25'),parseUnits('3',6),parseUnits('2.5',6),1,1,1,1,0,1,1,1,1,1234567],{address:F,index:1});
 const r=await poll(source(fixture({logs:[l]})),[market('flap',{address:F,chartSupply:'1000000000',quoteDecimals:6,price:'888888'})]);
 assert.ok(r.events[0].valuation);assert.equal(r.events[0].valuation.value,'1234567000');assert.equal(r.events[0].valuation.basis,'share-equivalent-FDV');assert.equal(r.events[0].valuation.unit,'QUO');assert.match(r.events[0].valuation.source,/spotPriceAfter/);
});

test('Gang event mean-price valuation retains rational precision and states buy fee/sell payout semantics',async()=>{
 const logs=[log(GANG,'Buy',[T,W,E('1.98'),0,E('0.02'),E('3'),1],{address:cfg.gang.pads.v2.address,index:1}),log(GANG,'Sell',[T,W,E('3'),0,0,E('1.9'),1],{address:cfg.gang.pads.v2.address,index:2,tx:2})];
 const r=await poll(source(fixture({logs})),[market('gang',{chartSupply:'1000000000',price:'777777'})]);
 assert.ok(r.events.every(e=>e.valuation));
 assert.equal(r.events[0].valuation.value,'666666666.666666666666666666666666666666666666');assert.equal(r.events[1].valuation.value,'633333333.333333333333333333333333333333333333');
 assert.ok(r.events.every(e=>e.valuation.basis==='execution-FDV'));assert.match(r.events[0].valuation.source,/含费用/);assert.match(r.events[1].valuation.source,/到账/);
});

test('native valuation missing metadata or a zero event price remains unknown without using latest prices',async()=>{
 for(const extra of [{chartSupply:null},{chartSupply:'-1'},{chartSupply:'1e9'},{chartSupply:'0'},{quoteDecimals:null},{quoteSymbol:null}]){
  const l=log(CORE,'TradeExecuted',[T,W,1,true,Q,OTHER,E('10'),E('10'),E('2'),E('2.1'),E('2'),0,0,0,0,0,0,0],{address:manifest.core,index:1});
  const r=await poll(source(fixture({logs:[l]})),[market('four',{chartSupply:'1000000000',price:'99999',...extra})]);
  assert.equal(r.events[0].valuation,null,JSON.stringify(extra));
 }
 const l=log(CORE,'TradeExecuted',[T,W,1,true,Q,OTHER,E('10'),E('10'),E('2'),E('2.1'),0,0,0,0,0,0,0,0],{address:manifest.core,index:1});
 assert.equal((await poll(source(fixture({logs:[l]})),[market('four',{chartSupply:'1000000000',price:'99999'})])).events[0].valuation,null);
});

test('DEX legs and ordinary transfers never infer historical valuations from chart supply or latest market cap',async()=>{
 const logs=[transfer(OTHER,W,'7',{index:1}),transfer(P,W,'5',{index:2}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:3})];
 const r=await poll(source(fixture({logs})),[market('gang',{phase:'graduated',chartSupply:'1000000000',marketCap:{value:999999,unit:'USD'}})]);
 assert.equal(r.events.length,2);assert.ok(r.events.every(e=>e.valuation===null));
});

test('the valuation boundary rejects wrong market identity and absent or malformed native evidence',()=>{
 const event={tokenAddress:T,platformId:'four',phase:'bonding',side:'buy',confirmed:true,demo:false,quoteSymbol:'QUO',source:'BSC four 原生TradeExecuted成功回执',blockNumber:990,timestamp:'2026-10-27T08:49:50.000Z'};
 const input={market:market('four',{chartSupply:'1000'}),event,postPriceRaw:E('2'),tokenRaw:E('10'),quoteRaw:E('20'),tokenDecimals:18,quoteDecimals:18};
 assert.equal(createNativeEventValuation(input)?.value,'2000');
 for(const extra of [{market:{...input.market,address:OTHER}},{market:{...input.market,platformId:'gang'}},{market:{...input.market,verified:false}},{tokenRaw:null},{tokenRaw:0n},{quoteRaw:null},{quoteRaw:-1n},{postPriceRaw:'2'},{tokenDecimals:37},{quoteDecimals:-1}])assert.equal(createNativeEventValuation({...input,...extra}),null);
 const fractional=createNativeEventValuation({...input,market:{...input.market,chartSupply:'1000.000000000000000001'},postPriceRaw:1000001n,quoteDecimals:6});
 assert.equal(fractional?.value,'1000.001000000000000001000001','fixed-point multiplication preserves all represented significant digits');
});

test('Gang V2 and legacy U/S native events report buy gross including protocol fees and sell payout',async()=>{
 const logs=[log(GANG,'Buy',[T,W,E('1.98'),0,E('0.02'),E('100'),1],{address:cfg.gang.pads.v2.address,index:1}),log(GANG,'Sell',[T,W,E('50'),0,E('0.01'),E('0.99'),1],{address:cfg.gang.pads.u.address,tx:2,index:2})];
 const f=fixture({logs});const r=await poll(source(f),[market(),market('gang',{address:T,manager:cfg.gang.pads.u.address})]);assert.deepEqual(r.events.map(e=>[e.side,e.tokenAmount,e.quoteAmount]),[['buy','100.0','2.0'],['sell','50.0','0.99']]);
});

test('Flap shares are found by indexed native wallet event without ERC20 transfers and keep market canonical',async()=>{
 const trade=(side,tx)=>log(FLAP,'VirtualTrade',[1,W,side,E('25'),E('3'),E(side===0?'2.5':'2.4'),1,1,1,1,0,1,1,1,1,1],{address:F,tx,index:tx});
 const f=fixture({logs:[trade(0,1),trade(1,2)]});const r=await poll(source(f),[market('flap',{address:F,tokenAddress:T,phase:'graduated',quoteAsset:ZeroAddress,quoteSymbol:'BNB'})]);assert.deepEqual(r.events.map(e=>[e.side,e.tokenAddress,e.assetAddress,e.tokenAmount,e.quoteAmount]),[['buy',F,F,'25.0','2.5'],['sell',F,F,'25.0','2.4']]);assert.equal(r.events[0].priceUnit,'BNB/份额');
});

test('native event actor may be a contract wallet; tx sender need not be watched',async()=>{const l=log(GANG,'Buy',[T,W,E('1'),0,0,E('10'),1],{address:cfg.gang.pads.v2.address});const f=fixture({logs:[l],receipts:{[hash(1)]:{status:1,from:OTHER,blockNumber:990,index:0,logs:[l]}}});assert.equal((await poll(source(f))).events[0].walletAddress,W);});

test('ordinary known token transfers stay distinct from buy/sell and ignore unknown assets',async()=>{const f=fixture({logs:[transfer(OTHER,W,'3',{index:1}),transfer(W,OTHER,'2',{index:2}),transfer(OTHER,W,'50',{address:addr(99),index:3})]});const r=await poll(source(f));assert.deepEqual(r.events.map(e=>[e.side,e.tokenAmount,e.quoteAmount,e.price]),[['transfer-in','3.0',null,null],['transfer-out','2.0',null,null]]);});

test('graduated V2 swap validates factory registration and uses wallet net token amount after transfer tax',async()=>{
 const logs=[transfer(P,W,'90',{index:1}),log(V2,'Swap',[ROUTER,0,E('2'),E('100'),0,W],{address:P,index:2})];const f=fixture({logs});const r=await poll(source(f),[market('gang',{phase:'graduated',pair:P})]);assert.equal(r.events.length,1);assert.equal(r.events[0].side,'buy');assert.equal(r.events[0].tokenAmount,'90.0');assert.equal(r.events[0].quoteAmount,'2.0');assert.match(r.events[0].source,/V2/);assert.ok(f.calls.filter(c=>c.method==='call').every(c=>c.req.blockTag===990));
});

test('graduated Pancake V3 signed swap decodes protocol fee fields and preserves Flap market mapping',async()=>{
 const logs=[transfer(W,P,'10',{index:1}),log(V3,'Swap',[ROUTER,W,E('10'),-E('4'),1,1,-1,0,0],{address:P,index:2})];const f=fixture({logs,pool:{factory:V3F}});const r=await poll(source(f),[market('flap',{address:F,tokenAddress:T,phase:'graduated',pair:P})]);assert.equal(r.events.length,1);assert.deepEqual([r.events[0].side,r.events[0].tokenAddress,r.events[0].assetAddress,r.events[0].quoteAmount],['sell',F,T,'4.0']);assert.match(r.events[0].source,/V3/);
});

for(const [name,pool] of [['foreign factory',{factory:OTHER}],['incorrect factory registration',{registered:OTHER}],['wrong token identity',{token0:OTHER}]])test(`rejects ${name} as swap evidence; retains transfer`,async()=>{const logs=[transfer(P,W,'5',{index:1}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:2})];const r=await poll(source(fixture({logs,pool})),[market('gang',{phase:'graduated'})]);assert.deepEqual(r.events.map(e=>e.side),['transfer-in']);});

test('DEX receipt from an unwatched sender cannot prove watched wallet bought via a custody/AA route',async()=>{const logs=[transfer(P,W,'5',{index:1}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:2})];const f=fixture({logs,receipts:{[hash(1)]:{status:1,from:OTHER,blockNumber:990,index:0,logs}}});const r=await poll(source(f),[market('gang',{phase:'graduated'})]);assert.deepEqual(r.events.map(e=>e.side),['transfer-in']);assert.match(r.status.coverage,/tx.from/);});

test('unknown quote metadata cannot become a guessed amount or price',async()=>{const logs=[transfer(P,W,'5',{index:1}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:2})];const f=fixture({logs,pool:{token1:OTHER}});const r=await poll(source(f),[market('gang',{phase:'graduated'})]);assert.equal(r.events[0].side,'buy');assert.equal(r.events[0].quoteAmount,null);assert.equal(r.events[0].quoteSymbol,null);assert.equal(r.events[0].price,null);});

test('bounded confirmed scan overlaps prior cursor, declares replace range, and deduplicates scanned logs',async()=>{const l=transfer(OTHER,W,'1',{index:1});const f=fixture({logs:[l,l]});const s=source(f);const initial=await poll(s);assert.equal(initial.cursor,995);assert.equal(initial.replaceFromBlock,868);assert.equal(initial.events.length,1);const r=await poll(s,[market()],{cursor:900});assert.equal(r.cursor,995);assert.equal(r.replaceFromBlock,889);assert.ok(f.calls.filter(c=>c.method==='logs').every(c=>c.filter.toBlock-c.filter.fromBlock<128));assert.equal(r.status.coveredFromBlock,868);});

test('backlog advances only the fully scanned bounded batch and reports remaining lag',async()=>{const f=fixture({tip:10000});const r=await poll(source(f),[market()],{cursor:100});assert.equal(r.cursor,216);assert.equal(r.status.state,'syncing');assert.equal(r.status.lagBlocks,9779);assert.equal(r.replaceFromBlock,89);});

test('RPC log, receipt, timestamp and pool read failures never return a cursor advance',async()=>{
 const l=transfer(OTHER,W,'1');
 await assert.rejects(poll(source(fixture({failLogs:true})),[market()],{cursor:900}),/RPC unavailable/);
 await assert.rejects(poll(source(fixture({logs:[l],receipts:{[hash(1)]:null}})),[market()],{cursor:900}),/receipt/i);
 const f=fixture({logs:[l]});f.provider.getBlock=async()=>{throw Error('block unavailable');};await assert.rejects(poll(source(f),[market()],{cursor:900}),/block unavailable/);
 const logs=[transfer(P,W,'5',{index:1}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:2})];await assert.rejects(poll(source(fixture({logs,failCall:true})),[market('gang',{phase:'graduated'})],{cursor:900}),/RPC call failed/);
});

test('removed/unconfirmed logs, unrelated markets, and spoofed native emitters never become trades',async()=>{const f=fixture({logs:[log(GANG,'Buy',[T,W,E('1'),0,0,E('10'),1],{address:OTHER}),transfer(OTHER,W,'1',{removed:true}),transfer(OTHER,W,'1',{block:998}),transfer(OTHER,W,'1',{address:addr(90)})]});const r=await poll(source(f));assert.deepEqual(r.events,[]);});

test('an arbitrary Swap emitter that reverts on pool getters remains an ordinary transfer',async()=>{
 const logs=[transfer(P,W,'5',{index:1}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:2})];
 const f=fixture({logs});f.provider.call=async()=>{const e=Error('getter does not exist');e.code='CALL_EXCEPTION';e.data='0x';throw e;};
 const r=await poll(source(f),[market('gang',{phase:'graduated'})]);assert.deepEqual(r.events.map(e=>e.side),['transfer-in']);
});

test('backpressure on excessive logs or receipt candidates rejects before claiming scan coverage',async()=>{
 const logs=Array.from({length:2001},(_,i)=>transfer(OTHER,W,'1',{index:i,tx:i+1}));
 await assert.rejects(poll(source(fixture({logs})),[market()],{cursor:900}),/日志过多/);
 await assert.rejects(poll(source(fixture({logs:logs.slice(0,201)})),[market()],{cursor:900}),/交易过多/);
});

test('one transaction with too many candidate pools fails with bounded work instead of advancing',async()=>{
 const logs=[transfer(P,W,'5',{index:0}),...Array.from({length:33},(_,i)=>log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:addr(100+i),index:i+1}))];
 await assert.rejects(poll(source(fixture({logs})),[market('gang',{phase:'graduated'})],{cursor:900}),/池/);
});

test('receipt or block hash changes during a scan reject the batch for safe reorg replay',async()=>{
 const l=transfer(OTHER,W,'1');
 const f=fixture({logs:[l],receipts:{[hash(1)]:{status:1,from:W,blockNumber:990,blockHash:hash(123),index:0,logs:[l]}}});
 await assert.rejects(poll(source(f),[market()],{cursor:900}),/changed/);
 const g=fixture({logs:[l]});g.provider.getBlock=async()=>({timestamp:1793090990,hash:hash(123)});
 await assert.rejects(poll(source(g),[market()],{cursor:900}),/changed/);
});

test('unverified markets and an unrecognized Gang manager are never promoted into signals',async()=>{
 const logs=[transfer(OTHER,W,'1'),log(GANG,'Buy',[T,W,E('1'),0,0,E('10'),1],{address:cfg.gang.pads.v2.address,index:1})];
 const f=fixture({logs});assert.deepEqual((await poll(source(f),[market('gang',{verified:false})])).events,[]);
 assert.deepEqual((await poll(source(f),[market('gang',{manager:OTHER})])).events,[]);
});

test('registered external swap proves graduation even when Gang/Four phase metadata is stale',async()=>{
 const logs=[transfer(P,W,'5',{index:1}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:2})];
 for(const platformId of ['gang','four']){const r=await poll(source(fixture({logs})),[market(platformId,{phase:'bonding'})]);assert.equal(r.events[0].side,'buy');assert.equal(r.events[0].phase,'graduated');}
});

test('Flap uses a known deployed token despite stale phase and never treats predictedToken as an ERC20',async()=>{
 const logs=[transfer(P,W,'5',{index:1}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:2})];
 const known=await poll(source(fixture({logs})),[market('flap',{address:F,phase:'launching',tokenAddress:T})]);assert.equal(known.events[0].side,'buy');assert.equal(known.events[0].tokenAddress,F);assert.equal(known.events[0].assetAddress,T);
 const predicted=await poll(source(fixture({logs})),[market('flap',{address:F,phase:'launching',predictedToken:T,tokenAddress:null})]);assert.deepEqual(predicted.events,[]);
});

test('gift to watched tx sender plus another recipient swap in one batch stays a transfer',async()=>{
 const logs=[transfer(OTHER,W,'5',{index:1}),transfer(P,OTHER,'10',{index:2}),log(V2,'Swap',[ROUTER,0,E('2'),E('10'),0,OTHER],{address:P,index:3})];
 const r=await poll(source(fixture({logs})),[market('gang',{phase:'graduated'})]);
 assert.deepEqual(r.events.map(e=>[e.side,e.tokenAmount]),[['transfer-in','5.0']]);
});

test('direct pool buy allocates only its wallet transfer and preserves a separate gift in the same receipt',async()=>{
 const logs=[transfer(OTHER,W,'7',{index:1}),transfer(P,W,'5',{index:2}),log(V2,'Swap',[ROUTER,0,E('1'),E('5'),0,W],{address:P,index:3})];
 const r=await poll(source(fixture({logs})),[market('gang',{phase:'graduated'})]);
 assert.deepEqual(r.events.map(e=>[e.side,e.tokenAmount,e.quoteAmount]),[['transfer-in','7.0',null],['buy','5.0','1.0']]);
});

test('direct pool buy retains token output after tax splits without claiming the tax leg as wallet tokens',async()=>{
 const logs=[transfer(P,OTHER,'10',{index:1}),transfer(P,W,'90',{index:2}),log(V2,'Swap',[ROUTER,0,E('2'),E('100'),0,W],{address:P,index:3})];
 const r=await poll(source(fixture({logs})),[market('gang',{phase:'graduated'})]);
 assert.deepEqual(r.events.map(e=>[e.side,e.tokenAmount,e.quoteAmount]),[['buy','90.0','2.0']]);
});

test('direct pool sell reports the evidenced pool leg and leaves an additional tax or gift transfer distinct',async()=>{
 const logs=[transfer(W,OTHER,'10',{index:1}),transfer(W,P,'90',{index:2}),log(V2,'Swap',[ROUTER,E('90'),0,0,E('2'),W],{address:P,index:3})];
 const r=await poll(source(fixture({logs})),[market('gang',{phase:'graduated'})]);
 assert.deepEqual(r.events.map(e=>[e.side,e.tokenAmount,e.quoteAmount]),[['transfer-out','10.0',null],['sell','90.0','2.0']]);
 assert.match(r.events[1].source,/直接/);
});

test('an intermediary output is a transfer until its wallet allocation can be proven',async()=>{
 const logs=[transfer(P,ROUTER,'10',{index:1}),transfer(ROUTER,W,'10',{index:2}),log(V2,'Swap',[ROUTER,0,E('2'),E('10'),0,ROUTER],{address:P,index:3})];
 const r=await poll(source(fixture({logs})),[market('gang',{phase:'graduated'})]);
 assert.deepEqual(r.events.map(e=>[e.side,e.tokenAmount]),[['transfer-in','10.0']]);
});
