import { formatUnits, parseUnits } from 'ethers';
import { readFileSync } from 'node:fs';

const GANG_VERIFIED_QUOTE = JSON.parse(readFileSync(new URL('../config/platforms.json', import.meta.url), 'utf8')).wrappedNative.toLowerCase();

const UNIT = 10n ** 18n;
const GANG_TOKEN_RESERVE = 1066666666666666666666666667n;
const ceil = (a, b) => (a + b - 1n) / b;
const positive = value => typeof value === 'bigint' && value > 0n;
const nonnegative = value => typeof value === 'bigint' && value >= 0n;
const within = (a, b, tolerance = 2n) => (a > b ? a - b : b - a) <= tolerance;
const display = (value, decimals) => nonnegative(value) ? formatUnits(value, decimals) : null;

export function priceImpactLimit(value = 300) {
  if (!Number.isInteger(value) || value < 50 || value > 500) throw new Error('价格冲击上限必须为 50–500 的整数基点');
  return value;
}

function assess({ side, limitBps, priceImpactBps = null, priceImpactMethod = null, depthVerified = false, realQuoteReserve = null, virtualQuoteReserve = null, curveQuoteLiquidity = null, quoteSymbol, estimatedNetOutput = null, minimumNetOutput = null, outputSymbol, feeAmount = null, feeSymbol = quoteSymbol, unknowns = [], failures = [], warnings = [] }) {
  limitBps = priceImpactLimit(limitBps);
  if (priceImpactBps === null && !unknowns.length) unknowns.push('本次数量的纯曲线价格冲击尚未核验');
  if (!depthVerified && !unknowns.length) unknowns.push('实际计价币储备尚未核验');
  const high = priceImpactBps !== null && priceImpactBps > limitBps;
  const highReason = `本次纯曲线价格冲击 ${priceImpactBps} bps 超过上限 ${limitBps} bps`;
  const blockReasons = side === 'buy' ? [...failures, ...unknowns, ...(high ? [highReason] : [])] : [];
  const notices = [...warnings, ...(side === 'sell' ? [...failures, ...unknowns, ...(high ? [highReason] : [])] : [])];
  const status = side === 'buy' ? failures.length || high ? 'blocked' : unknowns.length ? 'unknown' : 'ok' : notices.length ? 'warning' : 'ok';
  return { status, limitBps, priceImpactBps, priceImpactMethod, depthVerified, realQuoteReserve, virtualQuoteReserve, curveQuoteLiquidity, quoteSymbol, estimatedNetOutput, minimumNetOutput, outputSymbol, feeAmount, feeSymbol, nativeGasBudget: null, netAfterGas: null, warnings: notices, blockReasons };
}

// Average executable curve price against the current marginal curve price. Fees never enter this ratio.
function impact(side, curveQuote, tokenAmount, quoteLiquidity, tokenLiquidity) {
  if (![curveQuote, tokenAmount, quoteLiquidity, tokenLiquidity].every(positive)) return null;
  const curveNumerator = curveQuote * tokenLiquidity;
  const spotNumerator = tokenAmount * quoteLiquidity;
  const numerator = side === 'buy' ? curveNumerator - spotNumerator : spotNumerator - curveNumerator;
  if (numerator < 0n) return null;
  const bps = ceil(numerator * 10000n, spotNumerator);
  return bps <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bps) : null;
}

export function enforceTradeRisk(tradeRisk, side) {
  if (side === 'buy' && (tradeRisk.status !== 'ok' || tradeRisk.blockReasons.length)) {
    const error = new Error(`买入风险检查未通过：${tradeRisk.blockReasons.join('；') || '关键风险数据尚未核验'}`);
    error.tradeRisk = tradeRisk;
    throw error;
  }
  return tradeRisk;
}

