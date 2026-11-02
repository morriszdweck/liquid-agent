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
/// Changes one voice chat and saves it. Only that chat is copied, and the list is written once.
fn edit(app: &App, id: &str, f: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let mut chats = app.chats.lock().unwrap();
    let index = chats
        .iter()
        .position(|c| c["id"] == id)
        .ok_or_else(|| anyhow::anyhow!("Voice chat no longer exists"))?;
    let mut chat = chats[index].clone();
    f(&mut chat);
    chat["updatedAt"] = json!(now());
    let previous = std::mem::replace(&mut chats[index], chat.clone());
    if let Err(e) = store::save_array(&app.data, "chats.json", &chats) {
        chats[index] = previous;
        return Err(e.into());
    }
    drop(chats);
    app.emit(json!({"type":"chat","chat":chat}));
    Ok(())
}
/// Shows a streamed reply to the chat window as it grows. It is saved when the turn ends, as text chat does,
/// because saving the whole history for every word is most of the work of a long reply.
fn stream(app: &App, chat: &str, reply: &str, text: &str) {
    app.emit(json!({"type":"delta","chatId":chat,"messageId":reply,"text":text}));
}
fn make_chat(app: &App, requested: Option<&str>) -> anyhow::Result<String> {
    let mut chats = app.chats.lock().unwrap();
    if let Some(chat) = requested.and_then(|id| chats.iter().find(|c| c["id"] == id)) {
        return Ok(chat["id"].as_str().unwrap().to_owned());
    }
    let id = store::id();
    let stamp = now();
    let chat = json!({"id":id,"title":"Voice chat","source":"voice","named":true,"createdAt":stamp,"updatedAt":stamp,"pinned":false,"messages":[]});
    chats.insert(0, chat.clone());
    if let Err(e) = store::save_array(&app.data, "chats.json", &chats) {
        chats.remove(0);
        return Err(e.into());
    }
    drop(chats);
    app.emit(json!({"type":"chat","chat":chat}));
    Ok(id)
}
fn schema(browser: bool, vision: bool) -> Vec<Value> {
    tools::descriptors(browser, vision).as_object().unwrap().iter().map(|(name, desc)| {
        let params=desc["params"].as_array().unwrap(); let properties=params.iter().filter_map(|p|p["name"].as_str()).map(|n|(n.to_owned(),json!({"type":if name=="reminder" && n=="minutes" {"number"}else{"string"}}))).collect::<serde_json::Map<_,_>>();
        let required: Vec<_>=params.iter().filter(|p|p["required"]!=false).filter_map(|p|p["name"].as_str()).collect();
        json!({"type":"function","name":name,"description":name.replace('_'," "),"parameters":{"type":"object","properties":properties,"required":required}})
    }).collect()
}
/// Realtime speech is configured separately from text replies and the /tts endpoint.
fn speech_directive(settings: &Value) -> &'static str {
    match liquid_core::i18n::call_language(settings) {
        "en" => "Speak aloud in American English.",
        "en-gb" => "Speak aloud in British English.",
        "es" => "Speak aloud in Spanish.",
        "pt" => "Speak aloud in Portuguese.",
        "fr" => "Speak aloud in French.",
        "de" => "Speak aloud in German.",
        "it" => "Speak aloud in Italian.",
        "ja" => "Speak aloud in Japanese.",
        "zh" => "Speak aloud in Chinese.",
        _ => "Speak aloud in the same language as the user.",
    }
}
fn instructions(app: &App, chat: &str, settings: &Value) -> String {
    // The voice model answers in the language of the chat, in the words of that language.
    let mut voice_settings = settings.clone();
    if let Some(language) = settings["realtimeLanguage"]
        .as_str()
        .filter(|s| *s != "auto" && !s.is_empty())
    {
        voice_settings["language"] = json!(if language == "en-gb" { "en" } else { language });
    }
    let reply = liquid_core::i18n::reply_for(&voice_settings);
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
        "{voice} {}\n{}\n{facts_line}\n{}\n{recent}",
        reply.directive(),
        speech_directive(settings),
        strings.voice_earlier
    )
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
/// Ends a reply: saves what was said and how it ended.
fn finish(app: &App, chat: &str, reply: &str, status: &str, said: &str) {
    let _ = edit(app, chat, |c| {
        if let Some(m) = c["messages"]
            .as_array_mut()
            .and_then(|ms| ms.iter_mut().find(|m| m["id"] == reply))
        {
            m["content"] = json!(said);
            m["status"] = json!(status);
        }
    });
}
#[cfg(test)]
mod tests {
    #[test]
    fn realtime_speech_language_is_independent_from_reply_and_read_aloud() {
        let settings =
            serde_json::json!({"language":"en", "ttsLanguage":"pt", "realtimeLanguage":"es"});
        assert_eq!(
            super::speech_directive(&settings),
            "Speak aloud in Spanish."
        );
        assert_eq!(
            super::speech_directive(
                &serde_json::json!({"language":"es","realtimeLanguage":"auto"})
            ),
            super::speech_directive(&settings)
        );
        assert_eq!(
            super::speech_directive(&serde_json::json!({"realtimeLanguage":"auto"})),
            "Speak aloud in the same language as the user."
        );
    }
    use super::is_jpeg_base64;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    #[test]
    fn recognises_a_jpeg_from_its_first_base64_group() {
        let jpeg = BASE64.encode([0xff, 0xd8, 0xff, 0xe0, 0, 16, b'J', b'F']);
        assert!(is_jpeg_base64(&jpeg));
        assert!(!is_jpeg_base64(&BASE64.encode(b"\x89PNG\r\n")));
        assert!(!is_jpeg_base64(""));
        assert!(!is_jpeg_base64("not base64!"));
    }
}

