import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpServer} from '../src/server.mjs';
import {createWalletTracking} from '../src/wallet-tracking.mjs';

const address='0x1111111111111111111111111111111111111111';
test('tracking management is local CSRF protected and saved markets remain outside executable token discovery',async t=>{
 let tokens=[{address,platformId:'gang',verified:true,symbol:'OLD',phase:'graduated'}];
 const monitor={snapshot:()=>({tokens}),stop(){}};
 const tracking=createWalletTracking({snapshot:monitor.snapshot,poll:async()=>({events:[],cursor:100,status:{state:'live'}})});
 await tracking.saveWallet({address:'0x2222222222222222222222222222222222222222'});await tracking.tick();tokens=[];
 let chartToken;
 const server=createHttpServer({monitor,tracking,baw:{},trades:{list:()=>[],isLiveExecution:()=>false},protocol:{},charts:{get:async token=>{chartToken=token;return{address:token,candles:[]};}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const session=await(await fetch(`${base}/api/session`)).json();const headers={Origin:base,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
 assert.equal((await fetch(`${base}/api/tracking`)).status,200);
 assert.equal((await fetch(`${base}/api/tracking/wallet`,{method:'POST',headers:{...headers,'X-CSRF-Token':''},body:JSON.stringify({address})})).status,403);
 const saved=await(await fetch(`${base}/api/tracking/wallet`,{method:'POST',headers,body:JSON.stringify({address,note:'Read only',xUrl:'https://x.com/example'})})).json();assert.equal(saved.wallets.length,2);
 const old=await(await fetch(`${base}/api/tracking/token?token=${address}`)).json();assert.equal(old.address,address);assert.equal(old.tradable,false);
 assert.equal((await(await fetch(`${base}/api/tokens`)).json()).tokens.length,0);
 assert.equal((await fetch(`${base}/api/candles?token=${address}`)).status,200);assert.equal(chartToken,address);
 assert.equal((await fetch(`${base}/api/positions?token=${address}`)).status,404);
 const pref=await(await fetch(`${base}/api/tracking/preferences`,{method:'POST',headers,body:'{"showAvatars":false}'})).json();assert.equal(pref.preferences.showAvatars,false);
 const removed=await(await fetch(`${base}/api/tracking/wallet/remove`,{method:'POST',headers,body:JSON.stringify({address})})).json();assert.equal(removed.wallets.length,1);
});
