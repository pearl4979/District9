import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther as E } from 'ethers';
import * as risks from '../src/trade-risk.mjs';
import { gangBuyQuote, gangSellQuote } from '../src/gang.mjs';

const verifiedGangQuote = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const VIRTUAL = 1066666666666666666666666667n;
const curve = { virtualQuote: E('5'), realQuote: 0n, sold: 0n, gradAmt: E('15') };
const gangRisk = (gross, side = 'buy', limitBps = 300) => {
  const quoted = side === 'buy' ? gangBuyQuote(curve, gross, null) : gangSellQuote(curve, gross);
  return risks.gangTradeRisk({ curve, quoted, side, input: gross, minimum: quoted.output * 99n / 100n, quoteAsset: verifiedGangQuote, quoteDecimals: 18, quoteSymbol: 'WBNB', tokenSymbol: 'TEST', limitBps });
};

test('amount-aware pure curve impact is small in deep liquidity and blocks large shallow buys', () => {
  // For x*y=k, buy average/spot - 1 = netQuote/currentQuote, before the platform fee.
  const small = gangRisk(E('0.01'));
  assert.equal(small.priceImpactBps, 20); // ceil(0.0099 / 5 * 10000)
  assert.equal(small.feeAmount, '0.0001');
  assert.equal(small.status, 'ok');
  const large = gangRisk(E('1'));
  assert.equal(large.priceImpactBps, 1981);
  assert.equal(large.status, 'blocked');
  assert.throws(() => risks.enforceTradeRisk(large, 'buy'), e => e.tradeRisk === large);
  assert.equal(small.realQuoteReserve, '0.0');
  assert.equal(small.virtualQuoteReserve, '5.0');
  assert.equal(small.curveQuoteLiquidity, '5.0');
  const deepCurve = { ...curve, virtualQuote: E('500') };
  const deepQuote = gangBuyQuote(deepCurve, E('1'), null);
  const deep = risks.gangTradeRisk({ curve: deepCurve, quoted: deepQuote, side: 'buy', input: E('1'), minimum: deepQuote.output * 99n / 100n, quoteAsset: verifiedGangQuote, quoteDecimals: 18, quoteSymbol: 'WBNB', tokenSymbol: 'TEST' });
  assert.equal(deep.priceImpactBps, 20);
  assert.equal(deep.status, 'ok');
});

test('sell impact excludes platform fee, warns beyond limit and preserves an exit', () => {
  const bought = gangBuyQuote(curve, E('1'), null);
  const after = { ...curve, sold: bought.output, realQuote: bought.spent - bought.fee };
  const quote = gangSellQuote(after, bought.output);
  const risk = risks.gangTradeRisk({ curve: after, quoted: quote, side: 'sell', input: bought.output, minimum: quote.output * 99n / 100n, quoteAsset: verifiedGangQuote, quoteDecimals: 18, quoteSymbol: 'WBNB', tokenSymbol: 'TEST', limitBps: 300 });
  assert.equal(risk.priceImpactBps, 1653); // 0.99 / 5.99, rounded upward
  assert.equal(risk.status, 'warning');
  assert.equal(risk.outputSymbol, 'WBNB');
  assert.equal(risk.estimatedNetOutput, '0.9801');
  assert.doesNotThrow(() => risks.enforceTradeRisk(risk, 'sell'));
  assert.equal(risks.withRiskGas(risk, '0.001', { nativeOutput: false }).netAfterGas, null);
  assert.equal(risks.withRiskGas(risk, '0.001', { nativeOutput: true }).netAfterGas, '0.9791');
});

test('limits bind independently from slippage and reject malformed values', () => {
  assert.equal(risks.priceImpactLimit(), 300);
  assert.equal(risks.priceImpactLimit(50), 50);
  for (const value of [49, 501, '300', null, 50.5]) assert.throws(() => risks.priceImpactLimit(value), /冲击/);
  assert.equal(gangRisk(E('0.1'), 'buy', 100).status, 'blocked');
  assert.equal(gangRisk(E('0.1'), 'buy', 500).status, 'ok');
});

