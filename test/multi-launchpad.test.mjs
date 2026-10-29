import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { gangBuyQuote, gangSellQuote } from '../src/gang.mjs';
import { parseProbe, enumerateFlapMarkets } from '../src/flap.mjs';
import { createMarketRouter, createMarketHub } from '../src/market-hub.mjs';
import { createFourMarketSource } from '../src/four-market.mjs';
import { createTradeService } from '../src/trades.mjs';

const unit = 10n ** 18n;
const token = '0x0000000000000000000000000000000000000001';
const curve = { virtualQuote: 5n * unit, realQuote: 0n, sold: 0n, gradAmt: 15n * unit };

test('Gang V2 quotes conserve gross budget and cap the output with exact refund', () => {
  const budget = unit;
  const quote = gangBuyQuote(curve, budget, 10_000_000n * unit);
  assert.equal(quote.output, 10_000_000n * unit);
  assert.equal(quote.spent + quote.refund, budget);
  assert.equal(quote.fee, quote.spent / 100n);
  assert.ok(quote.refund > 0n);
  const full = gangBuyQuote(curve, 1000n * unit, null);
  assert.ok(full.spent < 1000n * unit);
  assert.ok(full.output > 0n);
  assert.throws(() => gangBuyQuote(curve, budget, 0n), /上限/);
});

test('Gang sell quote is fee inclusive and rejects invalid reserves', () => {
  const bought = gangBuyQuote(curve, unit / 100n, null);
  const after = { ...curve, sold: bought.output, realQuote: bought.spent - bought.fee };
  const sold = gangSellQuote(after, bought.output);
  assert.ok(sold.output > 0n && sold.output < bought.spent);
  assert.equal(sold.output + sold.fee, sold.gross);
  assert.throws(() => gangSellQuote(after, bought.output + 1n), /份额|数量/);
});

test('Flap reads complete Solidity Error strings, including zero values; rejects missing and duplicate fields', () => {
  const abi = new Interface(['error Error(string)']);
  const data = abi.encodeErrorResult('Error', ['SHARES=123;OUT_RAW=0;MIN_RAW=0;BLOCK=130000000;END']);
  assert.equal(parseProbe(data, ['SHARES', 'OUT_RAW', 'MIN_RAW', 'BLOCK']).OUT_RAW, '0');
  for (const reason of ['SHARES=1;OUT_RAW=1', 'SHARES=1;SHARES=2;END', 'NO_SHARES', 'SHARES=1;END;OUT_RAW=1', 'X=0;END']) {
    assert.throws(() => parseProbe(abi.encodeErrorResult('Error', [reason]), ['SHARES']));
  }
});

test('Flap discovery respects the Reader 16-market page limit and checks complete pagination', async () => {
  const requested = [];
  const readPage = async (cursor, limit) => {
    requested.push([cursor, limit]);
    assert.ok(limit <= 16n);
    return { marketAddresses: Array.from({ length: Number(limit) }, (_, i) => `market-${cursor + BigInt(i)}`), nextCursor: cursor + limit, total: 88n };
  };
  const result = await enumerateFlapMarkets(readPage, 88n);
  assert.equal(result.addresses.length, 88);
  assert.equal(requested.length, 6);
  await assert.rejects(enumerateFlapMarkets(async () => ({ marketAddresses: [], nextCursor: 16n }), 88n), /不完整/);
});

test('routing uses verified membership and rejects client platform spoofing and ambiguous addresses', async () => {
  const calls = [];
  const providers = Object.fromEntries(['four', 'gang', 'flap'].map(id => [id, { buildTrade: async input => { calls.push(id); return { kind: 'buy', summary: { token: input.token }, transaction: {} }; } }]));
  let rows = [{ address: token, platformId: 'flap', verified: true, tradable: true }];
  const router = createMarketRouter({ providers, snapshot: () => ({ tokens: rows }) });
  await assert.rejects(router.buildTrade({ token, platformId: 'gang' }), /平台/);
  assert.equal(calls.length, 0);
  const built = await router.buildTrade({ token, platformId: 'flap' });
  assert.deepEqual(calls, ['flap']);
  assert.equal(built.summary.platformId, 'flap');
  rows = [...rows, { ...rows[0], platformId: 'four' }];
  await assert.rejects(router.buildTrade({ token }), /多个/);
});

test('platform failure leaves other markets live and marks failed-source cached rows non-tradable', async () => {
  let fails = false;
  const hub = createMarketHub({ sources: {
    gang: { load: async () => { if (fails) throw new Error('indexer down'); return { tokens: [{ address: token, verified: true, tradable: true }], message: 'ok' }; } },
    flap: { load: async () => ({ tokens: [{ address: '0x0000000000000000000000000000000000000002', verified: true, tradable: true }], message: 'ok' }) },
  }, pollMs: 100000 });
  try {
    await hub.refresh(); fails = true; await hub.refresh();
    const data = hub.snapshot();
    assert.equal(data.tokens.find(t => t.platformId === 'flap').tradable, true);
    assert.equal(data.tokens.find(t => t.platformId === 'gang').tradable, false);
    assert.equal(data.monitor.sources.find(s => s.id === 'gang').status, 'error');
    assert.equal(data.monitor.status, 'degraded');
  } finally { hub.stop(); }
});

test('Four official search is candidate discovery only; chain membership and confirmed block remain mandatory', async () => {
  const calls = [];
  const protocol = {
    initialize: async () => {}, provider: { getBlockNumber: async () => 130000000 },
    getTokenState: async (address, options) => { calls.push(options.blockTag); if (address.endsWith('2')) throw new Error('wrong preset'); return { address, verified: true, tradable: true, createBlock: 129999990 }; },
  };
  const source = createFourMarketSource({ protocol, search: async () => ({ code: 0, data: [{ tokenAddress: token }, { tokenAddress: token.slice(0, -1) + '2' }] }) });
  const result = await source.load();
  assert.equal(result.tokens.length, 1);
  assert.equal(result.unavailable, 1);
  assert.deepEqual(calls, [129999995, 129999995]);
  const outage = createFourMarketSource({ protocol, search: async () => ({ code: -1, data: [] }) });
  await assert.rejects(outage.load(), /索引/);
});

test('wallet seconds and numeric-string expiry both cap the local preview lifetime', async () => {
  const now = 1793073600000;
  for (const expiresAt of [1793073610, '1793073610000']) {
    const service = createTradeService({ now: () => now, demo: true, protocol: { buildTrade: async () => ({ transaction: {}, summary: {} }) }, baw: { wallet: async () => ({ available: true, address: token }), preview: async () => ({ requestId: 'test', expiresAt }) } });
    const preview = await service.preview({ token, side: 'buy', amount: '0.01', slippageBps: 50 });
    assert.equal(preview.expiresAt, now + 10000);
  }
});
