import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createDemo } from '../src/demo.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const avatarSource = await readFile(new URL('../public/wallet-avatar.js', import.meta.url), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const source = await readFile(new URL('../public/wallet-tracker.js', import.meta.url), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const address = n => `0x${String(n).padStart(40, '0')}`;
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const wallet = (n = 1, values = {}) => ({ address: address(n), note: '观察钱包', xUrl: 'https://x.com/observer', avatar: null, createdAt: '2026-10-27T10:00:00Z', ...values });
const event = (n, values = {}) => ({ id: String(n), walletAddress: address(1), tokenAddress: address(9), assetAddress: address(9), platformId: 'flap', phase: 'graduated', side: 'buy', timestamp: 1793095200000 + n * 1000, blockNumber: 100 + n, transactionIndex: 0, logIndex: n, txHash: `0x${String(n).padStart(64, '0')}`, tokenSymbol: 'TEST', tokenName: 'Test', tokenAmount: '12.5', quoteAmount: '0.01', quoteSymbol: 'BNB', price: null, priceUnit: null, source: 'verified-dex', confirmed: true, demo: false, market: null, ...values });
const snapshot = (values = {}) => ({ wallets: [wallet()], events: [], preferences: { showAvatars: true }, status: { state: 'live', message: '已确认区块增量读取', updatedAt: new Date().toISOString(), coverage: '有限近期区块', lastBlock: 110, coveredFromBlock: 100, lagBlocks: 2 }, ...values });

function page({ canEdit = () => true, storage = new Map() } = {}) {
  const { window, document } = parseHTML(html), requests = [], selected = [], updates = [], timers = new Map(); let nextTimer = 0;
  window.innerWidth = 1400;
  window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  let focused = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => focused, configurable: true });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  const api = (path, body, options) => new Promise((resolve, reject) => requests.push({ path, body, options, resolve, reject }));
  const runtime = vm.createContext({ window, document, AbortController, URL, Intl, Date, console,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } });
  if (avatarSource) vm.runInContext(avatarSource, runtime);
  vm.runInContext(source, runtime);
  assert.equal(typeof window.createWalletTracker, 'function', 'wallet tracking exposes its standalone controller');
  window.addEventListener('wallet-tracking-update', e => updates.push(e.detail));
  const controller = window.createWalletTracker({ api, canEdit, onSelect: value => selected.push(value) });
  return { window, document, runtime, api, requests, selected, updates, timers, controller, $: id => document.getElementById(id) };
}

async function ready(data = snapshot(), options) {
  const p = page(options); p.controller.start(); p.requests[0].resolve(data); await tick(); return p;
}

test('streamed indexer observations show a distinct evidence label without entering confirmed chart history',async()=>{
 const p=await ready(snapshot());
 assert.equal(typeof p.controller.applySnapshot,'function');assert.equal(typeof p.controller.setStreamState,'function');
 p.controller.setStreamState(true);
 p.controller.applySnapshot(snapshot({events:[event(1)],indexedEvents:[event(2,{id:'indexed:2',confirmed:false,evidence:'binance-indexed',tokenAmount:null,quoteAmount:null,price:null,source:'Binance Web3 索引推送',indexerFields:{txUsdValue:'72.5',txNativeTokenQty:'1616'}})]}));
 const rows=[...p.$('tracking-signals').querySelectorAll('.tracking-signal')];assert.equal(rows.length,2);assert.match(rows[0].textContent,/币安推送.*待链上核验/);assert.match(rows[0].textContent,/72.5 USD/);assert.equal(rows[0].textContent.includes('1616 BNB'),false);
 assert.equal(p.controller.snapshot().events.length,1);assert.equal(p.controller.snapshot().indexedEvents.length,1);
 assert.equal([...p.timers.values()].some(timer=>timer.ms===5000),false,'healthy stream suspends polling');
 const kept=rows[1];p.controller.applySnapshot(p.controller.snapshot());assert.equal(p.$('tracking-signals').querySelectorAll('.tracking-signal')[1],kept,'unchanged signals keep their DOM nodes');
 p.controller.stop();p.controller.applySnapshot(snapshot({events:[event(9)]}));assert.equal(p.$('tracking-signals').querySelectorAll('.tracking-signal').length,0,'late pushes cannot restore a stopped owner');
});