const snapshot = { available: true, initialQuoteLiquidity: E('10'), initialTokenLiquidity: E('1000'), currentQuoteLiquidity: E('20'), currentTokenLiquidity: E('500'), totalRaised: E('10'), remainingForSale: E('400'), lastPrice: E('0.04') };
// 10 tokens: curveQuote = ceil(10000 / 490) - 20 = 20/49, fee is separately 0.01.
const curveQuote = (E('10000') * E('1') + E('490') - 1n) / E('490') - E('20');
const estimate = { tokenAmount: E('10'), curveQuote, totalFee: E('0.01'), userPays: curveQuote + E('0.01'), userReceives: 0n, executionPrice: curveQuote / 10n };
const fourRisk = extra => risks.fourTradeRisk({ snapshot, estimate, side: 'buy', minimum: E('9.9'), realQuoteBalance: E('10'), tokenSymbol: 'TEST', limitBps: 300, ...extra });

test('Four compares current spot to fee-exclusive executable curve quote and separates virtual backing', () => {
  const risk = fourRisk();
  assert.equal(risk.priceImpactBps, 205); // ceil((20/49)/0.4 - 1), not total userPays
  assert.equal(risk.feeAmount, '0.01');
  assert.equal(risk.realQuoteReserve, '10.0');
  assert.equal(risk.virtualQuoteReserve, null);
  assert.equal(risk.curveQuoteLiquidity, '20.0');
  assert.equal(risk.depthVerified, true);
  assert.equal(risk.status, 'ok');
  assert.equal(fourRisk({ estimate: { ...estimate, totalFee: E('1'), userPays: curveQuote + E('1') } }).priceImpactBps, 205);
});

test('unknown snapshot/backing and inconsistent fee or curve semantics never become zero impact', () => {
  for (const extra of [
    { snapshot: { ...snapshot, available: false } },
    { realQuoteBalance: null },
    { snapshot: { ...snapshot, currentTokenLiquidity: E('501') } },
    { estimate: { ...estimate, curveQuote: curveQuote + E('0.01') } },
    { estimate: { ...estimate, userPays: estimate.userPays + 1n } },
  ]) {
    const risk = fourRisk(extra);
    assert.ok(['blocked', 'unknown'].includes(risk.status));
    assert.throws(() => risks.enforceTradeRisk(risk, 'buy'), e => e.tradeRisk === risk);
  }
  assert.equal(fourRisk({ realQuoteBalance: null }).realQuoteReserve, null);
  assert.equal(fourRisk({ snapshot: { ...snapshot, available: false } }).priceImpactBps, null);
});

test('Flap exposes independently known real balance and retains unknown model instead of treating net price as impact', () => {
  const risk = risks.flapTradeRisk({ side: 'buy', limitBps: 300, detail: { quoteBalanceKnown: true, quoteBalanceRaw: E('3'), quoteBackingEnough: true, inventoryKnown: true, inventoryEnough: true }, settings: { curveR: E('5') }, plan: { output: E('100'), minimum: E('99') }, quoteSymbol: 'QQQB', quoteDecimals: 18, tokenSymbol: 'SHARE' });
  assert.equal(risk.realQuoteReserve, '3.0');
  assert.equal(risk.virtualQuoteReserve, null);
  assert.equal(risk.curveQuoteLiquidity, null);
  assert.equal(risk.priceImpactBps, null);
  assert.equal(risk.feeAmount, null);
  assert.equal(risk.estimatedNetOutput, '100.0');
  assert.equal(risk.status, 'unknown');
  assert.throws(() => risks.enforceTradeRisk(risk, 'buy'), e => /尚未核验/.test(e.message));
  const exit = risks.flapTradeRisk({ side: 'sell', detail: { quoteBalanceKnown: false, inventoryKnown: false }, settings: {}, plan: { output: E('2'), minimum: E('1.98') }, quoteSymbol: 'QQQB', quoteDecimals: 18, tokenSymbol: 'SHARE' });
  assert.equal(exit.realQuoteReserve, null);
  assert.equal(exit.status, 'warning');
  assert.doesNotThrow(() => risks.enforceTradeRisk(exit, 'sell'));
});

