#!/usr/bin/env node
// Read-only public schema probe. No login, wallet adapter, session read or trade.
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

const args=process.argv.slice(2);let duration=8,output=null;
for(let i=0;i<args.length;i++){
 if(args[i]==='--duration'&&/^\d+$/.test(args[i+1]??'')){duration=Number(args[++i]);continue;}
 if(args[i]==='--output'&&args[i+1]){output=resolve(args[++i]);continue;}
 throw Error('Usage: node scripts/probe-binance-signals.mjs [--duration 1..30] [--output <json>]');
}
if(!Number.isSafeInteger(duration)||duration<1||duration>30)throw Error('Probe duration must be 1..30 seconds');
const cli=fileURLToPath(new URL('../node_modules/@binance/agentic-wallet/dist/index.js',import.meta.url));
const version=JSON.parse(readFileSync(new URL('../node_modules/@binance/agentic-wallet/package.json',import.meta.url),'utf8')).version;
if(version!=='1.11.0')throw Error('This schema probe is scoped to installed CLI 1.11.0; no dependencies were changed');
const root=mkdtempSync(join(tmpdir(),'district9-binance-probe-'));const home=join(root,'home'),state=join(root,'state');mkdirSync(home,{mode:0o700});mkdirSync(state,{mode:0o700});
const evidence={startedAt:new Date().toISOString(),cliVersion:version,nodeVersion:process.version,scope:'Public BSC indexer transport/schema only; no receipt validation or complete protocol coverage claim',command:`node <installed-cli> tracker ws --wallet BSC --duration ${duration} --json`,isolatedHome:true,isolatedState:true,initialHomeEntries:readdirSync(home).length,initialStateEntries:readdirSync(state).length,envKeys:['HOME','BINANCE_BAW_DIR','PATH','LANG'],maxStdoutBytes:524288,maxLineBytes:65536,maxSamples:3,stdoutBytes:0,stderrBytes:0,pushes:0,malformedLines:0,streams:[],samples:[],redaction:'Only public canonical identity, upstream logId, time, side and numeric fields retained. Labels, groups, links, metadata, raw errors, temporary paths and all environment values omitted.'};
const streamSet=new Set();const decoder=new StringDecoder('utf8');let buffer='',child,deadline,killTimer,closing=false;
function halt(reason){if(closing)return;closing=true;evidence.stopReason=reason;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),500);}
const onSignal=()=>halt('parent-signal');process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
try{
 child=spawn(process.execPath,[cli,'tracker','ws','--wallet','BSC','--duration',String(duration),'--json'],{cwd:home,env:{HOME:home,BINANCE_BAW_DIR:state,PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,LANG:'C.UTF-8'},shell:false,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>{
  evidence.stdoutBytes+=chunk.length;if(evidence.stdoutBytes>evidence.maxStdoutBytes){halt('stdout-byte-limit');return;}
  buffer+=decoder.write(chunk);
  for(let nl;(nl=buffer.indexOf('\n'))!==-1;){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);if(Buffer.byteLength(line)>evidence.maxLineBytes){halt('line-byte-limit');return;}
   let frame;try{frame=JSON.parse(line);}catch{evidence.malformedLines++;continue;}
   if(frame?.stream==='w3w@tracker@wallet@BSC'&&frame.data&&typeof frame.data==='object'){
    evidence.pushes++;streamSet.add(frame.stream);
    if(evidence.samples.length<evidence.maxSamples){
     const data={};for(const key of ['chainId','address','ca','txHash','logId','ts','tradeSideCategory','txUsdValue','tokenPrice','txNativeTokenQty','nativePrice','currentPrice','marketCap']){const value=frame.data[key];if(value===null||['string','number','boolean'].includes(typeof value))data[key]=typeof value==='string'?value.slice(0,200):value;}
     evidence.samples.push({stream:frame.stream,data});
    }
   }
  }
  if(Buffer.byteLength(buffer)>evidence.maxLineBytes){buffer='';halt('line-byte-limit');}
 });
 child.stderr.on('data',chunk=>{evidence.stderrBytes+=chunk.length;if(evidence.stderrBytes>65536)halt('stderr-byte-limit');});
 child.on('error',()=>{evidence.transportError=true;});
 deadline=setTimeout(()=>halt('external-deadline'),(duration+5)*1000);
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>{evidence.exitCode=code;evidence.signal=signal;resolve();}));
 // Optional supervisor acknowledgement: signal handlers and child cleanup are
 // installed before a parent may request cancellation. Never infer readiness
 // from temporary-directory creation, which happens earlier during startup.
 if(process.connected)process.send({type:'binance-public-probe-ready'},()=>{});
 await closed;
 evidence.stopReason??='process-exit';
}finally{
 clearTimeout(deadline);clearTimeout(killTimer);if(process.connected)process.disconnect();process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);evidence.finalHomeEntries=readdirSync(home).length;evidence.finalStateEntries=readdirSync(state).length;rmSync(root,{recursive:true,force:true});evidence.cleanedUp=true;
}
evidence.streams=[...streamSet];evidence.finishedAt=new Date().toISOString();evidence.observation=evidence.pushes?'Public BSC pushes observed; individual trades remain indexer observations until independently confirmed.':'No public push observed during this bounded window; this does not establish absence of trades or protocol coverage.';
const text=JSON.stringify(evidence,null,2)+'\n';if(output)writeFileSync(output,text,{mode:0o600});process.stdout.write(text);
