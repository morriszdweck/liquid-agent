import { describe, it, expect } from "vitest";
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

// Migrated from scripts/rust-media-tools-check.mjs. The checks throw on failure; vitest reports each one.

describe("Rust media tools with fixtures", () => {
  it("Rust media tools with fixtures", async () => {
    const repo=fileURLToPath(new URL("../..", import.meta.url)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'liquid-media-')),data=path.join(dir,'data'),dist=path.join(dir,'dist'),bin=path.join(dir,'bin'),tmp=path.join(dir,'tmp');
    fs.mkdirSync(dist);fs.writeFileSync(path.join(dist,'index.html'),'<head></head>');fs.mkdirSync(bin);fs.mkdirSync(tmp);fs.mkdirSync(path.join(data,'engine'),{recursive:true});fs.mkdirSync(path.join(data,'models'));for(const file of ['LFM3-1.7B-Q4_K_M.gguf','LFM3-Omni-2B-Q4_K_M.gguf','mmproj-LFM3-Omni-2B-Q8_0.gguf'])fs.writeFileSync(path.join(data,'models',file),'fixture');
    const picture=path.join(dir,'fixture.png'),audio=path.join(dir,'fixture.wav'),marker=path.join(dir,'use-portal'),portalToken=path.join(dir,'portal-token'),modelLog=path.join(dir,'omni-request.json'),slow=path.join(dir,'slow'),started=path.join(dir,'screenshot-started');fs.writeFileSync(picture,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));fs.writeFileSync(audio,Buffer.from('RIFFtestWAVE'));
    const screenshot=`#!${process.execPath}\nconst fs=require('fs');if(fs.existsSync(${JSON.stringify(slow)})){fs.writeFileSync(${JSON.stringify(started)},'started');return setTimeout(()=>fs.copyFileSync(${JSON.stringify(picture)},process.argv.at(-1)),5000);}if(fs.existsSync(${JSON.stringify(marker)}))process.exit(1);fs.copyFileSync(${JSON.stringify(picture)},process.argv.at(-1));\n`;for(const cmd of ['screencapture','import','scrot','maim','gnome-screenshot','spectacle','grim'])fs.writeFileSync(path.join(bin,cmd),screenshot,{mode:0o755});
    const convert=`#!${process.execPath}\nconst fs=require('fs');fs.copyFileSync(${JSON.stringify(picture)},process.argv.at(-1));\n`;for(const cmd of ['sips','magick','convert'])fs.writeFileSync(path.join(bin,cmd),convert,{mode:0o755});
    const wav=`#!${process.execPath}\nrequire('fs').copyFileSync(${JSON.stringify(audio)},process.argv.at(-1));\n`;for(const cmd of ['afconvert','ffmpeg'])fs.writeFileSync(path.join(bin,cmd),wav,{mode:0o755});
    fs.writeFileSync(path.join(bin,'gdbus'),`#!${process.execPath}\nconst fs=require('fs'),args=process.argv.slice(2),tokenFile=${JSON.stringify(portalToken)};if(args[0]==='call'){const token=args.at(-1).match(/liquid[0-9a-f]+/)?.[0];fs.writeFileSync(tokenFile,token);process.exit(0);}const poll=setInterval(()=>{if(fs.existsSync(tokenFile)){const token=fs.readFileSync(tokenFile,'utf8');process.stdout.write('/org/freedesktop/portal/desktop/request/1/'+token+": org.freedesktop.portal.Request.Response (uint32 0, {'uri': <'${pathToFileURL(picture).href}'>})\\n");clearInterval(poll);}},20);\n`,{mode:0o755});
    const engine=path.join(data,'engine','llama-server');fs.writeFileSync(engine,`#!${process.execPath}
    const http=require('http'),fs=require('fs'),i=process.argv.indexOf('--port');const omni=process.argv.includes('LFM3-Omni-2B');if(omni&&fs.existsSync(${JSON.stringify(path.join(dir,'slow-omni'))})){setTimeout(()=>process.exit(1),3000);return;}http.createServer((q,s)=>{if(q.method==='GET')return s.end('{}');let body='';q.on('data',c=>body+=c);q.on('end',()=>{const messages=JSON.parse(body).messages,request=messages.find(m=>m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('describe media test '))?.content,has=messages.some(m=>m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('[result]'));let call='';if(omni && !request)fs.writeFileSync(${JSON.stringify(modelLog)},body);if(!has){if(request==='describe media test image')call='<function=look_at_image><parameter=path>${picture}</parameter><parameter=question>What is this?</parameter></function>';if(request==='describe media test screen')call='<function=look_at_screen><parameter=question>What is on screen?</parameter></function>';if(request==='describe media test audio')call='<function=transcribe_audio><parameter=path>${audio}</parameter></function>';}const content=call?'<tool_call>'+call+'</tool_call>':omni?'Omni fixture result':'done';s.writeHead(200,{'content-type':'text/event-stream'});const send=()=>s.end('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\\n\\ndata: [DONE]\\n\\n');if(!omni && body.includes('please wait'))return setTimeout(send,3000);send();});}).listen(Number(process.argv[i+1]),'127.0.0.1');\n`,{mode:0o755});
    async function free(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}const port=await free(),small=await free(),omni=await free(),base=`http://127.0.0.1:${port}`,sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const env={...process.env,LIQUID_AGENT_NO_AUTOSTART:"1",LIQUID_AGENT_GPU:'vulkan',PATH:`${bin}:${process.env.PATH}`,DISPLAY:':test',WAYLAND_DISPLAY:'',TMPDIR:tmp,LIQUID_AGENT_RUST_HOME:data,LIQUID_AGENT_WEB_DIST:dist,LIQUID_AGENT_RUST_PORT:String(port),LIQUID_AGENT_SMALL_PORT:String(small),LIQUID_AGENT_OMNI_PORT:String(omni)};let app,ws,token='';const check=(ok,msg)=>{if(!ok)throw Error(msg);console.log(`✓ ${msg}`);};
    async function api(route,method='GET',body){const r=await fetch(base+route,{method,headers:{'x-liquid-token':token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!r.ok)throw Error(`${route}: ${r.status} ${await r.text()}`);return r.json();}
    function event(predicate){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.off('message',on);reject(Error('Timed out waiting for media action'));},15000);function on(raw){const e=JSON.parse(raw.toString());if(predicate(e)){clearTimeout(timer);ws.off('message',on);resolve(e);}}ws.on('message',on);});}
    async function act(name,approve){const pending=event(e=>e.type==='chat'&&e.chat.messages?.at(-1)?.steps?.some(s=>s.status==='approval'));const chat=await api('/api/chats','POST',{text:`describe media test ${name}`});const step=(await pending).chat.messages.at(-1).steps.find(s=>s.status==='approval');const done=event(e=>e.type==='chat'&&e.chat.id===chat.id&&e.chat.messages.at(-1)?.status==='done');await api(`/api/approvals/${step.id}`,'POST',{approve});return (await done).chat;}
    try {
     app=spawn(path.join(repo,'target/debug/liquid-server'),[],{env,stdio:['ignore','pipe','pipe']});let stderr='';app.stderr.on('data',d=>stderr+=d);for(let i=0;i<100;i++){try{const html=await(await fetch(base)).text();token=html.match(/name="liquid-token" content="([^"]+)"/)?.[1]||'';if(token)break;}catch{}await sleep(100);}if(!token)throw Error(stderr);
     ws=new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`,{origin:base});await once(ws,'open');await api('/api/settings','PATCH',{smallURL:`http://127.0.0.1:${small}/v1`,omniURL:`http://127.0.0.1:${omni}/v1`,startupMode:'hybrid',gpuLayers:16});await api('/api/parts/small/start','POST');for(let i=0;i<100;i++){const parts=(await api('/api/state')).parts;if(parts.find(p=>p.id==='small').status==='running')break;await sleep(100);}
     let chat=await act('image',false);check(chat.messages.at(-1).steps[0].status==='denied'&&!fs.existsSync(modelLog) && (await api('/api/state')).parts.find(p=>p.id==='omni').status==='installed','Denied image inspection does not start or contact Omni');
     const cancelOther=await api('/api/chats','POST',{text:'please wait'});
     const cancelOtherDone=event(e=>e.type==='chat'&&e.chat.id===cancelOther.id&&e.chat.messages.at(-1)?.status==='done');
     const cancelApproval=event(e=>e.type==='chat'&&e.chat.messages?.at(-1)?.steps?.some(s=>s.status==='approval'));
     const cancelChat=await api('/api/chats','POST',{text:'describe media test image'});
     const cancelStep=(await cancelApproval).chat.messages.at(-1).steps.find(s=>s.status==='approval');
     await api(`/api/approvals/${cancelStep.id}`,'POST',{approve:true}); await sleep(200);
     const cancelDone=event(e=>e.type==='chat'&&e.chat.id===cancelChat.id&&e.chat.messages.at(-1)?.status==='stopped');
     await api(`/api/chats/${cancelChat.id}/stop`,'POST'); await cancelDone; await cancelOtherDone;
     check((await api('/api/state')).parts.find(p=>p.id==='omni').status==='installed','Cancelling a waiting hybrid tool prevents the model switch');
     await api(`/api/chats/${cancelChat.id}`,'DELETE'); await api(`/api/chats/${cancelOther.id}`,'DELETE');
     fs.writeFileSync(path.join(dir,'slow-omni'),'');
     const warmApproval=event(e=>e.type==='chat'&&e.chat.messages?.at(-1)?.steps?.some(s=>s.status==='approval'));
     const warmChat=await api('/api/chats','POST',{text:'describe media test image'});
     const warmStep=(await warmApproval).chat.messages.at(-1).steps.find(s=>s.status==='approval');
     await api(`/api/approvals/${warmStep.id}`,'POST',{approve:true});
     let warmState;for(let i=0;i<100;i++){warmState=await api('/api/state');if(warmState.parts.find(p=>p.id==='omni').status==='starting')break;await sleep(50);}
     check(warmState.parts.find(p=>p.id==='omni').status==='starting'&&warmState.parts.find(p=>p.id==='small').status==='installed','Omni warmup begins after text is evicted');
     const warmStopped=event(e=>e.type==='chat'&&e.chat.id===warmChat.id&&e.chat.messages.at(-1)?.status==='stopped');
     const cancelStart=Date.now();await api(`/api/chats/${warmChat.id}/stop`,'POST');await warmStopped;
     check(Date.now()-cancelStart<2000,'Cancellation returns before the slow Omni warmup fails');
     for(let i=0;i<150;i++){warmState=await api('/api/state');if(warmState.parts.find(p=>p.id==='small').status==='running')break;await sleep(50);}
     check(warmState.parts.find(p=>p.id==='small').status==='running','Text model recovers after a cancelled Omni warmup fails');
     fs.unlinkSync(path.join(dir,'slow-omni'));await api(`/api/chats/${warmChat.id}`,'DELETE');
     ws.terminate();const oldExit=once(app,'exit');app.kill('SIGINT');await oldExit;
     app=spawn(path.join(repo,'target/debug/liquid-server'),[],{env,stdio:['ignore','pipe','pipe']});app.stderr.on('data',d=>stderr+=d);token='';
     for(let i=0;i<100;i++){try{const html=await(await fetch(base)).text();token=html.match(/name="liquid-token" content="([^"]+)"/)?.[1]||'';if(token)break;}catch{}await sleep(100);}if(!token)throw Error(stderr);
     ws=new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`,{origin:base});await once(ws,'open');await api('/api/parts/small/start','POST');
     for(let i=0;i<100;i++){if((await api('/api/state')).parts.find(p=>p.id==='small').status==='running')break;await sleep(100);}
     const otherChat=await api('/api/chats','POST',{text:'please wait'});
     const hybridApproval=event(e=>e.type==='chat'&&e.chat.messages?.at(-1)?.steps?.some(s=>s.status==='approval'));
     const hybridChat=await api('/api/chats','POST',{text:'describe media test image'});
     const hybridStep=(await hybridApproval).chat.messages.at(-1).steps.find(s=>s.status==='approval');
     const hybridDone=event(e=>e.type==='chat'&&e.chat.id===hybridChat.id&&e.chat.messages.at(-1)?.status==='done');
     await api(`/api/approvals/${hybridStep.id}`,'POST',{approve:true}); await sleep(300);
     const busyState=await api('/api/state');
     check(busyState.parts.find(p=>p.id==='small').status==='running' && busyState.chats.find(c=>c.id===otherChat.id).messages.at(-1).status==='streaming','Hybrid tool handoff waits for another active text chat');
     chat=(await hybridDone).chat; await api(`/api/chats/${otherChat.id}`,'DELETE');
     let request=JSON.parse(fs.readFileSync(modelLog,'utf8'));check(chat.messages.at(-1).steps[0].result==='Omni fixture result' && request.messages[0].content.some(c=>c.type==='image_url'&&c.image_url.url.startsWith('data:image/jpeg;base64,')) && request.messages[0].content.some(c=>c.text==='What is this?'),'Rust image tool sends converted image and question to Omni');check(chat.messages.at(-1).model==='omni' && (await api('/api/state')).parts.find(p=>p.id==='small').status==='installed','Approved hybrid image action switches to Omni and continues the reply');
     chat=await act('audio',true);request=JSON.parse(fs.readFileSync(modelLog,'utf8'));check(chat.messages.at(-1).steps[0].result==='Omni fixture result' && request.messages[1].content[0].input_audio.format==='wav','Rust audio tool converts and transcribes a file');
     chat=await act('screen',true);request=JSON.parse(fs.readFileSync(modelLog,'utf8'));check(chat.messages.at(-1).steps[0].status==='done' && request.messages[0].content.some(c=>c.text==='What is on screen?'),'Rust screen tool captures and describes the screen');
     if(process.platform!=='darwin'){fs.writeFileSync(marker,'');chat=await act('screen',true);check(chat.messages.at(-1).steps[0].status==='done' && fs.existsSync(portalToken),'Rust screen tool falls back to the desktop portal');}
     fs.writeFileSync(slow,'');const pending=event(e=>e.type==='chat'&&e.chat.messages?.at(-1)?.steps?.some(s=>s.status==='approval'));const slowChat=await api('/api/chats','POST',{text:'describe media test screen'});const step=(await pending).chat.messages.at(-1).steps.find(s=>s.status==='approval');await api(`/api/approvals/${step.id}`,'POST',{approve:true});for(let i=0;i<100&&!fs.existsSync(started);i++)await sleep(20);check(fs.existsSync(started),'Screenshot fixture started');const stopped=event(e=>e.type==='chat'&&e.chat.id===slowChat.id&&e.chat.messages?.at(-1)?.status==='stopped');await api(`/api/chats/${slowChat.id}/stop`,'POST');await stopped;for(let i=0;i<100&&fs.readdirSync(tmp).length;i++)await sleep(20);check(fs.readdirSync(tmp).length===0,'Stopping screenshot capture removes its temporary files');
     check(fs.readdirSync(tmp).length===0,'Temporary media files are removed after actions');
    }finally{if(ws)ws.terminate();if(app){const exit=once(app,'exit');app.kill('SIGINT');await exit;}fs.rmSync(dir,{recursive:true,force:true});}
  }, 600_000);
});
