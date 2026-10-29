import {ERC20,readContract,check,same,exactApproval,ercInterface,simulate} from './market-utils.mjs';
// Only adapter-verified spenders are eligible. Aggregator-managed approvals have
// no public canonical spender in CLI 1.11.0 and are deliberately not guessed.
export function createPreapprovalProtocol({protocol,now=Date.now}={}){
 async function position(p){const [state,pos]=await Promise.all([protocol.getTokenState(p.input.token,{platformId:p.input.platformId}),protocol.positions(p.input.token,p.walletAddress,{platformId:p.input.platformId})]);check(state.tradable===true&&pos.positionKind!=='shares'&&/^0x[0-9a-f]{40}$/i.test(pos.spender||''),'此市场不提供已核验 ERC20 卖出入口，跳过后台预授权');return pos;}
 async function planPreapproval({token,platformId,walletAddress,spender,revoke=false,consentVersion,originalApproval}){
  const p={kind:'preapproval',walletAddress,input:{token,platformId,side:revoke?'revoke':'preapprove',amount:'0'},deadline:Math.floor(now()/1000)+90,consentVersion,revoke};
  const original=revoke&&originalApproval?.kind==='preapproval'&&same(originalApproval.walletAddress,walletAddress)&&same(originalApproval.input?.token,token)&&same(originalApproval.spender,spender);
  p.originalVerifiedRevocation=Boolean(original);
  const pos=original?{spender,balance:'0',allowance:'0'}:await position(p);
  check(!spender||same(spender,pos.spender),'原授权入口与当前 spender 不一致，请核对协议升级');
  check(/^\d+$/.test(pos.balance)&&BigInt(pos.balance)>0n||revoke,'当前持仓为零，跳过预授权');
  p.amountRaw=revoke?'0':pos.balance;p.spender=pos.spender;p.quoteSymbol='授权';p.summary={token,platformId,walletAddress,spender:p.spender,approvalAsset:token,approvalAmountRaw:p.amountRaw,revocation:revoke,action:revoke?'撤销卖出授权':'预授权当前持仓，额度不会自动扩大到无限'};
  p.steps=[{id:'approval',role:'approval',label:revoke?'撤销原卖出授权':'预授权当前持仓',status:'PLANNED'}];return p;
 }
 async function validate(p){check(now()<p.deadline*1000,'授权准备已到期');if(p.revoke&&p.originalVerifiedRevocation===true)return {spender:p.spender};const pos=await position(p);check(same(pos.spender,p.spender),'卖出授权入口已变化');check(p.revoke||BigInt(pos.balance)>=BigInt(p.amountRaw),'当前持仓余额减少，停止原预授权');return pos;}
 return{...protocol,planPreapproval,
  async buildRouteStep(p,s){if(p.kind!=='preapproval')return protocol.buildRouteStep(p,s);const pos=await validate(p);if(!p.revoke&&BigInt(pos.allowance||0)>=BigInt(p.amountRaw))return{kind:'skip',allowanceRaw:String(pos.allowance),summary:{...p.summary,existingAllowance:true}};const b=await exactApproval(protocol.provider,p.input.token,p.walletAddress,p.spender,BigInt(p.amountRaw),p.summary);return{...b,summary:{...b.summary,revocation:p.revoke}};},
  async validateRouteStep(p,s){if(p.kind!=='preapproval')return protocol.validateRouteStep(p,s);await validate(p);const t=s.transaction,d=ercInterface.parseTransaction(t);check(same(t.from,p.walletAddress)&&same(t.to,p.input.token)&&BigInt(t.value)===0n&&d.name==='approve'&&same(d.args[0],p.spender)&&String(d.args[1])===p.amountRaw,'预授权参数改变');return simulate(protocol.provider,t);},
  async observeRouteStep(p,s,r,c){if(p.kind!=='preapproval')return protocol.observeRouteStep(p,s,r,c);const allowance=BigInt(await readContract(protocol.provider,p.input.token,ERC20,'allowance',[p.walletAddress,p.spender]));check(p.revoke?allowance===0n:allowance>=BigInt(p.amountRaw),'链上授权额度与预期不一致');return{retainedBalances:[],allowanceRaw:String(allowance)};}
 };
}
