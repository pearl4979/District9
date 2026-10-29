'use strict';

// 本机关注名单与只读信号；不请求外部头像，也不触及交易执行。
window.createWalletTracker = ({ api, onSelect = () => {}, onChange = () => {}, canEdit = () => true }) => {
  const $ = id => document.getElementById(id);
  const listeners = new Set();
  const platforms = { gang: 'Gang', flap: 'Flap', four: 'Four.meme' };
  const sideLabels = { buy: '买入', sell: '卖出', 'transfer-in': '转入', 'transfer-out': '转出', transfer_in: '转入', transfer_out: '转出' };
  let data = { wallets: [], events: [], preferences: { showAvatars: true }, status: { state: 'connecting', message: '等待本地追踪服务' } };
  let active = false, timer = null, pending = null, generation = 0, ownerGeneration = 0, writing = false, avatar = null, imageVersion = 0;
  let walletSignature = null, signalSignature=null, managerReturn = null,streamLive=false,streamPaused=false,fallbackDelay=5000;
  const inertElements = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  const snapshot = () => clone(data);
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };
  const key = value => String(value || '').toLowerCase();
  const short = value => `${String(value).slice(0, 6)}…${String(value).slice(-4)}`;
  const validAddress = value => /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
  function xProfile(value) {
    if (!value?.trim()) return null;
    try {
      const url = new URL(value.trim());
      const handle = url.pathname.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1];
      if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !handle || ['home', 'explore', 'search', 'settings', 'messages', 'notifications', 'i', 'intent', 'share'].includes(handle.toLowerCase())) return null;
      return `https://x.com/${handle}`;
    } catch { return null; }
  }
  const validAvatar = value => typeof value === 'string' && value.length <= 6000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
  const stamp = value => { const time = typeof value === 'number' && value < 1e12 ? value * 1000 : value; const parsed = new Date(time); return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0; };
  const date = value => stamp(value) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(stamp(value))) : '时间待核验';
  const amount = value => value === null || value === undefined || value === '' ? '数量待核验' : String(value);
  const metricKey = 'district9.signalMetric.v1';
  let metric = 'marketcap';
  try { if (window.localStorage?.getItem(metricKey) === 'price') metric = 'price'; } catch { /* Display preference is optional. */ }
  const positive = value => typeof value === 'string' && /^\d{1,90}(?:\.\d{1,90})?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
  const unit = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 32 && !/[\u0000-\u001f\u007f]/.test(value);
  const referenceNumber = (value, compact) => new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6, useGrouping: false, ...(compact ? { notation: 'compact' } : {}) }).format(Number(value));
  function signalValuation(event) {
    const el = node('span', 'tracking-signal-valuation');
    if (!['buy', 'sell'].includes(event.side)) { el.textContent = '转账不计成交估值'; el.classList.add('unknown'); return el; }
    const action = sideLabels[event.side], label = `${action}${metric === 'price' ? '币价' : '市值'}`;
    let raw, valueUnit, basis = '', source;
    if (metric === 'price') {
      if (positive(event.price) && unit(event.priceUnit)) {
        raw = event.price; valueUnit = event.priceUnit;
        basis = /dex|池计价量/i.test(event.source || '') ? '池成交参考价' : '成交均价';
        source = event.source;
      }
    } else {
      // The attached market is a latest snapshot. Only the event's own valuation is historical.
      const value = event.valuation, bases = { FDV: 'FDV', 'circulating-market-cap': '流通市值', 'share-equivalent-FDV': '份额等值 FDV', 'execution-FDV': '成交价折算 FDV' };
      if (event.demo !== true && value?.kind === 'event-snapshot' && Object.hasOwn(bases, value.basis) && Number.isSafeInteger(value.blockNumber) && value.blockNumber === event.blockNumber && stamp(event.timestamp) > 0 && stamp(value.timestamp) === stamp(event.timestamp) && positive(value.value) && unit(value.unit) && typeof value.source === 'string' && value.source.trim() && value.source.length <= 160) {
        raw = value.value; valueUnit = value.unit; basis = bases[value.basis]; source = value.source;
      }
    }
    if (!raw) { el.textContent = `${label} · 未知`; el.title = '缺少这笔交易发生时的已核验数据，不使用当前行情替代'; el.classList.add('unknown'); return el; }
    el.append(node('span', 'tracking-valuation-label', `${label}（${basis}）`), node('strong', '', `≈ ${referenceNumber(raw, metric === 'marketcap')} ${valueUnit}`));
    el.title = `${raw} ${valueUnit} · ${source || '事件记录'} · ${date(event.timestamp)} UTC+8${event.demo ? ' · DEMO' : ''}`;
    return el;
  }
  function walletAvatar(wallet) {
    const el = node('span', 'tracking-avatar');
    if(window.AgentWalletAvatar?.create)el.append(window.AgentWalletAvatar.create(wallet));
    else if (validAvatar(wallet.avatar)) { const img = node('img'); img.src = wallet.avatar; img.alt = ''; el.append(img); }
    else if (window.AgentWalletAvatar?.createDefault) el.append(window.AgentWalletAvatar.createDefault(wallet.address));
    else el.textContent = Array.from(wallet.note || short(wallet.address))[0]?.toUpperCase() || 'W';
    return el;
  }
  function publish() {
    const value = snapshot(); onChange(value); listeners.forEach(fn => fn(clone(value)));
    window.dispatchEvent(new window.CustomEvent('wallet-tracking-update', { detail: clone(value) }));
  }
  function renderStatus() {
    const status = data.status || {}, labels = { connecting: '连接中', syncing: '正在同步', idle: '等待关注', live: '实时追踪', demo: 'DEMO · 独立演示', delayed: '数据延迟', stale: '数据延迟', error: '连接异常', unavailable: '暂不可用', scanning: '正在追赶区块' };
    const stale = stamp(status.updatedAt) && Date.now() - stamp(status.updatedAt) > 60000 && data.wallets.length > 0 && status.state !== 'demo';
    $('tracking-status').textContent = `${labels[status.state] || '追踪状态待核验'}${stale ? ' · 更新延迟' : ''}${status.message ? ` · ${status.message}` : ''}`;
    $('tracking-status').className = `tracking-status ${['error', 'unavailable'].includes(status.state) ? 'error' : stale || ['delayed', 'stale', 'scanning', 'syncing'].includes(status.state) ? 'delayed' : status.state}`;
    const coverage = typeof status.coverage === 'string' ? status.coverage : '仅覆盖有限近期区块';
    $('tracking-coverage').textContent = `${coverage}${status.coveredFromBlock != null ? ` · 起点 ${status.coveredFromBlock}` : ' · 起点待确认'}${status.lastBlock != null ? ` → ${status.lastBlock}` : ''}${status.lagBlocks != null ? ` · 落后 ${status.lagBlocks} 块` : ''}`;
    $('tracking-updated').textContent = (status.updatedAt ? `更新 ${date(status.updatedAt)}` : '尚未完成读取')+(status.indexer?['live','observing'].includes(status.indexer.state)?' · 已接收币安推送':' · 币安推送连接中':'');
  }
  function render() {
    renderStatus(); $('tracking-wallet-count').textContent = String(data.wallets.length);
    ['marketcap', 'price'].forEach(value => $('tracking-metric-' + value).setAttribute('aria-pressed', String(value === metric)));
    $('tracking-manager-count').textContent = String(data.wallets.length);
    const wallets = $('tracking-wallets'), signature = JSON.stringify([data.wallets, writing]);
    if (signature !== walletSignature) {
      walletSignature = signature;
      const focused = document.activeElement, action = focused?.closest?.('[data-wallet-edit],[data-wallet-remove]');
      const focusAddress = action?.dataset.walletEdit || action?.dataset.walletRemove, focusKind = action?.dataset.walletEdit ? 'walletEdit' : 'walletRemove';
      wallets.replaceChildren();
      data.wallets.forEach(wallet => {
        const row = node('div', 'tracking-wallet'), info = node('div', 'tracking-wallet-info');
        info.append(node('strong', '', wallet.note || short(wallet.address)), node('span', 'mono', short(wallet.address))); info.title = wallet.address;
        const binding=window.AgentWalletAvatar?.verified(wallet),xUrl = xProfile(binding?.xUrl||wallet.xUrl);
        if (xUrl) { const link = node('a', 'tracking-x-link', binding?'X ↗ · 已绑定':'X ↗ · 手动关联'); link.href = xUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; info.append(link); }
        const actions = node('div', 'tracking-wallet-actions');
        const edit = node('button', '', '编辑'); edit.type = 'button'; edit.dataset.walletEdit = wallet.address; edit.setAttribute('aria-label', `编辑 ${wallet.note || short(wallet.address)}`); edit.disabled = writing; edit.addEventListener('click', () => openForm(wallet));
        const remove = node('button', '', '移除'); remove.type = 'button'; remove.dataset.walletRemove = wallet.address; remove.setAttribute('aria-label', `移除 ${wallet.note || short(wallet.address)}`); remove.disabled = writing; remove.addEventListener('click', () => removeWallet(wallet.address));
        actions.append(edit, remove); row.append(walletAvatar(wallet), info, actions); wallets.append(row);
      });
      if (focusAddress && !$('tracking-manager').hidden) {
        const replacement = [...wallets.querySelectorAll('button')].find(button => button.dataset[focusKind] === focusAddress);
        (replacement && !replacement.disabled ? replacement : $('tracking-add')).focus({ preventScroll: true });
      }
    }
    $('tracking-wallets-empty').hidden = data.wallets.length > 0;
    const watched = new Map(data.wallets.map(wallet => [key(wallet.address), wallet]));
    const ids = new Set();
    const indexed=(data.indexedEvents||[]).filter(event=>event?.confirmed===false&&event.evidence==='binance-indexed'&&['buy','sell'].includes(event.side));
    const events = [...data.events.filter(event=>event?.confirmed===true),...indexed].filter(event => {
      if (!event || !watched.has(key(event.walletAddress)) || !sideLabels[event.side] || ids.has(event.id)) return false;
      ids.add(event.id); return true;
    }).sort((a, b) => stamp(b.timestamp) - stamp(a.timestamp) || (b.blockNumber || 0) - (a.blockNumber || 0) || (b.logIndex || 0) - (a.logIndex || 0)).slice(0, 80);
    const nextSignalSignature=JSON.stringify([events,data.wallets,metric]);
    if(nextSignalSignature===signalSignature)return;
    signalSignature=nextSignalSignature;
    const signals = $('tracking-signals'); signals.replaceChildren();
    events.forEach(event => {
      const wallet = watched.get(key(event.walletAddress)), row = node('article', `tracking-signal ${event.side === 'buy' || event.side === 'sell' ? event.side : 'transfer'}`); row.dataset.eventId = event.id;
      const open = node('button', 'tracking-signal-open'); open.type = 'button'; open.disabled = !validAddress(event.tokenAddress); open.setAttribute('aria-label', `${wallet.note || short(wallet.address)} ${sideLabels[event.side]} ${event.tokenSymbol || '代币'}`);
      const body = node('span', 'tracking-signal-body'), title = node('span', 'tracking-signal-title');
      title.append(node('strong', '', wallet.note || short(wallet.address)), node('span', 'tracking-side', sideLabels[event.side]));
      const symbol = node('span', 'tracking-signal-token', event.tokenSymbol || event.tokenName || short(event.tokenAddress));
      const poolQuantity = String(event.source || '').includes('池计价量');
      const quantities = node('span', 'tracking-signal-amount', `${amount(event.tokenAmount)} ${event.tokenSymbol || 'TOKEN'}${event.quoteAmount != null ? ` · ${amount(event.quoteAmount)} ${event.quoteSymbol || '计价币待核验'}${poolQuantity ? '（池计价量）' : ''}` : ''}`);
      if(event.evidence==='binance-indexed'&&positive(event.indexerFields?.txUsdValue))quantities.append(node('span','',' · 索引成交额 ≈ '+referenceNumber(event.indexerFields.txUsdValue,false)+' USD'));
      const meta = node('span', 'tracking-signal-meta', `${date(event.timestamp)} · ${platforms[event.platformId] || '平台待核验'}${event.phase === 'graduated' ? ' · 已毕业' : ''}`);
      meta.title = String(event.source || '来源待核验');
      if (event.demo === true) meta.append(node('span', 'tracking-demo', ' · DEMO'));
      if(event.evidence==='binance-indexed'){row.classList.add('indexed');meta.append(node('span','tracking-indexed',' · 币安推送 · 待链上核验'));}
      body.append(title, symbol, signalValuation(event), quantities, meta); open.append(walletAvatar(wallet), body);
      open.addEventListener('click', async () => { try { await onSelect(clone(event)); closeMobile(); } catch (error) { $('tracking-status').textContent = `无法打开信号 · ${error.message}`; $('tracking-status').className = 'tracking-status error'; } });
      row.append(open);
      if (/^0x[\da-f]{64}$/i.test(event.txHash || '') && event.demo !== true) { const link = node('a', 'tracking-tx', '交易凭证 ↗'); link.href = `https://bscscan.com/tx/${event.txHash}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
      signals.append(row);
    });
    $('tracking-signals-empty').hidden = events.length > 0;
    $('tracking-signals-empty').textContent = data.wallets.length ? '当前覆盖范围内暂无已确认信号' : '关注钱包后显示已确认信号';
  }
  function apply(value) {
    if (!value || !Array.isArray(value.wallets) || !Array.isArray(value.events) || !value.status || typeof value.status !== 'object') throw new Error('本地追踪数据格式无效');
    data = { wallets: value.wallets.filter(wallet => wallet && validAddress(wallet.address)), events: value.events,indexedEvents:Array.isArray(value.indexedEvents)?value.indexedEvents:[], preferences: { showAvatars: value.preferences?.showAvatars !== false }, status: value.status };
    render(); publish();
  }
  function schedule() { clearTimeout(timer); timer = active&&!streamLive&&!streamPaused ? setTimeout(() => refresh(), fallbackDelay) : null; }
  function refresh({ discardPending = false } = {}) {
    if (discardPending && pending) { invalidateRead(); pending = null; }
    if (pending) return pending.promise;
    clearTimeout(timer); timer = null;
    const version = generation, controller = new AbortController(), request = { controller, promise: null }; pending = request;
    $('tracking-refresh').disabled = true;
    request.promise = (async () => {
      try { const value = await api('/api/tracking', undefined, { signal: controller.signal }); if (version === generation && !controller.signal.aborted) apply(value); }
      catch (error) { if (version === generation && !controller.signal.aborted) { data.status = { ...data.status, state: 'error', message: `${error.message} · 保留上次数据` }; renderStatus(); publish(); } }
      finally { if (pending === request) { pending = null; $('tracking-refresh').disabled = false; schedule(); } }
    })();
    return request.promise;
  }
  function invalidateRead() { generation++; if (pending) pending.controller.abort(); clearTimeout(timer); timer = null; }
  function formError(message = '') {
    $('tracking-form-error').textContent = message; $('tracking-form-error').hidden = !message;
    $('tracking-manager-error').textContent = message; $('tracking-manager-error').hidden = !message;
  }
  function focusableManagement() {
    return [...$('tracking-manager-panel').querySelectorAll('button,input,a[href]')].filter(element => !element.disabled && !element.hidden && !element.closest('[hidden]'));
  }
  function openManager({ focus = true, checked = false } = {}) {
    if (!checked && !canEdit()) return false;
    if ($('tracking-manager').hidden) {
      managerReturn = document.activeElement;
      closeMobile();
      $('tracking-manager').hidden = false;
      $('tracking-manage-open').setAttribute('aria-expanded', 'true');
      document.body.classList.add('tracking-manager-open');
      for (const element of document.querySelectorAll('.topbar, .wallet-tracking, .workspace, #tracking-backdrop')) {
        inertElements.set(element, element.hasAttribute('inert')); element.setAttribute('inert', '');
      }
    }
    if (focus) $('tracking-manager-close').focus({ preventScroll: true });
    return true;
  }
  function closeManager({ restoreFocus = true } = {}) {
    if ($('tracking-manager').hidden) return;
    closeForm({ restoreFocus: false });
    $('tracking-manager').hidden = true;
    $('tracking-manage-open').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('tracking-manager-open');
    for (const [element, wasInert] of inertElements) if (!wasInert) element.removeAttribute('inert');
    inertElements.clear();
    if (restoreFocus) {
      const target = managerReturn?.isConnected && !managerReturn.closest('[hidden]') ? managerReturn : $('tracking-manage-open');
      const hiddenRail = mobile() && !document.body.classList.contains('tracking-drawer-open');
      (hiddenRail && target.closest('#wallet-tracking') ? $('tracking-open') : target).focus({ preventScroll: true });
    }
    managerReturn = null;
  }
  function avatarPreview() { const preview = $('tracking-avatar-preview'); preview.replaceChildren(); if (validAvatar(avatar)) { const img = node('img'); img.src = avatar; img.alt = ''; preview.append(img); } else preview.textContent = '＋'; }
  function openForm(wallet) {
    if (!canEdit() || writing) return;
    openManager({ focus: false, checked: true });
    imageVersion++; avatar = validAvatar(wallet?.avatar) ? wallet.avatar : null;
    $('tracking-form').hidden = false; $('tracking-address').value = wallet?.address || ''; $('tracking-address').readOnly = Boolean(wallet);
    $('tracking-note').value = wallet?.note || ''; $('tracking-x').value = xProfile(wallet?.xUrl) || ''; $('tracking-avatar-file').value = '';
    $('tracking-save').disabled = writing;
    $('tracking-add').setAttribute('aria-expanded', 'true'); $('tracking-save').textContent = wallet ? '保存修改' : '保存关注'; formError(); avatarPreview(); $('tracking-address').focus({ preventScroll: true });
  }
  function closeForm({ restoreFocus = true } = {}) {
    const wasOpen = !$('tracking-form').hidden;
    imageVersion++; $('tracking-form').hidden = true; $('tracking-add').setAttribute('aria-expanded', 'false'); avatar = null; formError();
    if (wasOpen && restoreFocus && !$('tracking-manager').hidden) $('tracking-add').focus({ preventScroll: true });
  }
  function busy(value) { writing = value; $('tracking-save').disabled = value; $('tracking-add').disabled = value; $('tracking-cancel').disabled = value; for (const button of $('tracking-wallets').querySelectorAll('button')) button.disabled = value; }
  async function mutate(path, body) {
    if (!canEdit()) return false;
    invalidateRead(); busy(true);
    const version = ownerGeneration;
    try {
      const value = await api(path, body);
      if (version !== ownerGeneration) return false;
      if (value?.wallets && value?.events && value?.status) apply(value);
      else { if (pending) { const old = pending; pending = null; await Promise.resolve(); old.controller.abort(); } await refresh(); }
      return version === ownerGeneration;
    } catch (error) { if (version === ownerGeneration) formError(error.message); return false; }
    finally { if (version === ownerGeneration) { busy(false); render(); schedule(); } }
  }
  async function removeWallet(address) {
    if (writing) return;
    const owner = ownerGeneration, removed = await mutate('/api/tracking/wallet/remove', { address });
    if (owner !== ownerGeneration) return;
    if (removed) { if ($('tracking-address').value.toLowerCase() === key(address)) closeForm(); }
    else if (active) { $('tracking-status').textContent = `移除失败 · ${$('tracking-form-error').textContent}`; $('tracking-status').className = 'tracking-status error'; }
  }
  $('tracking-form').addEventListener('submit', async event => {
    event.preventDefault(); if (writing) return;
    const address = $('tracking-address').value.trim(), note = $('tracking-note').value.trim(), rawX = $('tracking-x').value.trim(), xUrl = xProfile(rawX);
    if (!validAddress(address)) return formError('请输入完整的 BSC 钱包地址');
    if (rawX && !xUrl) return formError('请输入有效的 X 个人主页：https://x.com/handle');
    if (note.length > 48) return formError('备注最多 48 个字符');
    formError(); if (await mutate('/api/tracking/wallet', { address, note, xUrl, avatar })) closeForm();
  });
  $('tracking-avatar-file').addEventListener('change', async () => {
    const file = $('tracking-avatar-file').files?.[0], version = ++imageVersion;
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) return formError('请选择小于 8 MB 的 PNG、JPEG 或 WebP 图片');
    $('tracking-save').disabled = true; formError();
    try {
      const raw = await new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取本地头像')); reader.readAsDataURL(file); });
      if (version !== imageVersion) return;
      const image = await new Promise((resolve, reject) => { const img = document.createElement('img'); img.onload = () => resolve(img); img.onerror = () => reject(new Error('无法解码本地头像')); img.src = raw; });
      if (version !== imageVersion) return;
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('头像图片尺寸无效');
      const canvas = document.createElement('canvas'), size = Math.min(image.naturalWidth, image.naturalHeight), context = canvas.getContext('2d'); canvas.width = 64; canvas.height = 64;
      if (!context) throw new Error('浏览器无法处理头像');
      context.fillStyle = '#151515'; context.fillRect(0, 0, 64, 64); context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 64, 64);
      let compact = ''; for (const quality of [0.78, 0.6, 0.42, 0.25]) { compact = canvas.toDataURL('image/jpeg', quality); if (validAvatar(compact)) break; }
      if (!validAvatar(compact)) throw new Error('头像压缩后仍过大，请换一张简单图片');
      avatar = compact; avatarPreview();
    } catch (error) { if (version === imageVersion) formError(error.message); }
    finally { if (version === imageVersion) $('tracking-save').disabled = writing; }
  });
  $('tracking-avatar-remove').addEventListener('click', () => { imageVersion++; avatar = null; $('tracking-avatar-file').value = ''; $('tracking-save').disabled = writing; avatarPreview(); });
  function mobile() { return window.innerWidth <= 800; }
  function expanded() { const open = mobile() ? document.body.classList.contains('tracking-drawer-open') : !document.body.classList.contains('tracking-collapsed'); $('tracking-open').setAttribute('aria-expanded', String(open)); $('tracking-collapse').setAttribute('aria-expanded', String(open)); $('tracking-collapse').setAttribute('aria-label', `${open ? '折叠' : '展开'}钱包信号`); $('tracking-backdrop').hidden = !mobile() || !open; }
  function closeMobile() { document.body.classList.remove('tracking-drawer-open'); expanded(); }
  $('tracking-open').addEventListener('click', () => { if (mobile()) document.body.classList.toggle('tracking-drawer-open'); else document.body.classList.toggle('tracking-collapsed'); expanded(); });
  $('tracking-collapse').addEventListener('click', () => { document.body.classList.toggle('tracking-collapsed'); expanded(); });
  $('tracking-close').addEventListener('click', closeMobile); $('tracking-backdrop').addEventListener('click', closeMobile);
  window.addEventListener('resize', expanded);
  document.addEventListener('keydown', event => {
    if ($('tracking-manager').hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeManager(); }
    else if (event.key === 'Tab') {
      const items = focusableManagement(), index = items.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && (index === items.length - 1 || index < 0)) { event.preventDefault(); items[0]?.focus(); }
    }
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('tracking-manager').hidden) closeMobile(); });
  $('tracking-manage-open').addEventListener('click', () => openManager());
  $('tracking-manager-close').addEventListener('click', () => closeManager());
  $('tracking-manager').addEventListener('click', event => { if (event.target === $('tracking-manager')) closeManager(); });
  $('tracking-add').addEventListener('click', () => openForm()); $('tracking-cancel').addEventListener('click', closeForm); $('tracking-refresh').addEventListener('click', refresh);
  ['marketcap', 'price'].forEach(value => $('tracking-metric-' + value).addEventListener('click', () => {
    if (metric === value) return;
    metric = value;
    try { window.localStorage?.setItem(metricKey, value); } catch { /* Keep switching usable if storage is blocked. */ }
    const scrollTop = $('tracking-signals').scrollTop; render(); $('tracking-signals').scrollTop = scrollTop;
  }));
  expanded(); render();
  return { start() { if (active) return pending?.promise || Promise.resolve(); active = true;streamPaused=false; return refresh(); }, stop() {
    active = false;streamLive=false; ownerGeneration++; invalidateRead(); pending = null; closeManager({ restoreFocus: false }); closeMobile(); closeForm({ restoreFocus: false }); busy(false);
    ['tracking-address','tracking-note','tracking-x','tracking-avatar-file'].forEach(id => { $(id).value = ''; }); avatarPreview();
    data = { wallets: [], events: [], preferences: { showAvatars: true }, status: { state: 'idle', message: '当前追踪会话已结束' } };
    $('tracking-refresh').disabled = false; render(); publish();
  }, applySnapshot(value){if(!active)return;invalidateRead();pending=null;$('tracking-refresh').disabled=false;apply(value);if(!streamLive)schedule();},setStreamState(live,{paused=false}={}){streamLive=live===true;streamPaused=paused;fallbackDelay=15000;if(streamLive||streamPaused){clearTimeout(timer);timer=null;}else if(active&&!pending)schedule();},snapshot, subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); }, refresh };
};
