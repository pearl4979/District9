import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,parseEther as E,keccak256,ZeroAddress} from 'ethers';
import {createTradeService} from '../src/trades.mjs';
import {verifyRouteWalletPreview} from '../src/route-orders.mjs';
const mod=await import('../src/gang-merged-trading.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const a=n=>'0x'+n.toString(16).padStart(40,'0');
const PAD=a(90),TOKEN=a(1),QUOTE='0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',ROUTER=a(91),IMPL=a(92),HANDLER=a(93),DEX=a(94),FACTORY=a(95),PAIR=a(96),WALLET=a(97),CREATOR=a(98);
const trade=new Interface(['function buy(address,uint256,uint256)','function sell(address,uint256,uint256)','function mint(address,uint256,uint256)','function withdraw(address,uint256,uint256)','function v3BuyBNB(address,uint256,uint256)','function fairMintBNB(address,uint256,uint256,uint256)','function poolBuyBNB(address,address,uint256,uint256)','function poolSellForBNB(address,address,uint256,uint256,uint256)','function poolSell(address,address,uint256,uint256,uint256)','function approve(address,uint256)']);
function fixture(){
 const code={pad:'0x6001',router:'0x6002',implementation:'0x6003',handler:'0x6004',pancake:'0x6005'};
 const config={pad:PAD,codeHash:keccak256(code.pad),factory:FACTORY,router:ROUTER,routerCodeHash:keccak256(code.router),implementation:IMPL,implementationCodeHash:keccak256(code.implementation),handler:HANDLER,handlerCodeHash:keccak256(code.handler),pancakeRouter:DEX,pancakeCodeHash:keccak256(code.pancake)};
 const s={kind:1,graduated:false,creator:CREATOR,quote:QUOTE,realQuote:E('1'),sold:E('177777777.777777777777777777'),gradAmt:E('15'),virtualQuote:E('5'),buyTaxBps:200n,sellTaxBps:200n,dividendBps:5000n,pair:PAIR,refPair:ZeroAddress,
  launched:false,soldShares:200n,capShares:100n,holdBps:6000n,mintFeeBps:200n,exitFeeBps:100n,gate:a(100),sharePrice:E('.0005'),refPool:ZeroAddress,markSold:200n,progressAt:1n};
 let allowance=0n,tokenBalance=E('175000'),quoteBalance=E('10'),badSlot=false,badCode=false,handlerFail=false,agent=true,quote=QUOTE,wrongPair=false;
 let bridgePair=a(101),bridgeWrong=false,bridgeShallow=false;const calls=[],reads=[];
 const provider={getNetwork:async()=>({chainId:56n}),getBlockNumber:async()=>100,getBlock:async()=>({timestamp:1793139000}),getCode:async address=>badCode&&address===ROUTER?'0x6000':({[PAD]:code.pad,[ROUTER]:code.router,[IMPL]:code.implementation,[HANDLER]:code.handler,[DEX]:code.pancake}[address]||'0x6006'),getStorage:async()=> '0x'+(badSlot?'0'.repeat(24)+a(5).slice(2):'0'.repeat(24)+IMPL.slice(2)),
  getBalance:async()=>E('100'),getFeeData:async()=>({gasPrice:100000000n}),estimateGas:async()=>200000n,call:async tx=>{calls.push(tx);return '0x';}};
 const read=async(address,_abi,fn,args=[],block)=>{
  reads.push({address,fn,args,block});assert.equal(block,100,'All state evidence uses one pinned block');
  if(address===PAD){
   if(fn==='kindOf')return BigInt(s.kind);if(fn==='curves')return{...s,quote};if(fn==='sales')return{...s,quote,sold:s.soldShares};
   if(fn==='pairFactory')return FACTORY;if(fn==='wbnb')return QUOTE;if(fn==='status')return s.launched?2n:1n;
   if(fn==='isAgent')return agent;if(fn==='agentGateEnabled')return true;if(fn==='routers')return true;if(fn==='walletRoom')return E('10000000');
   if(fn==='positions')return 3n;if(fn==='TOKENS_PER_SHARE')return E('50000');
   if(fn==='previewMint'){const accepted=args[2]>97n?97n:args[2],cost=accepted*E('.0005');return[accepted,cost,cost/50n];}
   if(fn==='previewWithdraw'){const principal=args[2]*E('.0005');return[principal-principal/100n,principal/100n];}
   if(fn==='exitFeeBpsOf')return 100n;if(fn==='baselineOf')return E('150000');if(fn==='holdBpsOf')return 6000n;
  }
  if(address===TOKEN){const values={launchpad:PAD,locked:!(s.kind===1?s.graduated:s.launched),decimals:18n,totalSupply:E('1000000000'),name:'Merged',symbol:'MERGED',pair:PAIR,buyTaxBps:s.kind===1?s.buyTaxBps:100n,sellTaxBps:s.kind===1?s.sellTaxBps:100n,taxHandler:HANDLER,balanceOf:tokenBalance,allowance};if(fn in values)return values[fn];}
  if(address===quote||address===QUOTE){const values={symbol:quote===QUOTE?'WBNB':'GANG',decimals:18n,balanceOf:quoteBalance,allowance};if(fn in values)return values[fn];}
  if(address===a(100)&&fn==='balanceOf')return agent?1n:0n;
  if(address===ROUTER){return{pad:PAD,wbnb:QUOTE,pancakeRouter:DEX}[fn];}
  if(address===FACTORY&&fn==='getPair')return args.some(x=>x===TOKEN)?(wrongPair?a(5):PAIR):bridgePair;
  if(address===a(101))return{token0:QUOTE,token1:bridgeWrong?a(6):quote,factory:FACTORY,getReserves:[bridgeShallow?E('.0001'):E('100'),E('10000'),0n]}[fn];
  if(address===PAIR)return{token0:TOKEN,token1:quote,factory:FACTORY,getReserves:[E('100000000'),E('10'),0n]}[fn];
  if(address===DEX&&fn==='getAmountsOut'){const [n,path]=args;if(path.length===3)return[n,E('.01'),E('98000')];if(path[0]===quote&&path[1]===QUOTE)return[n,n/100n];return[n,n*10000000n/(1n+n/E('1000000000000'))];}
  if(address===HANDLER){if(fn==='previewSellNextBlock'){if(handlerFail)throw Error('handler offline');return[E('.0095'),E('20')];}if(fn==='isOut')return false;}
  throw Error('Unexpected read '+address+' '+fn);
 };
 const make=({useDefaultVerifier=false}={})=>{assert.equal(typeof mod.createGangMergedProtocol,'function');return mod.createGangMergedProtocol({provider,read,config,now:()=>1793139000000,...(useDefaultVerifier?{}:{verifyQuoteAsset:async({address,blockTag})=>({verified:config.verifiedQuoteTokens?.some(x=>x.address===address&&x.transferSemantics==='standard-erc20'&&x.codeHash===keccak256('0x6006'))===true,decimals:18})})});};
 return{s,config,provider,reads,calls,make,setAllowance:v=>allowance=v,setBadSlot:()=>badSlot=true,setBadCode:()=>badCode=true,setHandlerFail:()=>handlerFail=true,setAgent:v=>agent=v,setQuote:v=>quote=v,setPairWrong:()=>wrongPair=true,setTokenBalance:v=>tokenBalance=v,setQuoteBalance:v=>quoteBalance=v,setBridgeMissing:()=>bridgePair=ZeroAddress,setBridgeWrong:()=>bridgeWrong=true,setBridgeShallow:()=>bridgeShallow=true,trustQuote:()=>config.verifiedQuoteTokens=[{address:quote,codeHash:keccak256('0x6006'),transferSemantics:'standard-erc20'}]};
}
const input=(side='buy',amount='.01')=>({token:TOKEN,side,amount:amount.startsWith('.')?'0'+amount:amount,slippageBps:50,maxPriceImpactBps:300,walletAddress:WALLET});
test('final Gang trade validation avoids repeated presentation and funding reads but simulates the exact transaction',async()=>{
 const h=fixture();h.setAllowance(E('1000'));const p=h.make(),built=await p.buildTrade(input('sell','1000'));h.reads.length=0;h.calls.length=0;
 const proof=await p.validateExecution(built.transaction,{...built.summary,kind:'sell'});
 assert.equal(proof.simulated,true);assert.equal(h.calls.length,1);assert.deepEqual({...h.calls[0],value:String(h.calls[0].value)},built.transaction);
 assert.equal(h.reads.some(r=>['name','symbol','balanceOf','allowance'].includes(r.fn)),false);
});

test('approved Gang sell accepts normal allowance consumption in direct and route wallet previews',async()=>{
 const h=fixture(),amount=E('1000');h.setAllowance(amount);const real=h.make(),protocol={...real,buildTrade:async(...args)=>{const b=await real.buildTrade(...args);return{...b,summary:{...b.summary,kind:b.kind}};}};let sends=0;
 const raw={requestId:'sell-consumption',expiresAt:1793139060000,risks:{addresses:{},riskDetails:[],riskBehaviors:[]},simulationResult:{simulationCode:'000000000',authorityChanges:[],allowanceChanges:[{tokenAddress:TOKEN,owner:WALLET,spender:PAD,preAmount:Number(amount),postAmount:0,tokenType:'Erc20',tokenId:null}]}};
 const built=await protocol.buildTrade(input('sell','1000'));
 assert.doesNotThrow(()=>verifyRouteWalletPreview(raw,built));
 const service=createTradeService({protocol,baw:{executionContext:async()=>({available:true,address:WALLET}),preview:async()=>raw,execute:async()=>{sends++;return{status:'PENDING_CONFIRMATION',orderId:'sell-order'};}},liveExecution:true,now:()=>1793139000000});
 const {walletAddress,...request}=input('sell','1000');
 const result=await service.place(request,{intentId:'gang-sell-normal-consumption',expectedWallet:WALLET});
 assert.equal(result.submitted,true);assert.equal(result.order.kind,'sell');assert.equal(sends,1);
});

test('Fair private positions expose current shares and effective principal without implying historical spending',async()=>{
 const h=fixture();h.s.kind=2;const p=await h.make().positions(TOKEN,WALLET);
 assert.equal(p.fairShares,'3');assert.equal(p.fairPrincipal,'0.0015');assert.equal(p.fairPrincipalRaw,'1500000000000000');assert.equal(p.sourceBlock,100);assert.equal(p.address,WALLET);
});

test('V3 WBNB curve buy previews native BNB through verified router without a wrap or approval',async()=>{
 const h=fixture(),p=h.make(),b=await p.buildTrade(input());const tx=trade.parseTransaction(b.transaction);
 assert.equal(b.kind,'buy');assert.equal(b.transaction.to,ROUTER);assert.equal(b.transaction.value,'10000000000000000');assert.equal(tx.name,'v3BuyBNB');assert.equal(tx.args[0],TOKEN);
 assert.equal(b.summary.protocolFeeBps,'100');assert.equal(b.summary.quoteSymbol,'BNB');assert.equal(b.summary.tradeRisk.depthVerified,true);assert.ok(b.summary.tradeRisk.priceImpactBps<300);assert.ok(BigInt(b.summary.minimumOutputRaw)>0n);assert.equal(h.calls.length,1);
});
test('curve sell uses exact token approval to merged pad and has no curve token tax',async()=>{
 const h=fixture(),p=h.make();let b=await p.buildTrade(input('sell','1000'));const tx=trade.parseTransaction(b.transaction);
 assert.equal(b.kind,'approve');assert.equal(b.transaction.to,TOKEN);assert.equal(tx.args[0],PAD);assert.equal(tx.args[1],E('1000'));
 h.setAllowance(E('1000'));b=await p.buildTrade(input('sell','1000'));assert.equal(trade.parseTransaction(b.transaction).name,'sell');assert.equal(b.transaction.to,PAD);assert.equal(b.summary.appliedTokenTaxBps,'0');
});
test('Fair budget mints integer shares and exposes principal, fee and unspent native budget',async()=>{
 const h=fixture();h.s.kind=2;const b=await h.make().buildTrade(input('buy','0.0011')),tx=trade.parseTransaction(b.transaction);
 assert.equal(tx.name,'fairMintBNB');assert.equal(tx.args[1],2n);assert.equal(tx.args[2],2n);assert.equal(b.transaction.value,'1020000000000000');
 assert.equal(b.summary.fairShares,'2');assert.equal(b.summary.estimatedTokens,'100000.0');assert.equal(b.summary.estimatedTotalFee,'0.00002');assert.equal(b.summary.unspentBudget,'0.00008');assert.equal(b.summary.tradeRisk.priceImpactBps,0);
});
test('Fair prelaunch withdraw reclaims full-share tokens directly without approving locked ERC20',async()=>{
 const h=fixture();h.s.kind=2;const p=h.make(),b=await p.buildTrade(input('sell','50000')),tx=trade.parseTransaction(b.transaction);
 assert.equal(b.kind,'sell');assert.equal(tx.name,'withdraw');assert.equal(tx.args[1],1n);assert.equal(b.transaction.to,PAD);assert.equal(b.summary.estimatedReceive,'0.000495');
 await assert.rejects(()=>p.buildTrade(input('sell','49999')),/整份|50,000|50000/);await assert.rejects(()=>p.buildTrade(input('buy','0.0001')),/一份|1 份/);
});
test('Fair positions distinguish ERC20 balances and the amount redeemable as whole mint shares',async()=>{
 const h=fixture();h.s.kind=2;const r=await h.make().positions(TOKEN,WALLET);
 assert.equal(r.balance,String(E('150000')));assert.equal(r.positionKind,'token');assert.equal(r.sellUnitRaw,String(E('50000')));assert.equal(r.fairShares,'3');
});
test('graduated buy uses verified pool tax and pool reserves, unrelated factory pair is refused',async()=>{
 const h=fixture();h.s.graduated=true;const p=h.make(),b=await p.buildTrade(input());
 assert.equal(trade.parseTransaction(b.transaction).name,'poolBuyBNB');assert.equal(b.summary.routeKind,'pool');assert.equal(b.summary.appliedTokenTaxBps,'200');assert.equal(b.summary.tradeRisk.realQuoteReserve,'10.0');
 h.setPairWrong();await assert.rejects(()=>p.buildTrade(input()),/池|pair|工厂/);
});
test('taxed pool sell uses next-block swap-back quote, exact router approval and refuses an unavailable handler',async()=>{
 const h=fixture();h.s.graduated=true;const p=h.make();let b=await p.buildTrade(input('sell','100000'));assert.equal(trade.parseTransaction(b.transaction).args[0].toLowerCase(),ROUTER);
 h.setAllowance(E('100000'));b=await p.buildTrade(input('sell','100000'));const tx=trade.parseTransaction(b.transaction);
 assert.equal(tx.name,'poolSell');assert.equal(b.summary.expectedOutputRaw,String(E('.0095')));assert.equal(tx.args[3],E('.0094525'));assert.equal(b.summary.quotedWith,'previewSellNextBlock');
 h.setHandlerFail();await assert.rejects(()=>p.buildTrade(input('sell','100000')),/handler offline|卖出报价/);
});
test('Fair pool sell warns when a minter crosses the permanent dividend hold line',async()=>{
 const h=fixture();h.s.kind=2;h.s.launched=true;h.setAllowance(E('100000'));const b=await h.make().buildTrade(input('sell','100000'));
 assert.equal(b.summary.fairRewardLost,true);assert.ok(b.summary.tradeRisk.warnings.some(t=>/永久.*分红/.test(t)));
});
test('a changed wallet balance cannot newly forfeit Fair rewards under an old confirmation',async()=>{
 const h=fixture();h.s.kind=2;h.s.launched=true;h.setAllowance(E('100000'));const p=h.make(),b=await p.buildTrade(input('sell','80000'));
 assert.equal(b.summary.fairRewardLost,false);h.setTokenBalance(E('165000'));
 await assert.rejects(()=>p.validateExecution(b.transaction,{...b.summary,kind:b.kind}),/分红.*变化|重新预览/);
});
test('wrong proxy implementation or bytecode is refused before a native buy or any approval',async()=>{
 for(const setter of ['setBadSlot','setBadCode']){const h=fixture();h[setter]();await assert.rejects(()=>h.make().buildTrade(input()),/路由|实现|合约/);assert.equal(h.calls.length,0);}
});
test('unknown quote semantics and missing Agent ID cannot become executable buys',async()=>{
 const h=fixture();h.setQuote(a(55));await assert.rejects(()=>h.make().buildTrade(input()),/底币|转账|计价币/);
 const g=fixture();g.setAgent(false);await assert.rejects(()=>g.make().buildTrade(input()),/Agent/);
});
test('unverified quote sells keep nominal contract amounts separate from unknown wallet net receipts',async()=>{
 for(const fair of [false,true]){
  const h=fixture();if(fair)h.s.kind=2;h.setQuote(a(55));h.setAllowance(E('100000'));
  const b=await h.make().buildTrade(input('sell',fair?'50000':'1000'));
  assert.equal(b.summary.tradeRisk.estimatedNetOutput,null);assert.equal(b.summary.estimatedReceive,null);assert.equal(b.summary.minReceive,null);
 }
});
test('execution validator binds original minimum, route, phase, amount and calldata',async()=>{
 const h=fixture(),p=h.make(),b=await p.buildTrade(input());const summary={...b.summary,kind:b.kind};await p.validateExecution(b.transaction,summary);
 await assert.rejects(()=>p.validateExecution({...b.transaction,value:'1'},summary),/预览|参数|交易/);
 const parsed=trade.parseTransaction(b.transaction);await assert.rejects(()=>p.validateExecution({...b.transaction,data:trade.encodeFunctionData('v3BuyBNB',[TOKEN,1n,parsed.args[2]])},summary),/预览|参数|交易/);
 h.s.graduated=true;await assert.rejects(()=>p.validateExecution(b.transaction,summary),/阶段|路由|预览/);
});


test('merged read-only quote does not require funding, allowance, gas or simulation',async()=>{
 const h=fixture();h.setQuoteBalance(0n);h.provider.estimateGas=async()=>{throw Error('must not estimate unfunded quote');};
 const q=await h.make().quoteTrade(input());assert.equal(q.kind,'buy');assert.ok(BigInt(q.summary.expectedOutputRaw)>0n);assert.equal(q.transaction,undefined);assert.equal(q.summary.simulated,undefined);assert.equal(q.summary.quoteDecimals,18);assert.equal(h.calls.length,0);assert.equal(h.reads.some(r=>['allowance'].includes(r.fn)),false);
});
test('merged caller minimum and deadline survive quote, approval and native calldata',async()=>{
 const h=fixture(),p=h.make(),guards={minimumOutputRaw:'1000000000000000000',deadline:1793139050};
 const q=await p.quoteTrade(input(),guards),b=await p.buildTrade(input(),guards);assert.equal(q.summary.minimumOutputRaw,guards.minimumOutputRaw);assert.equal(b.summary.minimumOutputRaw,guards.minimumOutputRaw);assert.equal(trade.parseTransaction(b.transaction).args[1],E('1'));assert.equal(b.summary.deadline,guards.deadline);
 await assert.rejects(()=>p.quoteTrade(input(),{minimumOutputRaw:String(E('1000000000'))}),/最低/);
});
test('verified nonWBNB pool BNB buy uses full path and one atomic native transaction',async()=>{
 const h=fixture();h.s.graduated=true;h.setQuote(a(55));h.trustQuote();h.setQuoteBalance(0n);
 const b=await h.make().buildTrade({...input(),settlement:'bnb'}),tx=trade.parseTransaction(b.transaction);
 assert.equal(tx.name,'poolBuyBNB');assert.equal(tx.args[1].toLowerCase(),a(55));assert.equal(b.transaction.value,String(E('.01')));assert.deepEqual(b.summary.routeHops.map(x=>x.toLowerCase()),[QUOTE,a(55),TOKEN].map(x=>x.toLowerCase()));assert.equal(b.summary.settlement,'bnb');assert.equal(b.summary.expectedOutputRaw,String(E('96040')));assert.ok(b.summary.tradeRisk.priceImpactBps>0);assert.equal(h.reads.some(r=>r.fn==='getReserves'&&r.address===a(101)),true);
});
test('BNB pool sale uses handler-adjusted quote proceeds then exact native settlement minimum',async()=>{
 const h=fixture();h.s.graduated=true;h.setQuote(a(55));h.trustQuote();const p=h.make(),i={...input('sell','100000'),settlement:'bnb'};
 const approval=await p.buildTrade(i);assert.equal(approval.kind,'approve');assert.equal(trade.parseTransaction(approval.transaction).args[1],E('100000'));
 h.setAllowance(E('100000'));const b=await p.buildTrade(i,{minimumOutputRaw:String(E('.00009'))}),tx=trade.parseTransaction(b.transaction);assert.equal(tx.name,'poolSellForBNB');assert.equal(tx.args[3],E('.00009'));assert.equal(b.summary.expectedOutputRaw,String(E('.000095')));assert.equal(b.summary.tradeRisk.outputSymbol,'BNB');assert.equal(b.summary.tradeRisk.netAfterGas,'0.000071');assert.equal(b.summary.tradeRisk.quoteSymbol,'GANG','target reserves retain actual quote denomination');assert.equal(b.summary.quoteSymbol,'BNB');assert.equal(b.transaction.value,'0');
 await p.validateExecution(b.transaction,{...b.summary,kind:b.kind});
 await assert.rejects(()=>p.validateExecution({...b.transaction,data:trade.encodeFunctionData('poolSell',[TOKEN,a(55),E('100000'),E('.00009'),b.summary.deadline])},{...b.summary,kind:b.kind}),/预览|参数|交易/);
});
test('atomic pool route rejects missing, altered or shallow bridge before simulation',async()=>{
 for(const setter of ['setBridgeMissing','setBridgeWrong','setBridgeShallow']){const h=fixture();h.s.graduated=true;h.setQuote(a(55));h.trustQuote();h[setter]();await assert.rejects(()=>h.make().buildTrade({...input(),settlement:'bnb'}),/桥|池|冲击|风险/);assert.equal(h.calls.length,0);}
});
test('an address and symbol without code-pinned transfer semantics cannot enable an atomic buy',async()=>{
 const h=fixture();h.s.graduated=true;h.setQuote(a(55));await assert.rejects(()=>h.make().quoteTrade({...input(),settlement:'bnb'}),/语义|底币/);
 h.trustQuote();h.config.verifiedQuoteTokens[0].codeHash=keccak256('0x6007');await assert.rejects(()=>h.make().quoteTrade({...input(),settlement:'bnb'}),/语义|底币|合约/);
});


test('inner WBNB sell cannot claim native BNB settlement without a confirmed unwrap step',async()=>{
 const h=fixture();await assert.rejects(()=>h.make().quoteTrade({...input('sell','1000'),settlement:'bnb'}),/BNB.*桥接|BNB.*结算/);assert.equal(h.calls.length,0);
});
test('guarded merged quotes still validate slippage and deadline',async()=>{
 const h=fixture();await assert.rejects(()=>h.make().quoteTrade({...input(),slippageBps:5001},{minimumOutputRaw:'1'}),/滑点/);
 await assert.rejects(()=>h.make().quoteTrade(input(),{deadline:1793139000,minimumOutputRaw:'1'}),/期限/);
});


test('default quote policy failure preserves ordinary merged exits with unknown net and real simulation',async()=>{
 for(const phase of ['curve','fair','pool'])for(const asset of [a(55),'0x0c6302401aa5325C2E36F170f52C00B1d220B405']){
  const h=fixture();if(phase==='fair')h.s.kind=2;if(phase==='pool')h.s.graduated=true;
  h.setQuote(asset);h.setAllowance(E('100000'));const p=h.make({useDefaultVerifier:true});
  const i={...input('sell',phase==='fair'?'50000':'1000'),settlement:'quote'};
  const q=await p.quoteTrade(i);assert.equal(q.kind,'sell');assert.equal(q.summary.simulated,undefined);assert.equal(q.summary.tradeRisk.estimatedNetOutput,null);assert.equal(q.summary.tradeRisk.status,'warning');assert.equal(h.calls.length,0);
  const b=await p.buildTrade(i);assert.equal(b.kind,'sell');assert.equal(b.summary.simulated,true);assert.equal(b.summary.estimatedReceive,null);assert.equal(b.summary.minReceive,null);assert.ok(BigInt(b.summary.expectedOutputRaw)>0n);assert.equal(b.summary.tradeRisk.estimatedNetOutput,null);assert.ok(b.summary.tradeRisk.warnings.some(x=>/转账语义/.test(x)));assert.equal(h.calls.length,1);
  await p.validateExecution(b.transaction,{...b.summary,kind:b.kind});assert.equal(h.calls.length,2);
 }
});
test('default quote policy failure still blocks merged buys and native settlement',async()=>{
 for(const asset of [a(55),'0x0c6302401aa5325C2E36F170f52C00B1d220B405']){
  const h=fixture();h.s.graduated=true;h.setQuote(asset);h.setAllowance(E('100000'));const p=h.make({useDefaultVerifier:true});
  await assert.rejects(()=>p.quoteTrade(input()),/语义|代码/);await assert.rejects(()=>p.buildTrade(input()),/语义|代码/);
  await assert.rejects(()=>p.quoteTrade({...input('sell','1000'),settlement:'bnb'}),/语义|代码/);assert.equal(h.calls.length,0);
 }
});
