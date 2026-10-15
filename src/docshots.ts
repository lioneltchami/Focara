// Documentation screenshots (npm run docshots): builds a demo project — a made-up analytics web
// app, an illustrated webcam avatar and a painted sunset background, all drawn in code — opens it
// in the real editor and saves screenshots, rendered frames and a GIF into docs/images.
import { CanvasSource, Mp4OutputFormat, Output, StreamTarget, getFirstEncodableVideoCodec } from 'mediabunny';
import { odak } from './bridge.ts';
import { type CursorTrack, type ExportSettings, type MediaAsset, type Project, newClip, newProject, normalizeProject, uuid } from './core/model.ts';
import { generateAutoZooms } from './core/zoom.ts';
import { addCameraSegment } from './core/edit.ts';
import { exportProject } from './media/exporter.ts';
import { MediaLibrary } from './media/media.ts';
import { themeCanvas, themes } from './render/themes.ts';
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
async function png(c: OffscreenCanvas) { return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); }

// ---------------------------------------------------------------- the demo "recording"

/** Where the cursor is (screen pixels) and the clicks of the story. */
const CLICKS = [2.0, 3.0, 5.4, 11.2];
const KEYS: [number, number, number][] = [ // time, x, y
  [0, 1500, 980], [1.7, 1668, 200], [2.2, 1668, 204], [2.9, 900, 560], [3.1, 902, 562], [4.6, 1110, 700],
  [5.2, 1318, 812], [5.6, 1320, 814], [7.0, 1100, 1000], [9.5, 1000, 980], [10.9, 664, 760], [11.3, 664, 760], [12.8, 900, 980], [14, 1000, 1010],
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

// ---------------------------------------------------------------- run

export async function runDocshots() {
  const begun = performance.now();
  try {
    const out = await odak().docshotsDir();
    await odak().selftestTempDir();
    const pkg = await odak().createPackage('Odak Demo');
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
    let p: Project = newProject('Odak Demo');
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
    await gallery('themes-business.png', themes.filter((t) => t.group === 'pro').map((t) => t.id), 3);
    await gallery('themes-fun.png', themes.filter((t) => t.group === 'fun').map((t) => t.id), 4);
    {
      // The editor with a business theme, for the README.
      const biz: Project = { ...p, style: { ...p.style, backgroundKind: 'theme', backgroundTheme: 'kurumsal', padding: 0.08 } };
      await frame('frame-business-theme.png', biz, 9.6);
    }

    // Demo GIF made by Odak itself
    {
      const file = `${tmp}/demo.gif`;
      await exportProject(p, lib, file, { ...p.export, format: 'gif', gifWidth: 720, gifFps: 15 }, () => {}, undefined, { range: { from: 0, to: 13 } });
      await save('demo.gif', await odak().readFile(dirOf(file), baseOf(file), 0, await odak().fileSize(dirOf(file), baseOf(file))));
    }
    lib.dispose();

    // The editor itself
    const hooks = () => (window as unknown as { __odak: { openProject: (p: string) => Promise<void>; store: EditorStore | null } }).__odak;
    const ed = () => (window as unknown as { __odakEditor: { player: { seek: (t: number) => Promise<void>; idle: () => Promise<void> }; setRange: (r: { a: number; b: number } | null) => void } }).__odakEditor;
    const store = () => hooks().store!;
    const shot = async (name: string) => {
      await sleep(250); await ed().player.idle(); await sleep(150);
      const f = await odak().uiTestCapture(name.replace(/\.png$/, ''));
      await save(name, await odak().readFile(dirOf(f), baseOf(f), 0, await odak().fileSize(dirOf(f), baseOf(f))));
    };
    const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    while (!$('.home')) await sleep(30);
    await hooks().openProject(pkg);
    while (!$('.editor') || !(window as unknown as { __odakEditor?: unknown }).__odakEditor) await sleep(30);
    await sleep(1500);

    await ed().player.seek(3.9);
    await shot('editor.png');

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

    click(byText('.toolbar button', 'Dışa Aktar'));
    while (!byText('.modal h2', 'Dışa Aktar')) await sleep(30);
    await shot('export-dialog.png');
    click(byText('.modal button', 'Kapat'));
  } catch (e) {
    log.push(`FAIL: ${(e as Error).stack ?? e}`);
    failures++;
  }
  log.push(`docshots took ${((performance.now() - begun) / 1000).toFixed(1)}s`);
  odak().selftestDone({ ok: failures === 0, log });
}