for (const action of ['add', 'edit', 'remove']) for (const succeeds of [true, false]) {
  test(`same-owner stream updates release ${action} management after a deferred write ${succeeds ? 'succeeds' : 'fails'}`, async () => {
    const p = await ready(); p.controller.setStreamState(true);
    if (action === 'remove') p.$('tracking-wallets').querySelector('[data-wallet-remove]').click();
    else {
      if (action === 'edit') p.$('tracking-wallets').querySelector('[data-wallet-edit]').click();
      else { p.$('tracking-add').click(); p.$('tracking-address').value = address(2); }
      p.$('tracking-note').value = '写入备注';
      p.$('tracking-form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    }
    const write = p.requests.at(-1);
    assert.equal(p.$('tracking-add').disabled, true);
    p.controller.applySnapshot(snapshot({ events: [event(2)] }));
    if (succeeds) write.resolve(snapshot({ wallets: action === 'remove' ? [] : [wallet(action === 'add' ? 2 : 1, { note: '写入备注' })] }));
    else write.reject(new Error('写入失败'));
    await tick();
    for (const id of ['tracking-add', 'tracking-save', 'tracking-cancel']) assert.equal(p.$(id).disabled, false, `${id} recovers`);
    assert.ok([...p.$('tracking-wallets').querySelectorAll('button')].every(button => !button.disabled));
    if (succeeds) { assert.equal(p.controller.snapshot().wallets.length, action === 'remove' ? 0 : 1); assert.doesNotMatch(p.$('tracking-status').textContent, /移除失败/); }
    else assert.match(p.$('tracking-manager-error').textContent, /写入失败/);
    p.controller.stop();
  });
}

for (const succeeds of [true, false]) test(`a stopped owner's deferred removal ${succeeds ? 'success' : 'failure'} cannot alter a restarted owner`, async () => {
  const p = await ready(); p.$('tracking-wallets').querySelector('[data-wallet-remove]').click();
  const write = p.requests.at(-1); p.controller.stop(); p.controller.start();
  p.requests.at(-1).resolve(snapshot({ wallets: [wallet(3, { note: '新会话' })] })); await tick();
  if (succeeds) write.resolve(snapshot({ wallets: [] })); else write.reject(new Error('旧会话错误'));
  await tick(); assert.equal(p.controller.snapshot().wallets[0].address, address(3));
  assert.doesNotMatch(p.$('tracking-status').textContent, /移除失败|旧会话/);
  assert.equal(p.$('tracking-add').disabled, false); p.controller.stop();
});

test('an owner stop during a mutation fallback read cannot close the restarted owner form', async () => {
  const p = await ready();p.$('tracking-add').click();p.$('tracking-address').value=address(2);
  p.$('tracking-form').dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));
  p.requests.at(-1).resolve({saved:true});await tick();const oldRead=p.requests.at(-1);
  assert.equal(oldRead.path,'/api/tracking');p.controller.stop();p.controller.start();
  p.requests.at(-1).resolve(snapshot({wallets:[wallet(3)]}));await tick();p.$('tracking-add').click();p.$('tracking-address').value=address(4);
  oldRead.resolve(snapshot({wallets:[wallet(2)]}));await tick();
  assert.equal(p.$('tracking-form').hidden,false,'obsolete completion cannot close the new form');
  assert.equal(p.$('tracking-address').value,address(4));assert.equal(p.controller.snapshot().wallets[0].address,address(3));p.controller.stop();
});

