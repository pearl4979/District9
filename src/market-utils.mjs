import { Contract, Interface, ZeroAddress, formatUnits, getAddress, keccak256 } from 'ethers';

export const ERC20 = ['function name() view returns(string)', 'function symbol() view returns(string)', 'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'];
export const ercInterface = new Interface(ERC20);
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function check(ok, message) { if (!ok) throw new Error(message); }
export const messageOf = e => e?.shortMessage || e?.message || String(e);
export const readContract = (provider, address, abi, method, args = [], blockTag = 'latest') => new Contract(address, abi, provider.readOnlyRunner || provider)[method](...args, { blockTag });

export async function verifyCode(provider, address, codeHash) {
  const code = await provider.getCode(address);
  check(code !== '0x' && (!codeHash || keccak256(code) === codeHash), '合约实现已变化或不存在，请重新核验平台');
}

export async function simulate(provider, transaction) {
  const tx = { ...transaction, value: BigInt(transaction.value) };
  await provider.call(tx);
  const [gas, fee, balance] = await Promise.all([provider.estimateGas(tx), provider.getFeeData(), provider.getBalance(tx.from)]);
  const price = fee.maxFeePerGas ?? fee.gasPrice;
  check(price > 0n, '无法获取 Gas 价格');
  const cost = (gas * 120n + 99n) / 100n * price;
  check(balance >= tx.value + cost, 'BNB 余额不足以支付本次金额及 Gas');
  return { simulated: true, estimatedGas: gas.toString(), estimatedGasCost: formatUnits(cost, 18) };
}

// 原最低输出不变；只检查最新报价相对原报价的变化和该最低输出。
export function checkDrift(expected, fresh, minimum, slippageBps) {
  check(expected > 0n && fresh > 0n && minimum > 0n, '报价或最低收到为零，请重新预览');
  check(Number.isInteger(slippageBps) && slippageBps >= 10 && slippageBps <= 5000, '滑点依据无效');
  const delta = fresh > expected ? fresh - expected : expected - fresh;
  check(delta * 20000n <= expected * BigInt(Math.min(slippageBps, 100)), '报价变化超过允许漂移，请重新预览；不会自动放宽最低收到');
  check(fresh >= minimum, '最新报价低于原最低收到，请重新预览');
}

export async function assetInfo(provider, address) {
  if (same(address, ZeroAddress)) return { address: ZeroAddress, symbol: 'BNB', decimals: 18, native: true };
  const [symbol, decimals] = await Promise.all(['symbol', 'decimals'].map(method => readContract(provider, address, ERC20, method)));
  check(Number(decimals) >= 0 && Number(decimals) <= 18, '底池币精度超出当前支持范围');
  return { address: getAddress(address), symbol: String(symbol).slice(0, 32), decimals: Number(decimals), native: false };
}

export async function exactApproval(provider, asset, owner, spender, input, summary) {
  const transaction = { from: owner, to: asset, value: '0', data: ercInterface.encodeFunctionData('approve', [spender, input]) };
  return { kind: 'approve', transaction, summary: { ...summary, ...await simulate(provider, transaction), allowance: input.toString(), approvalAsset: asset, approvalAmountRaw: input.toString(), spender, action: '本次仅授权当前所需数量。确认回执后重新预览买卖。', requiresNewPreview: true } };
}

export async function mapLimited(items, count, mapper) {
  let cursor = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; out[index] = await mapper(items[index], index); }
  }));
  return out;
}

export async function getJson(url, { limit = 2 * 1024 * 1024, timeoutMs = 12000, method = 'GET', body } = {}) {
  const response = await fetch(url, { method, ...(body ? { body } : {}), headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  check(response.ok, `平台索引返回 HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; check(size <= limit, '平台索引响应过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
