import { Contract } from 'ethers';
import { check, verifyCode } from './market-utils.mjs';

const ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const HASH = '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';
const ABI = ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] results)'];

// 仅行情 view 读取走 Multicall3。依赖 from 的模拟、Probe 和所有真实资金动作走原始 provider/baw。
export function createReadBatcher({ provider, aggregate, flushMs = 8 } = {}) {
  let timer, closed = false, ready;
  const queue = [];
  const perform = aggregate || (async (calls, blockTag) => {
    if (!ready) ready = verifyCode(provider, ADDRESS, HASH).catch(error => { ready = null; throw error; });
    await ready;
    return new Contract(ADDRESS, ABI, provider).aggregate3.staticCall(calls, { blockTag });
  });
  async function flush() {
    timer = null;
    const pending = queue.splice(0);
    const groups = new Map();
    for (const item of pending) {
      const block = String(item.tx.blockTag ?? 'latest');
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(item);
    }
    await Promise.allSettled([...groups.values()].flatMap(group => {
      const chunks = [];
      for (let offset = 0; offset < group.length; offset += 24) chunks.push(group.slice(offset, offset + 24));
      return chunks.map(async items => {
        try {
          const results = await perform(items.map(i => ({ target: i.tx.to, allowFailure: true, callData: i.tx.data })), items[0].tx.blockTag ?? 'latest');
          check(results.length === items.length, '批量读取返回长度不匹配');
          results.forEach((result, index) => {
            if (result.success) items[index].resolve(result.returnData);
            else items[index].reject(Object.assign(new Error('合约只读调用回滚'), { code: 'CALL_EXCEPTION', data: result.returnData }));
          });
        } catch (error) { for (const item of items) item.reject(error); }
      });
    }));
  }
  return {
    provider,
    call(tx) {
      if (closed) return Promise.reject(new Error('行情读取已停止'));
      // 保留实际 sender/value 语义，绝不把钱包的模拟改成 Multicall 的 sender。
      if (tx.from !== undefined || (tx.value !== undefined && BigInt(tx.value) !== 0n)) return provider.call(tx);
      if (queue.length >= 2048) return Promise.reject(new Error('行情请求过多，请稍后刷新'));
      return new Promise((resolve, reject) => { queue.push({ tx, resolve, reject }); if (!timer) timer = setTimeout(flush, flushMs); });
    },
    dispose() { closed = true; clearTimeout(timer); for (const item of queue.splice(0)) item.reject(new Error('行情读取已停止')); },
  };
}
