import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadBatcher } from '../src/read-batcher.mjs';
const to = '0x0000000000000000000000000000000000000001';

test('read batching groups only caller-independent reads; wallet simulation is always direct', async () => {
  const batches = [], direct = [];
  const reader = createReadBatcher({ provider: { call: async tx => { direct.push(tx); return '0x99'; } }, aggregate: async (calls, block) => { batches.push({ calls, block }); return calls.map(() => ({ success: true, returnData: '0x11' })); } });
  assert.deepEqual(await Promise.all([reader.call({ to, data: '0x01' }), reader.call({ to, data: '0x02' }), reader.call({ to, from: to, data: '0x03' })]), ['0x11', '0x11', '0x99']);
  assert.equal(batches.length, 1); assert.equal(batches[0].calls.length, 2); assert.equal(direct.length, 1);
  reader.dispose();
});

test('different block tags remain separate and individual reverted reads do not become zero', async () => {
  const reader = createReadBatcher({ provider: {}, aggregate: async calls => calls.map((_, i) => ({ success: i !== 0, returnData: i === 0 ? '0xdeadbeef' : '0x22' })) });
  const reads = await Promise.allSettled([reader.call({ to, data: '0x01' }), reader.call({ to, data: '0x02' }), reader.call({ to, data: '0x03', blockTag: 123 })]);
  assert.equal(reads[0].status, 'rejected'); assert.equal(reads[1].value, '0x22'); assert.equal(reads[2].status, 'rejected');
  reader.dispose();
});