// Pinned runtime bytecode is a public, read-only test fixture; the normal production hash check still runs.
import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress } from 'ethers';
import { createGangProtocol } from '../src/gang.mjs';
const platforms = JSON.parse(readFileSync(new URL('../config/platforms.json', import.meta.url)));
const gangCode = readFileSync(new URL('./fixtures/gang-v2-code.hex', import.meta.url), 'utf8').trim();
const gangInterface = new Interface([
  'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,bool taxed,address pair,address refPair)',
  'function agentGateEnabled() view returns(bool)', 'function walletCapEnabled() view returns(bool)', 'function PROTOCOL_FEE_BPS() view returns(uint256)', 'function walletRoom(address,address) view returns(uint256)', 'function isAgent(address) view returns(bool)',
  'function buy(address,uint256,uint256) returns(uint256)', 'function sell(address,uint256,uint256) returns(uint256)',
  'function name() view returns(string)', 'function symbol() view returns(string)', 'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)', 'function deposit() payable',
]);
const gangToken = '0x1111111111111111111111111111111111111111', gangWallet = '0x2222222222222222222222222222222222222222';
function gangHarness({ balance = 0n, allowance = 0n, quoteAsset = platforms.wrappedNative,useDefaultVerifier=false } = {}) {
  const state = { c: { ...curve }, balance, allowance, quoteAsset, simulations: [] };
  const provider = {
    getNetwork: async () => ({ chainId: 56n }), getCode: async () => gangCode, getBlockNumber:async()=>123,
    getBalance: async () => E('5'), estimateGas: async () => 100000n, getFeeData: async () => ({ gasPrice: 50000000n }),
    async call(tx) {
      const { name, args } = gangInterface.parseTransaction(tx);
      const result = values => gangInterface.encodeFunctionResult(name, values);
      if (name === 'curves') return result([gangWallet, state.quoteAsset, state.c.realQuote, state.c.sold, state.c.gradAmt, state.c.virtualQuote, false, false, ZeroAddress, ZeroAddress]);
      if (['agentGateEnabled', 'isAgent'].includes(name)) return result([true]);
      if (name === 'walletCapEnabled') return result([false]);
      if (name === 'PROTOCOL_FEE_BPS') return result([100n]);
      if (name === 'decimals') return result([18]);
      if (name === 'name') return result(['Test']);
      if (name === 'symbol') return result([tx.to.toLowerCase() === gangToken ? 'TEST' : 'WBNB']);
      if (name === 'balanceOf') return result([state.balance]);
      if (name === 'allowance') return result([state.allowance]);
      state.simulations.push(name);
      if (name === 'deposit') return '0x';
      if (name === 'approve') return result([true]);
      if (name === 'buy' || name === 'sell') return result([1n]);
      throw new Error(`Unexpected fake Gang RPC ${name}/${args}`);
    },
  };
  return { state, protocol: createGangProtocol({ provider,...(useDefaultVerifier?{}:{verifyQuoteAsset:async()=>({verified:false})}) }) };
}

test('unsafe Gang buy is rejected before wrap or approval simulation even when funding is missing', async () => {
  for (const balance of [0n, E('2')]) {
    const { protocol, state } = gangHarness({ balance });
    await assert.rejects(protocol.buildTrade({ token: gangToken, walletAddress: gangWallet, side: 'buy', amount: '1', slippageBps: 100 }), e => e.tradeRisk?.status === 'blocked' && e.tradeRisk.priceImpactBps > 300);
    assert.deepEqual(state.simulations, []);
  }
});

test('Gang fresh risk blocks both wrap and approval execution after the depth becomes shallow', async () => {
  for (const balance of [0n, E('2')]) {
    const { protocol, state } = gangHarness({ balance });
    const trade = await protocol.buildTrade({ token: gangToken, walletAddress: gangWallet, side: 'buy', amount: '0.01', slippageBps: 100, maxPriceImpactBps: 50 });
    assert.equal(trade.kind, balance === 0n ? 'wrap' : 'approve');
    assert.equal(trade.summary.tradeRisk.limitBps, 50);
    assert.equal(trade.summary.tradeRisk.nativeGasBudget, '0.000006');
    state.simulations.length = 0;
    state.c.virtualQuote = E('0.1');
    await assert.rejects(protocol.validateExecution(trade.transaction, { ...trade.summary, kind: trade.kind }), e => e.tradeRisk?.status === 'blocked');
    assert.deepEqual(state.simulations, []);
  }
});