test('signal metric switch shows event-time cap or execution price without using the latest market or writing an order', async () => {
  const historical = event(1, { price:'0.0000000123456', priceUnit:'BNB/份额',
    valuation:{kind:'event-snapshot',value:'12345',unit:'BNB',basis:'share-equivalent-FDV',source:'已核验事件后份额等值 FDV',blockNumber:101,timestamp:new Date(1793095201000).toISOString()},
    market:{price:'999',marketCap:{value:888888,unit:'USD'}} });
  const p=await ready(snapshot({events:[historical,event(2,{side:'sell',price:'0.25',priceUnit:'USD',valuation:{kind:'event-snapshot',value:'250000',unit:'USD',basis:'circulating-market-cap',source:'历史流通供应量',blockNumber:102,timestamp:new Date(1793095202000).toISOString()}})]}));
  const metrics=()=>[...p.$('tracking-signals').querySelectorAll('.tracking-signal-valuation')];
  assert.equal(metrics().length,2);
  assert.match(metrics()[0].textContent,/卖出市值.*250K USD/);
  assert.match(metrics()[1].textContent,/买入市值.*份额等值 FDV.*12.345K BNB/);
  assert.match(metrics()[1].title,/12345 BNB.*已核验事件/);
  p.$('tracking-metric-price').click();
  assert.equal(p.$('tracking-metric-price').getAttribute('aria-pressed'),'true');
  assert.equal(p.$('tracking-metric-marketcap').getAttribute('aria-pressed'),'false');
  assert.match(metrics()[0].textContent,/卖出币价.*0.25 USD/);
  assert.match(metrics()[1].textContent,/买入币价.*0.0000000123456 BNB\/份额/);
  const refresh=p.controller.refresh();p.requests.at(-1).resolve(snapshot({events:[{...historical,market:{price:'555',marketCap:{value:777777,unit:'USD'}}}]}));await refresh;
  assert.match(metrics()[0].textContent,/0.0000000123456 BNB\/份额/);
  p.$('tracking-metric-marketcap').click();assert.match(metrics()[0].textContent,/12.345K BNB/);
  assert.ok(p.requests.every(request=>request.path==='/api/tracking'&&request.body===undefined));
  assert.equal(p.selected.length,0);p.controller.stop();
});

test('signal valuation never fabricates missing history, uses stale snapshots or labels transfers as trades',async()=>{
  const base={kind:'event-snapshot',value:'12345',unit:'BNB',basis:'FDV',source:'历史估值',blockNumber:101,timestamp:new Date(1793095201000).toISOString()};
  const p=await ready(snapshot({events:[
    event(1,{valuation:{...base,blockNumber:999},market:{price:'999',chartSupply:'1000000000',marketCap:{value:999999}}}),
    event(2,{valuation:{...base,blockNumber:102,timestamp:new Date(1793095201000).toISOString()}}),
    event(3,{side:'transfer-in',price:'2',priceUnit:'BNB',valuation:{...base,blockNumber:103,timestamp:new Date(1793095203000).toISOString()}}),
    event(4,{price:'0',priceUnit:'BNB'}),event(5,{price:'NaN',priceUnit:'BNB'})
  ]}));
  const rows=[...p.$('tracking-signals').querySelectorAll('.tracking-signal-valuation')];
  assert.equal(rows.length,5);assert.ok(rows.every(row=>!row.textContent.includes('12345')&&!row.textContent.includes('999')));
  assert.match(rows[2].textContent,/转账不计成交/);
  p.$('tracking-metric-price').click();
  const prices=[...p.$('tracking-signals').querySelectorAll('.tracking-signal-valuation')];
  assert.ok(prices.filter(row=>!row.textContent.includes('转账')).every(row=>row.textContent.includes('未知')));
  p.controller.stop();
});

test('signal metric preference survives a reload without changing private tracking preferences and blocked storage stays usable',async()=>{
  const storage=new Map(),p=await ready(snapshot(),{storage});p.$('tracking-metric-price').click();p.controller.stop();
  const restored=await ready(snapshot({events:[event(1,{price:'0.01',priceUnit:'BNB',source:'已核验 DEX swap · 池计价量'})]}),{storage});
  assert.equal(restored.$('tracking-metric-price').getAttribute('aria-pressed'),'true');
  assert.match(restored.$('tracking-signals').textContent,/池成交参考价.*0.01 BNB/);
  assert.equal(restored.controller.snapshot().preferences.showAvatars,true);restored.controller.stop();
  const unavailable={get(){throw Error('storage disabled');},set(){throw Error('storage disabled');}};
  const blocked=await ready(snapshot(),{storage:unavailable});blocked.$('tracking-metric-price').click();
  assert.equal(blocked.$('tracking-metric-price').getAttribute('aria-pressed'),'true');blocked.controller.stop();
});

