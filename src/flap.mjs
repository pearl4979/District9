import { readFileSync } from 'node:fs';
import { Contract, Interface, ZeroAddress, formatUnits, getAddress } from 'ethers';
import { flapMetrics } from './market-metrics.mjs';
import { priceImpactLimit, flapTradeRisk, enforceTradeRisk, withRiskGas } from './trade-risk.mjs';
import { parseDecimalAmount } from './protocol.mjs';
import { ERC20, ercInterface, same, check, readContract, verifyCode, simulate, checkDrift, exactApproval, mapLimited } from './market-utils.mjs';

const DEFAULT_CONFIG = JSON.parse(readFileSync(new URL('../config/platforms.json', import.meta.url))).flap;
const READER = JSON.parse(readFileSync(new URL('../abi/FlapReader.json', import.meta.url)));
const FACTORY = ['function isMarket(address) view returns(bool)', 'function marketCount() view returns(uint256)', 'function probeOfMarket(address) view returns(address)', 'function marketBeacon() view returns(address)', 'function probeBeacon() view returns(address)', 'function flapPortal() view returns(address)'];
const PORTAL = ['function factory() view returns(address)', 'function buy(address,uint256) payable returns(uint256)', 'function buyWithQuote(address,uint256,uint256) returns(uint256)', 'function sellBps(address,uint256,uint256) returns(uint256)'];
const MARKET = ['function portal() view returns(address)'];
const PROBE = ['function market() view returns(address)', 'function assetProbe()', 'function actionStatusProbe()', 'function buyCapacityProbe()', 'function positionProbe()', 'function buyPlanProbe(uint256,uint256)', 'function quoteBuyProbe(uint256)', 'function sellPlanCustomProbe(uint256,uint256)', 'function quoteFundingProbe(uint256)', 'error Error(string)'];
const probeInterface = new Interface(PROBE), portalInterface = new Interface(PORTAL);

// 探针刻意以 Solidity Error(string) 返回只读结果；不解析网页文案或猜测缺失数值。
export function parseProbe(data, required) {
  check(typeof data === 'string' && /^0x[0-9a-f]+$/i.test(data) && data.length <= 32768, '探针回执不可读');
  let reason;
  try { const parsed = probeInterface.parseError(data); if (parsed?.name === 'Error') reason = parsed.args[0]; } catch { /* report below */ }
  check(typeof reason === 'string', '探针没有返回完整 Error(string)');
  check(reason.endsWith(';END') && reason.length < 8192, `探针不可读：${reason.slice(0, 120)}`);
  const fields = {};
  for (const part of reason.slice(0, -4).split(';')) {
    const match = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_.:-]+)$/.exec(part);
    check(match && !Object.hasOwn(fields, match[1]), '探针含不完整或重复字段');
    fields[match[1]] = match[2];
  }
  for (const key of required) check(Object.hasOwn(fields, key), `探针缺少 ${key}`);
  return fields;
}
const uint = (fields, key) => { check(/^(0|[1-9]\d*)$/.test(fields[key] ?? ''), `探针 ${key} 无效`); return BigInt(fields[key]); };

export async function enumerateFlapMarkets(readPage, total) {
  const start = total > 160n ? total - 160n : 0n;
  const addresses = [];
  for (let cursor = start; cursor < total;) {
    const page = await readPage(cursor, total - cursor > 16n ? 16n : total - cursor);
    check(page.nextCursor > cursor && page.nextCursor <= total && page.marketAddresses.length === Number(page.nextCursor - cursor), 'Flap 市场分页不完整');
    addresses.push(...page.marketAddresses); cursor = page.nextCursor;
  }
  check(new Set(addresses.map(a => a.toLowerCase())).size === addresses.length, 'Flap 市场分页出现重复地址');
  return { addresses, truncated: start > 0n };
}

