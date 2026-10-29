import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from 'ethers';
import * as mod from '../src/aggregator-routes.mjs';
const A='0x'+'1'.repeat(40),T='0x'+'2'.repeat(40),Q='0x'+'3'.repeat(40),N='0x'+'e'.repeat(40),U='0x55d398326f99059ff775485246999027b3197955';
const input={walletAddress:A,token:T,platformId:'gang',side:'buy',amount:'0.01',slippageBps:100,maxPriceImpactBps:300,settlement:'bnb'};
function setup(){let sent=0,time=1700000000000;const balances=new Map();const quotes=[],state={address:T,platformId:'gang',verified:true,tradable:true,phase:'bonding',manager:T,quoteAsset:Q,quoteSymbol:'Q',quoteDecimals:18,decimals:18,symbol:'TOK'};
 const provider={getBlockNumber:async()=>100,getNetwork:async()=>({chainId:56n}),getFeeData:async()=>({gasPrice:1n}),getBalance:async()=>10n**20n};
 const p={provider,getTokenState:async()=>state,quoteTrade:async(i,g)=>({kind:i.side,summary:{expectedOutputRaw:'100000000000000000000',minimumOutputRaw:g?.minimumOutputRaw||'99000000000000000000',tradeRisk:{status:'ok',priceImpactBps:1,blockReasons:[]}}}),buildTrade:async()=>{sent++;}};
 const baw={marketQuote:async i=>{quotes.push(i);return{fromCoinAmount:i.amount,toCoinAmount:String(Number(i.amount)*100),slippage:String(i.slippageBps/10000)};}};
 const wrapper=mod.createAggregatorProtocol?.({protocol:p,baw,snapshot:async()=>({tokens:[state]}),now:()=>time,scales:async()=>new Map([[Q,'1000']]),read:async(a,b,m)=>m==='balanceOf'?(balances.get(a.toLowerCase())||0n):m==='decimals'?18:0n,verifyQuote:async()=>({verified:true,decimals:18}),verifyLiquidity:async()=>({verified:true})});
 return{wrapper,p,baw,state,quotes,balances,advance:ms=>time+=ms,sent:()=>sent};}
