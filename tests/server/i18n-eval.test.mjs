// Checks that the models answer in the language they are asked in.
// Migrated from scripts/i18n-eval.mjs. The language guess is unit-tested on its own, and the live
// part runs only against a running Liquid Agent server with its models installed:
//
//   LIQUID_EVAL_URL=http://127.0.0.1:8397 LIQUID_EVAL_SMALL_URL=http://127.0.0.1:8591/v1 \
//     LIQUID_EVAL_OMNI_URL=http://127.0.0.1:8592/v1 npx vitest run --config vitest.server.config.mjs \
//     tests/server/i18n-eval.test.mjs
//
//   LIQUID_EVAL_JSON=out.json   also writes every answer to a file
//   LIQUID_EVAL_IDEAS=3         the "For You" cards only, that many samples per language
//
// The guess only looks at script (Japanese, Chinese) and common function words, so it is a check,
// not a proof: read the printed answers too.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import WebSocket from "ws";

const base = process.env.LIQUID_EVAL_URL ?? "";
const LIVE = base !== "";
const IDEAS = Number(process.env.LIQUID_EVAL_IDEAS ?? 0);
const jsonOut = process.env.LIQUID_EVAL_JSON ?? null;

// The question, written by a native speaker of each language, with the code it should be answered in.
const QUESTIONS = {
  en: "In two sentences, what is photosynthesis?",
  es: "En dos frases, ¿qué es la fotosíntesis?",
  pt: "Em duas frases, o que é fotossíntese?",
  fr: "En deux phrases, qu'est-ce que la photosynthèse ?",
  de: "Erkläre in zwei Sätzen, was Photosynthese ist.",
  it: "In due frasi, cos'è la fotosintesi?",
  zh: "用两句话解释什么是光合作用。",
  ja: "光合成とは何か、二文で説明してください。",
};

// Function words that are common in one language and rare in the others.
const STOPWORDS = {
  en: ["the", "and", "is", "of", "to", "that", "with", "plants", "light"],
  es: ["el", "la", "de", "que", "y", "los", "las", "es", "por", "una", "con", "plantas"],
  pt: ["de", "que", "é", "não", "uma", "com", "para", "os", "as", "plantas", "luz"],
  fr: ["le", "les", "et", "est", "des", "une", "pour", "qui", "sont", "dans", "plantes", "lumière"],
  de: ["und", "die", "der", "das", "ist", "nicht", "mit", "ein", "eine", "pflanzen", "licht"],
  it: ["il", "di", "che", "è", "e", "per", "una", "non", "sono", "dei", "cui", "con", "piante", "luce"],
};

/** Guesses the language of a reply. Returns a language code, or null when it can't tell. */
export function guessLanguage(text) {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  const words = text.toLowerCase().normalize("NFC").split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < 4) return null;
  const score = {};
  for (const [code, list] of Object.entries(STOPWORDS)) {
    score[code] = words.filter((w) => list.includes(w)).length;
  }
  // Accented letters are a strong hint for Portuguese and French.
  if (/[ãõç]/.test(text)) score.pt += 3;
  if (/[èêçàœ]/.test(text)) score.fr += 2;
  if (/[äöüß]/.test(text)) score.de += 3;
  if (/[ñ¿¡]/.test(text)) score.es += 3;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 2 ? best[0] : null;
}

describe("language guess", () => {
  it("recognises each language from an answer-length sentence", () => {
    const answers = {
      en: "Photosynthesis is the process plants use to turn light into food, with water and carbon dioxide.",
      es: "La fotosíntesis es el proceso por el que las plantas convierten la luz en alimento con agua y dióxido de carbono.",
      pt: "A fotossíntese é o processo pelo qual as plantas transformam a luz em alimento com água e dióxido de carbono.",
      fr: "La photosynthèse est le processus par lequel les plantes transforment la lumière en nourriture avec l'eau et le dioxyde de carbone.",
      de: "Photosynthese ist der Prozess, mit dem Pflanzen Licht in Nahrung umwandeln, aus Wasser und Kohlendioxid.",
      it: "La fotosintesi è il processo con cui le piante trasformano la luce in cibo, usando acqua e anidride carbonica.",
    };
    for (const [code, answer] of Object.entries(answers)) {
      expect(guessLanguage(answer), `the answer in ${code}`).toBe(code);
    }
  });

  it("says it cannot tell for very short or language-neutral text", () => {
    expect(guessLanguage("Hi.")).toBeNull();
    expect(guessLanguage("42 7 3 9 1")).toBeNull();
  });

  it("uses script before words, for Japanese and Chinese", () => {
    expect(guessLanguage("光合成は植物が光からエネルギーを作る仕組みです。")).toBe("ja");
    expect(guessLanguage("光合成是植物利用光能制造养分的过程。")).toBe("zh");
  });

  it("uses accents as a hint when words are scarce", () => {
    expect(guessLanguage("Não sei dizer com certeza, mas é uma boa ideia.")).toBe("pt");
    expect(guessLanguage("Das ist nicht schön, aber für uns gut genug.")).toBe("de");
  });
});

