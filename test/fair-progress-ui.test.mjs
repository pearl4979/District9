import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const detailSource=await readFile(new URL('../public/token-detail.js',import.meta.url),'utf8');
const fairSource=await readFile(new URL('../public/fair-progress.js',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
const participantSource=await readFile(new URL('../public/fair-participants.js',import.meta.url),'utf8');
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40),W='0x'+'1'.repeat(40),OTHER='0x'+'2'.repeat(40);
const sale=()=>({verified:true,status:'minting',soldShares:'6800',totalShares:'10000',remainingShares:'3200',walletCapShares:'100',progress:68,tokensPerShare:'50000.0',sharePriceRaw:'500000000000000',sharePrice:'0.0005',subscribedPrincipal:'3.4',targetPrincipal:'5.0',mintFeeBps:100,exitFeeBps:100,sourceBlock:123,updatedAt:new Date().toISOString()});
const fair=()=>({address:A,platformId:'gang',pad:'merged',launchType:'fair',name:'Fair fixture',symbol:'FAIR',phase:'bonding',verified:true,locked:true,quoteSymbol:'WBNB',quoteDecimals:18,priceUnit:'WBNB',fairSale:sale(),sourceUpdatedAt:new Date().toISOString(),sourceBlock:123});
const personal=()=>({wallet:{address:W,available:true,status:'CONNECTED'},position:{token:A,address:W,fairShares:'3',fairPrincipal:'0.0015',fairPrincipalRaw:'1500000000000000',quoteSymbol:'WBNB',sourceBlock:124,updatedAt:new Date().toISOString()}});
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(setImmediate);};
async function page({holdChart=false,withParticipants=false}={}){
 const {window,document}=parseHTML(html),requests=[],waiters=[];let context=personal(),refreshes=0;
 window.HTMLElement.prototype.scrollIntoView=function(){};window.createTokenInsights=()=>({open(){},close(){}});
 window.AgentCandleChart={create(){return {setData(){},clear(){},reset(){}};}};
 const api=async(path,body,options)=>{requests.push({path,body,options});const address=new URL(path,'http://local').searchParams.get('token');if(path.startsWith('/api/fair-participants?'))return {token:address,block:123,updatedAt:new Date().toISOString(),demo:false,items:[{address:W,shares:'3',tokenAmount:'150000',principal:'0.0015'}],indexedTotal:1,checkedOnPage:1,inactiveOnPage:0,offset:0,hasMore:false,nextOffset:null,quoteSymbol:'WBNB'};const result={address,source:'fixture',priceUnit:'BNB',interval:'1min',mode:'marketcap',candles:[],pagination:{hasMore:false}};if(holdChart)return new Promise(resolve=>waiters.push(()=>resolve(result)));return result;};
 const ctx=vm.createContext({window,document,Date,Intl,URL,AbortController,setTimeout:()=>1,clearTimeout(){},console});if(withParticipants)vm.runInContext(participantSource,ctx);if(fairSource)vm.runInContext(fairSource,ctx);vm.runInContext(detailSource,ctx);
 const detail=window.createTokenDetail({api,avatar:()=>document.createElement('span'),copy(){},canClose:()=>true,onBack(){},onTrade(){},onSelect(){},getPosition:()=>context,onRefresh:async()=>{refreshes++;}});
 return{window,document,detail,requests,waiters,$:id=>document.getElementById(id),setContext:c=>context=c,get refreshes(){return refreshes;}};
}
test('prelaunch Fair shows share-goal progress and exact principal instead of issuing candle reads',async()=>{
 const p=await page();p.detail.open(fair());await settle();assert.equal(p.$('fair-progress-panel')?.hidden,false);assert.equal(p.document.querySelector('.chart-panel').hidden,true);assert.equal(p.requests.length,0);
 assert.match(p.$('fair-progress-percent').textContent,/68/);assert.equal(Number(p.$('fair-progress-bar').value),6800);assert.equal(Number(p.$('fair-progress-bar').max),10000);const text=p.$('fair-progress-panel').textContent;for(const part of ['6,800','10,000','3,200','0.0005','50,000','3.4','5 WBNB'])assert.ok(text.includes(part),part);assert.match(p.$('fair-my-shares').textContent,/3 份/);assert.match(p.$('fair-my-principal').textContent,/0.0015 WBNB/);
 p.$('fair-refresh').click();await settle();assert.equal(p.refreshes,1);assert.equal(p.requests.length,0);
});
test('Fair exits lower effective progress and full subscription waits for verified graduation before candles',async()=>{
 const p=await page(),t=fair();p.detail.open(t);const lower={...t,fairSale:{...sale(),soldShares:'5000',remainingShares:'5000',progress:50,subscribedPrincipal:'2.5'}};p.detail.update(lower);assert.match(p.$('fair-progress-percent').textContent,/50/);
 p.detail.update({...t,fairSale:{...sale(),soldShares:'10000',remainingShares:'0',progress:100,subscribedPrincipal:'5.0',status:'filled'}});await settle();assert.match(p.$('fair-status').textContent,/满额.*等待发射/);assert.equal(p.requests.length,0);assert.equal(p.document.querySelector('.chart-panel').hidden,true);
 p.detail.update({...t,phase:'graduated',locked:false});await settle();assert.equal(p.$('fair-progress-panel').hidden,true);assert.equal(p.document.querySelector('.chart-panel').hidden,false);assert.equal(p.requests.filter(r=>r.path.startsWith('/api/candles?')).length,1);assert.ok(p.$('chart-wallet-avatars'));
});
test('missing or stale Fair data is not replaced by guessed share counts or a zero balance',async()=>{
 const p=await page(),t=fair();p.detail.open({...t,fairSale:null,progress:68});assert.match(p.$('fair-progress-percent').textContent,/—/);assert.equal(p.$('fair-progress-bar').hidden,true);assert.match(p.$('fair-status').textContent,/待核验/);
 p.detail.update({...t,sourceUnavailable:true});assert.match(p.$('fair-data-status').textContent,/延迟|上次/);
 p.setContext({wallet:{address:W,available:true,status:'CONNECTED'},positionBusy:true});p.detail.updatePosition();assert.match(p.$('fair-my-shares').textContent,/读取/);
 p.setContext({...personal(),position:{...personal().position,address:OTHER}});p.detail.updatePosition();assert.match(p.$('fair-my-shares').textContent,/待核验|不可用/);assert.doesNotMatch(p.$('fair-my-shares').textContent,/0 份/);
 p.setContext({});p.detail.updatePosition();assert.match(p.$('fair-my-status').textContent,/连接钱包/);assert.equal(p.$('fair-my-principal').textContent,'—');
});
test('late chart responses cannot replace the Fair view and curve markets restore their chart normally',async()=>{
 const p=await page({holdChart:true}),curve={...fair(),address:B,launchType:'curve-v3'};p.detail.open(curve);await settle();assert.equal(p.requests.length,1);p.detail.open(fair());assert.equal(p.requests[0].options.signal.aborted,true);p.waiters[0]();await settle();assert.equal(p.document.querySelector('.chart-panel').hidden,true);assert.equal(p.$('fair-progress-panel').hidden,false);
 p.detail.open(curve);await settle();assert.equal(p.$('fair-progress-panel').hidden,true);assert.equal(p.document.querySelector('.chart-panel').hidden,false);assert.equal(p.requests.length,2);
});
test('personal subscription never presents expired position data as current alongside fresh global progress',async()=>{
 const p=await page();p.detail.open(fair());const old=personal();old.position.updatedAt=new Date(Date.now()-86400000).toISOString();p.setContext(old);p.detail.updatePosition();assert.equal(p.$('fair-my-shares').textContent,'—');assert.equal(p.$('fair-my-principal').textContent,'—');assert.match(p.$('fair-my-status').textContent,/过期|延迟/);
 p.setContext(personal());p.detail.updatePosition();assert.match(p.$('fair-my-shares').textContent,/3 份/);assert.match(p.$('fair-my-status').textContent,/更新/);
});
test('actual Fair detail integration mounts participant reads, refreshes them and closes them on graduation',async()=>{
 const p=await page({withParticipants:true});p.detail.open(fair());await settle();assert.equal(p.$('fair-participants-panel').hidden,false);assert.match(p.$('fair-participant-rows').textContent,/150,000/);assert.equal(p.requests.filter(r=>r.path.startsWith('/api/candles?')).length,0);
 p.$('fair-refresh').click();await settle();assert.equal(p.requests.filter(r=>r.path.startsWith('/api/fair-participants?')).length,2);
 p.detail.update({...fair(),phase:'graduated',locked:false});await settle();assert.equal(p.$('fair-participants-panel').hidden,true);assert.equal(p.requests.filter(r=>r.path.startsWith('/api/candles?')).length,1);
});