test('latest signal feed filters unwatched and unconfirmed events, sorts newest first and safely labels manual profiles', async () => {
  const unsafe = '<img src=x onerror="window.injected=true">';
  const p = await ready(snapshot({ wallets: [wallet(1, { note: unsafe, xUrl: 'javascript:alert(1)', avatar: 'https://evil.test/avatar.jpg' })], events: [event(1), event(4, { side: 'transfer-out', timestamp: '2026-10-27T18:00:04Z' }), event(3, { side: 'sell', demo: true }), event(9, { confirmed: false }), event(8, { walletAddress: address(2) })] }));
  const rows = [...p.$('tracking-signals').querySelectorAll('.tracking-signal')];
  assert.deepEqual(rows.map(x => x.dataset.eventId), ['4', '3', '1']);
  assert.match(rows[0].textContent, /转出/); assert.equal(rows[0].classList.contains('sell'), false);
  assert.ok(rows[1].classList.contains('sell')); assert.match(rows[1].textContent, /DEMO/);
  assert.match(rows[2].textContent, /Flap/); assert.match(rows[2].textContent, /0\.01 BNB/);
  assert.equal(p.$('wallet-tracking').querySelectorAll('script,iframe,img[src^=\"http\"],img[src^=\"javascript\"]').length, 0);
  assert.match(p.$('tracking-wallets').textContent, /<img src=x onerror=/);
  assert.equal(p.$('tracking-wallets').querySelector('a'), null);
  rows[2].querySelector('.tracking-signal-open').click(); await tick();
  assert.equal(p.selected[0].tokenAddress, address(9));
  assert.equal(p.updates.at(-1).events.length, 5);
  p.controller.stop();
});

test('wallet form saves canonical X and plain labels, keeps unsaved edits during refresh, then removes locally', async () => {
  const p = await ready();
  p.$('tracking-add').click(); p.$('tracking-address').value = address(2); p.$('tracking-note').value = '<b>鲸鱼</b>'; p.$('tracking-x').value = 'https://twitter.com/whale_2/';
  p.$('tracking-form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(p.requests.at(-1).path, '/api/tracking/wallet');
  assert.deepEqual(JSON.parse(JSON.stringify(p.requests.at(-1).body)), { address: address(2), note: '<b>鲸鱼</b>', xUrl: 'https://x.com/whale_2', avatar: null });
  p.requests.at(-1).resolve(snapshot({ wallets: [wallet(), wallet(2, { note: '<b>鲸鱼</b>', xUrl: 'https://x.com/whale_2' })] })); await tick();
  assert.equal(p.$('tracking-form').hidden, true); assert.match(p.$('tracking-wallets').textContent, /<b>鲸鱼<\/b>/);
  assert.match(p.$('tracking-wallets').textContent, /手动关联/);
  p.$('tracking-wallets').querySelector('[data-wallet-edit]').click();
  p.$('tracking-note').value = '未保存的备注'; const refresh = p.controller.refresh();
  p.requests.at(-1).resolve(snapshot({ wallets: [wallet(), wallet(2)] })); await refresh;
  assert.equal(p.$('tracking-note').value, '未保存的备注');
  p.$('tracking-cancel').click(); p.$('tracking-wallets').querySelector('[data-wallet-remove]').click();
  assert.equal(p.requests.at(-1).path, '/api/tracking/wallet/remove');
  p.requests.at(-1).resolve(snapshot({ wallets: [wallet(2)] })); await tick();
  assert.equal(p.$('tracking-wallets').querySelectorAll('.tracking-wallet').length, 1);
  assert.equal(p.controller.snapshot().wallets[0].address, address(2)); p.controller.stop();
});

test('form rejects arbitrary X URLs and invalid addresses without sending a write', async () => {
  const p = await ready(); p.$('tracking-add').click(); p.$('tracking-address').value = address(2); p.$('tracking-x').value = 'https://x.com/whale/status/123';
  const submit = () => p.$('tracking-form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await tick(); assert.equal(p.requests.length, 1); assert.match(p.$('tracking-form-error').textContent, /X.*主页/);
  p.$('tracking-x').value = ''; p.$('tracking-address').value = '0x123'; submit(); await tick();
  assert.equal(p.requests.length, 1); assert.match(p.$('tracking-form-error').textContent, /地址/); p.controller.stop();
});

test('a rejected removal stays visible without discarding the watched wallet or last signals', async () => {
  const p = await ready(snapshot({ events: [event(1)] }));
  p.$('tracking-wallets').querySelector('[data-wallet-remove]').click(); p.requests.at(-1).reject(new Error('本机存储暂不可写')); await tick();
  assert.equal(p.$('tracking-form').hidden, true); assert.match(p.$('tracking-status').textContent, /移除失败.*本机存储暂不可写/);
  assert.equal(p.controller.snapshot().wallets.length, 1); assert.equal(p.$('tracking-signals').querySelectorAll('.tracking-signal').length, 1); p.controller.stop();
});

test('local avatar upload crops to 64px JPEG and saves only its compact data URL', async () => {
  const p = await ready(), draws = [], compact = 'data:image/jpeg;base64,Y29tcGFjdC1pbWFnZQ==';
  const originalCreate = p.document.createElement.bind(p.document);
  const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage(...args) { draws.push(args); } }), toDataURL(type) { assert.equal(type, 'image/jpeg'); return compact; } };
  p.document.createElement = tag => {
    if (tag === 'canvas') return canvas;
    const element = originalCreate(tag);
    if (tag === 'img') {
      Object.defineProperties(element, { naturalWidth: { value: 128 }, naturalHeight: { value: 96 }, src: { get() { return this.getAttribute('src'); }, set(value) { this.setAttribute('src', value); if (value.startsWith('data:image/png;')) this.onload(); } } });
    }
    return element;
  };
  p.window.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,bG9jYWwtaW1hZ2U='; this.onload(); } };
  p.$('tracking-add').click(); p.$('tracking-address').value = address(2);
  Object.defineProperty(p.$('tracking-avatar-file'), 'files', { value: [{ type: 'image/png', size: 5000 }], configurable: true });
  p.$('tracking-avatar-file').dispatchEvent(new p.window.Event('change')); await tick();
  assert.equal(p.$('tracking-form-error').textContent, '');
  assert.equal(canvas.width, 64); assert.equal(canvas.height, 64); assert.deepEqual(draws[0].slice(1), [16, 0, 96, 96, 0, 0, 64, 64]);
  assert.equal(p.$('tracking-avatar-preview').querySelector('img').src, compact);
  p.$('tracking-form').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
  assert.equal(p.requests.at(-1).body.avatar, compact); assert.ok(p.requests.at(-1).body.avatar.length <= 6000);
  p.requests.at(-1).resolve(snapshot({ wallets: [wallet(2, { avatar: compact })] })); await tick();
  assert.equal(p.$('tracking-wallets').querySelector('img').src, compact); p.controller.stop();
});

