import {keccak256,id,toBeHex} from 'ethers';
import {check,readContract,same} from './market-utils.mjs';

const GANG='0x0c6302401aa5325c2e36f170f52c00b1d220b405';
const BEACON='0x156d6dce9a4f6139a3406f1f021f1a4880de93a3';
const IMPLEMENTATION='0xcfed6c4679297ea4889f8183bc057b4a86c64e46';
const STOCKS=new Map([
 ['0x02fca66c1d1afb4e2a7884261eb00f63598a7436','NVDAB'],
 ['0x205812cdbed920aff76c6580abd681a46d11efc7','QQQB'],
 ['0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1','SPCXB'],
 ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f','BNCB'],
]);
const HASH={
 gang:'0x14efef69f6d88d506c0b07168d6aaeaa6b536dffa6e0545a0fc83bf8ad9fd6b7',
 proxy:'0xdf946913977a2ed76735b4b2e66f2272d1a76af911c4e520655888c9e32269f9',
 beacon:'0x80fbad22136c0abdce6e0f3cc46cd0572318e01b92dbd5b4d5795ef6e8808711',
 implementation:'0x060dc28d4dd8d9bb8a381d4009bccbac129ce743a10b3d8aa0ffef5034b50544',
};
const FXION='0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1';
const ONDO={
 beacon:'0xc046b05a920e4b412815934dd8e58904dda73315',
 implementation:'0x578f397ca4661d1db4d9a65065d6b284a1a850fd',
 proxyHash:'0x439923c85f956f038ae77871736f789e6d08d22257b6e5fdccfdc83924ecb4d0',
 beaconHash:'0x90d14c8f8d7d3468b5215829b587058c5e7f78acaef6b946c20caa3de92bf410',
 implementationHash:'0x85d44c72e84a34f0b4a3bceca35289b10bd0c5510c5a441466a755e903edc36a',
};
const BEACON_SLOT=toBeHex(BigInt(id('eip1967.proxy.beacon'))-1n,32);

// Trust is address + executable source + current bytecode, never a token symbol.
// GANG: source-matched LaunchToken/OZ5.1; locked transfers must be released.
// Stocks: exact-match SecuritiesToken/OZ ERC20 raw balances. ERC8056 UI
// multipliers affect display only. Compliance/pause checks can still revert;
// every actual transaction must be simulated separately. Recheck beacon/code
// at every quote and execution: no permanent trust across issuer upgrades.
export async function verifiedQuoteAsset({provider,address,blockTag,read=readContract}={}){
 const key=typeof address==='string'?address.toLowerCase():'';
 check(key===GANG||key===FXION||STOCKS.has(key),'底币转账语义未核验，暂不支持自动兑换');
 check(Number.isSafeInteger(blockTag)&&blockTag>0,'底币核验缺少固定区块');
 check((await provider.getNetwork()).chainId===56n,'底币核验必须使用 BSC 主网');
 const code=await provider.getCode(address,blockTag),expected=key===GANG?HASH.gang:key===FXION?ONDO.proxyHash:HASH.proxy;
 check(code!=='0x'&&keccak256(code)===expected,'底币代码已经改变，暂停交易并重新核验');
 const decimals=Number(await read(provider,address,['function decimals() view returns(uint8)'],'decimals',[],blockTag));
 check(decimals===18,'底币精度与已核验源码不一致');
 if(key===FXION){
  // Source-matched GMToken uses raw OZ ERC20 transfers. Its compliance and
  // pause hooks can reject transfers; each actual route step still simulates.
  const [beaconSlot,beaconCode,implementation]=await Promise.all([
   provider.getStorage(address,BEACON_SLOT,blockTag),provider.getCode(ONDO.beacon,blockTag),
   read(provider,ONDO.beacon,['function implementation() view returns(address)'],'implementation',[],blockTag),
  ]);
  check(typeof beaconSlot==='string'&&beaconSlot.toLowerCase()==='0x'+ONDO.beacon.slice(2).padStart(64,'0'),'FXIon 底币 Beacon 已改变，暂停交易');
  check(keccak256(beaconCode)===ONDO.beaconHash&&same(implementation,ONDO.implementation),'FXIon Beacon 或实现已升级，暂停交易');
  check(keccak256(await provider.getCode(ONDO.implementation,blockTag))===ONDO.implementationHash,'FXIon 实现代码已改变，暂停交易');
  return{verified:true,address,symbol:'FXIon',decimals,codeHash:expected,rawTransferTaxBps:0,upgradeable:true,beacon:ONDO.beacon,implementation:ONDO.implementation,source:'sourcify-executable-match',blockTag,warnings:['发行方可暂停、限制地址或升级底币；每一步仍需重新模拟。']};
 }
 if(key===GANG){
  check(await read(provider,address,['function locked() view returns(bool)'],'locked',[],blockTag)===false,'GANG 底币仍锁定，暂不支持兑换');
  return{verified:true,address,symbol:'GANG',decimals,codeHash:expected,rawTransferTaxBps:0,upgradeable:false,source:'official-source-executable-match',blockTag};
 }
 const [beaconCode,implementation]=await Promise.all([
  provider.getCode(BEACON,blockTag),
  read(provider,BEACON,['function implementation() view returns(address)'],'implementation',[],blockTag),
 ]);
 check(keccak256(beaconCode)===HASH.beacon&&same(implementation,IMPLEMENTATION),'股票底币 Beacon 或实现已升级，暂停交易');
 check(keccak256(await provider.getCode(IMPLEMENTATION,blockTag))===HASH.implementation,'股票底币实现代码已经改变，暂停交易');
 return{verified:true,address,symbol:STOCKS.get(key),decimals,codeHash:expected,rawTransferTaxBps:0,upgradeable:true,beacon:BEACON,implementation:IMPLEMENTATION,source:'sourcify-exact-match',blockTag,warnings:['发行方可暂停、限制地址或升级底币；每一步仍需重新模拟。股票 UI 乘数不参与 ERC20 原始数量计算。']};
}
