import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther as E } from 'ethers';
import { gangMetrics, fourMetrics, flapMetrics, enrichMarketMetrics } from '../src/market-metrics.mjs';
const V=1066666666666666666666666667n;

test('Gang graduation uses each curve locked target and virtual quote, and FDV supply is one billion',()=>{
 const m=gangMetrics({virtualQuote:E('5'),gradAmt:E('15')},18);
 assert.equal(m.chartSupply,'1000000000');
 assert.ok(Math.abs(Number(m.graduationPrice)-7.5e-8)<1e-17);
 assert.equal(gangMetrics({virtualQuote:0n,gradAmt:E('15')},18).graduationPrice,null);
});
test('Four target uses remaining sale inventory and rejects an unrecognized current curve model',()=>{
 const cfg={maxSupply:E('1000000000'),saleAmount:E('800000000')};
 const s={available:true,initialQuoteLiquidity:E('5'),initialTokenLiquidity:V,currentQuoteLiquidity:E('5'),currentTokenLiquidity:V,lastPrice:E('5')*10n**18n/V};
 const m=fourMetrics(cfg,s);assert.ok(Number(m.graduationPrice)>0);assert.equal(m.chartSupply,'1000000000');
 assert.equal(fourMetrics(cfg,{...s,lastPrice:E('3')}).graduationPrice,null);
 assert.equal(fourMetrics(cfg,{available:false}).graduationPrice,null);
});
test('Flap graduation uses net curve reserve at cap; unknown model and malformed inputs have no target',()=>{
 const s={curveR:E('6.14'),curveK:E('6797205657.28'),virtualReserveAtCapRaw:E('4.85')};
 const d={curveReserveRaw:0n};const current=s.curveR*s.curveR/s.curveK;
 const m=flapMetrics(s,d,current);assert.ok(Number(m.graduationPrice)>Number(current)/1e18);assert.equal(m.chartSupply,'1000000000');
 assert.equal(flapMetrics(s,d,1n).graduationPrice,null);
});
test('market caps keep native denomination if no FX; share FDV is labeled and invalid prices are not zero',()=>{
 const rows=enrichMarketMetrics([{platformId:'gang',quoteAsset:'0x11',quoteSymbol:'GANG',price:'0.0001',chartSupply:'1000000000',valuationQuoteUsd:0.01}, {platformId:'flap',quoteAsset:'0x22',quoteSymbol:'QQQB',price:'0.0002',chartSupply:'1000000000',positionKind:'shares'}, {price:null,chartSupply:'1000000000'}]);
 assert.equal(rows[0].marketCap.value,1000);assert.equal(rows[0].marketCap.unit,'USD');
 assert.equal(rows[1].marketCap.value,200000);assert.equal(rows[1].marketCap.unit,'QQQB');assert.match(rows[1].marketCap.label,/份额/);
 assert.equal(rows[2].marketCap,null);
});

test('failed or expired source FX cannot price another market in USD; healthy WBNB FX also covers native BNB',()=>{
 const base={platformId:'gang',quoteAsset:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',quoteSymbol:'WBNB',price:'0.0001',chartSupply:'1000000000',valuationQuoteUsd:700};
 const four={platformId:'four',quoteAsset:base.quoteAsset,quoteSymbol:'BNB',price:'0.0001',chartSupply:'1000000000'};
 assert.equal(enrichMarketMetrics([{...base,sourceUnavailable:true},four])[1].marketCap.unit,'BNB');
 assert.equal(enrichMarketMetrics([{...base,sourceUpdatedAt:new Date(0).toISOString()},four])[1].marketCap.unit,'BNB');
 const native={...four,quoteAsset:'0x0000000000000000000000000000000000000000'};
 assert.equal(enrichMarketMetrics([base,native])[1].marketCap.unit,'USD');
});


test('verified graduated pool prices use pool FDV provenance instead of a curve-reference label',()=>{
 const row=enrichMarketMetrics([{phase:'graduated',positionKind:'token',priceSource:'verified-pool',quoteSymbol:'WBNB',price:'0.000002',chartSupply:'1000000000',indexedMarketCapUsd:null}])[0];
 assert.equal(row.marketCap.value,2000);assert.equal(row.marketCap.label,'FDV');assert.equal(row.marketCap.source,'链上池价 × 总供应量');
});