test('Gang high-impact sale continues to exact execution simulation with warnings', async () => {
  const { protocol, state } = gangHarness({ balance: E('1000000000'), allowance: E('1000000000') });
  const bought = gangBuyQuote(curve, E('1'), null);
  state.c = { ...curve, sold: bought.output, realQuote: E('0.99') };
  const trade = await protocol.buildTrade({ token: gangToken, walletAddress: gangWallet, side: 'sell', amount: String(bought.output / 10n ** 18n), slippageBps: 100 });
  assert.equal(trade.kind, 'sell');
  assert.equal(trade.summary.tradeRisk.status, 'warning');
  assert.ok(trade.summary.tradeRisk.priceImpactBps > 300);
  assert.deepEqual(state.simulations, ['sell']);
  const checked = await protocol.validateExecution(trade.transaction, { ...trade.summary, kind: 'sell' });
  assert.equal(checked.tradeRisk.outputSymbol, 'WBNB');
  assert.equal(checked.tradeRisk.netAfterGas, null);
  assert.deepEqual(state.simulations, ['sell', 'sell']);
});

test('Four sell net/minimum and native gas remain separate from pure curve impact', () => {
  const amount = E('10'), denominator = E('510');
  const gross = E('20') - (E('10000') * E('1') + denominator - 1n) / denominator;
  const fees = E('0.01'), net = gross - fees;
  const risk = risks.fourTradeRisk({ snapshot, estimate: { tokenAmount: amount, curveQuote: gross, totalFee: fees, userPays: 0n, userReceives: net, executionPrice: gross * E('1') / amount }, side: 'sell', minimum: net * 99n / 100n, realQuoteBalance: E('10'), tokenSymbol: 'TEST', limitBps: 50 });
  assert.equal(risk.priceImpactBps, 197);
  assert.equal(risk.status, 'warning');
  assert.equal(risk.outputSymbol, 'BNB');
  assert.equal(risk.feeSymbol, 'WBNB');
  assert.notEqual(risk.estimatedNetOutput, risk.feeAmount);
  const withGas = risks.withRiskGas(risk, '0.001', { nativeOutput: true });
  assert.equal(withGas.nativeGasBudget, '0.001');
  assert.ok(withGas.netAfterGas);
  assert.doesNotThrow(() => risks.enforceTradeRisk(withGas, 'sell'));
});

test('Flap Reader backing failures are explicit and never overwrite a known balance with zero', () => {
  const args = { side: 'buy', detail: { quoteBalanceKnown: true, quoteBalanceRaw: E('3'), quoteBackingEnough: false, inventoryKnown: true, inventoryEnough: false }, settings: { curveR: E('5'), curveK: E('100') }, plan: { output: E('100'), minimum: E('99') }, quoteSymbol: 'QQQB', quoteDecimals: 18, tokenSymbol: 'SHARE' };
  const risk = risks.flapTradeRisk(args);
  assert.equal(risk.status, 'blocked');
  assert.equal(risk.depthVerified, false);
  assert.equal(risk.realQuoteReserve, '3.0');
  assert.ok(risk.blockReasons.some(reason => /底币背书不足/.test(reason)));
  assert.ok(risk.blockReasons.some(reason => /库存不足/.test(reason)));
  const unknown = risks.flapTradeRisk({ ...args, detail: { quoteBalanceKnown: false, quoteBalanceRaw: 0n, inventoryKnown: false } });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.realQuoteReserve, null);
});


