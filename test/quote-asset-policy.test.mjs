import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Interface,keccak256} from 'ethers';
const mod=await import('../src/quote-asset-policy.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const codes=JSON.parse(readFileSync(new URL('./fixtures/quote-assets-bytecode.json',import.meta.url)));
const N='0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436',G='0x0c6302401aa5325C2E36F170f52C00B1d220B405';
const B='0x156d6dce9a4f6139a3406f1f021f1a4880de93a3',I='0xCFEd6c4679297ea4889F8183bC057B4A86C64e46';
function fixture(){let changed=false,locked=false,implementation=I;const reads=[];
 const provider={getNetwork:async()=>({chainId:56n}),getCode:async(a,b)=>{reads.push([a,b]);if(changed)return'0x6000';if(a.toLowerCase()===N.toLowerCase())return codes.stockProxy;if(a.toLowerCase()===I.toLowerCase())return codes.stockImplementation;if(a.toLowerCase()===G.toLowerCase())return codes.gang;return codes.stockBeacon;}};
 const read=async(p,a,abi,m,args,b)=>{reads.push([a,b]);if(m==='implementation')return implementation;if(m==='locked')return locked;if(m==='decimals')return 18n;throw Error(m);};
 return{provider,read,reads,change:()=>changed=true,lock:()=>locked=true,upgrade:()=>implementation=N};
}
test('unknown address cannot acquire transfer trust through a familiar symbol or same proxy code',async()=>{
 assert.equal(typeof mod.verifiedQuoteAsset,'function');const h=fixture();await assert.rejects(mod.verifiedQuoteAsset({...h,address:'0x'+'8'.repeat(40),blockTag:100}),/未核验|不支持/);assert.equal(h.reads.length,0);
});
test('stock transfer policy pins proxy, immutable beacon and current implementation at one block',async()=>{
 assert.equal(typeof mod.verifiedQuoteAsset,'function');const h=fixture();
 const evidence=await mod.verifiedQuoteAsset({...h,address:N,blockTag:100});
 assert.equal(evidence.verified,true);assert.equal(evidence.decimals,18);assert.equal(evidence.rawTransferTaxBps,0);assert.equal(evidence.upgradeable,true);assert.ok(h.reads.every(r=>r[1]===100));
 h.upgrade();await assert.rejects(mod.verifiedQuoteAsset({...h,address:N,blockTag:101}),/实现|升级|改变/);
});
test('GANG source-matched bytecode is trusted only after its transfer lock is released',async()=>{
 assert.equal(typeof mod.verifiedQuoteAsset,'function');const h=fixture();const r=await mod.verifiedQuoteAsset({...h,address:G,blockTag:100});assert.equal(r.verified,true);h.lock();await assert.rejects(mod.verifiedQuoteAsset({...h,address:G,blockTag:100}),/锁定/);h.change();await assert.rejects(mod.verifiedQuoteAsset({...h,address:G,blockTag:100}),/代码|改变/);
});

const F='0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1';
const FB='0xc046b05a920e4b412815934dd8e58904dda73315',FI='0x578f397ca4661d1db4d9a65065d6b284a1a850fd';
function ondoFixture(){
 let beacon=FB,implementation=FI,changed=false;const reads=[];
 const provider={getNetwork:async()=>({chainId:56n}),getStorage:async(a,slot,b)=>{reads.push([a,b]);return '0x'+beacon.slice(2).padStart(64,'0');},getCode:async(a,b)=>{reads.push([a,b]);a=a.toLowerCase();return a===F?codes.ondoProxy:a===FB?codes.ondoBeacon:changed?'0x6000':codes.ondoImplementation;}};
 const read=async(p,a,abi,method,args,b)=>{reads.push([a,b]);if(method==='decimals')return 18n;if(method==='implementation')return implementation;throw Error(method);};
 return {provider,read,reads,moveBeacon:()=>beacon=I.toLowerCase(),upgrade:()=>implementation=I.toLowerCase(),changeCode:()=>changed=true};
}
test('FXIon pins its storage beacon and verified GMToken implementation at the quote block',async()=>{
 const h=ondoFixture(),result=await mod.verifiedQuoteAsset({...h,address:F,blockTag:123});
 assert.equal(result.verified,true);assert.equal(result.symbol,'FXIon');assert.equal(result.rawTransferTaxBps,0);assert.equal(result.upgradeable,true);assert.ok(h.reads.every(r=>r[1]===123));
 h.moveBeacon();await assert.rejects(mod.verifiedQuoteAsset({...h,address:F,blockTag:124}),/Beacon|底币|改变/);
});
test('FXIon refuses an issuer implementation upgrade or modified executable code',async()=>{
 const a=ondoFixture();a.upgrade();await assert.rejects(mod.verifiedQuoteAsset({...a,address:F,blockTag:125}),/实现|升级|改变/);
 const b=ondoFixture();b.changeCode();await assert.rejects(mod.verifiedQuoteAsset({...b,address:F,blockTag:126}),/实现|升级|改变/);
});
