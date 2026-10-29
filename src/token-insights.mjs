import{readFileSync}from'node:fs';
import{Interface,zeroPadValue,ZeroAddress}from'ethers';
import{readContract,getJson as fetchJson,check,same}from'./market-utils.mjs';
import{manifest}from'./protocol.mjs';
import{createAgentNameResolver}from'./agent-names.mjs';
import{createPoolInspector}from'./pool-inspector.mjs';
const CORE=new Interface(JSON.parse(readFileSync(new URL('../abi/Core.json',import.meta.url))));
const GANG=new Interface(['event Created(address indexed token,address indexed creator,string name,string symbol,string logoURI,bool taxed,address indexed quote,address refPair,uint256 gradAmt)','event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 taxDividend,uint256 taxPlatform,uint256 tokensOut,uint256 realQuote)']);
const ADDRESS=a=>typeof a==='string'&&/^0x[0-9a-f]{40}$/i.test(a)&&!same(a,ZeroAddress);
const HASH=h=>/^0x[0-9a-f]{64}$/i.test(h||'');
const bps=v=>v!==null&&v!==undefined&&v!==''&&Number.isSafeInteger(Number(v))&&Number(v)>=0&&Number(v)<=10000?Number(v):null;
const GETTERS=['function quote() view returns(address)','function founder() view returns(address)','function rateFounder() view returns(uint256)','function rateHolder() view returns(uint256)','function rateBurn() view returns(uint256)','function rateLiquidity() view returns(uint256)','function platformBucket() view returns(address)','function dividendVault() view returns(address)','function taxHandler() view returns(address)','function feeVault() view returns(address)','function burner() view returns(address)','function DIV_SHARE_BPS() view returns(uint256)','function BUYBACK_BPS() view returns(uint256)','function OUTER_TAX_BPS() view returns(uint256)'];
const MERGED_LABELS={'curve-v3':'V3 曲线',fair:'Fair 打新'};
const isMerged=t=>t.platformId==='gang'&&(t.pad==='merged'||Object.hasOwn(MERGED_LABELS,t.launchType));
const official=(platformId,address)=>({gang:`https://gang.fun/token/${address}`,four:`https://four.meme/token/${address}`,flap:`https://flap.sh/apps/agent-bonding-curve?lang=zh&market=${address}`}[platformId]);

