//! Realtime voice bridge for the locally managed Omni model.
use crate::{agent_tools, allowed, json_response, media, store, tools, App};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::Response,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as UpMessage;
use tokio_util::sync::CancellationToken;

pub async fn websocket(
    State(app): State<App>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Response {
    if !headers.contains_key(header::ORIGIN) || !allowed(&headers, &uri, &app, true) {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error":"Not allowed."}));
    }
    ws.max_message_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| run(app, socket))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn edit(app: &App, id: &str, f: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let mut chats = app.chats.lock().unwrap();
    let mut next = chats.clone();
    let chat = next
        .iter_mut()
        .find(|c| c["id"] == id)
        .ok_or_else(|| anyhow::anyhow!("Voice chat no longer exists"))?;
    f(chat);
    chat["updatedAt"] = json!(now());
    let event = chat.clone();
    store::save(&app.data, "chats.json", &json!(next))?;
    *chats = next;
    drop(chats);
    app.emit(json!({"type":"chat","chat":event}));
    Ok(())
}
fn make_chat(app: &App, requested: Option<&str>) -> anyhow::Result<String> {
    let mut chats = app.chats.lock().unwrap();
    if let Some(chat) = requested.and_then(|id| chats.iter().find(|c| c["id"] == id)) {
        return Ok(chat["id"].as_str().unwrap().to_owned());
    }
    let id = store::id();
    let stamp = now();
    let chat = json!({"id":id,"title":"Voice chat","source":"voice","named":true,"createdAt":stamp,"updatedAt":stamp,"pinned":false,"messages":[]});
    let mut next = chats.clone();
    next.insert(0, chat.clone());
    store::save(&app.data, "chats.json", &json!(next))?;
    *chats = next;
    drop(chats);
    app.emit(json!({"type":"chat","chat":chat}));
    Ok(id)
}
fn schema(browser: bool) -> Vec<Value> {
    tools::descriptors(browser, true).as_object().unwrap().iter().map(|(name, desc)| {
        let params=desc["params"].as_array().unwrap(); let properties=params.iter().filter_map(|p|p["name"].as_str()).map(|n|(n.to_owned(),json!({"type":if name=="reminder" && n=="minutes" {"number"}else{"string"}}))).collect::<serde_json::Map<_,_>>();
        let required: Vec<_>=params.iter().filter(|p|p["required"]!=false).filter_map(|p|p["name"].as_str()).collect();
        json!({"type":"function","name":name,"description":name.replace('_'," "),"parameters":{"type":"object","properties":properties,"required":required}})
    }).collect()
}
fn instructions(app: &App, chat: &str, settings: &Value) -> String {
    // The voice model answers in the language of the chat, in the words of that language.
    let reply = liquid_core::i18n::reply_for(settings);
    let strings = reply.strings;
    let personality = reply.personality(settings["personality"].as_str().unwrap_or(""));
    let style = if personality.is_empty() {
        String::new()
    } else {
        format!("{personality} ")
    };
    let name = settings["userName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| {
            strings
                .user_name
                .replace("{name}", &s.chars().take(100).collect::<String>())
        })
        .unwrap_or_default();
    let recent = app
        .chats
        .lock()
        .unwrap()
        .iter()
        .find(|c| c["id"] == chat)
        .and_then(|c| c["messages"].as_array())
        .map(|messages| {
            messages
                .iter()
                .rev()
                .take(6)
                .rev()
                .filter_map(|m| {
                    m["content"].as_str().filter(|s| !s.is_empty()).map(|text| {
                        format!(
                            "{}: {}",
                            if m["role"] == "user" {
                                strings.speaker_user
                            } else {
                                strings.speaker_you
                            },
                            text.chars().take(200).collect::<String>()
                        )
                    })
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let facts = liquid_core::memory::search(&app.memory.lock().unwrap(), &recent, 4).join("; ");
    let voice = strings
        .voice
        .replace("{style}", &style)
        .replace("{name}", &name);
    let facts_line = strings.user_facts.replace("{facts}", &facts);
    format!(
        "{voice} {}\n{facts_line}\n{}\n{recent}",
        reply.directive(),
        strings.voice_earlier
    )
}
fn wav(pcm: &[u8], rate: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend(b"RIFF");
    out.extend((36 + pcm.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(rate.to_le_bytes());
    out.extend((rate * 2).to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((pcm.len() as u32).to_le_bytes());
    out.extend(pcm);
    out
}
async fn send(socket: &mut WebSocket, value: Value) -> bool {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .is_ok()
}
fn begin(app: &App, chat: &str, text: &str) -> anyhow::Result<(String, String)> {
    let uid = store::id();
    let rid = store::id();
    let stamp = now();
    edit(app, chat, |c| {
        let messages = c["messages"].as_array_mut().unwrap();
        messages.push(
            json!({"id":uid,"role":"user","content":text,"voice":true,"attachments":[],"at":stamp}),
        );
        messages.push(json!({"id":rid,"role":"assistant","content":"","steps":[],"status":"streaming","model":"omni","voice":true,"at":stamp}));
    })?;
    Ok((uid, rid))
}
fn finish(app: &App, chat: &str, reply: &str, status: &str) {
    let _ = edit(app, chat, |c| {
        if let Some(m) = c["messages"]
            .as_array_mut()
            .and_then(|ms| ms.iter_mut().find(|m| m["id"] == reply))
        {
            m["status"] = json!(status);
        }
    });
}
#[derive(Debug)]
enum AsyncEvent {
    Transcription(String, String),
    Tools(String, Vec<(String, String)>),
    Camera(u64, String),
}
async fn describe(url: String, image: String) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;
    let res=client.post(format!("{}/chat/completions",url.trim_end_matches('/'))).json(&json!({"model":"LFM3-Omni-2B","temperature":0,"max_tokens":120,"stream":false,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":format!("data:image/jpeg;base64,{image}")}},{"type":"text","text":"This is a frame from the user's camera during a voice call. In one or two short sentences, describe what it shows."}]}]})).send().await?.error_for_status()?;
    let mut stream = res.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        anyhow::ensure!(
            bytes.len() + chunk.len() < 1_000_000,
            "Camera response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes)?;
    Ok(body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_owned())
}
/// Counts a live voice call, so an update waits until nobody is talking to the agent.
struct CallGuard(App);
impl Drop for CallGuard {
    fn drop(&mut self) {
        self.0
            .voice_calls
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

async fn run(app: App, mut socket: WebSocket) {
    app.voice_calls
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _call = CallGuard(app.clone());
    let first = tokio::time::timeout(Duration::from_secs(30), socket.recv()).await;
    let Some(Ok(Message::Text(first))) = first.ok().flatten() else {
        return;
    };
    let Ok(start) = serde_json::from_str::<Value>(&first) else {
        return;
    };
    if start["type"] != "start" {
        return;
    }
    if !app.backends.running("omni") {
        send(&mut socket,json!({"type":"error","message":"Voice chat needs Eyes and ears. Set it up in Settings → Downloads."})).await;
        return;
    }
    let settings = app.settings.lock().unwrap().clone();
    let url = settings["omniURL"].as_str().unwrap_or("");
    if !liquid_core::settings::is_local(url) {
        send(&mut socket,json!({"type":"error","message":"Refusing a model address that isn't on this computer."})).await;
        return;
    }
    let Ok(mut upstream_url) = url::Url::parse(url) else {
        return;
    };
    let scheme = match upstream_url.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => return,
    };
    let _ = upstream_url.set_scheme(scheme);
    upstream_url.set_path(&format!(
        "{}/realtime",
        upstream_url.path().trim_end_matches('/')
    ));
    upstream_url.set_query(None);
    upstream_url.set_fragment(None);
    let upstream = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(upstream_url.as_str()),
    )
    .await;
    let Ok(Ok((mut upstream, _))) = upstream else {
        send(
            &mut socket,
            json!({"type":"error","message":"Couldn't reach the voice service."}),
        )
        .await;
        return;
    };
    let Ok(chat) = make_chat(&app, start["chatId"].as_str()) else {
        return;
    };
    let session_cancel = CancellationToken::new();
    let active = {
        let mut running = app.running.lock().unwrap();
        if running.contains_key(&chat) {
            None
        } else {
            running.insert(chat.clone(), session_cancel.clone());
            Some(running.keys().cloned().collect::<Vec<_>>())
        }
    };
    let Some(active) = active else {
        send(
            &mut socket,
            json!({"type":"error","message":"That chat is already active."}),
        )
        .await;
        return;
    };
    app.emit(json!({"type":"running","running":active}));
    let instructions = instructions(&app, &chat, &settings);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut events = app.events.subscribe();
    let mut input_rate = 16000u32;
    let mut output_rate = 24000u32;
    let mut heard = Vec::new();
    let mut reply: Option<String> = None;
    let mut user = String::new();
    let mut text = String::new();
    let mut calls: Vec<Value> = Vec::new();
    let mut audio_bytes = 0usize;
    let mut responding = false;
    let mut discarding = false;
    let mut queued_response = false;
    let mut turn_cancel = session_cancel.child_token();
    let mut camera_seq = 0u64;
    let mut seen = (0u64, String::new());
    let mut camera_busy = false;
    let mut queued_frame: Option<(u64, String)> = None;
    macro_rules! up {
        ($value:expr) => {
            if upstream
                .send(UpMessage::Text($value.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        };
    }
    loop {
        tokio::select! {
            _=session_cancel.cancelled()=>break,
            incoming=socket.recv()=>{let Some(Ok(message))=incoming else{break};match message {
                Message::Binary(bytes)=>{if heard.len()+bytes.len()>input_rate as usize*2*60 {send(&mut socket,json!({"type":"error","message":"Voice input is too long."})).await;heard.clear();up!(json!({"type":"input_audio_buffer.clear"}));continue;} heard.extend_from_slice(&bytes);up!(json!({"type":"input_audio_buffer.append","audio":BASE64.encode(bytes)}));},
                Message::Text(raw)=>{let Ok(message)=serde_json::from_str::<Value>(&raw) else{continue};match message["type"].as_str().unwrap_or("") {
                    "stop"=>break,
                    "cancel"=>{heard.clear();turn_cancel.cancel();if responding && !discarding {up!(json!({"type":"response.cancel"})); discarding=true;} queued_response=false;calls.clear();if let Some(id)=reply.take(){finish(&app,&chat,&id,"stopped");send(&mut socket,json!({"type":"turn.done"})).await;}send(&mut socket,json!({"type":"state","state":"listening"})).await;},
                    "frame"=>{if let Some(image)=message["image"].as_str().filter(|s|s.len()<3_000_000){if BASE64.decode(image).ok().is_some_and(|b|b.starts_with(&[0xff,0xd8])) {camera_seq+=1;let frame=(camera_seq,image.to_owned());if camera_busy{queued_frame=Some(frame);}else{camera_busy=true;let tx=tx.clone();let url=url.to_owned();tokio::spawn(async move{let _=tx.send(AsyncEvent::Camera(frame.0,describe(url,frame.1).await.unwrap_or_default()));});}}}},
                    "text" | "commit"=>{let is_audio=message["type"]=="commit";let spoken=if is_audio {"…".to_owned()} else {message["text"].as_str().unwrap_or("").trim().chars().take(8000).collect()};if spoken.is_empty(){continue;}if is_audio && heard.len()<input_rate as usize*2*3/10 {heard.clear();up!(json!({"type":"input_audio_buffer.clear"}));continue;}if let Some(id)=reply.take(){turn_cancel.cancel();finish(&app,&chat,&id,"stopped");}turn_cancel=session_cancel.child_token();if responding && !discarding {up!(json!({"type":"response.cancel"}));discarding=true;}calls.clear();let Ok((uid,rid))=begin(&app,&chat,&spoken) else{break};user=spoken.clone();reply=Some(rid);text.clear();audio_bytes=0;
                        let note=if seen.0>0 {format!("(On camera right now: {})",seen.1)}else{String::new()};
                        if is_audio {let audio=std::mem::take(&mut heard);up!(json!({"type":"input_audio_buffer.commit"}));if !note.is_empty(){up!(json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":note}]}}));}let tx=tx.clone();let url=url.to_owned();let token=turn_cancel.clone();tokio::spawn(async move {let audio=wav(&audio,input_rate);let result=tokio::select!{_ = token.cancelled()=>return, result=media::completion(&url,&audio)=>result.unwrap_or_default()};let _=tx.send(AsyncEvent::Transcription(uid,result));});}
                        else {let message=if note.is_empty(){spoken}else{format!("{spoken}\n\n{note}")};up!(json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":message}]}}));}
                        up!(json!({"type":"response.create"}));responding=true;send(&mut socket,json!({"type":"state","state":"thinking"})).await;
                    },_=>{}
                }},Message::Close(_)=>break,_=>{}
            }},
            event=upstream.next()=>{let raw=match event {Some(Ok(UpMessage::Text(raw)))=>raw,Some(Ok(UpMessage::Close(_))) | None | Some(Err(_))=>break,Some(Ok(_))=>continue};let Ok(event)=serde_json::from_str::<Value>(&raw) else{continue};match event["type"].as_str().unwrap_or(""){
                "session.created"=>{input_rate=event.pointer("/session/audio/input/format/rate").and_then(Value::as_u64).unwrap_or(16000).clamp(8000,96000) as u32;output_rate=event.pointer("/session/audio/output/format/rate").and_then(Value::as_u64).unwrap_or(24000).clamp(8000,96000) as u32;up!(json!({"type":"session.update","session":{"instructions":instructions,"tools":schema(app.backends.running("browser")),"tool_choice":"auto","output_modalities":["text","audio"],"max_output_tokens":400}}));send(&mut socket,json!({"type":"ready","inputRate":input_rate,"outputRate":output_rate,"chatId":chat})).await;send(&mut socket,json!({"type":"state","state":"listening"})).await;},
                "response.output_text.delta"=>{if discarding {continue;}if let Some(id)=reply.as_deref(){text.push_str(event["delta"].as_str().unwrap_or(""));let _=edit(&app,&chat,|c|{if let Some(m)=c["messages"].as_array_mut().and_then(|v|v.iter_mut().find(|m|m["id"]==id)){m["content"]=json!(text);}});send(&mut socket,json!({"type":"assistant","text":text})).await;}},
                "response.output_audio.delta"=>{if discarding {continue;}if reply.is_some(){if let Ok(bytes)=BASE64.decode(event["delta"].as_str().unwrap_or("")){audio_bytes+=bytes.len();if audio_bytes>output_rate as usize*2*45{up!(json!({"type":"response.cancel"}));}else{if audio_bytes==bytes.len(){send(&mut socket,json!({"type":"state","state":"speaking"})).await;}if socket.send(Message::Binary(bytes.into())).await.is_err(){break;}}}}},
                "response.function_call_arguments.done"=>{if !discarding {calls.push(event);}},
                "response.done"=>{responding=false;if discarding {discarding=false;calls.clear();if queued_response {queued_response=false;up!(json!({"type":"response.create"}));responding=true;}continue;}if event["response"]["status"]=="cancelled"{calls.clear();if let Some(id)=reply.take(){finish(&app,&chat,&id,"stopped");send(&mut socket,json!({"type":"turn.done"})).await;}}else if calls.is_empty(){if let Some(id)=reply.take(){finish(&app,&chat,&id,"done");send(&mut socket,json!({"type":"turn.done"})).await;}}else if let Some(id)=reply.clone(){let pending=std::mem::take(&mut calls);let tx=tx.clone();let app=app.clone();let chat=chat.clone();let request=user.clone();let token=turn_cancel.clone();let note=text.clone();send(&mut socket,json!({"type":"state","state":"working"})).await;tokio::spawn(async move{let mut output=Vec::new();for call in pending{if token.is_cancelled(){return;}let name=call["name"].as_str().unwrap_or("");let args:Value=serde_json::from_str(call["arguments"].as_str().unwrap_or("{}")).unwrap_or(json!({}));let result=if tools::descriptors(app.backends.running("browser"), app.backends.running("omni")).get(name).is_some(){agent_tools::run(&app,&chat,&id,&json!({"name":name,"args":args}),&note,&request,"omni",&token).await.unwrap_or_else(|e|format!("error: {e}"))}else{"Unknown tool.".into()};output.push((call["call_id"].as_str().unwrap_or("").to_owned(),result));}let _=tx.send(AsyncEvent::Tools(id,output));});}},
                "error"=>{send(&mut socket,json!({"type":"error","message":event["error"]["message"].as_str().unwrap_or("Voice error.")})).await;},_=>{}
            }},
            event=rx.recv()=>{match event {
                Some(AsyncEvent::Transcription(uid,result))=>{let result=if result.is_empty(){"(voice message)".to_owned()}else{result};let _=edit(&app,&chat,|c|{if let Some(m)=c["messages"].as_array_mut().and_then(|v|v.iter_mut().find(|m|m["id"]==uid)){m["content"]=json!(result);}});send(&mut socket,json!({"type":"user","text":result})).await;},
                Some(AsyncEvent::Tools(id,outputs))=>{if reply.as_ref()!=Some(&id) || turn_cancel.is_cancelled(){continue;}for (call_id,output) in outputs {up!(json!({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":call_id,"output":output}}));}up!(json!({"type":"response.create"}));responding=true;send(&mut socket,json!({"type":"state","state":"thinking"})).await;},
                Some(AsyncEvent::Camera(seq,description))=>{if !description.is_empty(){seen=(seq,description);}camera_busy=false;if let Some(frame)=queued_frame.take(){camera_busy=true;let tx=tx.clone();let url=url.to_owned();tokio::spawn(async move{let _=tx.send(AsyncEvent::Camera(frame.0,describe(url,frame.1).await.unwrap_or_default()));});}},None=>break
            }},
            event=events.recv()=>{if let Ok(event)=event{if let Ok(value)=serde_json::from_str::<Value>(&event){if value["type"]=="chat" && value["chat"]["id"]==chat {if let Some(id)=reply.as_deref(){if let Some(step)=value["chat"]["messages"].as_array().and_then(|v|v.iter().find(|m|m["id"]==id)).and_then(|m|m["steps"].as_array()).and_then(|v|v.last()){send(&mut socket,json!({"type":"tool","label":step["label"],"status":step["status"]})).await;}}}}}}
        }
    }
    session_cancel.cancel();
    turn_cancel.cancel();
    if let Some(id) = reply {
        finish(&app, &chat, &id, "stopped");
    }
    let _ = upstream.close(None).await;
    let active = {
        let mut running = app.running.lock().unwrap();
        running.remove(&chat);
        running.keys().cloned().collect::<Vec<_>>()
    };
    app.emit(json!({"type":"running","running":active}));
    let mut chats = app.chats.lock().unwrap();
    if chats.iter().any(|c| {
        c["id"] == chat
            && c["source"] == "voice"
            && c["messages"].as_array().is_some_and(|v| v.is_empty())
    }) {
        let mut next = chats.clone();
        next.retain(|c| c["id"] != chat);
        if store::save(&app.data, "chats.json", &json!(next)).is_ok() {
            *chats = next;
            app.emit(json!({"type":"chat.deleted","id":chat}));
        }
    }
}