test('cancelling an in-flight avatar decode does not leave the next form disabled or apply an old image', async () => {
  const p = await ready(); let reader;
  p.window.FileReader = class { readAsDataURL() { reader = this; } };
  p.$('tracking-add').click(); Object.defineProperty(p.$('tracking-avatar-file'), 'files', { value: [{ type: 'image/png', size: 5000 }], configurable: true });
  p.$('tracking-avatar-file').dispatchEvent(new p.window.Event('change'));
  assert.equal(p.$('tracking-save').disabled, true); p.$('tracking-cancel').click(); p.$('tracking-add').click();
  assert.equal(p.$('tracking-save').disabled, false);
  reader.result = 'data:image/png;base64,bG9jYWw='; reader.onload(); await tick();
  assert.equal(p.$('tracking-avatar-preview').querySelector('img'), null); p.controller.stop();
});

test('delayed and failed source states retain last signals and disclose bounded coverage and lag', async () => {
  const p = await ready(snapshot({ events: [event(1)], status: { state: 'delayed', message: 'RPC 积压', updatedAt: '2026-10-27T10:00:00Z', coverage: '仅最近 500 区块', lastBlock: 600, coveredFromBlock: 100, lagBlocks: 42 } }));
  assert.match(p.$('tracking-status').textContent, /延迟/); assert.match(p.$('tracking-coverage').textContent, /100.*600.*42/); assert.match(p.$('tracking-coverage').textContent, /仅最近 500 区块/);
  const refresh = p.controller.refresh(); p.requests.at(-1).reject(new Error('连接中断')); await refresh;
  assert.match(p.$('tracking-status').textContent, /连接中断/); assert.match(p.$('tracking-status').textContent, /上次/);
  assert.equal(p.$('tracking-signals').querySelectorAll('.tracking-signal').length, 1); p.controller.stop();
});

