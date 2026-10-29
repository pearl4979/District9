import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {parseHTML} from 'linkedom';
const source=await readFile(new URL('../public/trade-approvals.js',import.meta.url),'utf8'),flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
test('automatic continuation has independent default-off consent; toggling it does not enable post-buy approval',async()=>{
 const{window,document}=parseHTML('<body><div class="wallet-content"></div></body>'),calls=[];let enabled=false,automaticSetup=false;
 vm.runInContext(source,vm.createContext({window,document}));const ui=window.createTradeApprovals({getOwner:()=> 'owner',isLive:()=>true,api:async(path,body)=>{calls.push({path,body});if(body){enabled=body.enabled??enabled;automaticSetup=body.automaticSetup??automaticSetup;}return{enabled,automaticSetup,approvals:[]};}});ui.update();
 const toggles=document.querySelectorAll('input');assert.equal(toggles.length,2);assert.equal(toggles[0].checked,false);assert.equal(toggles[1].checked,false);
 toggles[1].checked=true;toggles[1].dispatchEvent(new window.Event('change'));await flush();assert.equal(calls.at(-1).body.automaticSetup,true);assert.equal(enabled,false);assert.equal(toggles[0].checked,false);assert.equal(toggles[1].checked,true);ui.clear();assert.equal(toggles[1].checked,false);
});
