import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// Migrated from scripts/rust-voice-check.mjs. The checks throw on failure; vitest reports each one.

describe("Rust realtime voice bridge", () => {
  it("Rust realtime voice bridge", async () => {
    const require=createRequire(import.meta.url), wsPath=require.resolve("ws"), repo=fileURLToPath(new URL("../..", import.meta.url));
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"liquid-voice-")),data=path.join(dir,"data"),dist=path.join(dir,"dist");fs.mkdirSync(dist);fs.writeFileSync(path.join(dist,"index.html"),"<head></head>");fs.mkdirSync(path.join(data,"engine"),{recursive:true});fs.mkdirSync(path.join(data,"models"));for(const file of ["LFM3-Omni-2B-Q4_K_M.gguf","mmproj-LFM3-Omni-2B-Q8_0.gguf"])fs.writeFileSync(path.join(data,"models",file),"fixture");
    const model=path.join(data,"engine","llama-server");fs.writeFileSync(model,`#!${process.execPath}
    const http=require('http'),fs=require('fs'),{WebSocketServer}=require(${JSON.stringify(wsPath)});
    const i=process.argv.indexOf('--port'),port=Number(process.argv[i+1]);const log=${JSON.stringify(path.join(dir,"events.log"))};fs.writeFileSync(${JSON.stringify(path.join(dir,"model-args.json"))},JSON.stringify(process.argv));
    const server=http.createServer((q,s)=>{if(q.method==='GET')return s.end('{"ok":true}');let body='';q.on('data',c=>body+=c);q.on('end',()=>{if(q.url==='/tts'){fs.appendFileSync(log,JSON.stringify({type:'tts',body:JSON.parse(body)})+'\\n');const wav=Buffer.alloc(48);wav.write('RIFF',0);wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);wav.writeInt16LE(1000,44);wav.writeInt16LE(-1000,46);s.writeHead(200,{'content-type':'audio/wav'});return s.end(wav);}if(body.includes('input_audio'))fs.appendFileSync(log,JSON.stringify({type:'asr',prompt:JSON.parse(body).messages?.[0]?.content})+'\\n');if(body.includes('image_url')){s.writeHead(200,{'content-type':'application/json'});return s.end(JSON.stringify({choices:[{message:{content:'a blue cup'}}]}));}s.writeHead(200,{'content-type':'text/event-stream'});s.end('data: '+JSON.stringify({choices:[{delta:{content:'heard words'}}]})+'\\n\\ndata: [DONE]\\n\\n');});});
    const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws)));wss.on('connection',ws=>{let tool=false,hold=false;ws.send(JSON.stringify({type:'session.created',session:{audio:{input:{format:{rate:16000}},output:{format:{rate:24000}}}}}));ws.on('message',data=>{const msg=JSON.parse(data.toString());fs.appendFileSync(log,JSON.stringify(msg)+'\\n');if(msg.type==='session.update'&&!fs.existsSync(${JSON.stringify(path.join(dir,"no-ack"))})){if(fs.existsSync(${JSON.stringify(path.join(dir,"reject-tools"))})&&msg.session.tools)ws.send(JSON.stringify({type:'error',error:{message:'unsupported tools'}}));else ws.send(JSON.stringify({type:'session.updated',session:msg.session}));}if(msg.type==='conversation.item.create' && msg.item?.content?.[0]?.text?.includes('use memory'))tool=true;if(msg.type==='conversation.item.create' && msg.item?.content?.[0]?.text?.includes('hold response'))hold=true;if(msg.type==='conversation.item.create' && msg.item?.type==='function_call_output')tool=false;if(msg.type==='response.create'){if(hold){hold=false;return;}if(tool){ws.send(JSON.stringify({type:'response.function_call_arguments.done',name:'remember',call_id:'tool-1',arguments:JSON.stringify({fact:'voice fixture fact'})}));}else{ws.send(JSON.stringify({type:'response.output_text.delta',delta:'Hello voice'}));ws.send(JSON.stringify({type:'response.output_audio.delta',delta:Buffer.from([1,2,3,4]).toString('base64')}));}ws.send(JSON.stringify({type:'response.done',response:{status:'completed'}}));}if(msg.type==='response.cancel')ws.send(JSON.stringify({type:'response.done',response:{status:'cancelled'}}));});});server.listen(port,'127.0.0.1');
    `,{mode:0o755});
    async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}const port=await freePort(),omniPort=await freePort(),base=`http://127.0.0.1:${port}`;
    const env={...process.env,LIQUID_AGENT_NO_AUTOSTART:"1",LIQUID_AGENT_RUST_HOME:data,LIQUID_AGENT_WEB_DIST:dist,LIQUID_AGENT_RUST_PORT:String(port),LIQUID_AGENT_OMNI_PORT:String(omniPort)};
    let app,voice; const sleep=ms=>new Promise(r=>setTimeout(r,ms));function check(ok,msg){if(!ok)throw new Error(msg);console.log(`✓ ${msg}`);}let token='';
    async function api(route,method='GET',body){const res=await fetch(base+route,{method,headers:{'x-liquid-token':token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!res.ok)throw Error(`${route}: ${res.status} ${await res.text()}`);return res.json();}
    function next(ws,predicate){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.off('message',onMessage);reject(Error('voice event timed out'));},10000);function onMessage(data,binary){let value=binary?data:JSON.parse(data);if(predicate(value,binary)){clearTimeout(timer);ws.off('message',onMessage);resolve(value);}}ws.on('message',onMessage);});}
    try {
     app=spawn(path.join(repo,'target/debug/liquid-server'),[],{env,stdio:['ignore','pipe','pipe']});let log='';app.stderr.on('data',d=>log+=d);for(let i=0;i<100;i++){try{const html=await(await fetch(base)).text();token=html.match(/name="liquid-token" content="([^"]+)"/)?.[1]||'';if(token)break;}catch{}await sleep(100);}if(!token)throw Error(log);
     await api('/api/settings','PATCH',{omniURL:`http://127.0.0.1:${omniPort}/v1`,realtimeLanguage:"es",ttsLanguage:"pt",language:"en",startupMode:"single-omni",omniSlots:2});
     check((await api('/api/state')).parts.find(p=>p.id==='omni').onDemand===true,'Voice can start with Omni unloaded in single-Omni mode');
     const rejected=await new Promise((resolve,reject)=>{const bad=new WebSocket(`ws://127.0.0.1:${port}/voice?t=${token}`,{origin:'https://evil.example'});bad.on('unexpected-response',(_,r)=>{resolve(r.statusCode);r.resume();});bad.on('open',()=>reject(Error('foreign origin accepted')));bad.on('error',reject);});check(rejected===401,'Voice WebSocket rejects foreign origins');
     voice=new WebSocket(`ws://127.0.0.1:${port}/voice?t=${token}`,{origin:base});await once(voice,'open');let ready=next(voice,v=>v.type==='ready');voice.send(JSON.stringify({type:'start'}));const session=await ready;check(session.inputRate===16000&&session.outputRate===24000&&session.cameraAvailable===true&&session.configurationConfirmed===true&&session.voiceSupported===false,'Two-slot voice session confirms instructions and reports unsupported voice selection');
     const args=JSON.parse(fs.readFileSync(path.join(dir,'model-args.json'),'utf8'));check(args[args.indexOf('-np')+1]==='2','Omni launches with the selected two slots');
     const capabilities=await api('/api/capabilities/omni','POST');check(capabilities.spanishWav && capabilities.realtimeHandshake,'Capability check detects a WAV response and realtime session handshake');
     for(let i=0;i<50 && !fs.existsSync(path.join(dir,'events.log'));i++) await sleep(20);
     const update=fs.readFileSync(path.join(dir,'events.log'),'utf8').trim().split('\n').map(JSON.parse).find(e=>e.type==='session.update');check(update?.session.instructions.includes('Respond in Spanish throughout the conversation.'),'Saved realtime speech language reaches the realtime model independently of read-aloud');
     let done=next(voice,v=>v.type==='turn.done'),audio=next(voice,(_,binary)=>binary);voice.send(JSON.stringify({type:'text',text:'hello'}));const [pcm]=await Promise.all([audio,done]);check(Buffer.from(pcm).equals(Buffer.from([1,2,3,4])),'Rust voice bridge forwards realtime audio');
     let stored=(await api("/api/chats")).find(c=>c.id===session.chatId);check(stored.messages.some(m=>m.role==='assistant'&&m.content==='Hello voice'&&m.status==='done'),'Rust voice turns persist in chat history');
     const approval=nextEventApproval();done=next(voice,v=>v.type==='turn.done');voice.send(JSON.stringify({type:'text',text:'use memory'}));const step=await approval;await api(`/api/approvals/${step.id}`,'POST',{approve:true});await done;check((await api('/api/state')).memory.includes('voice fixture fact'),'Rust voice tool calls use the shared approval workflow');
     voice.send(JSON.stringify({type:'frame',image:Buffer.from([255,216,255,217]).toString('base64')}));await sleep(250);
     done=next(voice,v=>v.type==='turn.done');voice.send(JSON.stringify({type:'text',text:'what do you see?'}));await done;
     check(fs.readFileSync(path.join(dir,'events.log'),'utf8').includes('(On camera right now: a blue cup)'),'Rust voice bridge includes camera descriptions in the turn');
     voice.send(JSON.stringify({type:'text',text:'hold response'}));await sleep(100);voice.send(JSON.stringify({type:'cancel'}));await sleep(100);
     done=next(voice,v=>v.type==='turn.done');voice.send(JSON.stringify({type:'text',text:'after interruption'}));await done;
     stored=(await api('/api/chats')).find(c=>c.id===session.chatId);check(stored.messages.at(-1).content==='Hello voice' && stored.messages.at(-1).status==='done','Voice bridge handles a new turn after interruption');
     done=next(voice,v=>v.type==='turn.done');voice.send(Buffer.alloc(12000));voice.send(JSON.stringify({type:'commit'}));await done;
     stored=(await api('/api/chats')).find(c=>c.id===session.chatId);check(stored.messages.at(-2).content==='…','Voice transcription waits until the realtime session ends');
     voice.send(JSON.stringify({type:'stop'}));await once(voice,'close');voice=null;
     for(let i=0;i<100;i++){stored=(await api('/api/chats')).find(c=>c.id===session.chatId);if(stored.messages.at(-2).content==='heard words')break;await sleep(50);}
     check(stored.messages.at(-2).content==='heard words','Voice transcript is saved after the realtime session ends');
     check(fs.readFileSync(path.join(dir,'events.log'),'utf8').trim().split('\n').map(JSON.parse).some(e=>e.type==='asr'&&e.prompt==='Perform ASR in Spanish.'),'Deferred ASR follows the explicit call language');
     await api('/api/parts/omni/stop','POST');await api('/api/settings','PATCH',{omniSlots:1});await api('/api/parts/omni/start','POST');
     for(let i=0;i<100;i++){if((await api('/api/state')).parts.find(p=>p.id==='omni').status==='running')break;await sleep(50);}
     fs.writeFileSync(path.join(dir,'no-ack'),'1');voice=new WebSocket(`ws://127.0.0.1:${port}/voice?t=${token}`,{origin:base});await once(voice,'open');ready=next(voice,v=>v.type==='ready');voice.send(JSON.stringify({type:'start'}));
     const oneSlot=await ready;check(oneSlot.configurationConfirmed===false,'No-ack engine uses bounded compatibility fallback');check(oneSlot.cameraAvailable===false,'One-slot voice session reports camera unavailable');
     const busySpeech=await fetch(base+'/api/speak',{method:'POST',headers:{'x-liquid-token':token,'content-type':'application/json'},body:JSON.stringify({text:'Hola',lang:'es'})});
     const busyAsr=await fetch(base+'/api/transcribe',{method:'POST',headers:{'x-liquid-token':token,'content-type':'audio/wav'},body:Buffer.from('RIFFtestWAVE')});
     const busyChat=await fetch(base+'/api/chats',{method:'POST',headers:{'x-liquid-token':token,'content-type':'application/json'},body:JSON.stringify({text:'Hello'})});
     const busyProbe=await fetch(base+'/api/capabilities/omni',{method:'POST',headers:{'x-liquid-token':token}});
     check(busySpeech.status===409 && busyAsr.status===409 && busyChat.status===409 && busyProbe.status===409,'One-slot voice session reports other Omni requests as busy');
     const rejectedFrame=next(voice,v=>v.type==='error');voice.send(JSON.stringify({type:'frame',image:Buffer.from([255,216,255,217]).toString('base64')}));check((await rejectedFrame).message.includes('two Omni slots'),'One-slot camera request is rejected rather than queued indefinitely');
     voice.send(JSON.stringify({type:'stop'}));await once(voice,'close');voice=null;
     fs.unlinkSync(path.join(dir,'no-ack'));fs.writeFileSync(path.join(dir,'reject-tools'),'1');
     voice=new WebSocket(`ws://127.0.0.1:${port}/voice?t=${token}`,{origin:base});await once(voice,'open');ready=next(voice,v=>v.type==='ready');voice.send(JSON.stringify({type:'start'}));
     const fallback=await ready;check(fallback.toolsSupported===false&&fallback.configurationConfirmed===false,'Rejected session options fall back to instructions and report unavailable tools');
     done=next(voice,v=>v.type==='turn.done');voice.send(JSON.stringify({type:'text',text:'hola'}));await done;
     voice.send(JSON.stringify({type:'stop'}));await once(voice,'close');voice=null;
     await api('/api/settings','PATCH',{voiceCallMode:'highQuality',realtimeLanguage:'es',voice:'male'});
     voice=new WebSocket(`ws://127.0.0.1:${port}/voice?t=${token}`,{origin:base});await once(voice,'open');ready=next(voice,v=>v.type==='ready');voice.send(JSON.stringify({type:'start'}));
     const quality=await ready;check(quality.voiceSupported===true,'High quality mode reports TTS voice support');
     const concurrent=await fetch(base+`/api/chats/${quality.chatId}/send`,{method:'POST',headers:{'x-liquid-token':token,'content-type':'application/json'},body:JSON.stringify({text:'other turn'})});
     const deletion=await fetch(base+`/api/chats/${quality.chatId}`,{method:'DELETE',headers:{'x-liquid-token':token}});
     check(concurrent.status===409 && deletion.status===409,'High quality reserves its chat while listening');
     done=next(voice,v=>v.type==='turn.done');audio=next(voice,(_,binary)=>binary);voice.send(Buffer.alloc(12000));voice.send(JSON.stringify({type:'commit'}));await Promise.all([audio,done]);
     const synthesis=fs.readFileSync(path.join(dir,'events.log'),'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.type==='tts').at(-1);check(synthesis.body.lang==='es'&&synthesis.body.voice==='male','High quality runs ASR, chat and Spanish TTS with selected voice on one slot');
     stored=(await api('/api/chats')).find(c=>c.id===quality.chatId);check(stored.messages.slice(-2).every(m=>m.voice===true),'High quality turns retain voice history markers');
     voice.send(JSON.stringify({type:'stop'}));await once(voice,'close');voice=null;
     async function nextEventApproval(){for(let i=0;i<200;i++){const chat=(await api("/api/chats")).find(c=>c.id===session.chatId);const step=chat.messages.at(-1)?.steps?.find(s=>s.status==='approval');if(step)return step;await sleep(50);}throw Error('voice tool approval timed out');}
    } finally {if(voice)voice.terminate();if(app){const exit=once(app,'exit');app.kill('SIGINT');await exit;}fs.rmSync(dir,{recursive:true,force:true});}
  }, 600_000);
});