test('graduated pool quantities retain their pool-leg qualifier and syncing backlog stays visibly delayed', async () => {
  const p = await ready(snapshot({ events: [event(1, { source: '已核验 DEX swap · 池计价量' })], status: { state: 'syncing', message: '仍有区块积压', updatedAt: new Date().toISOString(), coveredFromBlock: 100, lastBlock: 600, lagBlocks: 800, coverage: '有限近期区块' } }));
  assert.match(p.$('tracking-signals').querySelector('.tracking-signal-amount').textContent, /0\.01 BNB.*池计价量/);
  assert.match(p.$('tracking-status').textContent, /正在同步/); assert.ok(p.$('tracking-status').classList.contains('delayed')); p.controller.stop();
});

test('polls coalesce, stopped requests are ignored and removal invalidates an earlier read', async () => {
  const p = await ready();
  const first = p.controller.refresh(), second = p.controller.refresh(); assert.equal(p.requests.length, 2);
  p.$('tracking-wallets').querySelector('[data-wallet-remove]').click();
  const removal = p.requests.at(-1); removal.resolve(snapshot({ wallets: [], events: [] })); await tick();
  p.requests[1].resolve(snapshot({ events: [event(1)] })); await Promise.all([first, second]);
  assert.equal(p.controller.snapshot().wallets.length, 0); assert.equal(p.$('tracking-signals').querySelectorAll('.tracking-signal').length, 0);
  const late = p.controller.refresh(); p.controller.stop(); p.requests.at(-1).resolve(snapshot()); await late;
  assert.equal(p.controller.snapshot().wallets.length, 0); assert.equal(p.timers.size, 0);
});

test('account stop clears private snapshots and late writes cannot repaint old wallets or signals', async () => {
  const p=await ready(snapshot({events:[event(1)]}));
  p.$('tracking-wallets').querySelector('[data-wallet-remove]').click();
  const lateWrite=p.requests.at(-1);p.controller.stop();
  assert.equal(p.controller.snapshot().wallets.length,0);
  lateWrite.reject(new Error('Session expired'));await tick();
  assert.equal(p.$('tracking-wallets').children.length,0);assert.equal(p.$('tracking-signals').children.length,0);
  assert.equal(p.controller.snapshot().events.length,0);assert.equal(p.timers.size,0);
});

test('account stop cancels late avatar callbacks and removes unsaved private fields', async () => {
  const p=await ready();let reader;
  p.window.FileReader=class {readAsDataURL(){reader=this;}};
  p.$('tracking-add').click();p.$('tracking-note').value='private note';
  Object.defineProperty(p.$('tracking-avatar-file'),'files',{value:[{type:'image/png',size:10}],configurable:true});
  p.$('tracking-avatar-file').dispatchEvent(new p.window.Event('change'));p.controller.stop();
  reader.result='data:image/png;base64,cHJpdmF0ZQ==';reader.onload();await tick();
  assert.equal(p.$('tracking-note').value,'');assert.equal(p.$('tracking-form').hidden,true);
  assert.equal(p.$('tracking-avatar-preview').querySelector('img'),null);
});

test('refresh after a saved preference discards an older in-flight snapshot', async () => {
  const p = await ready(), older = p.controller.refresh();
  const latest = p.controller.refresh({ discardPending: true });
  assert.equal(p.requests.length, 3); assert.equal(p.requests[1].options.signal.aborted, true);
  p.requests[2].resolve(snapshot({ preferences: { showAvatars: false } })); await latest;
  p.requests[1].resolve(snapshot({ preferences: { showAvatars: true } })); await older;
  assert.equal(p.controller.snapshot().preferences.showAvatars, false); p.controller.stop();
});

test('desktop collapse and mobile drawer preserve feed independently of the detail view', async () => {
  const p = await ready(snapshot({ events: [event(1)] }));
  p.$('tracking-collapse').click(); assert.ok(p.document.body.classList.contains('tracking-collapsed'));
  p.$('tracking-open').click(); assert.equal(p.document.body.classList.contains('tracking-collapsed'), false);
  p.window.innerWidth = 390; p.$('tracking-open').click(); assert.ok(p.document.body.classList.contains('tracking-drawer-open'));
  assert.equal(p.$('tracking-open').getAttribute('aria-expanded'), 'true');
  p.$('token-detail').hidden = false; p.$('market').hidden = true;
  assert.equal(p.$('wallet-tracking').hidden, false); assert.equal(p.$('tracking-signals').querySelectorAll('.tracking-signal').length, 1);
  p.$('tracking-close').click(); assert.equal(p.document.body.classList.contains('tracking-drawer-open'), false); p.controller.stop();
});