test('aggregator module exists; quote-only plan never builds or signs future funded target',async()=>{assert.equal(typeof mod.createAggregatorProtocol,'function');const h=setup(),plan=await h.wrapper.planRoute(input);assert.equal(plan.kind,'binance-sequential');assert.equal(plan.steps[0].role,'market');assert.equal(plan.steps.at(-1).role,'target');assert.equal(h.sent(),0);assert.equal(plan.summary.simulated,false);assert.equal(plan.originalMinimumOutputRaw,'99000000000000000000');assert.equal(plan.steps[0].quote.toRaw,'1000000000000000');});
test('unsupported direct quote can select USDT before submission, never from a send failure',async()=>{const h=setup(),quote=h.baw.marketQuote;h.baw.marketQuote=async i=>{if(i.fromToken===N&&i.toToken===Q)throw Object.assign(Error('pair unsupported'),{code:'UNSUPPORTED_PAIR'});return quote(i);};const p=await h.wrapper.planRoute(input);assert.equal(p.steps.length,3);assert.equal(p.steps[0].quote.toToken,U);assert.equal(p.steps[1].quote.fromToken,U);});
test('wrong market ownership, stale market, unverified quote semantics block route planning',async()=>{for(const mode of ['platform','stale','quote']){const h=setup();if(mode==='stale')h.state.sourceUnavailable=true;if(mode==='quote')h.p.getTokenState=async()=>{throw Error('quote semantics unknown');};await assert.rejects(h.wrapper.planRoute({...input,...(mode==='platform'?{platformId:'four'}:{})}),/归属|不可用|quote|semantics/);}});
test('source RWA display units are scaled without changing the raw spending cap',async()=>{const h=setup(),p=await h.wrapper.planRoute(input),quote=p.steps[0].quote;assert.equal(quote.toScale,'1000');assert.equal(quote.toRaw,'1000000000000000');assert.equal(quote.minimumRaw,'995000000000000');});
test('graduated Flap quotes and positions use minted ERC20, never the former share market',async()=>{const h=setup();h.state.phase='graduated';h.state.platformId='flap';h.state.addressKind='market';h.state.tokenAddress=Q;const plan=await h.wrapper.planRoute({...input,platformId:'flap'});assert.equal(plan.steps[0].quote.toToken,Q);assert.equal(plan.assetToken,Q);assert.equal((await h.wrapper.positions(T,A,{platformId:'flap'})).assetToken,Q);});
test('future funded target refuses missing proceeds and lower current wallet balances',async()=>{const h=setup(),p=await h.wrapper.planRoute(input);await assert.rejects(h.wrapper.buildRouteStep(p,{...p.steps.at(-1),ownedAssets:{}}),/到账/);await assert.rejects(h.wrapper.buildRouteStep(p,{...p.steps.at(-1),ownedAssets:{[Q]:'10'}}),/余额|底币/);});
test('RWA multiplier change blocks execution; increased slippage never overrides impact cap',async()=>{const h=setup(),p=await h.wrapper.planRoute(input);p.steps[0].quote.toScale='1';await assert.rejects(h.wrapper.validateRouteStep(p,{kind:'market',marketInput:p.steps[0].quote,summary:{minimumOutputRaw:'1'}}),/乘数/);const q=h.baw.marketQuote;h.baw.marketQuote=async i=>{const r=await q(i);if(i.amount==='0.01')r.toCoinAmount='0.5';return r;};await assert.rejects(h.wrapper.planRoute({...input,slippageBps:5000}),/冲击/);});
test('receipt-derived proceeds exclude old balances; below-min partial fill is retained and pauses',async()=>{
 const h=setup();h.balances.set(Q,1000n);const p=await h.wrapper.planRoute(input),q=p.steps[0].quote;const erc=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);const e=erc.encodeEventLog(erc.getEvent('Transfer'),[T,A,100n]);h.balances.set(Q,1100n);
 const observed=await h.wrapper.observeRouteStep(p,{kind:'market',role:'market',marketInput:q,beforeTo:'1000',summary:{minimumOutputRaw:'101'}},{logs:[{...e,address:Q}]},{});
 assert.equal(observed.ownedAssets[Q],'100');assert.match(observed.haltReason,/最低/);assert.equal(observed.retainedBalances[0].amountRaw,'100');
});
test('ledger positions need confirmed-call minimum and balance increase, not nonexistent token transfers',async()=>{
 const h=setup();h.state.launchType='fair';const p=await h.wrapper.planRoute(input);let balance='120';h.p.positions=async()=>({balance});const step={kind:'buy',role:'target',beforePositionRaw:'20',summary:{minimumOutputRaw:'99',tradeRisk:{priceImpactBps:1}}};
 const observed=await h.wrapper.observeRouteStep(p,step,{logs:[]},{});assert.equal(observed.ownedAssets[T],'99');assert.match(observed.retainedBalances[0].basis,/保守/);balance='100';await assert.rejects(h.wrapper.observeRouteStep(p,step,{logs:[]},{}),/最低份额/);
});
test('definite quote unavailability can retain the old verified route before any submission',async()=>{const h=setup();h.baw.marketQuote=async()=>{throw Error('HTTP 503');};h.p.planRoute=async()=>({kind:'bnb-sequential',verifiedFallback:true});const p=await h.wrapper.planRoute(input);assert.equal(p.verifiedFallback,true);assert.equal(h.sent(),0);});
test('minimum USD quote size uses a larger reference and normalizes full-size curve impact',async()=>{
 const h=setup(),quote=h.baw.marketQuote;
 h.baw.marketQuote=async i=>{
  if(i.fromToken===N&&i.toToken===Q)throw Error('Unsupported token pair for Ondo trading, one side must be a supported stablecoin');
  if(i.fromToken===N&&i.toToken===U)return{fromCoinAmount:i.amount,toCoinAmount:(Number(i.amount)*1000).toFixed(18),slippage:String(i.slippageBps/10000)};
  if(i.fromToken===U&&i.toToken===Q){if(Number(i.amount)<5)throw Error('From token value greater than 5 USD');return{fromCoinAmount:i.amount,toCoinAmount:(Number(i.amount)*100/(1+Number(i.amount)/1000)).toFixed(18),slippage:String(i.slippageBps/10000)};}
  return quote(i);
 };
 const p=await h.wrapper.planRoute(input);assert.equal(p.steps.length,3);assert.ok(p.summary.tradeRisk.priceImpactBps>=98&&p.summary.tradeRisk.priceImpactBps<=103,'large reference cannot hide full-order impact');assert.equal(h.sent(),0);
});
test('inner aggregator plan obeys the existing protocol 120-second deadline limit',async()=>{const h=setup(),quote=h.p.quoteTrade;h.p.quoteTrade=async(i,g)=>{assert.ok(g.deadline<=1700000000+120,'protocol deadline cannot be extended by the aggregator');return quote(i,g);};const p=await h.wrapper.planRoute(input);assert.equal(p.deadline,1700000120);});
test('BNB-settled summary keeps funding amounts and impact separate from intermediate asset fees',async()=>{const h=setup(),quote=h.p.quoteTrade;h.p.quoteTrade=async(...args)=>{const r=await quote(...args);return{...r,summary:{...r.summary,inputRaw:'999',estimatedSpend:'9',estimatedTotalFee:'2',quoteSymbol:'Q',priceImpactBps:1}};};const p=await h.wrapper.planRoute(input);assert.equal(p.summary.inputRaw,'10000000000000000');assert.equal(p.summary.estimatedSpend,'0.01');assert.equal(p.summary.estimatedTotalFee,undefined);assert.equal(p.summary.intermediate.estimatedTotalFee,'2');assert.equal(p.summary.intermediate.quoteSymbol,'Q');assert.equal(p.summary.priceImpactBps,p.summary.tradeRisk.priceImpactBps);});
test('another target with the same base asset reuses the known USDT path and minimum-size recipe, not old prices',async()=>{
 const h=setup();let rejectedDirect=0,rejectedSmall=0,successful=0;
 h.baw.marketQuote=async i=>{if(i.fromToken===N&&i.toToken===Q){rejectedDirect++;throw Error('Unsupported token pair for Ondo trading');}if(i.fromToken===U&&i.toToken===Q&&Number(i.amount)<5){rejectedSmall++;throw Error('From token value greater than 5 USD');}successful++;return{fromCoinAmount:i.amount,toCoinAmount:(Number(i.amount)*(i.toToken===U?1000:100)).toFixed(18),slippage:String(i.slippageBps/10000)};};
 await h.wrapper.planRoute(input);assert.equal(rejectedDirect,1);assert.equal(rejectedSmall,1);
 h.state.address='0x'+'4'.repeat(40);await h.wrapper.planRoute({...input,token:h.state.address});
 assert.equal(rejectedDirect,1,'known unsupported direct pair is not probed for each new token');assert.equal(rejectedSmall,1,'known minimum lot is not rediscovered');assert.ok(successful>=8,'new order still obtains current amount and reference quotes');assert.equal(h.sent(),0);
});
test('cached funding recipe still rejects a reduced native balance before a market send',async()=>{const h=setup(),p=await h.wrapper.planRoute(input);h.p.provider.getBalance=async()=>0n;await assert.rejects(h.wrapper.validateRouteStep(p,{kind:'market',marketInput:p.steps[0].quote,summary:{minimumOutputRaw:'1'}}),/余额|Gas/);assert.equal(h.sent(),0);});
test('routing recipe expires rather than being trusted permanently',async()=>{const h=setup(),q=h.baw.marketQuote;let probes=0;h.baw.marketQuote=async i=>{if(i.fromToken===N&&i.toToken===Q){probes++;throw Error('unsupported pair');}return q(i);};await h.wrapper.planRoute(input);await h.wrapper.planRoute(input);assert.equal(probes,1);h.advance(300000);await h.wrapper.planRoute(input);assert.equal(probes,2);});

