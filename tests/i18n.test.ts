// Interface languages: every text the app shows has an English translation, nothing Turkish is
// left outside the translation calls, and the language follows the system unless one is picked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { en } from '../src/i18n/en.ts';
import { helperMessage, resolveLang, setLang, systemLang, t } from '../src/i18n/index.ts';

const root = path.resolve(import.meta.dirname, '..');
const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = [...walk('src'), ...walk('electron')].filter((f) => /\.tsx?$/.test(f) && !f.startsWith(path.join('src', 'i18n')));
// The app itself (the test drivers only look things up with t()).
const harness = /(selftest|uitest|perftest|docshots)\.ts$/;
const appSources = sources.filter((f) => !harness.test(f));

/** Source text without comments (line comments only where they start a line or follow code after a space). */
const code = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const CALL = /\b(?:t|N)\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const unquote = (lit: string) => lit.slice(1, -1).replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');
const keysIn = (f: string) => [...code(f).matchAll(CALL)].map((m) => unquote(m[1]));
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

test('every text the app shows has an English translation with the same placeholders', () => {
  const missing: string[] = [], wrong: string[] = [];
  for (const f of sources) {
    for (const k of keysIn(f)) {
      if (!(k in en)) missing.push(`${f}: ${k}`);
      else if (!en[k].trim() || JSON.stringify(holes(k)) !== JSON.stringify(holes(en[k]))) wrong.push(`${f}: ${k} → ${en[k]}`);
    }
  }
  assert.deepEqual(missing, [], 'texts without an English translation');
  assert.deepEqual(wrong, [], 'translations that are empty or have other placeholders');
});

/** Messages of the native capture helpers ({detail} where they add one). */
function helperMessages(): string[] {
  const out: string[] = [];
  for (const f of walk('native').filter((x) => /\.(swift|rs)$/.test(x))) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const s = m[1].replace(/\\\([^)]*\)/g, '{detail}').replace(/\{[a-z_]*\}/g, (h) => (h === '{detail}' ? h : '{detail}'));
      if (TURKISH.test(s) && !s.startsWith('{')) out.push(s);
    }
  }
  return out;
}

test('every English entry is used, and the capture helpers\' messages are translated', () => {
  const used = new Set([...sources.flatMap(keysIn), ...helperMessages()]);
  assert.deepEqual(Object.keys(en).filter((k) => !used.has(k)), [], 'unused entries in en.ts');
  setLang('en');
  try {
    for (const msg of helperMessages()) {
      const sample = msg.replace('{detail}', 'disk full');
      const out = helperMessage(sample);
      assert.ok(out !== sample && !TURKISH.test(out.replace('disk full', '')), `helper message not translated: ${msg} → ${out}`);
    }
  } finally { setLang('tr'); }
});

test('no Turkish text is left outside t() / N() in the app', () => {
  const found: string[] = [];
  for (const f of appSources) {
    const rest = code(f).replace(CALL, 't(""');
    for (const [i, line] of rest.split('\n').entries()) {
      // String literals and JSX text with Turkish letters.
      const strings = [...line.matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|>[^<>{}]*</g)].map((m) => m[0]);
      for (const s of strings) if (TURKISH.test(s) && !/Türkçe|Dil · Language/.test(s)) found.push(`${f}:${i + 1}: ${s.trim()}`);
    }
  }
  assert.deepEqual(found, []);
});

test('JSX text and title attributes go through t()', () => {
  // Plain words in markup would stay in one language. Symbols, numbers, units and key names are fine.
  const allowed = /^(?:[\s·×%/:,.…•↖↔✂┆⌫＋●⏩✦📷🔍⚙‹›↶↷⏮⏭▶❚⛶⊘🎞🖥➚⌖—–()?\d-]|Esc|fps|px|PNG|GIF|Odak|Dil · Language|S|[A-Z])*$/u;
  const found: string[] = [];
  for (const f of appSources.filter((x) => x.endsWith('.tsx'))) {
    const rest = code(f);
    // Text between tags on one line. A tag ends in a name, quote, brace or slash; “ >” and “=>” are
    // comparisons and arrows, and code has its own characters in between.
    for (const m of rest.matchAll(/(?<![\s=-])>([^<>{}\n;=()[\]&|]+)</g)) {
      const text = m[1].trim();
      if (text && /\p{L}{2}/u.test(text) && !allowed.test(text)) found.push(`${f}: >${text}<`);
    }
    for (const m of rest.matchAll(/\b(title|placeholder|startLabel|label)="([^"]*)"/g)) {
      if (/\p{L}{2}/u.test(m[2])) found.push(`${f}: ${m[1]}="${m[2]}"`);
    }
  }
  assert.deepEqual(found, []);
});

test('the language follows the system (Turkish or English) unless one is picked', () => {
  assert.equal(systemLang(['tr-TR', 'en-US']), 'tr');
  assert.equal(systemLang(['tr']), 'tr');
  assert.equal(systemLang(['en-US', 'tr-TR']), 'en');
  assert.equal(systemLang(['de-DE']), 'en');
  assert.equal(systemLang(['en-TR']), 'en');
  assert.equal(systemLang([]), 'en');
  assert.equal(resolveLang('auto', ['tr-TR']), 'tr');
  assert.equal(resolveLang('en', ['tr-TR']), 'en');
  assert.equal(resolveLang('tr', ['fr-FR']), 'tr');
});

test('t() fills placeholders in both languages and falls back to the key', () => {
  setLang('tr');
  assert.equal(t('Klip {n} / {total}', { n: 2, total: 5 }), 'Klip 2 / 5');
  setLang('en');
  try {
    assert.equal(t('Klip {n} / {total}', { n: 2, total: 5 }), 'Clip 2 / 5');
    assert.equal(t('%{p} · yaklaşık {s} sn kaldı', { p: 40, s: 12 }), '40% · about 12 s left');
    assert.equal(helperMessage('Dosya yazılamadı: disk full'), 'Couldn\'t write the file: disk full');
    assert.equal(helperMessage('something new'), 'something new');
  } finally { setLang('tr'); }
});
