import { Interface } from 'ethers';
import { check, same } from './market-utils.mjs';
import { verifyCanonicalReceipt } from './transaction-receipt.mjs';

const erc20=new Interface(['function approve(address,uint256)']);
const NATIVE='0x'+'e'.repeat(40);
// Fast path remains the original constant-time balance check. Only a deficit
// triggers a bounded search for the wallet's preceding SDK approvals. No fee
// estimate or unexplained balance difference is ever treated as paid Gas.
export async function verifyNativeProceeds({provider,step,receipt,walletAddress,nowBalance,expectedRaw}){
  const swapGas=BigInt(receipt.gasUsed||0)*BigInt(receipt.gasPrice||0),baseline=BigInt(step.beforeTo),expected=baseline+expectedRaw;
  if(nowBalance+swapGas>=expected)return{gasAdjustmentRaw:swapGas,auxiliaryGasRaw:0n,approvals:[]};
  check(step.kind===undefined||step.kind==='market','原生到账步骤无效');
  check(step.marketInput&&!same(step.marketInput.fromToken,NATIVE)&&same(step.marketInput.toToken,NATIVE),'原生到账缺少可核验的聚合输入');
  const swap=await provider.getTransaction(step.txHash),submittedAt=Date.parse(step.submittedAt);
  check(swap&&same(swap.hash,step.txHash)&&same(swap.from,walletAddress)&&swap.chainId===56n&&swap.value===0n&&Number.isSafeInteger(swap.nonce)&&swap.nonce>0&&Number.isFinite(submittedAt),'原生到账缺少原钱包交易证据');
  const blocks=new Map(),approvals=[];let auxiliary=0n,nextNonce=swap.nonce-1;
  async function block(number){if(!blocks.has(number))blocks.set(number,await provider.getBlock(number,true));return blocks.get(number);}
  for(let count=0;count<3&&nextNonce>=0;count++,nextNonce--){
    let tx,txBlock;
    for(let n=receipt.blockNumber;n>=Math.max(0,receipt.blockNumber-12);n--){
      const b=await block(n);check(b&&Number.isFinite(b.timestamp),'授权区块不可用');
      if(b.timestamp*1000<submittedAt-2000)break;
      tx=b.prefetchedTransactions.find(t=>same(t.from,walletAddress)&&t.nonce===nextNonce);
      if(tx){txBlock=b;break;}
    }
    check(tx&&txBlock&&same(tx.to,step.marketInput.fromToken)&&tx.value===0n,'BNB 余额差额不是已核验的本次输入币授权 Gas');
    let decoded;try{decoded=erc20.parseTransaction(tx);}catch{}
    check(decoded?.name==='approve'&&/^0x[0-9a-f]{40}$/i.test(decoded.args[0])&&!/^0x0{40}$/i.test(decoded.args[0])&&erc20.encodeFunctionData('approve',decoded.args).toLowerCase()===tx.data.toLowerCase(),'辅助交易不是精确可识别的 ERC20 授权');
    const approvalReceipt=await provider.getTransactionReceipt(tx.hash);
    check(approvalReceipt?.status===1&&(await verifyCanonicalReceipt({provider,txHash:tx.hash,receipt:approvalReceipt,transaction:tx})).valid,'辅助授权回执未通过链上核验');
    const fee=BigInt(approvalReceipt.gasUsed||0)*BigInt(approvalReceipt.gasPrice||0);check(fee>0n,'辅助授权 Gas 费用不可核验');
    auxiliary+=fee;approvals.push({txHash:tx.hash,gasRaw:String(fee),blockNumber:approvalReceipt.blockNumber});
    const anchored=BigInt(await provider.getBalance(walletAddress,approvalReceipt.blockNumber-1));
    if(anchored===baseline&&nowBalance+swapGas+auxiliary>=expected)return{gasAdjustmentRaw:swapGas+auxiliary,auxiliaryGasRaw:auxiliary,approvals,anchorBlock:approvalReceipt.blockNumber-1};
  }
  throw Error('BNB 余额变化仍无法由已核验的兑换与授权费用解释，请核对交易明细');
}
