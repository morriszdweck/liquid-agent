//! Dictation and speech through the local multimodal model.
use crate::{json_response, response, App};
use axum::{body::to_bytes, extract::Request, http::StatusCode, response::Response};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};

fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}

/// One HTTP client for every call to the model. Connections are reused, and the
/// TLS and pool setup isn't repeated for each sentence or camera frame.
pub(crate) fn client() -> anyhow::Result<reqwest::Client> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let built = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()?;
    Ok(CLIENT.get_or_init(|| built).clone())
}
pub(crate) fn local_url(settings: &Value) -> Option<url::Url> {
    let text = settings.get("omniURL")?.as_str()?;
    let parsed = url::Url::parse(text).ok()?;
    (liquid_core::settings::is_local(text) && ["http", "https"].contains(&parsed.scheme()))
        .then_some(parsed)
}
/// The model hears speech well for about 20 to 30 seconds. Past that it silently stops hearing the rest, so a longer
/// recording is cut into pieces of at most SEGMENT_SECONDS. Each cut is made at the quietest moment between
/// CUT_FROM_SECONDS and the end of the piece, so no word is split, and the pieces are transcribed in turn.
const SEGMENT_SECONDS: f64 = 20.0;
const CUT_FROM_SECONDS: f64 = 12.0;
/// The length of the stretch that is measured for quietness when choosing a cut.
const FRAME_SECONDS: f64 = 0.2;

pub(crate) async fn completion(url: &str, audio: &[u8], language: &str) -> anyhow::Result<String> {
    let Some((rate, pcm, cuts)) = split_plan(audio) else {
        return transcribe_piece(url, audio, language).await;
    };
    let mut parts = Vec::with_capacity(cuts.len());
    for (start, end) in cuts {
        let text = transcribe_piece(url, &pcm16_wav(&pcm[start..end], rate), language).await?;
        if !text.is_empty() {
            parts.push(text);
        }
    }
    Ok(parts.join(" "))
}

async fn transcribe_piece(url: &str, audio: &[u8], language: &str) -> anyhow::Result<String> {
    let prompt = match language {
        "ar" => "Perform ASR in Arabic.",
        "da" => "Perform ASR in Danish.",
        "el" => "Perform ASR in Greek.",
        "en" | "en-gb" => "Perform ASR in English.",
        "es" => "Perform ASR in Spanish.",
        "pt" => "Perform ASR in Portuguese.",
        "fr" => "Perform ASR in French.",
        "de" => "Perform ASR in German.",
        "fi" => "Perform ASR in Finnish.",
        "he" => "Perform ASR in Hebrew.",
        "it" => "Perform ASR in Italian.",
        "ja" => "Perform ASR in Japanese.",
        "ko" => "Perform ASR in Korean.",
        "nl" => "Perform ASR in Dutch.",
        "pl" => "Perform ASR in Polish.",
        "sv" => "Perform ASR in Swedish.",
        "tr" => "Perform ASR in Turkish.",
        "zh" => "Perform ASR in Chinese.",
        _ => "Perform ASR.",
    };
    complete(url, json!([{"role":"system","content":prompt},{"role":"user","content":[{"type":"input_audio","input_audio":{"data":BASE64.encode(audio),"format":"wav"}}]}]), transcript_budget(audio)).await
}

/// Where a recording is cut, as byte ranges of its PCM data: the sample rate, the data, and the ranges.
/// None when the clip is short enough to send whole, or isn't 16-bit mono PCM WAV that can be cut.
fn split_plan(audio: &[u8]) -> Option<(u32, &[u8], Vec<(usize, usize)>)> {
    let format = wav_format(audio)?;
    if format.encoding != 1
        || format.channels != 1
        || format.bits != 16
        || format.rate == 0
        || format.data.len() % 2 != 0
    {
        return None;
    }
    let rate = format.rate as usize;
    if format.data.len() / 2 <= (SEGMENT_SECONDS * rate as f64) as usize {
        return None;
    }
    let samples: Vec<i16> = format
        .data
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    let cuts = plan_cuts(&samples, rate)
        .into_iter()
        .map(|(start, end)| (start * 2, end * 2))
        .collect();
    Some((format.rate, format.data, cuts))
}

