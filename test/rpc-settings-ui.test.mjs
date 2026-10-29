import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile}from'node:fs/promises';import {parseHTML}from'linkedom';
const source=await readFile(new URL('../public/rpc-settings.js',import.meta.url),'utf8'),flush=async()=>{for(let i=0;i<6;i++)await new Promise(setImmediate);};
test('RPC panel is lazy, does not use browser storage, clears secrets after save and preserves other settings',async()=>{
 const{window,document}=parseHTML('<body><div class="wallet-content"></div></body>');let owner='a',switched=0;const calls=[];
 vm.runInContext(source,vm.createContext({window,document}));const view=window.createRpcSettingsView({getOwner:()=>owner,onSwitch:()=>switched++,api:async(path,body)=>{calls.push({path,body});return path.endsWith('/test')?{chainId:56,blockNumber:100,latencyMs:5}:{mode:body?.mode||'default',host:'rpc.example.com',latencyMs:5};}});view.update();assert.equal(calls.length,0);
 const panel=document.getElementById('rpc-settings');panel.open=true;panel.dispatchEvent(new window.Event('toggle'));await flush();assert.equal(calls[0].path,'/api/settings/rpc?refresh=1');
 const mode=document.getElementById('rpc-mode');for(const o of mode.children)o.selected=o.value==='custom';mode.dispatchEvent(new window.Event('change'));
 const input=document.getElementById('rpc-http-url');input.value='https://rpc.example.com/private-key';input.dispatchEvent(new window.Event('input'));
 document.getElementById('rpc-test').dispatchEvent(new window.Event('click'));await flush();assert.equal(switched,0);assert.equal(calls.at(-1).path,'/api/settings/rpc/test');
 document.getElementById('rpc-save').dispatchEvent(new window.Event('click'));await flush();assert.equal(switched,1);assert.equal(input.value,'');assert.doesNotMatch(document.body.textContent,/private-key/);
 input.value='another-secret';owner='b';view.update();assert.equal(input.value,'');view.clear();assert.equal(document.getElementById('rpc-save').disabled,true);
 assert.doesNotMatch(source,/localStorage|sessionStorage|\/api\/order\b|\/api\/execute\b|\/api\/settings\/execution/);
});
