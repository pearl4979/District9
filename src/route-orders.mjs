import { randomUUID } from 'node:crypto';
import { Interface, parseUnits } from 'ethers';
import { expiryMs } from './baw.mjs';
import { verifyCanonicalReceipt } from './transaction-receipt.mjs';
import { ERC20, check, same } from './market-utils.mjs';
import {verifiedAllowanceChanges,verifiedApprovalChanges} from './allowance-consumption.mjs';

const erc = new Interface(ERC20);
const hash = value => /^0x[0-9a-fA-F]{64}$/.test(value||'');
const pending = new Set(['SUBMITTING','UNKNOWN','PENDING_CONFIRMATION','BROADCASTED','MINED','MARKET_PENDING','WAITING_APPROVAL']);
function matchesMarketSlippage(value,bps){
  // market-order list returns a percentage ("0.2500" = 25 bps).
  // market-order quote uses a fraction; the two endpoints have different units.
  if(!['string','number'].includes(typeof value)||!/^\d+(\.\d{1,6})?$/.test(String(value))||!Number.isInteger(bps))return false;
  try{return parseUnits(String(value),6)===BigInt(bps)*10000n;}catch{return false;}
}
export const isBlockingRouteOrder = order => order.kind==='route' && (order.status==='ROUTE_RUNNING' || order.steps?.some(step=>pending.has(step.status))); 

// Opaque allowance changes cannot establish an amount. Only direct canonical
// approve calldata to the protocol-verified asset/spender establishes the exact
// cap, and validateRouteStep re-verifies its chain bindings before submission.
// Known consumption is verified against private, exact builder evidence.
export function verifyRouteWalletPreview(raw, step) {
  const risk=raw?.risks, simulation=raw?.simulationResult;
  check(risk&&Array.isArray(risk.riskDetails)&&risk.riskDetails.length===0&&risk.addresses&&Object.keys(risk.addresses).length===0,'钱包风险信息缺失或提示风险，路线已暂停');
  check(simulation&&Array.isArray(simulation.authorityChanges)&&simulation.authorityChanges.length===0&&Array.isArray(simulation.allowanceChanges),'钱包权限模拟缺失或发生权限变更');
  if(step.kind!=='approve')check(verifiedAllowanceChanges(simulation.allowanceChanges,step.transaction),'交易包含意外授权变更');
  else {
    const parsed=erc.parseTransaction(step.transaction),s=step.summary;
    check(parsed?.name==='approve'&&BigInt(step.transaction.value)===0n&&same(step.transaction.to,s.approvalAsset)&&same(parsed.args[0],s.spender)&&String(parsed.args[1])===s.approvalAmountRaw&&(parsed.args[1]>0n||s.revocation===true&&parsed.args[1]===0n)&&parsed.args[1]<(1n<<255n),'路线授权必须精确限定本次资产和数量');
    check(verifiedApprovalChanges(simulation.allowanceChanges,step.transaction,parsed.args[0],parsed.args[1]),'钱包授权模拟包含未知授权变更，无法自动确认精确授权');
  }
}