export function gangMergedRisk({side,limitBps,quoteAsset,quoteSymbol,tokenSymbol,quoted,minimum,reserve,input,tokenReserve,fair=false,tax=0n,warnings=[],quoteTransferVerified=false}){
 const verified=quoteTransferVerified===true||(typeof quoteAsset==='string'&&quoteAsset.toLowerCase()===GANG_VERIFIED_QUOTE);
 let bps=null;
 if(fair)bps=0;
 else if(positive(reserve)&&positive(tokenReserve)&&positive(input)){
  const n=side==='buy'?ceil(input*10000n,reserve):ceil(input*10000n,tokenReserve+input);
  if(n<=BigInt(Number.MAX_SAFE_INTEGER))bps=Number(n);
 }
 const risk=assess({side,limitBps,priceImpactBps:verified?bps:null,priceImpactMethod:fair?'Fair 固定份额价，无 AMM 冲击；打新/退出手续费另列。':'Pancake V2 储备恒定乘积价格冲击；税、LP费与税回售另计。',depthVerified:verified&&nonnegative(reserve),realQuoteReserve:display(reserve,18),quoteSymbol,outputSymbol:side==='buy'?tokenSymbol:quoteSymbol,estimatedNetOutput:verified?display(quoted.output,18):null,minimumNetOutput:verified?display(minimum,18):null,feeAmount:display(fair?quoted.fee:tax,18),feeSymbol:fair?quoteSymbol:tokenSymbol,unknowns:verified?[]:['Gang 底币转账语义未核验，预计净到账及价格冲击未知'],warnings:[...warnings,fair?'储备为本打新市场已售份额对应的托管本金；打新费不退还。':'池子储备来自同块工厂登记；价格冲击不包含项目税、LP手续费及税回售。']});
 return{...risk,contractQuotedOutput:display(quoted.output,18),contractMinimumOutput:display(minimum,18)};
}

export function withRiskGas(tradeRisk, gasBudget, { nativeOutput = false } = {}) {
  let netAfterGas = null;
  if (nativeOutput && tradeRisk.estimatedNetOutput !== null && gasBudget !== undefined && gasBudget !== null) {
    const net = parseUnits(tradeRisk.estimatedNetOutput, 18) - parseUnits(gasBudget, 18);
    netAfterGas = formatUnits(net, 18);
  }
  return { ...tradeRisk, nativeGasBudget: gasBudget ?? null, netAfterGas };
}

export function gangTradeRisk({ curve, quoted, side, input, minimum, quoteAsset, quoteDecimals, quoteSymbol, tokenSymbol, limitBps, quoteTransferVerified = false }) {
  // A symbol or successful safeTransfer does not prove recipient balance semantics.
  const transferVerified = quoteTransferVerified === true || (typeof quoteAsset === 'string' && quoteAsset.toLowerCase() === GANG_VERIFIED_QUOTE);
  const q = curve.virtualQuote + curve.realQuote, t = GANG_TOKEN_RESERVE - curve.sold;
  const curveQuote = side === 'buy' ? quoted.spent - quoted.fee : quoted.gross;
  const tokenAmount = side === 'buy' ? quoted.output : input;
  const failures = [];
  if (side === 'sell' && curveQuote > curve.realQuote) failures.push('曲线真实计价币储备不足以支付本次卖出');
  const risk = assess({ side, limitBps, priceImpactBps: transferVerified ? impact(side, curveQuote, tokenAmount, q, t) : null, priceImpactMethod: transferVerified ? 'Gang V2: fee-exclusive average curve price / current marginal curve price' : null, depthVerified: transferVerified && nonnegative(curve.realQuote), realQuoteReserve: display(curve.realQuote, quoteDecimals), virtualQuoteReserve: display(curve.virtualQuote, quoteDecimals), curveQuoteLiquidity: display(q, quoteDecimals), quoteSymbol, outputSymbol: side === 'buy' ? tokenSymbol : quoteSymbol, estimatedNetOutput: transferVerified ? display(quoted.output, side === 'buy' ? 18 : quoteDecimals) : null, minimumNetOutput: transferVerified ? display(minimum, side === 'buy' ? 18 : quoteDecimals) : null, feeAmount: display(quoted.fee, quoteDecimals), failures,
    unknowns: transferVerified ? [] : ['Gang 底币合约的转账语义尚未核验，可能含转账税；合约报价及最低输出不保证钱包净到账，本次数量的纯曲线冲击保持未知'],
    warnings: ['真实储备为 Launchpad.curves.realQuote 的市场账本储备；虚拟储备不属于可提取底币。', ...(transferVerified ? [] : ['显示的 1% 仅为合约名义协议费；底币转账税等额外扣费未知。'])] });
  return { ...risk, contractQuotedOutput: display(quoted.output, side === 'buy' ? 18 : quoteDecimals), contractMinimumOutput: display(minimum, side === 'buy' ? 18 : quoteDecimals) };
}