/// Sample ranges of at most SEGMENT_SECONDS, each ending at the quietest frame of its last part.
pub(crate) fn plan_cuts(samples: &[i16], rate: usize) -> Vec<(usize, usize)> {
    let max = (SEGMENT_SECONDS * rate as f64) as usize;
    let first = (CUT_FROM_SECONDS * rate as f64) as usize;
    let frame = ((FRAME_SECONDS * rate as f64) as usize).max(2);
    let step = (frame / 2).max(1);
    let energy = |at: usize| -> i64 {
        samples[at..at + frame]
            .iter()
            .map(|s| (*s as i64) * (*s as i64))
            .sum()
    };
    let mut cuts = Vec::new();
    let mut start = 0;
    while samples.len() - start > max {
        // The last frame must end inside the piece, so the cut is at most `max - frame` after the start.
        let (lo, hi) = (start + first, start + max - frame);
        let at = (lo..=hi)
            .step_by(step)
            .min_by_key(|at| energy(*at))
            .unwrap_or(hi);
        cuts.push((start, at));
        start = at;
    }
    cuts.push((start, samples.len()));
    cuts
}

/// A WAV file's format and its PCM data, read from its header.
pub(crate) struct WavFormat<'a> {
    pub(crate) encoding: u16,
    pub(crate) rate: u32,
    pub(crate) channels: u16,
    pub(crate) bits: u16,
    pub(crate) data: &'a [u8],
}

pub(crate) fn wav_format(bytes: &[u8]) -> Option<WavFormat<'_>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let (mut at, mut format, mut data) = (12usize, None, None);
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?) as usize;
        let body = at + 8;
        match id {
            b"fmt " if size >= 16 && body + 16 <= bytes.len() => {
                let field = |offset: usize, len: usize| &bytes[body + offset..body + offset + len];
                format = Some((
                    u16::from_le_bytes(field(0, 2).try_into().ok()?),
                    u16::from_le_bytes(field(2, 2).try_into().ok()?),
                    u32::from_le_bytes(field(4, 4).try_into().ok()?),
                    u16::from_le_bytes(field(14, 2).try_into().ok()?),
                ));
            }
            // A header can claim more than the file holds, as a streamed WAV does; count what is there.
            b"data" => data = Some(&bytes[body..(body + size).min(bytes.len())]),
            _ => {}
        }
        at = body + size + (size & 1);
    }
    let (encoding, channels, rate, bits) = format?;
    Some(WavFormat {
        encoding,
        rate,
        channels,
        bits,
        data: data?,
    })
}

/// 16-bit PCM mono WAV around the samples: the format the model and the speech checks read.
pub(crate) fn pcm16_wav(pcm: &[u8], rate: u32) -> Vec<u8> {
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

pub(crate) async fn vision(
    url: &str,
    image: &[u8],
    mime: &str,
    question: &str,
) -> anyhow::Result<String> {
    complete(url, json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":format!("data:{mime};base64,{}",BASE64.encode(image))}},{"type":"text","text":question}]}]), 600).await
}

/// How many tokens a transcript of this clip may need. Speech takes about 3 to 4 tokens a second in English
/// and more in other languages, so the budget grows with the clip. A fixed budget cut long dictations off mid-sentence.
pub(crate) fn transcript_budget(audio: &[u8]) -> u32 {
    let seconds = wav_seconds(audio).unwrap_or(0.0);
    ((seconds * 8.0) as u32 + 128).clamp(512, 4096)
}

/// The length of a WAV clip in seconds, from its header. None if it isn't a WAV file.
pub(crate) fn wav_seconds(bytes: &[u8]) -> Option<f64> {
    let format = wav_format(bytes)?;
    let bytes_per_second = format.rate as f64 * format.channels as f64 * (format.bits as f64 / 8.0);
    (bytes_per_second > 0.0).then(|| format.data.len() as f64 / bytes_per_second)
}

/// Reads the server-sent events of a streamed completion and keeps the text they carry.
#[derive(Default)]
pub(crate) struct Transcript {
    buffer: Vec<u8>,
    text: String,
}
impl Transcript {
    /// Takes the next piece of the response. Returns false once the stream says it has finished.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> anyhow::Result<bool> {
        self.buffer.extend_from_slice(chunk);
        while let Some(pos) = self.buffer.iter().position(|b| *b == b'\n') {
            let line = String::from_utf8_lossy(&self.buffer[..pos])
                .trim()
                .to_owned();
            self.buffer.drain(..=pos);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                return Ok(false);
            }
            if let Some(part) = serde_json::from_str::<Value>(data).ok().and_then(|event| {
                event
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }) {
                self.text.push_str(&part);
            }
            anyhow::ensure!(
                self.text.len() < 4 * 1024 * 1024 && self.buffer.len() < 4 * 1024 * 1024,
                "The dictation response is too large."
            );
        }
        Ok(true)
    }
    /// The transcript, without the quotes a model sometimes wraps around it.
    pub(crate) fn finish(self) -> String {
        let text = self.text.trim();
        let text = text.strip_prefix(['"', '“']).unwrap_or(text);
        text.strip_suffix(['"', '”'])
            .unwrap_or(text)
            .trim()
            .to_owned()
    }
}

