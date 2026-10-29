import test from'node:test';import assert from'node:assert/strict';
import{createMarketClient}from'../src/market-client.mjs';
const local=await import('../src/local-market.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
test('shared local discovery never constructs or starts the chain scanner',()=>{
 let scans=0,options;const shared={snapshot:()=>({tokens:[]})};
 assert.equal(typeof local.createLocalMarket,'function');const monitor=local.createLocalMarket({baseUrl:'https://district9.club',createDiscovery:()=>{scans++;throw Error('must not scan');},createClient:o=>{options=o;return shared;}});
 assert.deepEqual(monitor.snapshot(),shared.snapshot());assert.equal(scans,0);assert.equal(options.allowHttps,true);
});
test('ordinary standalone mode retains its existing discovery source',()=>{const monitor={};assert.equal(local.createLocalMarket({createDiscovery:()=>monitor}),monitor);});
test('stale preview-only prose cannot claim a verified tradable token has disabled the live switch',()=>{
 const token={platformId:'gang',tradable:true,reason:'V3 曲线买卖；需逐笔预览，真实交易保持关闭。'},monitor=local.createLocalMarket({baseUrl:'https://district9.club',createClient:()=>({snapshot:()=>({tokens:[token]})})});
 assert.doesNotMatch(monitor.snapshot().tokens[0].reason,/真实交易保持关闭/);assert.equal(monitor.snapshot().tokens[0].tradable,true);assert.match(token.reason,/真实交易保持关闭/);
});
test('HTTPS public discovery is explicit, anonymous, redirect-disabled and fails closed on stale data',async()=>{
 const token={address:'0x'+'1'.repeat(40),platformId:'gang',verified:true,tradable:true};let now=1000,options;
 const client=createMarketClient({baseUrl:'https://district9.club',allowHttps:true,now:()=>now,fetch:async(url,o)=>{options=o;return Response.json({tokens:[token],monitor:{status:'live'}});}});
 await client.refresh();assert.equal(client.snapshot().tokens[0].tradable,true);assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,undefined);now+=90001;assert.equal(client.snapshot().tokens[0].tradable,false);client.stop();
 assert.throws(()=>createMarketClient({baseUrl:'https://district9.club'}));
});
