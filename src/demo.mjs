import { randomUUID } from 'node:crypto';
import { parseEther,formatUnits,parseUnits } from 'ethers';
import { enforceTradeRisk,priceImpactLimit,withRiskGas } from './trade-risk.mjs';
import { enrichMarketMetrics } from './market-metrics.mjs';
import { PLATFORMS } from './market-hub.mjs';
import {validateCandleBefore,validateCandleCurrency} from './candle-query.mjs';
import {fairSaleSnapshot,fairPositionPrincipal} from './gang-fair-sale.mjs';

// 故意独立的演示数据；不与实时列表合并，也不创建 baw 实例。
export function createDemo({fairLaunch=false}={}) {
  const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const address = '0x000000000000000000000000000000000000dEaD';
  const tokens = [
    ['SIGNAL', 'Signal Agent · 演示', '0.0000000142', 24.6, '3.42'],
    ['NEXUS', 'Nexus.ai · 演示', '0.0000000821', 88.1, '12.87'],
    ['CIRCUIT', 'Circuit Agent · 演示', '0.0000000063', 8.4, '0.96'],
    ['ORBIT', 'Orbit.ai · 演示', '0.000000196', 100, '27.30'],
    ['NOVA', 'Nova Market · 演示', '0.00216', 46.2, '10800'],
  ].map((t, i) => {
    const id = ['four', 'gang', 'flap', 'four', 'flap'][i];
    const quoteSymbol = i === 1 ? 'WBNB' : i === 4 ? 'QQQB' : 'BNB';
    return { creator: address, quoteAsset: i===4?'0x3333333333333333333333333333333333333333':'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', tokenTaxBuyBps:'100',tokenTaxSellBps:'100',tokenTaxScope:id==='gang'?'外盘':id==='flap'?'发射后':'项目税',protocolBuyFeeBps:id==='gang'?'100':null,creatorName:'demo.ai · 演示', chartSupply:'1000000000', graduationPrice:String(Number(t[2])*1.2), graduationLabel:'理论毕业线 · 演示', symbol: t[0], name: t[1], platformId: id, platformName: PLATFORMS[id].name, platformLogo: PLATFORMS[id].logo, positionKind: id === 'flap' ? 'shares' : 'token', addressKind: id === 'flap' ? 'market' : 'token', ...(id === 'flap' ? { predictedToken: `0x${String(i + 101).padStart(40, '0')}`, tokenAddress: null } : {}), quoteSymbol, quoteDecimals: 18, priceUnit: `${quoteSymbol}${id === 'flap' ? '/份额' : ''}`, imageUrl: `/assets/demo-${i === 4 ? 'circuit' : t[0].toLowerCase()}.svg`, imageSource: 'local-demo', metadataStatus: 'demo', address: `0x${String(i + 1).padStart(40, '0')}`, price: t[2], progress: t[3], volume: t[4], volumeLabel: `演示成交量 · ${quoteSymbol}`, phase: i === 3 ? 'graduated' : 'bonding', verified: true, tradable: i !== 3, reason: i === 3 ? '已毕业，当前仅支持内盘' : '演示数据，不可实盘交易', officialUrl: PLATFORMS[id].url, createdAt: new Date(Date.now() - (i + 1) * 180000).toISOString() };
  });
  if(fairLaunch){
    const quoteAsset='0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',sourceUpdatedAt=new Date().toISOString();
    const fairSale={...fairSaleSnapshot({sold:6800n,sharePrice:parseEther('0.0005'),capShares:100n,mintFeeBps:100n,exitFeeBps:100n,launched:false},{totalShares:10000n,tokensPerShare:parseEther('50000'),effectiveExitFeeBps:100n,updatedAt:sourceUpdatedAt}),demo:true};
    tokens.push({...tokens[1],address:'0x0000000000000000000000000000000000000006',symbol:'FAIR',name:'Fair Launch · 演示',pad:'merged',launchType:'fair',launchTypeLabel:'Fair 打新',phase:'bonding',locked:true,progress:68,price:null,graduationPrice:null,marketCap:null,priceSource:null,quoteAsset,fairSale,sourceUpdatedAt,sourceBlock:null,volume:null,volumeLabel:'认购进度',demo:true});
  }
  const protocol = {
    async positions(token, walletAddress) {
      const market = tokens.find(t => t.address.toLowerCase() === token.toLowerCase());
      if (!market) throw new Error('演示代币不存在');
      if(market.launchType==='fair')return {address:walletAddress,token,balance:parseEther('150000').toString(),allowance:'0',decimals:18,positionKind:'token',quoteSymbol:'WBNB',quoteDecimals:18,quoteBalance:parseEther('1.25').toString(),demo:true,fairShares:'3',sellUnitRaw:parseEther('50000').toString(),...fairPositionPrincipal(3n,parseEther('0.0005'))};
      return { address: walletAddress, token, balance: parseEther('12345.678901234567890123').toString(), allowance: '0', decimals: 18, positionKind: market.positionKind, quoteSymbol: market.quoteSymbol, quoteDecimals: 18, quoteBalance: parseEther(market.quoteSymbol === 'QQQB' ? '10000' : '1.25').toString(), demo: true };
    },
    async buildTrade({ token, side, amount, walletAddress,slippageBps=50,maxPriceImpactBps=300 }) {
      const t = tokens.find(t => t.address === token);
      if (!t?.tradable) throw new Error('演示代币当前不可交易');
      if(t.launchType==='fair'){
        const raw=parseEther(amount),price=parseEther('0.0005'),unit=parseEther('50000'),shares=side==='buy'?raw*100n/(price*101n):raw/unit;
        if(shares<=0n||shares>100n||side==='sell'&&(raw%unit!==0n||shares>3n))throw Error('演示 Fair 需按整份操作并遵守钱包限额');
        const principal=shares*price,fee=principal/100n,output=side==='buy'?shares*unit:principal-fee,cost=side==='buy'?principal+fee:0n;
        const risk=withRiskGas({status:'ok',limitBps:maxPriceImpactBps,priceImpactBps:0,priceImpactMethod:'独立演示固定申购价格，不代表市场成交价',depthVerified:true,realQuoteReserve:'3.4',quoteSymbol:'WBNB',outputSymbol:side==='buy'?'FAIR':'BNB',estimatedNetOutput:formatUnits(output,18),minimumNetOutput:formatUnits(output,18),feeAmount:formatUnits(fee,18),feeSymbol:'WBNB',warnings:['DEMO · 认购份数、费用和本金为独立演示数据；无真实资产变化。'],blockReasons:[]},'0.000005',{nativeOutput:side==='sell'});
        return {kind:side,transaction:{from:walletAddress,to:address,value:side==='buy'?String(cost):'0',data:'0x'},summary:{mode:'纯演示，不签名、不广播',platformId:'gang',quoteSymbol:'BNB',launchType:'fair',phase:'bonding',walletAddress,token,side,amount,fairShares:String(shares),tokensPerShare:'50000',unspentBudget:side==='buy'?formatUnits(raw-cost,18):'0',tradeRisk:risk}};
      }
      const unit=10n**18n,input=parseEther(amount),q=parseEther(t.quoteSymbol==='QQQB'?'10000':'10'),reserve=q*unit/parseEther(t.price),ceil=(a,b)=>(a+b-1n)/b;
      let output,fee,curveQuote;
      if(side==='buy'){fee=input/100n;curveQuote=input-fee;output=curveQuote*reserve/(q+curveQuote);}
      else{curveQuote=input*q/(reserve+input);fee=curveQuote/100n;output=curveQuote-fee;}
      const tokenAmount=side==='buy'?output:input,spot=tokenAmount*q,curve=curveQuote*reserve;
      const impact=Number(ceil((side==='buy'?curve-spot:spot-curve)*10000n,spot));
      const minimum=output*BigInt(10000-slippageBps)/10000n,limit=priceImpactLimit(maxPriceImpactBps),high=impact>limit;
      const tradeRisk=withRiskGas({status:side==='buy'&&high?'blocked':side==='sell'&&high?'warning':'ok',limitBps:limit,priceImpactBps:impact,priceImpactMethod:'独立演示恒定乘积曲线，交易费与冲击分别计算；不代表真实市场',depthVerified:true,realQuoteReserve:formatUnits(q,18),virtualQuoteReserve:null,curveQuoteLiquidity:formatUnits(q,18),quoteSymbol:t.quoteSymbol,estimatedNetOutput:formatUnits(output,18),minimumNetOutput:formatUnits(minimum,18),outputSymbol:side==='buy'?`${t.symbol}${t.positionKind==='shares'?' 份额':''}`:t.quoteSymbol,feeAmount:formatUnits(fee,18),feeSymbol:t.quoteSymbol,warnings:['DEMO：深度、费用、Gas和报价均为独立演示数据。',...(side==='sell'&&high?['本次演示卖出价格冲击较高，保留退出确认']:[])],blockReasons:side==='buy'&&high?['演示买入价格冲击超过所设上限']:[]},'0.000005',{nativeOutput:side==='sell'&&t.quoteSymbol==='BNB'});
      enforceTradeRisk(tradeRisk,side);
      return { transaction: { from: walletAddress, to: address, value: side === 'buy' && t.quoteSymbol === 'BNB' ? parseEther(amount).toString() : '0', data: '0x' }, summary: { mode: '纯演示，不会发送到钱包或区块链', platformId: t.platformId, quoteSymbol: t.quoteSymbol, positionKind: t.positionKind, side, token, amount, symbol: t.symbol,tradeRisk,maxPriceImpactBps:limit }, kind: side };
    },
  };
  const baw = {
    async wallet() { return { available: true, status: 'CONNECTED', address, balance: '1.2500', quota: { quotaUsed: '25', quotaLeft: '475', dailyLimit: '500', date: localDate() }, devMode: { enabled: true, expiresAt: '2099-01-01', dailyLimit: '100', quotaUsed: '10', quotaDate: localDate(), demo: true }, raw: { note: '全部为演示数据',balance:tokens.filter(t=>t.positionKind!=='shares').map(t=>({address:t.address,symbol:t.symbol,binanceChainId:'56',balance:'12345.678901234567890123',price:(Number(t.price)*700).toFixed(18)})) } }; },
    async preview(transaction) { return { requestId: `DEMO-${randomUUID()}`, expiresAt: Date.now() + 30000, parsedTx: { transactionType: 'DEMO_ONLY', ...transaction }, simulationResult: { balanceChanges: [], allowanceChanges: [], authorityChanges: [] }, risks: { riskDetails: [{ title: '演示模式', description: '此预览没有调用 baw，也不会签名或广播。' }], addresses: {} }, requireConfirmation: false }; },
    async execute() { return { status: 'DEMO_COMPLETED', orderId: `demo-${randomUUID()}`, txHash: null, message: '演示完成 · 没有发生真实交易' }; },
  };
  const monitor = { start() {}, stop() {}, snapshot() { return { tokens: enrichMarketMetrics(tokens), monitor: { status: 'demo', message: '三平台演示数据 · 不读取真实行情，不发送真实交易', lastBlock: null, updatedAt: new Date().toISOString(), sources: Object.values(PLATFORMS).map(p => ({ ...p, status: 'demo', count: tokens.filter(t => t.platformId === p.id).length, message: '独立演示数据', updatedAt: new Date().toISOString() })), templateId: '1778027615735', registry: '0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94', manager: '0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3' } }; } };
  const demoEpoch=Date.now();
  const charts = { async get(token, interval = '1min', mode = 'price', {before,currency}={}) {
    validateCandleBefore(before);validateCandleCurrency(currency);
    const market = tokens.find(t => t.address.toLowerCase() === token.toLowerCase());
    if (!market) throw new Error('演示代币不存在');
    if(!['price','marketcap'].includes(mode))throw new Error('不支持的K线指标');
    const scale=mode==='marketcap'?Number(market.chartSupply):1;
    const step = { '1s':1000,'5s':5000,'15s':15000,'1min': 60000, '5min': 300000, '15min': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval];
    if (!step) throw new Error('不支持的K线周期');
    const end = Math.floor((before===undefined?Date.now():before-1) / step) * step;
    const epoch=Math.floor(demoEpoch/step)*step;
    const floor=epoch-4999*step;
    const count=Math.min(96,Math.max(0,Math.floor((end-floor)/step)+1));
    const first=end-(count-1)*step;
    const closeAt=t=>Number(market.price)*scale*(1+Math.sin((t-epoch)/step*.065)*.28+Math.sin((t-epoch)/step*.21)*.06);
    const idleAt=t=>{const n=Math.abs(Math.floor((t-epoch)/step))%9;return n>=4&&n<=6;};
    let previousTime=first-step;
    while(idleAt(previousTime))previousTime-=step;
    let previous = closeAt(previousTime);
    let candles = Array.from({ length: count }, (_, i) => {
      const t=first+i*step;
      if(idleAt(t))return {t,o:previous,h:previous,l:previous,c:previous,v:0,idle:true};
      const o = previous, c = closeAt(t);
      previous = c;
      return { t, o, h: Math.max(o,c) * 1.025, l: Math.min(o,c) * .975, c, v: (1 + Math.sin((t-epoch)/step * .43)) * .3 };
    });
    // Display-only demo rates stay entirely separate from public/live FX.
    const scalar=currency===undefined?1:(market.quoteSymbol==='QQQB'?0.0001:1)*(currency==='USD'?750:1);
    if(currency!==undefined)candles=candles.map(c=>({...c,o:c.o*scalar,h:c.h*scalar,l:c.l*scalar,c:c.c*scalar}));
    const priceUnit=currency?`${currency}${mode==='price'&&market.positionKind==='shares'?'/份额':''}`:mode==='marketcap'?market.quoteSymbol:market.priceUnit;
    const currencyConversion=currency?{status:'demo',requestedCurrency:currency,sourceUnit:market.priceUnit,method:'simulated-demo-rate',warning:'显示汇率也为独立演示数据。'}:undefined;
    return { address: market.address, interval, mode, ...(currency?{currency,currencyConversion,sourcePriceUnit:market.priceUnit}:{}), seriesKey:JSON.stringify(['demo',market.address,market.phase,market.positionKind,interval,mode,market.priceUnit,scale,currency??null]), pagination:{nextBefore:candles[0]?.t??null,hasMore:!!candles.length&&candles[0].t>floor,scope:'demo',reason:'simulated-history'}, graduation:{value:Number(market.graduationPrice)*scale*scalar,label:'理论毕业线 · 演示'}, candles, kind: 'demo', source: 'demo', sourceLabel: 'DEMO · 独立演示曲线', priceUnit, volumeUnit: market.quoteSymbol, updatedAt: new Date().toISOString(), stale: false, warning: '演示图形与成交量均为假数据，不代表真实行情。' };
  } };
  const insights={async get(token){
    const t=tokens.find(t=>t.address.toLowerCase()===token.toLowerCase());if(!t)throw Error('演示代币不存在');
    return {address:t.address,platformId:t.platformId,updatedAt:new Date().toISOString(),quote:{address:t.quoteAsset,symbol:t.quoteSymbol,decimals:18},
      fees:{tokenBuyBps:100,tokenSellBps:100,tokenTaxScope:t.tokenTaxScope,platformBuyBps:t.platformId==='gang'?100:null,platformSellBps:t.platformId==='gang'?100:null,agentBps:null,note:'全部为独立演示配置，不代表真实代币税率。'},
      tax:{allocations:[{label:'演示持有人分红',bps:5000},{label:'演示项目收益',bps:5000}],recipients:[{label:'演示接收地址',address,type:'unknown',source:'独立演示数据'}],note:'假数据，仅预览信息布局。'},
      dev:{address,name:'demo.ai · 演示',verified:false,nameSource:'独立演示数据'},firstBuyer:{address,name:'buyer.ai · 演示',verified:false,source:'独立演示',coverage:'无真实交易历史',note:'假数据，不代表链上首买'},
      history:{items:tokens.map(r=>({...r,verified:true,inCurrentWindow:true})),complete:false,totalKnown:null,scope:'演示列表'},route:{kind:t.phase==='bonding'?'bonding':'dex-reference',label:'演示路由',target:null,quoteAsset:t.quoteAsset,pair:null,pools:[],note:'演示不会选池、签名或广播。'},warnings:['DEMO：档案与曲线均为假数据。'],sources:['独立演示']};
  }};
  const portfolioLedger=async owner=>({address:owner,demo:true,complete:true,assets:tokens.map((t,i)=>{
    const balance=parseUnits('12345.678901234567890123',36),unit=10n**36n,price=parseUnits((Number(t.price)*(t.quoteSymbol==='QQQB'?1.5:700)).toFixed(18),36),value=balance*price/unit;
    const fmt=n=>formatUnits(n,36),rate=i%2?120n:80n,sellRate=i%2?110n:90n;
    return{address:t.address,positionKind:t.positionKind,complete:true,fills:[{id:`demo-buy-${i}`,side:'buy',quantity:fmt(balance*2n),costUsd:fmt(value*2n*rate/100n),confirmed:true},{id:`demo-sell-${i}`,side:'sell',quantity:fmt(balance),proceedsUsd:fmt(value*sellRate/100n),confirmed:true}]};
  })});
  const fairParticipants={async get(token,{offset=0,block}={}){
    const market=tokens.find(t=>t.address.toLowerCase()===String(token).toLowerCase()&&t.launchType==='fair');
    if(!market||!Number.isSafeInteger(offset)||offset<0||offset>10000||offset%50!==0||offset>0&&block!==1||block!==undefined&&block!==1)throw Error('演示认购分页无效，请刷新');
    const candidates=[...Array.from({length:68},(_,i)=>({address:'0x'+(0xd90000+i).toString(16).padStart(40,'0'),shares:i===67?97n:100n})),{address,shares:3n}];
    const rows=candidates.slice(offset,offset+50).map(r=>({address:r.address,shares:String(r.shares),tokenAmount:String(r.shares*50000n),principal:formatUnits(r.shares*parseEther('0.0005'),18)})),hasMore=offset+50<candidates.length;
    return {token:market.address,block:1,updatedAt:new Date().toISOString(),demo:true,items:rows,indexedTotal:candidates.length,checkedOnPage:rows.length,inactiveOnPage:0,offset,hasMore,nextOffset:hasMore?offset+50:null,truncated:false,complete:false,quoteSymbol:'WBNB',symbol:'FAIR',coverage:'DEMO · 独立模拟认购地址与份数，无真实链上交易'};
  }};
  return { protocol, baw, monitor, charts, insights,portfolioLedger,fairParticipants };
}