async fn complete(url: &str, messages: Value, max_tokens: u32) -> anyhow::Result<String> {
    let res=client()?.post(format!("{}/chat/completions",url.trim_end_matches('/'))).json(&json!({"model":"LFM3-Omni-2B","temperature":0,"max_tokens":max_tokens,"stream":true,"stream_options":{"include_usage":true},"cache_prompt":true,"chat_template_kwargs":{"enable_thinking":false},"messages":messages})).send().await?;
    anyhow::ensure!(
        res.status().is_success(),
        "Dictation failed (HTTP {}).",
        res.status().as_u16()
    );
    let mut stream = res.bytes_stream();
    let mut transcript = Transcript::default();
    while let Some(chunk) = stream.next().await {
        if !transcript.push(&chunk?)? {
            break;
        }
    }
    Ok(transcript.finish())
}
pub async fn transcribe(app: &App, request: Request) -> Response {
    let bytes = match to_bytes(request.into_body(), 25 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "That request is too big."),
    };
    if bytes.is_empty() {
        return error(StatusCode::BAD_REQUEST, "The audio is empty.");
    }
    if !crate::backends::demand_omni(app).await {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Dictation needs Eyes and ears. Set it up in Settings → Downloads.",
        );
    }
    if app.omni_slots_busy() {
        return error(
            StatusCode::CONFLICT,
            "Omni is busy with a voice call. End the call or configure another Omni slot.",
        );
    }
    let Some(_model_use) = app.backends.begin_model_use() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The model is changing. Try again shortly.",
        );
    };
    if !app.backends.running("omni") {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Eyes and ears is not running.",
        );
    }
    let settings = app.settings.lock().unwrap().clone();
    let Some(url) = local_url(&settings) else {
        return error(
            StatusCode::BAD_REQUEST,
            "Refusing a model address that isn't on this computer.",
        );
    };
    match completion(
        url.as_str(),
        &bytes,
        settings["asrLanguage"].as_str().unwrap_or("auto"),
    )
    .await
    {
        Ok(text) => json_response(StatusCode::OK, json!({"text":text})),
        Err(e) => error(StatusCode::BAD_GATEWAY, &e.to_string()),
    }
}
/// Read-aloud clips are heard again and checked against the text. The model sometimes drifts into English
/// or garbles a loanword, so a clip that doesn't match is made again, up to this many times in all.
const SPEECH_TRIES: usize = 3;
/// How closely the heard words must match the text, from 0 to 1.
const SPEECH_MATCH: f64 = 0.8;
pub(crate) const SPEECH_LANGUAGES: &[&str] = &[
    "auto", "default", "ar", "da", "de", "el", "en", "en-gb", "es", "fi", "fr", "he", "it", "ja",
    "ko", "nl", "pl", "pt", "sv", "tr", "zh",
];
/// Only use a supported detected language when there is enough text and strong evidence.
fn detected_speech_language(text: &str) -> Option<&'static str> {
    if text.chars().filter(|c| c.is_alphabetic()).count() < 20 {
        return None;
    }
    let info = whatlang::detect(text)?;
    if !info.is_reliable() {
        return None;
    }
    match info.lang() {
        whatlang::Lang::Eng => Some("en"),
        whatlang::Lang::Spa => Some("es"),
        whatlang::Lang::Por => Some("pt"),
        whatlang::Lang::Fra => Some("fr"),
        whatlang::Lang::Deu => Some("de"),
        whatlang::Lang::Ita => Some("it"),
        whatlang::Lang::Jpn => Some("ja"),
        whatlang::Lang::Cmn => Some("zh"),
        _ => None,
    }
}
pub async fn speak(app: &App, request: Request) -> Response {
    let bytes = match to_bytes(request.into_body(), 1_000_000).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "That request is too big."),
    };
    let body: Value = if bytes.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return error(StatusCode::BAD_REQUEST, "Bad JSON."),
        }
    };
    let text = body["text"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(1200)
        .collect::<String>();
    if text.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "The text is empty.");
    }
    if body.get("lang").is_some()
        && !body["lang"]
            .as_str()
            .is_some_and(|lang| SPEECH_LANGUAGES.contains(&lang))
    {
        return error(StatusCode::BAD_REQUEST, "Unsupported speech language.");
    }
    if !crate::backends::demand_omni(app).await {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Reading aloud needs Eyes and ears. Set it up in Settings → Downloads.",
        );
    }
    if app.omni_slots_busy() {
        return error(
            StatusCode::CONFLICT,
            "Omni is busy with a voice call. End the call or configure another Omni slot.",
        );
    }
    let Some(_model_use) = app.backends.begin_model_use() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The model is changing. Try again shortly.",
        );
    };
    if !app.backends.running("omni") {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Eyes and ears is not running.",
        );
    }
    let settings = app.settings.lock().unwrap().clone();
    let Some(url) = local_url(&settings) else {
        return error(
            StatusCode::BAD_REQUEST,
            "Refusing a model address that isn't on this computer.",
        );
    };
    let voice = body["voice"]
        .as_str()
        .filter(|v| ["male", "female"].contains(v))
        .or_else(|| settings["voice"].as_str())
        .unwrap_or("female");
    let lang = body["lang"]
        .as_str()
        .unwrap_or_else(|| settings["ttsLanguage"].as_str().unwrap_or("auto"));
    if !SPEECH_LANGUAGES.contains(&lang) {
        return error(StatusCode::BAD_REQUEST, "Unsupported speech language.");
    }
    let language_context: String = body["languageText"]
        .as_str()
        .unwrap_or(&text)
        .chars()
        .take(8000)
        .collect();
    let lang = match lang {
        "auto" => detected_speech_language(&text)
            .or_else(|| detected_speech_language(&language_context))
            .unwrap_or("auto"),
        "default" => "auto",
        other => other,
    };
    let verify = settings["verifySpeech"].as_bool().unwrap_or(false);
    let result = if verify {
        speak_checked(&url, &text, voice, lang).await
    } else {
        synthesize(&url, &text, voice, lang).await
    };
    match result {
        Ok(wav) => response(StatusCode::OK, "audio/wav", wav),
        Err(e) => error(StatusCode::BAD_GATEWAY, &e.to_string()),
    }
}

