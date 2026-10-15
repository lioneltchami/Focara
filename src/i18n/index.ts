// Interface languages. The Turkish text itself is the key; en.ts has the English for each one.
// Used by the UI and by the Electron main process (menus, dialogs, the recording panel).
import { en } from './en.ts';

export type Lang = 'tr' | 'en';
/** What the user picked in Settings: follow the system, or a fixed language. */
export type LangPref = 'auto' | Lang;
export const languages: { id: Lang; name: string }[] = [{ id: 'tr', name: 'Türkçe' }, { id: 'en', name: 'English' }];

/** Turkish when the system's first preferred language is Turkish, English for everything else. */
export function systemLang(preferred: readonly string[]): Lang {
  return /^tr(\b|[-_])/i.test(preferred[0] ?? '') ? 'tr' : 'en';
}
export const resolveLang = (pref: LangPref, preferred: readonly string[]): Lang => (pref === 'tr' || pref === 'en' ? pref : systemLang(preferred));
export const isLangPref = (v: unknown): v is LangPref => v === 'auto' || v === 'tr' || v === 'en';

let current: Lang = 'tr';
export const lang = () => current;
export function setLang(l: Lang) { current = l; }

type Vars = Record<string, string | number>;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

/** `key` (the Turkish text) in the current language; `{name}` placeholders are filled from `vars`. */
export function t(key: string, vars?: Vars): string {
  return fill(current === 'en' ? (en[key] ?? key) : key, vars);
}

/**
 * Marks a Turkish text in a table (theme names, formats…) for translation; it is translated where
 * it's shown, with t(). The translation test collects the keys of both.
 */
export const N = <T extends string>(key: T): T => key;

/**
 * A message from the native capture helpers (Turkish, sometimes with a detail after the colon,
 * like “Dosya yazılamadı: disk full”) in the current language.
 */
export function helperMessage(msg: string): string {
  if (current === 'tr') return msg;
  if (en[msg]) return en[msg];
  for (const key of Object.keys(en)) {
    if (!key.endsWith('{detail}')) continue;
    const prefix = key.slice(0, -'{detail}'.length);
    if (msg.startsWith(prefix)) return fill(en[key], { detail: msg.slice(prefix.length) });
  }
  return msg;
}
