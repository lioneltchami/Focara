// Documentation screenshots (npm run docshots): builds a demo project — a made-up analytics web
// app, an illustrated webcam avatar and a painted sunset background, all drawn in code — opens it
// in the real editor and saves screenshots, rendered frames and a GIF into docs/images.
import { lang, t } from './i18n/index.ts';
import { CanvasSource, Mp4OutputFormat, Output, StreamTarget, getFirstEncodableVideoCodec } from 'mediabunny';
import { odak } from './bridge.ts';
import { type CursorTrack, type ExportSettings, type MediaAsset, type Project, newClip, newProject, normalizeProject, projectDuration, uuid } from './core/model.ts';
import { generateAutoZooms } from './core/zoom.ts';
import { addCameraSegment, addMagnifier } from './core/edit.ts';
import { exportProject, renderFrames } from './media/exporter.ts';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { drawCursor } from './render/renderer.ts';
import { MediaLibrary } from './media/media.ts';
import { themeCanvas, themesOf } from './render/themes.ts';
import type { EditorStore } from './ui/store.ts';

const W = 1920, H = 1200, FPS = 30, SECONDS = 14;
const log: string[] = [];
let failures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T | null;
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const byText = (sel: string, text: string) => $$(sel).find((e) => e.textContent?.includes(text)) ?? null;
const click = (el: Element | null) => { if (!el) throw new Error('element not found'); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const baseOf = (p: string) => p.replace(/^.*[\\/]/, '');
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

async function writeFile(path: string, build: (target: StreamTarget) => Promise<void>) {
  const h = await odak().fileOpen(path);
  try {
    await build(new StreamTarget(new WritableStream({ write: (c) => odak().fileWrite(h, c.data, c.position) }), { chunked: true }));
  } finally { await odak().fileClose(h); }
}
/**
 * Collects GIF frames in memory; delays are rounded against the ideal clock so the length never drifts.
 * After the first frame only the pixels that changed are stored (the rest are transparent and keep the
 * frame before), and a frame with no change just lengthens the one before: a still editor costs little.
 */
class Gif {
  private enc = GIFEncoder({ auto: false });
  private parts: Uint8Array[] = [];
  private shown: Uint8ClampedArray | null = null; // what a viewer shows after the frames so far
  private pending: { index: Uint8Array; palette: number[][]; transparent: boolean; delayCs: number } | null = null;
  private frames = 0;
  private writtenCs = 0;
  constructor(private w: number, private h: number, private fps: number) { this.enc.writeHeader(); }
  add(rgba: Uint8ClampedArray, hold = 1) {
    this.frames += hold;
    const delay = Math.max(2, Math.round((this.frames / this.fps) * 100) - this.writtenCs);
    this.writtenCs += delay;
    const n = this.w * this.h, shown = this.shown;
    const changed = new Uint8Array(n);
    let count = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (!shown || Math.abs(rgba[p] - shown[p]) > 3 || Math.abs(rgba[p + 1] - shown[p + 1]) > 3 || Math.abs(rgba[p + 2] - shown[p + 2]) > 3) { changed[i] = 1; count++; }
    }
    if (shown && count === 0 && this.pending) { this.pending.delayCs += delay; return; }
    this.flush();
    const px = new Uint8ClampedArray(Math.max(1, count) * 4);
    for (let i = 0, j = 0; i < n; i++) if (changed[i]) { const p = i * 4; px[j] = rgba[p]; px[j + 1] = rgba[p + 1]; px[j + 2] = rgba[p + 2]; px[j + 3] = 255; j += 4; }
    const palette = quantize(px, shown ? 255 : 256);
    const index = applyPalette(rgba, palette);
    const next = shown ?? new Uint8ClampedArray(n * 4);
    const clear = palette.length;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (!changed[i]) { index[i] = clear; continue; }
      const c = palette[index[i]]; next[p] = c[0]; next[p + 1] = c[1]; next[p + 2] = c[2]; next[p + 3] = 255;
    }
    if (shown) palette.push([0, 0, 0]);
    this.shown = next;
    this.pending = { index, palette, transparent: !!shown, delayCs: delay };
  }
  private flush() {
    const f = this.pending;
    if (!f) return;
    this.enc.writeFrame(f.index, this.w, this.h, { palette: f.palette, delay: f.delayCs * 10, first: this.parts.length === 0, repeat: 0,
      transparent: f.transparent, transparentIndex: f.palette.length - 1, dispose: 1 });
    this.parts.push(this.enc.bytes()); this.enc.reset();
    this.pending = null;
  }
  bytes() {
    this.flush();
    this.enc.finish(); this.parts.push(this.enc.bytes());
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** A caption pill at the bottom left (or top left) of a frame (for the README videos). */
function caption(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, text: string, alpha: number, top = false, size = 0.052) {
  if (alpha <= 0) return;
  const fs = Math.round(h * size), pad = fs * 0.7;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `650 ${fs}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
  const tw = ctx.measureText(text).width, x = h * 0.05, y = top ? h * 0.05 : h - h * 0.05 - fs - pad * 1.2;
  ctx.fillStyle = 'rgba(17,18,40,0.82)'; ctx.beginPath(); ctx.roundRect(x, y, tw + pad * 2, fs + pad * 1.2, (fs + pad * 1.2) / 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillText(text, x + pad, y + fs * 0.98 + pad * 0.3);
  ctx.restore();
}

async function png(c: OffscreenCanvas) { return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); }

// ---------------------------------------------------------------- the demo "recording"

/** Where the cursor is (screen pixels) and the clicks of the story. */
const CLICKS = [2.0, 3.0, 5.4, 11.2];
const KEYS: [number, number, number][] = [ // time, x, y
  [0, 1500, 980], [1.7, 1668, 200], [2.2, 1668, 204], [2.9, 900, 560], [3.1, 902, 562], [4.6, 1110, 700],
  [5.2, 1318, 812], [5.6, 1320, 814], [7.0, 1100, 1000], [9.5, 1000, 980], [10.9, 664, 760], [11.5, 664, 770], [12.3, 810, 688], [13.1, 960, 720], [14, 975, 726],
];
function cursorAt(t: number) {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] <= t) i++;
  const [t0, x0, y0] = KEYS[i], [t1, x1, y1] = KEYS[i + 1];
  const k = ease((t - t0) / Math.max(1e-6, t1 - t0));
  return { x: lerp(x0, x1, k), y: lerp(y0, y1, k) };
}
function cursorTrack(): CursorTrack {
  const tr: CursorTrack = { samples: [], clicks: [] };
  for (let i = 0; i <= SECONDS * 120; i++) { const t = i / 120; tr.samples.push({ t, ...cursorAt(t) }); }
  for (const c of CLICKS) { const p = cursorAt(c); tr.clicks.push({ t: c, ...p, isDown: true, button: 0 }, { t: c + 0.09, ...p, isDown: false, button: 0 }); }
  return tr;
}

const chart = [1820, 3482, 2950, 4110, 3720, 4890, 5320];
const chartPoint = (i: number) => ({ x: 360 + i * 150, y: 1020 - (chart[i] / 6000) * 480 });

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}

/** A made-up analytics dashboard; the story: open "New report", type a name, save, inspect the chart. */
function drawApp(ctx: OffscreenCanvasRenderingContext2D, t: number) {
  const font = (px: number, w = 500) => `${w} ${px}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = '#f5f6fb'; ctx.fillRect(0, 0, W, H);
  // Sidebar
  ctx.fillStyle = '#1e2140'; ctx.fillRect(0, 0, 250, H);
  ctx.fillStyle = '#8b7bff'; ctx.beginPath(); ctx.arc(52, 58, 16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = font(26, 700); ctx.fillText('Acme Analytics', 80, 67);
  ['Overview', 'Reports', 'Customers', 'Campaigns', 'Settings'].forEach((m, i) => {
    if (i === 0) roundRect(ctx, 20, 120 + i * 60, 210, 46, 10, 'rgba(139,123,255,0.22)');
    ctx.fillStyle = i === 0 ? '#fff' : '#a9acc8'; ctx.font = font(22, i === 0 ? 650 : 500); ctx.fillText(m, 48, 151 + i * 60);
  });
  // Top bar
  ctx.fillStyle = '#fff'; ctx.fillRect(250, 0, W - 250, 84);
  ctx.fillStyle = '#e6e8f0'; ctx.fillRect(250, 84, W - 250, 2);
  roundRect(ctx, 300, 20, 460, 44, 10, '#f1f2f7');
  ctx.fillStyle = '#9a9db3'; ctx.font = font(20); ctx.fillText('Search reports, customers…', 330, 49);
  ctx.fillStyle = '#ffb38a'; ctx.beginPath(); ctx.arc(1860, 42, 22, 0, Math.PI * 2); ctx.fill();
  // Title + button
  ctx.fillStyle = '#151833'; ctx.font = font(44, 750); ctx.fillText('Overview', 300, 172);
  ctx.fillStyle = '#7d8099'; ctx.font = font(22); ctx.fillText('Last 7 days · updated just now', 300, 210);
  const pressed = t >= CLICKS[0] && t < CLICKS[0] + 0.15;
  roundRect(ctx, 1560, 174, 220, 56, 12, pressed ? '#5b4ee0' : '#7b6cff');
  ctx.fillStyle = '#fff'; ctx.font = font(23, 650); ctx.fillText('+  New report', 1600, 210);
  // KPI cards
  const kpis: [string, string, string, string][] = [['Visitors', '26,292', '+12.4%', '#16a34a'], ['Sign-ups', '1,204', '+8.1%', '#16a34a'], ['Revenue', '$18.4k', '−2.3%', '#dc2626']];
  kpis.forEach(([label, value, delta, color], i) => {
    const x = 300 + i * 540;
    roundRect(ctx, x, 260, 500, 140, 18, '#fff', '#e6e8f0');
    ctx.fillStyle = '#7d8099'; ctx.font = font(22); ctx.fillText(label, x + 30, 305);
    ctx.fillStyle = '#151833'; ctx.font = font(48, 750); ctx.fillText(value, x + 30, 368);
    ctx.fillStyle = color; ctx.font = font(22, 650); ctx.fillText(delta, x + 360, 368);
  });
  // Line chart
  roundRect(ctx, 300, 430, 1040, 680, 18, '#fff', '#e6e8f0');
  ctx.fillStyle = '#151833'; ctx.font = font(26, 700); ctx.fillText('Visitors per day', 330, 480);
  ctx.strokeStyle = '#eef0f6'; ctx.lineWidth = 2;
  for (let g = 0; g <= 4; g++) { ctx.beginPath(); ctx.moveTo(340, 540 + g * 120); ctx.lineTo(1300, 540 + g * 120); ctx.stroke(); }
  const grow = ease(t / 1.2);
  ctx.beginPath();
  chart.forEach((_, i) => { const p = chartPoint(i); const y = lerp(1020, p.y, grow); if (i) ctx.lineTo(p.x, y); else ctx.moveTo(p.x, y); });
  ctx.strokeStyle = '#7b6cff'; ctx.lineWidth = 6; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(chartPoint(6).x, 1020); ctx.lineTo(chartPoint(0).x, 1020); ctx.closePath();
  const fill = ctx.createLinearGradient(0, 540, 0, 1020); fill.addColorStop(0, 'rgba(123,108,255,0.28)'); fill.addColorStop(1, 'rgba(123,108,255,0)');
  ctx.fillStyle = fill; ctx.fill();
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, i) => {
    const p = chartPoint(i);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, lerp(1020, p.y, grow), 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#7b6cff'; ctx.lineWidth = 4; ctx.stroke();
    ctx.fillStyle = '#9a9db3'; ctx.font = font(20); ctx.fillText(d, p.x - 20, 1070);
  });
  // Top pages
  roundRect(ctx, 1380, 430, 500, 680, 18, '#fff', '#e6e8f0');
  ctx.fillStyle = '#151833'; ctx.font = font(26, 700); ctx.fillText('Top pages', 1410, 480);
  [['/pricing', 0.92], ['/blog/zoom-tips', 0.74], ['/download', 0.61], ['/docs/export', 0.43], ['/changelog', 0.3], ['/about', 0.18]].forEach(([p, v], i) => {
    const y = 540 + i * 92;
    ctx.fillStyle = '#3a3d5c'; ctx.font = font(21); ctx.fillText(String(p), 1410, y);
    roundRect(ctx, 1410, y + 16, 440, 14, 7, '#eef0f6');
    roundRect(ctx, 1410, y + 16, 440 * Number(v), 14, 7, i % 2 ? '#a99dff' : '#7b6cff');
  });
  // Tooltip on the chart (after the last click)
  if (t >= CLICKS[3] + 0.05) {
    const p = chartPoint(2), a = ease((t - CLICKS[3]) / 0.2);
    ctx.globalAlpha = a;
    roundRect(ctx, p.x - 120, p.y - 120, 240, 86, 12, '#151833');
    ctx.fillStyle = '#fff'; ctx.font = font(21, 650); ctx.fillText('Wednesday', p.x - 96, p.y - 84);
    ctx.fillStyle = '#c9c6ff'; ctx.font = font(20); ctx.fillText('2,950 visitors', p.x - 96, p.y - 54);
    ctx.globalAlpha = 1;
  }
  // "New report" modal
  const open = t >= CLICKS[0] + 0.2 && t < CLICKS[2] + 0.3;
  if (open) {
    const a = Math.min(ease((t - CLICKS[0] - 0.2) / 0.25), 1 - ease((t - CLICKS[2]) / 0.3));
    ctx.fillStyle = `rgba(16,18,40,${0.35 * a})`; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = a;
    const s = 0.96 + 0.04 * a;
    ctx.translate(1085, 640); ctx.scale(s, s); ctx.translate(-1085, -640);
    roundRect(ctx, 705, 400, 760, 480, 22, '#fff');
    ctx.fillStyle = '#151833'; ctx.font = font(34, 750); ctx.fillText('New report', 755, 470);
    ctx.fillStyle = '#7d8099'; ctx.font = font(21); ctx.fillText('Name', 755, 525);
    const focused = t >= CLICKS[1];
    roundRect(ctx, 755, 540, 660, 60, 12, '#fff', focused ? '#7b6cff' : '#dfe1ea');
    const name = 'Weekly growth';
    const typed = focused ? name.slice(0, Math.floor((t - CLICKS[1] - 0.15) / 0.09)) : '';
    ctx.fillStyle = typed ? '#151833' : '#a0a3b8'; ctx.font = font(24);
    ctx.fillText(typed || 'e.g. Monthly summary', 775, 579);
    if (focused && Math.floor(t * 2) % 2 === 0) { const w = ctx.measureText(typed).width; ctx.fillStyle = '#7b6cff'; ctx.fillRect(777 + w, 556, 3, 30); }
    ctx.fillStyle = '#7d8099'; ctx.font = font(21); ctx.fillText('Range', 755, 650);
    roundRect(ctx, 755, 665, 660, 60, 12, '#fff', '#dfe1ea');
    ctx.fillStyle = '#151833'; ctx.font = font(24); ctx.fillText('Last 7 days', 775, 704);
    roundRect(ctx, 1060, 780, 150, 56, 12, '#f1f2f7');
    ctx.fillStyle = '#3a3d5c'; ctx.font = font(23, 600); ctx.fillText('Cancel', 1097, 816);
    roundRect(ctx, 1230, 780, 185, 56, 12, t >= CLICKS[2] && t < CLICKS[2] + 0.15 ? '#5b4ee0' : '#7b6cff');
    ctx.fillStyle = '#fff'; ctx.font = font(23, 650); ctx.fillText('Save report', 1258, 816);
    ctx.restore();
  }
  // Toast
  if (t >= CLICKS[2] + 0.4 && t < CLICKS[2] + 3.2) {
    const a = Math.min(ease((t - CLICKS[2] - 0.4) / 0.25), 1 - ease((t - CLICKS[2] - 2.9) / 0.3));
    ctx.globalAlpha = a;
    roundRect(ctx, 300, 1120 - 20 * a, 420, 60, 14, '#151833');
    ctx.fillStyle = '#4ade80'; ctx.font = font(24, 700); ctx.fillText('✓', 326, 1159 - 20 * a);
    ctx.fillStyle = '#fff'; ctx.font = font(22, 600); ctx.fillText('Report “Weekly growth” saved', 360, 1158 - 20 * a);
    ctx.globalAlpha = 1;
  }
}

