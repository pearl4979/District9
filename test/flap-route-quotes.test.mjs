import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { Interface, ZeroAddress, keccak256, parseEther as E } from 'ethers';
import { createFlapProtocol } from '../src/flap.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const MARKET = address(1), WALLET = address(2), PROBE = address(3), QUOTE = address(4);
const NOW = 1793139000000;
const probe = new Interface(['function assetProbe()', 'function buyCapacityProbe()', 'function buyPlanProbe(uint256,uint256)', 'function quoteBuyProbe(uint256)', 'function positionProbe()', 'function sellPlanCustomProbe(uint256,uint256)', 'function quoteFundingProbe(uint256)', 'error Error(string)']);
const portal = new Interface(['function buy(address,uint256) payable', 'function buyWithQuote(address,uint256,uint256)', 'function sellBps(address,uint256,uint256)']);
const input = (side = 'buy', amount = '1') => ({ token: MARKET, side, amount, walletAddress: WALLET, slippageBps: 50, maxPriceImpactBps: 300, ...(side === 'sell' ? { sellPercentBps: 2500 } : {}) });

function fixture({ native = false, verified = false } = {}) {
  const code = '0x6001';
  const pin = n => ({ address: address(n), implementation: address(n + 1), codeHash: keccak256(code) });
  const config = { factory: address(10), reader: address(11), portal: address(12), flapPortal: address(13), marketBeacon: pin(20), probeBeacon: pin(30), quoteAssets: [{ address: native ? ZeroAddress : QUOTE, symbol: native ? 'BNB' : 'QQQB', decimals: 18 }] };
  const quoteAsset = config.quoteAssets[0].address;
  const detail = { market: MARKET, quoteToken: quoteAsset, quoteDecimals: 18n, phase: 1n, capRaw: E('100'), totalShares: E('100'), creator: address(40), token: ZeroAddress, predictedToken: address(41), pair: ZeroAddress, statsComplete: false, quoteBalanceKnown: true, quoteBalanceRaw: E('10'), quoteBackingEnough: true, inventoryKnown: true, inventoryEnough: true };
  const settings = { launch: { name: 'Shares', symbol: 'SHR', meta: '', beneficiary: address(40), buyTaxRate: 0n, sellTaxRate: 0n, mktBps: 10000n, deflationBps: 0n, dividendBps: 0n, lpBps: 0n }, curveH: E('100'), curveK: E('1000000') };
  const state = { now: NOW, funding: false, allowance: false, nativeBalance: 0n, held: E('100'), output: E('1000'), minimum: E('995'), agent: true, probeAddress: PROBE, badAsset: false };
  const sample=verified?JSON.parse(readFileSync(new URL('./fixtures/flap-buy-quotes-20261029.json',import.meta.url))).rows[native?0:1]:null;
  if(sample){const ints=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==='string'&&/^\d+$/.test(v)?BigInt(v):v]));Object.assign(detail,ints(sample.detail),{market:MARKET,quoteToken:quoteAsset});Object.assign(settings,ints(sample.settings),{launch:settings.launch});}
  const quoteFor=amount=>sample?[sample.full,sample.reference].find(q=>E(q.amount)===amount)?.fields:null;
  const effects = { fundingReads: 0, simulationCalls: 0, balanceReads: 0, allowanceReads: 0, probes: [] };
  const read = async (target, _abi, method) => {
    if (method === 'factory') return config.factory;
    if (method === 'marketBeacon') return config.marketBeacon.address;
    if (method === 'probeBeacon') return config.probeBeacon.address;
    if (method === 'flapPortal') return config.flapPortal;
    if (method === 'implementation') return target === config.marketBeacon.address ? config.marketBeacon.implementation : config.probeBeacon.implementation;
    if (method === 'isMarket') return true;
    if (method === 'portal') return config.portal;
    if (method === 'probeOfMarket') return state.probeAddress;
    if (method === 'market') return MARKET;
    if (method === 'marketDetail') return detail;
    if (method === 'marketSettings') return settings;
    if (method === 'balanceOf') { effects.balanceReads++; return state.funding ? E('100') : 0n; }
    if (method === 'allowance') { effects.allowanceReads++; return state.allowance ? E('100') : 0n; }
    throw Error(`Unexpected read ${target} ${method}`);
  };
  const provider = { getNetwork: async () => ({ chainId: 56n }), getCode: async () => code, getBlockNumber: async () => 100,
    getBalance: async () => { effects.balanceReads++; return state.nativeBalance; }, estimateGas: async () => 100000n, getFeeData: async () => ({ gasPrice: 1000000000n }),
    call: async tx => {
      if (tx.to.toLowerCase() !== PROBE.toLowerCase()) { effects.simulationCalls++; return '0x'; }
      const decoded = probe.parseTransaction(tx); effects.probes.push(decoded);
      let fields;
      if (decoded.name === 'assetProbe') fields = `MARKET=${MARKET};QUOTE=${state.badAsset ? address(99) : quoteAsset};DECIMALS=18`;
      if (decoded.name === 'buyCapacityProbe') fields = `ROOM_SHARES=10000000000000000000000;ID=${state.agent ? 1 : 0};PHASE=1`;
      if (decoded.name === 'buyPlanProbe') {const q=quoteFor(decoded.args[0]);fields = `MIN_SHARES=${q?BigInt(q.SHARES)*9950n/10000n:state.minimum};BUY_SHARES=${q?.SHARES??state.output};RULES_OK=1;BLOCK=100`;}
      if (decoded.name === 'quoteBuyProbe') {const q=quoteFor(decoded.args[0]),suffix=native?'WEI':'RAW';fields=`SHARES=${q?.SHARES??state.output};ACCEPT_${suffix}=${q?.['ACCEPT_'+suffix]??decoded.args[0]};FEE_${suffix}=${BigInt(q?.['FEE_'+suffix]??decoded.args[0]/100n)+(state.badFee?1000000000000n:0n)};REFUND_${suffix}=${q?.['REFUND_'+suffix]??0};BLOCK=${state.badQuoteBlock?99:100}`;}
      if (decoded.name === 'positionProbe') fields = `HELD_SHARES=${state.held};SELL_OK=1;PHASE=1;BLOCK=100`;
      if (decoded.name === 'sellPlanCustomProbe') fields = `SHARES=${state.held * decoded.args[0] / 10000n};OUT_${native ? 'WEI' : 'RAW'}=${state.output};MIN_${native ? 'WEI' : 'RAW'}=${state.minimum};BLOCK=100`;
      if (decoded.name === 'quoteFundingProbe') { effects.fundingReads++; fields = `BALANCE_OK=${state.funding ? 1 : 0};ALLOWANCE_OK=${state.allowance ? 1 : 0};BLOCK=100`; }
      throw Object.assign(Error('Probe result'), { data: probe.encodeErrorResult('Error', [`${fields};END`]) });
    } };
  return { protocol: createFlapProtocol({ provider, read, config, now: () => state.now }), state, detail, effects,settings };
}

