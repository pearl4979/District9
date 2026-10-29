import { same, check } from './market-utils.mjs';

const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
function sameValue(a,b) {
  try { return a !== undefined && b !== undefined && BigInt(a) === BigInt(b); }
  catch { return false; }
}

// Shared by ordinary/atomic orders and sequential route stages. A canonical
// mined transaction must match the exact submitted intent before any observer
// reports success or a runner consumes its output. RPC failures remain retryable
// reads; mismatched chain/identity evidence is explicitly invalid, never success.
export async function verifyCanonicalReceipt({provider,txHash,receipt,transaction:expected}) {
  check(Number.isSafeInteger(receipt?.blockNumber) && receipt.blockNumber >= 0 && [0,1].includes(receipt.status),'回执格式无效');
  const network=await provider.getNetwork();
  if(network.chainId!==56n)return{valid:false};
  const [tx,block,head]=await Promise.all([provider.getTransaction(txHash),provider.getBlock(receipt.blockNumber),provider.getBlockNumber()]);
  const valid=hash(txHash)&&hash(receipt.blockHash)&&tx&&block&&
    tx.chainId===56n&&same(tx.hash,txHash)&&same(receipt.hash,txHash)&&
    tx.blockNumber===receipt.blockNumber&&block.number===receipt.blockNumber&&
    same(tx.blockHash,receipt.blockHash)&&same(block.hash,receipt.blockHash)&&
    same(tx.from,expected.from)&&same(tx.to,expected.to)&&
    typeof tx.data==='string'&&tx.data.toLowerCase()===expected.data.toLowerCase()&&sameValue(tx.value,expected.value)&&
    (!receipt.from||same(receipt.from,expected.from))&&(!receipt.to||same(receipt.to,expected.to));
  if(!valid)return{valid:false};
  check(Number.isSafeInteger(head)&&head>=receipt.blockNumber,'节点区块高度落后于回执');
  return{valid:true,head};
}
