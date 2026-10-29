import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
const source=await readFile(new URL('../public/wallet-avatar.js',import.meta.url),'utf8');
function helper(){const {window,document}=parseHTML('<html><body></body></html>');vm.runInContext(source,vm.createContext({window,document}));return{window,document};}
const A='0x'+'a'.repeat(40);
test('supplied default portraits are varied but stable for the same normalized wallet',()=>{
 const{window,document}=helper(),one=window.AgentWalletAvatar.createDefault(A),two=window.AgentWalletAvatar.createDefault(A.toUpperCase());
 assert.equal(one.tagName.toLowerCase(),'img');assert.equal(one.outerHTML,two.outerHTML);assert.notEqual(one,two);assert.match(one.getAttribute('src'),/^\/assets\/wallet-default-[1-6]\.png$/);assert.equal(document.body.children.length,0);
 const paths=Array.from({length:100},(_,i)=>window.AgentWalletAvatar.createDefault('0x'+i.toString(16).padStart(40,'0')).getAttribute('src'));assert.equal(new Set(paths).size,6);
 assert.doesNotMatch(window.AgentWalletAvatar.createDefault('<script>').outerHTML,/<script>|javascript:|onerror=/);
});
test('only a server verified address-matched social image takes priority over a custom avatar',()=>{
 const{window}=helper(),custom='data:image/jpeg;base64,/9j/2Q==',social={status:'verified',address:A,xUrl:'https://x.com/example',avatarPath:'/api/wallet-avatar/'+A};
 assert.equal(typeof window.AgentWalletAvatar.create,'function');
 assert.equal(window.AgentWalletAvatar.create({address:A,avatar:custom,social}).getAttribute('src'),social.avatarPath);
 for(const bad of [{...social,status:'unverified'},{...social,address:'0x'+'b'.repeat(40)},{...social,avatarPath:'https://evil.test/pic'},{...social,xUrl:'javascript:alert(1)'}])assert.equal(window.AgentWalletAvatar.create({address:A,avatar:custom,social:bad}).getAttribute('src'),custom);
 const image=window.AgentWalletAvatar.create({address:A,social});image.dispatchEvent(new window.Event('error'));assert.match(image.getAttribute('src'),/^\/assets\/wallet-default-/);const fallback=image.getAttribute('src');image.dispatchEvent(new window.Event('error'));assert.equal(image.getAttribute('src'),fallback,'fallback cannot loop');
});