test('slippage is allocated across actual route steps without widening the original final floor',async()=>{
 const direct=setup(),p=await direct.wrapper.planRoute({...input,slippageBps:50});assert.equal(p.steps[0].quote.slippageBps,25);assert.equal(p.originalMinimumOutputRaw,'99500000000000000000');
 const external=setup();external.state.phase='graduated';const e=await external.wrapper.planRoute({...input,slippageBps:50});assert.equal(e.steps.length,1);assert.equal(e.steps[0].quote.slippageBps,50);assert.equal(e.steps[0].quote.minimumRaw,e.originalMinimumOutputRaw);
 const via=setup(),quote=via.baw.marketQuote;via.baw.marketQuote=async i=>{if(i.fromToken===N&&i.toToken===Q)throw Error('pair unsupported');return quote(i);};const v=await via.wrapper.planRoute({...input,slippageBps:50});assert.equal(v.steps.length,3);assert.ok(v.steps.filter(s=>s.quote).every(s=>s.quote.slippageBps===16));assert.equal(v.originalMinimumOutputRaw,p.originalMinimumOutputRaw);
});
test('a move inside the allocated budget is permitted; moves beyond it and too-small total budgets remain blocked',async()=>{
 const h=setup(),p=await h.wrapper.planRoute({...input,slippageBps:50}),quote=h.baw.marketQuote;let drop=0.002;
 h.baw.marketQuote=async i=>{const r=await quote(i);return{...r,toCoinAmount:String(Number(r.toCoinAmount)*(1-drop))};};
 const step=await h.wrapper.buildRouteStep(p,p.steps[0]);assert.equal(step.summary.minimumOutputRaw,p.steps[0].quote.minimumRaw);assert.equal(p.originalMinimumOutputRaw,'99500000000000000000');
 drop=0.003;await assert.rejects(h.wrapper.buildRouteStep(p,p.steps[0]),/最低收到/);
 await assert.rejects(setup().wrapper.planRoute({...input,slippageBps:10}),/滑点.*步骤|步骤.*滑点/);
});