const unverifiedQuoteAsset = '0x3333333333333333333333333333333333333333';
test('Gang arbitrary quote ERC20 keeps nominal output separate from actual net and pure impact', () => {
  const bought = gangBuyQuote(curve, E('1'), null);
  const after = { ...curve, sold: bought.output, realQuote: E('0.99') };
  const quoted = gangSellQuote(after, bought.output);
  const minimum = quoted.output * 99n / 100n;
  // A transfer-tax quote can satisfy the Launchpad nominal minimum while the recipient receives less.
  const taxedReceipt = quoted.output * 9000n / 10000n;
  assert.equal(taxedReceipt, E('0.88209'));
  assert.ok(taxedReceipt < minimum);
  const risk = risks.gangTradeRisk({ curve: after, quoted, side: 'sell', input: bought.output, minimum, quoteAsset: unverifiedQuoteAsset, quoteDecimals: 18, quoteSymbol: 'WBNB', tokenSymbol: 'TEST', limitBps: 300 });
  assert.equal(risk.estimatedNetOutput, null);
  assert.equal(risk.minimumNetOutput, null);
  assert.equal(risk.priceImpactBps, null);
  assert.equal(risk.priceImpactMethod, null);
  assert.equal(risk.contractQuotedOutput, '0.9801');
  assert.equal(risk.contractMinimumOutput, '0.970299');
  assert.equal(risk.status, 'warning');
  assert.ok(risk.warnings.some(warning => /转账税/.test(warning)));
  assert.doesNotThrow(() => risks.enforceTradeRisk(risk, 'sell'));
});

test('Gang unverified quote buys stop before approval even if their symbol impersonates WBNB', async () => {
  const { protocol, state } = gangHarness({ balance: E('2'), quoteAsset: unverifiedQuoteAsset });
  await assert.rejects(protocol.buildTrade({ token: gangToken, walletAddress: gangWallet, side: 'buy', amount: '0.01', slippageBps: 100 }), error => error.tradeRisk?.status === 'unknown' && error.tradeRisk.priceImpactBps === null);
  assert.deepEqual(state.simulations, []);
});

test('Gang changed quote transfer semantics stop wrap and approval revalidation before simulation', async () => {
  for (const balance of [0n, E('2')]) {
    const { protocol, state } = gangHarness({ balance });
    const trade = await protocol.buildTrade({ token: gangToken, walletAddress: gangWallet, side: 'buy', amount: '0.01', slippageBps: 100 });
    assert.equal(trade.kind, balance === 0n ? 'wrap' : 'approve');
    state.quoteAsset = unverifiedQuoteAsset;
    state.simulations.length = 0;
    await assert.rejects(protocol.validateExecution(trade.transaction, { ...trade.summary, kind: trade.kind }), error => error.tradeRisk?.status === 'unknown');
    assert.deepEqual(state.simulations, []);
  }
});

test('Gang unverified quote sale remains available with nominal calldata and unknown recipient net', async () => {
  const { protocol, state } = gangHarness({ balance: E('1000000000'), allowance: E('1000000000'), quoteAsset: unverifiedQuoteAsset });
  const bought = gangBuyQuote(curve, E('1'), null);
  state.c = { ...curve, sold: bought.output, realQuote: E('0.99') };
  const trade = await protocol.buildTrade({ token: gangToken, walletAddress: gangWallet, side: 'sell', amount: String(bought.output / 10n ** 18n), slippageBps: 100 });
  assert.equal(trade.kind, 'sell');
  assert.equal(trade.summary.estimatedReceive, null);
  assert.equal(trade.summary.minReceive, null);
  assert.equal(trade.summary.tradeRisk.estimatedNetOutput, null);
  assert.equal(trade.summary.tradeRisk.minimumNetOutput, null);
  assert.ok(trade.summary.tradeRisk.contractQuotedOutput);
  const parsed = gangInterface.parseTransaction(trade.transaction);
  assert.equal(String(parsed.args[2]), trade.summary.minimumOutputRaw);
  const checked = await protocol.validateExecution(trade.transaction, { ...trade.summary, kind: 'sell' });
  assert.equal(checked.tradeRisk.estimatedNetOutput, null);
  assert.equal(checked.tradeRisk.netAfterGas, null);
  assert.deepEqual(state.simulations, ['sell', 'sell']);
});