/// The model leaves about a quarter second of silence at each end of a clip. Read aloud, each sentence is its own
/// clip, so that silence stacks into a long gap between sentences. Clips are trimmed to this much on each side.
const EDGE_PAD_SECONDS: f64 = 0.08;
/// Frames quieter than this (RMS, as a fraction of full scale, -40 dBFS) count as silence.
const SILENCE_RMS: f64 = 0.01;
const LEVEL_FRAME_SECONDS: f64 = 0.02;

/// A speech clip with its leading and trailing silence cut to EDGE_PAD_SECONDS. Anything that isn't 16-bit mono
/// PCM WAV, or has no sound in it, is returned unchanged.
pub(crate) fn trim_silence(wav: Vec<u8>) -> Vec<u8> {
    let Some(format) = wav_format(&wav) else {
        return wav;
    };
    if format.encoding != 1
        || format.channels != 1
        || format.bits != 16
        || format.rate == 0
        || format.data.len() % 2 != 0
    {
        return wav;
    }
    let rate = format.rate as usize;
    let frame = ((LEVEL_FRAME_SECONDS * rate as f64) as usize).max(1);
    let loud = |f: &[u8]| -> bool {
        let sum: f64 = f
            .chunks_exact(2)
            .map(|b| {
                let x = i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0;
                x * x
            })
            .sum();
        (sum / (f.len() / 2).max(1) as f64).sqrt() > SILENCE_RMS
    };
    let frames: Vec<&[u8]> = format.data.chunks(frame * 2).collect();
    let (Some(first), Some(last)) = (
        frames.iter().position(|f| loud(f)),
        frames.iter().rposition(|f| loud(f)),
    ) else {
        return wav;
    };
    let pad = (EDGE_PAD_SECONDS * rate as f64) as usize * 2;
    let start = (first * frame * 2).saturating_sub(pad);
    let end = ((last + 1) * frame * 2 + pad).min(format.data.len());
    pcm16_wav(&format.data[start..end], format.rate)
}