export function createTokenInsights({snapshot,provider,read=(a,b,m,args=[],block='latest')=>readContract(provider,a,b,m,args,block),getJson=fetchJson,resolveName,poolInspector,now=Date.now}={}){
 const names=resolveName?{resolve:resolveName}:createAgentNameResolver({provider,read,now});
 const pools=poolInspector||createPoolInspector({provider,read,getJson,now});
 const cache=new Map(),pending=new Map();let active=0;
 const person=async address=>ADDRESS(address)?names.resolve(address).catch(()=>({address,name:null,verified:false,nameSource:'Agent ID 名称读取失败'})):{address:null,name:null,verified:false,nameSource:'创建者地址待核验'};
 async function recipient(address,label,source){
  if(!ADDRESS(address))return null;
  let type='unknown';try{const code=await provider?.getCode(address);if(typeof code==='string')type=code==='0x'?'external':'contract';}catch{}
  return{address,label,type,source};
 }
 function feeSummary(t){
  const gang=t.platformId==='gang',flap=t.platformId==='flap';
  return{tokenBuyBps:bps(t.tokenTaxBuyBps??(gang?null:t.buyTaxBps)),tokenSellBps:bps(t.tokenTaxSellBps??(gang?null:t.sellTaxBps)),tokenTaxScope:gang?'外盘；内盘另收平台费':flap?'发射后项目买卖税；内盘以Probe预览为准':'项目买卖税配置；总费用以实际预览为准',platformBuyBps:bps(t.protocolBuyFeeBps??(gang&&t.pad==='v2'?100:null)),platformSellBps:bps(t.protocolSellFeeBps??(gang&&t.pad==='v2'?100:null)),agentBps:bps(t.agentFeeBps),note:gang?'Gang V2 内盘平台费不等于持有人分红税。':flap?'Agent费、发射后项目税与Flap费用分别适用，不能直接相加冒充内盘总费率。':'项目税不包含所有协议费、Dev费或动态防狙击费用；执行前读取完整预览。'};
 }
 async function taxInfo(t,fees){
  const out={allocations:[],recipients:[],note:'配置分配不等于已经到账；收款地址不自动等同创建者或私人受益人。'};
  const add=async(a,label,source)=>{const r=await recipient(a,label,source);if(r)out.recipients.push(r);};
  if(t.platformId==='flap'){
   const a=t.taxAllocation||[];
   if(a.length&&a.every(r=>bps(r.bps)!==null)&&a.reduce((s,r)=>s+Number(r.bps),0)===10000)out.allocations=a;
   await add(t.taxBeneficiary,'项目收益接收配置','Flap Reader.marketSettings.launch.beneficiary');
   out.note+=' Flap分配在代币发射后适用；beneficiary可能为Vault。';
  }else if(t.platformId==='four'){
   const block=await provider.getBlockNumber();
   const[quote,founder,...weights]=await Promise.all(['quote','founder','rateFounder','rateHolder','rateBurn','rateLiquidity'].map(m=>read(t.address,GETTERS,m,[],block)));
   check(same(quote,t.quoteAsset),'Four税配置报价币不匹配');
   if(weights.every(w=>w>=0n&&w<=100n)&&weights.reduce((s,w)=>s+w,0n)===100n)out.allocations=weights.map((w,i)=>({label:['项目收益','持有人分红','回购销毁','税收加池'][i],bps:Number(w)*100}));
   await add(founder,'Founder收益接收地址','Four TaxToken.founder，同块配置');
   out.note+=' Four为配置权重，实际启用项可能重归一化；Founder可为TaxVault，不能据此认定Dev个人获利。';
  }else if(t.platformId==='gang'&&t.pad==='v2'){
   const block=await provider.getBlockNumber();const[bucket,dividend,handler]=await Promise.all(['platformBucket','dividendVault','taxHandler'].map(m=>read(t.manager,GETTERS,m,[],block)));
   await add(bucket,'内盘平台费归集桶','Gang LaunchpadV2.platformBucket');
   if(ADDRESS(bucket)){
    const[vault,burner,share]=await Promise.all(['feeVault','burner','BUYBACK_BPS'].map(m=>read(bucket,GETTERS,m,[],block)));
    if(share>=0n&&share<=10000n){out.allocations=[{label:'内盘平台费→回购',bps:Number(share)},{label:'内盘平台费→费用金库',bps:10000-Number(share)}];}
    await add(vault,'平台费用金库','PlatformFeeBucket.feeVault');await add(burner,'平台回购合约','PlatformFeeBucket.burner');
   }
   if(t.taxed===true){
    const rate=await read(t.address,GETTERS,'OUTER_TAX_BPS',[],block);fees.tokenBuyBps=fees.tokenSellBps=bps(rate);
    await add(dividend,'毕业后税的分红合约','Gang LaunchpadV2.dividendVault');await add(handler,'毕业后税处理合约','Gang LaunchpadV2.taxHandler');
    if(ADDRESS(handler)){
     const[dh,pb,share]=await Promise.all(['dividendVault','platformBucket','DIV_SHARE_BPS'].map(m=>read(handler,GETTERS,m,[],block)));
     if(same(dh,dividend)&&same(pb,bucket)&&share<=10000n)out.note+=` 外盘税配置：${Number(share)/100}%进入分红合约，${(10000-Number(share))/100}%进入平台桶；不表示内盘有分红。`;
    }
   }else if(t.taxed===false)fees.tokenBuyBps=fees.tokenSellBps=0;
   out.note+=' 内盘平台费与外盘项目税按阶段分别显示。';
  }
  return out;
 }
 async function chainFirst(t){
  if(!provider?.getLogs||!provider?.getBlockNumber)throw Error('链上日志不可用');
  let creation=Number(t.createBlock),manager=t.platformId==='four'?manifest.core:t.manager,iface=t.platformId==='four'?CORE:GANG;
  if(t.platformId==='gang'){
   check(HASH(t.creationTransaction),'创建回执未知');const receipt=await provider.getTransactionReceipt(t.creationTransaction);check(receipt?.status===1,'创建回执不可读');
   const created=receipt.logs.some(log=>{try{const e=GANG.parseLog(log);return same(log.address,manager)&&e?.name==='Created'&&same(e.args.token,t.address)&&same(e.args.creator,t.creator);}catch{return false;}});
   check(created,'创建事件与市场身份不一致');creation=receipt.blockNumber;
  }
  check(Number.isSafeInteger(creation)&&creation>0&&ADDRESS(manager),'创建区块未知');
  const tip=await provider.getBlockNumber(),end=Math.min(creation+4999,tip-5);check(end>=creation,'等待创建确认');
  const topic=iface.getEvent(t.platformId==='four'?'TradeExecuted':'Buy').topicHash;
  const logs=await provider.getLogs({address:manager,fromBlock:creation,toBlock:end,topics:[topic,zeroPadValue(t.address,32)]});
  const buys=logs.flatMap(log=>{try{const e=iface.parseLog(log);return same(log.address,manager)&&same(e.args.token,t.address)&&(t.platformId!=='four'||e.args.isBuy===true)?[{log,address:t.platformId==='four'?e.args.trader:e.args.buyer}]:[];}catch{return [];}}).sort((a,b)=>a.log.blockNumber-b.log.blockNumber||(a.log.index??a.log.logIndex??0)-(b.log.index??b.log.logIndex??0));
  check(buys.length&&ADDRESS(buys[0].address),'初始覆盖范围未发现买入');
  return{address:buys[0].address,txHash:buys[0].log.transactionHash,verified:true,source:'BSC 从创建块开始的Buy事件',coverage:`完整扫描创建块 ${creation} 至 ${end}；首个买入事件`,note:'首买身份以事件trader/buyer定义，不据此推断资金实际控制人。'};
 }
 async function indexedFirst(t){
  if(t.platformId==='gang'){
   const all=[];let offset=0,more=false;
   for(let page=0;page<4;page++){
    const prefix=t.pad==='v2'?'stocks/':'';const j=await getJson(`https://gang.fun/api/${prefix}tokens/${t.address}/trades?limit=200&offset=${offset}`,{limit:512*1024,timeoutMs:4000});check(Array.isArray(j.items),'成交索引格式无效');all.push(...j.items);more=j.hasMore===true;if(!more)break;check(Number.isSafeInteger(j.nextOffset)&&j.nextOffset>offset,'成交分页无效');offset=j.nextOffset;
   }
   const buys=[...new Map(all.filter(r=>r.side==='buy'&&ADDRESS(r.trader)&&HASH(r.tx)&&Number.isSafeInteger(Number(r.ts))).map(r=>[`${r.tx.toLowerCase()}:${r.trader.toLowerCase()}`,r])).values()].sort((a,b)=>Number(a.ts)-Number(b.ts)||(Number(a.block)||0)-(Number(b.block)||0));
   let buy=buys[0];check(buy,'索引覆盖未发现买入');
   const coverage=more?'仅最近最多800笔；不是全局首买':'已取得当前索引全部返回；链上全历史未独立补证';
   const tied=buys.filter(r=>Number(r.ts)===Number(buy.ts)&&(!Number(r.block)||!Number(buy.block)||Number(r.block)===Number(buy.block)));
   let orderNote='';
   if(tied.length>1){
    try{
     check(tied.length<=8&&provider?.getTransactionReceipt,'同块买入顺序未取得');
     const ordered=await Promise.all(tied.map(async row=>{
      const receipt=await provider.getTransactionReceipt(row.tx);check(receipt?.status===1&&Number.isSafeInteger(receipt.index)&&Number(receipt.blockNumber)===Number(row.block),'成交回执顺序未核验');
      const matches=receipt.logs.filter(log=>{try{const e=GANG.parseLog(log);return same(log.address,t.manager)&&e?.name==='Buy'&&same(e.args.token,t.address)&&same(e.args.buyer,row.trader);}catch{return false;}});
      check(matches.length===1&&Number.isSafeInteger(matches[0].index),'同笔买入日志顺序不唯一');return{row,block:receipt.blockNumber,txIndex:receipt.index,logIndex:matches[0].index};
     }));
     ordered.sort((a,b)=>a.block-b.block||a.txIndex-b.txIndex||a.logIndex-b.logIndex);buy=ordered[0].row;orderNote=' 同秒同块并列记录已按成功回执的交易和日志顺序核对。';
    }catch{return{address:null,txHash:null,verified:false,source:'Gang 官方成交索引',coverage,note:'最早时间内存在多笔买入，交易顺序未核验，暂不指定唯一最早买家。'};}
   }
   return{address:buy.trader,txHash:buy.tx,verified:false,source:'Gang 官方成交索引（客户端筛选与排序）',coverage,note:'最早收录买家。股票接口忽略side/sort参数，因此不能把第一条返回直接当作首买。'+orderNote};
  }
  if(t.platformId==='flap'){
   const j=await getJson(`https://fsi.taxed.fun/fsi/v1/${t.address.toLowerCase()}/G/virtualBuyFill?sort=time_asc&limit=1`,{limit:128*1024,timeoutMs:5000});const r=j.items?.[0];check(r?.confirmed===true&&ADDRESS(r.actor)&&HASH(r.txHash),'首笔买入索引尚未核验');return{address:r.actor,txHash:r.txHash,verified:false,source:'FSI Flap 买入早序索引',coverage:'索引早序首项；未证明索引覆盖全部创建历史',note:'最早收录买家；不冒充已证明的全局首买。'};
  }
  throw Error('首买索引不可用');
 }
 async function firstBuyer(t){
  let entry;
  if(t.platformId!=='flap'){try{entry=await chainFirst(t);}catch{}}
  if(!entry)entry=await indexedFirst(t);
  const identity=await person(entry.address);return{...identity,...entry,name:identity.name,verified:entry.verified&&identity.verified,nameSource:identity.nameSource};
 }
 function history(t,data,external){
  const rows=data.tokens.filter(r=>r.verified&&ADDRESS(t.creator)&&same(r.creator,t.creator)).map(r=>({address:r.address,name:r.name,symbol:r.symbol,platformId:r.platformId,phase:r.phase,...(r.platformId==='gang'&&Object.hasOwn(MERGED_LABELS,r.launchType)?{launchType:r.launchType,launchTypeLabel:MERGED_LABELS[r.launchType],locked:r.locked===true}:{}),verified:true,inCurrentWindow:true,officialUrl:official(r.platformId,r.address)}));
  if(external?.creatorStats&&same(external.creator,t.creator))for(const r of external.creatorStats.recent||[])if(ADDRESS(r.address)&&!rows.some(x=>same(x.address,r.address)))rows.push({address:r.address,name:r.name||r.symbol,symbol:r.symbol,platformId:'gang',phase:r.graduated?'graduated':'unknown',verified:false,inCurrentWindow:false,officialUrl:official('gang',r.address)});
  return{items:rows.slice(0,40),complete:false,scope:'当前已核验监控窗口，附官方索引提供的近期创建记录',totalKnown:Number.isSafeInteger(external?.creatorStats?.launches)?external.creatorStats.launches:null};
 }
 function mergedPartial(t,data){
  const launchType=Object.hasOwn(MERGED_LABELS,t.launchType)?t.launchType:null,launchTypeLabel=MERGED_LABELS[launchType]||'合并版（类型待核验）';
  const sourceBlock=Number.isSafeInteger(t.sourceBlock)&&t.sourceBlock>0?t.sourceBlock:null,updatedAt=typeof t.sourceUpdatedAt==='string'&&Number.isFinite(Date.parse(t.sourceUpdatedAt))?t.sourceUpdatedAt:null;
  const preview=t.tradable===true&&!t.sourceUnavailable&&launchType!==null;
  const warnings=['新合并版资料部分可用；首买、平台费用与税收分配、完整历史和池子详情尚未接入核验。'];
  if(t.sourceUnavailable)warnings.push('当前行情不可用，仅保留最近核验快照，请留意快照时间。');
  return{address:t.address,platformId:'gang',status:'partial',launchType,launchTypeLabel,phase:t.phase,locked:t.locked===true,updatedAt,sourceBlock,sourceUnavailable:Boolean(t.sourceUnavailable),quote:{address:t.quoteAsset,symbol:t.quoteSymbol,decimals:t.quoteDecimals},
   fees:{tokenBuyBps:bps(t.tokenTaxBuyBps),tokenSellBps:bps(t.tokenTaxSellBps),tokenTaxScope:typeof t.tokenTaxScope==='string'?t.tokenTaxScope:'适用阶段待核验',platformBuyBps:null,platformSellBps:null,agentBps:null,note:preview?`本页展示 ${launchTypeLabel} 快照税配置；本次平台费及税后到账在逐笔预览中核验。完整税收分配仍待核验。`:`Gang ${launchTypeLabel} 仅展示已核验快照中的项目税配置；平台费用、税收分配与实际净到账尚未接入核验。`},
   tax:{status:'unavailable',allocations:[],recipients:[],note:'新类型的税收分配与接收地址尚未核验；缺失不代表无税或私人收款。'},
   dev:{address:ADDRESS(t.creator)?t.creator:null,name:null,verified:false,nameSource:'创建者地址来自已核验市场快照；名称尚未单独核验。'},
   firstBuyer:{status:'unavailable',address:null,name:null,txHash:null,verified:false,source:'新类型首买资料尚未接入',coverage:'未知',note:'首买历史尚未核验，暂不指定最早买家。'},
   history:{...history(t,data,null),scope:'当前已核验监控窗口中同一创建者地址的记录'},
   route:{kind:preview?'preview-only':'readonly',label:`Gang ${launchTypeLabel} ${preview?'支持买卖预览':'只读资料'}`,target:null,quoteAsset:t.quoteAsset,pair:ADDRESS(t.pair)?t.pair:null,pools:[],note:preview?'买卖入口支持逐笔预览；交易路由、储备、费用与净到账须在该笔预览重新核验，真实交易保持关闭。':'此快照当前不提供买卖预览；参考交易对来自已核验市场快照，池子详情未读取不代表没有流动性。'},
   warnings,sources:['已核验市场快照（保留原区块和时间）','当前监控窗口中的创建者地址匹配记录']};
 }
 async function build(t,data){
  if(isMerged(t))return mergedPartial(t,data);
  const warnings=[],fees=feeSummary(t);const missing={address:null,name:null,verified:false,source:'未取得可核验记录',coverage:'未知',note:'未发现不等于没有首买。'};
  const work=await Promise.allSettled([taxInfo(t,fees),person(t.creator),firstBuyer(t),t.platformId==='gang'?getJson(`https://gang.fun/api/${t.pad==='v2'?'stocks/':''}tokens/${t.address}`,{limit:256*1024,timeoutMs:5000}):Promise.resolve(null)]);
  const take=(i,fallback,label)=>{if(work[i].status==='fulfilled')return work[i].value;warnings.push(`${label}暂未完整读取，缺失项保持待核验。`);return fallback;};
  const tax=take(0,{allocations:[],recipients:[],note:'税收去向读取失败，不能推断为无税或私人收款。'},'税务'),dev=take(1,{address:t.creator||null,name:null,verified:false,nameSource:'身份未读取'},'Dev'),buyer=take(2,missing,'首买'),raw=take(3,null,'平台档案');
  const external=raw&&same(raw.address,t.address)&&same(raw.creator,t.creator)?raw:null;
  const actualToken=t.platformId==='flap'?(t.phase==='graduated'&&ADDRESS(t.tokenAddress)?t.tokenAddress:null):t.address;
  const target=t.phase==='bonding'?(t.manager||(t.platformId==='four'?manifest.core:null)):null;
  let targetAsset=t.phase==='graduated'?actualToken:t.phase==='bonding'&&ADDRESS(t.quoteAsset)&&!same(t.quoteAsset,manifest.wrappedNative)?t.quoteAsset:null;
  let poolRows=[];if(targetAsset)try{poolRows=await pools.inspect(targetAsset,t.phase==='graduated'?t.pair:t.referencePair);}catch{warnings.push('池子候选读取失败；不能据此认定流动性为0或选池安全。');}
  const route={kind:t.phase==='bonding'?'bonding':t.phase==='graduated'?'dex-reference':'pending',label:t.phase==='bonding'?`${t.platformId} 已核验内盘入口`:t.phase==='graduated'?'外盘仅展示参考':'阶段确认中，暂停交易',target,quoteAsset:t.quoteAsset,pair:ADDRESS(t.pair)?t.pair:null,pools:poolRows,note:t.phase==='bonding'?`当前买卖调用固定Manager/Portal，不经过随机DEX池。${targetAsset?`以下为计价币 ${t.quoteSymbol} 的外部池参考，并非内盘执行池。`:''} 授权/包装/买卖仍需逐笔预览确认。`:t.phase==='graduated'?'以下为候选池归属与流动性参考；不代表税后最优输出，外盘执行未接入。':'尚未确认毕业；当前不提供执行路由，等待阶段核验。'};
  if(t.sourceUnavailable)warnings.push('当前平台行情不可用，档案为最近核验快照，交易仍保持禁用。');
  return{address:t.address,platformId:t.platformId,updatedAt:new Date(now()).toISOString(),quote:{address:t.quoteAsset,symbol:t.quoteSymbol,decimals:t.quoteDecimals},fees,tax,dev,firstBuyer:buyer,history:history(t,data,external),route,warnings,sources:['BSC 平台状态/配置','Agent ID handleOf + ownerOfHandle + balanceOf（同块）',...(t.platformId==='gang'?['Gang 官方索引']:t.platformId==='flap'?['Flap Reader / FSI 索引']:['Four Core / TaxToken']),...(poolRows.length?['DexScreener候选 + BSC池归属/储备核对']:[])]};
 }
 async function get(address){
  check(ADDRESS(address),'代币地址无效');const data=await snapshot(),rows=data.tokens.filter(t=>t.verified===true&&same(t.address,address));check(rows.length===1,'只能查询当前唯一已核验市场');const t=rows[0];
  const key=JSON.stringify([address.toLowerCase(),t.platformId,t.pad??null,t.launchType??null,t.manager??null,t.phase,t.creator||'',...(isMerged(t)?[t.sourceUpdatedAt??null,t.sourceBlock??null,Boolean(t.sourceUnavailable),t.tradable===true]:[])]),old=cache.get(key);if(old&&old.until>now())return old.data;if(pending.has(key))return pending.get(key);check(active<4,'档案请求繁忙，请稍后刷新');active++;
  const task=build(t,data).then(result=>{cache.set(key,{data:result,until:now()+30000});while(cache.size>128)cache.delete(cache.keys().next().value);return result;}).finally(()=>{active--;pending.delete(key);});pending.set(key,task);return task;
 }
 return{get};
}
