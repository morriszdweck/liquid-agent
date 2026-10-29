// What the agent knows about the user, and the idea cards built from it.

import { MODELS, bus, load, save, settings } from "./core.js";
import { complete } from "./llm.js";

const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);

// A fact is a short plain sentence: no Markdown, code or table rows.
const plainFact = (f) => typeof f === "string" && /[a-z]{3,}.*\s.*[a-z]{2,}/i.test(f) && !/[|`#<>{}\[\]]|^\W/.test(f);

const stored = load("memory.json", []);
let facts = stored.filter(plainFact);
let ideas = load("ideas.json", { at: 0, items: [] });

export const memory = {
  /** Drops junk that older versions saved, then rebuilds the ideas from what's left. */
  tidy() {
    if (facts.length !== stored.length) this.changed();
  },

  get facts() {
    return facts;
  },
  get ideas() {
    return ideas;
  },

  add(fact) {
    const text = String(fact ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
    if (!text) return false;
    if (facts.some((f) => f.toLowerCase() === text.toLowerCase())) return false;
    facts = [...facts, text].slice(-200);
    this.changed();
    return true;
  },

  remove(index) {
    facts = facts.filter((_, i) => i !== index);
    this.changed();
  },

  update(index, text) {
    if (!facts[index] || !String(text).trim()) return;
    facts = facts.map((f, i) => (i === index ? String(text).trim() : f));
    this.changed();
  },

  clear() {
    facts = [];
    this.changed();
  },

  changed() {
    save("memory.json", facts);
    bus.emit("memory", { facts });
    clearTimeout(this.ideaTimer);
    this.ideaTimer = setTimeout(() => this.refreshIdeas().catch(() => {}), 20_000);
  },

  /** Facts that share words with the request, best first. */
  search(query, limit = 4) {
    const q = words(query);
    return facts
      .map((f, i) => ({ f, i, score: [...words(f)].filter((w) => q.has(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.i - a.i)
      .slice(0, limit)
      .map((x) => x.f);
  },

  /** A short line for the system prompt: the relevant facts plus the newest few. */
  promptBlock(query) {
    const picked = [...new Set([...this.search(query, 4), ...facts.slice(-3)])];
    return picked.length ? `User facts: ${picked.join("; ")}` : "";
  },

  /** Picks up lasting facts the user mentions in passing. Runs after a reply, off the critical path. */
  async learnFrom(text) {
    // "Show me…" and "tell me…" are requests, not facts; look for the user talking about themself.
    if (!/\b(i|i'm|im|i've|i'd|my|mine|call me)\b/i.test(text) || text.length > 600) return;
    const out = await complete({
      url: settings.smallURL,
      model: MODELS.small.id,
      temperature: 0,
      maxTokens: 80,
      messages: [
        {
          role: "system",
          content:
            "Extract lasting personal facts about the user (name, job, location, family, pets, preferences, projects, goals) from their message. Write each as a short third-person sentence on its own line, like 'Lives in Austin.'. If there are none, reply NONE.",
        },
        { role: "user", content: text },
      ],
    });
    if (/^none\b/i.test(out)) return;
    // Keep only facts grounded in what the user actually said.
    const said = words(text);
    for (const line of out.split("\n").slice(0, 2)) {
      const fact = line.replace(/^[-*\d.\s]+/, "").trim();
      const grounded = [...words(fact)].some((w) => w.length > 3 && said.has(w));
      if (fact.length > 4 && fact.length < 160 && !/none/i.test(fact) && plainFact(fact) && grounded) this.add(fact);
    }
  },

  /** Builds four personalized "try this" cards from memory. */
  async refreshIdeas() {
    // With nothing known yet the app's hand-picked starters beat generic guesses.
    if (!facts.length) {
      ideas = { at: Date.now(), items: [] };
      save("ideas.json", ideas);
      bus.emit("ideas", { ideas });
      return ideas;
    }
    const known = facts.slice(-15).join("; ");
    const out = await complete({
      url: settings.smallURL,
      model: MODELS.small.id,
      temperature: 0.8,
      maxTokens: 220,
      messages: [
        {
          role: "system",
          content:
            "You suggest things a personal AI agent on a Mac could do for this user right now. It can chat, search the web, use files and apps, set reminders, browse websites and see the screen. Write exactly 4 lines, each 'Short title | the full request the user would type', like 'Tidy Downloads | Sort the files in my Downloads folder into folders by type'. No numbering, nothing else.",
        },
        { role: "user", content: `What I know about the user: ${known}` },
      ],
    });
    const items = out
      .split("\n")
      .map((l) => l.replace(/^[-*\d.\s]+/, "").split("|").map((s) => s.trim()))
      .filter(([title, prompt]) => title && prompt && prompt.split(/\s+/).length >= 4 && !/[|`#]/.test(title + prompt))
      .slice(0, 4)
      .map(([title, prompt]) => ({ title: title.slice(0, 60), prompt: prompt.slice(0, 300) }));
    if (!items.length) return ideas;
    ideas = { at: Date.now(), items };
    save("ideas.json", ideas);
    bus.emit("ideas", { ideas });
    return ideas;
  },
};
