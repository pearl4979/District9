import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBaw } from '../src/baw.mjs';
import { createTradeService, validateInput } from '../src/trades.mjs';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const EPOCH = 2_000_000_000_000;
const input = { token: TOKEN, side: 'buy', amount: '0.01', slippageBps: 100 };
const transaction = { from: ACCOUNT, to: TOKEN, value: '10000000000000000', data: '0x12345678' };
const envelope = data => ({ stdout: JSON.stringify({ success: true, data }), stderr: '' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const idle = { operation: null, stage: 'idle', startedAt: null, stageStartedAt: null, elapsedMs: 0 };

function adapterHarness() {
  const data = {
    'wallet status': { status: 'CONNECTED' },
    'wallet address': { addresses: [{ binanceChainId: '56', address: ACCOUNT }] },
    'wallet settings': { devMode: { enabled: true, expiresAt: EPOCH + 60_000, balanceExceeded: false } },
    'wallet balance': [],
    'wallet left-quota': { quotaUsed: 0, quotaLeft: 100, dailyLimit: 100, date: '2033-05-18' },
    'contract-call preview': { requestId: 'fresh-preview', expiresAt: EPOCH + 60_000 },
  };
  const calls = [];
  let time = EPOCH;
  const baw = createBaw({ binary: '/fake/baw', now: () => time, run: async (_binary, args) => {
    const key = args.slice(0, 2).join(' ');
    calls.push(key);
    const value = typeof data[key] === 'function' ? await data[key]() : data[key];
    return envelope(value);
  } });
  return { baw, data, calls, advance: ms => { time += ms; } };
}

function serviceHarness({ baw: bawOverrides, protocol: protocolOverrides, journalPath, measured = true } = {}) {
  let elapsed = 0, broadcasts = 0, contextReads = 0;
  const advance = ms => { elapsed += ms; };
  const builtInputs = [];
  const baw = {
    wallet: async () => { throw new Error('display-only wallet query must not enter the execution path'); },
    executionContext: async () => { contextReads++; return { available: true, status: 'CONNECTED', address: ACCOUNT }; },
    preview: async () => ({ requestId: 'original-request', expiresAt: EPOCH + elapsed + 60_000 }),
    execute: async requestId => { assert.equal(requestId, 'original-request'); broadcasts++; return { status: 'PENDING_CONFIRMATION', orderId: 'upstream-order', txHash: null }; },
    ...bawOverrides,
  };
  const protocol = {
    buildTrade: async value => { builtInputs.push(value); return { transaction, summary: { maxPriceImpactBps: value.maxPriceImpactBps }, kind: 'buy' }; },
    validateExecution: async () => {},
    ...protocolOverrides,
  };
  const service = createTradeService({ protocol, baw, liveExecution: true, now: () => EPOCH + elapsed, ...(measured && { performanceNow: () => elapsed }), journalPath });
  return { service, advance, builtInputs, broadcasts: () => broadcasts, contextReads: () => contextReads };
}

test('minimal live execution context completes while a display quota lookup remains pending', async () => {
  const { baw, data, calls } = adapterHarness();
  const quota = deferred();
  data['wallet left-quota'] = () => quota.promise;
  let displayComplete = false;
  const display = baw.wallet().then(value => { displayComplete = true; return value; });
  await tick();
  try {
    const context = await baw.executionContext();
    assert.equal(context.address, ACCOUNT);
    assert.equal(context.status, 'CONNECTED');
    assert.equal(context.devMode.enabled, true);
    assert.equal(Object.hasOwn(context, 'balance'), false);
    assert.equal(Object.hasOwn(context, 'quota'), false);
    assert.equal(displayComplete, false);
    assert.equal(calls.filter(key => key === 'wallet balance').length, 1);
    assert.equal(calls.filter(key => key === 'wallet left-quota').length, 1);
  } finally {
    quota.resolve({ quotaUsed: 0, quotaLeft: 100, dailyLimit: 100, date: '2033-05-18' });
    assert.equal((await display).quota.quotaLeft, 100);
  }
});

test('execution context rereads identity and rejects every unavailable or expired permission state', async () => {
  const { baw, data, calls, advance } = adapterHarness();
  assert.equal((await baw.executionContext()).address, ACCOUNT);
  data['wallet address'].addresses[0].address = TOKEN;
  assert.equal((await baw.executionContext()).address, TOKEN);
  assert.equal(calls.filter(key => key === 'wallet status').length, 2);
  assert.equal(calls.filter(key => key === 'wallet settings').length, 2);
  for (const devMode of [null, { enabled: false, expiresAt: EPOCH + 60_000 }, { enabled: true }, { enabled: true, expiresAt: 'invalid' }, { enabled: true, expiresAt: EPOCH - 1 }, { enabled: true, expiresAt: EPOCH + 60_000, balanceExceeded: true }]) {
    data['wallet settings'] = { devMode };
    await assert.rejects(baw.executionContext(), /Developer Mode/);
  }
  data['wallet settings'] = { devMode: { enabled: true, expiresAt: EPOCH + 1 } };
  advance(1);
  await assert.rejects(baw.executionContext(), /expired/);
  data['wallet status'] = { status: 'UNCONNECTED' };
  await assert.rejects(baw.executionContext(), /connected/);
  data['wallet status'] = { status: 'CONNECTED' };
  data['wallet address'] = { addresses: [] };
  await assert.rejects(baw.executionContext(), /address|account/i);
  assert.equal(calls.some(key => key === 'wallet balance' || key === 'wallet left-quota' || key.startsWith('contract-call')), false);
});

test('trade service binds a default or explicit impact limit and reads fresh minimal context once per operation', async () => {
  const { service, builtInputs, broadcasts, contextReads } = serviceHarness();
  const defaultPreview = await service.preview(input);
  assert.equal(defaultPreview.input.maxPriceImpactBps, 300);
  assert.equal(builtInputs[0].maxPriceImpactBps, 300);
  const preview = await service.preview({ ...input, maxPriceImpactBps: 175 });
  assert.equal(preview.input.maxPriceImpactBps, 175);
  assert.equal(builtInputs[1].maxPriceImpactBps, 175);
  preview.input.maxPriceImpactBps = 500;
  const order = await service.execute({ previewId: preview.id, confirmed: true });
  assert.equal(order.requestId, 'original-request');
  assert.equal(contextReads(), 3);
  assert.equal(broadcasts(), 1);
  for (const maxPriceImpactBps of [49, 501, 100.5, '300', null]) assert.throws(() => validateInput({ ...input, maxPriceImpactBps }), /冲击/);
  for (const maxPriceImpactBps of [50, 500]) assert.doesNotThrow(() => validateInput({ ...input, maxPriceImpactBps }));
});

test('live preview guards and execute independently reject changed accounts or expired Developer Mode', async () => {
  for (const change of ['account', 'expiry']) {
    const { baw, data, calls, advance } = adapterHarness();
    let builds = 0;
    const protocol = { buildTrade: async () => { builds++; return { transaction, summary: {} }; } };
    const service = createTradeService({ baw, protocol, liveExecution: true, now: () => EPOCH });
    const preview = await service.preview(input);
    assert.equal(builds, 1);
    assert.equal(calls.filter(key => key === 'wallet settings').length, 1);
    if (change === 'account') data['wallet address'].addresses[0].address = TOKEN;
    else advance(60_000);
    await assert.rejects(service.execute({ previewId: preview.id, confirmed: true }), /钱包|expired/);
    assert.equal(service.list().length, 0);
    assert.deepEqual(service.progress(), idle);
    assert.equal(calls.some(key => key === 'contract-call execute'), false);
  }
});

test('preview exposes each pending stage and exact monotonic durations without consuming quote TTL in wallet loading', async () => {
  const wallet = deferred(), quote = deferred(), preview = deferred();
  const { service, advance } = serviceHarness({
    baw: { executionContext: () => wallet.promise, preview: () => preview.promise },
    protocol: { buildTrade: () => quote.promise },
  });
  assert.deepEqual(service.progress(), idle);
  const pending = service.preview(input);
  advance(60_000);
  assert.deepEqual(service.progress(), { operation: 'preview', stage: 'wallet-check', startedAt: EPOCH, stageStartedAt: EPOCH, elapsedMs: 60_000 });
  wallet.resolve({ available: true, address: ACCOUNT });
  await tick();
  advance(7);
  assert.equal(service.progress().stage, 'quote-simulation');
  assert.equal(service.progress().stageStartedAt, EPOCH + 60_000);
  quote.resolve({ transaction, summary: {}, kind: 'buy' });
  await tick();
  advance(11);
  const snapshot = service.progress();
  assert.equal(snapshot.stage, 'wallet-preview');
  snapshot.stage = 'idle';
  assert.equal(service.progress().stage, 'wallet-preview');
  preview.resolve({ requestId: 'original-request', expiresAt: EPOCH + 120_000 });
  const result = await pending;
  assert.equal(result.quotedAt, EPOCH + 60_000);
  assert.equal(result.expiresAt, EPOCH + 90_000);
  assert.deepEqual(result.timings, { walletCheckMs: 60_000, quoteSimulationMs: 7, walletPreviewMs: 11, totalMs: 60_018 });
  assert.deepEqual(service.progress(), idle);
});

test('execution reports checks and submission separately while duplicate submits share one original request', async () => {
  const guard = deferred(), submit = deferred();
  let sends = 0;
  const { service, advance } = serviceHarness({
    protocol: { validateExecution: () => guard.promise },
    baw: { execute: async requestId => { assert.equal(requestId, 'original-request'); sends++; return submit.promise; } },
  });
  const preview = await service.preview(input);
  advance(5000); // User confirmation time is excluded from both operation totals.
  const pending = service.execute({ previewId: preview.id, confirmed: true });
  await tick();
  advance(13);
  assert.deepEqual(service.progress(), { operation: 'execute', stage: 'execution-check', startedAt: EPOCH + 5000, stageStartedAt: EPOCH + 5000, elapsedMs: 13 });
  const duplicate = await service.execute({ previewId: preview.id, confirmed: true });
  assert.equal(duplicate.status, 'SUBMITTING');
  guard.resolve();
  await tick();
  advance(19);
  assert.equal(service.progress().stage, 'submission');
  assert.equal(service.progress().stageStartedAt, EPOCH + 5013);
  submit.resolve({ status: 'PENDING_CONFIRMATION', orderId: 'upstream-order', txHash: null });
  const result = await pending;
  assert.equal(result.id, duplicate.id);
  assert.deepEqual(result.timings, {walletCheckMs:0,quoteSimulationMs:0,walletPreviewMs:0,walletAuthorizationMs:0,protocolCheckMs:13,executionCheckMs:13,submissionMs:19,totalMs:32});
  assert.equal(sends, 1);
  assert.deepEqual(service.progress(), idle);
});

test('failed checks reset progress and quote latency still expires before wallet preview', async () => {
  const { service, advance } = serviceHarness({ protocol: { buildTrade: async () => { advance(30_000); return { transaction, summary: {} }; } } });
  await assert.rejects(service.preview(input), /过期/);
  assert.deepEqual(service.progress(), idle);
  assert.equal(service.list().length, 0);
});

test('preview failures clear pending progress and preserve structured protocol risk errors', async () => {
  const risk = { status: 'blocked', blockReasons: ['Impact exceeds selected limit'] };
  const failure = Object.assign(new Error('blocked risk'), { tradeRisk: risk });
  for (const overrides of [
    { baw: { executionContext: async () => { throw failure; } } },
    { protocol: { buildTrade: async () => { throw failure; } } },
    { baw: { preview: async () => { throw failure; } } },
  ]) {
    const { service, broadcasts } = serviceHarness(overrides);
    await assert.rejects(service.preview(input), error => error === failure && error.tradeRisk === risk);
    assert.deepEqual(service.progress(), idle);
    assert.equal(service.list().length, 0);
    assert.equal(broadcasts(), 0);
  }
});

test('unwritable submission journal clears progress and prevents any fake broadcast', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trade-speed-journal-'));
  const journalPath = join(dir, 'orders.json');
  const { service, broadcasts } = serviceHarness({ journalPath });
  try {
    const preview = await service.preview(input);
    mkdirSync(journalPath); // The durable journal cannot replace this directory.
    await assert.rejects(service.execute({ previewId: preview.id, confirmed: true }));
    assert.equal(broadcasts(), 0);
    assert.equal(service.list().length, 0);
    assert.deepEqual(service.progress(), idle);
    await assert.rejects(service.execute({ previewId: preview.id, confirmed: true }), /过期/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('submission timeout records durable UNKNOWN with timings and never resends the request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trade-speed-'));
  const journalPath = join(dir, 'orders.json');
  let sends = 0;
  const { service, advance } = serviceHarness({ journalPath, baw: { execute: async requestId => {
    assert.equal(requestId, 'original-request');
    assert.equal(JSON.parse(readFileSync(journalPath, 'utf8'))[0].status, 'SUBMITTING');
    sends++; advance(23); throw new Error('timeout after possible broadcast');
  } } });
  try {
    const preview = await service.preview(input);
    const order = await service.execute({ previewId: preview.id, confirmed: true });
    assert.equal(order.status, 'UNKNOWN');
    assert.equal(order.requestId, 'original-request');
    assert.deepEqual(order.timings, {walletCheckMs:0,quoteSimulationMs:0,walletPreviewMs:0,walletAuthorizationMs:0,protocolCheckMs:0,executionCheckMs:0,submissionMs:23,totalMs:23});
    assert.deepEqual(service.progress(), idle);
    assert.equal(JSON.parse(readFileSync(journalPath, 'utf8'))[0].status, 'UNKNOWN');
    await service.execute({ previewId: preview.id, confirmed: true });
    const next = await service.preview(input);
    await assert.rejects(service.execute({ previewId: next.id, confirmed: true }), /未完成|未知/);
    assert.equal(sends, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('default timing clock exposes finite nonnegative elapsed numbers', async () => {
  const { service } = serviceHarness({ measured: false });
  const preview = await service.preview(input);
  for (const value of Object.values(preview.timings)) assert.ok(Number.isFinite(value) && value >= 0);
});

test('one fresh internally minted context removes duplicate CLI reads, but cannot be reused or forged', async () => {
  const { baw, data, calls } = adapterHarness();
  const context = await baw.executionContext();
  await baw.preview(transaction, { context });
  assert.equal(calls.filter(x => x === 'wallet settings').length, 1);
  data['wallet settings'] = { devMode: { enabled: false } };
  await assert.rejects(baw.preview(transaction, { context }), /Developer Mode/);
  await assert.rejects(baw.preview(transaction, { context: { ...context } }), /Developer Mode/);
});

test('stale or tampered context cannot hide changed identity or expired permission', async () => {
  for (const mode of ['stale', 'expired', 'tampered']) {
    const { baw, data, advance } = adapterHarness();
    const context = await baw.executionContext();
    if (mode === 'expired') advance(60_000);
    else {
      data['wallet address'].addresses[0].address = TOKEN;
      if (mode === 'stale') advance(5001);
      else context.address = TOKEN;
    }
    await assert.rejects(baw.preview(transaction, { context }), /address|expired|account/i);
  }
});

for (const receiptStatus of [1, 0]) {
  test(`chain timing preserves first mining observation and records policy completion for receipt status ${receiptStatus}`, async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    let confirmations = 1;
    let hasReceipt = false;
    const provider = {
      getTransactionReceipt: async () => hasReceipt ? { hash, blockHash: hash, blockNumber: 100, status: receiptStatus } : null,
      getNetwork: async () => ({ chainId: 56n }),
      getTransaction: async () => ({ ...transaction, hash, chainId: 56n, blockNumber: 100, blockHash: hash }),
      getBlock: async () => ({ number: 100, hash }),
      getBlockNumber: async () => 99 + confirmations,
    };
    const { service, advance } = serviceHarness({
      protocol: { provider, validateExecution: async () => { advance(100); } },
      baw: { execute: async () => { advance(25); return { status: 'BROADCASTED', txHash: hash }; } },
    });
    const preview = await service.preview(input);
    const order = await service.execute({ previewId: preview.id, confirmed: true });
    assert.equal(order.createdAt, new Date(EPOCH).toISOString());
    assert.equal(order.submittedAt, new Date(EPOCH + 125).toISOString());
    assert.equal(Object.hasOwn(order, 'minedAt'), false);
    assert.equal(Object.hasOwn(order, 'confirmedAt'), false);
    assert.equal(Object.hasOwn(order.timings, 'confirmationWaitMs'), false);
    advance(1000);
    await service.refresh();
    assert.equal(Object.hasOwn(service.list()[0], 'minedAt'), false);
    hasReceipt = true;
    await service.refresh();
    let latest = service.list()[0];
    assert.equal(latest.status, 'MINED');
    assert.equal(latest.minedAt, new Date(EPOCH + 1125).toISOString());
    assert.equal(latest.timings.confirmationWaitMs, 1000);
    assert.equal(Object.hasOwn(latest, 'confirmedAt'), false);
    advance(2000);
    confirmations = 2;
    await service.refresh();
    latest = service.list()[0];
    assert.equal(latest.minedAt, new Date(EPOCH + 1125).toISOString());
    assert.equal(latest.timings.confirmationWaitMs, 3000);
    assert.equal(Object.hasOwn(latest, 'confirmedAt'), false);
    advance(1000);
    confirmations = 3;
    await service.refresh();
    latest = service.list()[0];
    assert.equal(latest.status, receiptStatus === 1 ? 'CONFIRMED' : 'REVERTED');
    assert.equal(latest.confirmedAt, new Date(EPOCH + 4125).toISOString());
    assert.equal(latest.timings.confirmationWaitMs, 4000);
    advance(9000);
    await service.refresh();
    assert.deepEqual(service.list()[0], latest);
    assert.deepEqual(service.progress(), idle);
  });
}

test('wallet pending and UNKNOWN responses receive response time without fabricated chain timestamps', async () => {
  for (const status of ['PENDING_CONFIRMATION', 'UNKNOWN']) {
    const { service, advance } = serviceHarness({
      protocol: { provider: { getTransactionReceipt: async () => { throw new Error('No chain hash should be polled'); } } },
      baw: { execute: async () => { advance(25); return { status, txHash: null }; } },
    });
    const preview = await service.preview(input);
    const order = await service.execute({ previewId: preview.id, confirmed: true });
    assert.equal(order.status, status);
    assert.equal(order.submittedAt, new Date(EPOCH + 25).toISOString());
    advance(5000);
    await service.refresh();
    const latest = service.list()[0];
    assert.equal(Object.hasOwn(latest, 'minedAt'), false);
    assert.equal(Object.hasOwn(latest, 'confirmedAt'), false);
    assert.equal(Object.hasOwn(latest.timings, 'confirmationWaitMs'), false);
  }
  const { service } = serviceHarness({ baw: { execute: async () => { throw new Error('timeout'); } } });
  const preview = await service.preview(input);
  const order = await service.execute({ previewId: preview.id, confirmed: true });
  assert.equal(order.status, 'UNKNOWN');
  assert.equal(Object.hasOwn(order, 'submittedAt'), false);
  assert.equal(Object.hasOwn(order, 'minedAt'), false);
  assert.equal(Object.hasOwn(order, 'confirmedAt'), false);
});