test('unfunded stock-quote buy exposes an estimate and risk without checking funding or simulating', async () => {
  const h = fixture();
  assert.equal(typeof h.protocol.quoteTrade, 'function');
  const result = await h.protocol.quoteTrade(input());
  assert.equal(result.kind, 'buy');
  assert.equal(result.transaction, undefined);
  assert.notEqual(result.summary.simulated, true);
  assert.equal(result.summary.expectedOutputRaw, '1000000000000000000000');
  assert.equal(result.summary.phase, 'bonding');
  assert.equal(result.summary.positionKind, 'shares');
  assert.equal(result.summary.quoteAsset, QUOTE);
  assert.equal(result.summary.quoteDecimals, 18);
  assert.equal(result.summary.tradeRisk.status, 'unknown');
  assert.deepEqual([h.effects.fundingReads, h.effects.simulationCalls, h.effects.balanceReads, h.effects.allowanceReads], [0, 0, 0, 0]);
});

test('share sell quotes use the exact wallet ledger percentage rather than ERC20 token balances', async () => {
  const h = fixture();
  assert.equal(typeof h.protocol.quoteTrade, 'function');
  const result = await h.protocol.quoteTrade(input('sell', '25'));
  assert.equal(result.summary.inputRaw, '25000000000000000000');
  assert.equal(result.summary.positionBalanceRaw, '100000000000000000000');
  assert.equal(result.summary.sellPercentBps, 2500);
  assert.equal(h.effects.probes.find(call => call.name === 'sellPlanCustomProbe').args[0], 2500n);
  await assert.rejects(() => h.protocol.quoteTrade(input('sell', '24')), /份额已变化/);
  await assert.rejects(() => h.protocol.quoteTrade({ ...input('sell', '25'), sellPercentBps: undefined }), /精确百分比/);
  assert.equal(h.effects.balanceReads, 0);
  assert.equal(h.effects.simulationCalls, 0);
});

test('quote-only preparation preserves Agent ID, phase and Probe asset binding checks', async () => {
  const h = fixture();
  assert.equal(typeof h.protocol.quoteTrade, 'function');
  h.state.agent = false;
  await assert.rejects(() => h.protocol.quoteTrade(input()), /Agent ID/);
  h.state.agent = true; h.state.badAsset = true;
  await assert.rejects(() => h.protocol.quoteTrade(input()), /资产绑定不匹配/);
  h.state.badAsset = false; h.detail.phase = 3n;
  await assert.rejects(() => h.protocol.quoteTrade(input()), /已发射/);
});

test('quote guards retain stricter original minimum and deadline while refusing impossible or expired routes', async () => {
  const h = fixture();
  assert.equal(typeof h.protocol.quoteTrade, 'function');
  const guards = { minimumOutputRaw: '998000000000000000000', deadline: NOW / 1000 + 120 };
  let result = await h.protocol.quoteTrade(input(), guards);
  assert.equal(result.summary.minimumOutputRaw, guards.minimumOutputRaw);
  assert.equal(result.summary.deadline, guards.deadline);
  result = await h.protocol.quoteTrade(input(), { minimumOutputRaw: '990000000000000000000' });
  assert.equal(result.summary.minimumOutputRaw, '995000000000000000000');
  await assert.rejects(() => h.protocol.quoteTrade(input(), { minimumOutputRaw: '1001000000000000000000' }), /最低收到/);
  await assert.rejects(() => h.protocol.quoteTrade(input(), { deadline: NOW / 1000 }), /期限|过期/);
});