/// One clip from the model's speech route, in the chosen voice.
pub(crate) async fn synthesize(
    url: &url::Url,
    text: &str,
    voice: &str,
    lang: &str,
) -> anyhow::Result<Vec<u8>> {
    let mut body = json!({"input":text,"voice":voice});
    if lang != "auto" {
        body["lang"] = json!(lang);
    }
    let res = client()?
        .post(format!("{}/tts", url.origin().ascii_serialization()))
        .json(&body)
        .send()
        .await?;
    anyhow::ensure!(
        res.status().is_success(),
        "Speech failed (HTTP {}).",
        res.status().as_u16()
    );
    let mut stream = res.bytes_stream();
    let mut wav = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        anyhow::ensure!(
            wav.len() + bytes.len() <= 50 * 1024 * 1024,
            "Speech response is too large."
        );
        wav.extend_from_slice(&bytes);
    }
    Ok(trim_silence(wav))
}

/// The clip that sounds closest to the text, made again while it doesn't match.
async fn speak_checked(
    url: &url::Url,
    text: &str,
    voice: &str,
    lang: &str,
) -> anyhow::Result<Vec<u8>> {
    let mut best: Option<(f64, Vec<u8>)> = None;
    for _ in 0..SPEECH_TRIES {
        let wav = synthesize(url, text, voice, lang).await?;
        // If the model can't hear the clip back, there is nothing to check it against: keep it.
        let score = match completion(url.as_str(), &wav, lang).await {
            Ok(heard) => similarity(text, &heard),
            Err(_) => 1.0,
        };
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, wav));
        }
        if score >= SPEECH_MATCH {
            break;
        }
    }
    Ok(best.map(|(_, wav)| wav).unwrap_or_default())
}

