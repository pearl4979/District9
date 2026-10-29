import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { formatEther } from 'ethers';
import { guardRequest, readJson } from './security.mjs';
import { createTradeService } from './trades.mjs';
import { createDemo } from './demo.mjs';
import { createAuthService } from './auth.mjs';
import { expiryMs } from './baw.mjs';
import { PLATFORMS, createMarketHub, createMarketRouter } from './market-hub.mjs';
import { createCandleService } from './candles.mjs';
import { readCandleQuery } from './candle-query.mjs';
import { createTokenInsights } from './token-insights.mjs';
import {createFairParticipants,readFairParticipantsQuery} from './fair-participants.mjs';
import { createWalletTracking } from './wallet-tracking.mjs';
import { createPortfolioService } from './portfolio.mjs';
import { isMainModule } from './main-module.mjs';
import { createReceiptObserver } from './receipt-observer.mjs';
import { createBnbRouteProtocol } from './bnb-routes.mjs';
import { createAggregatorProtocol } from './aggregator-routes.mjs';
import { createPreapprovalProtocol } from './preapproval.mjs';
import {createAutomaticSetupProtocol} from './automatic-setup.mjs';
import {createLocalMarket} from './local-market.mjs';
import { createWalletSignalProvider } from './wallet-signal-rpc.mjs';
import { createSnapshotStream } from './snapshot-stream.mjs';
import { createIndexedTracking } from './indexed-tracking.mjs';
import { createWorkerLifecycle } from './worker-lifecycle.mjs';
import { createRpcSettings } from './rpc-settings.mjs';
import { createAssetConversionProtocol } from './asset-conversion.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Exact branding asset allowlist; no general filesystem or upload route.
const imageAssets=new Set(['/assets/district9-logo.png','/assets/district9-ufo.png','/assets/district9-ufo-transparent.png',...Array.from({length:6},(_,i)=>`/assets/wallet-default-${i+1}.png`)]);
const assets = { '/wallet-profiles.js':['wallet-profiles.js','text/javascript'], '/wallet-profiles.css':['wallet-profiles.css','text/css'], '/portfolio.js':['portfolio.js','text/javascript'], '/portfolio.css':['portfolio.css','text/css'], '/wallet-avatar.js':['wallet-avatar.js','text/javascript'], '/vendor/lightweight-charts-5.2.1.standalone.production.js':['vendor/lightweight-charts-5.2.1.standalone.production.js','text/javascript'], '/workspace-layout.js':['workspace-layout.js','text/javascript'], '/workspace-layout.css':['workspace-layout.css','text/css'], '/trade-feedback.js':['trade-feedback.js','text/javascript'], '/trade-feedback.css':['trade-feedback.css','text/css'], '/wallet-tracker.js': ['wallet-tracker.js','text/javascript'], '/wallet-markers.css':['wallet-markers.css','text/css'], '/token-insights.js': ['token-insights.js','text/javascript'], '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/token-detail.js': ['token-detail.js', 'text/javascript'], '/candle-chart.js': ['candle-chart.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

assets['/order-observer.js'] = ['order-observer.js', 'text/javascript'];
assets['/trade-preparation.js'] = ['trade-preparation.js', 'text/javascript'];
assets['/fair-progress.js'] = ['fair-progress.js', 'text/javascript'];
assets['/fair-participants.js'] = ['fair-participants.js', 'text/javascript'];
assets['/trade-approvals.js']=['trade-approvals.js','text/javascript'];
assets['/trade-route.js'] = ['trade-route.js', 'text/javascript'];
assets['/live-updates.js'] = ['live-updates.js', 'text/javascript'];
assets['/rpc-settings.js'] = ['rpc-settings.js', 'text/javascript'];
assets['/asset-conversion.js'] = ['asset-conversion.js', 'text/javascript'];

export function createHttpServer({ monitor, baw, trades, protocol, metadata, charts, insights, fairParticipants, tracking, binanceFeed, portfolioLedger, rpcSettings, demo = false, liveExecution = false, liveExecutionAllowed = true, receiptPollMs = 750, lifecycleCapability, lifecycleFlush, redactRpcUrls=[] }) {
  const csrf = randomBytes(32).toString('hex');
  // Hosted deployment policy is a process-level ceiling, independent of wallet permissions.
  if (!liveExecutionAllowed) trades.setLiveExecution?.(false);
  let walletCache;
  let walletTime = 0;
  let walletPending;
  let walletGeneration = 0;
  let previewPending = false;
  let previewTime = 0;
  let preparePending = false, prepareTime = 0;
  let executionRevision = 0;
  function invalidateWallet() { walletTime = 0; walletGeneration++; }
  const auth = !demo && baw.authStart ? createAuthService({ baw, onConnected: () => { invalidateWallet(); trades.setLiveExecution(false); executionRevision++; } }) : null;
  const lifecycle = lifecycleCapability ? createWorkerLifecycle({ capability: lifecycleCapability, disable: () => { trades.setLiveExecution(false); executionRevision++; }, read: () => {
    const state = trades.lifecycle?.(), authState = auth?.snapshot();
    return state && { busy: state.busy || Boolean(walletPending || preparePending || previewPending || authState?.status === 'WAITING_APP' || authState?.pendingVerification), pending: state.pending };
  }, flush: async () => { if (typeof trades.checkpoint !== 'function' || typeof lifecycleFlush !== 'function') throw Error('Worker checkpoint unavailable'); trades.checkpoint(); await lifecycleFlush(); } }) : null;
  const executionEnabled = () => liveExecutionAllowed && (demo || (trades.isLiveExecution?.() ?? liveExecution));
  async function wallet(refresh = false) {
    if (refresh) invalidateWallet();
    if (walletCache && Date.now() - walletTime < 30_000) return walletCache;
    if (walletPending?.generation === walletGeneration) return walletPending.promise;
    const generation = walletGeneration;
    const promise = (async () => {
      const data = await baw.wallet();
      // CLI会按价格过滤低余额资产；链上原生BNB余额更准确，空列表不等于0。
      if (data.address && protocol.provider) {
        try { data.balance = formatEther(await protocol.provider.getBalance(data.address)); data.balanceSource = 'BSC eth_getBalance'; }
        catch (e) { data.balanceError = e.shortMessage || e.message; }
      }
      if (generation === walletGeneration) { walletCache = data; walletTime = Date.now(); }
      return data;
    })().finally(() => { if (walletPending?.generation === generation) walletPending = null; });
    walletPending = { generation, promise };
    return promise;
  }
  async function verifiedToken(address, allowTracked = false) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) return null;
    const current = (await monitor.snapshot()).tokens.find(t => t.verified === true && t.address.toLowerCase() === address.toLowerCase());
    if(current)return current;
    return allowTracked ? tracking?.getToken(address) : null;
  }
  const portfolio=createPortfolioService({wallet:()=>wallet(),snapshot:()=>monitor.snapshot(),protocol,orders:()=>trades.list(),ledger:portfolioLedger,demo});
  let demoPublished=true;
  const demoProfile=async()=>({demo:true,walletAddress:'0x000000000000000000000000000000000000dead',x:{id:'DEMO-ONLY',username:'district9_demo',name:'District9 演示钱包',avatarPath:'/assets/wallet-default-1.png'},agentId:{name:'demo.ai',verified:false,demo:true},published:demoPublished,boundAt:new Date().toISOString(),portfolio:{...await portfolio.get(),coverage:'DEMO 独立模拟档案与持仓快照；未绑定真实 X。'}});
  const ownProfile=async()=>({bindingAvailable:false,authenticated:demo,demo,profile:demo?await demoProfile():null,message:demo?'DEMO：仅展示绑定后的档案效果，没有绑定真实 X。':'请通过钱包登录使用 X 绑定；当前本机预览未开放真实绑定。'});
  async function publicMarket(){
    const current=await monitor.snapshot();
    const indexed=binanceFeed?await binanceFeed.snapshot():null;
    return{tokens:current.tokens.map(t=>({...t,platformId:t.platformId||'four',imageUrl:t.imageUrl||`/api/token-image/${t.address}`})),monitor:{...current.monitor,...(indexed?{realtime:indexed.status}:{})}};
  }
  const marketStream=createSnapshotStream({read:publicMarket,eventName:'market'});
  const trackingStream=tracking?createSnapshotStream({read:()=>tracking.snapshot(),eventName:'tracking',mode:'full',statusDeltas:true}):null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'none'");
    const send = (code, body) => { let text=JSON.stringify(body);for(const url of redactRpcUrls)if(typeof url==='string'&&url)text=text.split(JSON.stringify(url).slice(1,-1)).join('[private RPC endpoint]');if(rpcSettings)text=rpcSettings.redact(text);res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(text); };
    if (req.url?.startsWith('/internal/lifecycle/')) {
      if (!lifecycle || !lifecycle.authorize(req.headers['x-worker-lifecycle'])) return send(403, { error: 'Forbidden' });
      const action = /^\/internal\/lifecycle\/(status|quiesce|resume)$/.exec(req.url)?.[1];
      const port = server.address()?.port;
      if (req.method !== 'POST' || !action || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) || req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) return send(400, { error: 'Invalid lifecycle request' });
      try { return send(200, await lifecycle[action]()); } catch (error) { if (error.code === 'WORKER_OPERATION_BUSY') return send(409, { code: 'WORKER_OPERATION_BUSY', error: 'Private worker is busy' }); return send(503, { error: 'Worker lifecycle unavailable' }); }
    }
    try { guardRequest(req, { port: server.address().port, csrf }); }
    catch (e) { return send(403, { error: e.message }); }
    let releaseLifecycle,releaseRpc;
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if(rpcSettings&&['/api/wallet','/api/portfolio','/api/positions','/api/order','/api/preview','/api/execute','/api/trade-prepare','/api/approvals/revoke','/api/orders/reconcile-route','/api/conversion','/api/conversion/balances'].includes(path))releaseRpc=rpcSettings.beginOperation();
      if (lifecycle && (req.method === 'POST' || ['/api/wallet', '/api/portfolio', '/api/positions'].includes(path))) releaseLifecycle = lifecycle.begin();
      if (req.method === 'GET') {
        if(['/api/market-stream','/api/tracking-stream'].includes(path)){
          if(url.search)return send(400,{error:'实时订阅不接受查询参数'});
          const stream=path==='/api/market-stream'?marketStream:trackingStream;
          if(!stream)return send(503,{error:'钱包追踪服务暂不可用'});
          return stream.attach(req,res);
        }
        if (path === '/api/health') return send(200, { status: 'ok', service: 'worker' });
        if(path==='/api/settings/rpc')return send(200,rpcSettings?.snapshot()??{mode:'default',configured:false,message:'当前服务未开放个人 RPC 设置'});
        if(path==='/api/conversion/balances'){if(!protocol.conversionBalances)return send(503,{error:'兑换服务暂不可用'});const owner=await wallet();if(!owner.address)return send(400,{error:'请先连接钱包'});return send(200,await protocol.conversionBalances(owner.address));}
        if(path==='/api/profile')return send(200,await ownProfile());
        if(path==='/api/profiles'){for(const k of url.searchParams.keys())if(k!=='wallet'||url.searchParams.getAll(k).length!==1)return send(400,{error:'档案查询参数无效'});const address=url.searchParams.get('wallet');if(address&&!/^0x[0-9a-f]{40}$/i.test(address))return send(400,{error:'钱包地址无效'});const rows=demo&&demoPublished?[await demoProfile()]:[];return send(200,address?{profile:rows.find(p=>p.walletAddress===address.toLowerCase())||null}:{profiles:rows,complete:true});}
        if (path === '/api/session') return send(200, { csrf, mode: demo ? 'demo' : 'live', liveExecution: executionEnabled(), liveExecutionAllowed, capabilities: { directOrders: typeof trades.place === 'function', tradePreparation: typeof trades.prepare === 'function', bnbRoutes: typeof protocol.planRoute === 'function', aggregator:protocol.aggregatorEnabled===true, preapproval:typeof trades.setApprovalSettings==='function' }, platforms: Object.values(PLATFORMS), mev: { status: 'unverified', label: '防夹未验证', description: '当前 baw contract-call 广播通道未披露 MEV 保护；滑点与重新估价不等于防夹。' } });
        if(path==='/api/settings/preapproval')return send(200,await trades.approvalSettings());
        if (path === '/api/trade-progress') return send(200,trades.progress?.()||{operation:null,stage:'idle',startedAt:null,stageStartedAt:null,elapsedMs:0});
        if (path === '/api/tracking') return tracking ? send(200,await tracking.snapshot()) : send(503,{error:'钱包追踪服务暂不可用'});
        if (path === '/api/tracking/token') {
          const token=await verifiedToken(url.searchParams.get('token'),true);
          if(!token)return send(404,{error:'未找到已核验的追踪市场'});
          return send(200,{...token,tradable:false,readOnly:true,reason:'追踪历史仅供查看；交易需重新进入当前核验市场'});
        }
        if (path === '/api/tokens') {
          const snapshot = await monitor.snapshot();
          return send(200, { ...snapshot, tokens: snapshot.tokens.map(t => ({ ...t, platformId: t.platformId || 'four', imageUrl: t.imageUrl || `/api/token-image/${t.address}`, imageSource: t.imageSource || `${PLATFORMS[t.platformId || 'four']?.name} / 链上元数据`, metadataStatus: t.metadataStatus || 'on-demand' })) });
        }
        if(path==='/api/fair-participants'){
          const {token:address,options}=readFairParticipantsQuery(url),token=await verifiedToken(address);
          if(!token)return send(404,{error:'只能查询当前已核验的打新市场'});
          if(!fairParticipants)return send(503,{error:'认购明细服务暂不可用'});
          return send(200,await fairParticipants.get(token.address,options));
        }
        if (path === '/api/token-insights') {
          const token = await verifiedToken(url.searchParams.get('token'),true);
          if (!token || !insights) return send(404, { error: '只能查询已核验市场的档案' });
          return send(200, await insights.get(token.address));
        }
        if (path === '/api/candles') {
          const {interval,mode,options}=readCandleQuery(url);
          const token = await verifiedToken(url.searchParams.get('token'),true);
          if (!token || !charts) return send(404, { error: '只能查询已核验市场的K线' });
          return send(200, await charts.get(token.address, interval, mode, options));
        }
        if (path === '/api/wallet') return send(200, await wallet(url.searchParams.get('refresh') === '1'));
        if (path === '/api/auth/status') return send(200, demo ? { status: 'CONNECTED', message: '演示钱包，无需登录' } : auth?.snapshot() ?? { status: 'UNAVAILABLE', message: '认证模块不可用' });
        if (path === '/api/positions') {
          const token = await verifiedToken(url.searchParams.get('token'));
          if (!token) return send(404, { error: '仅支持已核验的 Agent 市场' });
          const w = await wallet();
          if (!w.address) throw new Error('请先连接 Agentic Wallet');
          return send(200, { ...await protocol.positions(token.address, w.address, { platformId: token.platformId || 'four' }), updatedAt: new Date().toISOString() });
        }
        if (path.startsWith('/api/token-image/')) {
          const token = await verifiedToken(path.slice('/api/token-image/'.length),true);
          if (!token || !metadata) return send(404, { error: '没有可用的代币图片' });
          const image = await metadata.getImage(token.address, token);
          if (!image) return send(404, { error: '没有可用的代币图片' });
          res.writeHead(200, { 'Content-Type': image.contentType, 'Cache-Control': image.cacheControl || 'private, max-age=300' }); return res.end(image.body);
        }
        if(path==='/api/portfolio'){if(url.search)return send(400,{error:'持仓只读取当前连接钱包，不接受查询参数'});return send(200,await portfolio.get());}
        if (path === '/api/orders') return send(200, { orders: trades.list() });
        if (imageAssets.has(path)) {
          const image = await readFile(resolve(root, 'public', path.slice(1)));
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' }); return res.end(image);
        }
        if (/^\/assets\/[a-zA-Z0-9_-]+\.svg$/.test(path)) {
          try { const image = await readFile(resolve(root, 'public', path.slice(1))); res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' }); return res.end(image); }
          catch { return send(404, { error: '图片不存在' }); }
        }
        if (assets[path]) {
          const [file, type] = assets[path];
          const content = await readFile(resolve(root, 'public', file));
          res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
        }
      }
      if(req.method==='POST'&&['/api/tracking/wallet','/api/tracking/wallet/remove','/api/tracking/preferences'].includes(path)){
        if(!tracking)return send(503,{error:'钱包追踪服务暂不可用'});
        const body=await readJson(req);
        const result=path==='/api/tracking/wallet'?await tracking.saveWallet(body):path==='/api/tracking/wallet/remove'?await tracking.removeWallet(body):await tracking.setPreferences(body);
        return send(200,result);
      }
      if(req.method==='POST'&&path.startsWith('/api/profile/')){const input=await readJson(req);if(demo&&path==='/api/profile/publish'&&typeof input.published==='boolean'&&(!input.published||input.consent===true)){demoPublished=input.published;return send(200,await ownProfile());}return send(400,{error:'当前预览不绑定真实 X；请先配置 District9 的 X 应用'});}
      if (req.method === 'POST' && path === '/api/auth/start') {
        await readJson(req);
        if (demo) return send(200, { status: 'CONNECTED', message: '演示模式无需登录' });
        if (!auth) throw new Error('认证模块不可用');
        return send(200, await auth.start());
      }
      if (req.method === 'POST' && path === '/api/settings/execution') {
        const body = await readJson(req);
        if (Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new Error('enabled 必须为布尔值');
        if (body.enabled && !liveExecutionAllowed) return send(403, { error: '此部署已禁用实盘执行' });
        if (demo) return send(200, { liveExecution: executionEnabled(), message: '演示模式不会签名或广播' });
        const revision = ++executionRevision;
        // This is the user's mode selection, not permission to sign. Every
        // financial operation independently verifies current wallet authority.
        trades.setLiveExecution(body.enabled);
        return send(200, { liveExecution: executionEnabled() });
      }
      if(req.method==='POST'&&['/api/settings/rpc','/api/settings/rpc/test'].includes(path)){
        if(!rpcSettings)return send(503,{error:'当前服务未开放个人 RPC 设置'});
        const body=await readJson(req);
        if(path.endsWith('/test'))return send(200,await rpcSettings.test(body));
        const state=trades.lifecycle?.();
        if(walletPending||preparePending||previewPending||state?.busy||state?.pending)return send(409,{code:'RPC_BUSY',error:'订单或钱包读取正在进行，请完成后再切换 RPC'});
        const result=await rpcSettings.save(body);trades.invalidateQuotes?.();invalidateWallet();return send(200,result);
      }
      if(req.method==='POST'&&path==='/api/settings/preapproval')return send(200,await trades.setApprovalSettings(await readJson(req)));
      if(req.method==='POST'&&path==='/api/approvals/revoke'){if(!liveExecutionAllowed) return send(403,{error:'此部署已禁用实盘执行'});return send(200,await trades.revokePreapproval(await readJson(req)));}
      if (req.method === 'POST' && path === '/api/trade-prepare') {
        if (preparePending || Date.now() - prepareTime < 1000) return send(429, { error: '只读准备请求过快，请稍后再试' });
        preparePending = true; prepareTime = Date.now();
        try { return send(200, await trades.prepare(await readJson(req))); }
        finally { preparePending = false; }
      }
      if (req.method === 'POST' && path === '/api/preview') {
        if (previewPending || Date.now() - previewTime < 1500) return send(429, { error: '预览正在处理中或请求过快，请稍后再试' });
        previewPending = true; previewTime = Date.now();
        try { return send(200, await trades.preview(await readJson(req))); }
        finally { previewPending = false; }
      }
      if (req.method === 'POST' && path === '/api/order') {
        const body = await readJson(req);
        if (Object.keys(body).some(key => !['input', 'intentId', 'expectedWallet'].includes(key))) throw new Error('未知下单字段');
        if (typeof body.expectedWallet !== 'string' || !/^0x[\da-fA-F]{40}$/.test(body.expectedWallet)) throw new Error('必须绑定点击时的钱包地址');
        // The process ceiling is authoritative, including when a service was
        // constructed with liveExecution=true by mistake.
        if (!liveExecutionAllowed && trades.isLiveExecution?.()) trades.setLiveExecution(false);
        const result = await trades.place(body.input, { intentId: body.intentId, expectedWallet: body.expectedWallet });
        if (result.submitted) invalidateWallet();
        return send(200, result);
      }
      if (req.method === 'POST' && path === '/api/execute') {
        if (!liveExecutionAllowed) return send(403, { error: '此部署已禁用实盘执行' });
        const result = await trades.execute(await readJson(req)); invalidateWallet(); return send(200, result);
      }
      if (req.method === 'POST' && path === '/api/orders/link') return send(200, await trades.linkTransaction(await readJson(req)));
      if(req.method==='POST'&&path==='/api/conversion'){if(!liveExecutionAllowed)return send(403,{error:'此部署已禁用实盘执行'});const result=await trades.convert(await readJson(req));invalidateWallet();return send(200,result);}
      if (req.method === 'POST' && path === '/api/orders/reconcile-route') { const result=await trades.reconcileRoute(await readJson(req));invalidateWallet();return send(200,result); }
      if (req.method === 'POST' && path === '/api/orders/release') return send(200, await trades.releaseOrder(await readJson(req)));
      return send(404, { error: '接口不存在' });
    } catch (e) { send(e.code==='RPC_BUSY'?409:e.code === 'WORKER_QUIESCING' || e.code === 'WORKER_OPERATION_BUSY' ? 503 : 400, { error: e.message, ...(e.cliError ? { cliError: e.cliError } : {}),...(e.tradeRisk?{tradeRisk:e.tradeRisk}:{}),...(e.timings?{timings:e.timings}:{}) }); }
    finally { releaseRpc?.();releaseLifecycle?.(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const receipts = createReceiptObserver({ trades, pollMs: receiptPollMs, onObserved: result => { if (result?.changed) invalidateWallet(); } });
  const unwatchRpc=rpcSettings?.watchBlocks(()=>receipts.wake());
  server.on('close',()=>{unwatchRpc?.();rpcSettings?.close();});
  server.on('listening', () => receipts.start());
  server.on('shutdown', () => receipts.stop());
  server.on('close', () => receipts.stop());
  server.on('shutdown', () => auth?.stop());
  server.on('close', () => auth?.stop());
  server.on('shutdown', () => lifecycle?.close());
  server.on('close', () => lifecycle?.close());
  const closeStreams=()=>{marketStream.close();trackingStream?.close();};
  server.on('shutdown',closeStreams);server.on('close',closeStreams);
  return server;
}

export async function main() {
  const demo = process.argv.includes('--demo');
  const liveExecutionAllowed = demo || process.env.LIVE_EXECUTION_ALLOWED === 'true';
  const liveExecution = !demo && liveExecutionAllowed && process.env.ENABLE_LIVE_TRADING === 'true';
  const port = Number(process.env.PORT || (demo ? 4319 : 4318));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024–65535');
  let deps;
  if (demo) deps = createDemo({fairLaunch:true});
  else {
    const [{ createProtocol }, { createBaw }, { createMetadataService }, { createGangProtocol }, { createFlapProtocol }] = await Promise.all([import('./protocol.mjs'), import('./baw.mjs'), import('./metadata.mjs'), import('./gang.mjs'), import('./flap.mjs')]);
    const rpcOptions = { rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org', batchMaxCount: Number(process.env.BSC_RPC_BATCH_COUNT || 1) };
    const four = createProtocol(rpcOptions);
    // 行情读取有自己的请求队列，不能排在交易预览前面耗尽 30 秒报价窗口。
    const displayOptions={...rpcOptions,rpcUrl:process.env.BSC_DISPLAY_RPC_URL||rpcOptions.rpcUrl};
    let discoveryFour;
    // 档案的日志/池子查询独立排队，避免阻塞行情与资金预览。
    const insightProtocol = createProtocol({ ...displayOptions, aggregateReads: true });
    const gang = createGangProtocol({ provider: four.provider });
    const flap = createFlapProtocol({ provider: four.provider });
    const { createFourMarketSource } = await import('./four-market.mjs');
    const monitor = createLocalMarket({baseUrl:process.env.DISTRICT9_MARKET_BASE_URL,createDiscovery:()=>{
      discoveryFour=createProtocol({...displayOptions,aggregateReads:true});
      return createMarketHub({sources:{four:createFourMarketSource({protocol:discoveryFour}),gang:createGangProtocol({provider:discoveryFour.provider}),flap:createFlapProtocol({provider:discoveryFour.provider})}});
    }});
    const stopMonitor = monitor.stop;
    monitor.stop = () => { stopMonitor(); discoveryFour?.provider.readOnlyRunner?.dispose(); discoveryFour?.provider.destroy(); insightProtocol.provider.readOnlyRunner?.dispose(); insightProtocol.provider.destroy(); };
    const baw=createBaw();
    const protocol = createPreapprovalProtocol({protocol:createAggregatorProtocol({baw,snapshot:monitor.snapshot,protocol:createBnbRouteProtocol({protocol:createMarketRouter({ providers: { four, gang, flap }, snapshot: monitor.snapshot, provider: four.provider })})})});
    deps = { protocol, monitor, baw, metadata: createMetadataService({ maxEntries: 96 }), insightProvider: insightProtocol.provider };
  }
  let signalProvider;
  let pollSignals;
  if(demo){
    pollSignals=async({wallets,markets})=>{
      markets=markets.filter(m=>Number.isFinite(Number(m.price))&&Number(m.price)>0);
      const minute=Math.floor(Date.now()/60000)*60000;
      const events=Array.from({length:12},(_,i)=>{
        const wallet=wallets[i%wallets.length],market=markets[i%markets.length];
        if(!wallet||!market)return null;
        const timestamp=new Date(minute-i*15000).toISOString();
        return{id:`demo:${timestamp}:${i}`,walletAddress:wallet.address,tokenAddress:market.address,platformId:market.platformId,phase:market.phase,side:i%3===1?'sell':'buy',timestamp,blockNumber:Math.floor(minute/1000)-i,transactionIndex:0,logIndex:i,txHash:null,tokenAmount:String(120000+i*30000),quoteAmount:(Number(market.price)*(120000+i*30000)).toFixed(9),quoteSymbol:market.quoteSymbol,price:null,priceUnit:null,source:'DEMO · 独立模拟信号',confirmed:true,demo:true};
      }).filter(Boolean);
      return{events,cursor:Math.floor(minute/1000),status:{state:'demo',message:'演示信号 · 无真实链上交易',coverage:'仅独立演示市场与模拟钱包',coveredFromBlock:null,lastBlock:null,lagBlocks:0}};
    };
  }else{
    const {createWalletSignalSource}=await import('./wallet-signal-source.mjs');
    signalProvider=createWalletSignalProvider({env:process.env});
    pollSignals=createWalletSignalSource({provider:signalProvider.provider}).poll;
  }
  deps.tracking=createWalletTracking({snapshot:deps.monitor.snapshot,poll:pollSignals,storagePath:resolve(root,'.runtime',demo?'tracking-demo-v1.json':'tracking-v1.json'),demo,seedWallets:demo?[
    {address:'0x1111111111111111111111111111111111111111',note:'Alpha · 演示',xUrl:null},
    {address:'0x2222222222222222222222222222222222222222',note:'观察钱包 · 演示',xUrl:null},
  ]:[]});
  await deps.tracking.ready;
  if(!demo){
    const {createBinanceSignalFeed}=await import('./binance-signal-feed.mjs');
    deps.binanceFeed=createBinanceSignalFeed({snapshot:deps.monitor.snapshot});
    deps.tracking=createIndexedTracking({tracking:deps.tracking,feed:deps.binanceFeed,snapshot:deps.monitor.snapshot});
  }
  const readOnlySnapshot=async()=>{
    const current=await deps.monitor.snapshot(), known=new Map(deps.tracking.knownMarkets().map(m=>[m.address.toLowerCase(),{...m,tradable:false,readOnly:true}]));
    for(const token of current.tokens)known.set(token.address.toLowerCase(),token);
    return{...current,tokens:[...known.values()]};
  };
  if (!demo) {
    deps.insights=createTokenInsights({snapshot:readOnlySnapshot,provider:deps.insightProvider});
    deps.fairParticipants=createFairParticipants({snapshot:readOnlySnapshot,provider:deps.insightProvider});
    deps.charts = createCandleService({ snapshot: readOnlySnapshot, cachePath: resolve(root, '.runtime', 'chart-samples-v1.json') });
    await deps.charts.restore();
  }
  if(!demo)deps.protocol=createAssetConversionProtocol({protocol:createAutomaticSetupProtocol({protocol:deps.protocol}),baw:deps.baw});
  const trades = createTradeService({ ...deps, demo, liveExecution, warmPreviews:!demo, ...(!demo&&process.env.DISTRICT9_WALLET_ADDRESS?{trustedWalletAddress:process.env.DISTRICT9_WALLET_ADDRESS}:{}), journalPath: resolve(root, '.runtime', demo ? 'orders-demo.json' : 'orders.json') });
  const rpcSettings=createRpcSettings({storagePath:resolve(root,'.runtime',demo?'rpc-demo.json':'rpc-settings.json'),isBusy:()=>{const state=trades.lifecycle();return state.busy||state.pending;}});
  await rpcSettings.ready;if(!demo)rpcSettings.attach(deps.protocol.provider);
  const server = createHttpServer({ ...deps, trades, rpcSettings, demo, liveExecution, liveExecutionAllowed, receiptPollMs: Number(process.env.RECEIPT_POLL_MS || 750),redactRpcUrls:[process.env.BSC_RPC_URL,process.env.BSC_SIGNAL_RPC_URL].filter(Boolean) });
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`District9 · Gang / Flap / Four.meme ${demo ? '[DEMO — 不发交易]' : '[LIVE DATA]'} http://127.0.0.1:${port}`);
    console.log(`实盘执行：${liveExecution ? '开启（后台报价、模拟与风控）' : '关闭'}`);
    Promise.resolve(deps.monitor.start()).catch(e => console.error(`监控启动失败：${e.shortMessage || e.message}`));
    deps.tracking.start();
    deps.binanceFeed?.start().catch(()=>console.error('币安公共实时流连接失败；链上扫描继续'));
  });
  const sampleTimer = !demo && setInterval(() => { try { deps.charts.observe(); } catch { /* source snapshot temporarily unavailable */ } }, 5000);
  const sampleSaveTimer = !demo && setInterval(() => deps.charts.flush().catch(e => console.error(`行情采样缓存：${e.message}`)), 30000);
  sampleTimer?.unref?.(); sampleSaveTimer?.unref?.();
  const stop = () => { server.emit('shutdown'); clearInterval(sampleTimer); clearInterval(sampleSaveTimer); deps.tracking.stop();void deps.binanceFeed?.stop().catch(()=>{});signalProvider?.close();deps.charts?.flush?.().catch(e => console.error(`保存行情采样：${e.message}`)); deps.monitor.stop(); deps.protocol.provider?.destroy(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { server, stop };
}

if (isMainModule(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
