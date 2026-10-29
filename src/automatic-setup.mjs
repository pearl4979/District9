import {Interface} from 'ethers';
import {ERC20,check,same,readContract} from './market-utils.mjs';
const erc=new Interface(ERC20),positive=v=>typeof v==='string'&&/^[1-9]\d*$/.test(v);
export function createAutomaticSetupProtocol({protocol,now=Date.now}){
 const minimum=s=>s.minimumOutputRaw||s.minQuoteReceiveRaw||s.minAmountOutRaw;
 function approval(tx){const d=erc.parseTransaction(tx);check(d?.name==='approve'&&BigInt(tx.value)===0n&&d.args[1]>0n&&d.args[1]<(1n<<255n),'自动设置只支持精确授权');return{asset:tx.to,spender:d.args[0],amountRaw:String(d.args[1])};}
 function validate(p){check(now()<p.deadline*1000&&positive(p.minimumOutputRaw)&&positive(p.expectedOutputRaw),'自动授权任务已过期或缺少原报价');}
 function checkApproval(p,tx){const a=approval(tx);check(same(tx.from,p.walletAddress)&&same(a.asset,p.approvalAsset)&&same(a.spender,p.spender)&&a.amountRaw===p.approvalAmountRaw,'自动授权的资产、合约或额度已变化');}
 return{...protocol,
  planAutomaticSetup({input,walletAddress,built,consentVersion,waitingFor}){
   check(same(walletAddress,built.transaction.from),'自动任务钱包不匹配');const s=built.summary,min=minimum(s);
   check(positive(min)&&positive(s.expectedOutputRaw)&&positive(s.inputRaw),'自动授权缺少原始输入或最低到账');
   const a=built.kind==='approve'?approval(built.transaction):waitingFor?{asset:input.token,spender:waitingFor.route.spender,amountRaw:s.inputRaw}:null;
   check(a,'此准备步骤尚不支持自动衔接');
   const deadline=Math.min(Math.floor(now()/1000)+120,Number.isSafeInteger(s.deadline)?s.deadline:Infinity);
   return{kind:'single-setup',walletAddress,input:{...input,walletAddress},consentVersion,deadline,approvalAsset:a.asset,spender:a.spender,approvalAmountRaw:a.amountRaw,inputRaw:s.inputRaw,minimumOutputRaw:min,expectedOutputRaw:s.expectedOutputRaw,waitingFor:waitingFor?.id,summary:{...s,automaticSetup:true},steps:[{id:'approval',role:'approval',label:waitingFor?'等待已有精确授权':'本次数量精确授权',status:'PLANNED',...(waitingFor?{kind:'approval-wait',waitOrderId:waitingFor.id}:{})},{id:'trade',role:'target',label:'授权确认后自动'+(input.side==='sell'?'卖出':'买入'),status:'PLANNED'}]};
  },
  async buildRouteStep(p,step){
   if(p.kind!=='single-setup')return protocol.buildRouteStep(p,step);validate(p);
   if(step.role==='approval'&&p.waitingFor)return{kind:'approval-wait',waitOrderId:p.waitingFor,summary:{}};
   const b=await protocol.buildTrade(p.input,{minimumOutputRaw:p.minimumOutputRaw,expectedOutputRaw:p.expectedOutputRaw,deadline:p.deadline});
   check(b.summary.inputRaw===p.inputRaw&&BigInt(minimum(b.summary))>=BigInt(p.minimumOutputRaw),'自动衔接不能改变输入或降低原最低到账');
   if(step.role==='approval'&&b.kind===p.input.side)return{kind:'skip',summary:{existingAllowance:true}};
   check(b.kind==='approve'||step.role==='target'&&b.kind===p.input.side,'自动任务出现未知准备步骤');
   if(b.kind==='approve'){checkApproval(p,b.transaction);b.summary={...b.summary,approvalAsset:p.approvalAsset,spender:p.spender,approvalAmountRaw:p.approvalAmountRaw};}return b;
  },
  async validateRouteStep(p,step){if(p.kind!=='single-setup')return protocol.validateRouteStep(p,step);validate(p);if(step.kind==='approve')checkApproval(p,step.transaction);else check(BigInt(minimum(step.summary))>=BigInt(p.minimumOutputRaw),'原最低到账不能降低');return protocol.validateExecution(step.transaction,{...step.summary,kind:step.kind});},
  async observeRouteStep(p,step,receipt,current){
   if(p.kind!=='single-setup')return protocol.observeRouteStep(p,step,receipt,current);validate(p);
   if(step.kind==='approve'){
    const pos=same(p.approvalAsset,p.input.token)&&protocol.positions?await protocol.positions(p.input.token,p.walletAddress,{platformId:p.input.platformId}):null;
    const amount=pos&&same(pos.spender,p.spender)?BigInt(pos.allowance):await readContract(protocol.provider,p.approvalAsset,ERC20,'allowance',[p.walletAddress,p.spender]);
    check(amount>=BigInt(p.approvalAmountRaw),'授权回执与当前链上额度不匹配');
   }
   return{retainedBalances:[]};
  },
  observeApprovalWait(p,step,source){validate(p);check(source&&source.route?.kind==='preapproval'&&!source.route.revoke&&same(source.walletAddress,p.walletAddress)&&same(source.token,p.input.token)&&same(source.route.spender,p.spender),'等待的原授权任务不匹配');check(!['UNKNOWN','ROUTE_FAILED','ROUTE_PAUSED','REVERTED'].includes(source.status),'原授权未成功，自动买卖已停止');return source.status==='CONFIRMED';},
 };
}
