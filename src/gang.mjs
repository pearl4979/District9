import {recordAllowanceConsumption} from './allowance-consumption.mjs';
import { readFileSync } from 'node:fs';
import { Contract, Interface, ZeroAddress, formatUnits, getAddress,keccak256 } from 'ethers';
import { gangMetrics } from './market-metrics.mjs';
import { createGangMergedSource } from './gang-merged.mjs';
import {createGangMergedProtocol} from './gang-merged-trading.mjs';
import {gangBuyQuote,gangSellQuote} from './gang-curve-quote.mjs';
export {gangBuyQuote,gangSellQuote} from './gang-curve-quote.mjs';
import { priceImpactLimit, gangTradeRisk, enforceTradeRisk, withRiskGas } from './trade-risk.mjs';
import { parseDecimalAmount, slippageFloor } from './protocol.mjs';
import { ERC20, ercInterface, same, check, readContract, simulate, checkDrift, exactApproval, mapLimited, getJson, messageOf } from './market-utils.mjs';

const config = JSON.parse(readFileSync(new URL('../config/platforms.json', import.meta.url)));
const VIRTUAL = 1066666666666666666666666667n;
const ABI = [
  'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,bool taxed,address pair,address refPair)',
  'function agentGateEnabled() view returns(bool)', 'function walletCapEnabled() view returns(bool)',
  'function PROTOCOL_FEE_BPS() view returns(uint256)', 'function walletRoom(address,address) view returns(uint256)',
  'function isAgent(address) view returns(bool)', 'function logoURIOf(address) view returns(string)',
  'function buy(address,uint256,uint256) returns(uint256)', 'function sell(address,uint256,uint256) returns(uint256)',
];
const iface = new Interface(ABI);

// 独立保留毕业/高进度窗口，不能被“最近创建160个”全部挤掉。
// 索引仅选候选；最终phase仍由getTokenState读取链上曲线。
export function selectGangCandidates({recent=[],progress=[],graduated=[]},limit=160) {
  const selected=new Map();
  const add=(rows,max)=>{for(const r of rows){if(selected.size>=max)break;if(/^0x[0-9a-f]{40}$/i.test(r.address))selected.set(r.address.toLowerCase(),r);}};
  add([...graduated].sort((a,b)=>(b.graduatedAt||0)-(a.graduatedAt||0)),Math.min(40,limit));
  add([...progress].filter(r=>!r.graduated).sort((a,b)=>(b.progressPct||0)-(a.progressPct||0)),Math.min(selected.size+24,limit));
  add([...recent].sort((a,b)=>b.createdAt-a.createdAt),limit);
  return [...selected.values()];
}

