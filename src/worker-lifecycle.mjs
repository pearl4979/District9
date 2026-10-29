import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWalletTracking } from './wallet-tracking.mjs';
import { sanitizeMarketSnapshot } from './snapshot-stream.mjs';
import { normalizeEventValuation } from './event-valuation.mjs';
import { isMainModule } from './main-module.mjs';

export const TRACKING_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/, ADDRESS = /^0x[\da-f]{40}$/i;
const failure = (code, message) => Object.assign(Error(message), { code });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => failure('TRACKING_EXPORT_INVALID', 'Tracking journal is unavailable or invalid');

// The only authority returned is a durable boolean. No journal, auth or capability
// detail is included. Quiesce closes admission synchronously before any await.
export function createWorkerLifecycle({ capability, read, flush, disable } = {}) {
  if (!HEX.test(capability ?? '') || ![read, flush, disable].every(fn => typeof fn === 'function')) throw Error('Invalid worker lifecycle configuration');
  let active = 0, closing = false, stopped = false, checkpointed = false, pending;
  const closed = () => failure('WORKER_QUIESCING', 'Private worker is quiescing');
  function available() {
    try { const state = read(); return object(state) && state.busy === false && state.pending === false && active === 0; }
    catch { return false; }
  }
  const result = safe => ({ version: 1, quiesced: closing, safe });
  return {
    authorize(value) { return typeof value === 'string' && HEX.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(capability)); },
    begin() { if (closing || stopped) throw closed(); if (active >= 64) throw failure('WORKER_OPERATION_BUSY', 'Private worker is busy'); active++; let released = false; return () => { if (!released) { released = true; active--; } }; },
    status() { return result(closing && checkpointed && available()); },
    async quiesce() {
      const wasClosing = closing;
      closing = true;
      // A failed idle-reclaim attempt must leave an active owner able to turn
      // off execution. Keep an existing checkpoint/closing barrier intact.
      if (!available()) { closing = wasClosing; return result(false); }
      disable();
      if (checkpointed) return result(true);
      pending ||= Promise.resolve().then(flush).then(() => { checkpointed = true; }).finally(() => { pending = null; });
      await pending;
      return result(checkpointed && available());
    },
    resume() {
      if (stopped || pending) throw closed();
      const state = read();
      if (active || state?.busy !== false || typeof state?.pending !== 'boolean') throw failure('WORKER_OPERATION_BUSY', 'Private worker is still processing an operation');
      closing = false; checkpointed = false; return result(false);
    },
    close() { stopped = true; closing = true; checkpointed = false; disable(); },
  };
}

