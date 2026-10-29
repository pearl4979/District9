import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import * as routes from '../src/bnb-routes.mjs';
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../config/platforms.json',import.meta.url)));
const A='0x'+'1'.repeat(40),T='0x'+'2'.repeat(40),Q='0x'+'3'.repeat(40),P='0x'+'4'.repeat(40),W=config.wrappedNative;
const input={platformId:'gang',token:T,walletAddress:A,side:'buy',amount:'0.01',slippageBps:100,maxPriceImpactBps:300,settlement:'bnb'};
function fixture(){
 const calls=[];let now=1700000000000,balance=100n*10n**18n;
 const state={phase:'bonding',quoteAsset:Q,quoteDecimals:18,quoteSymbol:'Q',tradable:true,manager:T};
 const provider={getBlockNumber:async()=>100,getNetwork:async()=>({chainId:56n}),getCode:async()=> '0x1234',getBalance:async()=>10n**20n,getFeeData:async()=>({gasPrice:1n}),call:async()=> '0x',estimateGas:async()=>100000n};
 const read=async(address,abi,method,args)=>{calls.push(method);if(method==='factory')return config.gang.merged.factory;if(method==='WETH')return W;if(method==='getPair')return P;if(method==='token0')return W;if(method==='token1')return Q;if(method==='getReserves')return[100n*10n**18n,10000n*10n**18n,0];if(method==='getAmountsOut')return[args[0],args[0]*100n];if(method==='balanceOf')return balance;if(method==='allowance')return 0n;throw Error(method);};
 const protocol={provider,getTokenState:async()=>state,quoteTrade:async(i,g)=>{calls.push(['quote',i,g]);return{kind:i.side,summary:{quoteAsset:Q,quoteDecimals:18,expectedOutputRaw:'5000000000000000000',minimumOutputRaw:'4950000000000000000',tradeRisk:{status:'ok',priceImpactBps:2,blockReasons:[]}}};},buildTrade:async(i,g)=>{calls.push(['build',i,g]);return{kind:i.side,transaction:{from:A,to:T,value:'0',data:'0x1234'},summary:{simulated:true,estimatedGas:'100000',inputRaw:'1',minimumOutputRaw:g.minimumOutputRaw,tradeRisk:{status:'ok',priceImpactBps:2,blockReasons:[]}}};},validateExecution:async()=>{}};
 const wrapper=routes.createBnbRouteProtocol?.({protocol,provider,read,now:()=>now,verifyQuote:async()=>({verified:true,address:Q,decimals:18,symbol:'Q',transferSemantics:'standard'}),routerCodeHash:keccak256('0x1234')});
 return{wrapper,provider,read,protocol,calls,state,setTime:v=>now=v,setBalance:v=>balance=v};
}
test('BNB route wrapper exists and produces funding-independent plan with original final minimum',async()=>{
 assert.equal(typeof routes.createBnbRouteProtocol,'function');const h=fixture();const p=await h.wrapper.planRoute(input);assert.equal(p.kind,'bnb-sequential');assert.equal(p.originalMinimumOutputRaw,'4950000000000000000');assert.equal(p.steps[0].role,'bridge');assert.equal(p.steps.at(-1).role,'target');assert.equal(p.walletAddress,A);assert.equal(h.calls.filter(c=>c[0]==='build').length,0);
});
test('unsupported quote semantics, missing pool, changed pair tokens and impact stop planning',async()=>{
 for(const mode of ['semantics','pool','tokens','impact']){const h=fixture();let wrapped=routes.createBnbRouteProtocol({protocol:h.protocol,provider:h.provider,routerCodeHash:keccak256('0x1234'),verifyQuote:async()=>{if(mode==='semantics')throw Error('semantics unknown');return{verified:true,decimals:18};},read:async(...args)=>{if(mode==='pool'&&args[2]==='getPair')return '0x'+'0'.repeat(40);if(mode==='tokens'&&args[2]==='token1')return T;if(mode==='impact'&&args[2]==='getReserves')return[1n,1n,0];return h.read(...args);}});await assert.rejects(wrapped.planRoute(input),/semantics|池|pair|冲击|储备/);}
});
test('graduated Gang native atomic routes and native quote markets pass through',async()=>{
 const h=fixture();h.state.phase='graduated';h.state.pad='merged';assert.equal(await h.wrapper.planRoute(input),null);h.state.phase='bonding';h.state.quoteAsset=W;assert.equal(await h.wrapper.planRoute(input),null);assert.equal(await h.wrapper.planRoute({...input,settlement:'quote'}),null);
});
test('target cannot build before confirmed bridge and fresh target keeps minimum',async()=>{
 const h=fixture(),p=await h.wrapper.planRoute(input);
 await assert.rejects(h.wrapper.buildRouteStep(p,{role:'target',ownedQuoteRaw:'0',bridgeConfirmed:false}),/确认|到账/);
 const built=await h.wrapper.buildRouteStep(p,{role:'target',ownedQuoteRaw:'900000000000000000',bridgeConfirmed:true,completedBridgePriceImpactBps:1});
 const request=h.calls.find(c=>c[0]==='build');assert.equal(request[1].amount,'0.9');assert.equal(request[2].minimumOutputRaw,p.originalMinimumOutputRaw);assert.equal(built.summary.minimumOutputRaw,p.originalMinimumOutputRaw);
});
test('receipt proceeds excludes pre-existing funds and nets outgoing transfers',async()=>{
 const h=fixture(),p=await h.wrapper.planRoute(input);const erc=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);const logs=[erc.encodeEventLog(erc.getEvent('Transfer'),[P,A,100n]),erc.encodeEventLog(erc.getEvent('Transfer'),[A,P,20n])].map(x=>({...x,address:Q}));
 const r=await h.wrapper.observeRouteStep(p,{role:'bridge',kind:'bridge-buy',beforeQuoteBalanceRaw:String(100n*10n**18n-70n)},{logs});assert.equal(r.ownedQuoteRaw,'70');assert.equal(r.retainedBalances[0].amountRaw,'70');
});
test('route never spends old quote holdings after received proceeds are removed',async()=>{
 const h=fixture(),p=await h.wrapper.planRoute(input);
 await assert.rejects(h.wrapper.buildRouteStep(p,{role:'target',ownedQuoteRaw:'100',protectedQuoteRaw:String(100n*10n**18n),bridgeConfirmed:true,completedBridgePriceImpactBps:1}),/原持有|到账|所得|底币/);
});
test('sell bridge amount is only confirmed intent proceeds and preserves original BNB minimum',async()=>{
 const h=fixture();const wrapped=routes.createBnbRouteProtocol({protocol:h.protocol,provider:h.provider,routerCodeHash:keccak256('0x1234'),verifyQuote:async()=>({verified:true,decimals:18}),read:async(...args)=>{if(args[2]==='getAmountsOut')return[args[3][0],args[3][0]/100n];if(args[2]==='allowance')return 10n**30n;return h.read(...args);}});
 const p=await wrapped.planRoute({...input,side:'sell',amount:'2'});
 await assert.rejects(wrapped.buildRouteStep(p,{role:'bridge',ownedQuoteRaw:'0'}),/确认/);
 const b=await wrapped.buildRouteStep(p,{role:'bridge',ownedQuoteRaw:'5000000000000000000',targetConfirmed:true,completedTargetPriceImpactBps:2,protectedQuoteRaw:'0'});
 const tx=new Interface(['function swapExactTokensForETH(uint256,uint256,address[],address,uint256)']).parseTransaction(b.transaction);
 assert.equal(String(tx.args[0]),'5000000000000000000');assert.equal(String(tx.args[1]),p.originalMinimumOutputRaw);assert.equal(p.steps[0].role,'target');assert.equal(p.steps[1].role,'bridge');
});
test('whole route gas balance and expiry stop before another step',async()=>{
 const h=fixture();h.provider.getBalance=async()=>0n;await assert.rejects(h.wrapper.planRoute(input),/Gas|余额/);
 const k=fixture(),p=await k.wrapper.planRoute(input);k.setTime(p.deadline*1000);await assert.rejects(k.wrapper.buildRouteStep(p,{role:'bridge'}),/到期/);
});
test('route quote requires explicit verified proof and plans target from minimum bridge output',async()=>{
 const h=fixture(),p=await h.wrapper.planRoute(input),quote=h.calls.filter(c=>c[0]==='quote').at(-1);assert.equal(quote[1].amount,formatUnitsForTest(p.bridge.minimumOutputRaw));
 const unsafe=routes.createBnbRouteProtocol({protocol:h.protocol,provider:h.provider,read:h.read,routerCodeHash:keccak256('0x1234'),verifyQuote:async()=>({verified:false,decimals:18})});await assert.rejects(unsafe.planRoute(input),/语义|核验/);
});
function formatUnitsForTest(value){const n=BigInt(value);return `${n/10n**18n}.${String(n%10n**18n).padStart(18,'0').replace(/0+$/,'')||'0'}`;}
test('future target cannot execute without real simulation or exceed reserved per-step gas',async()=>{
 for(const mode of ['unsimulated','gas']){const h=fixture(),p=await h.wrapper.planRoute(input),build=h.protocol.buildTrade;h.protocol.buildTrade=async(...args)=>{const b=await build(...args);b.summary.simulated=mode!=='unsimulated';b.summary.estimatedGas=mode==='gas'?'4000001':'100000';return b;};await assert.rejects(h.wrapper.buildRouteStep(p,{role:'target',ownedQuoteRaw:'900000000000000000',bridgeConfirmed:true,completedBridgePriceImpactBps:1}),/模拟|Gas/);}
});
test('fresh execution validation stops if route-owned balance disappears after simulation',async()=>{
 const h=fixture(),p=await h.wrapper.planRoute(input),protectedQuoteRaw=String(99n*10n**18n);
 const b=await h.wrapper.buildRouteStep(p,{role:'target',ownedQuoteRaw:String(10n**18n),protectedQuoteRaw,bridgeConfirmed:true,completedBridgePriceImpactBps:1});h.setBalance(99n*10n**18n);
 await assert.rejects(h.wrapper.validateRouteStep(p,{...b,role:'target'}),/到账|原持有|所得|余额/);
});
test('buy bridge impact and combined hop impact use conservative average-price composition',async()=>{
 const h=fixture(),quote=h.protocol.quoteTrade;h.protocol.quoteTrade=async(...args)=>{const q=await quote(...args);q.summary.tradeRisk.priceImpactBps=150;return q;};
 const w=routes.createBnbRouteProtocol({protocol:h.protocol,provider:h.provider,routerCodeHash:keccak256('0x1234'),verifyQuote:async()=>({verified:true,decimals:18}),read:async(...args)=>args[2]==='getReserves'?[666666666666666667n,10000n*10n**18n,0]:h.read(...args)});
 await assert.rejects(w.planRoute(input),/完整路线价格冲击/);
});
test('target becoming blocked after plan stops bridge at final validation',async()=>{
 const h=fixture(),p=await h.wrapper.planRoute(input),bridge=await h.wrapper.buildRouteStep(p,{role:'bridge'});h.protocol.quoteTrade=async()=>{throw Error('target phase/risk changed');};
 await assert.rejects(h.wrapper.validateRouteStep(p,{...bridge,role:'bridge'}),/target phase/);
});
test('global slippage applies once to full expected output and worst bridge quote cannot relax it',async()=>{
 const h=fixture();h.protocol.quoteTrade=async(i,g={})=>{const expected=BigInt(Math.round(Number(i.amount)*1e6))*10n**12n*5n,minimum=g.minimumOutputRaw?BigInt(g.minimumOutputRaw):expected*9900n/10000n;if(expected<minimum)throw Error('worst bridge below global minimum');return{kind:i.side,summary:{expectedOutputRaw:String(expected),minimumOutputRaw:String(minimum),tradeRisk:{status:'ok',priceImpactBps:2,blockReasons:[]}}};};
 const p=await h.wrapper.planRoute(input);assert.equal(p.summary.expectedOutputRaw,'5000000000000000000');assert.equal(p.originalMinimumOutputRaw,'4950000000000000000');assert.equal(p.bridge.minimumOutputRaw,'995000000000000000');assert.equal(p.summary.amount,input.amount);
});
test('later buy uses recorded bridge impact without quoting an imaginary second bridge',async()=>{
 const h=fixture(),p=await h.wrapper.planRoute(input);h.calls.length=0;await h.wrapper.buildRouteStep(p,{role:'target',ownedQuoteRaw:'900000000000000000',bridgeConfirmed:true,completedBridgePriceImpactBps:1});assert.equal(h.calls.includes('getAmountsOut'),false);
});
test('final sell bridge includes the completed target impact in whole-route ceiling',async()=>{
 const h=fixture();const w=routes.createBnbRouteProtocol({protocol:h.protocol,provider:h.provider,routerCodeHash:keccak256('0x1234'),verifyQuote:async()=>({verified:true,decimals:18}),read:async(...args)=>args[2]==='getAmountsOut'?[args[3][0],args[3][0]/100n]:h.read(...args)});const p=await w.planRoute({...input,side:'sell',amount:'2'});
 await assert.rejects(w.buildRouteStep(p,{role:'bridge',ownedQuoteRaw:'5000000000000000000',targetConfirmed:true,completedTargetPriceImpactBps:300}),/完整路线价格冲击/);
 assert.equal(p.summary.tradeRisk.outputSymbol,'BNB');assert.equal(p.summary.tradeRisk.estimatedNetOutput,'0.05');assert.equal(p.summary.estimatedReceive,'0.05');assert.equal(p.summary.expectedOutputRaw,'50000000000000000');
});
test('Fair integer output that cannot meet global minimum at worst bridge is blocked before funding',async()=>{
 const h=fixture();h.protocol.quoteTrade=async(i,g={})=>{const expected=Number(i.amount)<1?'50000':'100000';return{kind:'buy',summary:{expectedOutputRaw:expected,minimumOutputRaw:g.minimumOutputRaw||'99000',tradeRisk:{status:'ok',priceImpactBps:0,blockReasons:[]}}};};await assert.rejects(h.wrapper.planRoute(input),/整条路线最低输出/);assert.equal(h.calls.some(c=>c[0]==='build'),false);
});
test('target quote reserve retains its denomination when final route settles in BNB',async()=>{
 const h=fixture(),quote=h.protocol.quoteTrade;h.protocol.quoteTrade=async(...args)=>{const q=await quote(...args);Object.assign(q.summary.tradeRisk,{quoteSymbol:'Q',realQuoteReserve:'123.0',feeSymbol:'Q'});return q;};
 const p=await h.wrapper.planRoute(input);assert.equal(p.summary.tradeRisk.realQuoteReserve,'123.0');assert.equal(p.summary.tradeRisk.quoteSymbol,'Q');assert.equal(p.summary.quoteSymbol,'BNB');
});