// Mutates the shared journal only through persist(), called before every send.
// Receipt polling drives the next stage; no long polling or hidden retry loop.
export function createRouteOrders({protocol,baw,orders,persist,walletContext,assertEnabled,now=Date.now,onChange=()=>{},assertRoute=()=>{}}) {
  let busy=false;
  const currentStep = order => order.steps.find(s=>pending.has(s.status)) || order.steps.find(s=>s.status==='PLANNED');
  const pendingCount = () => orders().filter(o=>o.kind==='route'&&o.steps?.some(s=>s.status==='MARKET_PENDING'||o.status==='ROUTE_RUNNING'&&s.status==='WAITING_APPROVAL'||hash(s.txHash)&&['BROADCASTED','MINED'].includes(s.status))).length;
  const snapshotResult = order => ({intentId:order.intentId,status:order.status,submitted:order.steps.some(s=>s.submissionAttempted===true),demo:false,walletAddress:order.walletAddress,route:order.route,summary:order.route.summary,order});
  function pause(order,error,status='ROUTE_PAUSED') {
    order.status=status;order.error=error?.message||String(error);order.pausedAt=new Date(now()).toISOString();
    order.blocksNewOrders=isBlockingRouteOrder(order);
    order.message='路线已停止；已收到的资产保留在原钱包，请核对步骤与余额。不会自动重试。';
  }
  async function guard(order,{identity=true}={}) {
    assertEnabled(order.executionVersion);
    assertRoute(order.route);
    check(Math.floor(now()/1000)<order.route.deadline,'路线已到期');
    if(!identity)return;
    const wallet=await walletContext();
    check(wallet.available!==false&&same(wallet.address,order.walletAddress),'当前钱包与路线原钱包不一致');
    assertEnabled(order.executionVersion);
    assertRoute(order.route);
    return wallet;
  }
  async function advance(order,initialBuilt) {
    if(order.status!=='ROUTE_RUNNING')return;
    const slot=order.steps.find(s=>s.status==='PLANNED');
    if(!slot){order.status='CONFIRMED';order.confirmedAt=new Date(now()).toISOString();order.message='整条路线各步骤均已确认';order.blocksNewOrders=false;persist();return;}
    let step=slot,sendStarted=false;
    try {
      // Step construction is read-only. The fresh wallet check belongs after
      // construction/validation, immediately before preview or submission.
      await guard(order,{identity:false});
      const built=initialBuilt||await protocol.buildRouteStep(order.route,{...slot,...order.routeState});
      if(built.kind==='skip'){Object.assign(slot,built,{status:'CONFIRMED'});if(built.allowanceRaw!==undefined)order.routeState.allowanceRaw=built.allowanceRaw;persist();return advance(order);}
      if(built.kind==='approval-wait'){Object.assign(slot,built,{status:'WAITING_APPROVAL'});persist();onChange();return;}
      if(built.kind==='market'){
        Object.assign(step,built,{status:'PREPARING'});
        step.executionEvidence=await protocol.validateRouteStep(order.route,step);
        const context=await guard(order);
        step.status='SUBMITTING';step.submittedAt=new Date(now()).toISOString();persist();
        sendStarted=true;step.submissionAttempted=true;
        try{const result=await baw.marketSwap(step.marketInput,{context,beforeSubmit:()=>{assertEnabled(order.executionVersion);assertRoute(order.route);check(now()<order.route.deadline*1000&&now()-step.marketInput.quotedAt<30000,'聚合报价已到期');}});check(typeof result.orderId==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(result.orderId),'聚合提交缺少订单 ID');step.orderId=result.orderId;step.status='MARKET_PENDING';}
        catch(error){if(error.submissionAttempted===false){sendStarted=false;step.submissionAttempted=false;throw error;}const id=error.data?.orderId;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(id))throw error;step.orderId=id;step.status='MARKET_PENDING';step.error=error.message;}
        try{persist();}finally{onChange();}return;
      }
      check(built.transaction&&same(built.transaction.from,order.walletAddress),'路线步骤缺少原钱包交易');
      if(built.kind==='approve'&&slot.role!=='approval'){
        // Exact approvals are their own visible journal entry. Never hide them
        // under a successful bridge or relabel them as completed target trades.
        check(!order.steps.some(s=>s.role===slot.role&&s.kind==='approve'),'同一步骤重复要求授权，已停止；请核对实际 allowance');
        step={id:randomUUID(),role:slot.role,label:'精确授权 · '+slot.label,status:'PLANNED'};
        order.steps.splice(order.steps.indexOf(slot),0,step);
      }
      Object.assign(step,built,{status:'PREPARING'});
      check(Math.floor(now()/1000)<order.route.deadline,'路线已到期');
      const currentWallet=await guard(order);
      const quotedAt=now(),raw=await baw.preview(step.transaction,{context:currentWallet});
      check(raw?.requestId,'钱包预览没有返回 requestId');
      verifyRouteWalletPreview(raw,step);
      const upstream=expiryMs(raw.expiresAt);
      check(upstream!==null,'钱包预览到期时间不可读');
      step.expiresAt=Math.min(quotedAt+30000,upstream,order.route.deadline*1000);
      step.requestId=raw.requestId;
      let walletCheckedAt;
      const checks=await Promise.allSettled([protocol.validateRouteStep(order.route,step),guard(order).then(w=>{walletCheckedAt=performance.now();return w;})]);
      for(const result of checks)if(result.status==='rejected')throw result.reason;
      step.executionEvidence=checks[0].value;
      const lastWallet=checks[1].value;
      if(performance.now()-walletCheckedAt>=5000||lastWallet.devMode&&expiryMs(lastWallet.devMode.expiresAt)<=now()||lastWallet.sessionExpiresAt!==undefined&&lastWallet.sessionExpiresAt<=now())await guard(order);
      await guard(order,{identity:false});
      check(now()<step.expiresAt,'钱包预览已过期');
      step.status='SUBMITTING';step.submittedAt=new Date(now()).toISOString();
      persist(); // Failure here means no wallet execution request can exist.
      sendStarted=true;step.submissionAttempted=true;
      const result=await baw.execute(raw.requestId);
      step.orderId=result.orderId??null;step.txHash=hash(result.txHash)?result.txHash:null;
      step.status=step.txHash?'BROADCASTED':result.status==='PENDING_CONFIRMATION'?'PENDING_CONFIRMATION':'UNKNOWN';
      step.message=result.message??null;
      if(step.status==='UNKNOWN')pause(order,'提交结果未知，禁止自动重试','UNKNOWN');
      else if(step.status==='PENDING_CONFIRMATION'){order.status='PENDING_CONFIRMATION';order.message='等待钱包确认；后续步骤尚未执行';}
    }catch(error){
      if(sendStarted){step.status='UNKNOWN';pause(order,error,'UNKNOWN');}
      else{step.status='STOPPED';pause(order,error,order.steps.some(s=>s.status==='CONFIRMED')?'ROUTE_PAUSED':'ROUTE_FAILED');}
      step.error=error.message;
    }
    // Submission uncertainty is retained in memory even if the second write
    // fails. The durable SUBMITTING entry becomes paused/UNKNOWN on restart.
    try{persist();}finally{onChange();}
  }
  async function start(plan,{intentId,intentKey,executionVersion,initialBuilt}) {
    check(!busy,'路线正在执行');busy=true;
    const order={id:randomUUID(),intentId,intentKey,executionVersion,kind:'route',side:plan.input.side,token:plan.input.token,platformId:plan.input.platformId,amount:plan.input.amount,quoteSymbol:'BNB',walletAddress:plan.walletAddress,transaction:{from:plan.walletAddress},status:'ROUTE_RUNNING',blocksNewOrders:true,createdAt:new Date(now()).toISOString(),demo:false,route:plan,steps:plan.steps.map(s=>({...s})),routeState:{ownedQuoteRaw:'0',bridgeConfirmed:false,targetConfirmed:false},retainedBalances:[],txHash:null};
    orders().unshift(order);
    try{persist();await advance(order,initialBuilt);return snapshotResult(order);}finally{busy=false;}
  }
  function enqueueApprovalWait(plan,{intentId,intentKey,executionVersion}){
    check(plan.kind==='single-setup'&&plan.waitingFor,'缺少可接续的已有授权');assertEnabled(executionVersion);assertRoute(plan);
    const order={id:randomUUID(),intentId,intentKey,executionVersion,kind:'route',side:plan.input.side,token:plan.input.token,platformId:plan.input.platformId,amount:plan.input.amount,quoteSymbol:plan.summary.quoteSymbol||'BNB',walletAddress:plan.walletAddress,transaction:{from:plan.walletAddress},status:'ROUTE_RUNNING',blocksNewOrders:true,createdAt:new Date(now()).toISOString(),demo:false,route:plan,steps:plan.steps.map((s,i)=>({...s,...(i===0?{status:'WAITING_APPROVAL'}:{})})),routeState:{ownedQuoteRaw:'0',bridgeConfirmed:false,targetConfirmed:false},retainedBalances:[],txHash:null};
    orders().unshift(order);persist();onChange();return{...snapshotResult(order),queued:true};
  }
  async function refresh({reconcileOrderId}={}) {
    const readOnly=typeof reconcileOrderId==='string';
    if(busy||!pendingCount()&&!readOnly)return{pending:pendingCount(),errors:0,changed:false};busy=true;
    let errors=0,changed=false;
    try{
      for(const order of orders().filter(o=>o.kind==='route'&&(!readOnly||o.id===reconcileOrderId))){
        if(readOnly&&order.status==='ROUTE_RUNNING')pause(order,'只读核对已暂停后续步骤；不会自动续单');
        const step=currentStep(order);
        if(!step){if(readOnly&&order.steps.length&&order.steps.every(s=>s.status==='CONFIRMED')&&!order.routeState?.haltReason){order.status='CONFIRMED';delete order.error;order.blocksNewOrders=false;order.message='整条路线各步骤均已核对确认；未重新发送交易';changed=true;}continue;}
        if(step.status==='WAITING_APPROVAL'){
          if(order.status!=='ROUTE_RUNNING')continue;
          try{
            await guard(order,{identity:false});
            if(!await protocol.observeApprovalWait(order.route,step,orders().find(o=>o.id===step.waitOrderId)))continue;
            Object.assign(step,{kind:'skip',status:'CONFIRMED',confirmedAt:new Date(now()).toISOString()});persist();changed=true;await advance(order);
          }catch(error){step.status='STOPPED';pause(order,error,'ROUTE_FAILED');changed=true;}
          continue;
        }
        if(step.kind==='market'&&(step.status==='MARKET_PENDING'||readOnly&&step.status==='UNKNOWN'&&typeof step.orderId==='string')){
          if(!readOnly&&now()-(step.lastOrderCheckAt||0)<2000)continue;step.lastOrderCheckAt=now();
          try{
            const record=await baw.marketOrder(step.orderId,{walletAddress:order.walletAddress});if(!record||record.status==='PENDING')continue;
            const q=step.marketInput;
            const sameQuantity=(a,b)=>{try{return parseUnits(a,18)===parseUnits(b,18);}catch{return false;}};
            if(record.orderId!==step.orderId||String(record.chain)!=='56'||!same(record.fromToken,q.fromToken)||!same(record.toToken,q.toToken)||!sameQuantity(record.fromTokenQty,q.amount)||!matchesMarketSlippage(record.slippage,q.slippageBps)){step.status='UNKNOWN';pause(order,'聚合订单身份、交易币种、数量或滑点不匹配','UNKNOWN');changed=true;continue;}
            step.marketRecord=record;
            if(record.status==='FAILED'&&!record.txHash){step.status='STOPPED';pause(order,'币安聚合订单失败；核对钱包余额和退款后重新下单','ROUTE_FAILED');changed=true;continue;}
            if(record.status!=='FINISHED'||!hash(record.txHash)||!/^\d+(\.\d+)?$/.test(record.toTokenActualQty||'')||!/[1-9]/.test(record.toTokenActualQty)){step.status='UNKNOWN';pause(order,'聚合未给出可核验实际到账或完整成交状态','UNKNOWN');changed=true;continue;}
            step.txHash=record.txHash;step.status='BROADCASTED';if(readOnly)order.reconcileReadOnly=true;changed=true;
          }catch(error){errors++;step.error='聚合状态查询失败：'+error.message;continue;}
        }
        if(!hash(step.txHash)||!['BROADCASTED','MINED'].includes(step.status))continue;
        try{
          const provider=protocol.provider, receipt=await provider.getTransactionReceipt(step.txHash);
          if(!receipt){if(step.status==='MINED'){step.status='BROADCASTED';step.confirmations=0;changed=true;}continue;}
          if(step.kind==='market'){
            const tx=await provider.getTransaction(step.txHash),q=step.marketInput;
            const block=await provider.getBlock(receipt.blockNumber),submitted=Date.parse(step.submittedAt);
            const native=/^0xe{40}$/i.test(q.fromToken);
            if(!tx||!same(tx.from,order.walletAddress)||!/^0x[0-9a-f]{40}$/i.test(tx.to||'')||BigInt(tx.value)!==(native?BigInt(q.fromRaw):0n)||!Number.isFinite(block?.timestamp)||block.timestamp*1000<submitted-120000||block.timestamp*1000>now()+120000||orders().some(o=>o!==order&&o.steps?.some(s=>same(s.txHash,step.txHash)))){
              step.status='UNKNOWN';pause(order,'聚合链上交易与原钱包、输入金额或时间不匹配','UNKNOWN');changed=true;continue;
            }
            // Binance authenticates the order binding; canonical chain checks
            // verify its transaction, not a locally constructed aggregator calldata.
            step.transaction={from:tx.from,to:tx.to,value:String(tx.value),data:tx.data};
          }
          const proof=await verifyCanonicalReceipt({provider,txHash:step.txHash,receipt,transaction:step.transaction});
          if(!proof.valid){
            step.status='UNKNOWN';pause(order,'链上回执 chain/from/to/value/data/hash 或规范区块与路线交易不匹配','UNKNOWN');changed=true;continue;
          }
          const {head}=proof;
          step.confirmations=head-receipt.blockNumber+1;step.receiptStatus=receipt.status;step.receiptBlock=receipt.blockNumber;step.status='MINED';changed=true;
          if(step.confirmations<3)continue;
          if(receipt.status!==1){step.status='REVERTED';step.confirmedAt=new Date(now()).toISOString();pause(order,'路线步骤链上回滚；后续步骤未发送','ROUTE_FAILED');continue;}
          try{
            const observed=await protocol.observeRouteStep(order.route,step,receipt,order.routeState);
            Object.assign(order.routeState,observed);order.retainedBalances=observed.retainedBalances;
            step.status='CONFIRMED';step.confirmedAt=new Date(now()).toISOString();
            if(observed.haltReason){pause(order,observed.haltReason);continue;}
            if(step.kind!=='approve')order.routeState[step.role==='bridge'?'bridgeConfirmed':'targetConfirmed']=true;
          }catch(error){pause(order,error);continue;}
          if(readOnly||order.reconcileReadOnly){
            delete step.error;
            if(order.steps.every(s=>s.status==='CONFIRMED')){order.status='CONFIRMED';order.confirmedAt=new Date(now()).toISOString();delete order.error;order.message='整条路线各步骤均已核对确认；未重新发送交易';}
            else pause(order,'已核对该步骤实际到账；后续步骤未执行，请使用留存资产重新报价，不会自动续单');
            order.reconciledAt=new Date(now()).toISOString();
          }
          order.blocksNewOrders=isBlockingRouteOrder(order);
          persist(); // Receipt/proceeds are durable before the dependent step.
          if(order.status==='ROUTE_RUNNING'&&!readOnly&&!order.reconcileReadOnly)await advance(order);
        }catch(error){errors++;order.error='路线回执查询失败：'+error.message;}
      }
      persist();
    }finally{busy=false;if(changed)onChange();}
    return{pending:pendingCount(),errors,changed};
  }
  function pauseRestarted() {
    for(const order of orders().filter(o=>o.kind==='route'&&['ROUTE_RUNNING','PENDING_CONFIRMATION','SUBMITTING','UNKNOWN'].includes(o.status))){
      const queueOnly=order.steps?.some(s=>s.status==='WAITING_APPROVAL')&&!order.steps.some(s=>s.submissionAttempted);
      for(const step of order.steps||[]){if(step.status==='SUBMITTING')step.status='UNKNOWN';if(step.status==='WAITING_APPROVAL')step.status='STOPPED';}
      if(queueOnly){pause(order,'服务已重启，本次排队买卖已停止；原授权仍单独核对，不会自动下单','ROUTE_FAILED');continue;}
      pause(order,'服务已重启，路线暂停；请核对钱包历史与每一步回执，禁止自动重发');
    }
  }
  return{start,enqueueApprovalWait,refresh,pendingCount,pauseRestarted,isBusy:()=>busy};
}
