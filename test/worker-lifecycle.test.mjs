import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const capability = 'a'.repeat(64);
async function module() { return import('../src/worker-lifecycle.mjs'); }

test('quiesce closes write admission, pins an in-flight write and only acknowledges after durable checkpoint', async () => {
  const { createWorkerLifecycle } = await module();
  let flushes = 0, disabled = 0;
  const life = createWorkerLifecycle({ capability, read: () => ({ busy: false, pending: false }), flush: async () => { flushes++; }, disable: () => disabled++ });
  const release = life.begin();
  assert.deepEqual(await life.quiesce(), { version: 1, quiesced: false, safe: false });
  const stillAdmitted=life.begin();stillAdmitted();
  assert.equal(flushes, 0); assert.equal(disabled,0,'idle reclamation must not revoke an in-flight live route'); release(); release();
  assert.deepEqual(await life.quiesce(), { version: 1, quiesced: true, safe: true });
  assert.equal(flushes, 1); assert(disabled > 0);
  life.resume(); const done = life.begin(); done();
  life.close(); assert.throws(() => life.resume(), { code: 'WORKER_QUIESCING' });
});

test('unknown lifecycle state, pending/ambiguous orders and checkpoint errors never authorize idle stop', async () => {
  const { createWorkerLifecycle } = await module();
  for (const state of [undefined, {}, { busy: true, pending: false }, { busy: false, pending: true }]) {
    let flushes = 0;
    const life = createWorkerLifecycle({ capability, read: () => state, flush: async () => { flushes++; }, disable() {} });
    assert.equal((await life.quiesce()).safe, false); assert.equal(flushes, 0);
  }
  const failed = createWorkerLifecycle({ capability, read: () => ({ busy: false, pending: false }), flush: async () => { throw Error('disk failure'); }, disable() {} });
  await assert.rejects(failed.quiesce(), /disk failure/);
  assert.throws(() => failed.begin(), { code: 'WORKER_QUIESCING' });
});

test('a resume cannot reopen admission while the durable checkpoint is pending', async () => {
  const { createWorkerLifecycle } = await module();
  let finish, entered; const checkpoint = new Promise(r => { finish = r; }), started = new Promise(r => { entered = r; });
  const life = createWorkerLifecycle({ capability, read: () => ({ busy: false, pending: false }), disable() {}, flush: async () => { entered(); await checkpoint; } });
  const closing = life.quiesce(); await started;
  assert.throws(() => life.resume(), { code: 'WORKER_QUIESCING' }); assert.throws(() => life.begin(), { code: 'WORKER_QUIESCING' });
  finish(); assert.equal((await closing).safe, true);
});

test('a released gateway lease cannot resume over a still-running worker handler, but pending orders remain reconcilable', async () => {
  const { createWorkerLifecycle } = await module();
  let busy = false, pending = true;
  const life = createWorkerLifecycle({ capability, read: () => ({ busy, pending }), disable() {}, flush: async () => {} });
  const finish = life.begin(); assert.throws(() => life.resume(), { code: 'WORKER_OPERATION_BUSY' }); finish();
  busy = true; assert.throws(() => life.resume(), { code: 'WORKER_OPERATION_BUSY' });
  busy = false; assert.equal(life.resume().quiesced, false, 'UNKNOWN needs an explicit reconciliation operation, not a permanent admission deadlock');
});

test('fixed tracking export preserves source and rejects symlink, oversized and credential-bearing journals', async t => {
  const { readTrackingExport } = await module();
  const root = await mkdtemp(join(tmpdir(), 'district9-export-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runtime'), { mode: 0o700 });
  const path = join(root, 'runtime', 'tracking-v1.json');
  const journal = { version: 1, wallets: [{ address: `0x${'1'.repeat(40)}`, note: 'Private owner note', xUrl: null, avatar: null, createdAt: '2026-10-28T00:00:00.000Z' }], events: [], markets: [], preferences: { showAvatars: false }, cursor: 100, replayNeeded: false, status: { state: 'live', updatedAt: '2026-10-28T00:00:00.000Z' } };
  assert.equal(await readTrackingExport({ stateRoot: root, ownerUid: process.getuid() }), null);
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  const exported = await readTrackingExport({ stateRoot: root, ownerUid: process.getuid() });
  assert.equal(exported.wallets[0].note, 'Private owner note'); assert.equal(exported.cursor, 100); assert.equal(exported.preferences.showAvatars, false);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(journal), 'readonly export must preserve original bytes');
  await writeFile(path, JSON.stringify({ ...journal, credentials: 'must-not-export' }));
  await assert.rejects(readTrackingExport({ stateRoot: root, ownerUid: process.getuid() }), { code: 'TRACKING_EXPORT_INVALID' });
  await rm(path); await symlink('/etc/passwd', path);
  await assert.rejects(readTrackingExport({ stateRoot: root, ownerUid: process.getuid() }), { code: 'TRACKING_EXPORT_INVALID' });
  await rm(path); await writeFile(path, 'x'.repeat(8 * 1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(readTrackingExport({ stateRoot: root, ownerUid: process.getuid() }), { code: 'TRACKING_EXPORT_INVALID' });
});