test('execution retains the guarded minimum in calldata and requires real BNB gas funding', async () => {
  const h = fixture();
  await assert.rejects(() => h.protocol.buildTrade(input('sell', '25')), /BNB 余额不足/);
  h.state.nativeBalance = E('1');
  const guards = { minimumOutputRaw: '998000000000000000000', deadline: NOW / 1000 + 120 };
  const built = await h.protocol.buildTrade(input('sell', '25'), guards);
  const decoded = portal.parseTransaction(built.transaction);
  assert.equal(decoded.name, 'sellBps');
  assert.equal(decoded.args[1], 2500n);
  assert.equal(decoded.args[2], 998000000000000000000n);
  assert.equal(built.summary.minimumOutputRaw, guards.minimumOutputRaw);
  assert.equal(built.summary.simulated, true);
  assert.equal(built.summary.positionKind, 'shares');
  assert.equal(built.summary.deadline, guards.deadline);
});

test('an unfunded or funded buy cannot bypass the existing unknown Flap buy-risk gate', async () => {
  const h = fixture();
  await assert.rejects(() => h.protocol.buildTrade(input()), /买入风险检查未通过/);
  h.state.nativeBalance = E('1'); h.state.funding = true; h.state.allowance = true;
  await assert.rejects(() => h.protocol.buildTrade(input()), /买入风险检查未通过/);
  assert.equal(h.effects.simulationCalls, 0);
  h.detail.quoteBackingEnough = false;
  const quote = await h.protocol.quoteTrade(input());
  assert.equal(quote.summary.tradeRisk.status, 'blocked');
  assert.ok(quote.summary.tradeRisk.blockReasons.some(reason => /背书不足/.test(reason)));
});

test('execution validation stops a guarded trade after its original route deadline', async () => {
  const h = fixture(); h.state.nativeBalance = E('1');
  const built = await h.protocol.buildTrade(input('sell', '25'), { deadline: NOW / 1000 + 120 });
  h.state.now = NOW + 120000;
  const priorSimulations = h.effects.simulationCalls;
  await assert.rejects(() => h.protocol.validateExecution(built.transaction, { ...built.summary, kind: built.kind }), /期限|过期/);
  assert.equal(h.effects.simulationCalls, priorSimulations);
});

test('verified native inner buy passes real calldata simulation and current risk revalidation',async()=>{
 const h=fixture({native:true,verified:true});h.state.nativeBalance=E('1');const request=input('buy','0.01');
 const built=await h.protocol.buildTrade(request),decoded=portal.parseTransaction(built.transaction);
 assert.equal(built.kind,'buy');assert.equal(built.summary.tradeRisk.status,'ok');assert.equal(built.summary.simulated,true);assert.equal(decoded.name,'buy');assert.equal(built.transaction.value,String(E('0.01')));assert.equal(decoded.args[1],BigInt(built.summary.minimumOutputRaw));
 assert.equal(built.summary.tradeRisk.inventoryScope,'unminted-ledger-shares');assert.equal(built.summary.estimatedProbeFee,'0.0001');
 assert.equal((await h.protocol.validateExecution(built.transaction,{...built.summary,kind:'buy'})).tradeRisk.status,'ok');assert.ok(h.effects.simulationCalls>=2);
 h.state.badFee=true;await assert.rejects(()=>h.protocol.validateExecution(built.transaction,{...built.summary,kind:'buy'}),/买入风险/);
});

test('verified ERC20 inner buy still requires full funding and exact approval before simulated buy',async()=>{
 const h=fixture({verified:true});h.state.nativeBalance=E('1');const request=input('buy','0.1');
 await assert.rejects(()=>h.protocol.buildTrade(request),/余额不足/);h.state.funding=true;
 const approval=await h.protocol.buildTrade(request);assert.equal(approval.kind,'approve');assert.equal(approval.summary.approvalAmountRaw,String(E('0.1')));assert.equal(approval.transaction.value,'0');
 h.state.allowance=true;const buy=await h.protocol.buildTrade(request),decoded=portal.parseTransaction(buy.transaction);assert.equal(buy.kind,'buy');assert.equal(decoded.name,'buyWithQuote');assert.equal(decoded.args[1],E('0.1'));assert.equal(buy.transaction.value,'0');assert.equal(buy.summary.tradeRisk.status,'ok');
});

test('mixed quote blocks and unknown curve models remain blocked without simulation',async()=>{
 const h=fixture({native:true,verified:true});h.state.nativeBalance=E('1');h.state.badQuoteBlock=true;
 await assert.rejects(()=>h.protocol.buildTrade(input('buy','0.01')),/区块不一致/);assert.equal(h.effects.simulationCalls,0);
 h.state.badQuoteBlock=false;h.settings.curveType=999n;await assert.rejects(()=>h.protocol.buildTrade(input('buy','0.01')),/买入风险/);assert.equal(h.effects.simulationCalls,0);
});
