import test from 'node:test';import assert from 'node:assert/strict';import{selectGangCandidates}from'../src/gang.mjs';
const row=(n,extra={})=>({address:`0x${n.toString(16).padStart(40,'0')}`,createdAt:2000+n,...extra});
test('older graduated Gang markets cannot be displaced by the newest 160 launches',()=>{
 const recent=Array.from({length:200},(_,i)=>row(i+1));
 const graduated=[row(500,{createdAt:1,graduated:true,graduatedAt:5000}),row(501,{createdAt:2,graduated:true,graduatedAt:4000})];
 const progress=[row(600,{createdAt:3,progressPct:95})];
 const selected=selectGangCandidates({recent,graduated,progress});assert.equal(selected.length,160);
 for(const r of [...graduated,...progress,recent.at(-1)])assert.ok(selected.some(s=>s.address===r.address));
 assert.equal(new Set(selected.map(s=>s.address)).size,160);
});