// Only recognize the pinned Four bonding model when both the snapshot and this exact executable quote agree.
// Primary field semantics: official OpenFour Integration Guide sections 4, 5.1 and 12 (vault custody, fee-exclusive curveQuote).
export function fourTradeRisk({ snapshot, estimate, side, minimum, realQuoteBalance, tokenSymbol, limitBps }) {
  const unknowns = [], failures = [];
  let priceImpactBps = null, model = false;
  const ready = snapshot?.available === true;
  const q = snapshot?.currentQuoteLiquidity, t = snapshot?.currentTokenLiquidity;
  const initialQ = snapshot?.initialQuoteLiquidity, initialT = snapshot?.initialTokenLiquidity;
  if (ready && [q, t, initialQ, initialT, snapshot.lastPrice, estimate?.curveQuote, estimate?.tokenAmount].every(positive)) {
    const invariant = initialQ * initialT;
    const amount = estimate.tokenAmount;
    const currentMatches = within(q, ceil(invariant, t)) && within(snapshot.lastPrice, q * UNIT / t);
    let expected = null;
    if (side === 'buy' && amount < t) expected = ceil(invariant, t - amount) - q;
    if (side === 'sell') expected = q - ceil(invariant, t + amount);
    const feesMatch = nonnegative(estimate.totalFee) && (side === 'buy' ? estimate.userPays === estimate.curveQuote + estimate.totalFee : estimate.curveQuote === estimate.userReceives + estimate.totalFee);
    const executionMatches = nonnegative(estimate.executionPrice) && within(estimate.executionPrice, estimate.curveQuote * UNIT / amount);
    model = currentMatches && positive(expected) && within(expected, estimate.curveQuote) && feesMatch && executionMatches;
    if (model) priceImpactBps = impact(side, estimate.curveQuote, amount, q, t);
  }
  if (!model) unknowns.push('Four 当前曲线快照、无税曲线报价与费用字段的模型一致性尚未核验');
  const balanceKnown = nonnegative(realQuoteBalance);
  const backingEnough = balanceKnown && ready && nonnegative(snapshot.totalRaised) && realQuoteBalance >= snapshot.totalRaised;
  if (!balanceKnown) unknowns.push('Four Vault 的实际 WBNB 底币余额尚未核验');
  else if (!ready || !nonnegative(snapshot.totalRaised)) unknowns.push('Four Vault 记账储备尚未核验');
  else if (!backingEnough) failures.push('Four Vault 实际底币余额不足以覆盖记账储备');
  if (side === 'sell' && balanceKnown && estimate?.curveQuote > realQuoteBalance) failures.push('Four Vault 的实际底币不足以支付本次曲线卖出');
  return assess({ side, limitBps, priceImpactBps, priceImpactMethod: model ? 'Four: verified constant-product quote excluding totalFee / current marginal curve price' : null, depthVerified: backingEnough, realQuoteReserve: display(realQuoteBalance, 18), virtualQuoteReserve: null, curveQuoteLiquidity: ready ? display(q, 18) : null, quoteSymbol: 'WBNB', estimatedNetOutput: display(side === 'buy' ? estimate?.tokenAmount : estimate?.userReceives, 18), minimumNetOutput: display(minimum, 18), outputSymbol: side === 'buy' ? tokenSymbol : 'BNB', feeAmount: display(estimate?.totalFee, 18), feeSymbol: 'WBNB', unknowns, failures,
    warnings: ['Vault 实际余额仅表示链上资产背书，不保证全部余额均可提取；当前曲线流动性不等于实际余额。', 'Four 初始曲线计价参数的虚拟/实存构成尚未独立核验，虚拟底币数量保持未知。'] });
}

