import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isAddress, formatUnits } from 'ethers';
import { expiryMs } from './baw.mjs';
import { verifyCanonicalReceipt } from './transaction-receipt.mjs';
import { createRouteOrders, isBlockingRouteOrder } from './route-orders.mjs';
import {verifiedAllowanceChanges} from './allowance-consumption.mjs';

const unfinished = new Set(['SUBMITTING', 'UNKNOWN', 'BROADCASTED', 'PENDING_CONFIRMATION', 'MINED', 'ROUTE_RUNNING', 'ROUTE_PAUSED']);
const blocksOrder = order => order.kind === 'route' ? isBlockingRouteOrder(order) : unfinished.has(order.status);
const publicCopy = value => JSON.parse(JSON.stringify(value));

export function validateInput(input) {
  if (!input || Object.keys(input).some(k => !['token', 'side', 'amount', 'slippageBps', 'platformId', 'sellPercentBps', 'maxPriceImpactBps', 'settlement'].includes(k))) throw new Error('未知请求字段');
  if (input.settlement !== undefined && !['bnb', 'quote'].includes(input.settlement)) throw new Error('结算币种无效');
  if (input.platformId !== undefined && !['four', 'gang', 'flap'].includes(input.platformId)) throw new Error('平台标识无效');
  if (input.sellPercentBps !== undefined && (input.platformId !== 'flap' || input.side !== 'sell' || !Number.isInteger(input.sellPercentBps) || input.sellPercentBps < 1 || input.sellPercentBps > 10000)) throw new Error('份额卖出百分比无效');
  if (!isAddress(input.token) || !['buy', 'sell'].includes(input.side)) throw new Error('代币地址或买卖方向不合法');
  if (typeof input.amount !== 'string' || input.amount.length > 80 || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(input.amount) || !/[1-9]/.test(input.amount)) throw new Error('金额必须为正十进制字符串，最多18位小数');
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 10 || input.slippageBps > 5000) throw new Error('滑点必须为 10–5000 bps');
  if (input.maxPriceImpactBps !== undefined && (!Number.isInteger(input.maxPriceImpactBps) || input.maxPriceImpactBps < 50 || input.maxPriceImpactBps > 500)) throw new Error('价格冲击上限必须为 50–500 bps');
}