// Narrow DTO gate. Only the original tracking schema can cross into the view
// store. Market sanitization strips private/implementation keys; event fields
// are an explicit allowlist, and unknown root fields fail closed.
export async function normalizeTrackingExport(raw) {
  if (raw === null) return null;
  const allowed = new Set(['version', 'wallets', 'events', 'markets', 'preferences', 'cursor', 'replayNeeded', 'status']);
  if (!object(raw) || Object.keys(raw).some(k => !allowed.has(k)) || raw.version !== 1 || !Array.isArray(raw.wallets) || raw.wallets.length > 100 || !Array.isArray(raw.events) || raw.events.length > 1000 || !Array.isArray(raw.markets) || raw.markets.length > 2000 || !object(raw.preferences) || typeof raw.preferences.showAvatars !== 'boolean' || raw.cursor !== null && !integer(raw.cursor) || raw.replayNeeded !== undefined && typeof raw.replayNeeded !== 'boolean') throw invalid();
  try {
    const seedWallets = raw.wallets.map(w => {
      if (!object(w) || Object.keys(w).some(k => !['address', 'note', 'xUrl', 'avatar', 'createdAt'].includes(k)) || !Number.isFinite(Date.parse(w.createdAt))) throw invalid();
      return { address: w.address, note: w.note, xUrl: w.xUrl, avatar: w.avatar };
    });
    const tracking = createWalletTracking({ seedWallets }); await tracking.ready;
    const normalized = await tracking.snapshot(); tracking.stop();
    const wallets = normalized.wallets.map((w, i) => ({ ...w, createdAt: new Date(raw.wallets[i].createdAt).toISOString() }));
    if (new Set(wallets.map(w => w.address.toLowerCase())).size !== wallets.length) throw invalid();
    const watched = new Set(wallets.map(w => w.address.toLowerCase()));
    const markets = sanitizeMarketSnapshot({ tokens: raw.markets, monitor: {} }, 2000, TRACKING_EXPORT_MAX_BYTES).tokens;
    const eventFields = new Set(['id', 'walletAddress', 'tokenAddress', 'assetAddress', 'platformId', 'phase', 'side', 'timestamp', 'blockNumber', 'transactionIndex', 'logIndex', 'txHash', 'blockHash', 'tokenSymbol', 'tokenName', 'tokenAmount', 'quoteAmount', 'quoteSymbol', 'price', 'priceUnit', 'source', 'confirmed', 'demo', 'valuation', 'evidence']);
    const events = raw.events.map(e => {
      if (!object(e) || Object.keys(e).some(k => !eventFields.has(k)) || typeof e.id !== 'string' || e.id.length > 256 || !ADDRESS.test(e.walletAddress ?? '') || !watched.has(e.walletAddress.toLowerCase()) || !ADDRESS.test(e.tokenAddress ?? '') || !/^0x[\da-f]{64}$/i.test(e.txHash ?? '') || !integer(e.blockNumber) || !integer(e.logIndex) || e.confirmed !== true || e.demo === true || !['four', 'flap', 'gang'].includes(e.platformId) || !['buy', 'sell', 'transfer-in', 'transfer-out'].includes(e.side) || !Number.isFinite(Date.parse(e.timestamp))) throw invalid();
      const out = {};
      for (const [key, value] of Object.entries(e)) {
        if (key === 'valuation') continue;
        if (typeof value === 'string' && value.length <= 1024 || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) out[key] = value;
        else throw invalid();
      }
      out.valuation = normalizeEventValuation(e.valuation, e); return out;
    });
    const status = {};
    for (const key of ['state', 'message', 'updatedAt', 'coverage', 'lastBlock', 'coveredFromBlock', 'lagBlocks']) {
      const value = raw.status?.[key];
      if (typeof value === 'string' && value.length <= 2048 || integer(value) || value === null) status[key] = value;
    }
    const dto = { version: 1, wallets, events, markets, preferences: { showAvatars: raw.preferences.showAvatars }, cursor: raw.cursor, replayNeeded: raw.replayNeeded === true, status };
    if (Buffer.byteLength(JSON.stringify(dto)) > TRACKING_EXPORT_MAX_BYTES) throw invalid();
    return dto;
  } catch { throw invalid(); }
}

// Constructor paths are test dependencies. Production CLI takes no path option:
// it reads exactly this one file from the single readonly mounted owner volume.
export async function readTrackingExport({ stateRoot = '/state', ownerUid = process.getuid() } = {}) {
  if (resolve(stateRoot) !== stateRoot) throw invalid();
  try {
    for (const path of [stateRoot, join(stateRoot, 'runtime')]) {
      const s = await lstat(path);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== ownerUid || (s.mode & 0o077)) throw invalid();
    }
    const file = await open(join(stateRoot, 'runtime', 'tracking-v1.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await file.stat();
      if (!s.isFile() || s.uid !== ownerUid || (s.mode & 0o777) !== 0o600 || s.size > TRACKING_EXPORT_MAX_BYTES) throw invalid();
      const raw = await file.readFile('utf8');
      if (Buffer.byteLength(raw) > TRACKING_EXPORT_MAX_BYTES) throw invalid();
      return await normalizeTrackingExport(JSON.parse(raw));
    } finally { await file.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw invalid(); }
}

if (isMainModule(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--export-tracking') throw invalid();
  const deadline = setTimeout(() => process.exit(1), 5000);
  readTrackingExport().then(tracking => { process.stdout.write(JSON.stringify({ tracking })); }).catch(() => { process.stderr.write('Tracking export unavailable\n'); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
}
