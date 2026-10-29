import {recordAllowanceConsumption} from './allowance-consumption.mjs';
import { readFileSync } from 'node:fs';
import { Contract, Interface, JsonRpcProvider, FetchRequest, getAddress, parseUnits, formatUnits, zeroPadValue, toBeHex, ZeroAddress, id } from 'ethers';
import { fourMetrics } from './market-metrics.mjs';
import { createReadBatcher } from './read-batcher.mjs';
import { priceImpactLimit, fourTradeRisk, enforceTradeRisk, withRiskGas } from './trade-risk.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export const manifest = read('../config/manifest.json');
const abis = Object.fromEntries(['Core', 'Registry', 'Tools', 'Runtime'].map((name) => [name, read(`../abi/${name}.json`)]));
const equalAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

// 限制公网 RPC 并发；单次读取失败会及时呈现，不在后台重试数分钟。
class BoundedRpcProvider extends JsonRpcProvider {
  pending = 0;
  waiters = [];
  async _send(payload) {
    if (this.pending >= 6) await new Promise(resolve => this.waiters.push(resolve));
    else this.pending++;
    try { return await super._send(payload); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.pending--; }
  }
}

export function parseDecimalAmount(value, decimals = 18) {
  requireThat(typeof value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(value), '金额必须是普通十进制字符串');
  requireThat((value.split('.')[1]?.length ?? 0) <= decimals, `金额最多支持 ${decimals} 位小数`);
  const amount = parseUnits(value, decimals);
  requireThat(amount > 0n && amount < (1n << 256n), '金额必须大于零且在 uint256 范围内');
  return amount;
}

export function slippageFloor(amount, bps) {
  requireThat(Number.isInteger(bps) && bps >= 0 && bps <= 5000, '滑点应为 0–5000 的整数基点');
  return amount * (10000n - BigInt(bps)) / 10000n;
}

export function decodeCreationTags(encoded) {
  requireThat(/^0x01[0-9a-fA-F]{112}$/.test(encoded), '未知 encodedTags 格式');
  return Object.fromEntries(['token', 'tokenModule', 'vault', 'curve', 'trade', 'migrate', 'customData'].map((key, i) => [key, `0x${encoded.slice(4 + i * 16, 20 + i * 16).toLowerCase()}`]));
}