export function createFlapProtocol({ provider, config = DEFAULT_CONFIG, read: readOverride, now = Date.now } = {}) {
  const read = readOverride ?? ((address, abi, method, args = [], block = 'latest') => readContract(provider, address, abi, method, args, block));
  async function initialize() {
    check((typeof provider.send === 'function' ? BigInt(await provider.send('eth_chainId', [])) : (await provider.getNetwork()).chainId) === 56n, 'Flap 必须使用 BSC 主网');
    const [readerFactory, portalFactory, marketBeacon, probeBeacon, flapPortal] = await Promise.all([
      read(config.reader, READER, 'factory'), read(config.portal, PORTAL, 'factory'), read(config.factory, FACTORY, 'marketBeacon'), read(config.factory, FACTORY, 'probeBeacon'), read(config.factory, FACTORY, 'flapPortal'),
    ]);
    check(same(readerFactory, config.factory) && same(portalFactory, config.factory) && same(marketBeacon, config.marketBeacon.address) && same(probeBeacon, config.probeBeacon.address) && same(flapPortal, config.flapPortal), 'Flap Factory/Portal/Reader 绑定已变化');
    for (const pin of [config.marketBeacon, config.probeBeacon]) {
      const implementation = await read(pin.address, ['function implementation() view returns(address)'], 'implementation');
      check(same(implementation, pin.implementation), 'Flap Beacon 已升级，请重新核验后交易');
      await verifyCode(provider, implementation, pin.codeHash);
    }
  }
  async function binding(market, block = 'latest') {
    const [registered, portal, probe, readerProbe] = await Promise.all([
      read(config.factory, FACTORY, 'isMarket', [market], block), read(market, MARKET, 'portal', [], block), read(config.factory, FACTORY, 'probeOfMarket', [market], block), read(config.reader, READER, 'probeOfMarket', [market], block),
    ]);
    check(registered && same(portal, config.portal) && !same(probe, ZeroAddress) && same(probe, readerProbe), 'Flap Market/Probe 归属未核验');
    check(same(await read(probe, PROBE, 'market', [], block), market), 'Flap Probe 指向其他市场');
    return probe;
  }
  async function probe(market, wallet, method, args, required, expectedState) {
    const block=expectedState?._blockTag??'latest',address = await binding(market,block);
    let data;
    try {
      await provider.call({ to: address, from: wallet, value: 0n, data: probeInterface.encodeFunctionData(method, args), blockTag:block });
      throw new Error('探针未返回预期的 revert 读取');
    } catch (error) {
      if (typeof error.data !== 'string') throw error;
      data = error.data;
    }
    const result = parseProbe(data, required);
    if (expectedState) {
      let encoded;
      try { await provider.call({ to: address, from: wallet, value: 0n, data: probeInterface.encodeFunctionData('assetProbe'), blockTag:block }); }
      catch (error) { encoded = error.data; }
      const asset = parseProbe(encoded, ['MARKET', 'QUOTE', 'DECIMALS']);
      check(same(asset.MARKET, market) && same(asset.QUOTE, expectedState.quoteAsset) && uint(asset, 'DECIMALS') === BigInt(expectedState.quoteDecimals), 'Flap 探针资产绑定不匹配');
    }
    if (Object.hasOwn(result, 'BLOCK')) {
      const tip = BigInt(await provider.getBlockNumber());
      check(uint(result, 'BLOCK') <= tip + 2n && uint(result, 'BLOCK') + 80n >= tip, '探针报价区块已过期');
      if(block!=='latest')check(uint(result,'BLOCK')===BigInt(block),'Flap 探针与曲线快照区块不一致');
    }
    return result;
  }
  async function getTokenState(market, { card, creationId, risk = false } = {}) {
    market = getAddress(market);
    const block=risk?await provider.getBlockNumber():'latest';
    check(await read(config.factory, FACTORY, 'isMarket', [market],block), '不是 Flap ID Agent Curve 市场');
    const [detail, settings] = await Promise.all([read(config.reader, READER, 'marketDetail', [market],block), read(config.reader, READER, 'marketSettings', [market],block)]);
    check(same(detail.market, market), 'Reader 返回了其他市场');
    const known = config.quoteAssets.find(q => same(q.address, detail.quoteToken));
    check(known && detail.quoteDecimals === BigInt(known.decimals), 'Flap 底池币不在已核验配置中');
    const probeAddress = await binding(market,block);
    const phase = Number(detail.phase);
    check([1, 2, 3].includes(phase) && detail.capRaw > 0n, 'Flap 阶段/阈值无法确认');
    const reason = phase !== 1 ? phase === 3 ? '已发射；内盘份额需要领取为代币，外盘请查看官方入口' : '发射处理中，暂停内盘交易' : null;
    const remaining = 1_000_000_000n * 10n ** 18n + settings.curveH - detail.totalShares;
    const squared = remaining > 0n ? remaining * remaining / 10n ** 18n : 0n;
    const spot = squared > 0n ? settings.curveK * 10n ** 18n / squared : null;
    return {
      ...flapMetrics(settings, detail, spot ?? 0n),
      address: market, addressKind: 'market', platformId: 'flap', name: settings.launch.name, symbol: settings.launch.symbol,
      creator: detail.creator, taxBeneficiary: settings.launch.beneficiary,
      taxAllocation: [['项目收益','mktBps'],['销毁','deflationBps'],['持有人分红','dividendBps'],['税收加池','lpBps']].map(([label,key])=>({label,bps:Number(settings.launch[key])})),
      tokenTaxBuyBps: String(settings.launch.buyTaxRate), tokenTaxSellBps: String(settings.launch.sellTaxRate), tokenTaxScope: '发射后',
      tokenAddress: same(detail.token, ZeroAddress) ? null : detail.token, predictedToken: detail.predictedToken, pair: detail.pair,
      verified: true, tradable: reason === null, reason, phase: phase === 1 ? 'bonding' : phase === 3 ? 'graduated' : 'launching',
      positionKind: 'shares', decimals: 18, quoteAsset: detail.quoteToken, quoteDecimals: known.decimals, quoteSymbol: known.symbol,
      progress: Math.min(100, Number(detail.progressBps) / 100), price: spot === null ? null : formatUnits(spot, known.decimals), priceUnit: `${known.symbol}/份额`,
      volume: detail.statsComplete ? formatUnits(detail.cumulativeBuyGrossRaw + detail.cumulativeSellPayoutRaw, known.decimals) : null,
      volumeLabel: detail.statsComplete ? `累计 · ${known.symbol} · 市场统计` : '市场统计覆盖不完整', volumeUnit: known.symbol,
      manager: config.portal, probeAddress, tokenMetaUri: `ipfs://${settings.launch.meta}`, creationId: creationId ?? null,
      buyTaxBps: String(settings.launch.buyTaxRate), sellTaxBps: String(settings.launch.sellTaxRate), agentFeeBps: String(detail.agentFeeBps),
      protocolBuyFeeBps: String(detail.flapBuyFeeBps), protocolSellFeeBps: String(detail.flapSellFeeBps),
      feeNote: '内盘报价使用 Probe 返回的实际费用；项目买卖税在代币发射后适用。',
      officialUrl: `https://flap.sh/apps/agent-bonding-curve?lang=zh&market=${market}`,
      ...(risk ? { _riskDetail: detail, _riskSettings: settings, _blockTag:block } : {}),
      limitRule: 'Flap 内盘为市场账本份额，买入需 Agent ID；持仓上限由当前 Market 配置与 Probe 判断。',
    };
  }
  async function positions(token, address) {
    const state = await getTokenState(token);
    const info = await read(config.reader, READER, 'userPosition', [token, address]);
    const quoteBalance = same(state.quoteAsset, ZeroAddress) ? await provider.getBalance(address) : await read(state.quoteAsset, ERC20, 'balanceOf', [address]);
    return { token: getAddress(token), address: getAddress(address), balance: String(info.shares), allowance: '0', decimals: 18, positionKind: 'shares', spender: token, quoteBalance: String(quoteBalance), quoteSymbol: state.quoteSymbol, quoteDecimals: state.quoteDecimals, claimableRaw: String(info.claimableRaw), tokenAddress: state.tokenAddress };
  }
  async function tradePlan(state, wallet, side, input, sellPercentBps, slippageBps) {
    if (side === 'buy') {
      const capacity = await probe(state.address, wallet, 'buyCapacityProbe', [], ['ROOM_SHARES', 'ID', 'PHASE'], state);
      check(uint(capacity, 'PHASE') === 1n && uint(capacity, 'ID') === 1n && uint(capacity, 'ROOM_SHARES') > 0n, '当前钱包不满足 Agent ID/市场容量条件');
      const p = await probe(state.address, wallet, 'buyPlanProbe', [input, slippageBps], ['MIN_SHARES', 'BUY_SHARES', 'RULES_OK', 'BLOCK'],state);
      check(uint(p, 'RULES_OK') === 1n, 'Flap 买入规则检查未通过');
      const suffix=same(state.quoteAsset,ZeroAddress)?'WEI':'RAW';
      async function quoted(amount){const q=await probe(state.address,wallet,'quoteBuyProbe',[amount],['SHARES',`ACCEPT_${suffix}`,`FEE_${suffix}`,`REFUND_${suffix}`,'BLOCK'],state);return{input:amount,output:uint(q,'SHARES'),accepted:uint(q,`ACCEPT_${suffix}`),fee:uint(q,`FEE_${suffix}`),refund:uint(q,`REFUND_${suffix}`),quotedBlock:String(uint(q,'BLOCK'))};}
      const full=await quoted(input),small=input/10n;
      check(full.output===uint(p,'BUY_SHARES'),'Flap 完整报价与买入计划份额不一致');
      return {...full,minimum:uint(p,'MIN_SHARES'),...(small>0n&&small<input?{reference:await quoted(small)}:{})};
    }
    check(Number.isInteger(sellPercentBps) && sellPercentBps >= 1 && sellPercentBps <= 10000, 'Flap 卖出必须提供精确百分比');
    const position = await probe(state.address, wallet, 'positionProbe', [], ['HELD_SHARES', 'SELL_OK', 'PHASE', 'BLOCK'], state);
    check(uint(position, 'PHASE') === 1n && uint(position, 'SELL_OK') === 1n && uint(position, 'HELD_SHARES') > 0n, '当前市场份额不能卖出');
    const held = uint(position, 'HELD_SHARES');
    check(held * BigInt(sellPercentBps) / 10000n === input, '持仓份额已变化，请刷新后重新预览卖出比例');
    const p = await probe(state.address, wallet, 'sellPlanCustomProbe', [sellPercentBps, slippageBps], ['SHARES', 'BLOCK'],state);
    const suffix = same(state.quoteAsset, ZeroAddress) ? 'WEI' : 'RAW';
    check(uint(p, 'SHARES') === input, 'Flap 卖出计划的份额不一致，请重新预览');
    return { output: uint(p, `OUT_${suffix}`), minimum: uint(p, `MIN_${suffix}`), held, quotedBlock: String(uint(p, 'BLOCK')) };
  }
  async function prepareTrade({ token, side, amount, slippageBps, maxPriceImpactBps = 300, walletAddress, sellPercentBps }, guards = {}) {
    check(['buy', 'sell'].includes(side), '买卖方向无效');
    check(Number.isInteger(slippageBps) && slippageBps >= 10 && slippageBps <= 5000, '滑点依据无效');
    maxPriceImpactBps = priceImpactLimit(maxPriceImpactBps);
    if (guards.deadline !== undefined) check(Number.isSafeInteger(guards.deadline) && guards.deadline > Math.floor(now() / 1000), 'Flap 路由期限无效或已过期');
    await initialize();
    const state = await getTokenState(token, { risk: true }); check(state.tradable, state.reason);
    const input = parseDecimalAmount(amount, side === 'buy' ? state.quoteDecimals : 18);
    const native = same(state.quoteAsset, ZeroAddress);
    const summary = { platformId: 'flap', token: state.address, manager: config.portal, symbol: state.symbol, side, amount, walletAddress, slippageBps, maxPriceImpactBps, phase: state.phase, positionKind: 'shares', quoteDecimals: state.quoteDecimals, quoteAsset: state.quoteAsset, quoteSymbol: state.quoteSymbol, priceUnit: state.quoteSymbol, limitRule: state.limitRule, feeNote: state.feeNote, mevProtection: 'unverified' };
    const plan = await tradePlan(state, walletAddress, side, input, sellPercentBps, slippageBps);
    check(plan.output > 0n && plan.minimum > 0n && plan.minimum <= plan.output, 'Flap 报价或最低收到无效');
    if (guards.minimumOutputRaw !== undefined) {
      check(/^[1-9]\d*$/.test(String(guards.minimumOutputRaw)), 'Flap 原最低收到无效');
      const originalMinimum = BigInt(guards.minimumOutputRaw);
      check(originalMinimum <= plan.output, 'Flap 最新报价低于原最低收到');
      if (originalMinimum > plan.minimum) plan.minimum = originalMinimum;
    }
    summary.inputRaw = String(input); summary.expectedOutputRaw = String(plan.output); summary.minimumOutputRaw = String(plan.minimum);
    summary.tradeRisk = flapTradeRisk({ side, limitBps: maxPriceImpactBps, detail: state._riskDetail, settings: state._riskSettings, plan, quoteSymbol: state.quoteSymbol, quoteDecimals: state.quoteDecimals, tokenSymbol: state.symbol });
    summary.priceImpactBps = summary.tradeRisk.priceImpactBps;
    if(side==='buy')Object.assign(summary,{estimatedSpend:formatUnits(plan.accepted,state.quoteDecimals),estimatedRefund:formatUnits(plan.refund,state.quoteDecimals),estimatedProbeFee:formatUnits(plan.fee,state.quoteDecimals),feeScope:'probe-reported-fee',...(summary.tradeRisk.curveInputRaw?{estimatedCurveAllocation:formatUnits(summary.tradeRisk.curveInputRaw,state.quoteDecimals),estimatedReserveAllocation:formatUnits(summary.tradeRisk.reserveAllocationRaw,state.quoteDecimals)}:{})});
    Object.assign(summary, { quotedBlock: plan.quotedBlock, ...(guards.deadline !== undefined ? { deadline: guards.deadline } : {}), ...(side === 'buy' ? { estimatedShares: formatUnits(plan.output, 18), minShares: formatUnits(plan.minimum, 18) } : { sellPercentBps, positionBalanceRaw: String(plan.held), estimatedReceive: formatUnits(plan.output, state.quoteDecimals), minReceive: formatUnits(plan.minimum, state.quoteDecimals) }) });
    return { state, input, native, plan, summary };
  }
  async function quoteTrade(input, guards = {}) {
    const { summary } = await prepareTrade(input, guards);
    return { kind: input.side, summary };
  }
  async function buildTrade(request, guards = {}) {
    const { side, walletAddress, sellPercentBps } = request;
    const { state, input, native, plan, summary } = await prepareTrade(request, guards);
    summary.tradeRisk = enforceTradeRisk(summary.tradeRisk, side);
    if (side === 'buy' && !native) {
      const funding = await probe(state.address, walletAddress, 'quoteFundingProbe', [input], ['BALANCE_OK', 'ALLOWANCE_OK', 'BLOCK'], state);
      check(uint(funding, 'BALANCE_OK') === 1n, `${state.quoteSymbol} 余额不足以支付完整预算`);
      if (uint(funding, 'ALLOWANCE_OK') !== 1n) {
        const approval = await exactApproval(provider, state.quoteAsset, walletAddress, state.address, input, summary);
        approval.summary.tradeRisk = withRiskGas(summary.tradeRisk, approval.summary.estimatedGasCost);
        return approval;
      }
    }

    const method = side === 'sell' ? 'sellBps' : native ? 'buy' : 'buyWithQuote';
    const args = side === 'sell' ? [state.address, sellPercentBps, plan.minimum] : native ? [state.address, plan.minimum] : [state.address, input, plan.minimum];
    const transaction = { from: walletAddress, to: config.portal, value: side === 'buy' && native ? String(input) : '0', data: portalInterface.encodeFunctionData(method, args) };
    const gas = await simulate(provider, transaction);
    return { kind: side, transaction, summary: { ...summary, ...gas, tradeRisk: withRiskGas(summary.tradeRisk, gas.estimatedGasCost, { nativeOutput: side === 'sell' && native }) } };
  }
  async function validateExecution(tx, summary) {
    if (summary.deadline !== undefined) check(Number.isSafeInteger(summary.deadline) && summary.deadline > Math.floor(now() / 1000), 'Flap 路由期限无效或已过期');
    await initialize();
    const state = await getTokenState(summary.token, { risk: true }); check(state.tradable, state.reason);
    check(priceImpactLimit(summary.maxPriceImpactBps) === summary.tradeRisk?.limitBps, '原价格冲击上限依据缺失，请重新预览');
    const originalInput = parseDecimalAmount(summary.amount, summary.side === 'buy' ? state.quoteDecimals : 18);
    check(String(originalInput) === summary.inputRaw, 'Flap 原输入依据不匹配');
    const fresh = await tradePlan(state, tx.from, summary.side, originalInput, summary.sellPercentBps, summary.slippageBps);
    const risk = enforceTradeRisk(flapTradeRisk({ side: summary.side, limitBps: summary.maxPriceImpactBps, detail: state._riskDetail, settings: state._riskSettings, plan: { ...fresh, minimum: BigInt(summary.minimumOutputRaw) }, quoteSymbol: state.quoteSymbol, quoteDecimals: state.quoteDecimals, tokenSymbol: state.symbol }), summary.side);
    if (summary.kind === 'approve') {
      const parsed = ercInterface.parseTransaction(tx);
      check(!same(state.quoteAsset, ZeroAddress) && same(tx.to, state.quoteAsset) && tx.value === '0' && parsed?.name === 'approve' && same(parsed.args[0], state.address) && String(parsed.args[1]) === summary.approvalAmountRaw && parsed.args[1] > 0n, 'Flap 精确授权与预览不匹配');
    } else {
      const parsed = portalInterface.parseTransaction(tx);
      const native = same(state.quoteAsset, ZeroAddress), method = summary.side === 'sell' ? 'sellBps' : native ? 'buy' : 'buyWithQuote';
      const input = BigInt(summary.inputRaw), minimum = BigInt(summary.minimumOutputRaw);
      check(same(tx.to, config.portal) && parsed?.name === method && same(parsed.args[0], state.address) && parsed.args[parsed.args.length - 1] === minimum, 'Flap 路由或最低收到与预览不符');
      check(tx.value === (summary.side === 'buy' && native ? String(input) : '0'), 'Flap 支付金额不匹配');
      if (method === 'buyWithQuote') check(parsed.args[1] === input, 'Flap 底池币数量不匹配');
      if (method === 'sellBps') check(parsed.args[1] === BigInt(summary.sellPercentBps), 'Flap 卖出百分比改变');
      if (summary.side === 'sell') check(String(fresh.held) === summary.positionBalanceRaw, 'Flap 持仓变化，请重新预览');
      checkDrift(BigInt(summary.expectedOutputRaw), fresh.output, minimum, summary.slippageBps);
    }
    const gas = await simulate(provider, tx);
    return { ...gas, tradeRisk: withRiskGas(risk, gas.estimatedGasCost, { nativeOutput: summary.side === 'sell' && same(state.quoteAsset, ZeroAddress) && summary.kind !== 'approve' }) };
  }
  async function load({ onProgress } = {}) {
    await initialize();
    const total = await read(config.factory, FACTORY, 'marketCount');
    const { addresses, truncated } = await enumerateFlapMarkets((cursor, limit) => read(config.reader, READER, 'marketPage', [cursor, limit]), total);
    let unavailable = 0;
    const partial = [];
    const tokens = (await mapLimited(addresses.reverse(), 3, async (address, index) => {
      try { const token = await getTokenState(address, { creationId: String(total - BigInt(index)) }); partial.push(token); onProgress?.(partial, `正在核验 Flap：${partial.length}/${total} 个市场`); return token; }
      catch { unavailable++; return null; }
    })).filter(Boolean);
    check(tokens.length || !addresses.length, 'Flap 市场链上读取全部失败');
    return { tokens, status: unavailable ? 'degraded' : 'live', unavailable, truncated, message: `已核验 ${tokens.length}/${total} 个市场${unavailable ? `，${unavailable} 个读取失败` : ''}；内盘为份额` };
  }
  return { provider, initialize, getTokenState, positions, quoteTrade, buildTrade, validateExecution, load };
}
