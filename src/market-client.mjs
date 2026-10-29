const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LIMIT = 2 * 1024 * 1024;

// A tenant consumes public discovery only. Its tracking/history never flows back.
export function createMarketClient({ baseUrl = 'http://market:4317', allowHttps=false, fetch = globalThis.fetch, now = Date.now, pollMs = 15000, staleMs = 90000 } = {}) {
  const url = new URL(baseUrl);
  if (!(url.protocol==='http:'||allowHttps===true&&url.protocol==='https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid shared market URL');
  const endpoint = new URL('/api/tokens', url).href;
  let data = { tokens: [], monitor: { status: 'starting', message: '正在连接共享行情', updatedAt: null, sources: [] } };
  let updated = null, failed = false, pending, controller, timer, running = false, stopped = false, generation = 0;
  function snapshot() {
    const out = structuredClone(data);
    if (failed || (updated !== null && now() - updated > staleMs)) {
      out.monitor = { ...out.monitor, status: 'error', message: '共享行情不可用，等待重新同步', sources: (out.monitor.sources || []).map(source => ({ ...source, status: 'error' })) };
      out.tokens = out.tokens.map(token => ({ ...token, tradable: false, sourceUnavailable: true, reason: '共享行情不可用，禁止使用过期报价' }));
    }
    return out;
  }
  async function refresh() {
    if (stopped) return snapshot();
    if (pending) return pending;
    const expected = generation;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 8000); timeout.unref?.();
    pending = Promise.resolve().then(async () => {
      try {
        const response = await fetch(endpoint, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok || Number(response.headers.get('content-length')) > LIMIT) throw new Error('Invalid shared market response');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > LIMIT) throw new Error('Shared market response too large');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || !Array.isArray(body.tokens) || body.tokens.length > 2000 || !body.monitor || typeof body.monitor !== 'object' || Array.isArray(body.monitor) || body.tokens.some(token => !token || !ADDRESS.test(token.address) || token.verified !== true || !['four', 'flap', 'gang'].includes(token.platformId))) throw new Error('Malformed shared market discovery');
        if (!stopped && expected === generation) { data = { tokens: body.tokens, monitor: body.monitor }; updated = now(); failed = false; }
      } catch {
        if (!stopped && expected === generation) failed = true;
      } finally {
        clearTimeout(timeout); controller = null; pending = null;
        if (running && !stopped) { timer = setTimeout(refresh, pollMs); timer.unref?.(); }
      }
      return snapshot();
    });
    return pending;
  }
  return {
    snapshot, refresh,
    async start() { if (running || stopped) return; running = true; return refresh(); },
    stop() { stopped = true; running = false; generation++; clearTimeout(timer); controller?.abort(); },
  };
}