/// A JPEG starts with FF D8 FF. The first base64 group is enough to tell, so a whole frame isn't decoded to check it.
fn is_jpeg_base64(image: &str) -> bool {
    image
        .get(..4)
        .and_then(|head| BASE64.decode(head).ok())
        .is_some_and(|bytes| bytes.starts_with(&[0xff, 0xd8]))
}
#[derive(Debug)]
enum AsyncEvent {
    Tools(String, Vec<(String, String)>),
    Camera(u64, String),
}
async fn describe(url: String, image: String) -> anyhow::Result<String> {
    let res=media::client()?.post(format!("{}/chat/completions",url.trim_end_matches('/'))).timeout(Duration::from_secs(20)).json(&json!({"model":"LFM3-Omni-2B","temperature":0,"max_tokens":120,"stream":false,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":format!("data:image/jpeg;base64,{image}")}},{"type":"text","text":"This is a frame from the user's camera during a voice call. In one or two short sentences, describe what it shows."}]}]})).send().await?.error_for_status()?;
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
    if !crate::backends::demand_omni(&app).await {
        send(&mut socket,json!({"type":"error","message":"Voice chat needs Eyes and ears. Set it up in Settings → Downloads."})).await;
        return;
    }
    let Some(model_use) = app.backends.begin_model_use() else {
        send(
            &mut socket,
            json!({"type":"error","message":"The model is changing. Try again shortly."}),
        )
        .await;
        return;
    };
    if !app.backends.running("omni") {
        send(
            &mut socket,
            json!({"type":"error","message":"Eyes and ears is not running."}),
        )
        .await;
        return;
    }
    if app.voice_calls.load(std::sync::atomic::Ordering::SeqCst)
        > app.backends.running_slots("omni").unwrap_or(1)
    {
        send(
            &mut socket,
            json!({"type":"error","message":"All Omni slots are occupied by voice calls."}),
        )
        .await;
        return;
    }
    let settings = app.settings.lock().unwrap().clone();
    if settings["voiceCallMode"] == "highQuality" {
        high_quality(app.clone(), socket, &start, settings, model_use).await;
        return;
    }
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
        let voice_chats = app.voice_chats.lock().unwrap();
        let mut running = app.running.lock().unwrap();
        if voice_chats.contains(&chat) || running.contains_key(&chat) {
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
    let camera_available = !app.omni_slots_busy()
        && app
            .backends
            .running_slots("omni")
            .is_some_and(|slots| slots > 1);
    let asr_language = liquid_core::i18n::call_asr_language(&settings).to_owned();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut events = app.events.subscribe();
    let mut input_rate = 16000u32;
    let mut output_rate = 24000u32;
    let mut heard = Vec::new();
    // The pinned realtime engine holds its inference slot until the session closes.
    // Keep a bounded queue and transcribe after the call instead of competing with it.
    let mut transcription_queue: Vec<(String, u32, Vec<u8>)> = Vec::new();
    let mut queued_audio_bytes = 0usize;
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
    let mut requested_session = json!({"instructions":instructions,"tools":schema(crate::backends::browser_available(&app),camera_available),"tool_choice":"auto","output_modalities":["text","audio"],"max_output_tokens":400});
    let mut session_retry = false;
    let mut session_ready = false;
    let mut created = false;
    let creation_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut ack_deadline: Option<tokio::time::Instant> = None;
    let requested_language = liquid_core::i18n::call_language(&settings).to_owned();
    let requested_voice = settings["voice"].as_str().unwrap_or("female").to_owned();
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
            _=tokio::time::sleep_until(creation_deadline), if !created=>{
                send(&mut socket,json!({"type":"error","message":"Voice service did not create a session in time."})).await;
                break;
            },
            _=async { if let Some(deadline)=ack_deadline { tokio::time::sleep_until(deadline).await } else { std::future::pending::<()>().await } }=>{
                ack_deadline=None;
                if !session_ready {
                    eprintln!("Realtime session: acknowledgment timed out; language={requested_language}, voice={requested_voice}; configuration unconfirmed");
                    send(&mut socket,json!({"type":"ready","inputRate":input_rate,"outputRate":output_rate,"cameraAvailable":camera_available,"chatId":chat,"configurationConfirmed":false,"toolsSupported":if session_retry {Some(false)} else {None},"voiceSupported":false,"effectiveLanguage":requested_language})).await;
                    send(&mut socket,json!({"type":"state","state":"listening"})).await;
                    session_ready=true;
                }
            },
            incoming=socket.recv()=>{let Some(Ok(message))=incoming else{break};match message {
                Message::Binary(bytes)=>{if !session_ready {continue;}if heard.len()+bytes.len()>input_rate as usize*2*60 {send(&mut socket,json!({"type":"error","message":"Voice input is too long."})).await;heard.clear();up!(json!({"type":"input_audio_buffer.clear"}));continue;} heard.extend_from_slice(&bytes);up!(json!({"type":"input_audio_buffer.append","audio":BASE64.encode(bytes)}));},
                Message::Text(raw)=>{let Ok(message)=serde_json::from_str::<Value>(&raw) else{continue};match message["type"].as_str().unwrap_or("") {
                    "stop"=>break,
                    "cancel"=>{heard.clear();turn_cancel.cancel();if responding && !discarding {up!(json!({"type":"response.cancel"})); discarding=true;} queued_response=false;calls.clear();if let Some(id)=reply.take(){finish(&app,&chat,&id,"stopped",&text);send(&mut socket,json!({"type":"turn.done"})).await;}send(&mut socket,json!({"type":"state","state":"listening"})).await;},
                    "frame"=>{if !camera_available || app.omni_slots_busy() {send(&mut socket,json!({"type":"error","message":"Camera requires two Omni slots; change the setting and restart Omni."})).await;continue;}if let Some(image)=message["image"].as_str().filter(|s|s.len()<3_000_000){if is_jpeg_base64(image) {camera_seq+=1;let frame=(camera_seq,image.to_owned());if camera_busy{queued_frame=Some(frame);}else{camera_busy=true;let tx=tx.clone();let url=url.to_owned();let model_use=model_use.clone();tokio::spawn(async move{let _model_use=model_use;let _=tx.send(AsyncEvent::Camera(frame.0,describe(url,frame.1).await.unwrap_or_default()));});}}}},
                    "text" | "commit"=>{if !session_ready {continue;}let is_audio=message["type"]=="commit";let spoken=if is_audio {"…".to_owned()} else {message["text"].as_str().unwrap_or("").trim().chars().take(8000).collect()};if spoken.is_empty(){continue;}if is_audio && heard.len()<input_rate as usize*2*3/10 {heard.clear();up!(json!({"type":"input_audio_buffer.clear"}));continue;}if let Some(id)=reply.take(){turn_cancel.cancel();finish(&app,&chat,&id,"stopped",&text);}turn_cancel=session_cancel.child_token();if responding && !discarding {up!(json!({"type":"response.cancel"}));discarding=true;}calls.clear();let Ok((uid,rid))=begin(&app,&chat,&spoken) else{break};user=spoken.clone();reply=Some(rid);text.clear();audio_bytes=0;
                        let note=if seen.0>0 {format!("(On camera right now: {})",seen.1)}else{String::new()};
                        if is_audio {let audio=std::mem::take(&mut heard);up!(json!({"type":"input_audio_buffer.commit"}));if !note.is_empty(){up!(json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":note}]}}));}if queued_audio_bytes.saturating_add(audio.len())<=32*1024*1024 {queued_audio_bytes+=audio.len();transcription_queue.push((uid,input_rate,audio));}else{let _=edit(&app,&chat,|c|{if let Some(m)=c["messages"].as_array_mut().and_then(|v|v.iter_mut().find(|m|m["id"]==uid)){m["content"]=json!("(voice message)");}});}}
                        else {let message=if note.is_empty(){spoken}else{format!("{spoken}\n\n{note}")};up!(json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":message}]}}));}
                        if discarding {queued_response=true;} else {up!(json!({"type":"response.create"}));responding=true;}send(&mut socket,json!({"type":"state","state":"thinking"})).await;
                    },_=>{}
                }},Message::Close(_)=>break,_=>{}
            }},
            event=upstream.next()=>{let raw=match event {Some(Ok(UpMessage::Text(raw)))=>raw,Some(Ok(UpMessage::Close(_))) | None | Some(Err(_))=>break,Some(Ok(_))=>continue};let Ok(event)=serde_json::from_str::<Value>(&raw) else{continue};match event["type"].as_str().unwrap_or(""){
                "session.created"=>{created=true;input_rate=event.pointer("/session/audio/input/format/rate").and_then(Value::as_u64).unwrap_or(16000).clamp(8000,96000) as u32;output_rate=event.pointer("/session/audio/output/format/rate").and_then(Value::as_u64).unwrap_or(24000).clamp(8000,96000) as u32;up!(json!({"type":"session.update","session":requested_session}));ack_deadline=Some(tokio::time::Instant::now()+Duration::from_secs(2));},
                "session.updated"=>{if !session_ready {ack_deadline=None;let accepted=requested_session.as_object().is_some_and(|fields|fields.iter().all(|(key,value)|event["session"].get(key)==Some(value)));let confirmed=accepted && !session_retry;let tools_supported=if session_retry {Some(false)} else {event["session"].get("tools").map(|tools|Some(tools)==requested_session.get("tools"))};eprintln!("Realtime session: requested language={requested_language}, voice={requested_voice}; instructions and accepted options confirmed={accepted}, full configuration confirmed={confirmed}, voice control unsupported");send(&mut socket,json!({"type":"ready","inputRate":input_rate,"outputRate":output_rate,"cameraAvailable":camera_available,"chatId":chat,"configurationConfirmed":confirmed,"toolsSupported":tools_supported,"voiceSupported":false,"effectiveLanguage":requested_language})).await;send(&mut socket,json!({"type":"state","state":"listening"})).await;session_ready=true;}},
                "response.output_text.delta"=>{if discarding {continue;}if let Some(id)=reply.as_deref(){text.push_str(event["delta"].as_str().unwrap_or(""));stream(&app,&chat,id,&text);send(&mut socket,json!({"type":"assistant","text":text})).await;}},
                "response.output_audio.delta"=>{if discarding {continue;}if reply.is_some(){if let Ok(bytes)=BASE64.decode(event["delta"].as_str().unwrap_or("")){audio_bytes+=bytes.len();if audio_bytes>output_rate as usize*2*45{up!(json!({"type":"response.cancel"}));}else{if audio_bytes==bytes.len(){send(&mut socket,json!({"type":"state","state":"speaking"})).await;}if socket.send(Message::Binary(bytes.into())).await.is_err(){break;}}}}},
                "response.function_call_arguments.done"=>{if !discarding {calls.push(event);}},
                "response.done"=>{responding=false;if discarding {discarding=false;calls.clear();if queued_response {queued_response=false;up!(json!({"type":"response.create"}));responding=true;}continue;}if event["response"]["status"]=="cancelled"{calls.clear();if let Some(id)=reply.take(){finish(&app,&chat,&id,"stopped",&text);send(&mut socket,json!({"type":"turn.done"})).await;}}else if calls.is_empty(){if let Some(id)=reply.take(){finish(&app,&chat,&id,"done",&text);send(&mut socket,json!({"type":"turn.done"})).await;}}else if let Some(id)=reply.clone(){let pending=std::mem::take(&mut calls);let tx=tx.clone();let app=app.clone();let chat=chat.clone();let request=user.clone();let token=turn_cancel.clone();let note=text.clone();let model_use=model_use.clone();send(&mut socket,json!({"type":"state","state":"working"})).await;tokio::spawn(async move{let _model_use=model_use;let mut output=Vec::new();for call in pending{if token.is_cancelled(){return;}let name=call["name"].as_str().unwrap_or("");let args:Value=serde_json::from_str(call["arguments"].as_str().unwrap_or("{}")).unwrap_or(json!({}));let result=if tools::descriptors(crate::backends::browser_available(&app), camera_available && !app.omni_slots_busy()).get(name).is_some(){agent_tools::run(&app,&chat,&id,&json!({"name":name,"args":args}),&note,&request,"omni",None,&token).await.unwrap_or_else(|e|format!("error: {e}"))}else{"Unknown tool.".into()};output.push((call["call_id"].as_str().unwrap_or("").to_owned(),result));}let _=tx.send(AsyncEvent::Tools(id,output));});}},
                "error"=>{if created && !session_ready && ack_deadline.is_some() {if !session_retry {session_retry=true;requested_session=json!({"instructions":instructions});eprintln!("Realtime session: configuration rejected; retrying instructions only; tools unavailable");up!(json!({"type":"session.update","session":requested_session}));ack_deadline=Some(tokio::time::Instant::now()+Duration::from_secs(2));}else{send(&mut socket,json!({"type":"error","message":"Voice service rejected the session configuration."})).await;break;}}else{send(&mut socket,json!({"type":"error","message":event["error"]["message"].as_str().unwrap_or("Voice error.")})).await;}},_=>{}
            }},
            event=rx.recv()=>{match event {
                Some(AsyncEvent::Tools(id,outputs))=>{if reply.as_ref()!=Some(&id) || turn_cancel.is_cancelled(){continue;}for (call_id,output) in outputs {up!(json!({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":call_id,"output":output}}));}up!(json!({"type":"response.create"}));responding=true;send(&mut socket,json!({"type":"state","state":"thinking"})).await;},
                Some(AsyncEvent::Camera(seq,description))=>{if !description.is_empty(){seen=(seq,description);}camera_busy=false;if let Some(frame)=queued_frame.take(){camera_busy=true;let tx=tx.clone();let url=url.to_owned();let model_use=model_use.clone();tokio::spawn(async move{let _model_use=model_use;let _=tx.send(AsyncEvent::Camera(frame.0,describe(url,frame.1).await.unwrap_or_default()));});}},None=>break
            }},
            event=events.recv()=>{if let Ok(event)=event{if let Some(value)=Some(&event).filter(|e|e.contains(r#""type":"chat""#)).and_then(|e|serde_json::from_str::<Value>(e).ok()){if value["type"]=="chat" && value["chat"]["id"]==chat {if let Some(id)=reply.as_deref(){if let Some(step)=value["chat"]["messages"].as_array().and_then(|v|v.iter().find(|m|m["id"]==id)).and_then(|m|m["steps"].as_array()).and_then(|v|v.last()){send(&mut socket,json!({"type":"tool","label":step["label"],"status":step["status"]})).await;}}}}}}
        }
    }
    session_cancel.cancel();
    turn_cancel.cancel();
    if let Some(id) = reply {
        finish(&app, &chat, &id, "stopped", &text);
    }
    let _ = upstream.close(None).await;
    drop(upstream);
    if !transcription_queue.is_empty() {
        let app = app.clone();
        let chat = chat.clone();
        let url = url.to_owned();
        let model_use = model_use.clone();
        tokio::spawn(async move {
            let _model_use = model_use;
            for (uid, rate, pcm) in transcription_queue {
                if !app.chats.lock().unwrap().iter().any(|c| c["id"] == chat) {
                    break;
                }
                let audio = media::pcm16_wav(&pcm, rate);
                let text = tokio::time::timeout(
                    Duration::from_secs(120),
                    media::completion(&url, &audio, &asr_language),
                )
                .await
                .ok()
                .and_then(Result::ok)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "(voice message)".to_owned());
                let _ = edit(&app, &chat, |c| {
                    if let Some(m) = c["messages"]
                        .as_array_mut()
                        .and_then(|v| v.iter_mut().find(|m| m["id"] == uid))
                    {
                        m["content"] = json!(text);
                    }
                });
            }
        });
    }
    let active = {
        let mut running = app.running.lock().unwrap();
        running.remove(&chat);
        running.keys().cloned().collect::<Vec<_>>()
    };
    app.emit(json!({"type":"running","running":active}));
    remove_empty_voice_chat(&app, &chat);
}

fn remove_empty_voice_chat(app: &App, chat: &str) {
    let mut chats = app.chats.lock().unwrap();
    if chats.iter().any(|c| {
        c["id"] == chat
            && c["source"] == "voice"
            && c["messages"].as_array().is_some_and(|v| v.is_empty())
    }) {
        let mut next = chats.clone();
        next.retain(|c| c["id"] != chat);
        if store::save_array(&app.data, "chats.json", &next).is_ok() {
            *chats = next;
            app.emit(json!({"type":"chat.deleted","id":chat}));
        }
    }
}

struct VoiceChatGuard(App, String);
impl Drop for VoiceChatGuard {
    fn drop(&mut self) {
        self.0.voice_chats.lock().unwrap().remove(&self.1);
    }
}

/// Runs each stage in order; the call reserves its Omni slot without keeping a
/// realtime websocket open, so ASR, chat and speech can share a single slot.
async fn high_quality(
    app: App,
    mut socket: WebSocket,
    start: &Value,
    settings: Value,
    _model_use: std::sync::Arc<crate::backends::ModelUseLease>,
) {
    let Some(url) = media::local_url(&settings) else {
        send(
            &mut socket,
            json!({"type":"error","message":"Invalid local model address."}),
        )
        .await;
        return;
    };
    let Ok(chat) = make_chat(&app, start["chatId"].as_str()) else {
        return;
    };
    let reserved = {
        let mut voice_chats = app.voice_chats.lock().unwrap();
        let running = app.running.lock().unwrap();
        !running.contains_key(&chat) && voice_chats.insert(chat.clone())
    };
    if !reserved {
        send(
            &mut socket,
            json!({"type":"error","message":"That chat is already active."}),
        )
        .await;
        return;
    }
    let _reservation = VoiceChatGuard(app.clone(), chat.clone());
    let language = liquid_core::i18n::call_language(&settings).to_owned();
    let asr = liquid_core::i18n::call_asr_language(&settings).to_owned();
    let voice = settings["voice"].as_str().unwrap_or("female").to_owned();
    send(&mut socket, json!({"type":"ready","inputRate":16000,"outputRate":24000,"cameraAvailable":true,"chatId":chat,"configurationConfirmed":true,"voiceSupported":true,"effectiveLanguage":language})).await;
    send(&mut socket, json!({"type":"state","state":"listening"})).await;
    let (commands, mut command_rx) =
        mpsc::unbounded_channel::<(u64, Vec<u8>, String, Option<String>, CancellationToken)>();
    let (tx, mut rx) = mpsc::unbounded_channel::<(u64, Value, Option<Vec<u8>>)>();
    let worker_app = app.clone();
    let worker_chat = chat.clone();
    let worker = tokio::spawn(async move {
        while let Some((id, pcm, typed, frame, cancel)) = command_rx.recv().await {
            if cancel.is_cancelled() {
                continue;
            }
            let result: anyhow::Result<()> = async {
                let heard = if !typed.is_empty() { typed } else {
                    let wav = media::pcm16_wav(&pcm, 16000);
                    tokio::select! { _=cancel.cancelled()=>return Ok(()), result=media::completion(url.as_str(), &wav, &asr)=>result? }
                };
                if heard.trim().is_empty() { anyhow::bail!("Could not hear any speech."); }
                let _ = tx.send((id, json!({"type":"user","text":heard}), None));
                let mut request = heard.clone();
                if let Some(image) = frame {
                    let description = tokio::select! { _=cancel.cancelled()=>return Ok(()), result=describe(url.to_string(), image)=>result.unwrap_or_default() };
                    if !description.is_empty() { request.push_str(&format!("\n\n(On camera right now: {description})")); }
                }
                let mut events = worker_app.events.subscribe();
                let response = crate::chat::send_voice(&worker_app, &worker_chat, &json!({"text":request}), &language);
                if !response.status().is_success() { anyhow::bail!("Could not start the voice reply (HTTP {}).", response.status()); }
                let answer = loop {
                    tokio::select! {
                        _=cancel.cancelled()=> {
                            crate::chat::stop(&worker_app, &worker_chat);
                            while worker_app.running.lock().unwrap().contains_key(&worker_chat) {
                                tokio::time::sleep(Duration::from_millis(25)).await;
                            }
                            return Ok(());
                        }
                        event=events.recv()=>{
                            let Ok(raw)=event else { anyhow::bail!("Voice reply event stream closed.") };
                            let Ok(event)=serde_json::from_str::<Value>(&raw) else {continue};
                            if event["type"]=="delta" && event["chatId"]==worker_chat {
                                let _=tx.send((id,json!({"type":"assistant","text":event["text"]}),None));
                            }
                            if event["type"]=="chat" && event["chat"]["id"]==worker_chat {
                                if let Some(last)=event["chat"]["messages"].as_array().and_then(|m|m.last()).filter(|m|m["role"]=="assistant") {
                                    if let Some(step)=last["steps"].as_array().and_then(|s|s.last()) {let _=tx.send((id,json!({"type":"tool","label":step["label"],"status":step["status"]}),None));}
                                    match last["status"].as_str() {
                                        Some("done")=>break last["content"].as_str().unwrap_or("").to_owned(),
                                        Some("error")=>anyhow::bail!("{}",last["error"].as_str().unwrap_or("Voice reply failed.")),
                                        Some("stopped")=>return Ok(()), _=>{}
                                    }
                                }
                            }
                        }
                    }
                };
                if answer.is_empty() { anyhow::bail!("Voice reply was empty."); }
                let speech_language = if language == "auto" { media::detected_speech_language(&answer).or_else(|| media::detected_speech_language(&heard)).unwrap_or("auto") } else { &language };
                let mut rate = None;
                for piece in speech_pieces(&answer) {
                    let wav = tokio::select! { _=cancel.cancelled()=>return Ok(()), result=media::synthesize(&url, &piece, &voice, speech_language)=>result? };
                    let format = media::wav_format(&wav).ok_or_else(||anyhow::anyhow!("Speech returned invalid audio."))?;
                    anyhow::ensure!(format.encoding==1 && format.channels==1 && format.bits==16 && format.rate>0, "Speech returned an unsupported audio format.");
                    anyhow::ensure!(rate.is_none_or(|old| old == format.rate), "Speech sample rate changed during the reply.");
                    let event = if rate.is_none() { json!({"type":"audio.format","rate":format.rate}) } else { json!({"type":"audio.chunk"}) };
                    rate = Some(format.rate);
                    let _=tx.send((id,event,Some(format.data.to_vec())));
                }
                Ok(())
            }.await;
            if !cancel.is_cancelled() {
                if let Err(error) = result {
                    let _ = tx.send((
                        id,
                        json!({"type":"error","message":error.to_string()}),
                        None,
                    ));
                }
                let _ = tx.send((id, json!({"type":"turn.done"}), None));
                let _ = tx.send((id, json!({"type":"state","state":"listening"}), None));
            }
        }
    });
    let mut heard = Vec::new();
    let mut frame = None;
    let mut sequence = 0u64;
    let mut active = CancellationToken::new();
    loop {
        tokio::select! {
            message=socket.recv()=>{
                let Some(Ok(message))=message else {break};
                match message {
                    Message::Binary(bytes)=>{if heard.len()+bytes.len()<=16000*2*60 {heard.extend_from_slice(&bytes)} else {heard.clear();send(&mut socket,json!({"type":"error","message":"Voice input is too long."})).await;}},
                    Message::Text(raw)=>{
                        let Ok(message)=serde_json::from_str::<Value>(&raw) else {continue};
                        match message["type"].as_str().unwrap_or("") {
                            "stop"=>break,
                            "cancel"=>{active.cancel();heard.clear();sequence+=1;send(&mut socket,json!({"type":"state","state":"listening"})).await;},
                            "frame"=>{frame=message["image"].as_str().filter(|s|s.len()<3_000_000 && is_jpeg_base64(s)).map(str::to_owned);},
                            "text"|"commit"=>{
                                let typed=message["text"].as_str().unwrap_or("").trim().chars().take(8000).collect::<String>();
                                if typed.is_empty() && heard.len()<16000*2*3/10 {heard.clear();continue;}
                                active.cancel();active=CancellationToken::new();sequence+=1;
                                let pcm=std::mem::take(&mut heard);
                                if commands.send((sequence,pcm,typed,frame.take(),active.clone())).is_err(){break;}
                                send(&mut socket,json!({"type":"state","state":"thinking"})).await;
                            }, _=>{}
                        }
                    }, Message::Close(_)=>break, _=>{}
                }
            },
            event=rx.recv()=>{
                let Some((id,event,audio))=event else {break};
                if id!=sequence {continue;}
                if !send(&mut socket,event).await {break;}
                if let Some(audio)=audio {
                    send(&mut socket,json!({"type":"state","state":"speaking"})).await;
                    if socket.send(Message::Binary(audio.into())).await.is_err(){break;}
                }
            }
        }
    }
    active.cancel();
    drop(commands);
    let _ = worker.await;
    remove_empty_voice_chat(&app, &chat);
}

/// Bound each synthesis request and start playback as soon as the first piece is ready.
fn speech_pieces(text: &str) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut piece = String::new();
    for word in text.split_whitespace() {
        if !piece.is_empty() && piece.chars().count() + word.chars().count() + 1 > 400 {
            pieces.push(std::mem::take(&mut piece));
        }
        if !piece.is_empty() {
            piece.push(' ');
        }
        piece.push_str(word);
        if piece.chars().count() >= 120 && word.ends_with(['.', '!', '?', '。', '！', '？']) {
            pieces.push(std::mem::take(&mut piece));
        }
    }
    if !piece.is_empty() {
        pieces.push(piece);
    }
    pieces
}