test('signal navigation resolves a retained verified market without adding it to executable discovery', async () => {
  const p = page(), demo = createDemo();
  const retained = { ...demo.monitor.snapshot().tokens[0], address: address(77), name: '已保存的市场', symbol: 'SAVED', phase: 'graduated', tradable: false };
  const chartTokens = [];
  p.window.createTokenDetail = () => ({ open(token) { chartTokens.push(token); p.$('token-detail').hidden = false; p.$('market').hidden = true; p.$('detail-name').textContent = token.name; }, update() {}, close() {}, back() {}, focusEvent(value) { p.$('chart-updated').textContent = value.id; } });
  p.window.HTMLElement.prototype.scrollIntoView = function () {};
  p.runtime.navigator = {}; p.runtime.setInterval = () => 99; p.runtime.clearInterval = () => {};
  p.runtime.fetch = async path => {
    let result;
    if (path === '/api/session') result = { csrf: 'test', mode: 'demo', liveExecution: false };
    else if (path === '/api/tokens') result = demo.monitor.snapshot();
    else if (path === '/api/wallet') result = await demo.baw.wallet();
    else if (path === '/api/orders') result = { orders: [] };
    else if (path === '/api/tracking') result = snapshot({ events: [event(1, { tokenAddress: address(77) })] });
    else if (path === `/api/tracking/token?token=${address(77)}`) result = retained;
    else throw new Error(`Unexpected read: ${path}`);
    return { ok: true, json: async () => result };
  };
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), p.runtime); await tick();
  p.$('tracking-signals').querySelector('.tracking-signal-open').click(); await tick();
  assert.equal(p.$('detail-name').textContent, '已保存的市场'); assert.equal(chartTokens.at(-1).address, address(77));
  assert.equal(p.$('preview-button').disabled, true); assert.equal(p.$('trade-drawer').hidden, true);
  assert.equal(p.document.querySelectorAll('#token-rows [data-address="' + address(77) + '"]').length, 0);
  assert.equal(p.$('chart-updated').textContent, '1'); p.window.walletTracker.stop();
});


test('management drawer keeps all profile rows outside the signal rail and returns focus after Escape', async () => {
  const p = await ready(snapshot({wallets:Array.from({length:100},(_,i)=>wallet(i+1)),events:[event(1)]}));
  assert.equal(p.$('wallet-tracking').nextElementSibling, p.document.querySelector('main.workspace'));
  assert.ok(!p.$('wallet-tracking').querySelector('#tracking-wallets'));
  assert.ok(!p.$('wallet-tracking').querySelector('#tracking-form'));
  assert.equal(p.$('tracking-wallets').querySelectorAll('.tracking-wallet').length, 100);
  assert.equal(p.$('tracking-manager').hidden, true);
  const trigger=p.$('tracking-manage-open');trigger.focus();trigger.click();
  assert.equal(p.$('tracking-manager').hidden,false);
  assert.equal(trigger.getAttribute('aria-expanded'),'true');
  assert.equal(p.document.activeElement,p.$('tracking-manager-close'));
  let downstream=0;p.document.addEventListener('keydown',()=>downstream++);
  const escape=new p.window.Event('keydown',{bubbles:true,cancelable:true});escape.key='Escape';p.$('tracking-manager-close').dispatchEvent(escape);
  assert.equal(p.$('tracking-manager').hidden,true);assert.equal(p.document.activeElement,trigger);
  assert.equal(downstream,0,'closing management cannot also close lower trading or chart layers');
  assert.equal(p.$('tracking-signals').querySelectorAll('.tracking-signal').length,1);p.controller.stop();
});