// 日志只存公开交易参数，不存认证信息。落盘先于发送，进程崩溃后不自动重发。
export function createTradeService({ protocol, baw, liveExecution = false, demo = false, warmPreviews = false, trustedWalletAddress, journalPath, now = Date.now, performanceNow = () => performance.now() }) {
  if(trustedWalletAddress!==undefined&&!isAddress(trustedWalletAddress))throw Error('服务端钱包绑定无效');
  const settingsPath=journalPath&&journalPath+'.settings';
  let approvalPolicy={enabled:false,automaticSetup:false,walletAddress:null,revision:0,optedAt:0};
  if(settingsPath&&existsSync(settingsPath)){const saved=JSON.parse(readFileSync(settingsPath,'utf8'));if(typeof saved.enabled==='boolean'&&isAddress(saved.walletAddress||'')&&Number.isSafeInteger(saved.revision)&&Number.isFinite(saved.optedAt))approvalPolicy={...saved,automaticSetup:saved.automaticSetup===true};}
  const previews = new Map();
  let orders = [];
  let executing = false;
  let refreshing = false;
  let executionVersion = 0;
  let activeProgress = null;
  let prepared = null, preparing = null, preparationVersion = 0;
  const intents = new Map();
  let placing = null;
  const normalizeInput = input => { validateInput(input); return { ...input, maxPriceImpactBps: input.maxPriceImpactBps ?? 300 }; };
  const preparationKey = async (input, wallet) => JSON.stringify([56, wallet.address.toLowerCase(), executionVersion, await protocol.preparationKey?.(input), input.platformId || 'four', input.token.toLowerCase(), input.side, input.amount, input.slippageBps, input.maxPriceImpactBps, input.sellPercentBps ?? null, ...(input.settlement === undefined ? [] : [input.settlement])]);
  const receiptOrders = new Map(), receiptListeners = new Set(), orderTicks = new Map();
  const trackReceipt = order => {
    if (order.kind !== 'route' && !demo && protocol.provider && order.txHash && unfinished.has(order.status) && !order.receiptMismatch) receiptOrders.set(order.id, order);
    else receiptOrders.delete(order.id);
  };
  const notifyReceipts = () => { for (const fn of receiptListeners) { try { fn(); } catch { /* A UI observer cannot change a submitted order. */ } } };
  const elapsedSince = started => Math.max(0, performanceNow() - started);
  const walletContext = () => typeof baw.executionContext === 'function' ? baw.executionContext() : baw.wallet();
  function reservePreparation(){
    const cached=prepared;prepared=null;
    if(!cached||now()<cached.quotedAt||now()>=cached.expiresAt||elapsedSince(cached.readyTick??cached.quotedTick)>=(cached.ticketId?10000:3000))return null;
    return {...cached,reservedAt:now(),reservedTick:performanceNow(),ageAtClickMs:elapsedSince(cached.readyTick??cached.quotedTick)};
  }
  const matchingPreparation=(cached,key)=>cached?.key===key&&now()>=cached.quotedAt&&now()>=cached.reservedAt&&now()<cached.quotedAt+30000&&elapsedSince(cached.quotedTick)<30000;
  function beginProgress(operation) {
    const startedAt = now();
    const startedTick = performanceNow();
    const state = { operation, stage: null, startedAt, stageStartedAt: startedAt, startedTick };
    activeProgress = state;
    return state;
  }
  async function measureStage(state, stage, key, timings, action) {
    state.stage = stage;
    state.stageStartedAt = now();
    const started = performanceNow();
    try { return await action(); }
    finally { timings[key] = elapsedSince(started); }
  }
  function finishProgress(state, timings) {
    timings.totalMs = elapsedSince(state.startedTick);
    if (activeProgress === state) activeProgress = null;
  }
  function progress() {
    if (!activeProgress) return { operation: null, stage: 'idle', startedAt: null, stageStartedAt: null, elapsedMs: 0 };
    const { operation, stage, startedAt, stageStartedAt, startedTick } = activeProgress;
    return { operation, stage, startedAt, stageStartedAt, elapsedMs: elapsedSince(startedTick) };
  }
  const isLiveExecution = () => !demo && liveExecution === true;
  function setLiveExecution(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('实盘开关必须为布尔值');
    if (demo && enabled) throw new Error('演示模式不能开启实盘');
    liveExecution = enabled;
    executionVersion++;
    preparationVersion++; prepared = null;
    previews.clear();
    return isLiveExecution();
  }
  function assertExecutionEnabled(version) {
    if (!demo && !isLiveExecution()) throw new Error('实盘执行未开启：请开启实盘开关（ENABLE_LIVE_TRADING）后重新预览');
    if (version !== executionVersion) throw new Error('实盘开关已变化，原预览失效，请重新预览');
  }
  function checkQuickPreview(p){
    const risk=p.raw?.risks,simulation=p.raw?.simulationResult;
    if(!risk||!Array.isArray(risk.riskDetails)||risk.riskDetails.length||!risk.addresses||Object.keys(risk.addresses).length||!simulation||!Array.isArray(simulation.authorityChanges)||simulation.authorityChanges.length||!verifiedAllowanceChanges(simulation.allowanceChanges,p.transaction))throw Error('钱包返回风险提示、权限变更或风险信息不完整，已停止快捷下单；请核对钱包信息');
  }
  function rememberPreview({built,input,wallet,raw,quotedAt,version,timings,preparation}){
    if(version!==executionVersion)throw Error('实盘开关已变化，原预览失效，请重新预览');
    if(!raw?.requestId)throw Error('钱包预览没有返回 requestId，禁止执行');
    const upstream=expiryMs(raw.expiresAt);if(upstream===null)throw Error('钱包预览到期时间不可读');
    const expiresAt=Math.min(quotedAt+30000,upstream,Number.isSafeInteger(built.summary?.deadline)?built.summary.deadline*1000:Infinity);
    if(expiresAt<=now())throw Error('钱包预览已过期');
    for(const[id,p]of previews)if(p.expiresAt<=now())previews.delete(id);
    if(previews.size>=100)throw Error('预览过多，请稍后再试');
    const p={id:randomUUID(),quotedAt,expiresAt,executionVersion:version,transaction:built.transaction,summary:built.summary,kind:built.kind||input.side,raw,demo,input:{...input},walletAddress:wallet.address,timings,preparation};
    previews.set(p.id,p);return p;
  }
  if (journalPath && existsSync(journalPath)) {
    orders = JSON.parse(readFileSync(journalPath, 'utf8'));
    for (const o of orders) if (o.status === 'SUBMITTING') { o.status = 'UNKNOWN'; o.error = '服务在提交过程中重启；请核对钱包历史，禁止自动重发。'; }
  }
  for (const order of orders) trackReceipt(order);
  const save = () => {
    if (!journalPath) return;
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    writeFileSync(`${journalPath}.tmp`, JSON.stringify(orders, null, 2), { mode: 0o600 });
    renameSync(`${journalPath}.tmp`, journalPath);
  };

  const routeOrders = createRouteOrders({ protocol, baw, orders: () => orders, persist: save, walletContext, assertEnabled: assertExecutionEnabled, now, onChange: notifyReceipts, assertRoute: plan=>{if((plan.kind==='preapproval'&&!plan.revoke||plan.kind==='single-setup')&&(!(plan.kind==='single-setup'?approvalPolicy.automaticSetup:approvalPolicy.enabled)||approvalPolicy.revision!==plan.consentVersion||approvalPolicy.walletAddress!==plan.walletAddress.toLowerCase()))throw Error('自动授权选项已经关闭或改变');} });
  routeOrders.pauseRestarted();

  // Preparation never signs or submits. Live opted-in workers may also create
  // a private wallet preview; only an explicit order intent can execute it.
  async function prepare(input) {
    input = normalizeInput(input);
    if (executing || activeProgress) throw new Error('交易正在处理中，暂停后台准备');
    const execution=executionVersion,started = performanceNow(), wallet = await walletContext();
    if (!wallet.available || !wallet.address) throw new Error(wallet.error || '请先连接钱包');
    const key = await preparationKey(input, wallet);
    if (preparing) {
      if (preparing.key !== key) throw new Error('另一个只读准备尚未完成，请稍后再试');
      return publicCopy(await preparing.promise);
    }
    const version = ++preparationVersion, quotedAt = now(), quotedTick = performanceNow();
    prepared = null;
    const task = { key };
    preparing = task;
    task.promise = (async () => {
      const route = await protocol.planRoute?.({ ...input, walletAddress: wallet.address });
      if (route) {
        const completedAt=now(),completedTick=performanceNow(),expiresAt=Math.min(completedAt+3000,route.deadline*1000);
        if(version===preparationVersion&&expiresAt>now())prepared={key,route,quotedAt:completedAt,quotedTick:completedTick,version,expiresAt};
        return {readOnly:true,demo,kind:'route',route,steps:route.steps,summary:route.summary,quotedAt,expiresAt,remainingMs:Math.max(0,expiresAt-now()),preparationVersion:version,timings:{totalMs:elapsedSince(started)}};
      }
      const built = await protocol.buildTrade({ ...input, walletAddress: wallet.address });
      if(warmPreviews&&isLiveExecution()&&version===preparationVersion&&execution===executionVersion&&['buy','sell'].includes(built.kind||input.side)&&!orders.some(blocksOrder)){
        const previewTick=performanceNow(),raw=await baw.preview(built.transaction,{context:wallet});
        const p=rememberPreview({built,input,wallet,raw,quotedAt,version:execution,timings:{walletCheckMs:Math.max(0,quotedTick-started),quoteSimulationMs:Math.max(0,previewTick-quotedTick),walletPreviewMs:elapsedSince(previewTick)},preparation:{reused:true,executionReady:true}});
        try{checkQuickPreview(p);}catch(e){previews.delete(p.id);throw e;}
        const readyTick=performanceNow(),expiresAt=Math.min(now()+10000,p.expiresAt);
        if(version===preparationVersion&&execution===executionVersion)prepared={key,built,ticketId:p.id,quotedAt,quotedTick,readyTick,expiresAt,version};else previews.delete(p.id);
        return{readOnly:true,demo,kind:p.kind,executionReady:version===preparationVersion&&execution===executionVersion,summary:p.summary,quotedAt,expiresAt,remainingMs:Math.max(0,expiresAt-now()),preparationVersion:version,timings:{...p.timings,totalMs:elapsedSince(started)}};
      }
      const readyAt=now(),readyTick=performanceNow(),expiresAt=Math.min(readyAt+3000,quotedAt+30000,Number.isSafeInteger(built.summary?.deadline)?built.summary.deadline*1000:Infinity);
      const timings = { walletCheckMs: Math.max(0, quotedTick - started), quoteSimulationMs: elapsedSince(quotedTick), totalMs: elapsedSince(started) };
      const result = { readOnly: true, demo, kind: built.kind || input.side, summary: built.summary, quotedAt, expiresAt, remainingMs: Math.max(0, expiresAt-now()), preparationVersion: version, timings };
      if (version === preparationVersion && now() < expiresAt) prepared = { key, built, quotedAt, quotedTick, readyTick, expiresAt, version };
      return result;
    })();
    try { return publicCopy(await task.promise); }
    finally { if (preparing === task) preparing = null; }
  }

  async function preview(input) {return buildPreview(input,{cached:reservePreparation()});}
  async function buildPreview(input,{wallet:checkedWallet,routeChecked=false,cached,deferSetup=false,constructed}={}) {
    input = normalizeInput(input);
    if (routeOrders.isBusy() || orders.some(isBlockingRouteOrder)) throw new Error('存在处理中或未完成的 BNB 路线，请先核对路线结果');
    const version = executionVersion;
    for (const [id, p] of previews) if (p.expiresAt < now()) previews.delete(id);
    if (previews.size >= 100) throw new Error('预览过多，请稍后再试');
    const timings = {};
    const operation = beginProgress('preview');
    let p;
    try {
      const wallet = await measureStage(operation, 'wallet-check', 'walletCheckMs', timings, () => checkedWallet || walletContext());
      if (!wallet.available || !wallet.address) throw new Error(wallet.error || '请先安装 baw 并登录 Agent Wallet');
      if (!routeChecked && await protocol.planRoute?.({ ...input, walletAddress: wallet.address })) throw new Error('多步骤 BNB 路线需要逐步确认到账后报价；请使用路线下单，不能手动预览未来资金交易');
      // 从构建/报价开始计时，包含 RPC 模拟和 Binance 预览的耗时。
      // 这只限制本地提交，不会为已提交或 App 待确认交易添加链上 deadline。
      let quotedAt = constructed?.quotedAt??now(), preparation = { reused: false };
      const built = await measureStage(operation, 'quote-simulation', 'quoteSimulationMs', timings, async () => {
        if(constructed?.built)return constructed.built;
        const key = await preparationKey(input, wallet);
        if (preparing?.key === key) {await preparing.promise;cached ||= reservePreparation();}
        if (cached?.built && matchingPreparation(cached,key) && key === await preparationKey(input, wallet)) {
          quotedAt = cached.quotedAt;
          preparation = { reused: true, ageMs: cached.ageAtClickMs, version: cached.version };
          return cached.built;
        }
        quotedAt = now();
        return protocol.buildTrade({ ...input, walletAddress: wallet.address });
      });
      if (now() >= quotedAt + 30_000) throw new Error('报价已过期，请重新预览');
      if(deferSetup&&built.kind==='approve')return{...built,walletAddress:wallet.address,warmSetup:true,timings};
      const raw = await measureStage(operation, 'wallet-preview', 'walletPreviewMs', timings, () => baw.preview(built.transaction, { context: wallet }));
      p=rememberPreview({built,input,wallet,raw,quotedAt,version,timings,preparation});
    } catch (error) { error.timings = timings; throw error; }
    finally { finishProgress(operation, timings); }
    return publicCopy(p);
  }

  async function execute({ previewId, confirmed }) {
    if (confirmed !== true) throw new Error('必须明确确认预览交易');
    assertExecutionEnabled(executionVersion);
    const prior = orders.find(o => o.previewId === previewId);
    if (prior) return publicCopy(prior);
    const p = previews.get(previewId);
    if (!p || now() >= p.expiresAt) throw new Error('预览已过期，请重新预览');
    assertExecutionEnabled(p.executionVersion);
    if (placing && p.directIntent?.id !== placing || executing || routeOrders.isBusy() || orders.some(blocksOrder)) throw new Error('存在未完成或结果未知的订单，请先核对结果');
    executing = true;
    const timings = {...p.timings,...p.requestTimings};
    const operation = beginProgress('execute');
    const order = { id: randomUUID(), previewId, ...(p.directIntent ? {intentId:p.directIntent.id,intentKey:p.directIntent.key} : {}), token: p.input.token, platformId: p.summary?.platformId || p.input.platformId || 'four', quoteSymbol: p.kind === 'wrap' ? 'BNB → WBNB' : p.summary?.quoteSymbol || 'BNB', positionKind: p.summary?.positionKind || 'token', side: p.input.side, kind: p.kind, amount: p.kind === 'wrap' ? formatUnits(p.transaction.value, 18) : p.input.amount, status: 'SUBMITTING', createdAt: new Date(now()).toISOString(), txHash: null, transaction: p.transaction, walletAddress:p.walletAddress, requestId: p.raw.requestId, demo, timings };
    orders.unshift(order);
    orderTicks.set(order.id, { started: operation.startedTick });
    let submitted = false;
    try {
      try {
        await measureStage(operation, 'execution-check', 'executionCheckMs', timings, async () => {
          let walletCheckedAt;
          const checkTick=performanceNow();
          const checks=await Promise.allSettled([walletContext().then(w=>{walletCheckedAt=performanceNow();timings.walletAuthorizationMs=elapsedSince(checkTick);return w;}),Promise.resolve().then(()=>protocol.validateExecution?.(p.transaction,p.summary)).finally(()=>{timings.protocolCheckMs=elapsedSince(checkTick);})]);
          for(const check of checks)if(check.status==='rejected')throw check.reason;
          let wallet=checks[0].value;
          if(elapsedSince(walletCheckedAt)>=5000||wallet.devMode&&expiryMs(wallet.devMode.expiresAt)<=now()||wallet.sessionExpiresAt!==undefined&&wallet.sessionExpiresAt<=now())wallet=await walletContext();
          if (wallet.available === false || !wallet.address || wallet.address.toLowerCase() !== p.walletAddress.toLowerCase()) throw new Error('当前钱包与预览钱包不一致，请重新预览');
          // 开关可能在任意 await 期间被关闭，或关闭后重新开启。
          assertExecutionEnabled(p.executionVersion);
          if (now() >= p.expiresAt) throw new Error('预览已过期，请重新预览');
        });
        save(); // 不能成功记录提交意图时，不发送。
      } catch (error) {
        orders = orders.filter(o => o !== order);
        orderTicks.delete(order.id);
        previews.delete(previewId);
        throw error;
      }
      submitted = true;
      try {
        const result = await measureStage(operation, 'submission', 'submissionMs', timings, () => baw.execute(p.raw.requestId));
        // 这是钱包提交响应时间；待 App 确认或 UNKNOWN 仍不代表链上广播。
        order.submittedAt = new Date(now()).toISOString();
        order.raw = result;
        order.orderId = result.orderId ?? null;
        order.txHash = /^0x[0-9a-fA-F]{64}$/.test(result.txHash || '') ? result.txHash : null;
        orderTicks.get(order.id).submitted = performanceNow();
        if (order.txHash && !demo) {
          order.firstHashObservedAt = order.submittedAt;
          timings.firstHashMs = elapsedSince(operation.startedTick);
          if(p.requestTick!==undefined)timings.requestToHashMs=elapsedSince(p.requestTick);
        }
        order.status = demo ? 'DEMO_COMPLETED' : result.status === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : order.txHash ? 'BROADCASTED' : 'UNKNOWN';
        order.message = result.message ?? null;
      } catch (error) {
        // 网络超时有可能已发送。保留请求ID，绝不把它当可重试失败。
        order.status = 'UNKNOWN';
        order.error = error.message;
        if (error.cliError) order.cliError = error.cliError;
      }
    } catch (error) { error.timings = timings; throw error; }
    finally {
      executing = false;
      finishProgress(operation, timings);
      if(p.requestTick!==undefined){timings.executionTotalMs=timings.totalMs;timings.requestTotalMs=elapsedSince(p.requestTick);timings.totalMs=timings.requestTotalMs;}
      if (submitted) {
        previews.delete(previewId);
        // Submission may already exist on-chain. A disk failure must not hide
        // its hash from the active observer or allow an automatic resend.
        try { save(); }
        finally { trackReceipt(order); notifyReceipts(); }
      }
    }
    return publicCopy(order);
  }

  // An intent represents one explicit click. Replays, including an ambiguous
  // network result, must never create a second wallet request or submission.
  async function place(input, { intentId, expectedWallet } = {}) {
    input = normalizeInput(input);
    if (typeof intentId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(intentId)) throw new Error('下单意图 ID 无效');
    if (expectedWallet !== undefined && !isAddress(expectedWallet)) throw new Error('预期钱包地址无效');
    const key = JSON.stringify([input.platformId || 'four', input.token.toLowerCase(), input.side, input.amount, input.slippageBps, input.maxPriceImpactBps, input.sellPercentBps ?? null, ...(input.settlement === undefined ? [] : [input.settlement])]);
    const prior = intents.get(intentId);
    const replay = async () => {
      if (prior.key !== key || prior.version !== executionVersion) throw new Error('下单意图已绑定不同参数或执行状态');
      const wallet = await walletContext();
      if (prior.wallet && wallet.address?.toLowerCase() !== prior.wallet || expectedWallet && wallet.address?.toLowerCase() !== expectedWallet.toLowerCase()) throw new Error('下单意图已绑定不同钱包');
      return publicCopy(await prior.promise);
    };
    if (prior && !prior.done) return replay();
    const durable = orders.find(o => o.intentId === intentId);
    if (durable) {
      if (durable.intentKey !== key) throw new Error('下单意图已绑定不同参数');
      const wallet = await walletContext(), original = durable.transaction?.from?.toLowerCase();
      if (!original || wallet.address?.toLowerCase() !== original || expectedWallet && expectedWallet.toLowerCase() !== original) throw new Error('下单意图已绑定不同钱包');
      return publicCopy({intentId,status:durable.status,submitted:true,demo:durable.demo,walletAddress:wallet.address,order:durable,timings:durable.timings});
    }
    if (prior) return replay();
    const blocked=orders.filter(blocksOrder),pendingApproval=blocked.length===1&&approvalPolicy.automaticSetup&&protocol.planAutomaticSetup&&input.side==='sell'&&blocked[0].route?.kind==='preapproval'&&!blocked[0].route.revoke&&blocked[0].status==='ROUTE_RUNNING'&&blocked[0].walletAddress?.toLowerCase()===approvalPolicy.walletAddress&&blocked[0].token?.toLowerCase()===input.token.toLowerCase()&&blocked[0].steps?.some(s=>s.txHash&&['BROADCASTED','MINED'].includes(s.status))?blocked[0]:null;
    if (placing || executing || activeProgress || !pendingApproval&&(refreshing||routeOrders.isBusy()||blocked.length)) throw new Error('存在处理中、未完成或结果未知的订单，请先核对结果');
    for (const [id, item] of intents) if (item.done && now() - item.createdAt > 300_000) intents.delete(id);
    if (intents.size >= 200) throw new Error('下单记录已满，请稍后再试');
    const entry = { key, version: executionVersion, createdAt: now(), done: false, wallet: null };
    placing = intentId;
    intents.set(intentId, entry);
    const clickedTick=performanceNow();let reserved=reservePreparation(),initialWalletCheckMs,preparationWaitMs=0;
    entry.promise = Promise.resolve().then(async () => {
      if(pendingApproval){
        assertExecutionEnabled(entry.version);const walletAddress=pendingApproval.walletAddress;
        if(expectedWallet&&expectedWallet.toLowerCase()!==walletAddress.toLowerCase())throw Error('排队请求钱包已变化');entry.wallet=walletAddress.toLowerCase();
        const built=await protocol.buildTrade({...input,walletAddress});
        const plan=protocol.planAutomaticSetup({input,walletAddress,built,consentVersion:approvalPolicy.revision,waitingFor:pendingApproval});
        assertExecutionEnabled(entry.version);return routeOrders.enqueueApprovalWait(plan,{intentId,intentKey:key,executionVersion:entry.version});
      }
      if(!reserved&&preparing&&expectedWallet){
        const task=preparing,key=await preparationKey(input,{address:expectedWallet});
        if(task.key===key){const t=performanceNow();await task.promise;preparationWaitMs+=elapsedSince(t);reserved=reservePreparation();}
      }
      if(reserved?.ticketId){
        const p=previews.get(reserved.ticketId);
        if(p&&p.executionVersion===entry.version&&now()<p.expiresAt){
          const currentKey=await preparationKey(input,{address:p.walletAddress});
          if(matchingPreparation(reserved,currentKey)){
            if(expectedWallet&&p.walletAddress.toLowerCase()!==expectedWallet.toLowerCase())throw Error('当前钱包与点击下单时的钱包不一致，请刷新后重新操作');
            entry.wallet=p.walletAddress.toLowerCase();checkQuickPreview(p);p.directIntent={id:intentId,key};
            p.preparation={reused:true,executionReady:true,ageMs:reserved.ageAtClickMs};
            p.requestTick=clickedTick;p.requestTimings={preparationWaitMs};
            const order=await execute({previewId:p.id,confirmed:true});
            return{intentId,status:order.status,submitted:true,demo,walletAddress:p.walletAddress,summary:p.summary,order,preparation:p.preparation,timings:{...order.timings,totalMs:elapsedSince(clickedTick)}};
          }
        }
      }
      const checkTick=performanceNow();
      const authorization=walletContext().then(w=>{initialWalletCheckMs=elapsedSince(checkTick);return w;});
      const construct=trustedWalletAddress&&!reserved&&!preparing&&isLiveExecution()?Promise.resolve().then(async()=>{
        const key=await preparationKey(input,{address:trustedWalletAddress}),route=await protocol.planRoute?.({...input,walletAddress:trustedWalletAddress});
        const quotedAt=now(),quoteTick=performanceNow(),built=route?null:await protocol.buildTrade({...input,walletAddress:trustedWalletAddress});
        return{key,route,built,quotedAt,quoteMs:elapsedSince(quoteTick)};
      }):null;
      const reads=await Promise.allSettled([authorization,construct]);for(const r of reads)if(r.status==='rejected')throw r.reason;
      const wallet=reads[0].value,constructed=reads[1].value;
      if (!wallet.available || !wallet.address) throw new Error(wallet.error || '请先连接钱包');
      if (expectedWallet && wallet.address.toLowerCase() !== expectedWallet.toLowerCase()) throw new Error('当前钱包与点击下单时的钱包不一致，请刷新后重新操作');
      entry.wallet = wallet.address.toLowerCase();
      if(constructed&&entry.wallet!==trustedWalletAddress.toLowerCase())throw Error('当前钱包与服务端绑定不一致');
      if (entry.version !== executionVersion) throw new Error('执行状态已变化，请重新下单');
      const routeKey=await preparationKey(input,wallet);
      if(constructed&&constructed.key!==routeKey)throw Error('准备期间市场路由已改变，请重新操作');
      let cached=reserved;
      if(preparing?.key===routeKey){await preparing.promise;cached ||= reservePreparation();}
      let route,preparation={reused:false};
      const quoteAgesValid=cached?.route?.steps?.every(s=>!s.quote||Number.isFinite(s.quote.quotedAt)&&now()>=s.quote.quotedAt&&now()-s.quote.quotedAt<15000);
      if(cached?.route&&matchingPreparation(cached,routeKey)&&now()<cached.route.deadline*1000&&quoteAgesValid&&routeKey===await preparationKey(input,wallet)){
        route=publicCopy(cached.route);preparation={reused:true,ageMs:cached.ageAtClickMs};
      }else route=constructed?constructed.route:await protocol.planRoute?.({...input,walletAddress:wallet.address});
      if (route) {
        if (entry.version !== executionVersion) throw new Error('执行状态已变化，请重新操作');
        if (!demo && !isLiveExecution()) {
          const current=await walletContext();
          if(current.address?.toLowerCase()!==entry.wallet||entry.version!==executionVersion)throw new Error('钱包或执行状态已变化，请重新操作');
          return { intentId, status: 'PREVIEW_ONLY', submitted: false, readOnly: true, demo, walletAddress: wallet.address, kind: 'route', route, steps: route.steps, summary: route.summary, preparation };
        }
        if (demo) throw new Error('演示模式不支持链上多步骤路线');
        if (executing || routeOrders.isBusy() || activeProgress || orders.some(blocksOrder)) throw new Error('存在处理中、未完成或结果未知的订单，请先核对结果');
        return {...await routeOrders.start(route,{intentId,intentKey:key,executionVersion:entry.version}),preparation};
      }
      if (!demo && !isLiveExecution()) {
        const result = await prepare(input);
        const current = await walletContext();
        if (current.address?.toLowerCase() !== entry.wallet || entry.version !== executionVersion) throw new Error('钱包或执行状态已变化，请重新操作');
        return { ...result, intentId, status: 'PREVIEW_ONLY', submitted: false, walletAddress: wallet.address };
      }
      const p = await buildPreview(input,{wallet,routeChecked:true,cached,constructed,deferSetup:approvalPolicy.automaticSetup&&approvalPolicy.walletAddress===entry.wallet&&Boolean(protocol.planAutomaticSetup)});
      if (p.walletAddress.toLowerCase() !== entry.wallet) throw new Error('钱包已变化，请重新下单');
      if(p.warmSetup&&(!approvalPolicy.automaticSetup||approvalPolicy.walletAddress!==entry.wallet))throw Error('自动授权选项已变化，请重新操作');
      if (['approve', 'wrap'].includes(p.kind)) {
        if(p.kind==='approve'&&approvalPolicy.automaticSetup&&approvalPolicy.walletAddress===p.walletAddress.toLowerCase()&&protocol.planAutomaticSetup){
          const built=p.warmSetup?p:previews.get(p.id),plan=protocol.planAutomaticSetup({input,walletAddress:p.walletAddress,built,consentVersion:approvalPolicy.revision});previews.delete(p.id);
          const initialBuilt={...built,summary:{...built.summary,approvalAsset:plan.approvalAsset,spender:plan.spender,approvalAmountRaw:plan.approvalAmountRaw}};
          return routeOrders.start(plan,{intentId,intentKey:key,executionVersion:entry.version,initialBuilt});
        }
        return { intentId, status: 'ACTION_REQUIRED', submitted: false, demo, walletAddress: p.walletAddress, summary: p.summary, timings: p.timings, action: p };
      }
      if (!demo) {
        try{checkQuickPreview(previews.get(p.id));}catch(error){previews.delete(p.id);throw error;}
      }
      previews.get(p.id).directIntent = {id:intentId,key};
      const currentPreview=previews.get(p.id);currentPreview.requestTick=clickedTick;currentPreview.requestTimings={initialWalletCheckMs,preparationWaitMs,...(constructed?{quoteSimulationMs:constructed.quoteMs}:{})};currentPreview.preparation=p.preparation;
      const order = await execute({ previewId: p.id, confirmed: true });
      return { intentId, status: order.status, submitted: true, demo, walletAddress: p.walletAddress, summary: p.summary, order, preparation:p.preparation, timings: { ...p.timings, ...order.timings, initialWalletCheckMs, totalMs:elapsedSince(clickedTick) } };
    }).finally(() => { entry.done = true; if (placing === intentId) placing = null; });
    return publicCopy(await entry.promise);
  }

  function recoveryOrder(orderId, { allowReleased = false } = {}) {
    if (typeof orderId !== 'string') throw new Error('订单 ID 无效');
    const order = orders.find(item => item.id === orderId);
    const allowed = ['UNKNOWN', 'PENDING_CONFIRMATION', ...(allowReleased ? ['MANUALLY_RELEASED'] : [])];
    if (order?.kind === 'route') throw new Error('多步骤路线需要逐笔核对回执；禁止使用单笔订单恢复入口');
    if (!order || !allowed.includes(order.status) || order.txHash) throw new Error('此订单不支持手动恢复');
    if (demo) throw new Error('演示订单不需要恢复');
    if (executing || refreshing) throw new Error('订单正在处理或查询中，请稍后恢复');
    return order;
  }

  // 恢复状态必须先可靠落盘；失败则恢复内存，不能悄悄解除订单锁。
  function persistRecovery(order, changes) {
    const previous = publicCopy(order);
    try { Object.assign(order, changes); save(); }
    catch (error) {
      for (const key of Object.keys(order)) delete order[key];
      Object.assign(order, previous);
      throw error;
    }
    trackReceipt(order); if (!unfinished.has(order.status)) orderTicks.delete(order.id); notifyReceipts();
    return publicCopy(order);
  }

  async function linkTransaction({ orderId, txHash, nonce, confirmed } = {}) {
    if (confirmed !== true) throw new Error('必须明确确认手动关联交易');
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('交易 hash 无效');
    if (typeof nonce === 'string' && /^(0|[1-9]\d*)$/.test(nonce)) nonce = Number(nonce);
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('请输入从交易详情核实的非负整数 nonce');
    const order = recoveryOrder(orderId, { allowReleased: true });
    if (!protocol.provider) throw new Error('RPC 不可用，无法验证手动关联');
    if (orders.some(other => other !== order && other.txHash?.toLowerCase() === txHash.toLowerCase())) throw new Error('此 hash 已关联到其他订单');
    executing = true;
    try {
      const provider = protocol.provider;
      const network = await provider.getNetwork();
      if (network.chainId !== 56n) throw new Error('恢复必须使用 BSC 主网（56）');
      const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
      const expected = order.transaction;
      if (!tx || tx.hash?.toLowerCase() !== txHash.toLowerCase() || tx.chainId !== 56n || tx.nonce !== nonce || tx.from?.toLowerCase() !== expected.from.toLowerCase() || tx.to?.toLowerCase() !== expected.to.toLowerCase() || tx.data?.toLowerCase() !== expected.data.toLowerCase() || BigInt(tx.value) !== BigInt(expected.value)) {
        throw new Error('链上交易的 chain/from/to/value/data/nonce 与订单或用户输入不匹配');
      }
      if (!Number.isSafeInteger(tx.blockNumber) || !receipt || receipt.hash?.toLowerCase() !== txHash.toLowerCase() || receipt.blockNumber !== tx.blockNumber || ![0, 1].includes(receipt.status)) throw new Error('交易尚未打包或回执无效，请稍后再关联');
      const block = await provider.getBlock(receipt.blockNumber);
      const createdAt = Date.parse(order.createdAt);
      const timestamp = block?.timestamp * 1000;
      if (!block || block.number !== receipt.blockNumber || block.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase() || block.hash?.toLowerCase() !== tx.blockHash?.toLowerCase() || !Number.isFinite(createdAt) || !Number.isFinite(timestamp) || timestamp < createdAt - 120_000 || timestamp > now() + 120_000) {
        throw new Error('交易区块不在当前链上，或交易时间不符合订单提交时间');
      }
      return persistRecovery(order, {
        txHash: tx.hash, status: 'BROADCASTED', manualLinked: true,
        manualLinkedAt: new Date(now()).toISOString(), linkedNonce: nonce,
        linkEvidence: { chainId: 56, nonce, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp },
        message: '用户手动关联 hash；已核对链上参数，等待回执确认。此关联不代表 CLI 提供了该 hash。',
      });
    } finally { executing = false; }
  }

  async function releaseOrder({ orderId, confirmed, chainHistoryChecked } = {}) {
    if (confirmed !== true || chainHistoryChecked !== true) throw new Error('必须明确确认已在 App 和链上历史核对订单，才能解除本地锁');
    const order = recoveryOrder(orderId);
    if (typeof baw.txLock !== 'function') throw new Error('钱包不支持实时交易锁查询，不能解除本地锁');
    executing = true;
    try {
      const wallet = await baw.wallet();
      if (!wallet.available || !wallet.address || wallet.address.toLowerCase() !== order.transaction.from.toLowerCase()) throw new Error('当前钱包与原订单不一致，不能解除本地锁');
      const lock = await baw.txLock();
      if (lock?.status !== 'UNLOCKED') throw new Error('Binance 钱包仍有交易或 App 确认锁，不能解除本地锁');
      const checkedAt = new Date(now()).toISOString();
      return persistRecovery(order, {
        status: 'MANUALLY_RELEASED', manuallyReleasedAt: checkedAt,
        releaseCheck: { status: 'UNLOCKED', address: wallet.address, checkedAt, chainHistoryChecked: true },
        message: '用户已核对历史并解除本地阻塞。这不是链上取消或失败证明；原请求不会重发，继续交易必须重新预览。',
      });
    } finally { executing = false; }
  }

  async function convert(input={}){
    if(Object.keys(input).some(k=>!['asset','amount','slippageBps','intentId','expectedWallet'].includes(k))||!protocol.planAssetConversion||!protocol.conversionToken)throw Error('兑换参数无效或当前服务不支持');
    const token=protocol.conversionToken(input.asset);validateInput({token,side:'sell',amount:input.amount,slippageBps:input.slippageBps});
    const {intentId,expectedWallet}=input;if(typeof intentId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(intentId)||!isAddress(expectedWallet||''))throw Error('兑换意图或钱包地址无效');
    const key=JSON.stringify(['asset-conversion',input.asset,input.amount,input.slippageBps]),prior=intents.get(intentId),durable=orders.find(o=>o.intentId===intentId);
    if(prior||durable){
      if((prior?.key??durable.intentKey)!==key)throw Error('兑换意图已绑定其他参数');const wallet=await walletContext();if(!wallet.address||wallet.address.toLowerCase()!==expectedWallet.toLowerCase()||durable&&wallet.address.toLowerCase()!==durable.walletAddress?.toLowerCase()||prior?.wallet&&wallet.address.toLowerCase()!==prior.wallet)throw Error('兑换意图已绑定其他钱包');
      if(prior)return publicCopy(await prior.promise);return{intentId,submitted:durable.steps.some(s=>s.submissionAttempted),walletAddress:wallet.address,order:publicCopy(durable)};
    }
    assertExecutionEnabled(executionVersion);if(demo||placing||executing||refreshing||preparing||activeProgress||routeOrders.isBusy()||orders.some(blocksOrder))throw Error('存在处理中或未知订单，请先核对后兑换');
    for(const[id,item]of intents)if(item.done&&now()-item.createdAt>300000)intents.delete(id);if(intents.size>=200)throw Error('下单记录已满，请稍后再试');
    const entry={key,version:executionVersion,createdAt:now(),done:false,wallet:null};placing=intentId;intents.set(intentId,entry);
    entry.promise=Promise.resolve().then(async()=>{
      const wallet=await walletContext();if(!wallet.available||wallet.address?.toLowerCase()!==expectedWallet.toLowerCase())throw Error('当前钱包与兑换请求不一致');entry.wallet=wallet.address.toLowerCase();assertExecutionEnabled(entry.version);
      const plan=await protocol.planAssetConversion({asset:input.asset,amount:input.amount,slippageBps:input.slippageBps,walletAddress:wallet.address});assertExecutionEnabled(entry.version);
      return routeOrders.start(plan,{intentId,intentKey:key,executionVersion:entry.version});
    }).finally(()=>{entry.done=true;if(placing===intentId)placing=null;});
    return publicCopy(await entry.promise);
  }
  async function reconcileRoute(input={}){
    if(Object.keys(input).some(k=>k!=='orderId')||typeof input.orderId!=='string')throw Error('路线核对参数无效');
    const order=orders.find(o=>o.id===input.orderId&&o.kind==='route');
    if(!order)throw Error('未找到本钱包的分步路线');
    if(executing||refreshing||placing||preparing||routeOrders.isBusy()||order.status==='ROUTE_RUNNING')throw Error('路线或钱包正在处理，请稍后核对');
    refreshing=true;
    try{const result=await routeOrders.refresh({reconcileOrderId:order.id});return{readOnly:true,...result,order:publicCopy(order)};}finally{refreshing=false;}
  }
  async function refresh() {
    if (!protocol.provider || demo || refreshing || executing || routeOrders.isBusy()) return { pending: receiptOrders.size, errors: 0 };
    refreshing = true;
    let errors = 0, changed = false;
    try {
      const routeResult = await routeOrders.refresh();
      errors += routeResult.errors; changed ||= routeResult.changed;
      // The active index excludes completed history; fast polling touches hashes only.
      for (const order of receiptOrders.values()) {
        try {
          const receipt = await protocol.provider.getTransactionReceipt(order.txHash);
          if (!receipt) {
            if (order.status === 'MINED') { order.status = 'BROADCASTED'; order.confirmations = 0; delete order.receiptStatus; delete order.receiptBlock; }
            continue;
          }
          const proof = await verifyCanonicalReceipt({ provider: protocol.provider, txHash: order.txHash, receipt, transaction: order.transaction });
          if (!proof.valid) {
            order.status = 'UNKNOWN'; order.receiptMismatch = true; order.error = '链上交易、回执或规范区块与 BSC 预览参数不匹配'; changed = true; trackReceipt(order); continue;
          }
          const { head } = proof;
          const observedAt = now();
          const previousStatus = order.status;
          if (!order.firstReceiptObservedAt) changed = true;
          order.firstReceiptObservedAt ??= new Date(observedAt).toISOString();
          if (receipt.status === 1) order.successfulReceiptObservedAt ??= new Date(observedAt).toISOString();
          order.receiptStatus = receipt.status;
          order.minedAt ??= new Date(observedAt).toISOString();
          order.confirmations = head - receipt.blockNumber + 1;
          order.status = order.confirmations >= 3 ? receipt.status === 1 ? 'CONFIRMED' : 'REVERTED' : 'MINED';
          if (order.status !== previousStatus) changed = true;
          if (order.confirmations >= 3) order.confirmedAt ??= new Date(observedAt).toISOString();
          const submittedAt = Date.parse(order.submittedAt);
          if (Number.isFinite(submittedAt)) {
            order.timings ??= {};
            const tick = orderTicks.get(order.id)?.submitted;
            const waited = Number.isFinite(tick) ? elapsedSince(tick) : Math.max(0, observedAt - submittedAt);
            order.timings.firstReceiptWaitMs ??= waited;
            order.timings.confirmationWaitMs = waited;
          }
          order.receiptBlock = receipt.blockNumber;
          delete order.error;
          trackReceipt(order);
          if (!receiptOrders.has(order.id)) orderTicks.delete(order.id);
        } catch (error) { errors++; order.error = `回执查询失败：${error.shortMessage || error.message}`; }
      }
      save();
      await autoApproveConfirmed();
    } finally { refreshing = false; }
    return { pending: receiptOrders.size + routeOrders.pendingCount(), errors, changed };
  }

  async function approvalSettings() {
    const wallet=await baw.wallet(),owner=wallet.address?.toLowerCase();
    return {enabled:Boolean(owner&&approvalPolicy.enabled&&approvalPolicy.walletAddress===owner),automaticSetup:Boolean(owner&&approvalPolicy.automaticSetup&&approvalPolicy.walletAddress===owner),walletAddress:owner||null,defaultEnabled:false,approvals:orders.filter(o=>o.kind==='route'&&o.route?.kind==='preapproval'&&o.walletAddress?.toLowerCase()===owner).map(o=>({orderId:o.id,token:o.token,spender:o.route.spender,amountRaw:o.routeState?.allowanceRaw??o.route.amountRaw,status:o.status,revoke:o.route.revoke,createdAt:o.createdAt})),message:'关闭只停止新的后台授权；已有链上额度请逐项撤销。'};
  }
  async function setApprovalSettings(body) {
    if(!body||!Object.keys(body).length||Object.keys(body).some(k=>!['enabled','automaticSetup'].includes(k)||typeof body[k]!=='boolean'))throw Error('自动授权设置必须为布尔值');
    const wallet=await (body.enabled||body.automaticSetup?walletContext():baw.wallet());if(!isAddress(wallet.address||''))throw Error('请先连接本人钱包');
    const sameOwner=approvalPolicy.walletAddress===wallet.address.toLowerCase();const next={enabled:body.enabled??(sameOwner&&approvalPolicy.enabled),automaticSetup:body.automaticSetup??(sameOwner&&approvalPolicy.automaticSetup),walletAddress:wallet.address.toLowerCase(),revision:approvalPolicy.revision+1,optedAt:body.enabled===true?now():approvalPolicy.optedAt};
    if(settingsPath){mkdirSync(dirname(settingsPath),{recursive:true,mode:0o700});writeFileSync(settingsPath+'.tmp',JSON.stringify(next),{mode:0o600});renameSync(settingsPath+'.tmp',settingsPath);}approvalPolicy=next;
    return approvalSettings();
  }
  async function autoApproveConfirmed() {
    if(!isLiveExecution()||!approvalPolicy.enabled||!protocol.planPreapproval||orders.some(blocksOrder))return;
    const source=orders.find(o=>o.status==='CONFIRMED'&&o.side==='buy'&&!o.preapproval&&Date.parse(o.createdAt)>=approvalPolicy.optedAt&&o.walletAddress?.toLowerCase()===approvalPolicy.walletAddress&&(o.kind!=='route'||o.route.kind!=='preapproval'));
    if(!source)return;
    const revision=approvalPolicy.revision,version=executionVersion;source.preapproval={status:'PREPARING'};save();
    try{
      const wallet=await walletContext();if(wallet.address?.toLowerCase()!==approvalPolicy.walletAddress)throw Error('当前钱包已变化');
      const plan=await protocol.planPreapproval({token:source.token,platformId:source.platformId,walletAddress:wallet.address,consentVersion:revision});
      assertExecutionEnabled(version);
      if(!approvalPolicy.enabled||approvalPolicy.revision!==revision)throw Error('预授权选项已经改变');
      const result=await routeOrders.start(plan,{intentId:'autoapproval-'+source.id,intentKey:source.id,executionVersion:version});source.preapproval={status:result.order.status,orderId:result.order.id};
    }catch(error){source.preapproval={status:'SKIPPED',message:error.message};}finally{save();}
  }
  async function revokePreapproval(body) {
    if(!body||Object.keys(body).length!==1||typeof body.orderId!=='string')throw Error('撤销参数无效');
    if(executing||refreshing||placing||routeOrders.isBusy()||orders.some(blocksOrder))throw Error('存在未完成订单，暂不能撤销');
    assertExecutionEnabled(executionVersion);const version=executionVersion;
    const source=orders.find(o=>o.id===body.orderId&&o.route?.kind==='preapproval'&&!o.route.revoke);if(!source)throw Error('没有已核验的原授权记录');
    const prior=orders.find(o=>o.revokesOrder===source.id);if(prior)return publicCopy(prior);
    executing=true;
    try{const wallet=await walletContext();if(wallet.address?.toLowerCase()!==source.walletAddress?.toLowerCase())throw Error('原授权属于不同钱包');const plan=await protocol.planPreapproval({token:source.token,platformId:source.platformId,walletAddress:wallet.address,spender:source.route.spender,revoke:true,originalApproval:source.route});assertExecutionEnabled(version);const result=await routeOrders.start(plan,{intentId:'revoke-'+source.id,intentKey:source.id,executionVersion:version});result.order.revokesOrder=source.id;const stored=orders.find(o=>o.id===result.order.id);stored.revokesOrder=source.id;save();return publicCopy(stored);}finally{executing=false;}
  }

  function lifecycle() {
    return { busy: Boolean(executing || refreshing || preparing || placing || activeProgress || routeOrders.isBusy()), pending: orders.some(order => unfinished.has(order.status) || order.status === 'ROUTE_PAUSED' || blocksOrder(order)) };
  }
  function checkpoint() {
    if (!journalPath) return;
    save();
    for (const path of [journalPath, dirname(journalPath)]) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  }
  function invalidateQuotes(){preparationVersion++;prepared=null;previews.clear();}
  return { convert,reconcileRoute,invalidateQuotes,approvalSettings,setApprovalSettings,revokePreapproval,prepare, preview, execute, place, linkTransaction, releaseOrder, refresh, progress, setLiveExecution, isLiveExecution, lifecycle, checkpoint, receiptPending: () => receiptOrders.size + routeOrders.pendingCount(), watchReceipts(fn) { receiptListeners.add(fn); return () => receiptListeners.delete(fn); }, list: () => publicCopy(orders) };
}