test('legacy Gang quotes unfunded buys without wrapping, approval or simulation',async()=>{
 const {protocol,state}=gangHarness();const q=await protocol.quoteTrade({token:gangToken,walletAddress:gangWallet,side:'buy',amount:'0.01',slippageBps:100});
 assert.equal(q.kind,'buy');assert.equal(q.transaction,undefined);assert.equal(q.summary.simulated,undefined);assert.equal(q.summary.phase,'bonding');assert.equal(q.summary.quoteDecimals,18);assert.equal(q.summary.sourceBlock,123);assert.ok(BigInt(q.summary.expectedOutputRaw)>0n);assert.deepEqual(state.simulations,[]);
});
test('legacy Gang preserved minimum survives exact approval and sell calldata',async()=>{
 const {protocol,state}=gangHarness({balance:E('1000'),allowance:E('1000')});const bought=gangBuyQuote(curve,E('1'),null);state.c={...curve,sold:bought.output,realQuote:E('0.99')};const request={token:gangToken,walletAddress:gangWallet,side:'sell',amount:'100',slippageBps:100};
 const guards={minimumOutputRaw:'1',deadline:Math.floor(Date.now()/1000)+90};const q=await protocol.quoteTrade(request,guards),b=await protocol.buildTrade(request,guards);
 assert.equal(q.summary.minimumOutputRaw,'1');assert.equal(b.summary.minimumOutputRaw,'1');assert.equal(gangInterface.parseTransaction(b.transaction).args[2],1n);assert.equal(b.summary.deadline,guards.deadline);
 await protocol.validateExecution(b.transaction,{...b.summary,kind:b.kind});
 await assert.rejects(()=>protocol.quoteTrade(request,{minimumOutputRaw:String(E('1000000000'))}),/最低/);
});

test('guarded legacy Gang quote rejects malformed slippage before any simulation',async()=>{
 const {protocol,state}=gangHarness();await assert.rejects(()=>protocol.quoteTrade({token:gangToken,walletAddress:gangWallet,side:'buy',amount:'0.01',slippageBps:5001},{minimumOutputRaw:'1'}),/滑点/);assert.deepEqual(state.simulations,[]);
});


test('default quote policy failure preserves legacy nominal exits and real execution simulation',async()=>{
 for(const quoteAsset of ['0x3333333333333333333333333333333333333333','0x0c6302401aa5325C2E36F170f52C00B1d220B405']){
  const {protocol,state}=gangHarness({quoteAsset,balance:E('1000'),allowance:E('1000'),useDefaultVerifier:true});const bought=gangBuyQuote(curve,E('1'),null);state.c={...curve,sold:bought.output,realQuote:E('0.99')};
  const i={token:gangToken,walletAddress:gangWallet,side:'sell',amount:'100',slippageBps:100,settlement:'quote'};
  const q=await protocol.quoteTrade(i);assert.equal(q.kind,'sell');assert.equal(q.summary.tradeRisk.estimatedNetOutput,null);assert.deepEqual(state.simulations,[]);
  const b=await protocol.buildTrade(i);assert.equal(b.kind,'sell');assert.equal(b.summary.simulated,true);assert.equal(b.summary.estimatedReceive,null);assert.equal(b.summary.minReceive,null);assert.ok(BigInt(b.summary.expectedOutputRaw)>0n);assert.ok(b.summary.tradeRisk.warnings.some(x=>/转账语义/.test(x)));assert.deepEqual(state.simulations,['sell']);
  await protocol.validateExecution(b.transaction,{...b.summary,kind:b.kind});assert.deepEqual(state.simulations,['sell','sell']);
 }
});
test('default quote policy continues to reject unsupported legacy buys before simulation',async()=>{
 const {protocol,state}=gangHarness({quoteAsset:'0x3333333333333333333333333333333333333333',balance:E('1000'),allowance:E('1000'),useDefaultVerifier:true});await assert.rejects(()=>protocol.quoteTrade({token:gangToken,walletAddress:gangWallet,side:'buy',amount:'0.01',slippageBps:100}),/语义/);assert.deepEqual(state.simulations,[]);
});
