import { same, check, messageOf } from './market-utils.mjs';
import { enrichMarketMetrics } from './market-metrics.mjs';
import { manifest } from './protocol.mjs';

export const PLATFORMS = {
  four: { id: 'four', name: 'Four.meme', logo: '/assets/platform-four.svg', url: 'https://four.meme/zh-TW/contract/1778027615735' },
  gang: { id: 'gang', name: 'Gang', logo: '/assets/platform-gang.svg', url: 'https://gang.fun/' },
  flap: { id: 'flap', name: 'Flap', logo: '/assets/platform-flap.svg', url: 'https://flap.sh/apps/agent-bonding-curve?lang=zh' },
};

// 客户端不能选择任意目标合约。来源从已验证行情中解析，再交由对应适配器复核。
export function createMarketRouter({ providers, snapshot, provider } = {}) {
  async function resolve(token, requested, requireTradable = true) {
    const rows = (await snapshot()).tokens.filter(t => t.verified === true && same(t.address, token));
    check(rows.length === 1, rows.length > 1 ? '此地址属于多个市场，禁止模糊路由' : '当前没有此地址的已核验市场');
    const row = rows[0], id = row.platformId || 'four';
    check(!requested || requested === id, '请求平台与已核验归属不一致');
    check(providers[id], '此平台未接入');
    check(!requireTradable || row.tradable !== false, row.reason || '当前市场不可交易');
    return { row, id, protocol: providers[id] };
  }
  return {
    provider: provider || providers.four?.provider || Object.values(providers)[0]?.provider,
    async preparationKey(input) {
      const { row, id } = await resolve(input.token, input.platformId);
      return JSON.stringify([id, row.address.toLowerCase(), row.phase, row.tradable, row.launchType, row.positionKind, row.quoteAsset, row.manager, row.modules, row.sourceUnavailable]);
    },
    async positions(token, address, options = {}) { const target = await resolve(token, options.platformId, false); return target.protocol.positions(token, address, {hint:target.row}); },
    async getTokenState(token, options = {}) { const target = await resolve(token, options.platformId, false); return target.protocol.getTokenState(token, {hint:target.row}); },
    async quoteTrade(input, guards = {}) {
      const target = await resolve(input.token, input.platformId);
      check(typeof target.protocol.quoteTrade === 'function', '此市场尚未提供独立报价，暂不支持自动兑换');
      check(target.id === 'flap' || input.sellPercentBps === undefined, '此市场不接受额外的份额百分比参数');
      const built = await target.protocol.quoteTrade({...input,market:target.row},guards);
      return { ...built, summary: { ...built.summary, platformId: target.id, kind: built.kind || input.side, token: input.token, walletAddress: input.walletAddress } };
    },
    async buildTrade(input, guards = {}) {
      const target = await resolve(input.token, input.platformId);
      check(target.id === 'flap' || input.sellPercentBps === undefined, '此市场不接受额外的份额百分比参数');
      const built = await target.protocol.buildTrade({...input,market:target.row},guards);
      return { ...built, summary: { ...built.summary, platformId: target.id, kind: built.kind || input.side, token: input.token, walletAddress: input.walletAddress } };
    },
    async validateExecution(transaction, summary) {
      const id = summary.platformId || 'four';
      const target = await resolve(summary.token, id);
      return target.protocol.validateExecution(transaction, summary);
    },
  };
}