export function flapTradeRisk({ side, limitBps, detail, settings, plan, quoteSymbol, quoteDecimals, tokenSymbol }) {
  const unknowns = [], failures = [];
  // Before minting, Flap holds ledger shares, not the future ERC20 inventory.
  // Only this exact phase may omit the post-launch inventory requirement.
  const ledger = detail?.phase === 1n && detail?.token?.toLowerCase() === '0x'+'0'.repeat(40) && detail?.claimedShares === 0n;
  let model=false,priceImpactBps=null,curveQuote=null,curveLiquidity=null;
  if(side==='buy'&&ledger&&[20n,30n].includes(settings?.curveType)&&quoteDecimals===18){
    const t=1_000_000_000n*UNIT+(settings.curveH??0n)-(detail.totalShares??0n),k=settings.curveK,r=settings.curveR,reserve=detail.curveReserveRaw,bps=detail.agentFeeBps,ref=plan?.reference;
    const complete=q=>q&&positive(q.input)&&positive(q.accepted)&&nonnegative(q.fee)&&nonnegative(q.refund)&&positive(q.output)&&q.fee<q.accepted&&q.accepted+q.refund===q.input&&/^\d+$/.test(q.quotedBlock??'')&&typeof bps==='bigint'&&bps>=0n&&bps<10000n&&within(q.fee,q.accepted*bps/10000n,1n);
    if(positive(t)&&positive(k)&&positive(r)&&nonnegative(reserve)&&complete(plan)&&complete(ref)&&ref.input<plan.input&&ref.accepted<plan.accepted&&ref.output<plan.output&&plan.output<t&&ref.quotedBlock===plan.quotedBlock){
      const q=r+reserve;
      const fullCurve=ceil(k*UNIT,t-plan.output)-q,smallCurve=ceil(k*UNIT,t-ref.output)-q,net=plan.accepted-plan.fee,smallNet=ref.accepted-ref.fee;
      // Recognize the pinned curve only when its current reserve and two
      // independent executable quotes agree. Infer allocation from both sizes;
      // never guess that ACCEPT-FEE is entirely paid into the virtual curve.
      model=within(q,ceil(k*UNIT,t),2n)&&positive(fullCurve)&&positive(smallCurve)&&fullCurve<=net&&smallCurve<=smallNet&&within(fullCurve*smallNet,smallCurve*net,2n*(net+smallNet));
      if(model){curveQuote=fullCurve;curveLiquidity=q;priceImpactBps=impact('buy',fullCurve,plan.output,q,t);model=priceImpactBps!==null;}
    }
  }
  if(!model)unknowns.push('Flap 当前曲线、整笔/参考报价及费用分配的一致性尚未核验');
  const backingKnown = detail?.quoteBalanceKnown === true;
  const inventoryKnown = detail?.inventoryKnown === true;
  if (!backingKnown) unknowns.push('Flap Reader 的实际底币余额未知');
  else if (detail.quoteBackingEnough !== true) failures.push('Flap Reader 报告底币背书不足');
  if(ledger&&(!nonnegative(detail.quoteBalanceRaw)||!nonnegative(detail.poolRaw)||detail.quoteBalanceRaw<detail.poolRaw))failures.push('Flap 实际底币不足以覆盖内盘账本');
  if(!ledger){if (!inventoryKnown) unknowns.push('Flap Reader 的份额/代币库存背书未知');else if (detail.inventoryEnough !== true) failures.push('Flap Reader 报告库存不足');}
  const backed=backingKnown&&detail.quoteBackingEnough===true&&(ledger?nonnegative(detail.quoteBalanceRaw)&&nonnegative(detail.poolRaw)&&detail.quoteBalanceRaw>=detail.poolRaw:inventoryKnown&&detail.inventoryEnough===true);
  const risk=assess({side,limitBps,priceImpactBps:model?priceImpactBps:null,priceImpactMethod:model?'Flap 同区块整笔/参考报价交叉核验曲线冲击；已报告费用和储备分配分别列示。':null,depthVerified:backed,realQuoteReserve:backingKnown?display(detail.quoteBalanceRaw,quoteDecimals):null,virtualQuoteReserve:null,curveQuoteLiquidity:model?display(curveLiquidity,quoteDecimals):null,quoteSymbol,estimatedNetOutput:display(plan?.output,side==='buy'?18:quoteDecimals),minimumNetOutput:display(plan?.minimum,side==='buy'?18:quoteDecimals),outputSymbol:side==='buy'?`${tokenSymbol} 份额`:quoteSymbol,feeAmount:model?display(plan.fee,quoteDecimals):null,unknowns,failures,warnings:model?['所示费用仅为 Probe 明确报告的 FEE 项；其余预算分配另列，不代表全部交易成本。','曲线流动性为定价参数，不是实际可提取底币；内盘持仓为尚未铸币的账本份额。']:[]});
  return{...risk,inventoryScope:ledger?'unminted-ledger-shares':'token-inventory',...(model?{feeScope:'probe-reported-fee',curveInputRaw:String(curveQuote),acceptedRaw:String(plan.accepted),refundRaw:String(plan.refund),reserveAllocationRaw:String(plan.accepted-plan.fee-curveQuote)}:{})};
}