/** An illustrated presenter for the webcam (not a real person). */
function drawAvatar(ctx: OffscreenCanvasRenderingContext2D, i: number) {
  const t = i / 30, w = 640, h = 480;
  const bg = ctx.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#c7d2fe'); bg.addColorStop(1, '#fbcfe8');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(520, 90, 70, 0, Math.PI * 2); ctx.fill();
  const bob = Math.sin(t * 2.1) * 4, tilt = Math.sin(t * 0.9) * 0.04;
  ctx.save(); ctx.translate(320, 250 + bob); ctx.rotate(tilt);
  ctx.fillStyle = '#4f46e5'; ctx.beginPath(); ctx.ellipse(0, 250, 210, 150, 0, Math.PI, 0); ctx.fill();     // shoulders
  ctx.fillStyle = '#e8b48f'; ctx.fillRect(-36, 70, 72, 60);                                                   // neck
  ctx.fillStyle = '#f2c9a0'; ctx.beginPath(); ctx.ellipse(0, -10, 112, 128, 0, 0, Math.PI * 2); ctx.fill();  // face
  ctx.fillStyle = '#3b2a20'; ctx.beginPath(); ctx.ellipse(0, -78, 124, 82, 0, Math.PI, 0); ctx.fill();        // hair
  ctx.beginPath(); ctx.ellipse(-96, -40, 30, 70, 0.2, 0, Math.PI * 2); ctx.ellipse(96, -40, 30, 70, -0.2, 0, Math.PI * 2); ctx.fill();
  const blink = (t % 3.4) > 3.25 ? 0.15 : 1;
  ctx.fillStyle = '#2b2b38';
  for (const x of [-42, 42]) { ctx.beginPath(); ctx.ellipse(x, -6, 10, 12 * blink, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = '#2b2b38'; ctx.lineWidth = 4;
  for (const x of [-42, 42]) { ctx.beginPath(); ctx.roundRect(x - 30, -32, 60, 48, 14); ctx.stroke(); }  // glasses
  ctx.beginPath(); ctx.moveTo(-12, -10); ctx.lineTo(12, -10); ctx.stroke();
  const talk = 6 + 6 * Math.abs(Math.sin(t * 9));
  ctx.fillStyle = '#b4545f'; ctx.beginPath(); ctx.ellipse(0, 58, 26, talk, 0, 0, Math.PI * 2); ctx.fill();     // mouth
  ctx.fillStyle = 'rgba(244,114,182,0.35)';
  for (const x of [-70, 70]) { ctx.beginPath(); ctx.arc(x, 30, 18, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

/** A painted sunset over mountains and a lake (for the "background image" feature). */
function drawLandscape(w: number, h: number): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d')!;
  const horizon = h * 0.62;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#1e1b4b'); sky.addColorStop(0.45, '#7c3aed'); sky.addColorStop(0.78, '#f97316'); sky.addColorStop(1, '#fde68a');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, horizon);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 160; i++) { ctx.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.6})`; ctx.fillRect(rnd() * w, rnd() * horizon * 0.45, 2, 2); }
  const sun = { x: w * 0.68, y: horizon - h * 0.08, r: h * 0.09 };
  const glow = ctx.createRadialGradient(sun.x, sun.y, sun.r * 0.5, sun.x, sun.y, sun.r * 4);
  glow.addColorStop(0, 'rgba(255,237,180,0.9)'); glow.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, horizon);
  ctx.fillStyle = '#fff4d6'; ctx.beginPath(); ctx.arc(sun.x, sun.y, sun.r, 0, Math.PI * 2); ctx.fill();
  const ridges: [string, number, number, number][] = [['#7e3a8f', 0.30, 0.0022, 1], ['#5b2a7a', 0.22, 0.0031, 2], ['#3b1f5e', 0.15, 0.0042, 3], ['#1f1540', 0.08, 0.006, 4]];
  for (const [color, height, freq, k] of ridges) {
    ctx.beginPath(); ctx.moveTo(0, horizon);
    for (let x = 0; x <= w; x += 8) {
      const y = horizon - h * height * (0.55 + 0.25 * Math.sin(x * freq + k) + 0.12 * Math.sin(x * freq * 2.7 + k * 3) + 0.06 * Math.sin(x * freq * 7.3 + k));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, horizon); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }
  // Lake: the sky and mountains mirrored, darker, with ripples.
  ctx.save(); ctx.translate(0, horizon * 2); ctx.scale(1, -1); ctx.globalAlpha = 0.55; ctx.drawImage(c, 0, 0, w, horizon, 0, 0, w, horizon); ctx.restore();
  const lake = ctx.createLinearGradient(0, horizon, 0, h); lake.addColorStop(0, 'rgba(15,10,40,0.25)'); lake.addColorStop(1, 'rgba(10,8,30,0.85)');
  ctx.fillStyle = lake; ctx.fillRect(0, horizon, w, h - horizon);
  ctx.strokeStyle = 'rgba(255,240,200,0.35)'; ctx.lineWidth = 2;
  for (let i = 0; i < 26; i++) { const y = horizon + 10 + i * i * 0.7; ctx.beginPath(); ctx.moveTo(sun.x - 120 + i * 3, y); ctx.lineTo(sun.x + 120 - i * 3, y); ctx.stroke(); }
  return c;
}

/** The README banner: the name, what it does, and the editor (a 2× screenshot) with a magnifier over its timeline. */
async function banner(editorPng: Uint8Array): Promise<Uint8Array> {
  const BW = 1800, BH = 620, tr = lang() === 'tr';
  const c = new OffscreenCanvas(BW, BH), ctx = c.getContext('2d')!;
  const font = (px: number, w = 650) => `${w} ${px}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = '#0b0b12'; ctx.fillRect(0, 0, BW, BH);
  for (const [x, y, r, color] of [[260, -60, 620, 'rgba(124,92,255,0.42)'], [1500, 700, 720, 'rgba(236,72,153,0.26)'], [900, 300, 520, 'rgba(168,85,247,0.14)']] as const) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, BW, BH);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let y = 14; y < BH; y += 28) for (let x = 14; x < BW; x += 28) ctx.fillRect(x, y, 2, 2);

  // The editor, glowing, on the right.
  const img = await createImageBitmap(new Blob([new Uint8Array(editorPng)], { type: 'image/png' }));
  const ew = 860, eh = Math.round((ew * img.height) / img.width), ex = BW - ew - 60, ey = Math.round((BH - eh) / 2);
  ctx.save(); ctx.shadowColor = 'rgba(124,92,255,0.55)'; ctx.shadowBlur = 90;
  ctx.fillStyle = '#14151c'; ctx.beginPath(); ctx.roundRect(ex, ey, ew, eh, 16); ctx.fill(); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.roundRect(ex, ey, ew, eh, 16); ctx.clip();
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, ex, ey, ew, eh); ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(ex, ey, ew, eh, 16); ctx.stroke();
  // A lens over the clip and zoom lanes (window pixels of the 1440 × 900 editor).
  const k = ew / 1440, src = { x: 511, y: 757, r: 58 }, lr = 112, lx = ex + src.x * k, ly = ey + src.y * k, s = img.width / 1440;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 40; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(img, (src.x - src.r) * s, (src.y - src.r) * s, src.r * 2 * s, src.r * 2 * s, lx - lr, ly - lr, lr * 2, lr * 2); ctx.restore();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.stroke();
  img.close();

  // Name and what it does, on the left (sizes shrink until they fit beside the editor).
  const x = 90, room = ex - x - 60;
  const fit = (text: string, px: number, weight: number) => { while (px > 12) { ctx.font = font(px, weight); if (ctx.measureText(text).width <= room) break; px -= 2; } return px; };
  const pill = tr ? 'macOS · Windows · Ücretsiz · Çevrimdışı' : 'macOS · Windows · Free · Offline';
  ctx.font = font(22, 600);
  const pw = ctx.measureText(pill).width + 40;
  ctx.fillStyle = 'rgba(124,92,255,0.18)'; ctx.strokeStyle = 'rgba(167,139,250,0.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x, 150, pw, 44, 22); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#d8d0ff'; ctx.fillText(pill, x + 20, 180);
  const brand = 'Focara';
  ctx.font = font(fit(brand, 104, 800), 800);
  const wBrand = ctx.measureText(brand).width;
  const g = ctx.createLinearGradient(x, 0, x + wBrand, 0);
  g.addColorStop(0, '#8b6cff'); g.addColorStop(0.55, '#c084fc'); g.addColorStop(1, '#f472b6');
  ctx.fillStyle = g; ctx.fillText(brand, x, 312);
  const lines = tr ? ['Tıkladığın yere zoom yapan ekran kayıtları.', 'Kamera düzenleri, büyüteç ve gerçek bir editör.']
    : ['Screen recordings that zoom where you click.', 'Webcam layouts, a magnifier and a real editor.'];
  ctx.font = font(Math.min(...lines.map((l) => fit(l, 34, 500))), 500); ctx.fillStyle = '#d4d5ea';
  lines.forEach((l, i) => ctx.fillText(l, x, 386 + i * 50));
  return png(c);
}

// ---------------------------------------------------------------- run

export async function runDocshots() {
  const begun = performance.now();
  try {
    const out = await odak().docshotsDir();
    await odak().selftestTempDir();
    const pkg = await odak().createPackage('Focara Demo');
    const id = uuid();
    const dir = `${pkg}/media/${id}`;
    const save = async (name: string, data: Uint8Array) => { await odak().writeFile(out, name, data); log.push(`wrote ${name}`); };

    // Media
    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9'], { width: W, height: H });
    if (!codec) throw new Error('no video encoder');
    await writeFile(`${dir}/screen.mp4`, async (target) => {
      const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d')!;
      const o = new Output({ format: new Mp4OutputFormat(), target });
      const src = new CanvasSource(canvas, { codec, bitrate: 16e6, keyFrameInterval: 1 });
      o.addVideoTrack(src, { frameRate: FPS });
      await o.start();
      for (let i = 0; i < SECONDS * FPS; i++) { drawApp(ctx, i / FPS); await src.add(i / FPS, 1 / FPS); }
      await o.finalize();
    });
    await writeFile(`${dir}/camera.mp4`, async (target) => {
      const canvas = new OffscreenCanvas(640, 480), ctx = canvas.getContext('2d')!;
      const o = new Output({ format: new Mp4OutputFormat(), target });
      const src = new CanvasSource(canvas, { codec, bitrate: 3e6, keyFrameInterval: 1 });
      o.addVideoTrack(src, { frameRate: 30 });
      await o.start();
      for (let i = 0; i < SECONDS * 30; i++) { drawAvatar(ctx, i); await src.add(i / 30, 1 / 30); }
      await o.finalize();
    });
    const track = cursorTrack();
    await odak().writeFile(pkg, `media/${id}/cursor.json`, new TextEncoder().encode(JSON.stringify(track)));
    await odak().writeFile(pkg, 'assets/sunset.png', await png(drawLandscape(1920, 1080)));

    const asset: MediaAsset = {
      id, kind: 'screenRecording', displayName: 'Screen recording', videoFile: `media/${id}/screen.mp4`, cameraFile: `media/${id}/camera.mp4`,
      cursorFile: `media/${id}/cursor.json`, duration: SECONDS, pixelWidth: W, pixelHeight: H, pixelsPerPoint: 2,
    };
    let p: Project = newProject('Focara Demo');
    p.media = [asset];
    const clip = newClip(id, 0, SECONDS);
    clip.zooms = generateAutoZooms(track, SECONDS);
    p.clips = [clip];
    p.style = {
      ...p.style, backgroundKind: 'theme', backgroundTheme: 'okyanus', padding: 0.07, cursorHighlight: true, clickStyle: 'ring',
      camera: { ...p.style.camera, position: 'bottom-right', size: 0.26, shape: 'circle', mirror: false },
    };
    // Camera: full frame for the intro, then a bubble; out of the way (top left) while the toast shows.
    p = addCameraSegment(p, 0, 1.6, { mode: 'full', position: 'center', size: 0.26 }).project;
    p = addCameraSegment(p, 8.4, 10.8, { mode: 'bubble', position: 'top-left', size: 0.22 }).project;
    p = normalizeProject(p);
    await odak().saveProject(pkg, p);
    log.push(`zooms: ${clip.zooms.map((z) => `${z.start.toFixed(1)}–${z.end.toFixed(1)}`).join(', ')}`);
    // In Turkish (`--lang tr`, for README.tr.md) only the editor screenshots are made: the rendered
    // frames, galleries and GIFs don't depend on the interface language.
    const uiOnly = lang() === 'tr';

    if (!uiOnly) {
      // Rendered frames (exactly what an export contains)
      const lib = new MediaLibrary(pkg);
      const tmp = await odak().selftestTempDir();
      const frame = async (name: string, proj: Project, t: number, o: Partial<ExportSettings> = {}) => {
        const file = `${tmp}/${name}`;
        await exportProject(proj, lib, file, { ...proj.export, format: 'png', resolution: 'p1080', ...o }, () => {}, undefined, { frameTime: t });
        await save(name, await odak().readFile(dirOf(file), baseOf(file), 0, await odak().fileSize(dirOf(file), baseOf(file))));
      };
      await frame('frame-intro-camera.png', p, 0.6);
      await frame('frame-zoom.png', p, 3.9);
      await frame('frame-camera-moved.png', p, 9.6);
      const withImage: Project = { ...p, style: { ...p.style, backgroundKind: 'image', backgroundImage: 'assets/sunset.png', backgroundBlur: 0, padding: 0.09 } };
      await frame('frame-background-image.png', withImage, 9.6);
      await frame('frame-vertical.png', { ...p, export: { ...p.export, aspect: 'vertical' } }, 4.2, { resolution: 'p1080', aspect: 'vertical' });
      await frame('frame-chart.png', withImage, 12.4);

      // Theme galleries
      const english: Record<string, string> = {
        eglenceli: 'Fun', yilbasi: 'New Year', sonbahar: 'Autumn', kutlama: 'Celebration', bahar: 'Spring', uzay: 'Space', okyanus: 'Ocean',
        minimal: 'Minimal light', gece: 'Minimal dark', kurumsal: 'Corporate', grafit: 'Graphite', mermer: 'Marble', blueprint: 'Blueprint',
        aurora: 'Aurora', pastel: 'Pastel', topografya: 'Topographic', kagit: 'Paper', 'siyah-altin': 'Black & Gold', bokeh: 'Office lights',
        finans: 'Finance', cam: 'Glass', geometrik: 'Geometric',
      };
      const gallery = async (name: string, ids: string[], cols: number) => {
        const tw = 600, th = 338, gap = 24, label = 46, rows = Math.ceil(ids.length / cols);
        const g = new OffscreenCanvas(cols * tw + (cols + 1) * gap, rows * (th + label) + (rows + 1) * gap), ctx = g.getContext('2d')!;
        ctx.fillStyle = '#16161a'; ctx.fillRect(0, 0, g.width, g.height);
        ids.forEach((id, i) => {
          const x = gap + (i % cols) * (tw + gap), y = gap + Math.floor(i / cols) * (th + label + gap);
          ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, tw, th, 14); ctx.clip();
          ctx.drawImage(themeCanvas(id, tw, th), x, y); ctx.restore();
          ctx.fillStyle = '#ececf1'; ctx.font = '600 24px -apple-system, "Segoe UI", sans-serif';
          ctx.fillText(english[id] ?? id, x + 4, y + th + 33);
        });
        await save(name, await png(g));
      };
      await gallery('themes-business.png', themesOf('pro').map((t) => t.id), 3);
      await gallery('themes-fun.png', themesOf('fun').map((t) => t.id), 4);
      {
        // The editor with a business theme, for the README.
        const biz: Project = { ...p, style: { ...p.style, backgroundKind: 'theme', backgroundTheme: 'kurumsal', padding: 0.08 } };
        await frame('frame-business-theme.png', biz, 9.6);
        const lensProject = addMagnifier({ ...p, clips: p.clips.map((c) => ({ ...c, zooms: c.zooms.slice(0, 1) })) }, 10.9, 13.5, { size: 0.36, zoom: 2.2, shape: 'circle' }).project;
        await frame('frame-magnifier.png', lensProject, 11.6);
      }

      // Hero GIF: the output itself. Pastel; auto zoom on the clicks; a pause is cut out; then the
      // same recording on other themes while the camera moves aside; the zoom follows the cursor.
      {
        const fps = 12, size = { width: 720, height: 405 };
        const gif = new Gif(size.width, size.height, fps);
        const ctx = new OffscreenCanvas(size.width, size.height).getContext('2d', { willReadFrequently: true })!;
        // Shorter zooms leave a wide view in the middle, where the background can be seen.
        // The end shows the magnifier instead of a second zoom.
        const shorter: Project = { ...p, clips: p.clips.map((c) => ({ ...c, zooms: c.zooms.slice(0, 1).map((z) => ({ ...z, end: 5.8 })) })) };
        const hero = addMagnifier(shorter, 10.9, 13.5, { size: 0.36, zoom: 2.2, shape: 'circle' }).project;
        const segments: { from: number; to: number; theme: string; captions: [number, number, string][] }[] = [
          { from: 0, to: 6.4, theme: 'pastel', captions: [[0, 1.6, '🎥 Camera full frame for the intro'], [1.7, 5.6, '🔍 Auto zoom on every click']] },
          { from: 7.4, to: 8.2, theme: 'pastel', captions: [[7.4, 8.2, '✂ Cut: the pause is gone']] },
          { from: 8.2, to: 9.0, theme: 'topografya', captions: [[8.2, 9.0, '🎨 Theme: Topographic']] },
          { from: 9.0, to: 9.8, theme: 'aurora', captions: [[9.0, 9.8, '🎨 Theme: Aurora']] },
          { from: 9.8, to: 10.6, theme: 'kurumsal', captions: [[9.8, 10.6, '🎨 Theme: Corporate']] },
          { from: 10.6, to: 13.6, theme: 'pastel', captions: [[11.0, 13.6, '🔍 A magnifier follows your cursor']] },
        ];
        for (const seg of segments) {
          const ps: Project = { ...hero, style: { ...hero.style, backgroundKind: 'theme', backgroundTheme: seg.theme, padding: 0.07 } };
          const data = await lib.allRenderData(ps);
          const count = Math.round((seg.to - seg.from) * fps);
          for await (const k of renderFrames(ps, lib, data, ctx, size, fps, seg.from, count)) {
            const t = seg.from + k / fps;
            for (const [a, b, text] of seg.captions) {
              if (t >= a && t < b) caption(ctx, size.width, size.height, text, Math.min(1, (t - a) / 0.2 + 0.4, (b - t) / 0.2 + 0.4));
            }
            gif.add(ctx.getImageData(0, 0, size.width, size.height).data);
          }
        }
        await save('demo.gif', gif.bytes());
      }

      // Feature GIFs: the output of one feature each, with captions.
      const outputGif = async (name: string, proj: Project, from: number, to: number, fps: number, captions: [number, number, string][], top = false) => {
        const size = { width: 800, height: 450 };
        const gif = new Gif(size.width, size.height, fps);
        const ctx = new OffscreenCanvas(size.width, size.height).getContext('2d', { willReadFrequently: true })!;
        const data = await lib.allRenderData(proj);
        for await (const k of renderFrames(proj, lib, data, ctx, size, fps, from, Math.round((to - from) * fps))) {
          const t = from + k / fps;
          for (const [a, b, text] of captions) {
            if (t >= a && t < b) caption(ctx, size.width, size.height, text, Math.min(1, (t - a) / 0.2 + 0.4, (b - t) / 0.2 + 0.4), top);
          }
          gif.add(ctx.getImageData(0, 0, size.width, size.height).data);
        }
        await save(name, gif.bytes());
      };
      {
        // The webcam's layouts on the timeline: full frame, out of the way, hidden, bigger elsewhere
        // (captions at the top: the camera ends at the bottom left).
        let cam: Project = { ...p, clips: p.clips.map((c) => ({ ...c, cameraSegments: [] })),
          style: { ...p.style, backgroundKind: 'theme', backgroundTheme: 'aurora', padding: 0.07 } };
        cam = addCameraSegment(cam, 0, 1.6, { mode: 'full', position: 'center', size: 0.26 }).project;
        cam = addCameraSegment(cam, 3.1, 4.7, { mode: 'bubble', position: 'top-right', size: 0.22 }).project;
        cam = addCameraSegment(cam, 5.7, 7.3, { mode: 'hidden', position: 'bottom-right', size: 0.26 }).project;
        cam = addCameraSegment(cam, 8.2, 10.0, { mode: 'bubble', position: 'bottom-left', size: 0.36 }).project;
        await outputGif('camera.gif', cam, 0, 10.2, 12, [
          [0, 1.6, '🎥 Webcam full frame for the intro'], [1.8, 5.0, '↗ Moves out of the way for a moment'],
          [5.2, 7.6, '⊘ Hides while you show something'], [7.8, 10.2, '↙ Any corner, any size'],
        ], true);
      }
      {
        // The magnifier over the whole screen (no zoom), following the cursor.
        const flat: Project = { ...p, clips: p.clips.map((c) => ({ ...c, zooms: [], cameraSegments: [] })),
          style: { ...p.style, backgroundKind: 'theme', backgroundTheme: 'gece', padding: 0.06 } };
        const lens = addMagnifier(flat, 9.0, 14, { size: 0.34, zoom: 2.4, shape: 'circle' }).project;
        await outputGif('magnifier.gif', lens, 9.3, 13.9, 15, [[9.3, 13.9, '🔍 A magnifier follows your cursor']]);
      }
      {
        // One recording, three shapes, playing side by side.
        const fps = 12, from = 1.6, count = Math.round(4.8 * fps), CW = 1040, CH = 420;
        const panes = ([['wide', 480, 270, '16:9 · YouTube'], ['vertical', 152, 270, '9:16 · Shorts, Reels, TikTok'], ['square', 270, 270, '1:1 · Feeds']] as const)
          .map(([aspect, width, height, label]) => {
            const proj: Project = { ...p, style: { ...p.style, backgroundKind: 'theme', backgroundTheme: 'pastel', padding: 0.07 }, export: { ...p.export, aspect } };
            const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
            return { proj, ctx, size: { width, height }, label };
          });
        const its = await Promise.all(panes.map(async (q) => renderFrames(q.proj, lib, await lib.allRenderData(q.proj), q.ctx, q.size, fps, from, count)));
        const gif = new Gif(CW, CH, fps);
        const out = new OffscreenCanvas(CW, CH).getContext('2d', { willReadFrequently: true })!;
        const font = (px: number, w = 650) => `${w} ${px}px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
        for (let k = 0; k < count; k++) {
          for (const it of its) await it.next();
          const bg = out.createLinearGradient(0, 0, CW, CH); bg.addColorStop(0, '#12111f'); bg.addColorStop(1, '#1d1230');
          out.fillStyle = bg; out.fillRect(0, 0, CW, CH);
          out.fillStyle = '#fff'; out.font = font(26, 750); out.textAlign = 'center';
          out.fillText('One recording → every format', CW / 2, 46);
          let x = (CW - panes.reduce((s, q) => s + q.size.width, 0) - 2 * 40) / 2;
          for (const q of panes) {
            const y = 74;
            out.save(); out.beginPath(); out.roundRect(x, y, q.size.width, q.size.height, 10); out.clip();
            out.drawImage(q.ctx.canvas, x, y); out.restore();
            out.strokeStyle = 'rgba(255,255,255,0.14)'; out.lineWidth = 1; out.beginPath(); out.roundRect(x + 0.5, y + 0.5, q.size.width - 1, q.size.height - 1, 10); out.stroke();
            out.fillStyle = '#d9d6f5'; out.font = font(16, 600); out.fillText(q.label, x + q.size.width / 2, y + q.size.height + 30);
            x += q.size.width + 40;
          }
          out.textAlign = 'start';
          gif.add(out.getImageData(0, 0, CW, CH).data);
        }
        await Promise.all(its.map((it) => it.return(undefined)));
        await save('formats.gif', gif.bytes());
      }
      lib.dispose();
    }

    // The editor itself
    const hooks = () => (window as unknown as { __odak: { openProject: (p: string) => Promise<void>; store: EditorStore | null } }).__odak;
    const ed = () => (window as unknown as { __odakEditor: { player: { seek: (t: number) => Promise<void>; idle: () => Promise<void> }; setRange: (r: { a: number; b: number } | null) => void } }).__odakEditor;
    const store = () => hooks().store!;
    const shot = async (name: string) => {
      await sleep(250); await ed().player.idle(); await sleep(150);
      const f = await odak().uiTestCapture(name.replace(/\.png$/, ''));
      const bytes = await odak().readFile(dirOf(f), baseOf(f), 0, await odak().fileSize(dirOf(f), baseOf(f)));
      await save(name, bytes);
      return bytes;
    };
    const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    while (!$('.home')) await sleep(30);
    await hooks().openProject(pkg);
    while (!$('.editor') || !(window as unknown as { __odakEditor?: unknown }).__odakEditor) await sleep(30);
    await sleep(1500);

    await ed().player.seek(3.9);
    await save('banner.png', await banner(await shot('editor.png')));

    const seg = store().project.clips[0].cameraSegments.find((s) => s.mode === 'bubble')!;
    store().select({ kind: 'camera', clipID: store().project.clips[0].id, segID: seg.id });
    await ed().player.seek(9.6);
    await shot('camera-segments.png');
    store().select(null);

    key('r');
    ed().setRange({ a: 6.4, b: 8.2 });
    await ed().player.seek(6.4);
    await shot('editing-tools.png');
    ed().setRange(null); key('Escape');

    store().update((q) => ({ ...q, style: { ...q.style, backgroundKind: 'image', backgroundImage: 'assets/sunset.png', backgroundBlur: 0, padding: 0.09 } }));
    await ed().player.seek(9.6);
    await shot('background-image.png');

    store().update((q) => ({ ...q, export: { ...q.export, aspect: 'vertical' } }));
    await shot('vertical.png');
    store().update((q) => ({ ...q, export: { ...q.export, aspect: 'wide' }, style: { ...q.style, backgroundKind: 'theme', backgroundTheme: 'okyanus' } }));

    click(byText('.toolbar button', t('Dışa Aktar')));
    while (!byText('.modal h2', t('Dışa Aktar'))) await sleep(30);
    await shot('export-dialog.png');
    click(byText('.modal button', t('Kapat')));
    await sleep(200);

    click($('.toolbar .settings-btn'));
    while (!$('.modal.settings')) await sleep(30);
    await shot('settings.png');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    while ($('.modal.settings')) await sleep(30);

    // Editor GIFs: the real editor with a drawn mouse pointer, filmed by a camera that moves in on
    // each step, the way Focara zooms in on clicks.
    if (!uiOnly) {
      const fps = 12, OW = 1000, OH = 625, WW = innerWidth, WH = innerHeight;
      const ctx = new OffscreenCanvas(OW, OH).getContext('2d', { willReadFrequently: true })!;
      const player = ed().player as unknown as { seek: (t: number) => Promise<void>; idle: () => Promise<void> };
      // The camera's view: a part of the window (window pixels) with the window's shape. Each move
      // glides there in a fixed number of frames and then holds still, so still moments stay cheap.
      type View = { x: number; y: number; w: number };
      const viewAt = (cx: number, cy: number, z: number): View => {
        const w = WW / z, h = WH / z;
        return { x: Math.min(Math.max(cx - w / 2, 0), WW - w), y: Math.min(Math.max(cy - h / 2, 0), WH - h), w };
      };
      const MOVE = 10;
      let gif = new Gif(OW, OH, fps);
      let pointerAt = { x: 980, y: 520 }, clock = 1.5, pressed = 0, step = 1 / fps;
      let cam = viewAt(WW / 2, WH / 2, 1), camFrom = cam, camTo = cam, movedAt = 0;
      let say = '', saidAt = 0, frame = 0;
      const moveTo = (v: View) => { camFrom = cam; camTo = v; movedAt = frame; };
      const look = (r: { left: number; top: number; width: number; height: number }, z: number) => moveTo(viewAt(r.left + r.width / 2, r.top + r.height / 2, z));
      const wide = () => moveTo(viewAt(WW / 2, WH / 2, 1));
      const tell = (text: string) => { say = text; saidAt = frame; };
      const restart = () => { gif = new Gif(OW, OH, fps); frame = 0; cam = camFrom = camTo; movedAt = -MOVE; };
      const snap = async (advance = true) => {
        if (advance) { clock = Math.min(clock + step, projectDuration(store().project) - 0.2); await player.seek(clock); }
        await player.idle(); await sleep(40);
        const q = ease((frame - movedAt + 1) / MOVE);
        cam = { x: lerp(camFrom.x, camTo.x, q), y: lerp(camFrom.y, camTo.y, q), w: Math.exp(lerp(Math.log(camFrom.w), Math.log(camTo.w), q)) };
        const vx = cam.x, vy = cam.y, vw = cam.w, vh = (cam.w * WH) / WW;
        const f = await odak().uiTestCapture('editor-frame');
        const bytes = await odak().readFile(dirOf(f), baseOf(f), 0, await odak().fileSize(dirOf(f), baseOf(f)));
        const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
        const s = bmp.width / WW, m = OW / vw;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, vx * s, vy * s, vw * s, vh * s, 0, 0, OW, OH);
        bmp.close();
        const px = (pointerAt.x - vx) * m, py = (pointerAt.y - vy) * m;
        if (pressed > 0) {
          ctx.fillStyle = 'rgba(123,108,255,0.35)'; ctx.beginPath(); ctx.arc(px, py, 13 * m, 0, Math.PI * 2); ctx.fill();
          pressed--;
        }
        drawCursor(ctx, { x: px, y: py }, 1.7 * m, 'arrow', { r: 1, g: 1, b: 1, a: 1 });
        if (say) caption(ctx, OW, OH, say, Math.min(1, (frame - saidAt) / 3 + 0.3), true, 0.045);
        gif.add(ctx.getImageData(0, 0, OW, OH).data);
        frame++;
      };
      const center = (el: Element | null) => { if (!el) throw new Error('element not found'); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const glide = async (to: { x: number; y: number }, frames: number, onStep?: (pt: { x: number; y: number }) => void) => {
        const from = pointerAt;
        for (let i = 1; i <= frames; i++) {
          const e = i / frames, q = e * e * (3 - 2 * e);
          pointerAt = { x: from.x + (to.x - from.x) * q, y: from.y + (to.y - from.y) * q };
          onStep?.(pointerAt);
          await snap();
        }
      };
      const tap = async (el: Element | null, frames = 6) => { await glide(center(el), frames); pressed = 2; click(el); await snap(); };
      const hold = async (n: number) => { for (let i = 0; i < n; i++) await snap(); };
      const inner = () => $('.timeline-inner')!;
      const xAt = (t: number) => { const sc = $('.timeline')!; return inner().getBoundingClientRect().left + 18 + t * ((sc.clientWidth - 36) / projectDuration(store().project)); };
      const clipY = () => { const c = $('.clip')!.getBoundingClientRect(); return c.top + c.height / 2; };
      const pe = (el: Element, type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }));

      const upper = { left: 240, top: 0, width: 1200, height: 750 }; // preview and the whole side panel
      const lane = (t0: number) => ({ left: xAt(t0) - 300, top: 600, width: 600, height: 300 });
      const clip0 = () => store().project.clips[0];
      store().update((q) => ({ ...q, style: { ...q.style, backgroundKind: 'theme', backgroundTheme: 'pastel', padding: 0.07 } }));
      store().select(null); key('Escape');
      clock = 1.5; await player.seek(clock); await sleep(300);

      // 1. The zooms are already there.
      tell('✦ Every click became a zoom, automatically');
      await hold(16);
      // 2. Edit one: a deeper zoom, then a fixed point to zoom into.
      const zoomEl = $$('.zoom')[0];
      look(zoomEl.getBoundingClientRect(), 2.2);
      await glide(center(zoomEl), 10);
      pressed = 2; store().select({ kind: 'zoom', clipID: clip0().id, zoomID: clip0().zooms[0].id });
      step = 0; // edited while paused, as you would
      await hold(4);
      tell('🎯 Every zoom is editable');
      look(upper, 1.2);
      await tap(byText('.inspector .chips button', '×3'), 9); await hold(10);
      await tap(byText('.inspector .segmented button', t('Sabit nokta')), 7);
      while (!$('.focus-picker')) await sleep(30);
      await sleep(300);
      const fp = $('.focus-picker')!, fr = fp.getBoundingClientRect(), spot = { x: fr.left + fr.width * 0.7, y: fr.top + fr.height * 0.66 };
      await glide(spot, 8);
      pressed = 2; pe(fp, 'pointerdown', spot.x, spot.y); pe(fp, 'pointerup', spot.x, spot.y);
      await hold(12);
      await tap(byText('.inspector-back button', t('Genel ayarlara dön')), 7);
      // 3. The webcam: full frame for a moment, then out of the way.
      tell('🎥 The webcam gets its own layouts');
      step = 0.04;
      const camButton = byText('.timeline-bar button', t('Kamera'))!;
      look(camButton.getBoundingClientRect(), 1.5);
      await tap(camButton, 9);
      look(upper, 1.2); await hold(3);
      await tap(byText('.inspector .segmented button', t('Tam ekran')), 9); await hold(10);
      await tap(byText('.inspector .segmented button', t('Balon')), 7);
      await tap($$('.positions button').find((b) => b.title === t('Sol üst')) ?? null, 6); await hold(9);
      await tap(byText('.inspector-back button', t('Genel ayarlara dön')), 6);
      wide(); await hold(8);
      await save('editing.gif', gif.bytes());

      // Second GIF: the magnifier and themes.
      restart();
      // 4. A magnifier where the cursor moves over the chart.
      clock = 10.6; await player.seek(clock);
      tell('🔍 A magnifier that follows your cursor');
      step = 1 / fps;
      const lensButton = byText('.timeline-bar button', t('Büyüteç'))!;
      look(lensButton.getBoundingClientRect(), 1.5);
      await tap(lensButton, 9);
      look($('.preview')!.getBoundingClientRect(), 1.35);
      await hold(18);
      step = 0.02;
      look(upper, 1.2);
      await tap(byText('.inspector .chips button', '×3'), 7); await hold(10);
      await tap(byText('.inspector-back button', t('Genel ayarlara dön')), 6);
      // 5. Themes, while the view is wide (between two zooms).
      clock = 9.3; await player.seek(clock);
      step = 0;
      tell('🎨 22 themes, one click each');
      await tap(byText('.theme', t('Topoğrafya')), 8); await hold(5);
      await tap(byText('.theme', t('Aurora')), 5); await hold(5);
      await tap(byText('.theme', t('Geometrik')), 5); await hold(5);
      await tap(byText('.theme', t('Pastel')), 5); await hold(4);
      wide(); await hold(8);
      await save('looks.gif', gif.bytes());

      // Third GIF: cutting and speeding up on the timeline, then export.
      restart();
      clock = 4.6; await player.seek(clock); step = 1 / fps;
      tell('✂ Cut where you click');
      look(lane(5.4), 1.9);
      await tap(byText('.timeline-bar button', t('Makas')), 8);
      const cutT = 5.4;
      await glide({ x: xAt(cutT), y: clipY() }, 7, (pt) => pe(inner(), 'pointermove', pt.x, pt.y));
      await hold(2);
      pressed = 2; pe($('.clip')!, 'pointerdown', xAt(cutT), clipY()); pe(inner(), 'pointerup', xAt(cutT), clipY());
      clock = cutT;
      await hold(6);
      tell('⏩ Select a slow part, play it ×4');
      look(lane(7.5), 1.8);
      await tap(byText('.timeline-bar button', t('Aralık')), 7);
      await glide({ x: xAt(6.6), y: clipY() }, 6);
      const clipAt = () => $$('.clip').find((c) => { const r = c.getBoundingClientRect(); return r.left <= pointerAt.x && r.right >= pointerAt.x; }) ?? $('.clip')!;
      pressed = 1; pe(clipAt(), 'pointerdown', pointerAt.x, pointerAt.y);
      await glide({ x: xAt(8.4), y: clipY() }, 7, (pt) => pe(inner(), 'pointermove', pt.x, pt.y));
      pe(inner(), 'pointerup', pointerAt.x, pointerAt.y);
      await hold(3);
      await tap(byText('.range-bar button', '×4'), 6); await hold(8);
      tell('📤 Export MP4, GIF, vertical 9:16, square 1:1…');
      wide();
      await tap(byText('.toolbar button', t('Dışa Aktar')), 10);
      while (!byText('.modal h2', t('Dışa Aktar'))) await sleep(30);
      look($('.modal')!.getBoundingClientRect(), 1.35); await hold(14);
      click(byText('.modal button', t('Kapat')));
      wide(); await hold(6);
      await save('cutting.gif', gif.bytes());
    }
  } catch (e) {
    log.push(`FAIL: ${(e as Error).stack ?? e}`);
    failures++;
  }
  log.push(`docshots took ${((performance.now() - begun) / 1000).toFixed(1)}s`);
  odak().selftestDone({ ok: failures === 0, log });
}
