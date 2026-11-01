// Translations for the web UI. English is the source: every other locale must have
// every key (the type checker enforces it), and anything missing falls back to English.

import { useCallback } from "react";
import { create } from "zustand";
import { de } from "./locales/de";
import { en, type Key } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { it } from "./locales/it";
import { ja } from "./locales/ja";
import { pt } from "./locales/pt";
import { zh } from "./locales/zh";

export type { Key };
export type Vars = Record<string, string | number>;

/** The languages the app is written in, with their own names for them. */
export const LOCALES = [
  { code: "en", name: "English", english: "English" },
  { code: "es", name: "Español", english: "Spanish" },
  { code: "pt", name: "Português", english: "Portuguese" },
  { code: "fr", name: "Français", english: "French" },
  { code: "de", name: "Deutsch", english: "German" },
  { code: "it", name: "Italiano", english: "Italian" },
  { code: "zh", name: "中文", english: "Chinese (Simplified)" },
  { code: "ja", name: "日本語", english: "Japanese" },
] as const;
export type Locale = (typeof LOCALES)[number]["code"];

const dictionaries: Record<Locale, Record<Key, string>> = { en, es, pt, fr, de, it, zh, ja };

const supported = new Set<string>(LOCALES.map((l) => l.code));

/** A setting ("auto", or a language code) to the language to show. "auto" follows the browser. */
export function resolveLocale(setting?: string | null): Locale {
  if (setting && setting !== "auto" && supported.has(setting)) return setting as Locale;
  for (const language of navigator.languages ?? [navigator.language]) {
    const code = language.toLowerCase().split("-")[0];
    if (supported.has(code)) return code as Locale;
  }
  return "en";
}

/** The English name of a language, which the models are told to reply in. */
export function englishName(locale: Locale) {
  return LOCALES.find((l) => l.code === locale)?.english ?? "English";
}

function fill(text: string, vars?: Vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`));
}

/** Translates a key into a locale, with English as the fallback. */
export function translate(locale: Locale, key: Key, vars?: Vars): string {
  return fill(dictionaries[locale][key] ?? en[key], vars);
}

const current = create<{ locale: Locale }>(() => ({ locale: resolveLocale(null) }));

/** Sets the language the UI speaks now. */
export function setLocale(setting?: string | null) {
  const locale = resolveLocale(setting);
  if (current.getState().locale === locale) return;
  current.setState({ locale });
  document.documentElement.lang = locale;
}

/** Translates outside React (toasts, errors, notifications). */
export function t(key: Key, vars?: Vars) {
  return translate(current.getState().locale, key, vars);
}

// ---- Messages the server sends ----
// The server words its errors in English. Each one is a dictionary entry whose English text is
// the same as the server's, and a template such as "Couldn't reach GitHub (HTTP {status})." matches
// whatever status it was given. Text the dictionary doesn't know is shown as it is.

type Rule = { key: Key; pattern: RegExp; names: string[] };
let rules: Rule[] | undefined;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function serverRules(): Rule[] {
  if (rules) return rules;
  const built: Rule[] = [];
  for (const key of Object.keys(en) as Key[]) {
    if (!key.startsWith("server.")) continue;
    const template = en[key];
    const names: string[] = [];
    let source = "";
    let last = 0;
    for (const match of template.matchAll(/\{(\w+)\}/g)) {
      source += escapeRegExp(template.slice(last, match.index)) + "(.*?)";
      names.push(match[1]);
      last = (match.index ?? 0) + match[0].length;
    }
    source += escapeRegExp(template.slice(last));
    built.push({ key, pattern: new RegExp(`^${source}$`, "s"), names });
  }
  // Messages with no values first: they are the most specific.
  built.sort((a, b) => a.names.length - b.names.length);
  rules = built;
  return built;
}

/** A message from the server, in the language of the interface. */
export function localizeServerError(text: string): string {
  const message = text.trim();
  for (const rule of serverRules()) {
    const match = rule.pattern.exec(message);
    if (match) {
      const vars = Object.fromEntries(rule.names.map((name, i) => [name, match[i + 1]]));
      return translate(current.getState().locale, rule.key, vars);
    }
  }
  return text;
}

/** How a tool argument's name reads in the language (command, path, url…). Unknown names are shown as they are. */
export function argLabel(name: string): string {
  const key = `arg.${name}` as Key;
  return key in en ? t(key) : name;
}

/** The current language. */
export const currentLocale = () => current.getState().locale;

/** The language the UI speaks now, as a hook: components re-render when it changes. */
export const useLocaleCode = () => current((s) => s.locale);

/** Translates in a component; it re-renders when the language changes. */
export function useT() {
  const locale = useLocaleCode();
  return useCallback((key: Key, vars?: Vars) => translate(locale, key, vars), [locale]);
}

/** Dates and times in the current language. */
export const formatDate = (at: number, options: Intl.DateTimeFormatOptions) => new Date(at).toLocaleDateString(currentLocale(), options);
export const formatTime = (at: number) => new Date(at).toLocaleTimeString(currentLocale(), { hour: "numeric", minute: "2-digit" });