async function token() {
  const page = await fetch(`${base}/`).then((r) => r.text());
  const t = page.match(/name="liquid-token" content="([^"]+)"/)?.[1];
  if (!t) throw new Error("No token on the page: is the server running?");
  return t;
}

async function api(method, path, body, t) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "X-Liquid-Token": t, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

async function waitForReply(chatId, t, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const state = await api("GET", "/api/state", undefined, t);
    const chat = state.chats.find((c) => c.id === chatId);
    const last = chat?.messages.at(-1);
    if (last && (last.status === "done" || last.status === "error" || last.status === "stopped")) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No reply in ${timeoutMs / 1000}s`);
}

async function chatAnswer(text, t) {
  const chat = await api("POST", "/api/chats", { text }, t);
  const reply = await waitForReply(chat.id, t);
  await api("DELETE", `/api/chats/${chat.id}`, undefined, t);
  return reply.content;
}

function voiceAnswer(text, t) {
  return new Promise((resolve, reject) => {
    const url = `${base.replace("http", "ws")}/voice?t=${t}`;
    const ws = new WebSocket(url, { headers: { Origin: base } });
    let reply = "";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("No voice reply in 240s"));
    }, 240_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start" })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(data.toString());
      if (event.type === "ready") ws.send(JSON.stringify({ type: "text", text }));
      if (event.type === "assistant") reply = event.text;
      if (event.type === "turn.done") {
        clearTimeout(timer);
        ws.close();
        resolve(reply);
      }
      if (event.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(event.message));
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** The models' addresses come from settings; the defaults are the app's own ports. */
function modelURLs() {
  const urls = {};
  if (process.env.LIQUID_EVAL_SMALL_URL) urls.smallURL = process.env.LIQUID_EVAL_SMALL_URL;
  if (process.env.LIQUID_EVAL_OMNI_URL) urls.omniURL = process.env.LIQUID_EVAL_OMNI_URL;
  return urls;
}

describe.skipIf(!LIVE)("the models answer in the language asked (needs a running server)", () => {
  it("chat, voice and auto-language answers are in the language asked", async () => {
    const report = { chat: {}, voice: {}, auto: {}, ideas: {} };
    const t = await token();
    await api("PATCH", "/api/settings", { ...modelURLs(), language: "auto" }, t);

    for (const [code, question] of Object.entries(QUESTIONS)) {
      await api("PATCH", "/api/settings", { language: code }, t);
      for (const [mode, run] of [
        ["chat", chatAnswer],
        ["voice", voiceAnswer],
      ]) {
        try {
          const answer = await run(question, t);
          const guessed = guessLanguage(answer);
          report[mode][code] = { answer, guessed, ok: guessed === code };
          console.log(`${mode.padEnd(5)} ${code}  ${guessed === code ? "PASS" : "FAIL"} (heuristic: ${guessed ?? "unsure"})\n      ${answer.replace(/\n+/g, " ⏎ ").slice(0, 400)}`);
        } catch (error) {
          report[mode][code] = { error: String(error.message ?? error), ok: false };
          console.log(`${mode.padEnd(5)} ${code}  ERROR ${error.message}`);
        }
      }
    }

    // Auto language: the answer follows what the user wrote, whatever the interface says.
    await api("PATCH", "/api/settings", { language: "auto", uiLanguage: "fr" }, t);
    for (const [code, question] of [
      ["es", QUESTIONS.es],
      ["ja", QUESTIONS.ja],
    ]) {
      const answer = await chatAnswer(question, t);
      const guessed = guessLanguage(answer);
      report.auto[code] = { answer, guessed, ok: guessed === code };
      console.log(`auto  ${code}  ${guessed === code ? "PASS" : "FAIL"} (interface fr; heuristic: ${guessed ?? "unsure"})\n      ${answer.replace(/\n+/g, " ⏎ ").slice(0, 400)}`);
    }
    await api("PATCH", "/api/settings", { language: "auto", uiLanguage: "en" }, t);

    // "For You" ideas: the model writes four cards from what it knows about the user, in the language chosen.
    await api("POST", "/api/memory", { fact: "Lives in Lisbon and enjoys cooking Portuguese food." }, t);
    for (const code of Object.keys(QUESTIONS)) {
      await api("PATCH", "/api/settings", { language: code }, t);
      try {
        const ideas = await api("POST", "/api/ideas/refresh", undefined, t);
        const text = ideas.items.map((i) => `${i.title}. ${i.prompt}`).join(" ");
        const guessed = guessLanguage(text);
        const ok = ideas.items.length === 4 && guessed === code;
        report.ideas[code] = { items: ideas.items, guessed, ok };
        console.log(`ideas ${code}  ${ok ? "PASS" : "FAIL"} (${ideas.items.length} cards; heuristic: ${guessed ?? "unsure"})`);
        for (const item of ideas.items) console.log(`      ${item.title} | ${item.prompt}`);
      } catch (error) {
        report.ideas[code] = { error: String(error.message ?? error), ok: false };
        console.log(`ideas ${code}  ERROR ${error.message}`);
      }
    }
    await api("PATCH", "/api/settings", { language: "auto" }, t);
    const state = await api("GET", "/api/state", undefined, t);
    for (let i = state.memory.length - 1; i >= 0; i--) {
      if (state.memory[i].startsWith("Lives in Lisbon")) await api("DELETE", `/api/memory/${i}`, undefined, t);
    }

    const all = [...Object.values(report.chat), ...Object.values(report.voice), ...Object.values(report.auto), ...Object.values(report.ideas)];
    const passed = all.filter((r) => r.ok).length;
    console.log(`\n${passed} of ${all.length} answers are in the language asked for.`);
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    expect(passed, "every answer is in the language asked for").toBe(all.length);
  }, 3_600_000);
});

describe.skipIf(!LIVE || IDEAS < 1)("For You cards in the language asked (needs a running server)", () => {
  it(`${IDEAS} sample sets per language are complete and in the language asked for`, async () => {
    const t = await token();
    await api("PATCH", "/api/settings", modelURLs(), t);
    await api("POST", "/api/memory", { fact: "Lives in Lisbon and enjoys cooking Portuguese food." }, t);
    let good = 0;
    let total = 0;
    for (const code of Object.keys(QUESTIONS)) {
      await api("PATCH", "/api/settings", { language: code }, t);
      let passed = 0;
      for (let n = 0; n < IDEAS; n++) {
        const before = (await api("GET", "/api/state", undefined, t)).ideas?.at;
        const ideas = await api("POST", "/api/ideas/refresh", undefined, t);
        const text = ideas.items.map((i) => `${i.title}. ${i.prompt}`).join(" ");
        // When the model writes nothing usable the server keeps the old cards, so a set with the same time stamp is stale.
        const fresh = ideas.at !== before;
        const ok = fresh && ideas.items.length === 4 && guessLanguage(text) === code;
        passed += ok ? 1 : 0;
        total += 1;
        console.log(`ideas ${code} #${n + 1} ${ok ? "PASS" : "FAIL"}${fresh ? "" : " (stale: old cards kept)"}: ${ideas.items.length} cards`);
        for (const item of ideas.items) console.log(`      ${item.title} | ${item.prompt}`);
      }
      good += passed;
    }
    await api("PATCH", "/api/settings", { language: "auto" }, t);
    const state = await api("GET", "/api/state", undefined, t);
    for (let i = state.memory.length - 1; i >= 0; i--) {
      if (state.memory[i].startsWith("Lives in Lisbon")) await api("DELETE", `/api/memory/${i}`, undefined, t);
    }
    console.log(`\n${good} of ${total} idea sets are complete and in the language asked for.`);
    expect(good, "every idea set is complete and in the language asked for").toBe(total);
  }, 3_600_000);
});