export function createGangProtocol({ provider, fetchJson = getJson,now=Date.now,verifyQuoteAsset=async args=>(await import('./quote-asset-policy.mjs')).verifiedQuoteAsset(args) } = {}) {
  const mergedProtocol=createGangMergedProtocol({provider,now,verifyQuoteAsset});
  const mergedMarket=t=>t?.pad==='merged'&&['curve-v3','fair'].includes(t.launchType);
  const pads = Object.entries(config.gang.pads).filter(([id]) => id !== 'soft').map(([id, value]) => ({ id, ...value }));
  const read = (address, method, args = [], blockTag = 'latest') => readContract(provider, address, ABI, method, args, blockTag);
  async function initialize(blockTag='latest') {
    check((typeof provider.send === 'function' ? BigInt(await provider.send('eth_chainId', [])) : (await provider.getNetwork()).chainId) === 56n, 'Gang 必须使用 BSC 主网');
    check(keccak256(await provider.getCode(config.gang.pads.v2.address,blockTag))===config.gang.pads.v2.codeHash,'合约实现已变化或不存在，请重新核验平台');
    const [gate, fee] = await Promise.all([read(config.gang.pads.v2.address, 'agentGateEnabled',[],blockTag), read(config.gang.pads.v2.address, 'PROTOCOL_FEE_BPS',[],blockTag)]);
    check(gate === true && fee === 100n, 'Gang Agent gate 或交易费已改变，需要重新核验');
  }
  async function resolve(token, hint,blockTag) {
    token = getAddress(token);
    const preferred = pads.find(p => same(p.address, hint?.v2Launchpad));
    for (const pad of preferred ? [preferred, ...pads.filter(p => p !== preferred)] : pads) {
      // RPC 异常不被当作“没有代币”。未知入口可能正常返回零结构。
      const c = await read(pad.address, 'curves', [token],blockTag);
      if (!same(c.creator, ZeroAddress)) return { pad, curve: c };
    }
    throw new Error('不是已核验 Gang 发射台的代币');
  }
  async function getTokenState(token, { hint, blockTag = 'latest' } = {}) {
    if(mergedMarket(hint))return mergedProtocol.getTokenState(token);
    token = getAddress(token);
    const { pad, curve: c } = await resolve(token, hint,blockTag);
    const [quoteSymbolValue,quoteDecimals]=await Promise.all(['symbol','decimals'].map(method=>readContract(provider,c.quote,ERC20,method,[],blockTag)));
    check(Number(quoteDecimals)>=0&&Number(quoteDecimals)<=18,'底池币精度超出当前支持范围');
    const quote={symbol:String(quoteSymbolValue).slice(0,32),decimals:Number(quoteDecimals)};
    const asset = new Contract(token, ERC20, provider);
    const [name, symbol, decimals] = hint ? [String(hint.name).slice(0, 200), String(hint.symbol).slice(0, 32), 18] : await Promise.all([asset.name({ blockTag }), asset.symbol({ blockTag }), asset.decimals({ blockTag })]);
    const supported = pad.id === 'v2';
    const reason = c.graduated ? '已毕业；当前终端仅执行内盘，外盘请查看官方入口' : !supported ? 'Gang 旧版曲线仅展示，当前交易接入 LaunchpadV2' : Number(decimals) !== 18 ? '未知代币精度' : null;
    const spot = c.sold < VIRTUAL ? (c.virtualQuote + c.realQuote) * 10n ** 18n / (VIRTUAL - c.sold) : null;
    const volume = hint?.track === 'stocks' ? hint.volume24hQuote : same(c.quote, config.wrappedNative) ? hint?.volume24hBnb : undefined;
    const quoteSymbol = same(c.quote, config.wrappedNative) ? 'WBNB' : quote.symbol;
    return {
      address: token, platformId: 'gang', name, symbol, decimals: Number(decimals), phase: c.graduated ? 'graduated' : 'bonding',
      verified: true, tradable: reason === null, reason, manager: pad.address, pad: pad.id,
      creator: c.creator, taxed: c.taxed, pair: same(c.pair, ZeroAddress) ? null : c.pair, referencePair: c.refPair,
      tokenTaxBuyBps: supported ? (c.taxed ? '100' : '0') : null, tokenTaxSellBps: supported ? (c.taxed ? '100' : '0') : null,
      protocolBuyFeeBps: supported ? '100' : null, protocolSellFeeBps: supported ? '100' : null, tokenTaxScope: '外盘',
      creatorName: same(hint?.creator,c.creator) && typeof hint?.creatorHandle === 'string' ? hint.creatorHandle.slice(0,64) : null, creatorNameSource: 'Gang 索引名称，详情页链上核验',
      quoteAsset: c.quote, quoteSymbol, quoteDecimals: quote.decimals, positionKind: 'token',
      price: spot === null ? null : formatUnits(spot, quote.decimals), priceUnit: quoteSymbol,
      ...(pad.id === 'v2' ? gangMetrics(c, quote.decimals) : {}),
      valuationQuoteUsd: same(hint?.quoteAddress,c.quote) && Number(hint?.quoteUsd)>0 ? Number(hint.quoteUsd) : null,
      indexedMarketCapUsd: same(hint?.quoteAddress,c.quote) && Number(hint?.fdvUsd)>0 ? Number(hint.fdvUsd) : null,
      progress: c.graduated ? 100 : c.gradAmt > 0n ? Math.min(100, Number(c.realQuote * 10000n / c.gradAmt) / 100) : null,
      volume: volume === undefined ? null : String(volume), volumeUnit: quoteSymbol, volumeLabel: `24h · ${quoteSymbol} · Gang 索引`,
      buyTaxBps: '100', sellTaxBps: '100', limitRule: 'Gang 内盘每钱包上限由 walletRoom 和实际执行模拟核验；1% 交易费。',
      createdAt: Number.isFinite(hint?.createdAt) ? new Date(hint.createdAt * 1000).toISOString() : null,
      graduatedAt: c.graduated && Number.isFinite(hint?.graduatedAt) ? new Date(hint.graduatedAt * 1000).toISOString() : null,
      creationTransaction: hint?.createdTx, sourceImageUrl: hint?.logoThumbUrl && /^\/thumbs\/0x[0-9a-f]{40}\.webp(?:\?[a-zA-Z0-9_=.-]+)?$/i.test(hint.logoThumbUrl) ? `https://gang.fun/api${hint.logoThumbUrl}` : hint?.logoUrl || null,
      officialUrl: `https://gang.fun/token/${token}`, _curve: c,sourceBlock:blockTag,
    };
  }
  async function positions(token, address, {hint}={}) {
    if(mergedMarket(hint))return mergedProtocol.positions(token,address);
    const state = await getTokenState(token);
    const asset = new Contract(token, ERC20, provider);
    const quote = new Contract(state.quoteAsset, ERC20, provider);
    const [balance, allowance, quoteBalance] = await Promise.all([asset.balanceOf(address), asset.allowance(address, state.manager), quote.balanceOf(address)]);
    return { token: getAddress(token), address: getAddress(address), balance: String(balance), allowance: String(allowance), decimals: state.decimals, positionKind: 'token', spender: state.manager, quoteBalance: String(quoteBalance), quoteDecimals: state.quoteDecimals, quoteSymbol: state.quoteSymbol };
  }
  async function curveQuote(state, side, input, wallet) {
    const c = state._curve;
    if (side === 'sell') return gangSellQuote(c, input);
    check(await read(state.manager, 'isAgent', [wallet],state.sourceBlock), '此钱包未持有 Gang 所要求的 Agent ID');
    const enabled = await read(state.manager, 'walletCapEnabled',[],state.sourceBlock);
    const room = enabled ? await read(state.manager, 'walletRoom', [state.address, wallet],state.sourceBlock) : null;
    return gangBuyQuote(c, input, room);
  }
  async function buildTrade(request,guards={},quoteOnly=false) {
    if(mergedMarket(request.market))return quoteOnly?mergedProtocol.quoteTrade(request,guards):mergedProtocol.buildTrade(request,guards);
    const { token, side, amount, slippageBps, maxPriceImpactBps: requestedLimit = 300, walletAddress }=request;
    let maxPriceImpactBps=requestedLimit;
    check(['buy', 'sell'].includes(side), '买卖方向无效');
    slippageFloor(1n,slippageBps);
    maxPriceImpactBps = priceImpactLimit(maxPriceImpactBps);
    const sourceBlock=await provider.getBlockNumber();await initialize(sourceBlock);
    const state = await getTokenState(token,{blockTag:sourceBlock}); check(state.tradable, state.reason);
    check(request.settlement!=='bnb','Gang 旧内盘 BNB 支付或结算需要顺序桥接');
    const input = parseDecimalAmount(amount, side === 'buy' ? state.quoteDecimals : state.decimals);
    const deadline=guards.deadline??Math.floor(now()/1000)+120;check(Number.isSafeInteger(deadline)&&deadline>Math.floor(now()/1000)&&deadline<=Math.floor(now()/1000)+120,'原预览期限已失效，请重新预览');
    let quoteProof;
    try{quoteProof=same(state.quoteAsset,config.wrappedNative)?{verified:true,decimals:state.quoteDecimals}:await verifyQuoteAsset({provider,address:state.quoteAsset,blockTag:sourceBlock});}
    catch(error){
      // Quote-denominated exits retain unknown-net warnings and actual simulation.
      if(side!=='sell'||request.settlement==='bnb')throw error;
      quoteProof={verified:false};
    }
    const quoteTransferVerified=quoteProof?.verified===true&&quoteProof.decimals===state.quoteDecimals;
    const summary = { phase:state.phase,quoteDecimals:state.quoteDecimals,sourceBlock,deadline,settlement:'quote',routeHops:side==='buy'?[state.quoteAsset,state.address]:[state.address,state.quoteAsset],platformId: 'gang', token: state.address, manager: state.manager, symbol: state.symbol, side, amount, slippageBps, maxPriceImpactBps, walletAddress, quoteAsset: state.quoteAsset, quoteSymbol: state.quoteSymbol, priceUnit: state.quoteSymbol, limitRule: state.limitRule, mevProtection: 'unverified' };
    const quoted = await curveQuote(state, side, input, walletAddress);
    const minimum = guards.minimumOutputRaw===undefined?slippageFloor(quoted.output, slippageBps):BigInt(guards.minimumOutputRaw); check(minimum > 0n&&minimum<=quoted.output, '最低收到无效，请重新预览');
    summary.inputRaw = String(input); summary.expectedOutputRaw = String(quoted.output); summary.minimumOutputRaw = String(minimum);
    summary.tradeRisk = enforceTradeRisk(gangTradeRisk({ curve: state._curve, quoted, side, input, minimum, quoteAsset: state.quoteAsset, quoteDecimals: state.quoteDecimals, quoteSymbol: state.quoteSymbol, tokenSymbol: state.symbol, limitBps: maxPriceImpactBps,quoteTransferVerified }), side);
    summary.priceImpactBps = summary.tradeRisk.priceImpactBps;
    Object.assign(summary,{estimatedTotalFee:formatUnits(quoted.fee,state.quoteDecimals),...(side==='buy'?{estimatedTokens:formatUnits(quoted.output,18),minTokens:formatUnits(minimum,18),estimatedSpend:formatUnits(quoted.spent,state.quoteDecimals),estimatedRefund:formatUnits(quoted.refund,state.quoteDecimals)}:{estimatedReceive:summary.tradeRisk.estimatedNetOutput,minReceive:summary.tradeRisk.minimumNetOutput})});
    if(quoteOnly)return{kind:side,summary};
    const spendAsset = side === 'buy' ? state.quoteAsset : state.address;
    const asset = new Contract(spendAsset, ERC20, provider);
    const [balance, allowance] = await Promise.all([asset.balanceOf(walletAddress,{blockTag:sourceBlock}), asset.allowance(walletAddress, state.manager,{blockTag:sourceBlock})]);
    if (side === 'buy' && same(spendAsset, config.wrappedNative) && balance < input) {
      const deficit = input - balance;
      const transaction = { from: walletAddress, to: config.wrappedNative, value: String(deficit), data: new Interface(['function deposit() payable']).encodeFunctionData('deposit') };
      const gas = await simulate(provider, transaction);
      return { kind: 'wrap', transaction, summary: { ...summary, ...gas, tradeRisk: withRiskGas(summary.tradeRisk, gas.estimatedGasCost), wrapAmountRaw: String(deficit), action: `本次仅将 ${formatUnits(deficit, 18)} BNB 包装为 WBNB。确认后重新预览买入。`, requiresNewPreview: true } };
    }
    check(balance >= input, `${side === 'buy' ? state.quoteSymbol : state.symbol} 余额不足`);
    if (allowance < input) {
      const approval = await exactApproval(provider, spendAsset, walletAddress, state.manager, input, summary);
      approval.summary.tradeRisk = withRiskGas(summary.tradeRisk, approval.summary.estimatedGasCost);
      return approval;
    }
    const transaction = { from: walletAddress, to: state.manager, value: '0', data: iface.encodeFunctionData(side, [state.address, input, minimum]) };
    const gas = await simulate(provider, transaction);
    recordAllowanceConsumption(transaction,{asset:spendAsset,owner:walletAddress,spender:state.manager,before:allowance,amount:input});
    return { kind: side, transaction, summary: { ...summary, ...gas, tradeRisk: withRiskGas(summary.tradeRisk, gas.estimatedGasCost), expectedOutputRaw: String(quoted.output), minimumOutputRaw: String(minimum), inputRaw: String(input), estimatedTotalFee: formatUnits(quoted.fee, state.quoteDecimals), ...(side === 'buy' ? { estimatedTokens: formatUnits(quoted.output, 18), minTokens: formatUnits(minimum, 18), estimatedSpend: formatUnits(quoted.spent, state.quoteDecimals), estimatedRefund: formatUnits(quoted.refund, state.quoteDecimals) } : { estimatedReceive: summary.tradeRisk.estimatedNetOutput, minReceive: summary.tradeRisk.minimumNetOutput }) } };
  }
  async function validateExecution(tx, summary) {
    if(['curve-v3','fair'].includes(summary.launchType))return mergedProtocol.validateExecution(tx,summary);
    const freshQuote=await buildTrade({...summary,walletAddress:tx.from},{minimumOutputRaw:summary.minimumOutputRaw,deadline:summary.deadline},true);
    const state={...freshQuote.summary,address:freshQuote.summary.token,decimals:18};
    check(same(summary.manager, state.manager), 'Gang 路由改变');
    check(same(tx.from, summary.walletAddress ?? tx.from), '钱包不一致');
    check(priceImpactLimit(summary.maxPriceImpactBps) === summary.tradeRisk?.limitBps, '原价格冲击上限依据缺失，请重新预览');
    const input = parseDecimalAmount(summary.amount, summary.side === 'buy' ? state.quoteDecimals : state.decimals);
    check(String(input) === summary.inputRaw, 'Gang 原输入依据不匹配');
    const fresh={output:BigInt(freshQuote.summary.expectedOutputRaw)};
    const risk = freshQuote.summary.tradeRisk;
    if (summary.kind === 'wrap') {
      check(same(tx.to, config.wrappedNative) && tx.data === new Interface(['function deposit() payable']).encodeFunctionData('deposit') && tx.value === summary.wrapAmountRaw, '包装参数不匹配');
    } else if (summary.kind === 'approve') {
      const parsed = ercInterface.parseTransaction(tx);
      const expected = summary.side === 'buy' ? state.quoteAsset : state.address;
      check(same(tx.to, expected) && tx.value === '0' && parsed?.name === 'approve' && same(parsed.args[0], state.manager) && String(parsed.args[1]) === summary.approvalAmountRaw && parsed.args[1] > 0n, '授权参数不匹配');
    } else {
      const parsed = iface.parseTransaction(tx);
      check(same(tx.to, state.manager) && tx.value === '0' && parsed?.name === summary.side && same(parsed.args[0], state.address) && String(parsed.args[1]) === summary.inputRaw && String(parsed.args[2]) === summary.minimumOutputRaw, 'Gang 交易与原预览不一致');
      checkDrift(BigInt(summary.expectedOutputRaw), fresh.output, parsed.args[2], summary.slippageBps);
    }
    const gas = await simulate(provider, tx);
    return { ...gas, tradeRisk: withRiskGas(risk, gas.estimatedGasCost) };
  }
  async function loadLegacy({ onProgress } = {}) {
    await initialize();
    const routes=[{path:'/stocks/tokens?sort=new',cohort:'recent',pages:5},{path:'/tokens?sort=new',cohort:'recent',pages:5},{path:'/stocks/tokens?sort=graduated',cohort:'graduated',pages:1},{path:'/tokens?sort=graduated',cohort:'graduated',pages:1},{path:'/stocks/tokens?sort=progress',cohort:'progress',pages:1}];
    const pages = await Promise.all(routes.map(async route => {
      const {path}=route;
      const rows = []; let offset = 0;
      for (let page = 0; page < route.pages; page++) {
        const data = await fetchJson(`https://gang.fun/api${path}${path.includes('?') ? '&' : '?'}limit=200&offset=${offset}`);
        check(Array.isArray(data.items), 'Gang 索引格式无效'); rows.push(...data.items);
        if (!data.hasMore) return { rows, cohort:route.cohort, truncated: false };
        check(Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset, 'Gang 索引分页无效'); offset = data.nextOffset;
      }
      return { rows, cohort:route.cohort, truncated: true };
    }));
    // 同一 CA 优先保留 stocks 记录的 quote 口径及官方缩略图，避免通用列表覆盖它。
    const all = [...new Map(pages.slice().reverse().flatMap(p => p.rows).filter(r => /^0x[0-9a-f]{40}$/i.test(r.address)).map(r => [r.address.toLowerCase(), r])).values()].sort((a, b) => b.createdAt - a.createdAt);
    const unique=rows=>[...new Map(rows.map(r=>[r.address.toLowerCase(),all.find(t=>same(t.address,r.address))||r])).values()];
    const candidates = selectGangCandidates(Object.fromEntries(['recent','graduated','progress'].map(cohort=>[cohort,unique(pages.filter(p=>p.cohort===cohort).flatMap(p=>p.rows))]))); let unavailable = 0;
    const partial = [];
    const tokens = (await mapLimited(candidates, 4, async hint => {
      try { const state = await getTokenState(hint.address, { hint }); const { _curve, ...publicState } = state; partial.push(publicState); onProgress?.(partial, `正在核验 Gang：${partial.length}/${candidates.length}`); return publicState; }
      catch { unavailable++; return null; }
    })).filter(Boolean);
    check(tokens.length || !candidates.length, 'Gang 候选代币链上核验全部失败');
    const graduated=tokens.filter(t=>t.phase==='graduated').length;
    return { tokens, status: unavailable ? 'degraded' : 'live', message: `已核验 ${tokens.length} 个（含 ${graduated} 个毕业）；新币/高进度/毕业独立窗口${unavailable ? `，${unavailable} 个未通过读取/归属核验` : ''}`, unavailable, truncated: all.length > candidates.length || pages.some(p => p.truncated) };
  }
  const merged=createGangMergedSource({provider,fetchJson,previewTrading:true});let lastLegacy=null,loading;
  function load(options={}) {
    if(loading)return loading;
    loading=(async()=>{
      const [legacyResult,mergedResult]=await Promise.allSettled([loadLegacy(options),merged.load()]);
      let legacy;
      if(legacyResult.status==='fulfilled'){
        const updatedAt=new Date().toISOString();legacy={...legacyResult.value,tokens:legacyResult.value.tokens.map(t=>({...t,sourceUpdatedAt:updatedAt,sourceUnavailable:false})),updatedAt};lastLegacy=legacy;
      }else legacy={tokens:(lastLegacy?.tokens||[]).map(t=>({...t,tradable:false,sourceUnavailable:true,reason:`旧版Gang行情失败：${messageOf(legacyResult.reason)}`})),status:'error',updatedAt:lastLegacy?.updatedAt??null,message:messageOf(legacyResult.reason),unavailable:lastLegacy?.tokens.length||0,truncated:lastLegacy?.truncated??false};
      const next=mergedResult.status==='fulfilled'?mergedResult.value:{tokens:[],tracks:[],status:'error',message:messageOf(mergedResult.reason),unavailable:0};
      const tracks=[{id:'legacy',label:'旧版 V2/U/S',status:legacy.status,count:legacy.tokens.length,updatedAt:legacy.updatedAt,message:legacy.message},...next.tracks];
      const rows=new Map();for(const t of [...legacy.tokens,...next.tokens]){const id=t.address.toLowerCase(),old=rows.get(id);if(!old||old.sourceUnavailable&&!t.sourceUnavailable)rows.set(id,t);}
      const status=legacy.status==='error'&&next.status==='error'?'error':legacy.status!=='live'||next.status!=='live'?'degraded':'live';
      return{tokens:[...rows.values()],tracks,status,lastBlock:next.lastBlock,unavailable:(legacy.unavailable||0)+(next.unavailable||0),truncated:Boolean(legacy.truncated||next.truncated),message:`旧版 ${legacy.tokens.length} · ${legacy.status==='error'?'异常':'已核验'} / ${next.message}`};
    })().finally(()=>{loading=null;});return loading;
  }
  return { provider, initialize, getTokenState, positions, buildTrade, quoteTrade:(request,guards)=>buildTrade(request,guards,true), validateExecution, load };
}