/// Number words in the languages the app speaks. The model may write "100" for "one hundred", or spell
/// out a number it was given as digits, and both are the same speech, so these words are left out of the check.
const NUMBER_WORDS: &[&str] = &[
    // English
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
    "hundred",
    "thousand",
    "million",
    // Spanish
    "cero",
    "uno",
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "seis",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "once",
    "doce",
    "trece",
    "catorce",
    "quince",
    "veinte",
    "treinta",
    "cuarenta",
    "cincuenta",
    "sesenta",
    "setenta",
    "ochenta",
    "noventa",
    "cien",
    "ciento",
    "mil",
    "millón",
    "millones",
    // Portuguese
    "um",
    "uma",
    "dois",
    "duas",
    "três",
    "quatro",
    "cinco",
    "seis",
    "sete",
    "oito",
    "nove",
    "dez",
    "onze",
    "doze",
    "vinte",
    "trinta",
    "quarenta",
    "cinquenta",
    "sessenta",
    "setenta",
    "oitenta",
    "noventa",
    "cem",
    "mil",
    "milhão",
    "milhões",
    // French
    "zéro",
    "un",
    "une",
    "deux",
    "trois",
    "quatre",
    "cinq",
    "six",
    "sept",
    "huit",
    "neuf",
    "dix",
    "onze",
    "douze",
    "treize",
    "quatorze",
    "quinze",
    "seize",
    "vingt",
    "trente",
    "quarante",
    "cinquante",
    "soixante",
    "cent",
    "mille",
    "million",
    // German
    "null",
    "eins",
    "ein",
    "eine",
    "zwei",
    "drei",
    "vier",
    "fünf",
    "sechs",
    "sieben",
    "acht",
    "neun",
    "zehn",
    "elf",
    "zwölf",
    "zwanzig",
    "dreißig",
    "vierzig",
    "fünfzig",
    "sechzig",
    "siebzig",
    "achtzig",
    "neunzig",
    "hundert",
    "tausend",
    // Italian
    "zero",
    "uno",
    "una",
    "due",
    "tre",
    "quattro",
    "cinque",
    "sei",
    "sette",
    "otto",
    "nove",
    "dieci",
    "undici",
    "dodici",
    "venti",
    "trenta",
    "quaranta",
    "cinquanta",
    "sessanta",
    "settanta",
    "ottanta",
    "novanta",
    "cento",
    "mille",
];

/// How much of the text was heard back, from 0 to 1: the share of its words' letters that appear, in order, in
/// the transcript. Case, spacing, punctuation, digits and number words are ignored, so "100" and "one hundred"
/// do not count as a mismatch. Words the transcript adds don't lower the score; only missing or changed words do,
/// which is what drift into another language or a garbled loanword looks like.
pub(crate) fn similarity(text: &str, heard: &str) -> f64 {
    let letters = |t: &str| -> Vec<char> {
        t.split(|c: char| !c.is_alphabetic())
            .filter(|word| !word.is_empty())
            .map(str::to_lowercase)
            .filter(|word| !NUMBER_WORDS.contains(&word.as_str()))
            .flat_map(|word| word.chars().collect::<Vec<_>>())
            .collect()
    };
    let (a, b) = (letters(text), letters(heard));
    if a.is_empty() {
        // Nothing but numbers and symbols: there is no word to check.
        return 1.0;
    }
    if b.is_empty() {
        return 0.0;
    }
    // Length of the longest common subsequence, two rows at a time.
    let mut prev = vec![0usize; b.len() + 1];
    let mut row = vec![0usize; b.len() + 1];
    for x in &a {
        for (j, y) in b.iter().enumerate() {
            row[j + 1] = if x == y {
                prev[j] + 1
            } else {
                prev[j + 1].max(row[j])
            };
        }
        std::mem::swap(&mut prev, &mut row);
    }
    prev[b.len()] as f64 / a.len() as f64
}

#[cfg(test)]
mod tests {
    use super::{detected_speech_language, similarity, transcript_budget, wav_seconds, Transcript};
    #[test]
    fn speech_language_detection_requires_enough_supported_text() {
        assert_eq!(detected_speech_language("Hola"), None);
        assert_eq!(detected_speech_language("Esta es una frase en español que contiene suficientes palabras para reconocer correctamente el idioma del mensaje completo."), Some("es"));
        assert_eq!(detected_speech_language("This is an English sentence with enough words to identify the language reliably for the spoken message."), Some("en"));
    }

