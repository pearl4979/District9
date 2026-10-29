'use strict';

// 所有交易由本地服务预览和执行；浏览器不连接钱包、不签名、不广播。
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    session: null, tokens: [], orders: [], wallet: null, monitor: null,
    selectedAddress: null, selectedSnapshot: null, side: 'buy', preview: null,
    previewBusy: false, executeBusy: false, tokensLoaded: false,
    tokenError: null, walletError: null, previewVersion: 0,
    loading: { tokens: false, wallet: false, orders: false }, timers: new Set(),
    orderDrafts: new Map(), ordersSignature: null,
    position: null, positionError: null, positionBusy: false, positionVersion: 0,
    auth: null, authBusy: false, authPollBusy: false, executionBusy: false, walletVersion: 0, platform: 'all',
    directAction: null, activeIntent: null,
  };
  let toastTimer,walletRetryTimer,walletRetryAttempt=0;
  const executionRequested=()=>state.session?.executionPreference?.revision>0?state.session.executionPreference.enabled===true:state.session?.liveExecution===true;
  let trackingNavigationVersion = 0;
  let accountEpoch = 0;
  let recoveringSession = false;
  let accountChannel = null;
  let liveUpdates=null,marketStreamState='connecting',marketReadVersion=0;
  const tokenCards=new Map();
  const browserNow=()=>globalThis.performance?.now?.()??Date.now();
  const clientOrders=new Map();
  const tradeNotices=window.createTradeNotifications?.({getSymbol:order=>state.tokens.find(t=>t.address?.toLowerCase()===order.token?.toLowerCase())?.symbol||order.token?.slice(0,8)||''});
  const orderObserver = window.createOrderObserver?.({
    api, getOwner: () => !state.session || state.session.capabilities?.hosted && !state.session.account ? null : `${accountEpoch}:${state.session.mode}:${state.session.account?.id || 'local'}:${state.session.account?.walletAddress||state.wallet?.address||''}`,
    onOrders: (orders,metadata={}) => { state.orders = orders; if(!metadata.stale)for(const o of orders){const trace=clientOrders.get(o.id);if(trace&&o.receiptStatus===1&&['MINED','CONFIRMED'].includes(o.status))trace.firstReceiptUiMs??=Math.max(0,browserNow()-trace.clickedAt);} $('orders-error').hidden = !metadata.stale;if(metadata.stale)$('orders-error').textContent='历史订单快照；刷新钱包可重新读取，当前未实时核对回执。';renderOrders(); portfolio?.update(); },
    onError: error => { $('orders-error').textContent = error.message; $('orders-error').hidden = false; },
    onReceipt: () => { portfolio?.receiptObserved?.(); void loadWallet(true).catch(()=>{}); },
    onStatus: order=>tradeNotices?.update(order),
    onMetrics: metrics => { const e=$('order-refresh-metrics'); if(e){e.hidden=false;e.textContent=`状态读取 ${(metrics.requestMs/1000).toFixed(2)}秒 · 页面更新 ${metrics.renderMs.toFixed(0)}ms`; } },
  });
  const phaseLabels = { bonding: '内盘', graduated: '已毕业', launching: '发射中', unknown: '待确认' };
  const platforms = { four: { name: 'Four.meme', logo: '/assets/platform-four.svg', host: 'four.meme' }, gang: { name: 'Gang', logo: '/assets/platform-gang.svg', host: 'gang.fun' }, flap: { name: 'Flap', logo: '/assets/platform-flap.svg', host: 'flap.sh' } };
  const statusLabels = {
    pending: '等待确认', submitted: '已提交', broadcast: '已广播', broadcasting: '广播中',
    confirmed: '链上已确认', success: '服务端报告成功', failed: '失败', error: '失败',
    rejected: '已拒绝', simulated: '模拟完成', demo: '模拟完成', approved: '授权已确认',
    executing: '执行中', queued: '排队中', unknown: '结果待核实',
    DEMO_COMPLETED: '模拟完成', UNKNOWN: '结果待核实', SUCCESS: '服务端报告成功', FAILED: '失败',
    SUBMITTING: '提交中', BROADCASTED: '已广播', PENDING_CONFIRMATION: '等待钱包确认',
    MINED: '已打包 · 等待确认', CONFIRMED: '链上已确认', REVERTED: '链上已回滚',
    ROUTE_RUNNING:'路线进行中', ROUTE_PAUSED:'路线已暂停', ROUTE_FAILED:'路线未执行',
    MANUALLY_RELEASED: '已释放本地阻塞',
  };
  const tokenDetail = window.createTokenDetail({
    api, avatar: tokenAvatar, copy: copyText,
    canClose: () => !state.previewBusy && !state.executeBusy,
    onBack: () => { trackingNavigationVersion++; closeDrawer(); }, onTrade: () => openDrawer(),
    onSelect: address => { const token=state.tokens.find(t=>t.address.toLowerCase()===address.toLowerCase()); if(token)selectToken(token,state.side,true); },
    getPosition:()=>({wallet:state.wallet,walletError:state.walletError,position:state.position,positionError:state.positionError,positionBusy:state.positionBusy}),
    onRefresh:async()=>{if(state.previewBusy||state.executeBusy){showToast('订单处理中，请稍后刷新');return;}await Promise.allSettled([loadTokens(),loadPosition()]);},
  });
  const tradeFeedback=window.createTradeFeedback?.({api,onLimitChange:()=>{invalidatePreview();renderControls();}})||{limitBps:()=>300,setBusy(){},showRisk(){},clearRisk(){},start(){},finish(){}};
  const routeView=window.createTradeRouteView?.({onChange:()=>{$('amount-input').value='';invalidatePreview();renderSelection();}})||{update(){},settlement:()=> 'quote',showPlan(){},renderOrder:()=>document.createDocumentFragment(),choose(){},clear(){}};
  const portfolio=window.createPortfolio?.({api,getContext:()=>({session:state.session,wallet:state.wallet}),onOpen:address=>{const token=state.tokens.find(t=>t.address.toLowerCase()===address.toLowerCase());if(token){window.location.hash='#market';selectToken(token,state.side,true);}}});
  const profileView=window.createWalletProfilesView?.({api,getContext:()=>({session:state.session,wallet:state.wallet}),requireAccount:()=>accountAccess.requireAccount()});
  const preparationStatus=node('p','field-help'); preparationStatus.id='trade-preparation-status'; preparationStatus.setAttribute('role','status');preparationStatus.hidden=true;$('preview-button').before(preparationStatus);
  const directStatus=node('p','direct-order-status');directStatus.id='direct-order-status';directStatus.setAttribute('role','status');directStatus.hidden=true;
  const setupButton=node('button','button subtle full');setupButton.id='direct-setup-button';setupButton.type='button';setupButton.hidden=true;
  $('preview-button').before(directStatus,setupButton);
  const quickBar=node('div','card-quick-settings');quickBar.id='card-quick-settings';quickBar.hidden=true;
  const quickEnable=node('input');quickEnable.type='checkbox';quickEnable.id='card-quick-enabled';
  const quickLabel=node('label','','卡片快捷下单');quickLabel.prepend(quickEnable);
  const quickBuy=node('input');quickBuy.id='quick-buy-value';quickBuy.type='text';quickBuy.inputMode='decimal';quickBuy.placeholder='买入金额';quickBuy.setAttribute('aria-label','卡片快捷买入金额');
  const quickQuote=node('select');quickQuote.id='quick-buy-quote';quickQuote.setAttribute('aria-label','卡片买入金额币种');
  for(const symbol of ['BNB','WBNB','QQQB','U','USD1','USDT']){const option=node('option','',symbol);option.value=symbol;option.selected=symbol==='BNB';quickQuote.append(option);}
  const quickSell=node('input');quickSell.id='quick-sell-value';quickSell.type='text';quickSell.inputMode='decimal';quickSell.placeholder='卖出比例';quickSell.setAttribute('aria-label','卡片快捷卖出百分比');
  quickBar.append(quickLabel,node('span','','买'),quickBuy,quickQuote,node('span','','卖'),quickSell,node('span','','%'),node('small','','使用当前滑点和冲击上限；币种不符时打开设置'));
  $('market-status')?.before(quickBar);
  if(!quickBar.isConnected)document.querySelector('.market-status')?.before(quickBar);
  try{const saved=JSON.parse(window.localStorage?.getItem('district9.quick-orders')||'null');if(saved){quickBuy.value=String(saved.buy||'');quickSell.value=String(saved.sell||'');if([...quickQuote.children].some(o=>o.value===saved.quote))for(const option of quickQuote.children)option.selected=option.value===saved.quote;quickEnable.checked=saved.enabled===true;}}catch{}
  const directOrders=()=>state.session?.capabilities?.directOrders===true;
  function quickPreset(token,side){
    if(!directOrders()||!quickEnable.checked)return null;
    const raw=(side==='buy'?quickBuy:quickSell).value.trim();
    if(!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(raw)||!/[1-9]/.test(raw)||raw.length>80)return null;
    if(side==='buy'&&(token.quoteSymbol||'BNB')!==quickQuote.value&&!(quickQuote.value==='BNB'&&state.session?.capabilities?.bnbRoutes&&['gang','flap'].includes(token.platformId)))return null;
    if(side==='sell'){try{parseSellPercent(raw);}catch{return null;}}
    return raw;
  }
  for(const control of [quickEnable,quickBuy,quickQuote,quickSell])control.addEventListener('change',()=>{try{window.localStorage?.setItem('district9.quick-orders',JSON.stringify({buy:quickBuy.value,sell:quickSell.value,quote:quickQuote.value,enabled:quickEnable.checked}));}catch{}renderTokens();});
  const approvalsView=window.createTradeApprovals?.({api,getOwner:()=>state.wallet?.address?.toLowerCase(),isLive:()=>state.session?.mode==='live'&&executionRequested()});
  const rpcSettingsView=window.createRpcSettingsView?.({api,getOwner:()=>state.session?.capabilities?.hosted?state.session.account?.walletAddress:state.session?'local':null,getBusy:()=>state.previewBusy||state.executeBusy,onSwitch:()=>{tradePreparation?.cancel();invalidatePreview();renderControls();}});
  const conversionView=window.createAssetConversionView?.({api,getContext:()=>({address:state.wallet?.address,live:state.session?.mode==='live'&&executionRequested(),blocked:state.orders.some(o=>o.kind==='route'?o.blocksNewOrders===true:['SUBMITTING','UNKNOWN','BROADCASTED','PENDING_CONFIRMATION','MINED'].includes(o.status))}),getBusy:()=>state.previewBusy||state.executeBusy,onBusy:value=>{state.executeBusy=value;tradePreparation?.cancel();renderControls();},onResult:async result=>{if(result.order)acceptDirectOrder(result.order);await loadOrders();void loadWallet(true).catch(()=>{});}});
  const tradePreparation=window.createTradePreparation?.({
    api,getOwner:()=>`${accountEpoch}:${state.session?.account?.id||'local'}:${state.wallet?.address||''}`,getInput:tradeInput,
    canPrepare:()=>Boolean(state.session?.capabilities?.tradePreparation&&!state.previewBusy&&!state.executeBusy&&!state.preview&&!$('trade-drawer').hidden&&document.visibilityState!=='hidden'&&navigator.onLine!==false&&canTrade(selectedToken())&&walletReadiness().ready&&!state.tokenError&&!inputError()),
    onReady:result=>{if(result.readOnly!==true||Boolean(result.demo)!==(state.session?.mode==='demo')||result.summary?.walletAddress&&result.summary.walletAddress.toLowerCase()!==state.wallet?.address?.toLowerCase()){tradeFeedback.clearRisk();return false;}tradeFeedback.showRisk(result.summary?.tradeRisk);},
    onStatus:text=>{preparationStatus.textContent=text;preparationStatus.hidden=!text;},onError:error=>{if(error.tradeRisk)tradeFeedback.showRisk(error.tradeRisk);},
  });
  function clearPersonalState() {
    liveUpdates?.stop();
    clientOrders.clear();$('order-refresh-metrics').hidden=true;
    orderObserver?.stop();tradeNotices?.clear();clearTimeout(walletRetryTimer);walletRetryAttempt=0;
    tradePreparation?.cancel();
    accountEpoch++; approvalsView?.clear();rpcSettingsView?.clear();conversionView?.clear();portfolio?.clear();profileView?.clear();
    state.activeIntent=null;state.previewBusy=false;state.executeBusy=false;
    state.timers.forEach(timer => { clearTimeout(timer); clearInterval(timer); }); state.timers.clear();
    window.walletTracker?.stop(); tokenDetail.close();
    state.walletVersion++; state.positionVersion++; trackingNavigationVersion++;
    state.auth = null; state.wallet = null; state.walletError = null; state.position = null;
    state.orders = []; state.orderDrafts.clear(); state.ordersSignature = null;
    invalidatePreview(); renderAuth(); renderWallet(); renderOrders();
    $('tracking-wallets').replaceChildren(); $('tracking-signals').replaceChildren(); $('tracking-wallet-count').textContent = '0';
    $('tracking-form').hidden = true; ['tracking-address','tracking-note','tracking-x','tracking-avatar-file'].forEach(id => { $(id).value = ''; });
    $('tracking-avatar-preview').replaceChildren();
  }
  const accountAccess = window.createAccountAccess?.({ api, onSessionChange: session => {
    state.session = session; clearPersonalState();
    accountChannel?.postMessage({type:'session-changed'});
    window.location.reload();
  } }) || { setSession() {}, requireAccount: () => true };
  async function recoverAccountSession() {
    if (recoveringSession || !state.session?.capabilities?.hosted) return;
    recoveringSession = true;
    state.session = { ...state.session, account: null, liveExecution: false };
    clearPersonalState(); accountAccess.setSession(state.session);
    try {
      state.session = await api('/api/session'); renderMode(); window.location.reload();
    } catch {
      $('mode-notice').textContent = '账号会话已结束，当前个人数据已清空。请刷新页面重新登录。';
    }
  }
  function startAccountChannel() {
    if (!accountChannel && state.session?.capabilities?.hosted && window.BroadcastChannel) {
      accountChannel = new window.BroadcastChannel('district9-account-session');
      accountChannel.onmessage = event => { if (event.data?.type === 'session-changed') void recoverAccountSession(); };
    }
  }

  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined && content !== null) el.textContent = String(content);
    return el;
  }

  function display(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }

  function prettyTime(value, full = false) {
    if (!value) return '—';
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      ...(full ? { month: '2-digit', day: '2-digit' } : {}),
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(time);
  }

  function showToast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').className = `toast${error ? ' error' : ''}`;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
  }

  async function copyText(value) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const input = node('textarea', 'copy-fallback', value);
        input.setAttribute('readonly', '');
        document.body.append(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('复制失败');
      }
      showToast('完整地址已复制');
    } catch {
      showToast('无法自动复制，请选中完整地址手动复制。', true);
    }
  }

  async function api(path, body, { signal,keepalive=false } = {}) {
    const epoch = accountEpoch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), body ? 120000 : 20000);
    try {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', ...(keepalive?{keepalive:true}:{}),
        headers: { ...(state.session?.capabilities?.hosted && path !== '/api/session' && !['/api/account/login','/api/account/register'].includes(path) ? { 'X-Account-Context': state.session.account?.id || 'anonymous' } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.session.csrf } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      });
      let result;
      try { result = await response.json(); } catch { throw new Error('本地服务返回了无法解析的响应。'); }
      if (epoch !== accountEpoch) throw new Error('账号会话已切换，请等待页面刷新。');
      if (!response.ok) {
        if (result.code === 'SESSION_EXPIRED' || result.code === 'ACCOUNT_CHANGED' || response.status === 401 && !['/api/account/login','/api/account/register','/api/session'].includes(path)) void recoverAccountSession();
        throw Object.assign(new Error(display(result.error, `请求失败（${response.status}）`)), {status:response.status,code:result.code}, result.tradeRisk?{tradeRisk:result.tradeRisk}:{},result.timings?{timings:result.timings}:{});
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时。若正在执行交易，请先检查交易记录及链上状态，避免重复提交。');
      if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认终端服务仍在运行。');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  function formatUnitsExact(raw, decimals) {
    if (!/^\d+$/.test(String(raw)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('持仓数量格式无效。');
    const value = BigInt(raw).toString().padStart(decimals + 1, '0');
    if (!decimals) return value;
    const whole = value.slice(0, -decimals);
    const fraction = value.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  }

  function parseSellPercent(percent) {
    if (!/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/.test(String(percent))) throw new Error('请输入大于 0 且不超过 100 的百分比，最多两位小数。');
    const [whole, fraction = ''] = String(percent).split('.');
    const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (bps <= 0n || bps > 10000n) throw new Error('卖出比例必须大于 0 且不超过 100%。');
    return bps;
  }

  function positionPercent(balance, decimals, percent, step = '1') {
    if (!/^\d+$/.test(String(balance))) throw new Error('持仓数量格式无效。');
    let raw=BigInt(balance)*parseSellPercent(percent)/10000n;
    const unit=BigInt(step);if(unit<=0n)throw new Error('卖出单位无效。');raw=raw/unit*unit;
    return formatUnitsExact(raw,decimals);
  }

  function tokenAvatar(token) {
    const container = node('div', 'token-avatar');
    container.setAttribute('aria-hidden', 'true');
    const seed = token && token.address || 'FOUR-TERMINAL';
    let hash = 2166136261;
    for (const character of seed.toLowerCase()) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 8 8'); svg.setAttribute('shape-rendering', 'crispEdges');
    const colors = ['#7af7c2', '#ffd66b', '#8cbfff', '#e5a2ff', '#ff9da7'];
    const color = colors[hash % colors.length];
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 3; x++) {
        hash = Math.imul(hash ^ (y * 3 + x + 1), 16777619) >>> 0;
        if ((hash >>> 15) & 1) {
          for (const xx of [x + 1, 6 - x]) {
            const square = document.createElementNS(ns, 'rect');
            square.setAttribute('x', xx); square.setAttribute('y', y + 1);
            square.setAttribute('width', 1); square.setAttribute('height', 1); square.setAttribute('fill', color); svg.append(square);
          }
        }
      }
    }
    container.append(svg);
    const imageUrl = token && token.imageUrl;
    if (imageUrl) {
      try {
        const url = new URL(imageUrl, window.location.origin);
        if (url.origin === window.location.origin && /^\/(?:api\/token-image\/|assets\/demo-)/.test(url.pathname)) {
          const image = node('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
          image.addEventListener('error', () => image.remove(), { once: true });
          image.src = url.href; container.append(image);
        }
      } catch { /* Unknown metadata keeps the local deterministic identicon. */ }
    }
    const platform = token && platforms[token.platformId || 'four'];
    if (platform) {
      const mark = node('span', `platform-mark platform-${token.platformId || 'four'}`);
      mark.title = platform.name;
      const logo = node('img'); logo.src = platform.logo; logo.alt = platform.name;
      mark.append(logo); container.append(mark);
    }
    return container;
  }

  function positionAvailable() {
    try { return Boolean(state.position && state.wallet && state.position.token.toLowerCase() === state.selectedAddress && state.position.address.toLowerCase() === state.wallet.address.toLowerCase() && BigInt(state.position.balance) > 0n && !state.positionError); }
    catch { return false; }
  }

  function tradeAmount() {
    const input = $('amount-input').value.trim();
    if (state.side === 'buy') return input;
    if (state.positionBusy || !positionAvailable()) throw new Error('请先读取当前钱包的代币持仓。');
    const fair=selectedToken()?.launchType==='fair'&&selectedToken()?.pad==='merged'&&selectedToken()?.phase==='bonding';
    if(fair&&Number(state.position.decimals)!==18)throw new Error('Fair 份额精度无效，请刷新。');
    const amount = positionPercent(state.position.balance, Number(state.position.decimals), input, fair?'50000000000000000000000':'1');
    if (!/[1-9]/.test(amount)) throw new Error(fair?'该比例不足 1 整份，请提高退出比例；每份 50,000 代币。':'此比例对应的数量不足代币最小单位，请提高比例。');
    return amount;
  }

  function renderSellEstimate() {
    $('sell-estimate').hidden = state.side !== 'sell';
    if (state.side !== 'sell') return;
    let text = state.positionBusy ? '正在读取持仓…' : !positionAvailable() ? '读取持仓后自动计算卖出数量。' : '输入持仓百分比，或选择下方快捷比例。';
    if (!state.positionBusy && positionAvailable() && $('amount-input').value.trim()) {
      try { text = `预计卖出 ${tradeAmount()} ${selectedToken()?.positionKind === 'shares' ? '市场份额' : selectedToken()?.symbol || 'TOKEN'}${selectedToken()?.launchType==='fair'&&selectedToken()?.phase==='bonding'?' · 按整份向下取整':''}`; }
      catch (error) { text = error.message; }
    }
    $('sell-estimate').textContent = text;
  }

  function renderPosition() {
    tokenDetail.updatePosition?.();
    const position = state.position;
    let text = state.positionBusy ? '读取中…' : '—';
    if (position && !state.positionError) {
      try { text = formatUnitsExact(position.balance, Number(position.decimals)); }
      catch { text = '数据无效'; }
    }
    $('position-balance').textContent = text;
    $('position-label').textContent = selectedToken()?.positionKind === 'shares' ? '持有市场份额' : '持有代币';
    const token = selectedToken();
    let quote = '—';
    if(state.side==='buy'&&routeView.settlement(token,state.side)==='bnb')quote=`${state.wallet?.balance??'—'} BNB`;
    else if (position?.quoteBalance !== undefined) {
      try { quote = `${formatUnitsExact(position.quoteBalance, Number(position.quoteDecimals))} ${position.quoteSymbol}`; } catch { /* keep unknown */ }
    } else if ((token?.platformId || 'four') === 'four' && state.wallet?.balance !== null && state.wallet?.balance !== undefined) quote = `${state.wallet.balance} BNB`;
    $('quote-balance').textContent = quote;
    $('position-balance').title = position ? `授权额度：${display(position.allowance)}（原始单位） · ${prettyTime(position.updatedAt)}` : '';
    $('position-error').hidden = !state.positionError;
    $('position-error').textContent = state.positionError || '';
  }

  async function loadPosition(refresh = false) {
    const version = ++state.positionVersion;
    const token = selectedToken();
    const walletAddress = state.wallet?.address;
    state.position = null;
    if (state.side === 'sell') invalidatePreview();
    if (!token || !state.wallet || !walletReadiness().ready) {
      state.position = null; state.positionBusy = false; renderSelection(); return;
    }
    state.positionBusy = true; state.positionError = null; renderSelection();
    try {
      const result = await api(`/api/positions?token=${encodeURIComponent(token.address)}${refresh===true&&state.session?.viewMode==='shared'?'&refresh=1':''}`);
      if (version !== state.positionVersion) return;
      if (result.token?.toLowerCase() !== token.address.toLowerCase() || result.address?.toLowerCase() !== walletAddress?.toLowerCase() || state.wallet?.address?.toLowerCase() !== walletAddress?.toLowerCase()) throw new Error('钱包或代币已变化，请重新读取持仓。');
      if (!/^\d+$/.test(String(result.balance)) || !Number.isInteger(Number(result.decimals))) throw new Error('服务端持仓格式无效。');
      state.position = result;
    } catch (error) { if (version === state.positionVersion) { state.position = null; state.positionError = error.message; } }
    finally { if (version === state.positionVersion) { state.positionBusy = false; renderSelection(); if(state.side==='sell')tradePreparation?.schedule(); } }
  }

  function renderDataAge() {
    const time = state.monitor && new Date(state.monitor.updatedAt).getTime();
    const seconds = time && Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 1000)) : null;
    $('monitor-age').textContent = seconds === null ? '—' : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    $('monitor-age').classList.toggle('caution', seconds !== null && seconds > 60);
  }

  function authUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (url.hostname === 'binance.com' || url.hostname.endsWith('.binance.com')) && !url.username && !url.password ? String(value) : null;
    } catch { return null; }
  }

  function authActive() { return state.auth && ['WAITING_APP', 'VERIFYING'].includes(state.auth.status); }

  function renderAuth() {
    const auth = state.auth;
    $('auth-panel').hidden = !auth;
    if (!auth) return;
    const labels = { WAITING_APP: '等待 App 确认', VERIFYING: '正在验证连接', CONNECTED: '钱包已连接', EXPIRED: '配对已过期', ERROR: '连接未完成' };
    $('auth-status').textContent = labels[auth.status] || display(auth.status);
    $('auth-message').textContent = auth.message || (authActive() ? '在 Binance App 完成登录并核对配对码。此步骤不会发起交易。' : '');
    const rawExpiry = typeof auth.expireAt === 'number' || /^\d+$/.test(String(auth.expireAt)) ? Number(auth.expireAt) : new Date(auth.expireAt).getTime();
    const expiry = Number.isFinite(rawExpiry) && rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry;
    const remaining = Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - Date.now()) / 1000)) : null;
    $('auth-countdown').textContent = authActive() && remaining !== null ? remaining > 0 ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '等待状态确认' : '';
    const link = authActive() && authUrl(auth.urlForWeb);
    $('auth-link').hidden = !link; $('auth-link').href = link || '#';
    $('pairing-container').hidden = !authActive() || !auth.pairingCode;
    $('pairing-code').textContent = display(auth.pairingCode, '');
    if (authActive() || auth.pendingVerification === true) { $('wallet-connect').textContent = auth.pendingVerification ? '核对连接结果…' : '等待 App 连接'; $('wallet-connect').disabled = true; }
    else if (!state.authBusy) renderWalletConnect();
  }

  function renderWalletConnect() {
    const readiness = walletReadiness();
    $('wallet-connect').disabled = state.authBusy || authActive() || Boolean(state.auth && state.auth.pendingVerification) || Boolean(state.wallet && state.wallet.status === 'CREATING') || !state.session || Boolean(state.session.mode === 'demo') || readiness.ready;
    $('wallet-connect').textContent = state.authBusy ? '正在创建连接…' : readiness.ready ? '钱包已连接' : state.session && state.session.mode === 'demo' ? 'DEMO 钱包' : state.session?.capabilities?.hosted && !state.session.account ? '使用钱包登录' : state.session?.account?.walletAddress ? '重新连接 Agent 钱包' : '连接 Agent 钱包';
  }

  async function startAuth() {
    if (state.authBusy || !state.session || authActive() || state.auth && state.auth.pendingVerification) return;
    if (!accountAccess.requireAccount()) return;
    state.authBusy = true; state.auth = null; renderWalletConnect(); renderAuth();
    try {
      state.auth = await api('/api/auth/start', {});
      if (state.auth.status === 'CONNECTED') await syncConnectedSession();
    } catch (error) { state.auth = { status: 'ERROR', message: error.message }; }
    finally { state.authBusy = false; renderWalletConnect(); renderAuth(); }
  }

  async function pollAuthStatus() {
    if ((!authActive() && !(state.auth && state.auth.pendingVerification === true)) || state.authPollBusy) return;
    state.authPollBusy = true;
    try {
      const result = await api('/api/auth/status');
      state.auth = result;
      if (result.status === 'CONNECTED') { await syncConnectedSession(); showToast('Agent 钱包已连接。真实交易开关仍需手动开启。'); }
    } catch (error) { state.auth.message = error.message; }
    finally { state.authPollBusy = false; renderAuth(); }
  }

  async function syncConnectedSession() {
    // 登录完成后服务端关闭执行开关，并清理认证响应中的临时配对信息。
    state.auth = { status: 'CONNECTED', message: state.auth && state.auth.message };
    if (state.session) state.session.liveExecution = false;
    invalidatePreview(); renderMode();
    const session = await api('/api/session');
    if (!['live', 'demo'].includes(session.mode) || typeof session.csrf !== 'string') throw new Error('连接已完成，但会话刷新失败，请刷新页面。');
    state.session = session; renderMode();
    await loadWallet(true);
  }

  function renderExecutionSetting() {
    const session = state.session;
    const capped = session?.capabilities?.liveExecutionAllowed === false || session?.liveExecutionAllowed === false;
    const enabled = session?.mode==='live'&&executionRequested();
    const needsStop=session?.mode==='live'&&(enabled||session.liveExecution===null||session.executionRollout?.stopRequired||session.executionRollout?.repairRequired);
    $('execution-toggle').setAttribute('aria-checked', String(enabled));
    $('execution-toggle').setAttribute('aria-label', enabled ? '关闭真实交易' : '开启真实交易');
    $('execution-toggle').disabled = capped&&!needsStop || state.executionBusy || state.executeBusy || state.previewBusy || !session || session.mode === 'demo' || (!needsStop && !walletReadiness().ready);
    $('execution-toggle').setAttribute('aria-label', session && session.mode === 'demo' ? '演示模式不执行真实交易' : enabled ? '关闭真实交易' : '开启真实交易');
    $('execution-label').textContent = state.executionBusy?'更新中…':needsStop&&capped?'需核对并关闭':capped ? '服务端已关闭' : session && session.mode === 'demo' ? '演示模式' : enabled ? '已开启' : '未开启';
    if (capped) $('execution-toggle').setAttribute('aria-label',needsStop?'核对并关闭已有交易会话':'本次部署已关闭真实交易');
    if(directOrders()){
      document.querySelector('.execution-setting > p').textContent=capped?(needsStop?'服务端已限制新下单；请关闭仍开启或状态未知的交易会话。':'此部署尚未开放真实交易；买卖仅执行只读报价与模拟。'):'本钱包的交易模式会自动记住；连接恢复后无需重新开启，币安要求续期时会单独提示。';
      document.querySelector('.account-footnote').textContent='账号和关注记录跟随已验证的 BSC 钱包。登录不会开启真实交易；在另一设备登录会结束当前会话。';
      const attribution=document.querySelector('.chart-attribution');if(attribution?.lastChild?.nodeType===3)attribution.lastChild.textContent=' · 后台报价、模拟与风控始终生效';
    }
  }

  async function toggleExecution() {
    if ($('execution-toggle').disabled || !state.session) return;
    state.executionBusy = true; $('execution-error').hidden = true; renderExecutionSetting();
    try {
      const stopping=executionRequested()||state.session.liveExecution===null||state.session.executionRollout?.stopRequired||state.session.executionRollout?.repairRequired;
      const result = await api('/api/settings/execution', { enabled: stopping?false:!state.session.liveExecution });
      if(stopping&&result.liveExecution!==false)throw new Error('未核实关闭成功，请保持停止下单并重试关闭');
      state.session.liveExecution = result.liveExecution === true;
      state.session.executionPreference=result.executionPreference||{enabled:result.liveExecution===true,revision:(state.session.executionPreference?.revision||0)+1};
      if(typeof result.liveExecutionAllowed==='boolean')state.session.liveExecutionAllowed=result.liveExecutionAllowed;
      if(stopping&&state.session.executionRollout)state.session.executionRollout={...state.session.executionRollout,stopRequired:false,repairRequired:false};
      invalidatePreview(); renderMode(); renderSelection();
      showToast(state.session.liveExecution ? (directOrders()?'真实交易已开启；点击买卖即可下单，后台风控始终生效。':'真实交易已开启；每笔交易仍需预览并手动确认。') : '真实交易已关闭。');
    } catch (error) { $('execution-error').textContent = error.message; $('execution-error').hidden = false; }
    finally { state.executionBusy = false; renderExecutionSetting(); }
  }

  function selectedToken() {
    return state.tokens.find((token) => token.address.toLowerCase() === state.selectedAddress);
  }

  function canTrade(token) {
    return Boolean(token&&token.verified===true&&!token.sourceUnavailable&&(token.phase==='bonding'&&token.tradable===true||token.phase==='graduated'&&(state.session?.capabilities?.aggregator===true||token.tradable===true&&token.platformId==='gang'&&token.pad==='merged')));
  }

  function badge(text, tone = 'neutral') { return node('span', `badge ${tone}`, text); }

  function renderMode() {
    const session = state.session;
    if (!session) return;
    accountAccess.setSession(session);
    startAccountChannel();
    const demo = session.mode === 'demo';
    $('mode-badge').textContent = demo ? 'DEMO' : 'LIVE';
    $('mode-badge').className = `badge ${demo ? 'yellow' : 'green'}`;
    $('mode-notice').className = `mode-notice${demo ? ' demo' : ''}`;
    $('mode-notice').textContent = session.capabilities?.hosted
      ? session.viewMode==='shared'?`LIVE 实时行情 · 多人共用行情，个人数据隔离；${executionRequested()?'本钱包实盘选择已保存':session.capabilities?.liveExecutionAllowed||session.executionRollout?.operatorAllowed&&session.executionRollout?.mode==='public'?'实盘由每位用户自行开启':'真实交易关闭'}。`:session.account ? session.account.walletAddress ? 'LIVE 实时行情 · 钱包身份已验证；交易连接失效时需重新连接。关注记录随钱包保存，真实交易关闭。' : 'LIVE 实时行情 · 旧账号记录已保留，请通过钱包登录绑定；真实交易关闭。' : 'LIVE 实时行情 · 使用 Binance 钱包登录，自动恢复个人关注记录，无需注册；真实交易关闭。'
      : demo
      ? 'DEMO 演示模式 · 所有交易均为服务端模拟，不签名、不广播，也不会产生真实资产变动。'
      : executionRequested()
        ? 'LIVE 实时模式 · 当前连接 BNB Chain。确认执行将请求本地钱包发送真实交易并消耗 Gas。'
        : 'LIVE 实时行情 · 连接钱包后可预览，真实交易开关默认关闭。';
    $('mev-status').textContent = session.mev && session.mev.label || '防夹未验证';
    renderExecutionSetting();
  }

  function renderTokens() {
    const query = $('search-input').value.trim().toLowerCase();
    const onlyBonding = $('bonding-only').checked;
    const verified = state.tokens.filter((token) => token.verified === true);
    const visible = verified.filter((token) => (state.platform === 'all' || (token.platformId || 'four') === state.platform) && (!onlyBonding || token.phase === 'bonding') &&
      (!query || [token.address, token.name, token.symbol].some((value) => display(value, '').toLowerCase().includes(query))));
    const groups = { new: [], soon: [], graduated: [] };
    for (const token of visible) {
      // 进度为100不代表已经毕业，毕业必须来自协议状态。
      const stage = token.phase === 'graduated' ? 'graduated' : usdMarketCap(token) > 10_000 ? 'soon' : 'new';
      groups[stage].push(token);
    }
    const progressOrder = (token) => {
      const value = token.progress;
      return value === null || value === undefined || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value)) ? -Infinity : Number(value);
    };
    for (const [stage, tokens] of Object.entries(groups)) {
      tokens.sort((a, b) => stage === 'soon' ? progressOrder(b) - progressOrder(a) || (usdMarketCap(b) ?? -1) - (usdMarketCap(a) ?? -1) || creationOrder(b) - creationOrder(a) : creationOrder(b) - creationOrder(a));
      const list=$(`stage-${stage}-list`),wanted=[];
      for(const token of tokens){
        const key=`${token.platformId||'four'}:${token.address.toLowerCase()}`;
        const signature=JSON.stringify([token,token.address.toLowerCase()===state.selectedAddress,state.previewBusy,state.executeBusy,quickPreset(token,'buy'),quickPreset(token,'sell')]);
        let cached=tokenCards.get(key);
        if(!cached||cached.signature!==signature){cached={signature,node:tokenCard(token)};tokenCards.set(key,cached);}
        const age=cached.node.querySelector('.token-age'),label=tokenAge(token);if(age&&age.textContent!==label)age.textContent=label;
        wanted.push(cached.node);
      }
      const keep=new Set(wanted);for(const child of [...list.children])if(!keep.has(child))child.remove();
      wanted.forEach((card,index)=>{if(list.children[index]!==card)list.insertBefore(card,list.children[index]||null);});
      $(`stage-${stage}-count`).textContent = String(tokens.length);
      const empty = $(`stage-${stage}-empty`);
      empty.hidden = tokens.length > 0;
      empty.textContent = state.tokenError ? '行情读取失败，请检查来源状态' : !state.tokensLoaded ? '正在同步链上市场…' : stage === 'graduated' && onlyBonding ? '已开启“仅内盘”筛选' : query || state.platform !== 'all' ? '此列暂无符合筛选的代币' : { new: '等待新创建的代币', soon: '暂无美元市值超过 $10K 的未毕业代币', graduated: '暂无已毕业的代币' }[stage];
    }
    const knownCards=new Set(verified.map(t=>`${t.platformId||'four'}:${t.address.toLowerCase()}`));
    for(const key of tokenCards.keys())if(!knownCards.has(key))tokenCards.delete(key);
    $('token-count').textContent = String(verified.length);
    for (const id of ['all', 'four', 'gang', 'flap']) $(`count-${id}`).textContent = String(id === 'all' ? verified.length : verified.filter(t => (t.platformId || 'four') === id).length);
    $('verified-count').textContent = String(verified.length);
    $('visible-count').textContent = String(visible.length);
    $('market-empty').hidden = visible.length > 0;
    if (!visible.length) {
      if (state.tokenError) {
        $('empty-title').textContent = '代币列表暂时不可用';
        $('empty-description').textContent = state.tokenError;
      } else if (!state.tokensLoaded) {
        $('empty-title').textContent = '正在读取代币列表';
        $('empty-description').textContent = '正在同步 Gang、Flap 和 Four.meme 的 Agent 市场。';
      } else if (!verified.length) {
        $('empty-title').textContent = '暂未发现已核验的 Agent 市场';
        $('empty-description').textContent = '平台来源正在独立核验，请留意上方同步状态。读取失败不会被当作没有代币。';
      } else {
        $('empty-title').textContent = '没有符合筛选条件的代币';
        $('empty-description').textContent = '尝试其他名称、符号或合约地址，也可以取消“仅内盘”筛选。';
      }
    }
    renderSelection();
    tokenDetail.update(selectedToken() || state.selectedSnapshot);
  }

  function usdMarketCap(token) {
    const cap=token.marketCap;
    if(cap?.unit!=='USD'||cap.value===null||cap.value===undefined||cap.value==='')return null;
    const value=Number(cap.value);
    return Number.isFinite(value)&&value>=0?value:null;
  }

  function curveProgress(token) {
    return token.progress === null || token.progress === undefined || !Number.isFinite(Number(token.progress)) ? null : Math.max(0, Math.min(100, Number(token.progress)));
  }

  function creationOrder(token) { return (token.phase === 'graduated' && Date.parse(token.graduatedAt)) || Date.parse(token.createdAt) || Number(token.creationId) || token.createBlock || 0; }

  function tokenAge(token) {
    const timestamp = Date.parse(token.createdAt);
    if (!Number.isFinite(timestamp)) return '时间未知';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
  }

  // 仅用于行情展示，交易金额与百分比仍由原始字符串和 BigInt 计算。
  function marketNumber(value, compact = false) {
    const raw = display(value);
    if (!/^\d+(?:\.\d+)?$/.test(raw)) return raw;
    if (compact && Number(raw) >= 1000 && Number.isFinite(Number(raw))) {
      for (const [scale, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
        if (Number(raw) >= scale) return `${(Number(raw) / scale).toFixed(2).replace(/\.?0+$/, '')}${suffix}`;
      }
    }
    const tiny = raw.match(/^0\.(0{4,})([1-9]\d*)$/);
    if (tiny) return `0.0${String(tiny[1].length).replace(/\d/g, d => '₀₁₂₃₄₅₆₇₈₉'[d])}${tiny[2].slice(0, 5).replace(/0+$/, '')}`;
    const [whole, fraction] = raw.split('.');
    return fraction ? `${whole}.${fraction.slice(0, Math.max(2, 7 - whole.length)).replace(/0+$/, '')}`.replace(/\.$/, '') : whole;
  }

  function officialLink(token, className = 'official-market-link') {
    try {
      const url = new URL(token.officialUrl);
      if (url.protocol !== 'https:' || url.hostname !== platforms[token.platformId || 'four']?.host || url.username || url.password) return null;
      const link = node('a', className, '官方市场 ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      return link;
    } catch { return null; }
  }

  function tokenCard(token) {
    const fair=token.platformId==='gang'&&token.pad==='merged'&&token.launchType==='fair'&&token.phase!=='graduated',sale=fair&&token.fairSale?.verified===true?token.fairSale:null;
    const row = node('article', `token-card${token.address.toLowerCase() === state.selectedAddress ? ' selected' : ''}`);
    row.dataset.token = token.address.toLowerCase();
    const identity = node('div', 'token-identity');
    const avatarButton = node('button', 'avatar-trigger'); avatarButton.type = 'button'; avatarButton.setAttribute('aria-label', fair?`查看 ${token.symbol || token.name || '代币'} 的打新进度`:`查看 ${token.symbol || token.name || '代币'} 的K线`); avatarButton.append(tokenAvatar(token)); avatarButton.addEventListener('click', () => selectToken(token, state.side, true));
    identity.append(avatarButton);
    const nameBlock = node('div', 'token-name-block');
    const name = node('button', 'token-title', token.name || token.symbol || '未命名代币');
    name.type = 'button'; name.title = display(token.name || token.symbol); name.addEventListener('click', () => selectToken(token, state.side, true));
    const subline = node('div', 'token-subline');
    subline.append(node('span', 'token-symbol', token.symbol || '—'), node('span', 'token-platform-name', platforms[token.platformId || 'four']?.name || '未知平台'));
    const launchType=window.gangLaunchTypeLabel?.(token);
    if(launchType){const label=node('span','token-launch-type',launchType);label.title=`Gang 发行类型：${launchType}`;subline.append(label);}
    const address = node('button', 'address-copy', `${token.addressKind === 'market' ? 'Market' : 'CA'} ${token.address.slice(0, 6)}…${token.address.slice(-6)}`);
    address.type = 'button'; address.title = `复制完整地址：${token.address}`;
    address.setAttribute('aria-label', `复制 ${token.symbol || token.name || '代币'} 的完整合约地址`);
    address.addEventListener('click', () => copyText(token.address));
    nameBlock.append(name, subline, address); identity.append(nameBlock);
    const age = node('span', 'token-age', tokenAge(token)); age.title = prettyTime(token.createdAt, true); identity.append(age);
    const metrics = node('div', 'token-metrics');
    const price = node('div', 'price-cell'); price.title = `${display(fair?sale?.sharePrice:token.price)} ${token.priceUnit || token.quoteSymbol || 'BNB'}${fair?' / 份':''}`;
    price.append(node('span', 'metric-label',fair?'每份价格':token.priceSource==='verified-pool'?'池子参考价':token.phase === 'graduated' ? '曲线参考价' : '价格'), node('strong', '', marketNumber(fair?sale?.sharePrice:token.price)), node('span', 'price-unit', `${token.priceUnit || token.quoteSymbol || 'BNB'}${fair?' / 份':''}`));
    const volume = node('div', 'volume-cell'); volume.title = `${display(token.volume)} · ${token.volumeLabel || '口径未提供'}`;
    volume.append(node('span', 'metric-label', '成交量'), node('strong', 'volume-value', marketNumber(token.volume, true)), node('span', 'volume-label', token.volumeLabel || '口径未提供'));
    const cap = node('div', 'market-cap-cell');
    const m = token.marketCap;
    cap.title = m ? `${m.value} ${m.unit} · ${m.label} · ${m.source}` : '供应量或价格尚未核验';
    cap.append(node('span', 'metric-label', '市值 / FDV'), node('strong', 'cap-value', m ? `${m.unit === 'USD' ? '$' : ''}${marketNumber(String(m.value), true)}` : '—'), node('span', 'volume-label', m ? `${m.unit} · ${m.label}` : '待核验'));
    if(fair){
      cap.replaceChildren(node('span','metric-label','已认购'),node('strong','cap-value',sale?Number(sale.soldShares).toLocaleString('en-US'):'—'),node('span','volume-label',sale?`/ ${Number(sale.totalShares).toLocaleString('en-US')} 份`:'待核验'));
      cap.title=sale?`有效认购 ${sale.soldShares} / ${sale.totalShares} 份`:'打新份数待核验';
      volume.replaceChildren(node('span','metric-label','剩余份额'),node('strong','volume-value',sale?Number(sale.remainingShares).toLocaleString('en-US'):'—'),node('span','volume-label','份'));volume.title='可继续认购的有效份额';
    }
    metrics.append(price, cap, volume);
    const facts = node('div', 'card-facts');
    const taxRate = value => value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value)) ? `${Number(value)/100}%` : '待核验';
    const projectBuy=token.tokenTaxBuyBps ?? (token.platformId==='gang'?null:token.buyTaxBps), projectSell=token.tokenTaxSellBps ?? (token.platformId==='gang'?null:token.sellTaxBps);
    const tax=node('span','',`税 ${taxRate(projectBuy)} / ${taxRate(projectSell)}${token.tokenTaxScope?` · ${token.tokenTaxScope}`:''}`);
    tax.title='项目买税 / 卖税；不代表内盘所有费用，详情查看适用阶段及去向。';
    facts.append(tax,node('span','',`底币 ${token.quoteSymbol||'待核验'}`));
    if(token.platformId==='gang'&&token.phase==='bonding')facts.append(node('span','',fair?`认购费 ${taxRate(sale?.mintFeeBps)}`:`平台费 ${taxRate(token.protocolBuyFeeBps)}`));
    const dev=node('span','card-dev',`Dev ${token.creatorName|| (token.creator?`${token.creator.slice(0,6)}…${token.creator.slice(-4)}`:'待核验')}`);
    dev.title=`${token.creator||'创建者未读取'} · ${token.creatorNameSource||'点击详情查询链上 Agent ID'}`; facts.append(dev);
    facts.title=Array.from(facts.children,element=>element.textContent).join(' · ');
    const footer = node('div', 'card-footer');
    const curve = node('div', 'card-curve'); const progress = curveProgress(token);
    curve.append(node('span', 'progress-label', token.phase === 'graduated' ? '已毕业' : token.phase === 'launching' ? '发射中' : progress === null ? '进度待确认' : `${token.launchType==='fair'?'打新':'曲线'} ${progress.toFixed(fair?2:1)}%`));
    if (progress !== null) { const bar = node('progress', 'curve-progress'); bar.max = 100; bar.value = progress; bar.setAttribute('aria-label', `${fair?'打新':'Curve'} 进度 ${progress.toFixed(fair?2:1)}%`); curve.append(bar); }
    const actions = node('div', 'row-actions');
    for (const side of ['buy', 'sell']) {
      const preset=quickPreset(token,side);
      const button = node('button', `row-action${side === 'sell' ? ' sell' : ''}`, preset?`${side==='buy'?'买':'卖'} ${preset}${side==='buy'?(token.quoteSymbol||'BNB'):'%'}`:side === 'buy' ? '买入' : '卖出');
      button.type = 'button'; button.disabled = !canTrade(token)||state.previewBusy||state.executeBusy;
      button.title = canTrade(token) ? `${side === 'buy' ? '买入' : '卖出'} ${token.symbol || token.name || token.address}` : token.reason || '当前市场不可交易';
      button.addEventListener('click', () => { void cardOrder(token,side).catch(error=>showToast(error.message,true)); });
      actions.append(button);
    }
    footer.append(curve, actions); row.append(identity, metrics, facts, footer);
    row.addEventListener('click', event => { if (!event.target.closest('button,a')) selectToken(token, state.side, true); });
    if (!canTrade(token)) {
      const status = node('div', 'card-availability'); status.append(node('span', '', token.phase === 'graduated' ? (state.session?.capabilities?.aggregator?'币安聚合 · 下单时核验':'外盘暂未接入') : token.reason || phaseLabels[token.phase] || '当前不可交易'));
      status.title=token.reason||'当前市场仅供查看；未接入交易';
      const link = officialLink(token); if (link) status.append(link); row.append(status);
    }
    return row;
  }

  function openDrawer(target = 'trade') {
    state.drawerReturn = target;
    $('trade-drawer').hidden = false; document.body.classList.add('drawer-open');
    $('wallet-open').setAttribute('aria-expanded', 'true');
    if (target === 'wallet') $('wallet-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    else $('trade-drawer').scrollTop = 0;
  }

  function closeDrawer() {
    if (state.previewBusy || state.executeBusy) return;
    invalidatePreview(); tradePreparation?.cancel(); $('trade-drawer').hidden = true; document.body.classList.remove('drawer-open');
    $('wallet-open').setAttribute('aria-expanded', 'false');
    const target = state.drawerReturn === 'wallet' ? $('wallet-open') : document.querySelector(`[data-token="${state.selectedAddress}"] .row-action${state.side === 'sell' ? '.sell' : ':not(.sell)'}`) || $('wallet-open');
    target.focus({ preventScroll: true });
  }

  function renderMonitor() {
    const monitor = state.monitor || {};
    const status = monitor.status || 'unknown';
    const live = ['live', 'running', 'watching', 'connected', 'ready', 'healthy'].includes(status);
    const problem = state.tokenError || ['error', 'failed', 'disconnected'].includes(status);
    const names = { live: '监控运行中', degraded: '部分来源可用', backfill: '历史补扫中', starting: '正在同步', running: '监控运行中', watching: '监控运行中', connected: '已连接', ready: '监控就绪', healthy: '监控正常', scanning: '扫描中', syncing: '同步中', demo: '演示数据', disabled: '监控未启用', error: '监控异常', failed: '监控异常', disconnected: '已断开', pending: '等待验证', idle: '等待数据', unknown: '等待监控' };
    $('monitor-status').textContent = names[status] || status;
    $('monitor-status').className = `badge ${problem ? 'red' : live ? 'green' : 'yellow'}`;
    $('monitor-message').textContent = state.tokenError || display(monitor.message, '等待监控服务返回状态。');
    $('connection-dot').className = `status-dot ${problem ? 'error' : state.tokensLoaded ? 'connected' : ''}`;
    $('connection-label').textContent = problem ? '连接需检查' : state.tokensLoaded ? liveUpdates?marketStreamState==='live'?'行情实时推送':marketStreamState==='paused'?'后台已暂停推送':'推送连接中 · 备用轮询':'每 5 秒同步' : '等待连接';
    const indexed=monitor.realtime;
    if(indexed)$('connection-label').title=['live','observing'].includes(indexed.state)?'已接收币安公共实时推送；钱包索引信号会明确标注待链上核验':'币安实时流连接中；公共行情与链上扫描独立运行';
    $('monitor-block').textContent = display(monitor.lastBlock);
    $('monitor-template').textContent = 'Gang / Flap / Four';
    for (const id of ['gang', 'flap', 'four']) {
      const source = monitor.sources?.find(s => s.id === id);
      const dot = $(`health-${id}`);
      dot.className = `source-dot ${source?.status === 'error' ? 'error' : ['live', 'demo'].includes(source?.status) ? 'live' : 'pending'}`;
      dot.parentElement.title = source ? `${platforms[id].name} · ${names[source.status] || source.status} · ${source.message}${source.truncated ? ' · 仅覆盖最近市场' : ''}` : `${platforms[id].name} · 等待同步`;
    }
    $('monitor-registry').textContent = display(monitor.registry);
    $('monitor-manager').textContent = display(monitor.manager);
    $('monitor-updated').textContent = prettyTime(monitor.updatedAt, true);
    const sourceErrors = monitor.sources?.filter(s => !['live', 'demo'].includes(s.status)).map(s => `${s.name}: ${s.message}`).join('；');
    const diagnosticError = state.tokenError || monitor.error || monitor.lastError || sourceErrors;
    $('monitor-error').hidden = !diagnosticError;
    $('monitor-error').textContent = diagnosticError ? `监控详情：${display(diagnosticError)}` : '';
    renderDataAge();
    $('market-updated').textContent = monitor.updatedAt ? `更新于 ${prettyTime(monitor.updatedAt)}` : state.tokensLoaded ? '已收到服务端数据' : '尚未更新';
  }

  function selectToken(token, side = state.side, detail = false) {
    if (state.previewBusy || state.executeBusy) return;
    trackingNavigationVersion++;
    openDrawer();
    if (state.selectedAddress !== token.address.toLowerCase()) $('amount-input').value = '';
    state.selectedAddress = token.address.toLowerCase();
    state.selectedSnapshot = token;
    state.position = null;
    state.positionError = null;
    setSide(side, false);
    invalidatePreview();
    renderTokens();
    const position=loadPosition(state.session?.viewMode==='shared');
    if (detail) tokenDetail.open(token);
    return position;
  }

  async function cardOrder(token,side){
    if(state.previewBusy||state.executeBusy)return;
    const preset=quickPreset(token,side),epoch=accountEpoch,wallet=state.wallet?.address?.toLowerCase(),walletVersion=state.walletVersion,slippage=$('slippage-input').value,impact=tradeFeedback.limitBps();
    const position=selectToken(token,side);
    if(!preset){$('amount-input').focus({preventScroll:true});return;}
    if(side==='buy')routeView.choose(quickQuote.value==='BNB'?'bnb':'quote');
    // Hold selection while the exact wallet/token balance for this click loads.
    state.previewBusy=true;renderControls();
    try{if(side==='sell')await position;if(epoch!==accountEpoch||walletVersion!==state.walletVersion||wallet!==state.wallet?.address?.toLowerCase()||state.side!==side||state.selectedAddress!==token.address.toLowerCase()||slippage!==$('slippage-input').value||impact!==tradeFeedback.limitBps())return;
      $('amount-input').value=preset;invalidatePreview();
    }finally{if(epoch===accountEpoch){state.previewBusy=false;renderControls();}}
    if(epoch===accountEpoch)await requestDirectOrder();
  }

  async function selectTrackingEvent(event) {
    if (state.previewBusy || state.executeBusy) return;
    const address = String(event.tokenAddress || '').toLowerCase();
    if (!/^0x[\da-f]{40}$/.test(address)) throw new Error('该信号缺少已核验的市场地址');
    const version = ++trackingNavigationVersion;
    let token = state.tokens.find(value => value.address.toLowerCase() === address);
    if (!token) {
      const result = await api(`/api/tracking/token?token=${encodeURIComponent(address)}`);
      token = result.token || result;
    }
    if (version !== trackingNavigationVersion || state.previewBusy || state.executeBusy) return;
    if (!token || token.verified !== true || token.address?.toLowerCase() !== address) throw new Error('该市场尚未保存在本机核验范围内');
    if (state.selectedAddress !== address) $('amount-input').value = '';
    state.selectedAddress = address;
    state.selectedSnapshot = token;
    state.position = null; state.positionError = null;
    invalidatePreview(); renderTokens();
    tokenDetail.open(token); tokenDetail.focusEvent?.(event);
  }

  function setSide(side, invalidate = true) {
    // BNB 金额与持仓百分比不是同一单位，切换方向时不继承旧输入。
    if (state.side !== side) $('amount-input').value = '';
    state.side = side;
    ['buy', 'sell'].forEach((value) => {
      $(`side-${value}`).classList.toggle('active', side === value);
      $(`side-${value}`).setAttribute('aria-pressed', String(side === value));
    });
    $('amount-label').textContent = side === 'buy' ? '买入金额' : '卖出比例';
    $('amount-input').placeholder = side === 'buy' ? '0.00' : '0';
    $('quick-amounts').hidden = side !== 'buy';
    $('sell-amounts').hidden = side !== 'sell';
    $('preview-button').classList.toggle('sell', side === 'sell');
    if (invalidate) invalidatePreview();
    renderSelection();
  }

  function renderSelection() {
    const token = selectedToken();
    const selected = token || state.selectedSnapshot;
    routeView.update({token:selected,side:state.side,enabled:state.session?.capabilities?.bnbRoutes===true,busy:state.previewBusy||state.executeBusy});
    const fairMint=selected?.platformId==='gang'&&selected?.pad==='merged'&&selected?.launchType==='fair'&&selected?.phase==='bonding';
    $('amount-label').textContent=state.side==='buy'?(fairMint?'打新预算':'买入金额'):(fairMint?'退出比例':'卖出比例');
    if (token) state.selectedSnapshot = token;
    $('selected-name').textContent = selected ? selected.name || selected.symbol || '未命名代币' : '选择一个代币';
    $('selected-symbol').textContent = selected ? `${selected.symbol || '—'}${selected.positionKind === 'shares' ? ' · 内盘市场份额' : ''}` : '从左侧列表开始';
    $('selected-address').textContent = selected ? `${selected.addressKind === 'market' ? 'Market · ' : 'CA · '}${selected.address}` : '尚未选择合约';
    const platform = selected && platforms[selected.platformId || 'four'];
    $('selected-platform').textContent = platform ? platform.name : '尚未选择平台';
    const official = $('selected-official'); official.hidden = true; official.removeAttribute('href');
    if (selected?.officialUrl && platform) {
      try { const url = new URL(selected.officialUrl); if (url.protocol === 'https:' && url.hostname === platform.host && !url.username && !url.password) { official.href = url.href; official.hidden = false; } } catch { /* no external link */ }
    }
    $('selected-token-address').hidden = !selected?.predictedToken;
    $('selected-token-address').textContent = selected?.predictedToken ? `${selected.tokenAddress ? '已发射 CA' : '预计 CA · 尚未发射'}：${selected.tokenAddress || selected.predictedToken}` : '';
    const avatar = $('selected-avatar');
    const avatarKey = selected ? `${selected.platformId}:${selected.address}:${selected.imageUrl || ''}` : 'placeholder';
    if (avatar.dataset.tokenKey !== avatarKey) {
      avatar.replaceChildren(...tokenAvatar(selected).childNodes);
      avatar.dataset.tokenKey = avatarKey;
    }
    $('selected-avatar').classList.toggle('placeholder-avatar', !selected);
    $('selected-phase').hidden = !selected;
    $('selected-phase').textContent = token ? fairMint?'打新中':phaseLabels[token.phase] || '待确认' : '未在列表';
    $('selected-phase').className = `badge ${token && token.phase === 'bonding' ? 'green' : 'neutral'}`;
    const quoteSymbol = selected?.quoteSymbol || 'BNB';
    const nativeSettlement=routeView.settlement(selected,state.side)==='bnb';
    const paySymbol=nativeSettlement?'BNB':quoteSymbol;
    const unit = state.side === 'buy' ? (nativeSettlement?'BNB':selected?.pad==='merged'&&quoteSymbol==='WBNB'?'BNB / WBNB':quoteSymbol) : '%';
    $('amount-unit').textContent = unit;
    $('amount-suffix').textContent = unit;
    document.querySelectorAll('[data-amount]').forEach((button, index) => {
      const amounts = ['BNB', 'WBNB'].includes(paySymbol) ? ['0.01', '0.05', '0.1'] : ['10', '50', '100'];
      button.dataset.amount = amounts[index]; button.textContent = `${amounts[index]} ${paySymbol}`;
    });
    let hint = '请先选择已验证、可交易的内盘代币。';
    let warning = false;
    if (state.selectedAddress && !token) { hint = '当前扫描未列出此代币，交易暂不可用。'; warning = true; }
    else if (token && !canTrade(token)) { hint = token.reason || '代币或交易路径尚未通过核验。'; warning = true; }
    else if (state.tokenError) { hint = '市场数据同步失败，恢复连接后才能创建新的交易预览。'; warning = true; }
    else if (state.session && state.session.mode === 'live' && !walletReadiness().ready) { hint = walletReadiness().message; warning = true; }
    else if (state.session && state.session.mode === 'live' && !executionRequested() && token) { hint = '真实执行设置未开启，可查看预览；执行按钮保持禁用。'; warning = true; }
    else if (token) { hint = fairMint?(state.side==='buy'?`按预算购买整数份额，每份 50,000 代币；费用、实际支付币种和未使用预算见预览。`:`按整份退出并收回 ${quoteSymbol}，不需要授权锁定的代币；退出费见预览。`):state.side === 'buy' ? `输入 ${quoteSymbol} 报价金额；Gas 另付 BNB。${quoteSymbol === 'WBNB' ? selected?.pad==='merged'?'可用时直接支付 BNB，否则先预览包装；最终币种以预览为准。':'余额不足时先预览 BNB 包装。' : ''}` : token.positionKind === 'shares' ? `按市场份额比例卖出，收回 ${quoteSymbol}；无需授权份额。` : `按当前持仓比例卖出，收回 ${quoteSymbol}；额度不足时先预览精确授权。`; }
    if(fairMint&&!hint.includes('50,000'))hint+=' Fair 按整份打新或退出，每份 50,000 代币；费用以逐笔预览为准。';
    if(selected?.phase==='graduated'&&state.session?.capabilities?.aggregator)hint+=' 外盘走币安聚合，以 BNB 支付或到账；必要时经 USDT。以后台路线核验为准。';
    else if(nativeSettlement)hint+=selected?.pad==='merged'&&selected?.phase==='graduated'?` 使用已核验路由，以 BNB 支付或到账，逐跳检查流动性。`:` ${state.side==='buy'?`先将 BNB 兑换为 ${quoteSymbol}，确认到账后重新报价买入`:`先卖出取得 ${quoteSymbol}，再兑换为 BNB`}；后一步失败时底币保留在钱包。`;
    if(directOrders())hint=hint.replaceAll('逐笔预览','后台报价').replaceAll('先预览包装','先完成包装').replaceAll('先预览 BNB 包装','先完成 BNB 包装').replaceAll('先预览精确授权','先完成本次精确授权').replaceAll('以预览为准','以后台报价为准').replaceAll('见预览','见后台报价');
    $('trade-hint').textContent = hint;
    $('trade-hint').className = `trade-hint${warning ? ' warning' : ''}`;
    renderPosition();
    renderControls();
  }

  function inputError() {
    let amount;
    try { amount = tradeAmount(); } catch (error) { return error.message; }
    if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(amount) || !/[1-9]/.test(amount) || amount.length > 80) return '请输入大于 0 的十进制金额，最多 18 位小数，不使用逗号或科学计数法。';
    const slippage = Number($('slippage-input').value);
    if (!Number.isInteger(slippage) || slippage < 10 || slippage > 5000) return '滑点需为 10–5000 之间的整数 bps。';
    if (state.side === 'sell' && state.position) {
      try {
        const decimals = Number(state.position.decimals);
        const [whole, fraction = ''] = amount.split('.');
        if (fraction.length > decimals) return `该代币最多支持 ${decimals} 位小数。`;
        const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
        if (raw > BigInt(state.position.balance)) return '卖出数量超过当前持有余额。';
      } catch { return '持仓数据格式无效，请刷新余额后重试。'; }
    }
    return null;
  }

  function renderControls() {
    conversionView?.update();
    const busy = state.previewBusy || state.executeBusy;
    const unresolvedExecution=state.session?.liveExecution===null&&!executionRequested()||state.session?.executionRollout?.stopRequired||state.session?.executionRollout?.repairRequired||state.session?.liveExecution===true&&(state.session?.liveExecutionAllowed===false||state.session?.capabilities?.liveExecutionAllowed===false);
    routeView.update({token:selectedToken()||state.selectedSnapshot,side:state.side,enabled:state.session?.capabilities?.bnbRoutes===true,busy});
    tradeFeedback.setBusy(busy);
    const walletReady = state.session && (state.session.mode === 'demo' || walletReadiness().ready);
    $('preview-button').disabled = !state.session || unresolvedExecution || !canTrade(selectedToken()) || !walletReady || Boolean(state.tokenError) || busy || (state.side === 'sell' && (state.positionBusy || !positionAvailable()));
    const verb=state.side==='buy'?'买入':'卖出';
    $('preview-button').firstElementChild.textContent = state.previewBusy ? (directOrders()?'正在报价与风控…':'正在获取预览…') : state.executeBusy ? '正在提交…' : directOrders()?(state.session.mode==='demo'?`模拟${verb}`:executionRequested()?verb:`${verb} · 仅预演`):`预览${verb}`;
    quickBar.hidden=!directOrders();
    for(const control of [quickEnable,quickBuy,quickQuote,quickSell])control.disabled=busy;
    document.querySelectorAll('.row-action').forEach(button=>{const token=state.tokens.find(t=>t.address.toLowerCase()===button.closest('[data-token]')?.dataset.token?.toLowerCase());if(token)button.disabled=busy||!canTrade(token);});
    const footnote=document.querySelector('.preview-footnote');if(footnote)footnote.textContent=directOrders()?(state.session.mode==='demo'?'演示模式：一键模拟，不签名、不广播':executionRequested()?'点击即提交；后台报价、模拟和风控始终生效':'实盘关闭：点击仅只读预演，不签名、不提交'):'先检查交易预览，再确认执行';
    $('side-buy').disabled = busy;
    $('side-sell').disabled = busy;
    $('drawer-close').disabled = busy;
    $('wallet-open').disabled = busy;
    $('detail-back').disabled = busy;
    $('amount-input').disabled = busy;
    $('slippage-input').disabled = busy;
    document.querySelectorAll('[data-slippage]').forEach((button) => {
      button.disabled = busy; button.classList.toggle('active', Number(button.dataset.slippage) === Number($('slippage-input').value));
    });
    document.querySelectorAll('[data-amount]').forEach((button) => { button.disabled = busy; });
    document.querySelectorAll('[data-percent]').forEach((button) => {
      button.disabled = busy || state.positionBusy || !positionAvailable();
      let active = false;
      try { active = state.side === 'sell' && parseSellPercent($('amount-input').value.trim()) === BigInt(button.dataset.percent) * 100n; } catch { /* 空输入或非法比例不选中快捷项。 */ }
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('position-refresh').disabled = busy || state.positionBusy || !state.selectedAddress || !walletReady;
    renderSellEstimate();
    $('slippage-warning').hidden = Number($('slippage-input').value) < 300;
    $('slippage-description').textContent = `${$('slippage-input').value || '—'} bps = ${Number($('slippage-input').value || 0) / 100}% · 可调 0.1%–50%，不改变价格冲击上限。`;
    $('confirm-preview').disabled = busy;
    $('close-preview').disabled = busy;
    renderExecutionSetting();
    updateExpiry();
  }

  function invalidatePreview() {
    tradeFeedback.clearRisk();
    routeView.clear();
    state.previewVersion += 1;
    state.preview = null;
    state.directAction=null;setupButton.hidden=true;directStatus.hidden=true;
    $('preview-panel').hidden = true;
    $('confirm-preview').checked = false;
    $('trade-error').hidden = true;
    renderControls();
    tradePreparation?.schedule();
  }

  function renderRisk(target, value, missing) {
    const el = $(target);
    if (value === undefined || value === null) { el.textContent = missing; return; }
    if (Array.isArray(value)) {
      if (!value.length) { el.textContent = '服务端返回空列表；这不构成安全保证。'; return; }
      const list = node('ul');
      value.forEach((item) => list.append(node('li', '', display(item))));
      el.replaceChildren(list);
    } else { el.textContent = display(value); }
  }

  function renderPreview() {
    const preview = state.preview;
    if (!preview) return;
    const approval = preview.kind === 'approve';
    const wrap = preview.kind === 'wrap';
    const demo = preview.demo === true;
    $('preview-title').textContent = wrap ? 'BNB → WBNB 包装预览' : approval ? '授权交易预览' : `${state.side === 'buy' ? '买入' : '卖出'}交易预览`;
    $('preview-kind').textContent = approval
      ? `${demo ? 'DEMO · ' : ''}本次仅授权当前所需额度。授权确认后，请重新预览交易。`
      : wrap ? '本次仅将 BNB 包装为 WBNB。确认后重新预览买入。' : demo ? 'DEMO · 本次仅模拟，不会签名或广播真实交易。' : '本次执行会请求本地钱包发送真实链上交易。';
    renderSummary(preview.summary);
    tradeFeedback.showRisk(preview.summary?.tradeRisk);
    $('preview-to').textContent = display(preview.transaction.to);
    $('preview-value').textContent = display(preview.transaction.value);
    $('preview-data').textContent = display(preview.transaction.data);
    const raw = preview.raw || {};
    const walletConfirmation=node('p','field-help',demo?'DEMO · 未调用真实签名或广播':raw.requireConfirmation===true?'钱包要求本人在 Binance App 确认，本平台不能代点':raw.requireConfirmation===false?'钱包预览未要求额外 App 确认；实际提交结果仍需核对':'钱包未明确是否需 App 确认，不能承诺直接广播');
    walletConfirmation.id='preview-wallet-confirmation';$('preview-wallet-confirmation')?.remove();$('preview-raw').closest('details').before(walletConfirmation);
    const simulation = raw.simulationResult || {};
    renderRisk('preview-risks', raw.risks, '服务端未返回 risks 字段，请核对完整解析结果。');
    renderRisk('preview-authority', simulation.authorityChanges ?? raw.authorityChanges, '服务端未返回 authorityChanges 字段，请核对完整解析结果。');
    renderRisk('preview-balances', simulation.balanceChanges ?? raw.balanceChanges, '服务端未返回 balanceChanges 字段，请核对完整解析结果。');
    renderRisk('preview-allowances', simulation.allowanceChanges ?? raw.allowanceChanges, '服务端未返回 allowanceChanges 字段，请核对完整解析结果。');
    $('preview-raw').textContent = display(preview.raw, '服务端未返回 raw 解析结果。');
    $('confirm-preview').checked = false;
    $('confirm-label').textContent = wrap ? '我已核对包装金额，理解本次将 BNB 转为 WBNB，买入需要另行预览确认。' : approval
      ? '我已核对授权对象、授权额度、风险和权限变化，理解本次只执行授权。'
      : demo ? '我已核对交易参数，理解本次为演示模拟，不会产生真实交易。' : '我已核对目标、金额、调用数据、风险和权限变化，同意执行真实交易。';
    $('execute-button').textContent = demo ? wrap ? '确认模拟包装' : approval ? '确认模拟授权' : '确认模拟交易' : wrap ? '确认并包装' : approval ? '确认并授权' : '确认并执行';
    $('execute-button').classList.toggle('sell', state.side === 'sell' && !approval);
    $('execute-hint').textContent = !demo && !executionRequested() ? '当前服务为只读模式，无法执行真实交易。' : approval || wrap ? '完成此准备步骤后，等待成功回执，再重新预览交易。' : '提交后请通过交易记录及链上回执确认实际结果。';
    $('preview-panel').hidden = false;
    updateExpiry();
  }

  function renderSummary(summary) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      $('preview-summary').textContent = display(summary, '服务端未提供交易摘要，请逐项核对以下原始交易。');
      return;
    }
    const labels = {
      platformId: '发射台', quoteSymbol: '支付/收回币种', positionKind: '持仓类型', estimatedShares: '预计获得份额', minShares: '最少获得份额', estimatedRefund: '预计退款', feeNote: '费用说明',
      estimatedTokens: '预计获得代币', minTokens: '最少获得代币', estimatedSpend: '预计支出 · BNB',
      estimatedReceive: '预计收到 · BNB', minReceive: '最少收到 · BNB', estimatedGasCost: '预估 Gas 预算 · BNB',
      buyTaxBps: '买入税', sellTaxBps: '卖出税', allowance: '本次授权数量', spender: '被授权合约',
      budget: '买入预算 · BNB', amount: '输入数量', side: '交易方向', token: '代币合约', symbol: '代币符号',
      antiSniperEnabled: '防狙击开关', slippageBps: '滑点容差', estimatedTotalFee: '预计总费用 · BNB',
      estimatedGas: '预计 Gas 数量', mode: '运行模式', action: '执行说明', requiresNewPreview: '需要重新预览',
      priceImpactBps: '预估价格影响', mevProtection: '防夹保护',
      fairShares:'本次打新 / 退出份数',tokensPerShare:'每份代币数量',unspentBudget:'未使用预算',fairRewardLost:'是否永久失去打新分红资格',routeKind:'交易路径',quotedWith:'报价依据',phase:'市场阶段',refundCurrency:'退款币种',appliedTokenTaxBps:'本次项目税',protocolFeeBps:'本次平台手续费',deadline:'链上截止时间戳',
      simulated: '已完成链上模拟', minAmountOutRaw: '最少代币输出 · 原始值', minQuoteReceiveRaw: '最少报价币输出 · 原始值',
    };
    const first = ['estimatedTokens', 'minTokens', 'estimatedSpend', 'estimatedReceive', 'minReceive', 'estimatedGasCost', 'buyTaxBps', 'sellTaxBps', 'allowance', 'spender'];
    for(const [key,label]of Object.entries({estimatedSpend:'预计支出',estimatedReceive:'预计净收到',minReceive:'最低净收到',estimatedTotalFee:'已知交易费',unspentBudget:'未使用预算'}))labels[key]=`${label} · ${summary.quoteSymbol||'BNB'}`;
    for(const [key,label]of Object.entries({estimatedRefund:'预计退款',estimatedProbeFee:'探针报告费用',estimatedCurveAllocation:'曲线分配',estimatedReserveAllocation:'其余储备预算'}))labels[key]=`${label} · ${summary.quoteSymbol||'BNB'}`;
    const hiddenFields=new Set(['tradeRisk','maxPriceImpactBps','feeScope']);
    const fields = [...first.filter((key) => Object.hasOwn(summary, key)), ...Object.keys(summary).filter((key) => !first.includes(key)&&!hiddenFields.has(key))];
    const list = node('dl', 'summary-grid');
    for (const key of fields) {
      const value = summary[key];
      let formatted = typeof value === 'boolean' ? value ? '是' : '否' : display(value);
      if (key.endsWith('Bps') && value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) formatted = `${Number(value) / 100}%（${value} bps）`;
      if (key === 'mevProtection' && value === 'unverified') formatted = '未验证';
      if (key === 'priceImpactBps' && (value === null || value === undefined)) formatted = '未提供';
      if (key === 'side') formatted = value === 'buy' ? '买入' : value === 'sell' ? '卖出' : display(value);
      if (key === 'platformId') formatted = platforms[value]?.name || formatted;
      if (key === 'positionKind' && value === 'shares') formatted = '市场账本份额';
      const label = ['estimatedSpend', 'estimatedReceive', 'minReceive', 'budget', 'estimatedTotalFee'].includes(key) ? `${(labels[key] || key).split(' · ')[0]} · ${summary.quoteSymbol || 'BNB'}` : labels[key] || key;
      list.append(node('dt', '', label), node('dd', '', formatted));
    }
    $('preview-summary').replaceChildren(list);
  }

  function updateExpiry() {
    const preview = state.preview;
    if (!preview) { $('execute-button').disabled = true; return; }
    const expiry = new Date(preview.expiresAt).getTime();
    const seconds = Math.ceil((expiry - Date.now()) / 1000);
    const valid = Number.isFinite(expiry) && seconds > 0;
    $('preview-expiry').textContent = valid ? `预览剩余 ${seconds} 秒 · 到期后需重新获取` : '预览已过期或有效期无效，请重新获取。';
    const modeConsistent = Boolean(state.session && (state.session.mode === 'demo') === (preview.demo === true));
    const executionAllowed = modeConsistent && (preview.demo === true || executionRequested() && state.session.capabilities?.liveExecutionAllowed !== false);
    const walletReady = preview.demo === true || walletReadiness().ready;
    $('execute-button').disabled = !valid || !executionAllowed || !walletReady || !$('confirm-preview').checked || state.executeBusy || state.previewBusy || !canTrade(selectedToken()) || Boolean(state.tokenError);
  }

  function tradeInput() {
    if(inputError())throw new Error(inputError());
    return {token:selectedToken().address,side:state.side,platformId:selectedToken().platformId||'four',...(routeView.settlement(selectedToken(),state.side)==='bnb'?{settlement:'bnb'}:{}),...(selectedToken().platformId==='flap'&&selectedToken().phase!=='graduated'&&state.side==='sell'?{sellPercentBps:Number(parseSellPercent($('amount-input').value.trim()))}:{}),amount:tradeAmount(),slippageBps:Number($('slippage-input').value),maxPriceImpactBps:tradeFeedback.limitBps()};
  }

  async function requestPreview(event) {
    event.preventDefault();
    if(directOrders())return requestDirectOrder();
    if ($('preview-button').disabled) return;
    const validationError = inputError();
    if (validationError) { $('trade-error').textContent = validationError; $('trade-error').hidden = false; return; }
    let maxPriceImpactBps;
    try{maxPriceImpactBps=tradeFeedback.limitBps();}catch(error){$('trade-error').textContent=error.message;$('trade-error').hidden=false;return;}
    invalidatePreview();
    const version = state.previewVersion;
    state.previewBusy = true;
    tradePreparation?.cancel();
    renderControls();
    tradeFeedback.start('preview');
    let timings,message='预览未完成';
    try {
      const result = await api('/api/preview', tradeInput());
      if (version !== state.previewVersion) return;
      if (!result.id || !result.transaction || !result.transaction.to || typeof result.transaction.data !== 'string') throw new Error('服务端返回的交易预览不完整，无法执行。');
      if ((state.session.mode === 'demo') !== (result.demo === true)) throw new Error('预览模式与当前会话不一致，请刷新页面确认服务运行模式。');
      if(result.walletAddress?.toLowerCase()!==state.wallet?.address?.toLowerCase())throw new Error('钱包已发生变化，请刷新钱包后重新预览。');
      state.preview = result;
      timings=result.timings;message=result.preparation?.reused?'已复用新鲜报价 · 等待逐笔确认':'预览已就绪，等待逐笔确认';
      renderPreview();
      ($('trade-risk-panel') && !$('trade-risk-panel').hidden ? $('trade-risk-panel') : $('preview-panel')).scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      timings=error.timings;
      if(error.tradeRisk)tradeFeedback.showRisk(error.tradeRisk);
      $('trade-error').textContent = error.message;
      $('trade-error').hidden = false;
    } finally {
      tradeFeedback.finish(timings,message);
      state.previewBusy = false;
      renderControls();
    }
  }

  function acceptDirectOrder(order,clickedAt){
    if(!order?.id)throw new Error('订单状态缺失，请检查订单记录后再操作');
    clientOrders.set(order.id,{clickedAt,responseMs:Math.max(0,browserNow()-clickedAt),...(order.txHash?{firstHashUiMs:Math.max(0,browserNow()-clickedAt)}:{})});
    if(clientOrders.size>200)clientOrders.delete(clientOrders.keys().next().value);
    state.orders=[order,...state.orders.filter(o=>o.id!==order.id)];orderObserver?.seed(state.orders);renderOrders();
    tradeNotices?.update(order);
    void Promise.allSettled([loadOrders(),loadWallet(true),loadTokens()]);
  }
  async function requestDirectOrder(){
    if($('preview-button').disabled||state.previewBusy||state.executeBusy)return;
    let input;try{input=tradeInput();}catch(error){$('trade-error').textContent=error.message;$('trade-error').hidden=false;return;}
    tradePreparation?.handoff?.();invalidatePreview();tradePreparation?.cancel();
    const version=state.previewVersion,epoch=accountEpoch,wallet=(state.session.account?.walletAddress||state.wallet?.address)?.toLowerCase(),intentId=crypto.randomUUID(),clickedAt=browserNow();
    state.activeIntent=intentId;state.previewBusy=true;renderControls();tradeFeedback.start('place');
    let timings,message='请求未完成，请检查订单状态';
    try{
      const result=await api('/api/order',{input,intentId,expectedWallet:wallet});
      if(epoch!==accountEpoch)return;
      if(result.intentId!==intentId||Boolean(result.demo)!==(state.session.mode==='demo')||result.walletAddress?.toLowerCase()!==wallet||(state.session.account?.walletAddress||state.wallet?.address)?.toLowerCase()!==wallet)throw new Error('订单的钱包或会话已变化，请检查订单记录');
      timings={...result.timings,...(result.gatewayTimings?{gatewayQueueMs:result.gatewayTimings.queueMs,gatewayTotalMs:result.gatewayTimings.totalMs}:{})};tradeFeedback.showRisk(result.summary?.tradeRisk);
      if(result.route&&result.status==='PREVIEW_ONLY')routeView.showPlan(result.route);
      if(result.status==='PREVIEW_ONLY'&&result.readOnly===true&&result.submitted===false){message='仅预演 · 未签名、未提交真实交易';}
      else if(result.status==='ACTION_REQUIRED'&&['approve','wrap'].includes(result.action?.kind)&&result.submitted===false){
        if(version!==state.previewVersion){message='准备步骤已生成，但交易参数已变化，请重新下单';directStatus.textContent=message;directStatus.hidden=false;showToast(message);return;}
        state.directAction={...result.action,version,epoch,wallet};
        message=result.action.kind==='approve'?'需要先授权代币额度；本次尚未买卖':'需要先包装 BNB → WBNB；本次尚未买入';
        setupButton.textContent=result.action.kind==='approve'?'授权本次精确额度':'执行 BNB → WBNB 包装';setupButton.hidden=false;
        setupButton.disabled=state.session.liveExecutionAllowed===false||(!executionRequested()&&state.session.mode!=='demo');
        const summary=result.summary||{};
        if(result.action.kind==='approve'){
          const allowance=summary.requiredAllowance||summary.approvalAmount||summary.allowance;
          message+=`。资产合约 ${result.action.transaction?.to||'未知'}；授权对象 ${summary.spender||'未核验'}；精确额度 ${allowance||'未核验'}；${display(summary.action,'')}`;
          if(!/^0x[\da-fA-F]{40}$/.test(summary.spender||'')||!allowance)setupButton.disabled=true;
        }else{
          let amount='未核验';try{amount=formatUnitsExact(BigInt(result.action.transaction.value).toString(),18);}catch{setupButton.disabled=true;}
          message+=`。包装数量 ${amount} BNB；目标 ${result.action.transaction?.to||'未知'}；${display(summary.action,'')}`;
        }
        message+=`。钱包风险与权限信息：${display({risks:result.action.raw?.risks,authorityChanges:result.action.raw?.simulationResult?.authorityChanges,allowanceChanges:result.action.raw?.simulationResult?.allowanceChanges},'未提供')}`;
      }else if(result.order&&(result.submitted===true||result.submitted===false&&result.order.kind==='route'&&(['ROUTE_FAILED','ROUTE_PAUSED'].includes(result.order.status)||result.queued===true&&result.order.route?.kind==='single-setup'&&result.order.status==='ROUTE_RUNNING'))){
        const order=result.order;
        if(order.intentId&&order.intentId!==intentId||order.walletAddress&&order.walletAddress.toLowerCase()!==wallet)throw new Error('返回订单的钱包或下单意图不匹配，请检查交易记录');
        acceptDirectOrder(order,clickedAt);
        if(['ROUTE_FAILED','ROUTE_PAUSED','UNKNOWN'].includes(order.status)){
          const reason=order.error||order.steps?.find(step=>step.error)?.error||'请展开交易明细核对具体原因';
          const evidence=order.steps?.some(step=>step.submissionAttempted===true||step.txHash||step.orderId||['SUBMITTING','UNKNOWN','MARKET_PENDING','PENDING_CONFIRMATION','BROADCASTED','MINED'].includes(step.status));
          message=order.status==='UNKNOWN'?`提交结果待核实：${reason}。请检查交易明细，勿重复提交。`:result.submitted===false&&!evidence?`未提交交易：${reason}`:`路线已停止：${reason}。请核对已完成步骤及钱包余额；不会自动重试。`;
          $('trade-error').textContent=message;$('trade-error').hidden=false;
        }else message=state.session.mode==='demo'?'模拟下单完成 · 未发送真实交易':order.route?.kind==='single-setup'&&order.steps?.some(s=>s.role==='target'&&s.status==='PLANNED')?'授权确认中，完成后自动继续本次买卖，无需再次点击':`${statusLabels[order.status]||'结果待核实'} · 以订单及链上回执为准`;
      }
      else throw new Error('未知下单结果，请检查订单记录，勿重复提交');
      directStatus.textContent=message;directStatus.hidden=false;showToast(message);
    }catch(error){if(epoch!==accountEpoch)return;timings=error.timings;if(error.tradeRisk)tradeFeedback.showRisk(error.tradeRisk);$('trade-error').textContent=error.message;$('trade-error').hidden=false;void loadOrders().catch(()=>{});}
    finally{if(state.activeIntent===intentId){tradeFeedback.finish(timings,message);state.activeIntent=null;state.previewBusy=false;renderControls();}}
  }
  async function requestDirectSetup(){
    const action=state.directAction;if(!action||setupButton.disabled||state.previewBusy||state.executeBusy)return;
    if(action.version!==state.previewVersion||action.epoch!==accountEpoch||action.wallet!==state.wallet?.address?.toLowerCase()||Date.now()>=action.expiresAt){invalidatePreview();return;}
    const clickedAt=browserNow(),epoch=accountEpoch;state.directAction=null;setupButton.hidden=true;state.executeBusy=true;renderControls();tradeFeedback.start('execute');
    let timings,message='设置操作结果待核实';
    try{const order=await api('/api/execute',{previewId:action.id,confirmed:true});if(epoch!==accountEpoch)return;acceptDirectOrder(order,clickedAt);timings=order.timings;message='设置操作已返回，请核对状态；完成后重新点击买卖';directStatus.textContent=message;directStatus.hidden=false;}
    catch(error){if(epoch===accountEpoch){$('trade-error').textContent=error.message;$('trade-error').hidden=false;void loadOrders().catch(()=>{});}}
    finally{if(epoch===accountEpoch){tradeFeedback.finish(timings,message);state.executeBusy=false;renderControls();}}
  }
  setupButton.addEventListener('click',requestDirectSetup);

  async function executePreview() {
    updateExpiry();
    if ($('execute-button').disabled || !state.preview || state.executeBusy) return;
    const previewId = state.preview.id;
    const clickedAt=browserNow();
    state.executeBusy = true;
    $('execute-button').textContent = '正在提交，请勿重复操作…';
    renderControls();
    tradeFeedback.start('execute');
    let timings,message='提交结果需要核实';
    try {
      const order = await api('/api/execute', { previewId, confirmed: true });
      timings=order?.timings;message='提交请求已返回，请核对订单状态';
      if (order && order.id) {
        clientOrders.set(order.id,{clickedAt,responseMs:Math.max(0,browserNow()-clickedAt),...(order.txHash?{firstHashUiMs:Math.max(0,browserNow()-clickedAt)}:{})});
        if(clientOrders.size>200)clientOrders.delete(clientOrders.keys().next().value);
        state.orders = [order, ...state.orders.filter((existing) => existing.id !== order.id)];
        orderObserver?.seed(state.orders);tradeNotices?.update(order);
        renderOrders();
      }
      showToast('执行请求已返回，请查看交易记录中的实际状态。');
      void Promise.allSettled([loadOrders(), loadWallet(true), loadTokens()]);
    } catch (error) {
      timings=error.timings;
      if(error.tradeRisk)tradeFeedback.showRisk(error.tradeRisk);
      $('trade-error').textContent = `${error.message} 请先检查交易记录和链上状态，再决定是否重新预览。`;
      $('trade-error').hidden = false;
      showToast('执行结果需要核实，请查看错误详情与交易记录。', true);
      void loadOrders().catch(()=>{});
    } finally {
      tradeFeedback.finish(timings,message);
      // 执行尝试后销毁本次预览，防止超时或重试造成重复交易。
      state.preview = null;
      state.previewVersion += 1;
      $('preview-panel').hidden = true;
      $('confirm-preview').checked = false;
      state.executeBusy = false;
      renderControls();
    }
  }

  function walletReadiness() {
    const wallet = state.wallet;
    const error = state.walletError || wallet && wallet.error;
    let label;
    let message;
    if (state.session?.capabilities?.hosted && !state.session.account) {
      return { ready: false, label: '未登录', message: '登录 District9 后，连接你自己的 Agent 钱包。' };
    } else if(state.session?.capabilities?.hosted&&state.session.account?.walletAddress&&(!wallet?.address||wallet.address.toLowerCase()===state.session.account.walletAddress.toLowerCase())&&wallet?.status!=='UNCONNECTED'&&wallet?.status!=='CREATING'&&(state.walletError||!wallet||wallet.status==='SLEEPING'||wallet.stale===true||wallet.status==='CONNECTED'&&wallet.error)){
      return{ready:true,label:state.walletError?'连接恢复中':'已登录 · 自动恢复',message:'钱包身份已保存，下单时自动恢复交易连接。'};
    } else if (state.walletError) {
      label = '读取失败'; message = '本地钱包信息读取失败，请检查服务后刷新。';
    } else if (wallet?.status==='SLEEPING'||wallet?.stale===true) {
      label = '按需刷新'; message = wallet.message||'钱包身份已验证；当前显示历史快照，点击刷新读取最新余额。';
    } else if (!wallet || !wallet.available) {
      label = '不可用';
      message = /ENOENT|not found|未安装/i.test(display(error, ''))
        ? '未检测到 baw。请先在终端安装并配置 Binance Agent Wallet（baw），再刷新此页面。'
        : '本地 baw 钱包不可用，请先完成安装和配置。';
    } else if (wallet.status === 'UNCONNECTED') {
      label = '未连接'; message = '点击“连接 Agent 钱包”，在 Binance App 完成配对。';
    } else if (wallet.status === 'CREATING') {
      label = '创建中'; message = 'Agent 钱包正在创建，完成后刷新钱包状态。';
    } else if (error) {
      label = '部分读取失败'; message = '部分钱包信息查询失败，请检查下方错误，恢复后再交易。';
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(wallet.address || '')) {
      label = '地址未就绪'; message = '尚未取得 BSC 钱包地址，请连接钱包后刷新。';
    } else if (wallet.status !== 'CONNECTED' && (!state.session || state.session.mode !== 'demo')) {
      label = '状态待确认'; message = '尚未确认钱包登录状态，请检查本地 baw 后刷新。';
    } else {
      return { ready: true, label: '已就绪', message: '' };
    }
    if (error) message += ` 查询详情：${display(error)}`;
    return { ready: false, label, message };
  }

  function renderWallet() {
    conversionView?.update();
    approvalsView?.update();
    rpcSettingsView?.update();
    orderObserver?.update();
    const wallet = state.wallet;
    const readiness = walletReadiness();
    $('wallet-status').textContent = readiness.label;
    $('wallet-status').className = `badge ${readiness.ready ? 'green' : 'yellow'}`;
    $('wallet-address').textContent = wallet && wallet.address || '未连接本地钱包';
    $('wallet-address').disabled = !(wallet && wallet.address);
    $('wallet-balance').replaceChildren(document.createTextNode(display(wallet && wallet.balance)), node('small', '', ' BNB'));
    $('wallet-error').hidden = readiness.ready;
    $('wallet-error').textContent = readiness.message;
    $('wallet-cli').textContent = display(wallet && wallet.cliVersion);
    renderWalletConnect();
    $('wallet-refresh').disabled = state.loading.wallet;
    renderExecutionSetting();
    const quota = wallet && wallet.quota;
    $('quota-date').textContent = display(quota && quota.date);
    $('quota-used').textContent = display(quota && quota.quotaUsed);
    $('quota-left').textContent = display(quota && quota.quotaLeft);
    $('quota-limit').textContent = display(quota && quota.dailyLimit);
    const limit = Number(quota && quota.dailyLimit);
    const used = Number(quota && quota.quotaUsed);
    $('quota-progress').value = limit > 0 && Number.isFinite(used) ? Math.min(100, Math.max(0, used / limit * 100)) : 0;
    const dev = wallet && wallet.devMode;
    $('developer-quota').hidden = !dev;
    $('dev-quota-used').textContent = display(dev && dev.quotaUsed);
    $('dev-quota-limit').textContent = display(dev && dev.dailyLimit);
    $('dev-quota-date').textContent = display(dev && dev.quotaDate);
    $('dev-status').textContent = dev === null || dev === undefined ? '未知' : typeof dev === 'object' && typeof dev.enabled === 'boolean' ? dev.enabled ? '已开启' : '未开启' : '查看配置';
    $('dev-data').textContent = display(dev, '服务端未提供 Developer Mode 配置。');
    renderSelection(); portfolio?.update();
  }

  function renderOrders() {
    const signature = JSON.stringify([state.orders,[...clientOrders]]);
    if (signature === state.ordersSignature) return;
    state.ordersSignature = signature;
    const active = document.activeElement;
    const activeId = active && $('order-list').contains(active) ? active.id : null;
    const selection = activeId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const fragment = document.createDocumentFragment();
    state.orders.forEach((order) => {
      const row = node('div', 'order-row');
      const side = order.route?.kind==='asset-conversion'?'兑换':order.kind === 'wrap' ? '包装' : order.kind === 'approve' || order.side === 'approve' ? '授权' : order.side === 'sell' ? '卖出' : order.side === 'buy' ? '买入' : display(order.side, '交易');
      const sideLabel = node('span', `order-side${order.side === 'sell' ? ' sell' : ''}`, side);
      const body = node('div');
      const token = typeof order.token === 'object' && order.token ? order.token.address || order.token.symbol || display(order.token) : display(order.token);
      const title = node('div', 'order-title');
      title.append(node('strong', 'mono', display(order.amount)), node('span', 'quiet small',order.route?.kind==='asset-conversion'?`${order.route.summary.symbol} → BNB`:`${order.side === 'buy' ? order.quoteSymbol || 'BNB' : order.positionKind === 'shares' ? '份额' : '代币'} · ${platforms[order.platformId || 'four']?.name || '未知平台'}`));
      body.append(title, node('div', 'order-meta', token));
      if(order.kind==='route')body.append(routeView.renderOrder(order));
      if (order.txHash && /^0x[0-9a-fA-F]{64}$/.test(order.txHash)) {
        const tx = node('a', 'order-tx', `Tx ${order.txHash}`);
        tx.href = `https://bscscan.com/tx/${order.txHash}`; tx.target = '_blank'; tx.rel = 'noopener noreferrer';
        body.append(tx);
      } else if (order.txHash) { body.append(node('div', 'order-meta', `Tx ${display(order.txHash)}`)); }
      if (order.error) body.append(node('p', 'order-result error', display(order.error)));
      if (order.message) body.append(node('p', 'order-result', display(order.message)));
      if (order.manualLinked) body.append(node('p', 'order-result', '已手动关联链上交易，状态继续按回执更新。'));
      if (order.status === 'MANUALLY_RELEASED') body.append(node('p', 'order-result', '仅释放本地阻塞，不代表链上交易已取消或成功。'));
      if (Number.isFinite(order.timings?.totalMs) && order.timings.totalMs >= 0) body.append(node('p', 'order-meta', `${Number.isFinite(order.timings.requestTotalMs)?'工作进程请求处理':'执行阶段处理（不含此前准备/排队）'} ${(order.timings.totalMs / 1000).toFixed(2)} 秒`));
      if (Number.isFinite(order.timings?.requestToHashMs??order.timings?.firstHashMs)) body.append(node('p','order-meta',`${Number.isFinite(order.timings.requestToHashMs)?'工作进程请求':'执行阶段'}至获哈希 ${((order.timings.requestToHashMs??order.timings.firstHashMs)/1000).toFixed(2)} 秒`));
      const breakdown=[['initialWalletCheckMs','初始钱包核对'],['quoteSimulationMs','报价与模拟'],['walletPreviewMs','钱包预览'],['walletAuthorizationMs','最终钱包核对'],['protocolCheckMs','合约复核'],['submissionMs','提交请求']].filter(([key])=>Number.isFinite(order.timings?.[key])).map(([key,label])=>`${label} ${(order.timings[key]/1000).toFixed(2)} 秒`);
      if(breakdown.length)body.append(node('p','order-meta',breakdown.join(' · ')+'（报价可在点击前预备，并行项不相加）'));
      if (Number.isFinite(order.timings?.firstReceiptWaitMs)) body.append(node('p','order-meta',`提交响应至首次观察回执 ${(order.timings.firstReceiptWaitMs/1000).toFixed(2)} 秒 · ${order.receiptStatus===0?'回滚':order.receiptStatus===1?'执行成功，按确认数更新':'历史观察'}`));
      const client=clientOrders.get(order.id);
      if(client)body.append(node('p','order-meta',`页面${order.demo?'模拟':''}提交响应 ${(client.responseMs/1000).toFixed(2)} 秒${Number.isFinite(client.firstHashUiMs)?` · 确认点击至获哈希 ${(client.firstHashUiMs/1000).toFixed(2)} 秒`:''}${Number.isFinite(client.firstReceiptUiMs)?` · 确认点击至页面观察成功回执 ${(client.firstReceiptUiMs/1000).toFixed(2)} 秒`:''}`));
      const wait = node('p', 'order-meta'); wait.dataset.orderWait = String(order.id); body.append(wait);
      if(order.kind==='route'){
        if(['UNKNOWN','ROUTE_PAUSED','PENDING_CONFIRMATION'].includes(order.status)&&order.steps?.some(s=>['UNKNOWN','MARKET_PENDING','BROADCASTED','MINED'].includes(s.status)))body.append(routeRecovery(order));
      }else if (!order.txHash && ['UNKNOWN', 'PENDING_CONFIRMATION'].includes(order.status)) body.append(orderRecovery(order));
      const meta = node('div');
      const failed = ['failed', 'error', 'rejected', 'FAILED', 'REVERTED'].includes(order.status);
      const confirmed = ['confirmed', 'success', 'simulated', 'demo', 'approved', 'DEMO_COMPLETED', 'SUCCESS', 'CONFIRMED'].includes(order.status);
      meta.append(badge(statusLabels[order.status] || display(order.status, '未知状态'), failed ? 'red' : confirmed ? 'green' : 'yellow'), node('div', 'order-time', prettyTime(order.createdAt, true)));
      row.append(sideLabel, body, meta); fragment.append(row);
    });
    $('order-list').replaceChildren(fragment);
    renderOrderWait();
    $('orders-empty').hidden = state.orders.length > 0;
    $('order-count').textContent = String(state.orders.length);
    if (activeId && $(activeId)) {
      $(activeId).focus({ preventScroll: true });
      if (selection) $(activeId).setSelectionRange(...selection);
    }
  }

  function renderOrderWait() {
    const orders = new Map(state.orders.map(order => [String(order.id), order]));
    document.querySelectorAll('[data-order-wait]').forEach(element => {
      const order = orders.get(element.dataset.orderWait); if (!order) return;
      let text = '';
      if (['CONFIRMED', 'REVERTED'].includes(order.status) && Number.isFinite(order.timings?.confirmationWaitMs)) text = `链上确认耗时 ${(order.timings.confirmationWaitMs / 1000).toFixed(2)} 秒`;
      else if (['BROADCASTED', 'MINED'].includes(order.status) && Number.isFinite(Date.parse(order.submittedAt))) text = `链上等待 ${(Math.max(0, Date.now() - Date.parse(order.submittedAt)) / 1000).toFixed(1)} 秒 · ${order.status === 'MINED' ? '已入块，等待足够确认' : '尚未确认'}`;
      else if (order.status === 'PENDING_CONFIRMATION') text = '等待钱包确认 · 尚未核实链上广播';
      else if (order.status === 'UNKNOWN') text = '提交结果未知 · 核对前请勿重复下单';
      element.textContent = text; element.hidden = !text;
    });
  }

  function routeRecovery(order) {
    const box=node('div','order-recovery');
    box.append(node('p','field-help','分步路线按原聚合订单号核对币种、数量、滑点和链上回执；只更新记录，不重发或自动继续买卖。'));
    const button=node('button','button subtle compact','核对分步路线（不重发）');button.type='button';
    const message=node('p','inline-error');message.hidden=true;
    button.disabled=!order.steps?.some(s=>s.kind==='market'&&s.orderId&&['UNKNOWN','MARKET_PENDING','BROADCASTED','MINED'].includes(s.status));
    if(button.disabled){message.textContent='尚无可查询的聚合订单号，请先核对 Binance 钱包交易历史；此路线不使用单笔关联或释放入口。';message.hidden=false;}
    button.addEventListener('click',async()=>{
      if(button.disabled)return;const epoch=accountEpoch;button.disabled=true;button.textContent='正在只读核对…';message.hidden=true;
      try{const result=await api('/api/orders/reconcile-route',{orderId:order.id});if(epoch!==accountEpoch)return;if(result.readOnly!==true)throw Error('未收到只读核对结果');showToast('核对完成，请查看每步状态及留存资产；未重新发送交易。');await loadOrders();}
      catch(error){if(epoch===accountEpoch){message.textContent=error.message;message.hidden=false;}}
      finally{if(epoch===accountEpoch){button.disabled=false;button.textContent='核对分步路线（不重发）';state.ordersSignature=null;}}
    });
    box.append(button,message);return box;
  }

  function orderRecovery(order) {
    if (!state.orderDrafts.has(order.id)) state.orderDrafts.set(order.id, { hash: '', nonce: '', linkConfirmed: false, releaseConfirmed: false, open: false, busy: false, error: '' });
    const draft = state.orderDrafts.get(order.id);
    const details = node('details', 'order-recovery');
    details.open = draft.open;
    details.addEventListener('toggle', () => { draft.open = details.open; });
    details.append(node('summary', '', '核对待确认订单'));
    const linkForm = node('form', 'recovery-form');
    linkForm.append(node('h4', '', '关联已发送的链上交易'), node('p', 'field-help', '后端会核对链、钱包、目标、金额、调用数据、nonce、时间及回执；关联不会重发交易。'));
    const hashLabel = node('label', 'recovery-field', '完整交易哈希');
    const hash = node('input', 'mono');
    hash.id = `recovery-hash-${order.id}`; hash.type = 'text'; hash.autocomplete = 'off'; hash.placeholder = '0x…'; hash.value = draft.hash;
    hashLabel.append(hash);
    const nonceLabel = node('label', 'recovery-field', '交易 nonce');
    const nonce = node('input', 'mono');
    nonce.id = `recovery-nonce-${order.id}`; nonce.type = 'text'; nonce.inputMode = 'numeric'; nonce.autocomplete = 'off'; nonce.placeholder = '例如：12'; nonce.value = draft.nonce;
    nonceLabel.append(nonce);
    const linkCheckLabel = node('label', 'check-label recovery-confirm');
    const linkCheck = node('input'); linkCheck.type = 'checkbox'; linkCheck.checked = draft.linkConfirmed;
    linkCheckLabel.append(linkCheck, node('span', '', '我已确认此交易对应本订单。'));
    const linkButton = node('button', 'button subtle compact', '验证并关联'); linkButton.type = 'submit';
    linkForm.append(hashLabel, nonceLabel, linkCheckLabel, linkButton);
    const releaseForm = node('form', 'recovery-form release-form');
    releaseForm.append(node('h4', '', '释放本地阻塞'), node('p', 'field-help', '仅在原请求已被拒绝或过期时使用；后端还会检查钱包交易锁已解除。'));
    const releaseCheckLabel = node('label', 'check-label recovery-confirm');
    const releaseCheck = node('input'); releaseCheck.type = 'checkbox'; releaseCheck.checked = draft.releaseConfirmed;
    releaseCheckLabel.append(releaseCheck, node('span', '', '已在 App 确认原请求被拒绝或过期，并核对链上记录；此操作不取消链上交易。'));
    const releaseButton = node('button', 'button subtle compact', '释放本地阻塞'); releaseButton.type = 'submit';
    releaseForm.append(releaseCheckLabel, releaseButton);
    const error = node('p', 'inline-error', draft.error); error.hidden = !draft.error; error.setAttribute('role', 'alert');
    const update = () => {
      hash.disabled = nonce.disabled = linkCheck.disabled = releaseCheck.disabled = draft.busy;
      const validHash = /^0x[0-9a-fA-F]{64}$/.test(draft.hash.trim());
      const validNonce = /^\d+$/.test(draft.nonce.trim()) && Number.isSafeInteger(Number(draft.nonce)) && Number(draft.nonce) >= 0;
      linkButton.disabled = draft.busy || !draft.linkConfirmed || !validHash || !validNonce || !state.session;
      releaseButton.disabled = draft.busy || !draft.releaseConfirmed || !state.session;
      linkButton.textContent = draft.busy ? '正在核对…' : '验证并关联';
      releaseButton.textContent = draft.busy ? '正在核对…' : '释放本地阻塞';
      error.textContent = draft.error; error.hidden = !draft.error;
    };
    hash.addEventListener('input', () => { draft.hash = hash.value; update(); });
    nonce.addEventListener('input', () => { draft.nonce = nonce.value; update(); });
    linkCheck.addEventListener('change', () => { draft.linkConfirmed = linkCheck.checked; update(); });
    releaseCheck.addEventListener('change', () => { draft.releaseConfirmed = releaseCheck.checked; update(); });
    const submit = async (kind) => {
      if (draft.busy) return;
      draft.busy = true; draft.error = ''; update();
      try {
        const body = kind === 'link'
          ? { orderId: order.id, txHash: draft.hash.trim(), nonce: Number(draft.nonce), confirmed: true }
          : { orderId: order.id, confirmed: true, chainHistoryChecked: true };
        await api(`/api/orders/${kind}`, body);
        showToast(kind === 'link' ? '关联请求已返回，请查看最新订单状态。' : '释放请求已返回，请查看最新订单状态；此操作不取消链上交易。');
        await loadOrders();
      } catch (failure) { draft.error = failure.message; }
      finally { draft.busy = false; state.ordersSignature = null; renderOrders(); }
    };
    linkForm.addEventListener('submit', (event) => { event.preventDefault(); if (!linkButton.disabled) submit('link'); });
    releaseForm.addEventListener('submit', (event) => { event.preventDefault(); if (!releaseButton.disabled) submit('release'); });
    details.append(linkForm, releaseForm, error);
    update();
    return details;
  }

  async function loadTokens() {
    if (state.loading.tokens) return;
    state.loading.tokens = true;
    const version=marketReadVersion;
    try {
      const result = await api('/api/tokens');
      if(version!==marketReadVersion)return;
      state.tokens = Array.isArray(result.tokens) ? result.tokens.filter((token) => token && typeof token.address === 'string') : [];
      state.monitor = result.monitor || {};
      state.tokensLoaded = true; state.tokenError = null;
    } catch (error) { if(version===marketReadVersion) state.tokenError = error.message; }
    finally { state.loading.tokens = false; renderTokens(); renderMonitor(); }
  }

  async function loadWallet(refresh = false) {
    if (state.loading.wallet && !refresh) return;
    const version = ++state.walletVersion;
    state.loading.wallet = true;
    $('wallet-refresh').disabled = true;
    const previous = state.wallet && `${state.wallet.address}:${state.wallet.status}`;
    try {
      const result = await api(`/api/wallet${refresh ? '?refresh=1' : ''}`);
      if (version !== state.walletVersion) return;
      state.wallet = result; state.walletError = null;walletRetryAttempt=0;clearTimeout(walletRetryTimer);
      if(refresh&&state.session?.viewMode==='shared'){
        const fresh=await api('/api/session');
        if(version!==state.walletVersion)return;
        if(fresh.account?.id!==state.session.account?.id)throw new Error('钱包账号已变化，请刷新页面');
        state.session=fresh;renderMode();
      }
    } catch (error) { if (version === state.walletVersion){state.walletError=error.message;clearTimeout(walletRetryTimer);if(state.session?.account){const epoch=accountEpoch;walletRetryTimer=setTimeout(()=>{if(epoch===accountEpoch&&document.visibilityState!=='hidden'&&navigator.onLine!==false)void loadWallet(false);},Math.min(15000,2000*2**Math.min(walletRetryAttempt++,3)));}} }
    finally {
      if (version === state.walletVersion) {
        state.loading.wallet = false;
        const current = state.wallet && `${state.wallet.address}:${state.wallet.status}`;
        if (current !== previous) invalidatePreview();
        renderWallet();
        const visibleFair=selectedToken()?.launchType==='fair'&&selectedToken()?.phase==='bonding'&&!$('token-detail').hidden&&!state.previewBusy&&!state.executeBusy;
        if (refresh || current !== previous || visibleFair) await loadPosition(refresh===true);
      }
    }
  }

  async function loadOrders() {
    if (orderObserver) return orderObserver.refresh();
    if (state.loading.orders) return;
    state.loading.orders = true;
    try {
      const result = await api('/api/orders');
      state.orders = Array.isArray(result.orders) ? result.orders : [];
      $('orders-error').hidden = true; renderOrders(); portfolio?.update();
    } catch (error) { $('orders-error').textContent = error.message; $('orders-error').hidden = false; }
    finally { state.loading.orders = false; }
  }

  // 任务完成后再调度下一次；每个资源还有独立锁，手动刷新不会产生重叠请求。
  function poll(task, delay) {
    const schedule = () => {
      const timer = setTimeout(async () => {
        state.timers.delete(timer);
        await run();
      }, delay);
      state.timers.add(timer);
    };
    const run = async () => {
      await task();
      schedule();
    };
    schedule();
  }

  $('search-input').addEventListener('input', renderTokens);
  document.querySelector('.topnav a[href="#market"]').addEventListener('click', event => { if (!$('token-detail').hidden) { event.preventDefault(); tokenDetail.back(); } });
  $('wallet-open').addEventListener('click', () => openDrawer('wallet'));
  $('drawer-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('trade-drawer').hidden) closeDrawer(); });
  document.querySelectorAll('[data-stage-jump]').forEach(button => button.addEventListener('click', () => {
    $(`stage-${button.dataset.stageJump}`).scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  }));
  $('bonding-only').addEventListener('change', renderTokens);
  document.querySelectorAll('[data-platform]').forEach(button => button.addEventListener('click', () => {
    state.platform = button.dataset.platform;
    document.querySelectorAll('[data-platform]').forEach(tab => { const active = tab.dataset.platform === state.platform; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
    renderTokens();
  }));
  $('side-buy').addEventListener('click', () => setSide('buy'));
  $('side-sell').addEventListener('click', () => setSide('sell'));
  $('amount-input').addEventListener('input', invalidatePreview);
  $('slippage-input').addEventListener('input', invalidatePreview);
  document.querySelectorAll('[data-amount]').forEach((button) => button.addEventListener('click', () => {
    $('amount-input').value = button.dataset.amount; invalidatePreview();
  }));
  document.querySelectorAll('[data-percent]').forEach((button) => button.addEventListener('click', () => {
    if (button.disabled || !state.position) return;
    try {
      $('amount-input').value = button.dataset.percent;
      invalidatePreview();
    } catch (error) { showToast(error.message, true); }
  }));
  document.querySelectorAll('[data-slippage]').forEach((button) => button.addEventListener('click', () => {
    $('slippage-input').value = button.dataset.slippage; invalidatePreview();
  }));
  $('position-refresh').addEventListener('click', () => loadPosition(true));
  $('wallet-refresh').addEventListener('click', () => loadWallet(true));
  $('wallet-connect').addEventListener('click', startAuth);
  $('pairing-copy').addEventListener('click', async () => {
    if (!state.auth || !state.auth.pairingCode) return;
    try { await navigator.clipboard.writeText(String(state.auth.pairingCode)); showToast('配对码已复制'); }
    catch { showToast('请选中配对码手动复制。', true); }
  });
  $('execution-toggle').addEventListener('click', toggleExecution);
  $('trade-form').addEventListener('submit', requestPreview);
  $('confirm-preview').addEventListener('change', updateExpiry);
  $('execute-button').addEventListener('click', executePreview);
  $('close-preview').addEventListener('click', invalidatePreview);
  $('wallet-address').addEventListener('click', () => { if (state.wallet && state.wallet.address) copyText(state.wallet.address); });
  $('refresh-button').addEventListener('click', async () => {
    $('refresh-button').disabled = true;
    await Promise.allSettled([loadTokens(), loadOrders(), loadWallet(true)]);
    $('refresh-button').disabled = false;
  });

  async function initialize() {
    try {
      state.session = await api('/api/session');
      if (!['live', 'demo'].includes(state.session.mode) || typeof state.session.csrf !== 'string') throw new Error('会话配置无效，请检查本地服务。');
      renderMode();profileView?.update();
      if (window.createWalletTracker) {
        window.walletTracker = window.createWalletTracker({ api, onSelect: selectTrackingEvent, canEdit: () => accountAccess.requireAccount() });
        if (state.session.capabilities?.hosted) document.querySelector('.tracking-form-help').textContent = '头像和备注保存在当前账号；X 为手动资料，未核验地址归属。';
        window.walletTracker.start();
      }
    } catch (error) {
      state.session = null;
      $('mode-notice').className = 'mode-notice error';
      $('mode-notice').textContent = `${error.message} 恢复服务后请重新加载页面。`;
      $('mode-badge').textContent = '离线';
      $('mode-badge').className = 'badge red';
    }
    await Promise.allSettled([loadTokens(), loadOrders(), loadWallet()]);
    liveUpdates=window.createLiveUpdates?.({
      trackingDeltas:state.session?.viewMode==='shared',
      tracking:Boolean(state.session&&(!state.session.capabilities?.hosted||state.session.account)),
      getHeaders:()=>state.session?.capabilities?.hosted?{'X-Account-Context':state.session.account?.id||'anonymous'}:{},
      onMarket:result=>{marketReadVersion++;state.tokens=result.tokens;state.monitor=result.monitor;state.tokensLoaded=true;state.tokenError=null;renderTokens();renderMonitor();},
      onTracking:value=>window.walletTracker?.applySnapshot(value),
      onState:value=>{if(value.channel==='market'){marketStreamState=value.state;renderMonitor();}else window.walletTracker?.setStreamState(value.state==='live',{paused:['paused','stopped','reset'].includes(value.state)});},
      onAuthError:()=>void recoverAccountSession(),
    });
    liveUpdates?.start();
    poll(()=>{if((!liveUpdates||marketStreamState!=='live')&&document.visibilityState!=='hidden'&&navigator.onLine!==false)return loadTokens();},liveUpdates?15000:5000); if(orderObserver)orderObserver.start();else poll(loadOrders, 5000); poll(loadWallet, 30000); poll(pollAuthStatus, 5000);
    state.timers.add(setInterval(() => { updateExpiry(); renderAuth(); renderDataAge(); renderOrderWait(); tradePreparation?.tick(); }, 1000));
  }
  document.addEventListener('visibilitychange',()=>{orderObserver?.update();if(document.visibilityState==='hidden'){tradePreparation?.cancel();clearTimeout(walletRetryTimer);}else void loadWallet(false);});
  window.addEventListener('online',()=>{orderObserver?.update();void loadWallet(false);});
  window.addEventListener('offline',()=>{orderObserver?.update();tradePreparation?.cancel();});
  window.addEventListener('pagehide', () => { liveUpdates?.stop();tradePreparation?.cancel();orderObserver?.stop();clearTimeout(walletRetryTimer); state.timers.forEach((timer) => clearTimeout(timer)); window.walletTracker?.stop(); portfolio?.stop();profileView?.stop(); tokenDetail.close(); accountChannel?.close(); });
  initialize();
})();
