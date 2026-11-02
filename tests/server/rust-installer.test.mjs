import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// Migrated from scripts/rust-installer-check.mjs. The checks throw on failure; vitest reports each one.

describe("Rust native downloads against a fixture service", () => {
  it("Rust native downloads against a fixture service", async () => {
    const repo=fileURLToPath(new URL("../..", import.meta.url)); const dir=fs.mkdtempSync(path.join(os.tmpdir(),"liquid-installer-"));
    const data=path.join(dir,"data"),dist=path.join(dir,"dist"); fs.mkdirSync(data); fs.mkdirSync(dist); fs.writeFileSync(path.join(dist,"index.html"),"<head></head>");
    const ports=[]; const sockets=[]; for (let i=0;i<5;i++) { const socket=net.createServer(); await new Promise((resolve)=>socket.listen(0,"127.0.0.1",resolve)); sockets.push(socket); ports.push(socket.address().port); } for (const socket of sockets) await new Promise((resolve)=>socket.close(resolve));
    const [appPort,modelPort,guardianPort,browserPort,omniPort]=ports;
    const binary=`#!${process.execPath}\nconst http=require('http'),fs=require('fs');const i=process.argv.indexOf('--port');if(i>=0){fs.writeFileSync(${JSON.stringify(path.join(dir,'model-pid'))},String(process.pid));fs.writeFileSync(${JSON.stringify(path.join(dir,'model-args'))},JSON.stringify(process.argv.slice(2)));}const port=Number(i>=0?process.argv[i+1]:process.argv[3]);http.createServer((q,s)=>{if(q.method==='POST' && q.url==='/v1/chat/completions'){q.resume();q.on('end',()=>{s.writeHead(200,{'content-type':'text/event-stream'});s.write('data: '+JSON.stringify({choices:[{delta:{content:'Hello '}}]})+'\\n\\n');const timer=setTimeout(()=>s.end('data: '+JSON.stringify({choices:[{delta:{content:'world'}}]})+'\\n\\ndata: [DONE]\\n\\n'),4000);s.on('close',()=>clearTimeout(timer));});return;}s.end('{"ok":true}');}).listen(port,'127.0.0.1');\n`;
    function tarFile(name,data) {
      const header=Buffer.alloc(512), write=(value,offset,size)=>header.write(value,offset,size,"ascii");
      const octal=(value,size)=>value.toString(8).padStart(size-1,"0")+"\0";
      write(name,0,100); write(octal(0o755,8),100,8); write(octal(0,8),108,8); write(octal(0,8),116,8); write(octal(data.length,12),124,12); write(octal(0,12),136,12); header.fill(32,148,156); header[156]=48; write("ustar\0",257,6); write("00",263,2);
      const sum=header.reduce((n,b)=>n+b,0); write(sum.toString(8).padStart(6,"0")+"\0 ",148,8);
      return Buffer.concat([header,data,Buffer.alloc((512-data.length%512)%512),Buffer.alloc(1024)]);
    }
    function zipFile(name,content,mode=0o755){
      const nameBuf=Buffer.from(name), crc=zlib.crc32(content);
      const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt32LE(crc,14); local.writeUInt32LE(content.length,18); local.writeUInt32LE(content.length,22); local.writeUInt16LE(nameBuf.length,26);
      const central=Buffer.alloc(46); central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(0x0314,4); central.writeUInt16LE(20,6); central.writeUInt32LE(crc,16); central.writeUInt32LE(content.length,20); central.writeUInt32LE(content.length,24); central.writeUInt16LE(nameBuf.length,28); central.writeUInt32LE((mode<<16)>>>0,38);
      const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(central.length+nameBuf.length,12); end.writeUInt32LE(local.length+nameBuf.length+content.length,16);
      return Buffer.concat([local,nameBuf,content,central,nameBuf,end]);
    }
    // Chrome for Testing's index: where the Web helper's browser comes from (a placeholder binary here).
    const browserBinary=Buffer.from("#!/bin/sh\nexit 0\n");
    const browserPlatform=process.platform==="darwin"?(process.arch==="arm64"?"mac-arm64":"mac-x64"):(process.arch==="arm64"?"linux-arm64":"linux64");
    const gguf=Buffer.alloc(24); gguf.write("GGUF",0); gguf.writeUInt32LE(3,4);
    const archive=zlib.gzipSync(tarFile("bin/llama-server",Buffer.from(binary))); const model=Buffer.from("ABCDEFGHIJKLMNO"); const guardianData=Buffer.alloc(128*1024,7); let slow=true, slowQuant=false, wrongRelease=true; const ranges=[];
    const mock=http.createServer((req,res)=>{
      if (req.url === "/api/models/org/test") {res.setHeader("content-type","application/json");return res.end(JSON.stringify({modelId:"org/test",cardData:{model_name:"Fixture",license:"mit"}}));}
      if (req.url === "/api/models/org/test/tree/main?recursive=true&expand=true") {res.setHeader("content-type","application/json");return res.end(JSON.stringify([{type:"file",path:"nested/Test-Q4_0.gguf",size:gguf.length},{type:"file",path:"nested/Test-Q8_0.gguf",size:gguf.length},{type:"file",path:"nested/Bad-Q2_K.gguf",size:12}]));}
      if (req.url.includes("Q6_K.gguf")) {res.statusCode=503;return res.end("fixture failure");}
      if (req.url === "/browser-index.json") {res.setHeader("content-type","application/json");return res.end(JSON.stringify({channels:{Stable:{downloads:{"chrome-headless-shell":[{platform:browserPlatform,url:`http://127.0.0.1:${mock.address().port}/browser.zip`}]}}}}));}
      if (req.url === "/browser.zip") {res.setHeader("content-type","application/zip");return res.end(zipFile(`chrome-headless-shell-${browserPlatform}/chrome-headless-shell`,browserBinary));}
      if (req.url === "/releases") { res.setHeader("content-type","application/json"); return res.end(JSON.stringify({tag_name:wrongRelease?"b99999":"b12017",assets:[{name:`llama-b12017-bin-${process.platform === "darwin" ? "macos" : "ubuntu"}-${process.arch}.tar.gz`,browser_download_url:`http://127.0.0.1:${mock.address().port}/engine.tar.gz`}]})); }
      const data=req.url === "/engine.tar.gz" ? archive : req.url.includes("/Bad-Q2_K.gguf") ? Buffer.from("bad weights!") : req.url.includes("/org/test/resolve/") ? gguf : req.url.includes("/LiquidAI/") ? model : guardianData;
      let start=0;
      if (req.headers.range) { start=Number(req.headers.range.match(/^bytes=(\d+)-$/)?.[1] ?? 0); ranges.push({path:req.url,start}); res.statusCode=206; res.setHeader("Content-Range",`bytes ${start}-${data.length-1}/${data.length}`); }
      res.setHeader("Content-Length",data.length-start);
      if ((req.url.includes("Q8_0.gguf") || req.url.includes("Q5_K_M.gguf")) && slowQuant) { const timer=setTimeout(()=>res.end(data.subarray(start)),1200);res.on("close",()=>clearTimeout(timer)); }
      else if (req.url.includes("/ProCreations/") && slow) { res.write(data.subarray(start,Math.min(start+4096,data.length))); const timer=setTimeout(()=>res.end(data.subarray(Math.min(start+4096,data.length))),5000); res.on("close",()=>clearTimeout(timer)); }
      else res.end(data.subarray(start));
    });
    await new Promise((resolve)=>mock.listen(0,"127.0.0.1",resolve)); const mockBase=`http://127.0.0.1:${mock.address().port}`;
    const fakeGuardian=path.join(dir,"guardian"); fs.writeFileSync(fakeGuardian,binary,{mode:0o755});
    fs.mkdirSync(path.join(data,"models")); fs.writeFileSync(path.join(data,"models","LFM3-1.7B-Q4_K_M.gguf.part"),model.subarray(0,3));
    const binDir=path.join(dir,"bin"); fs.mkdirSync(binDir);
    const env={...process.env,LIQUID_AGENT_NO_AUTOSTART:"1",PATH:`${binDir}:${process.env.PATH}`,LIQUID_AGENT_BROWSER_INDEX:`${mockBase}/browser-index.json`,LIQUID_AGENT_BROWSER_PORT:String(browserPort),LIQUID_AGENT_RUST_PORT:String(appPort),LIQUID_AGENT_RUST_HOME:data,LIQUID_AGENT_WEB_DIST:dist,LIQUID_AGENT_SMALL_PORT:String(modelPort),LIQUID_AGENT_OMNI_PORT:String(omniPort),LIQUID_GUARDIAN_PORT:String(guardianPort),LIQUID_AGENT_HF_BASE:mockBase,LIQUID_AGENT_RELEASES_URL:`${mockBase}/releases`,LIQUID_AGENT_GUARDIAN_BINARY:fakeGuardian,LIQUID_AGENT_GPU:"cpu",NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"};
    let app; let log="";
    const base=`http://127.0.0.1:${appPort}`; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); let token="";
    const call=async (method,url,body)=>{ const res=await fetch(base+url,{method,headers:{"x-liquid-token":token,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})}); if(!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`); return res.json(); };
    async function waitFor(label,test) { for(let i=0;i<200;i++){ const state=await call("GET","/api/state"); if(test(state)) return state; const failed=state.parts.find(p=>p.status==="failed"); if(failed) throw new Error(`${label}: ${failed.error}`); await sleep(100); } throw new Error(`Timed out: ${label}\n${log}`); }
    function check(ok,message){if(!ok) throw new Error(message); console.log(`✓ ${message}`);}
    async function start() {
      app=spawn(path.join(repo,"target/debug/liquid-server"),[],{env,stdio:["ignore","pipe","pipe"]}); app.stderr.on("data",d=>log+=d); token="";
      for(let i=0;i<100;i++){ try { const page=await (await fetch(base)).text(); token=page.match(/name="liquid-token" content="([^"]+)"/)?.[1] ?? ""; if(token) return; }catch{} await sleep(100); }
      throw new Error(`Server did not start: ${log}`);
    }
    async function stop() { const exited=once(app,"exit"); app.kill("SIGINT"); await exited; app=null; }
    try {
      await start();
      await call("POST","/api/parts/install",{ids:["engine"]});
      const rejectedRelease=await waitFor("unexpected engine release",s=>!s.busy && s.parts.find(p=>p.id==="engine")?.status==="failed");
      check(rejectedRelease.parts.find(p=>p.id==="engine").error.includes("Unexpected llama.cpp release") && !fs.existsSync(path.join(data,"engine")), "Installer rejects a mismatched engine release");
      wrongRelease=false;
      await call("POST","/api/parts/install",{ids:["small"]});
      await waitFor("model installation",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="running");
      check(fs.readFileSync(path.join(data,"models","LFM3-1.7B-Q4_K_M.gguf")).equals(model) && ranges.some(r=>r.path.includes("LFM3-1.7B") && r.start===3),"Rust installer resumes and starts a model after installing its engine");
      check(fs.readFileSync(path.join(data,"engine",".version"),"utf8") === "b12017" && (await call("GET","/api/state")).parts.find(p=>p.id==="engine").version === "b12017", "Installer records the pinned engine release");
      await call("PATCH","/api/settings",{smallURL:`http://127.0.0.1:${modelPort}/v1`});
      const activeChat=await call("POST","/api/chats",{text:"Describe a peaceful morning."});
      const firstPid=fs.readFileSync(path.join(dir,"model-pid"),"utf8");slowQuant=true;
      await call("PATCH","/api/settings",{smallQuant:"Q8_0"});
      const switching=await waitFor("live model size download",s=>s.busy && s.parts.find(p=>p.id==="small")?.status==="installing");
      check(switching.parts.find(p=>p.id==="small").live===true && fs.readFileSync(path.join(dir,"model-pid"),"utf8")===firstPid,"Model remains live while its new size downloads");
      const waiting=await waitFor("model replacement waiting for chat",s=>s.busy && s.parts.find(p=>p.id==="small")?.text?.includes("Waiting for active work"));
      check(waiting.chats.find(c=>c.id===activeChat.id)?.messages.at(-1)?.status==="streaming" && fs.readFileSync(path.join(dir,"model-pid"),"utf8")===firstPid,"Model replacement waits for the active chat");
      await waitFor("new model size",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="running");
      check((await call("GET","/api/chats")).find(c=>c.id===activeChat.id)?.messages.at(-1)?.status==="done","The active chat completes before model replacement");
      await call("DELETE",`/api/chats/${activeChat.id}`);
      check(fs.readFileSync(path.join(dir,"model-pid"),"utf8")!==firstPid && JSON.parse(fs.readFileSync(path.join(dir,"model-args"),"utf8")).some(a=>a.endsWith("LFM3-1.7B-Q8_0.gguf")),"Rust server starts the newly downloaded model size");
      slowQuant=false;
      const interruptedChat=await call("POST","/api/chats",{text:"Describe a quiet afternoon."});
      await call("PATCH","/api/settings",{smallQuant:"Q4_K_M"});
      await waitFor("installed model replacement waiting for chat",s=>s.busy && s.parts.find(p=>p.id==="small")?.text?.includes("Waiting for active work"));
      await call("POST","/api/parts/small/stop");
      await waitFor("explicit stop while replacement waits",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="installed");
      check((await call("GET","/api/state")).parts.find(p=>p.id==="small").status==="installed","A manual stop while replacement waits suppresses restart");
      await call("DELETE",`/api/chats/${interruptedChat.id}`);
      await call("POST","/api/parts/small/start");
      await waitFor("previous model size",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="running");
      check(JSON.parse(fs.readFileSync(path.join(dir,"model-args"),"utf8")).some(a=>a.endsWith("LFM3-1.7B-Q4_K_M.gguf")),"Rust server switches back to an installed size");
      const pidBeforeFailure=fs.readFileSync(path.join(dir,"model-pid"),"utf8");
      await call("PATCH","/api/settings",{smallQuant:"Q6_K"});
      await waitFor("failed live switch",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="running");
      check(fs.readFileSync(path.join(dir,"model-pid"),"utf8")===pidBeforeFailure,"A failed model download leaves the old model running");
      await call("PATCH","/api/settings",{smallQuant:"Q4_K_M"});
      await waitFor("restore after failed switch",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="running");
      slowQuant=true;await call("PATCH","/api/settings",{smallQuant:"Q5_K_M"});
      await waitFor("switch before stop",s=>s.busy && s.parts.find(p=>p.id==="small")?.status==="installing");
      await call("POST","/api/parts/small/stop");
      await waitFor("stopped switch",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="installed");
      check((await call("GET","/api/state")).parts.find(p=>p.id==="small").status==="installed","Stopping a model during its download does not restart it");
      slowQuant=false;await call("PATCH","/api/settings",{smallQuant:"Q4_K_M"});
      await waitFor("default model after stop",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="running");
      await call("POST","/api/parts/small/stop");
      await call("PATCH","/api/settings",{startupMode:"hybrid",omniURL:`http://127.0.0.1:${omniPort}/v1`});
      await call("POST","/api/parts/install",{ids:["omni"]});
      const installedOmni=await waitFor("Omni installation",s=>!s.busy && s.parts.find(p=>p.id==="omni")?.status==="installed");
      check(installedOmni.parts.find(p=>p.id==="omni").onDemand === true,"Hybrid installation leaves Omni unloaded until needed");
      const warmed=await fetch(`${base}/api/speak`,{method:"POST",headers:{"x-liquid-token":token,"content-type":"application/json"},body:JSON.stringify({text:"Hola",lang:"es"})});
      check(warmed.ok,"Hybrid starts newly installed Omni on demand");
      await waitFor("Omni warmup",s=>s.parts.find(p=>p.id==="omni")?.status==="running");
      await call("POST","/api/parts/install",{ids:["small"]});
      const deferredSmall=await waitFor("deferred text model",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="installed");
      check(deferredSmall.parts.find(p=>p.id==="omni")?.status==="running","Hybrid installation does not add text while Omni is active");
      check(JSON.parse(fs.readFileSync(path.join(dir,"model-args"),"utf8")).some(a=>a.endsWith("mmproj-LFM3-Omni-2B-Q8_0.gguf")),"Omni starts with the default Q8 projector");
      await call("PATCH","/api/settings",{omniProjector:"Q4_K_M"});
      await waitFor("Omni projector switch",s=>!s.busy && s.parts.find(p=>p.id==="omni")?.status==="running");
      check(fs.existsSync(path.join(data,"models","mmproj-LFM3-Omni-2B-Q4_K_M.gguf")) && JSON.parse(fs.readFileSync(path.join(dir,"model-args"),"utf8")).some(a=>a.endsWith("mmproj-LFM3-Omni-2B-Q4_K_M.gguf")),"Changing projector downloads and starts the selected quantization");
      await call("POST","/api/parts/omni/stop");
      await call("PATCH","/api/settings",{startupMode:"auto"});
      await call("PATCH","/api/settings",{guardianURL:`http://127.0.0.1:${guardianPort}`,approvalMode:"approveForMe"});
      await waitFor("guardian download",s=>s.busy && s.parts.find(p=>p.id==="guardian")?.status==="installing");
      await call("PATCH","/api/settings",{approvalMode:"askAlways"});
      slow=false;
      await waitFor("guardian after preference change",s=>!s.busy && s.parts.find(p=>p.id==="guardian")?.status==="installed");
      check((await call("GET","/api/settings")).approvalMode === "askAlways" && !(await call("GET","/api/state")).guardianWanted,"Changing the approval preference leaves the installed safety helper stopped");
      await call("POST","/api/parts/guardian/stop"); fs.rmSync(path.join(data,"guardian"),{recursive:true,force:true}); slow=true;
      await call("PATCH","/api/settings",{approvalMode:"approveForMe"});
      await waitFor("guardian redownload",s=>s.busy && s.parts.find(p=>p.id==="guardian")?.status==="installing");
      const busyRemove=await fetch(base+"/api/parts/guardian/remove",{method:"POST",headers:{"x-liquid-token":token}});
      check(busyRemove.status===409,"Rust server refuses to remove a component during installation");
      await sleep(300); await call("POST","/api/parts/cancel");
      await waitFor("cancellation",s=>!s.busy);
      check(!fs.existsSync(path.join(data,"guardian",".ready")) && (await call("GET","/api/state")).guardianWanted,"Rust installer cancels without marking an incomplete helper ready");
      slow=false;
      await stop(); await start();
      await waitFor("guardian installation",s=>!s.busy && s.parts.find(p=>p.id==="guardian")?.status==="running");
      check(fs.readFileSync(path.join(data,"guardian",".ready"),"utf8")==="ProCreations/auto-150m-3" && ranges.some(r=>r.path.includes("ProCreations") && r.start>0) && (await call("GET","/api/settings")).approvalMode === "approveForMe","Rust installer restores the safety-helper request and resumes it after restart");
      await call("POST","/api/parts/guardian/stop");
      await call("POST","/api/parts/install",{ids:["browser"]});
      await waitFor("browser installation",s=>!s.busy && s.parts.find(p=>p.id==="browser")?.status==="installed");
      check(fs.existsSync(path.join(data,"bridge",".ready")) && fs.readFileSync(path.join(data,"bridge","browser",`chrome-headless-shell-${browserPlatform}`,"chrome-headless-shell"),"utf8")===browserBinary.toString() && (fs.statSync(path.join(data,"bridge","browser",`chrome-headless-shell-${browserPlatform}`,"chrome-headless-shell")).mode & 0o100)!==0,"Rust installer downloads the browser without starting the Web helper");
      await call("POST","/api/parts/browser/start");
      await waitFor("manual browser start",s=>s.parts.find(p=>p.id==="browser")?.status==="running");
      await call("POST","/api/parts/browser/stop");
      const resolved=await call("POST","/api/models/resolve",{link:"org/test"});
      check(resolved.repo==="org/test" && resolved.variants.length===3 && resolved.license==="mit","Rust server resolves Hugging Face model variants");
      await call("POST","/api/models/custom",{link:"org/test",file:"nested/Test-Q4_0.gguf"});
      let customState=await waitFor("custom model",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="running");
      check(customState.parts.find(p=>p.id==="small").custom.file==="nested/Test-Q4_0.gguf" && fs.readFileSync(path.join(data,"models/custom/nested/Test-Q4_0.gguf")).equals(gguf) && JSON.parse(fs.readFileSync(path.join(data,"custom-model.json"),"utf8")).meta.hasTemplate===false,"Rust server downloads, probes, and starts a custom GGUF model");
      await call("POST","/api/models/custom/quant",{file:"nested/Bad-Q2_K.gguf"});
      let failedCustom; for(let i=0;i<200;i++){const state=await call("GET","/api/state");if(!state.busy && state.parts.find(p=>p.id==="small")?.status==="failed"){failedCustom=state;break;} await sleep(100);}
      check(failedCustom && JSON.parse(fs.readFileSync(path.join(data,"custom-model.json"),"utf8")).meta===null,"Rust installer rejects an invalid GGUF without marking it installed");
      await call("POST","/api/models/custom/quant",{file:"nested/Test-Q8_0.gguf"});
      customState=await waitFor("custom model size",s=>!s.busy && s.parts.find(p=>p.id==="small")?.status==="running");
      check(customState.parts.find(p=>p.id==="small").custom.file==="nested/Test-Q8_0.gguf","Rust server switches custom model sizes");
      await call("DELETE","/api/models/custom");
      await waitFor("built-in model restored",s=>s.parts.find(p=>p.id==="small")?.status==="running");
      check(!fs.existsSync(path.join(data,"custom-model.json")) && !fs.existsSync(path.join(data,"models/custom")),"Rust server restores the built-in model");
      check((await call("GET","/api/state")).parts.find(p=>p.id==="browser")?.status==="installed","Rust server stops the browser bridge");
      await call("POST","/api/parts/browser/remove");
      check(!fs.existsSync(path.join(data,"bridge")) && (await call("GET","/api/state")).parts.find(p=>p.id==="browser")?.status==="missing","Rust server removes the browser helper");
      await call("POST","/api/parts/guardian/remove");
      check(!fs.existsSync(path.join(data,"guardian")) && (await call("GET","/api/settings")).approvalMode==="askAlways" && !(await call("GET","/api/state")).guardianWanted,"Removing the safety helper falls back to manual approval");
      await call("POST","/api/parts/small/remove");
      check(!fs.existsSync(path.join(data,"models","LFM3-1.7B-Q4_K_M.gguf")) && (await call("GET","/api/state")).parts.find(p=>p.id==="small")?.status==="missing","Rust server stops and removes the model");
      await call("POST","/api/parts/engine/remove");
      check(!fs.existsSync(path.join(data,"engine")),"Rust server removes the AI engine");
    } finally {
      if(app) await stop(); mock.closeAllConnections(); await new Promise(resolve=>mock.close(resolve)); fs.rmSync(dir,{recursive:true,force:true});
    }
  }, 600_000);
});