test('management traps keyboard focus and preserves wallet action nodes and editor input through polling',async()=>{
  const p=await ready();assert.ok(p.$('tracking-manage-open'),'management entry is available');p.$('tracking-manage-open').click();
  const edit=p.$('tracking-wallets').querySelector('[data-wallet-edit]');edit.focus();
  const refresh=p.controller.refresh();p.requests.at(-1).resolve(snapshot({events:[event(2)]}));await refresh;
  assert.equal(p.$('tracking-wallets').querySelector('[data-wallet-edit]'),edit);
  assert.equal(p.document.activeElement,edit);
  edit.click();p.$('tracking-note').value='未保存备注';p.$('tracking-note').focus();
  const again=p.controller.refresh();p.requests.at(-1).resolve(snapshot({events:[event(3)]}));await again;
  assert.equal(p.$('tracking-note').value,'未保存备注');assert.equal(p.document.activeElement,p.$('tracking-note'));
  p.$('tracking-cancel').click();
  const items=[...p.$('tracking-manager-panel').querySelectorAll('button,input,a[href]')].filter(e=>!e.disabled&&!e.hidden&&!e.closest('[hidden]'));
  items.at(-1).focus();const tab=new p.window.Event('keydown',{bubbles:true,cancelable:true});tab.key='Tab';items.at(-1).dispatchEvent(tab);
  assert.equal(p.document.activeElement,items[0]);
  p.controller.stop();assert.equal(p.$('tracking-manager').hidden,true);assert.equal(p.$('tracking-note').value,'');
});

test('management errors remain visible and account gate prevents opening private management',async()=>{
  const p=await ready();assert.ok(p.$('tracking-manage-open'),'management entry is available');p.$('tracking-manage-open').click();
  p.$('tracking-wallets').querySelector('[data-wallet-remove]').click();p.requests.at(-1).reject(new Error('storage unavailable'));await tick();
  assert.equal(p.$('tracking-manager-error').hidden,false);assert.match(p.$('tracking-manager-error').textContent,/storage unavailable/);
  assert.equal(p.$('tracking-wallets').children.length,1);p.controller.stop();
  let requests=0;const guest=page({canEdit:()=>{requests++;return false;}});guest.$('tracking-manage-open').click();
  assert.equal(requests,1);assert.equal(guest.$('tracking-manager').hidden,true);assert.equal(guest.requests.length,0);guest.controller.stop();
});

test('shared default wallet avatars match between management and signals while custom avatars retain priority',async()=>{
  const p=await ready(snapshot({events:[event(1)]}));
  const profile=p.$('tracking-wallets').querySelector('.wallet-default-avatar'),signal=p.$('tracking-signals').querySelector('.wallet-default-avatar');
  assert.ok(profile);assert.ok(signal);assert.equal(profile.outerHTML,signal.outerHTML);
  const refresh=p.controller.refresh();const custom='data:image/jpeg;base64,Y29tcGFjdA==';p.requests.at(-1).resolve(snapshot({wallets:[wallet(1,{avatar:custom})],events:[event(1)]}));await refresh;
  assert.equal(p.$('tracking-wallets').querySelector('.tracking-avatar img').src,custom);
  assert.equal(p.$('tracking-signals').querySelector('.tracking-avatar img').src,custom);p.controller.stop();
});


test('cancelling management edits returns focus to add and backdrop dismissal releases background controls',async()=>{
  const p=await ready();p.$('tracking-manage-open').focus();p.$('tracking-manage-open').click();
  assert.ok(p.document.querySelector('.topbar').hasAttribute('inert'));
  p.$('tracking-add').click();p.$('tracking-cancel').focus();p.$('tracking-cancel').click();
  assert.equal(p.document.activeElement?.id,'tracking-add');
  p.$('tracking-manager').click();assert.equal(p.$('tracking-manager').hidden,true);
  assert.equal(p.document.querySelector('.topbar').hasAttribute('inert'),false);
  assert.equal(p.document.activeElement?.id,'tracking-manage-open');p.controller.stop();
});

test('an owner-verified X binding replaces the manual link while missing image falls back to a supplied portrait',async()=>{
 const addressValue=address(1),p=await ready(snapshot({wallets:[wallet(1,{social:{status:'verified',address:addressValue,xUrl:'https://x.com/owner',avatarPath:'/api/wallet-avatar/'+addressValue}})],events:[event(1)]}));
 const link=p.$('tracking-wallets').querySelector('a');assert.equal(link.getAttribute('href'),'https://x.com/owner');assert.match(link.textContent,/已绑定/);assert.equal(p.$('tracking-signals').querySelector('img').getAttribute('src'),'/api/wallet-avatar/'+addressValue);
});
