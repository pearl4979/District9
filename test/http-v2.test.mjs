import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server.mjs';
import { createDemo } from '../src/demo.mjs';
import { createTradeService } from '../src/trades.mjs';

async function harness(t, extra = {}) {
  const deps = createDemo();
  const trades = createTradeService({ ...deps, demo: true });
  const server = createHttpServer({ ...deps, trades, demo: true, ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(`${base}/api/session`)).json();
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf };
  return { base, headers, session, post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }) };
}

test('像素版本返回真实边界和原始持仓，不接受任意图片CA', async t => {
  let imageCalls = 0;
  const h = await harness(t, { metadata: { getImage: async () => { imageCalls++; return { body: Buffer.from('image'), contentType: 'image/png' }; } } });
  assert.equal(h.session.mev.status, 'unverified');
  const positions = await (await fetch(`${h.base}/api/positions?token=0x0000000000000000000000000000000000000001`)).json();
  assert.equal(positions.decimals, 18); assert.match(positions.balance, /^\d+$/);
  assert.equal((await fetch(`${h.base}/api/token-image/0x1111111111111111111111111111111111111111`)).status, 404);
  assert.equal(imageCalls, 0);
});

test('K线接口仅接受已核验市场，静态图表脚本本地加载且保持原CSP', async t => {
  const h=await harness(t);
  const ok=await fetch(`${h.base}/api/candles?token=0x0000000000000000000000000000000000000001&interval=5min`);
  const chart=await ok.json(); assert.equal(ok.status,200); assert.equal(chart.kind,'demo'); assert.equal(chart.candles.length,96);
  assert.equal((await fetch(`${h.base}/api/candles?token=0x1111111111111111111111111111111111111111`)).status,404);
  assert.equal((await fetch(`${h.base}/api/candles?token=0x0000000000000000000000000000000000000001&interval=bad`)).status,400);
  for(const path of ['/candle-chart.js','/token-detail.js','/token-insights.js','/vendor/lightweight-charts-5.2.1.standalone.production.js']) {
    const r=await fetch(`${h.base}${path}`);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);
    assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
  }
  assert.equal((await fetch(`${h.base}/vendor/not-allowed.js`)).status,404);
});

test('选择实盘模式不读取钱包，真实预览仍要求当前钱包连接', async t => {
  const deps = createDemo();
  const trades = createTradeService({ ...deps });
  let reads=0;const baw={wallet:async()=>{reads++;return{status:'UNCONNECTED'};}};
  const real=createTradeService({protocol:deps.protocol,baw});
  const h = await harness(t, { demo: false, trades:real, baw });
  assert.equal((await h.post('/api/settings/execution', { enabled: true })).status, 200);
  assert.equal(real.isLiveExecution(),true);assert.equal(reads,0);
  assert.equal((await h.post('/api/preview',{token:'0x'+'1'.repeat(40),side:'buy',amount:'0.01',slippageBps:50})).status,400);assert.equal(reads,1);
  assert.equal((await h.post('/api/settings/execution', { enabled: false })).status, 200);
});

test('关闭模式无需等待正在读取的余额查询', async t => {
  const deps = createDemo(); const trades = createTradeService({ ...deps });
  let finish, began;
  const ready = new Promise(resolve => { began = resolve; });
  const h = await harness(t, { demo: false, trades, baw: { wallet: () => new Promise(resolve => { finish = resolve; began(); }) } });
  const reading=fetch(h.base+'/api/wallet');await ready;
  assert.equal((await h.post('/api/settings/execution',{enabled:true})).status,200);
  await h.post('/api/settings/execution', { enabled: false });
  finish({ status: 'CONNECTED', address: '0x1111111111111111111111111111111111111111', devMode: { enabled: true, expiresAt: '2099-01-01' } });
  assert.equal((await reading).status,200);assert.equal(trades.isLiveExecution(), false);
});

test('刷新钱包不会复用旧查询，晚返回的旧结果不能覆盖新缓存', async t => {
  let release, began, calls = 0;
  const ready = new Promise(resolve => { began = resolve; });
  const baw = { wallet: async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = resolve; began(); });
    return { status: 'CONNECTED', address: '0x1111111111111111111111111111111111111111' };
  } };
  const h = await harness(t, { demo: false, baw });
  const old = fetch(`${h.base}/api/wallet`); await ready;
  const fresh = await (await fetch(`${h.base}/api/wallet?refresh=1`)).json();
  assert.equal(fresh.status, 'CONNECTED');
  release({ status: 'UNCONNECTED' }); await old;
  const cached = await (await fetch(`${h.base}/api/wallet`)).json();
  assert.equal(cached.status, 'CONNECTED'); assert.equal(calls, 2);
});


test('档案接口拒绝窗口外地址；演示完全使用独立数据',async t=>{
 const h=await harness(t);const response=await fetch(`${h.base}/api/token-insights?token=0x0000000000000000000000000000000000000001`);assert.equal(response.status,200);const j=await response.json();assert.equal(j.fees.tokenBuyBps,100);assert.match(j.warnings[0],/DEMO/);assert.equal((await fetch(`${h.base}/api/token-insights?token=0x1111111111111111111111111111111111111111`)).status,404);
});

test('candle history query validates single decimal UTC milliseconds before dependencies and demo pages do not overlap',async t=>{
 const h=await harness(t);const path='/api/candles?token=0x0000000000000000000000000000000000000001';
 for(const suffix of ['&before=0','&before=1e12','&before=1793088000000.5','&before=999999999999999','&before=1793088000000&before=1793088000000','&extra=1','&interval=','&mode='])assert.equal((await fetch(h.base+path+suffix)).status,400,suffix);
 const latest=await(await fetch(h.base+path)).json();assert.equal(typeof latest.seriesKey,'string');assert.equal(latest.pagination.hasMore,true);
 const page=await(await fetch(h.base+path+'&before='+latest.pagination.nextBefore)).json();
 assert.equal(page.candles.length,96);assert.ok(page.candles.at(-1).t<latest.candles[0].t);assert.equal(page.seriesKey,latest.seriesKey);assert.equal(page.pagination.scope,'demo');
});


test('local candle currency validates strictly and forwards latest and exclusive history choices unchanged',async t=>{
 const calls=[],h=await harness(t,{charts:{get(...args){calls.push(args);return{candles:[],currency:args[3]?.currency};}}}),path=h.base+'/api/candles?token=0x0000000000000000000000000000000000000001';
 for(const suffix of ['&currency=','&currency=usd','&currency=EUR','&currency=BNB&currency=USD'])assert.equal((await fetch(path+suffix)).status,400,suffix);assert.equal(calls.length,0);
 assert.equal((await fetch(path+'&currency=USD')).status,200);assert.equal((await fetch(path+'&currency=BNB&before=1793088000000')).status,200);assert.deepEqual(calls.map(r=>r[3]),[{currency:'USD'},{before:1793088000000,currency:'BNB'}]);
});
