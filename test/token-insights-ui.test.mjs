import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const source=await readFile(new URL('../public/token-insights.js',import.meta.url),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
const address=n=>`0x${String(n).padStart(40,'0')}`;
const tick=async()=>{for(let n=0;n<4;n++)await new Promise(setImmediate);};
function snapshot(ca=address(1),overrides={}){
 return {address:ca,platformId:'gang',updatedAt:'2026-10-27T10:00:00.000Z',
  quote:{address:address(9),symbol:'WBNB',decimals:18},
  fees:{tokenBuyBps:null,tokenSellBps:0,tokenTaxScope:'仅外盘代币转账',platformBuyBps:null,platformSellBps:0,agentBps:0,note:'费用需以交易预览为准'},
  tax:{allocations:[{label:'流动性',bps:2500},{label:'未确认分配',bps:null}],recipients:[{label:'税收接收方',address:address(8),type:'external',source:'链上接收配置'}],note:'地址归属未确认'},
  dev:{address:address(7),name:'Creator',verified:true,nameSource:'官方创建记录'},
  firstBuyer:{address:null,name:null,verified:false,source:'官方成交记录',txHash:null,coverage:'最近200笔成交',note:'最早买家待核验'},
  history:{items:[],scope:'本机当前发现窗口',complete:false,totalKnown:null},
  route:{label:'内盘曲线',kind:'bonding',target:address(6),quoteAsset:address(9),pair:null,note:'实际执行以预览为准',pools:[]},
  warnings:[],sources:['官方接口','BSC 合约只读'],...overrides};
}
function page(){
 const {window,document}=parseHTML(html),requests=[],selected=[],timers=new Map();let nextTimer=0;
 const api=(path,body,options)=>new Promise((resolve,reject)=>requests.push({path,body,options,resolve,reject}));
 const runtime=vm.createContext({window,document,AbortController,URL,Intl,Date,console,
  setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
 vm.runInContext(source,runtime);
 assert.equal(typeof window.createTokenInsights,'function','the page exposes a standalone token-insights controller');
 const controller=window.createTokenInsights({api,onSelect:ca=>selected.push(ca)});
 return {window,document,requests,selected,timers,controller,root:document.getElementById('token-insights'),$:id=>document.getElementById(id)};
}

test('token dossier sits after the chart and safely renders unknown and zero fees without interpreting external ownership',async()=>{
 const p=page();assert.ok(p.root.previousElementSibling.classList.contains('chart-panel'));
 assert.ok(p.document.querySelector('script[src="/token-insights.js"]'));
 const unsafe='<img src=x onerror="window.injected=true">';
 p.controller.open({address:address(1)});
 assert.match(p.requests[0].path,/^\/api\/token-insights\?token=0x/);assert.ok(p.requests[0].options.signal);
 const data=snapshot();data.dev.name=unsafe;data.fees.note=unsafe;data.tax.recipients[0].label=unsafe;data.sources=[unsafe];
 p.requests[0].resolve(data);await tick();
 assert.equal(p.root.hidden,false);assert.equal(p.root.querySelectorAll('img,svg,script,iframe').length,0);
 assert.match(p.root.textContent,/<img src=x onerror=/);
 assert.equal(p.root.querySelector('[data-field="token-buy"]').textContent,'待核验');
 assert.equal(p.root.querySelector('[data-field="token-sell"]').textContent,'0%');
 assert.equal(p.root.querySelector('[data-field="platform-buy"]').textContent,'待核验');
 assert.equal(p.root.querySelector('[data-field="platform-sell"]').textContent,'0%');
 assert.match(p.root.textContent,/项目税适用范围：仅外盘代币转账/);assert.match(p.root.textContent,/内盘平台费用/);
 assert.match(p.root.textContent,/流动性.*25%/);assert.match(p.root.textContent,/外部地址，归属未知/);
 assert.match(p.root.textContent,/最近200笔成交/);assert.match(p.root.textContent,/当前覆盖范围：本机当前发现窗口/);
 assert.match(p.root.textContent,/不是全部历史/);assert.match(p.root.textContent,/已知总数：待核验/);
 assert.match(p.root.textContent,/来源：/);assert.match(p.root.textContent,/更新时间/);
 const receiver=p.root.querySelector(`a[href="https://bscscan.com/address/${address(8)}"]`);
 assert.equal(receiver.title,address(8));assert.notEqual(receiver.textContent,address(8));
 p.$('insights-toggle').click();assert.equal(p.$('insights-body').hidden,true);
 p.$('insights-toggle').click();assert.equal(p.$('insights-body').hidden,false);
 assert.ok([...p.root.querySelectorAll('details')].every(item=>!item.hasAttribute('open')));
 p.controller.close();
});

test('switching or closing aborts requests and late old responses cannot replace or flash token information',async()=>{
 const p=page();p.controller.open({address:address(1)});const old=p.requests[0];
 p.controller.open({address:address(2)});const current=p.requests[1];assert.equal(old.options.signal.aborted,true);
 current.resolve(snapshot(address(2),{dev:{address:address(7),name:'CURRENT DEV',verified:true,nameSource:'当前记录'}}));await tick();
 old.resolve(snapshot(address(1),{dev:{address:address(7),name:'STALE DEV',verified:true,nameSource:'旧记录'}}));await tick();
 assert.match(p.root.textContent,/CURRENT DEV/);assert.doesNotMatch(p.root.textContent,/STALE DEV/);
 p.controller.open({address:address(3)});assert.doesNotMatch(p.root.textContent,/CURRENT DEV/,'switch clears the previous token immediately');
 const closing=p.requests[2];p.controller.close();assert.equal(closing.options.signal.aborted,true);assert.equal(p.root.hidden,true);
 closing.resolve(snapshot(address(3),{dev:{name:'CLOSED DEV'}}));await tick();
 assert.doesNotMatch(p.root.textContent,/CLOSED DEV/);assert.equal(p.timers.size,0);
});

test('same-token opens coalesce; refresh and the 30-second poll replace only their own active request',async()=>{
 const p=page(),token={address:address(1)};
 p.controller.open(token);p.controller.open({...token,address:token.address.toUpperCase().replace('0X','0x')});assert.equal(p.requests.length,1);
 p.requests[0].resolve(snapshot());await tick();p.controller.open(token);assert.equal(p.requests.length,1);
 const timer=[...p.timers.values()][0];assert.equal(timer.ms,30000);assert.equal(p.timers.size,1);
 p.$('insights-refresh').click();assert.equal(p.requests.length,2);assert.equal(p.timers.size,0);
 p.requests[1].resolve(snapshot());await tick();const next=[...p.timers.values()][0];next.fn();assert.equal(p.requests.length,3);
 p.controller.close();assert.equal(p.requests[2].options.signal.aborted,true);
 p.requests[2].resolve(snapshot());await tick();assert.equal(p.timers.size,0);
});

test('only verified history entries in the current window can select a token; other addresses stay read-only',async()=>{
 const p=page(),items=[
  {address:address(11),name:'可查看详情',symbol:'GOOD',platformId:'gang',phase:'bonding',verified:true,inCurrentWindow:true,officialUrl:'https://gang.fun/token/ok'},
  {address:address(12),name:'未核验',symbol:'UNKNOWN',platformId:'four',phase:'unknown',verified:false,inCurrentWindow:true,officialUrl:'https://four.meme/token/read-only'},
  {address:address(13),name:'窗口外',symbol:'OUT',platformId:'flap',phase:'graduated',verified:true,inCurrentWindow:false,officialUrl:'https://flap.sh/apps/agent-bonding-curve'},
  {address:address(14),name:'恶意外链',symbol:'BAD',platformId:'four',phase:'unknown',verified:false,inCurrentWindow:false,officialUrl:'https://four.meme.evil.example/token/steal'},
  {address:'javascript:alert(1)',name:'无效地址',symbol:'INVALID',verified:true,inCurrentWindow:true,officialUrl:'https://user:pass@four.meme/token/steal'},
 ];
 p.controller.open({address:address(1)});p.requests[0].resolve(snapshot(address(1),{history:{items,scope:'最近发现的5个项目',complete:false,totalKnown:5}}));await tick();
 const history=p.root.querySelector('.insights-history'),buttons=[...history.querySelectorAll('button')];
 assert.equal(buttons.length,1);assert.match(buttons[0].textContent,/可查看详情/);buttons[0].click();assert.deepEqual(p.selected,[address(11)]);
 assert.equal(history.querySelector('a[href="https://four.meme/token/read-only"]').target,'_blank');
 assert.ok(history.querySelector(`a[href="https://bscscan.com/address/${address(14)}"]`));
 for(const link of p.root.querySelectorAll('a')){
  const url=new URL(link.href);assert.equal(url.protocol,'https:');assert.ok(['four.meme','gang.fun','flap.sh','bscscan.com'].includes(url.hostname));assert.equal(url.username,'');assert.equal(url.password,'');
 }
 assert.match(history.textContent,/不是全部历史/);assert.match(history.textContent,/窗口外/);assert.match(history.textContent,/待核验/);
 p.controller.close();
});

test('DEX pools are labeled as liquidity references and unknown liquidity remains unknown',async()=>{
 const p=page();p.controller.open({address:address(1)});
 p.requests[0].resolve(snapshot(address(1),{route:{label:'PancakeSwap 参考',kind:'dex-reference',target:null,quoteAsset:address(9),pair:address(5),note:'候选池只读查询',pools:[{address:address(5),dex:'PancakeSwap',quoteSymbol:'WBNB',liquidityUsd:null,verified:false,reason:'代币对已匹配，储备待核验',official:false}]}}));await tick();
 assert.match(p.root.textContent,/流动性参考/);assert.match(p.root.textContent,/外盘执行未接入/);
 const pools=p.root.querySelector('.insights-pools');assert.match(pools.textContent,/流动性.*待核验/);assert.doesNotMatch(pools.textContent,/\$0|最优|防夹/);
 assert.equal(pools.querySelectorAll('button').length,0);assert.match(pools.textContent,/代币对已匹配，储备待核验/);
 p.controller.close();
});

test('address mismatches and refresh failures expose status without replacing the last verified response',async()=>{
 const p=page();p.controller.open({address:address(1)});p.requests[0].resolve(snapshot(address(2)));await tick();
 assert.match(p.$('insights-state').textContent,/读取失败/);assert.equal(p.root.querySelector('[data-field="token-sell"]'),null);
 p.$('insights-refresh').click();p.requests[1].resolve(snapshot());await tick();
 p.$('insights-refresh').click();p.requests[2].reject(new Error('<img src=x onerror=alert(1)>'));await tick();
 assert.match(p.$('insights-state').textContent,/刷新失败/);assert.match(p.root.textContent,/上次数据/);assert.equal(p.root.querySelector('[data-field="token-sell"]').textContent,'0%');
 assert.equal(p.root.querySelectorAll('img').length,0);p.controller.close();
});


test('merged partial dossiers show their type, original snapshot and read-only availability without implying an inner execution route',async()=>{
 const p=page();p.controller.open({address:address(1)});
 p.requests[0].resolve(snapshot(address(1),{status:'partial',launchType:'fair',launchTypeLabel:'Fair 打新',sourceBlock:130122898,
  fees:{tokenBuyBps:100,tokenSellBps:0,tokenTaxScope:'毕业 / 发射后',platformBuyBps:null,platformSellBps:null,agentBps:null,note:'新类型平台费用尚未接入核验'},
  history:{items:[{address:address(11),name:'Fair待发射',platformId:'gang',launchType:'fair',launchTypeLabel:'Fair 打新',phase:'bonding',locked:true,verified:true,inCurrentWindow:true}],scope:'当前已核验监控窗口',complete:false,totalKnown:null},
  route:{kind:'readonly',label:'新类型只读资料',target:null,quoteAsset:address(9),pair:null,pools:[],note:'尚未接入执行'},warnings:['仅展示最近核验快照']}));await tick();
 assert.match(p.$('insights-state').textContent,/部分.*只读/);assert.match(p.$('insights-context').textContent,/Fair 打新/);assert.match(p.$('insights-context').textContent,/快照时间/);assert.match(p.$('insights-context').textContent,/130122898/);
 assert.match(p.root.querySelector('.insights-history').textContent,/打新中/);assert.match(p.root.querySelector('.insights-pools').textContent,/只读.*未接入执行/);assert.doesNotMatch(p.root.textContent,/当前实际交易路由|Gang V2/);assert.equal(p.root.querySelector('[data-field="platform-buy"]').textContent,'待核验');p.controller.close();
});