    /// A 16-bit mono WAV of `seconds` at `rate`, with a header like the ones the app records and plays.
    fn wav(rate: u32, seconds: u32) -> Vec<u8> {
        let data = rate * 2 * seconds;
        let mut out = b"RIFF".to_vec();
        out.extend((36 + data).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(rate.to_le_bytes());
        out.extend((rate * 2).to_le_bytes());
        out.extend(2u16.to_le_bytes());
        out.extend(16u16.to_le_bytes());
        out.extend(b"data");
        out.extend(data.to_le_bytes());
        out.extend(vec![0u8; data as usize]);
        out
    }

    #[test]
    fn matches_the_words_and_ignores_case_and_punctuation() {
        assert_eq!(similarity("Hola, ¿que tal?", "hola que tal"), 1.0);
        assert!(
            similarity(
                "Die Datei liegt im Ordner Downloads.",
                "Hi, I downloaded them and I opened them yesterday."
            ) < 0.8
        );
        assert!(
            similarity(
                "Guten Morgen, wie geht es dir?",
                "Guten Morgen, wie geht es dir heute?"
            ) >= 0.8
        );
        assert_eq!(similarity("", ""), 1.0);
        assert_eq!(similarity("abc", ""), 0.0);
    }

    #[test]
    fn a_number_written_as_digits_or_as_words_is_the_same() {
        assert_eq!(
            similarity(
                "Water boils at 100 degrees.",
                "water boils at one hundred degrees"
            ),
            1.0
        );
        assert_eq!(
            similarity("Leaves every 20 minutes", "leaves every twenty minutes"),
            1.0
        );
        assert_eq!(
            similarity("Dos cafés, por favor", "2 cafés, por favor"),
            1.0
        );
        assert_eq!(similarity("Vier Stühle", "4 Stühle"), 1.0);
        // Numbers alone have no words to check.
        assert_eq!(similarity("42 7", "forty two seven"), 1.0);
    }

    #[test]
    fn a_heard_word_that_is_missing_or_changed_lowers_the_score() {
        // Words the transcript adds don't count against it; words it drops or changes do.
        assert_eq!(
            similarity("Save the report.", "Save the report on Friday"),
            1.0
        );
        assert!(
            similarity(
                "Save the report in the Downloads folder.",
                "Save the report folder."
            ) < 0.8
        );
        assert!(similarity("Please save the report.", "Please safe the rapport.") < 1.0);
    }

    #[test]
    fn reads_the_length_of_a_clip_from_its_header() {
        assert_eq!(wav_seconds(&wav(16000, 3)), Some(3.0));
        assert_eq!(wav_seconds(&wav(24000, 1)), Some(1.0));
        assert_eq!(wav_seconds(b"not a wav file at all"), None);
    }

    #[test]
    fn a_long_dictation_gets_room_for_its_whole_transcript() {
        // Short clips keep the old floor; a minute of speech needs far more than 512 tokens.
        assert_eq!(transcript_budget(&wav(16000, 1)), 512);
        assert_eq!(transcript_budget(&wav(16000, 120)), 1088);
        assert_eq!(transcript_budget(&wav(8000, 600)), 4096);
        assert_eq!(transcript_budget(b"unknown"), 512);
    }

    #[test]
    fn collects_text_from_events_split_across_network_chunks() {
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"\\\"Hello \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n",
            "data: [DONE]\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ignored\"}}]}\n",
        );
        let mut transcript = Transcript::default();
        let bytes = stream.as_bytes();
        // Cut the stream at awkward places: inside a line, and inside a multi-byte character.
        let mut keep_going = true;
        for piece in bytes.chunks(7) {
            if !transcript.push(piece).unwrap() {
                keep_going = false;
                break;
            }
        }
        assert!(!keep_going, "the stream reported its end");
        assert_eq!(transcript.finish(), "Hello world");
    }

    #[test]
    fn strips_quotes_and_ignores_lines_that_are_not_events() {
        let mut transcript = Transcript::default();
        transcript
            .push("event: ping\n: comment\ndata: {\"choices\":[{\"delta\":{\"content\":\"“Café ☕”\"}}]}\n".as_bytes())
            .unwrap();
        assert_eq!(transcript.finish(), "Café ☕");
    }

    /// Speech-like samples: a loud tone, with a quiet gap at `gap` seconds.
    fn speech_with_pause(seconds: usize, gap: Option<f64>) -> Vec<i16> {
        let rate = 16000usize;
        (0..seconds * rate)
            .map(|i| {
                let t = i as f64 / rate as f64;
                if gap.is_some_and(|g| (g..g + 0.5).contains(&t)) {
                    0
                } else {
                    (8000.0 * (t * 440.0 * std::f64::consts::TAU).sin()) as i16
                }
            })
            .collect()
    }