// 各来源独立轮询、独立报错。一个索引失联不会清空其他发射台。
export function createMarketHub({ sources, pollMs = 15000, staleMs = 90000, now = Date.now } = {}) {
  const entries = new Map(Object.entries(sources).map(([id, source]) => [id, { source, tokens: [], status: 'starting', message: '正在连接', updatedAt: null, busy: false, timer: null }]));
  let running = false;
  async function refreshSource(id) {
    const entry = entries.get(id);
    if (entry.busy || !entry.source.load) return;
    entry.busy = true;
    try {
      const initial = entry.updatedAt === null;
      const result = await entry.source.load({ onProgress: (tokens, message) => {
        if (!initial) return;
        entry.tokens = [...tokens]; entry.status = 'syncing'; entry.message = message;
        entry.updatedAt = new Date(now()).toISOString();
      } });
      entry.tokens = result.tokens;
      entry.status = result.status || 'live'; entry.message = result.message || '已同步';
      entry.truncated = Boolean(result.truncated); entry.unavailable = result.unavailable ?? 0;
      entry.lastBlock = result.lastBlock ?? null; entry.tracks = result.tracks;
      entry.updatedAt = new Date(now()).toISOString();
    } catch (error) { entry.status = 'error'; entry.message = messageOf(error); }
    finally {
      entry.busy = false;
      if (running) { entry.timer = setTimeout(() => refreshSource(id), pollMs); entry.timer.unref?.(); }
    }
  }
  function snapshot() {
    const tokens = [], statuses = [];
    let fourMonitor;
    for (const [id, entry] of entries) {
      let { status, message, updatedAt, truncated, unavailable } = entry, rows = entry.tokens;
      if (entry.source.monitor) {
        const data = entry.source.monitor.snapshot();
        rows = data.tokens; ({ status, message, updatedAt, unavailable } = data.monitor);
        if (id === 'four') fourMonitor = data.monitor;
      }
      const stale = updatedAt && now() - Date.parse(updatedAt) > staleMs;
      const failed = status === 'error' || stale;
      if (stale) { status = 'error'; message = '行情已过期，等待重新同步'; }
      statuses.push({ ...PLATFORMS[id], id, status, message, updatedAt, lastBlock: entry.lastBlock ?? null, count: rows.filter(t => t.verified).length, truncated, unavailable, ...(entry.tracks?{tracks:entry.tracks}:{}) });
      for (const row of rows) {
        const token = { ...row, platformId: id, platformName: PLATFORMS[id]?.name || id, platformLogo: PLATFORMS[id]?.logo, sourceUpdatedAt: row.sourceUpdatedAt || updatedAt, sourceUnavailable:Boolean(failed || row.sourceUnavailable), priceUnit: row.priceUnit || row.quoteSymbol || 'BNB', quoteSymbol: row.quoteSymbol || 'BNB', positionKind: row.positionKind || 'token', ...(failed ? { tradable: false, reason: `${PLATFORMS[id]?.name} 行情不可用：${message}` } : {}) };
        if (token.verified === true) tokens.push(token);
      }
    }
    tokens.sort((a, b) => (a.phase !== 'bonding') - (b.phase !== 'bonding') || (Date.parse(b.createdAt) || Number(b.creationId) || b.createBlock || 0) - (Date.parse(a.createdAt) || Number(a.creationId) || a.createBlock || 0));
    const healthy = statuses.filter(s => ['live', 'demo'].includes(s.status)).length;
    const status = healthy === statuses.length ? 'live' : healthy > 0 || statuses.some(s => s.count > 0) ? 'degraded' : statuses.every(s => s.status === 'error') ? 'error' : 'starting';
    return { tokens: enrichMarketMetrics(tokens,{now:now()}), monitor: { templateId: manifest.templateId, registry: manifest.registry, manager: manifest.core, lastBlock: entries.get('four')?.lastBlock ?? null, ...fourMonitor, status, message: `${healthy}/${statuses.length} 个来源已同步 · ${tokens.length} 个已核验市场`, updatedAt: statuses.map(s => s.updatedAt).filter(Boolean).sort().at(-1) || null, sources: statuses } };
  }
  return {
    async start() {
      if (running) return; running = true;
      for (const entry of entries.values()) if (entry.source.monitor) Promise.resolve(entry.source.monitor.start()).catch(error => { entry.status = 'error'; entry.message = messageOf(error); });
      await Promise.allSettled([...entries.keys()].map(refreshSource));
    },
    refresh: () => Promise.allSettled([...entries.keys()].map(refreshSource)), snapshot,
    stop() { running = false; for (const entry of entries.values()) { clearTimeout(entry.timer); entry.source.monitor?.stop(); } },
  };
}
