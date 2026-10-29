import test from 'node:test';import assert from 'node:assert/strict';
import {createMarketRouter} from '../src/market-hub.mjs';
const A='0x'+'1'.repeat(40),W='0x'+'2'.repeat(40);
test('market router resolves quote/state through verified ownership and forwards internal guards',async()=>{
 const row={address:A,platformId:'gang',verified:true,tradable:true,pad:'merged',launchType:'fair'};const calls=[];
 const adapter={getTokenState:async(t,o)=>{calls.push(o);return row;},quoteTrade:async(i,g)=>{calls.push([i,g]);return{kind:'buy',summary:{}};},buildTrade:async(i,g)=>{calls.push([i,g]);return{kind:'buy',summary:{},transaction:{}};}};
 const p=createMarketRouter({providers:{gang:adapter},snapshot:()=>({tokens:[row]})});
 assert.equal(typeof p.quoteTrade,'function');assert.equal(typeof p.getTokenState,'function');
 const guards={minimumOutputRaw:'42',deadline:123};const input={token:A,platformId:'gang',side:'buy',amount:'1',walletAddress:W,settlement:'quote'};
 await p.getTokenState(A,{platformId:'gang'});await p.quoteTrade(input,guards);await p.buildTrade(input,guards);
 assert.equal(calls[0].hint,row);assert.equal(calls[1][0].market,row);assert.equal(calls[1][1],guards);assert.equal(calls[2][1],guards);
 await assert.rejects(p.quoteTrade({...input,platformId:'four'},guards),/归属/);
});
