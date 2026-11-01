// Check Rust startup against installed, disposable model files.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=fileURLToPath(new URL('..',import.meta.url)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'liquid-autostart-')),data=path.join(dir,'data'),dist=path.join(dir,'dist');
fs.mkdirSync(dist);fs.writeFileSync(path.join(dist,'index.html'),'<head></head>');fs.mkdirSync(path.join(data,'engine'),{recursive:true});fs.mkdirSync(path.join(data,'models'));fs.writeFileSync(path.join(data,'models','LFM3-1.7B-Q4_K_M.gguf'),'fixture');
const engine=path.join(data,'engine','llama-server');fs.writeFileSync(engine,`#!${process.execPath}\nconst http=require('http'),i=process.argv.indexOf('--port');http.createServer((q,s)=>s.end('{}')).listen(Number(process.argv[i+1]),'127.0.0.1');\n`,{mode:0o755});
async function free(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}const port=await free(),modelPort=await free(),base=`http://127.0.0.1:${port}`,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const env={...process.env,LIQUID_AGENT_RUST_HOME:data,LIQUID_AGENT_WEB_DIST:dist,LIQUID_AGENT_RUST_PORT:String(port),LIQUID_AGENT_SMALL_PORT:String(modelPort),LIQUID_AGENT_GPU:'cpu'};delete env.LIQUID_AGENT_NO_AUTOSTART;let app;const check=(ok,msg)=>{if(!ok)throw Error(msg);console.log(`✓ ${msg}`);};
try {app=spawn(path.join(repo,'target/debug/liquid-server'),[],{env,stdio:['ignore','pipe','pipe']});let stderr='';app.stderr.on('data',d=>stderr+=d);let token='';for(let i=0;i<100;i++){try{const html=await(await fetch(base)).text();token=html.match(/name="liquid-token" content="([^"]+)"/)?.[1]||'';if(token)break;}catch{}await sleep(100);}if(!token)throw Error(stderr);let state;for(let i=0;i<100;i++){state=await(await fetch(`${base}/api/state`,{headers:{'x-liquid-token':token}})).json();if(state.parts.find(p=>p.id==='small').status==='running')break;await sleep(100);}const small=state.parts.find(p=>p.id==='small'),omni=state.parts.find(p=>p.id==='omni');check(small.status==='running','Installed model starts automatically');check(small.quant==='Q4_K_M'&&small.quants.length===6&&small.quants.find(q=>q.id==='Q4_K_M').onDisk&&omni.quants.length===4,'Built-in model sizes and installed variants appear in state');check(state.machine.memoryGB>0&&state.machine.gpu==='cpu','Machine memory and selected engine flavor appear in state');
}finally{if(app){const exit=once(app,'exit');app.kill('SIGINT');await exit;}fs.rmSync(dir,{recursive:true,force:true});}