    #[test]
    fn short_clips_are_sent_whole() {
        let pcm: Vec<u8> = speech_with_pause(15, None)
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert!(super::split_plan(&super::pcm16_wav(&pcm, 16000)).is_none());
    }

    #[test]
    fn long_clips_are_cut_into_pieces_no_longer_than_twenty_seconds() {
        let samples = speech_with_pause(83, None);
        let cuts = super::plan_cuts(&samples, 16000);
        assert!(cuts.len() > 4);
        assert_eq!(cuts[0].0, 0);
        assert_eq!(cuts.last().unwrap().1, samples.len());
        for pair in cuts.windows(2) {
            assert_eq!(
                pair[0].1, pair[1].0,
                "the pieces cover the clip with no gap"
            );
        }
        for (start, end) in &cuts {
            assert!(end - start <= 20 * 16000, "a piece is at most 20 seconds");
        }
    }

    #[test]
    fn a_cut_falls_in_the_pause_between_words() {
        // A pause from 15.0 to 15.5 seconds, inside the window where cuts are allowed.
        let samples = speech_with_pause(40, Some(15.0));
        let cuts = super::plan_cuts(&samples, 16000);
        let cut = cuts[0].1;
        assert!(
            (15 * 16000..=16 * 16000).contains(&cut),
            "the cut at {cut} should sit in the pause"
        );
    }

    #[test]
    fn a_wav_written_here_reads_back_with_its_format() {
        let pcm = [1u8, 0, 0xff, 0x7f];
        let wav = super::pcm16_wav(&pcm, 24000);
        let format = super::wav_format(&wav).unwrap();
        assert_eq!((format.rate, format.channels, format.bits), (24000, 1, 16));
        assert_eq!(format.data, &pcm);
    }

    #[test]
    fn encoded_or_unaligned_wav_is_not_processed_as_pcm() {
        let mut encoded = super::pcm16_wav(&vec![0; 48_000], 24_000);
        encoded[20..22].copy_from_slice(&3u16.to_le_bytes());
        assert_eq!(super::wav_format(&encoded).unwrap().encoding, 3);
        assert_eq!(super::trim_silence(encoded.clone()), encoded);
        assert!(super::split_plan(&encoded).is_none());

        let odd = super::pcm16_wav(&[1, 2, 3], 24_000);
        assert_eq!(super::trim_silence(odd.clone()), odd);
        assert!(super::split_plan(&odd).is_none());

        let mut bad_header = super::pcm16_wav(&[1, 2], 24_000);
        bad_header[16..20].copy_from_slice(&0u32.to_le_bytes());
        assert!(super::wav_format(&bad_header).is_none());
    }

    #[test]
    fn edge_silence_is_cut_to_a_natural_pause() {
        let rate = 24000usize;
        let tone = |n: usize| -> Vec<u8> {
            (0..n)
                .flat_map(|i| {
                    let x = 0.3 * (i as f64 * 440.0 * std::f64::consts::TAU / rate as f64).sin();
                    ((x * 32768.0) as i16).to_le_bytes()
                })
                .collect()
        };
        let silence = |n: usize| vec![0u8; n * 2];
        let mut pcm = silence(rate / 4);
        pcm.extend(tone(rate));
        pcm.extend(silence(rate / 4));
        let trimmed = super::trim_silence(super::pcm16_wav(&pcm, rate as u32));
        let format = super::wav_format(&trimmed).unwrap();
        let seconds = format.data.len() as f64 / 2.0 / rate as f64;
        // One second of tone plus 80 ms of padding each side; the cut is made on 20 ms frames, so allow one frame.
        assert!((seconds - 1.16).abs() < 0.03, "trimmed to {seconds} s");
    }

    #[test]
    fn a_silent_or_foreign_clip_is_left_alone() {
        let silent = super::pcm16_wav(&[0u8; 4800], 24000);
        assert_eq!(super::trim_silence(silent.clone()), silent);
        let not_wav = b"not audio".to_vec();
        assert_eq!(super::trim_silence(not_wav.clone()), not_wav);
    }
}
