import {isAddress} from 'ethers';

// Only builders with exact on-chain bigint amounts can mint this evidence.
// It stays process-local, attached to the actual transaction object, never to
// client JSON or a rounded amount returned by the wallet simulation.
const evidence = new WeakMap();
const MAX = (1n << 256n) - 1n;
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fingerprint = tx => JSON.stringify([tx.from?.toLowerCase(),tx.to?.toLowerCase(),tx.value,tx.data?.toLowerCase()]);

export function recordAllowanceConsumption(transaction,{asset,owner,spender,before,amount}) {
  if(![asset,owner,spender].every(isAddress) || !same(transaction.from,owner) || typeof before !== 'bigint' || typeof amount !== 'bigint' || amount <= 0n || before < amount || before > MAX) throw Error('Invalid exact allowance consumption evidence');
  evidence.set(transaction,{asset,owner,spender,before,after:before-amount,fingerprint:fingerprint(transaction)});
}

function matchesAmount(value,exact) {
  if(typeof value === 'string') return /^(0|[1-9]\d*)$/.test(value) && value === String(exact);
  // The API emits uint256 as JSON numbers. This is only a rounded consistency
  // check against independently acquired exact evidence, never an amount source.
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value === Number(exact);
}

export function verifiedAllowanceChanges(changes,transaction) {
  if(!Array.isArray(changes)) return false;
  if(changes.length === 0) return true;
  const proof=evidence.get(transaction);
  if(!proof || proof.fingerprint !== fingerprint(transaction) || changes.length !== 1) return false;
  const c=changes[0];
  // For finite allowances, equal rounded before/after numbers cannot prove
  // direction. Require an observable decrease or an exact string amount.
  if(c && proof.before!==MAX && typeof c.postAmount==='number' && c.postAmount>=Number(proof.before))return false;
  return Boolean(c && c.tokenType === 'Erc20' && c.tokenId == null && same(c.tokenAddress,proof.asset) && same(c.owner,proof.owner) && same(c.spender,proof.spender) && matchesAmount(c.preAmount,proof.before) && (matchesAmount(c.postAmount,proof.after) || proof.before === MAX && matchesAmount(c.postAmount,MAX)));
}

// The caller has already matched canonical approve calldata to a verified
// builder's asset/spender/cap. JSON numbers are consistency checks only.
export function verifiedApprovalChanges(changes,transaction,spender,amount) {
  if(!Array.isArray(changes))return false;
  if(!changes.length)return true;
  if(changes.length!==1||typeof amount!=='bigint'||amount<0n||amount>MAX)return false;
  const c=changes[0],pre=c?.preAmount;
  const validPre=typeof pre==='string'?/^(0|[1-9]\d*)$/.test(pre)&&pre.length<=78&&BigInt(pre)<=MAX:typeof pre==='number'&&Number.isFinite(pre)&&Number.isInteger(pre)&&pre>=0&&pre<=Number(MAX);
  return Boolean(c&&validPre&&c.tokenType==='Erc20'&&c.tokenId==null&&same(c.tokenAddress,transaction.to)&&same(c.owner,transaction.from)&&same(c.spender,spender)&&matchesAmount(c.postAmount,amount));
}