export function createProtocol({ rpcUrl = 'https://rpc-bsc.48.club', provider: injectedProvider, batchMaxCount = 1, aggregateReads = false } = {}) {
  requireThat(Number.isInteger(batchMaxCount) && batchMaxCount >= 1 && batchMaxCount <= 20, 'RPC 批量读取必须为 1–20');
  const request = new FetchRequest(rpcUrl);
  request.timeout = 12000; request.setThrottleParams({ maxAttempts: 1 });
  const provider = injectedProvider ?? new BoundedRpcProvider(request, 56, { batchMaxCount, batchStallTime: 10, cacheTimeout: -1, staticNetwork: true });
  if (aggregateReads) provider.readOnlyRunner = createReadBatcher({ provider });
  const reader = provider.readOnlyRunner || provider;
  const registry = new Contract(manifest.registry, abis.Registry, reader);
  const coreInterface = new Interface(abis.Core);
  let manager = manifest.core;
  let toolsAddress = manifest.tools;
  let core = new Contract(manager, abis.Core, reader);
  let tools = new Contract(toolsAddress, abis.Tools, reader);

  async function validatePreset(blockTag = 'latest') {
    const preset = await registry.getPreset(manifest.templateId, { blockTag });
    requireThat(preset.active, '目标模板已暂停，本终端停止交易');
    requireThat(String(preset.id) === manifest.templateId && preset.tokenImplId === manifest.tokenImplId, '目标模板 token implementation 标识已变化');
    requireThat(equalAddress(await registry.getPresetTokenImpl(manifest.templateId, { blockTag }), manifest.tokenImplementation), '目标代币实现已变化，需要重新核验');
    for (const [slot, expected] of Object.entries(manifest.modules)) {
      requireThat(preset[slot] === expected.id, `${slot} 模块标识已变化，需要重新核验`);
      const [actual, record] = await Promise.all([registry.getModuleImplementation(expected.id, { blockTag }), registry.getModule(expected.id, { blockTag })]);
      requireThat(record.active && equalAddress(actual, expected.implementation), `${slot} 实现已变化或停用，需要重新核验`);
    }
    return preset;
  }

  async function initialize() {
    const chainId = typeof provider.send === 'function' ? BigInt(await provider.send('eth_chainId', [])) : (await provider.getNetwork()).chainId;
    requireThat(chainId === 56n, 'RPC 必须连接 BNB Smart Chain 主网（56）');
    const [currentCore, currentTools] = await Promise.all([registry.openFourCore(), registry.openFourTool()]);
    requireThat(equalAddress(currentCore, manifest.core) && equalAddress(currentTools, manifest.tools), 'Registry 的 Core/Tools 地址已改变，需重新核验部署');
    manager = getAddress(currentCore); toolsAddress = getAddress(currentTools);
    core = new Contract(manager, abis.Core, reader); tools = new Contract(toolsAddress, abis.Tools, reader);
    const [native, boundRegistry] = await Promise.all([core.wrappedNative(), core.registry()]);
    requireThat(equalAddress(native, manifest.wrappedNative) && equalAddress(boundRegistry, manifest.registry), 'Core 的 Registry/WBNB 配置不匹配');
    await validatePreset();
    return { registry: manifest.registry, manager, tools: toolsAddress, templateId: manifest.templateId, chainId: 56 };
  }

  async function getTokenState(token, { blockTag = 'latest', risk = false } = {}) {
    token = getAddress(token);
    const cfg = await core.tokens(token, { blockTag });
    requireThat(cfg.exists && String(cfg.presetId) === manifest.templateId && equalAddress(cfg.token, token), '不是目标 Binance Agent 模板代币');
    const asset = new Contract(token, abis.Runtime, reader);
    const [descriptor, decimals, phase, snapshot] = await Promise.all([
      asset.descriptor({ blockTag }), asset.decimals({ blockTag }),
      new Contract(cfg.vault, abis.Runtime, reader).phase({ blockTag }),
      tools.getCurveLiquiditySnapshot(token, { blockTag }),
    ]);
    requireThat(descriptor.tag === manifest.tokenTag && descriptor.tagId === id(descriptor.tag).slice(0, 18), '代币类型标签未通过核验');
    for (const [key, configKey] of [['tokenModuleId', 'tokenModule'], ['vaultModuleId', 'vault'], ['curveModuleId', 'curveModule'], ['tradeModuleId', 'tradeModule'], ['migrateModuleId', 'migrateModule']]) {
      const expected = manifest.modules[key];
      const d = await new Contract(cfg[configKey], abis.Runtime, reader).descriptor({ blockTag });
      requireThat(d.tag === expected.tag && d.tagId === id(expected.tag).slice(0, 18), `${configKey} 标签不匹配`);
    }
    requireThat(equalAddress(cfg.customData, ZeroAddress), '目标模板出现未知 customData 模块');
    const [buyFee, sellFee] = await Promise.all([asset.buyFeeRate({ blockTag }), asset.sellFeeRate({ blockTag })]);
    const phaseNumber = Number(phase);
    const bnbQuote = equalAddress(cfg.quoteAsset, manifest.wrappedNative);
    const phaseLabel = phaseNumber === 1 ? 'bonding' : phaseNumber === 3 ? 'graduated' : 'unknown';
    const reason = cfg.paused ? '代币已暂停' : phaseNumber !== 1 ? `当前阶段 ${phaseNumber} 不支持内盘交易` : !bnbQuote ? '本终端仅支持 WBNB 计价、BNB 支付' : Number(decimals) !== 18 ? '代币精度不是已核验的 18 位' : null;
    let realQuoteBalance = null;
    if (risk && bnbQuote) {
      // The bound Vault is the documented quote custody location. Never call the virtual curve reserve real backing.
      try { realQuoteBalance = await new Contract(cfg.quoteAsset, abis.Runtime, reader).balanceOf(cfg.vault, { blockTag }); } catch { /* unknown backing blocks new buys */ }
    }
    const remaining = snapshot.available ? snapshot.remainingForSale : null;
    const progress = remaining !== null && cfg.saleAmount > 0n ? Number((cfg.saleAmount > remaining ? cfg.saleAmount - remaining : 0n) * 10000n / cfg.saleAmount) / 100 : null;
    return {
      ...fourMetrics(cfg, snapshot),
      address: token, name: cfg.name, symbol: cfg.symbol, price: snapshot.available ? formatUnits(snapshot.lastPrice, 18) : null,
      progress: progress === null ? null : Math.min(100, progress), phase: phaseLabel, phaseCode: phaseNumber,
      verified: true, tradable: reason === null, reason, quoteAsset: cfg.quoteAsset, decimals: Number(decimals),
      creator: cfg.creator, manager, tokenTaxBuyBps: buyFee.toString(), tokenTaxSellBps: sellFee.toString(), tokenTaxScope: '项目税',
      presetId: String(cfg.presetId), createBlock: Number(cfg.createBlock), maxSupply: cfg.maxSupply.toString(),
      remainingForSale: remaining?.toString() ?? null, totalRaised: snapshot.available ? snapshot.totalRaised.toString() : null,
      buyTaxBps: buyFee.toString(), sellTaxBps: sellFee.toString(), antiSniperEnabled: cfg.antiSniperEnabled,
      modules: { vault: cfg.vault, token: cfg.tokenModule, curve: cfg.curveModule, trade: cfg.tradeModule, migrate: cfg.migrateModule },
      volume: null, volumeLabel: '累计成交额（已索引区间）',
      ...(risk ? { _riskSnapshot: snapshot, _realQuoteBalance: realQuoteBalance } : {}),
    };
  }

  async function simulate(transaction, value = 0n) {
    await provider.call({ ...transaction, value });
    const [gas, feeData, balance] = await Promise.all([provider.estimateGas({ ...transaction, value }), provider.getFeeData(), provider.getBalance(transaction.from)]);
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    requireThat(gasPrice !== null && gasPrice > 0n, '无法获取燃气价格');
    const gasBudget = gas * 120n / 100n * gasPrice;
    requireThat(balance >= value + gasBudget, 'BNB 余额不足以覆盖支付金额和预估燃气');
    return { estimatedGas: gas.toString(), estimatedGasCost: formatUnits(gasBudget, 18) };
  }

  async function positions(token, address) {
    token = getAddress(token); address = getAddress(address);
    requireThat(token !== ZeroAddress && address !== ZeroAddress, '地址不能为零地址');
    await initialize();
    const state = await getTokenState(token);
    const asset = new Contract(token, abis.Runtime, provider);
    const [balance, allowance] = await Promise.all([asset.balanceOf(address), asset.allowance(address, manager)]);
    return { token, address, spender: manager, balance: balance.toString(), allowance: allowance.toString(), decimals: state.decimals, verified: true, tradable: state.tradable, reason: state.reason };
  }

  async function buildTrade({ token, side, amount, slippageBps = 100, maxPriceImpactBps = 300, walletAddress } = {},guards={}) {
    token = getAddress(token); walletAddress = getAddress(walletAddress);
    requireThat(token !== ZeroAddress && walletAddress !== ZeroAddress, '地址不能为零地址');
    requireThat(side === 'buy' || side === 'sell', '仅支持 buy/sell');
    const input = parseDecimalAmount(amount);
    const minimumFor=output=>{const floor=slippageFloor(output,slippageBps),guard=guards.minimumOutputRaw===undefined?floor:BigInt(guards.minimumOutputRaw);requireThat(guard>0n&&guard<=output,'最新报价低于原最低到账');return guard>floor?guard:floor;};
    slippageFloor(input, slippageBps);
    maxPriceImpactBps = priceImpactLimit(maxPriceImpactBps);
    await initialize(); // 每次预览都重新读取可信入口和模块，不依赖监控缓存。
    const state = await getTokenState(token, { risk: true });
    requireThat(state.tradable, state.reason);
    const blockNumber = await provider.getBlockNumber();
    const summary = {
      token, name: state.name, symbol: state.symbol, side, amount, slippageBps, maxPriceImpactBps, walletAddress,inputRaw:String(input),
      templateId: manifest.templateId, manager, quoteAsset: state.quoteAsset, priceUnit: 'BNB',
      buyTaxBps: state.buyTaxBps, sellTaxBps: state.sellTaxBps, antiSniperEnabled: state.antiSniperEnabled,
      blockNumber, previewedAt: new Date().toISOString(), limitRule: manifest.limitRule,
      mevProtection: 'unverified', priceImpactBps: null,
    };
    let estimate, data, sellAllowance, value = 0n;
    if (side === 'buy') {
      requireThat(await provider.getBalance(walletAddress) > input, 'BNB 余额必须大于预算，并预留燃气');
      estimate = await tools.estimateBuyByBudget.staticCall(token, walletAddress, input, 0, '0x');
      requireThat(estimate.tokenAmount > 0n && estimate.userPays > 0n && estimate.userPays <= input, '报价不可执行或超过预算');
      requireThat(estimate.tokenAmount <= BigInt(state.maxSupply) / 100n, '本次购买超过总量 1% 的限额');
      const minimum = minimumFor(estimate.tokenAmount);
      summary.minimumOutputRaw=String(minimum);
      requireThat(minimum > 0n, '最少收到数量为零');
      summary.tradeRisk = enforceTradeRisk(fourTradeRisk({ snapshot: state._riskSnapshot, realQuoteBalance: state._realQuoteBalance, estimate, side, minimum, tokenSymbol: state.symbol, limitBps: maxPriceImpactBps }), side);
      summary.priceImpactBps = summary.tradeRisk.priceImpactBps;
      value = input;
      data = coreInterface.encodeFunctionData('buyByBudget', [token, input, minimum, 0, '0x']);
      Object.assign(summary, { budget: amount, estimatedTokens: formatUnits(estimate.tokenAmount, 18), minTokens: formatUnits(minimum, 18), estimatedSpend: formatUnits(estimate.userPays, 18), minAmountOutRaw: minimum.toString(), expectedOutputRaw: estimate.tokenAmount.toString() });
    } else {
      const asset = new Contract(token, abis.Runtime, provider);
      const [balance, allowance] = await Promise.all([asset.balanceOf(walletAddress), asset.allowance(walletAddress, manager)]);
      requireThat(balance >= input, '代币余额不足');
      estimate = await tools.estimateSell.staticCall(token, walletAddress, input, 0, '0x');
      requireThat(estimate.tokenAmount === input && estimate.userReceives > 0n, '卖出报价不可执行或仅能部分成交');
      const minimum = minimumFor(estimate.userReceives);
      summary.minimumOutputRaw=String(minimum);
      requireThat(minimum > 0n, '最少收到 BNB 为零');
      summary.tradeRisk = enforceTradeRisk(fourTradeRisk({ snapshot: state._riskSnapshot, realQuoteBalance: state._realQuoteBalance, estimate, side, minimum, tokenSymbol: state.symbol, limitBps: maxPriceImpactBps }), side);
      summary.priceImpactBps = summary.tradeRisk.priceImpactBps;
      Object.assign(summary,{estimatedReceive:formatUnits(estimate.userReceives,18),minReceive:formatUnits(minimum,18),minQuoteReceiveRaw:String(minimum),expectedOutputRaw:String(estimate.userReceives)});
      if (allowance < input) {
        const transaction = { to: token, from: walletAddress, value: '0', data: new Interface(abis.Runtime).encodeFunctionData('approve', [manager, input]) };
        const gas = await simulate(transaction);
        return { kind: 'approve', transaction, summary: { ...summary, ...gas, tradeRisk: withRiskGas(summary.tradeRisk, gas.estimatedGasCost), allowance: formatUnits(input, 18), spender: manager, action: '仅授权本次卖出数量；授权确认后必须再次预览卖出。', requiresNewPreview: true } };
      }
      data = coreInterface.encodeFunctionData('sell', [token, input, minimum, 0, '0x']);
      sellAllowance = allowance;
      Object.assign(summary, { estimatedReceive: formatUnits(estimate.userReceives, 18), minReceive: formatUnits(minimum, 18), minQuoteReceiveRaw: minimum.toString(), expectedOutputRaw: estimate.userReceives.toString() });
    }
    const transaction = { to: manager, value: value.toString(), data, from: walletAddress };
    if(sellAllowance!==undefined)recordAllowanceConsumption(transaction,{asset:token,owner:walletAddress,spender:manager,before:sellAllowance,amount:input});
    const gas = await simulate(transaction, value); // Agent 身份及累计 1% 条件由实际 from 的 Core 执行模拟判定。
    return { kind: side, transaction, summary: { ...summary, ...gas, tradeRisk: withRiskGas(summary.tradeRisk, gas.estimatedGasCost, { nativeOutput: side === 'sell' }), estimatedTotalFee: formatUnits(estimate.totalFee, 18), simulated: true } };
  }

  async function validateExecution(transaction, summary) {
    const from = getAddress(transaction.from);
    const to = getAddress(transaction.to);
    requireThat(from !== ZeroAddress && typeof transaction.value === 'string' && /^\d+$/.test(transaction.value), '执行地址/value 无效');
    const value = BigInt(transaction.value);
    await initialize();
    let token, decoded;
    if (equalAddress(to, manager)) {
      decoded = coreInterface.parseTransaction(transaction);
      requireThat(decoded && ['buyByBudget', 'sell'].includes(decoded.name), '执行方法不在已核验路由中');
      token = decoded.args[0];
      requireThat(decoded.args[1] > 0n && decoded.args[2] > 0n, '支付/卖出数量和最少收到必须大于零');
      requireThat(decoded.args[3] === 0n && decoded.args[4] === '0x', '不支持额外 options/proof');
      requireThat(decoded.name === 'buyByBudget' ? value === decoded.args[1] : value === 0n, '交易 value 与已预览动作不一致');
    } else {
      decoded = new Interface(abis.Runtime).parseTransaction(transaction);
      requireThat(decoded?.name === 'approve' && equalAddress(decoded.args[0], manager) && decoded.args[1] > 0n && decoded.args[1] < (1n << 256n) - 1n && value === 0n, '只允许精确数量的 Core 授权');
      token = to;
      requireThat(await new Contract(token, abis.Runtime, provider).balanceOf(from) >= decoded.args[1], '授权数量超过当前持仓');
    }
    const state = await getTokenState(token, { risk: true });
    requireThat(state.tradable, state.reason);
    requireThat(summary && priceImpactLimit(summary.maxPriceImpactBps) === summary.tradeRisk?.limitBps, '原价格冲击上限依据缺失，请重新预览');
    let freshRisk;
    if (['buyByBudget', 'sell'].includes(decoded.name)) {
      const bps = summary.slippageBps;
      requireThat(Number.isInteger(bps) && bps >= 1 && bps <= 5000 && typeof summary.expectedOutputRaw === 'string' && /^[1-9]\d*$/.test(summary.expectedOutputRaw), '原报价依据缺失，请重新预览');
      const expected = BigInt(summary.expectedOutputRaw);
      const bound=summary.minimumOutputRaw===undefined?slippageFloor(expected,bps):BigInt(summary.minimumOutputRaw);
      requireThat(decoded.args[2]===bound&&bound>=slippageFloor(expected,bps)&&bound<=expected, '原报价与最低收到不匹配，请重新预览');
      const fresh = decoded.name === 'buyByBudget'
        ? await tools.estimateBuyByBudget.staticCall(token, from, decoded.args[1], 0, '0x')
        : await tools.estimateSell.staticCall(token, from, decoded.args[1], 0, '0x');
      const output = decoded.name === 'buyByBudget' ? fresh.tokenAmount : fresh.userReceives;
      requireThat(output > 0n && (decoded.name === 'buyByBudget'
        ? fresh.userPays > 0n && fresh.userPays <= decoded.args[1]
        : fresh.tokenAmount === decoded.args[1]), '当前报价不可执行，请重新预览');
      freshRisk = enforceTradeRisk(fourTradeRisk({ snapshot: state._riskSnapshot, realQuoteBalance: state._realQuoteBalance, estimate: fresh, side: decoded.name === 'buyByBudget' ? 'buy' : 'sell', minimum: decoded.args[2], tokenSymbol: state.symbol, limitBps: summary.maxPriceImpactBps }), decoded.name === 'buyByBudget' ? 'buy' : 'sell');
      const difference = output >= expected ? output - expected : expected - output;
      // 阈值为 min(滑点 / 2, 50 bps)，用整数交叉相乘保留半个基点精度。
      requireThat(difference * 20000n <= expected * BigInt(Math.min(bps, 100)), '报价变化超过允许漂移，请重新预览；不会自动放宽最低收到');
      requireThat(output >= decoded.args[2], '当前报价低于最低收到，请重新预览');
    }
    if (decoded.name === 'approve') {
      const fresh = await tools.estimateSell.staticCall(token, from, decoded.args[1], 0, '0x');
      requireThat(fresh.tokenAmount === decoded.args[1] && fresh.userReceives > 0n, '卖出报价不可执行');
      freshRisk = fourTradeRisk({ snapshot: state._riskSnapshot, realQuoteBalance: state._realQuoteBalance, estimate: fresh, side: 'sell', minimum: slippageFloor(fresh.userReceives, summary.slippageBps), tokenSymbol: state.symbol, limitBps: summary.maxPriceImpactBps });
    }
    const gas = await simulate({ ...transaction, from, to }, value);
    return { valid: true, simulated: true, ...gas, tradeRisk: withRiskGas(freshRisk, gas.estimatedGasCost, { nativeOutput: decoded.name === 'sell' }) };
  }

  return {
    provider, initialize, validatePreset, getTokenState, positions, buildTrade, validateExecution, coreInterface,
    get manager() { return manager; },
    createdTopic: coreInterface.getEvent('TokenCreated').topicHash,
    tradeTopic: coreInterface.getEvent('TradeExecuted').topicHash,
    presetTopic: zeroPadValue(toBeHex(BigInt(manifest.templateId)), 32),
  };
}
