// Performance test: builds a heavy, realistic project (long high-resolution screen recording with
// sparse key frames, camera, two audio tracks, many cuts, sped-up clips, zooms and camera
// segments) and drives the real editor in a visible window: playback across cuts, scrubbing,
// editing, timeline zoom/scroll and export. Thresholds fail the run locally; with --perf-report
// (CI machines have no GPU) the numbers are only reported.
import {
  AudioBufferSource, CanvasSource, Mp4OutputFormat, Output, StreamTarget, WavOutputFormat, getFirstEncodableVideoCodec,
} from 'mediabunny';
import { odak } from './bridge.ts';
import { type CursorTrack, type MediaAsset, clipStarts, newClip, newProject, normalizeProject, projectDuration, uuid } from './core/model.ts';
import { generateAutoZooms } from './core/zoom.ts';
import { addCameraSegment, setClipSpeed, splitAt } from './core/edit.ts';
import { exportProject } from './media/exporter.ts';
import { MediaLibrary } from './media/media.ts';
import { PlaybackStats, type Player } from './media/player.ts';
import type { EditorStore } from './ui/store.ts';
import { themeCanvas, themes } from './render/themes.ts';

const W = 2560, H = 1600, FPS = 60, SECONDS = 40;
const log: string[] = [];
let failures = 0;
const reportOnly = odak().perfReportOnly;
const check = (ok: boolean, msg: string) => { log.push(`${ok ? 'PASS' : reportOnly ? 'WARN' : 'FAIL'}: ${msg}`); if (!ok && !reportOnly) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T | null;
const ms = (x: number) => `${x.toFixed(1)} ms`;
const quantile = (a: number[], q: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))] : 0);

/** Main-thread smoothness: intervals between animation frames while something happens. */
class FrameMonitor {
  private times: number[] = [];
  private running = false;
  start() {
    this.times = []; this.running = true;
    const tick = (t: number) => { if (!this.running) return; this.times.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  stop() {
    this.running = false;
    const d = this.times.slice(1).map((t, i) => t - this.times[i]);
    return { n: d.length, p50: quantile(d, 0.5), p95: quantile(d, 0.95), max: Math.max(0, ...d), hitches: d.filter((x) => x > 50).length };
  }
}
const describe = (r: ReturnType<FrameMonitor['stop']>) => `frame interval p50 ${ms(r.p50)}, p95 ${ms(r.p95)}, max ${ms(r.max)}, hitches>50ms ${r.hitches}`;

async function writeFile(path: string, build: (target: StreamTarget) => Promise<void>) {
  const h = await odak().fileOpen(path);
  try {
    await build(new StreamTarget(new WritableStream({ write: (c) => odak().fileWrite(h, c.data, c.position) }), { chunked: true }));
  } finally { await odak().fileClose(h); }
}

/** Busy screen content: every frame changes (worst case for decoding). */
function drawScreen(ctx: OffscreenCanvasRenderingContext2D, i: number) {
  ctx.fillStyle = '#f4f4f6'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#d0d0d8';
  for (let x = 0; x < W; x += 64) ctx.fillRect(x, 0, 1, H);
  for (let y = 0; y < H; y += 64) ctx.fillRect(0, y, W, 1);
  for (let k = 0; k < 12; k++) {
    ctx.fillStyle = `hsl(${(k * 30 + i) % 360}, 70%, 55%)`;
    ctx.fillRect((k * 211 + i * (k + 1) * 2) % (W - 240), (k * 127 + i * 3) % (H - 160), 240, 160);
  }
  ctx.fillStyle = '#111'; ctx.font = 'bold 72px monospace'; ctx.fillText(`frame ${i}`, 120, 140);
  ctx.font = '28px sans-serif';
  for (let l = 0; l < 20; l++) ctx.fillText(`satır ${l} · ${(i * 7 + l * 13) % 1000} — Lorem ipsum dolor sit amet`, 140, 260 + l * 56);
}

function cursorPath(): CursorTrack {
  const t: CursorTrack = { samples: [], clicks: [] };
  for (let i = 0; i <= SECONDS * 120; i++) {
    const s = i / 120;
    t.samples.push({ t: s, x: 1280 + 900 * Math.sin(s * 0.7) + 200 * Math.sin(s * 3.1), y: 800 + 500 * Math.cos(s * 0.5) + 120 * Math.sin(s * 2.3) });
  }
  for (let c = 1; c < SECONDS - 1; c += 1.7) {
    const p = t.samples[Math.round(c * 120)];
    t.clicks.push({ t: c, x: p.x, y: p.y, isDown: true, button: 0 }, { t: c + 0.08, x: p.x, y: p.y, isDown: false, button: 0 });
  }
  return t;
}

async function wav(path: string, seconds: number, freq: number) {
  await writeFile(path, async (target) => {
    const out = new Output({ format: new WavOutputFormat(), target });
    const src = new AudioBufferSource({ codec: 'pcm-s16' });
    out.addAudioTrack(src);
    await out.start();
    for (let s = 0; s < seconds; s += 5) {
      const n = 5 * 48000;
      const buf = new OfflineAudioContext(2, n, 48000).createBuffer(2, n, 48000);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < n; i++) d[i] = 0.2 * Math.sin((2 * Math.PI * freq * (s * 48000 + i)) / 48000) * (0.5 + 0.5 * Math.sin(i / 9000));
      }
      await src.add(buf);
    }
    await out.finalize();
  });
}

export async function runPerfTest() {
  const begun = performance.now();
  try {
    log.push(`platform: ${odak().platform}, ${navigator.hardwareConcurrency} cores, display ${screen.width}×${screen.height}@${devicePixelRatio}x`);
    await odak().selftestTempDir();
    const pkg = await odak().createPackage('PerfTest');
    const id = uuid();
    const dir = `${pkg}/media/${id}`;

    // ---- 1. Media: worst case for the decoder (busy frames, key frames 5 s apart).
    let t = performance.now();
    const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9'], { width: W, height: H });
    if (!vcodec) throw new Error('no video encoder');
    await writeFile(`${dir}/screen.mp4`, async (target) => {
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d')!;
      const out = new Output({ format: new Mp4OutputFormat(), target });
      const src = new CanvasSource(canvas, { codec: vcodec, bitrate: 25e6, keyFrameInterval: 2 });
      out.addVideoTrack(src, { frameRate: FPS });
      await out.start();
      for (let i = 0; i < SECONDS * FPS; i++) { drawScreen(ctx, i); await src.add(i / FPS, 1 / FPS); }
      await out.finalize();
    });
    await writeFile(`${dir}/camera.mp4`, async (target) => {
      const canvas = new OffscreenCanvas(1280, 720);
      const ctx = canvas.getContext('2d')!;
      const out = new Output({ format: new Mp4OutputFormat(), target });
      const src = new CanvasSource(canvas, { codec: vcodec, bitrate: 4e6, keyFrameInterval: 1 });
      out.addVideoTrack(src, { frameRate: 30 });
      await out.start();
      for (let i = 0; i < SECONDS * 30; i++) {
        ctx.fillStyle = `hsl(${(i * 2) % 360}, 50%, 40%)`; ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = '#f2c9a0'; ctx.beginPath(); ctx.arc(640 + 40 * Math.sin(i / 10), 380, 220, 0, Math.PI * 2); ctx.fill();
        await src.add(i / 30, 1 / 30);
      }
      await out.finalize();
    });
    await wav(`${dir}/system.wav`, SECONDS, 440);
    await wav(`${dir}/mic.wav`, SECONDS, 220);
    const track = cursorPath();
    await odak().writeFile(pkg, `media/${id}/cursor.json`, new TextEncoder().encode(JSON.stringify(track)));
    log.push(`media: ${SECONDS} s ${W}×${H}@${FPS} ${vcodec} (key frames every 2 s) + camera 1280×720@30 + 2 WAV, built in ${((performance.now() - t) / 1000).toFixed(1)} s`);

    // ---- 2. A heavily edited project.
    const asset: MediaAsset = {
      id, kind: 'screenRecording', displayName: 'Perf', videoFile: `media/${id}/screen.mp4`, systemAudioFile: `media/${id}/system.wav`,
      microphoneFile: `media/${id}/mic.wav`, cameraFile: `media/${id}/camera.mp4`, cursorFile: `media/${id}/cursor.json`,
      duration: SECONDS, pixelWidth: W, pixelHeight: H, pixelsPerPoint: 2,
    };
    let project = newProject('PerfTest');
    project.media = [asset];
    const clip = newClip(id, 0, SECONDS);
    clip.zooms = generateAutoZooms(track, SECONDS);
    project.clips = [clip];
    project.style = { ...project.style, backgroundKind: 'theme', backgroundTheme: 'kutlama', cursorHighlight: true, hideIdleCursor: true };
    for (let s = 2.5; s < SECONDS; s += 2.5) { const r = splitAt(project, s); if ('project' in r) project = r.project; }
    project = setClipSpeed(project, project.clips[3].id, 2);
    project = setClipSpeed(project, project.clips[8].id, 4);
    project = addCameraSegment(project, 4, 7, { mode: 'full', position: 'center', size: 0.3 }).project;
    project = addCameraSegment(project, 10, 14, { mode: 'bubble', position: 'top-center', size: 0.22 }).project;
    project = normalizeProject(project);
    await odak().saveProject(pkg, project);
    log.push(`project: ${project.clips.length} clips, ${project.clips.reduce((n, c) => n + c.zooms.length, 0)} zooms, ${projectDuration(project).toFixed(1)} s timeline`);

    // ---- 3. Open it in the editor.
    const hooks = () => (window as unknown as { __odak: { openProject: (p: string) => Promise<void>; store: EditorStore | null } }).__odak;
    while (!$('.home')) await sleep(30);
    t = performance.now();
    await hooks().openProject(pkg);
    while (!$('.editor') || !(window as unknown as { __odakEditor?: unknown }).__odakEditor) await sleep(10);
    const player = () => (window as unknown as { __odakEditor: { player: Player } }).__odakEditor.player;
    await sleep(50);
    await player().idle();
    const openMs = performance.now() - t;
    check(openMs < 2500, `open project → first frame: ${ms(openMs)}`);
    await sleep(1500); // waveforms etc. settle

    const mon = new FrameMonitor();
    // Input the test didn't make (someone using the machine meanwhile) and focus/visibility changes
    // explain an odd number; they're listed with the results.
    const t0 = performance.now(), outside: string[] = [];
    const note = (what: string) => { if (outside.length < 12) outside.push(`${((performance.now() - t0) / 1000).toFixed(2)}s ${what}`); };
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'keydown'])
      window.addEventListener(type, (e) => { if (e.isTrusted) note(type); }, true);
    window.addEventListener('blur', () => note('window blur'));
    window.addEventListener('focus', () => note('window focus'));
    document.addEventListener('visibilitychange', () => note(`visibility ${document.visibilityState}`));
    const clipStartsOf = () => clipStarts(hooks().store!.project).slice(1, 8);
    const heap = () => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6;
    const heap0 = heap();

    // ---- 4. Playback across cuts, speed changes, zooms and camera moves.
    const pl = player();
    await pl.seek(0);
    pl.stats = new PlaybackStats();
    const longTasks: string[] = [];
    let playStart = 0;
    const lt = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(`${((e.startTime - playStart) / 1000).toFixed(2)}s:${e.duration.toFixed(0)}ms`);
    });
    try { lt.observe({ type: 'longtask', buffered: false }); } catch { /* not supported */ }
    mon.start();
    t = playStart = performance.now();
    pl.play();
    await sleep(12000);
    pl.pause();
    lt.disconnect();
    const elapsed = (performance.now() - t) / 1000;
    if (longTasks.length) log.push(`long tasks during playback: ${longTasks.join(', ')} (cuts at ${clipStartsOf().map((x) => x.toFixed(2)).join(' ')} s)`);
    const ui = mon.stop();
    const st = pl.stats;
    pl.stats = null;
    const fps = st.frames / elapsed;
    check(fps >= 50, `playback: ${fps.toFixed(1)} frames drawn/s over ${elapsed.toFixed(1)} s`);
    check(st.late / Math.max(1, st.frames) <= 0.03, `playback: ${st.late} of ${st.frames} frames late (> 2.5 frames behind the clock)`);
    check(st.maxGap <= 60, `playback: longest gap between frames ${ms(st.maxGap)} (cuts included)`);
    check(ui.hitches === 0 && ui.p95 <= 25, `playback UI: ${describe(ui)}`);

    // ---- 5. Scrubbing by dragging the playhead head.
    const knob = $('.playhead-knob')!;
    const scroller = $('.timeline')!;
    const sr = scroller.getBoundingClientRect();
    const pointer = (el: Element, type: string, x: number) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: knob.getBoundingClientRect().top + 8, pointerId: 1, isPrimary: true, button: 0 }));
    pl.stats = new PlaybackStats();
    mon.start();
    pointer(knob, 'pointerdown', knob.getBoundingClientRect().left + 8);
    t = performance.now();
    for (let k = 0; k <= 120; k++) {
      pointer(knob, 'pointermove', sr.left + 20 + ((sr.width - 60) * (k % 60)) / 60);
      await sleep(16);
    }
    pointer(knob, 'pointerup', sr.left + 40);
    const scrubSecs = (performance.now() - t) / 1000;
    const settleStart = performance.now();
    await player().idle();
    const settle = performance.now() - settleStart;
    const scrubUi = mon.stop();
    const stills = pl.stats.stills / scrubSecs;
    log.push(`scrub draws: n=${pl.stats.drawMs.length} p50 ${ms(quantile(pl.stats.drawMs, 0.5))} max ${ms(Math.max(0, ...pl.stats.drawMs))}; ${scrubSecs.toFixed(2)} s of dragging`);
    pl.stats = null;
    check(stills >= 15, `scrubbing: ${stills.toFixed(1)} frames shown/s while dragging`);
    check(settle <= 250, `scrubbing: last frame ${ms(settle)} after letting go`);
    check(scrubUi.hitches <= 1 && scrubUi.p95 <= 34, `scrubbing UI: ${describe(scrubUi)}`);

    // ---- 6. Editing: time from an action to the next painted frame.
    const store = () => hooks().store!;
    const times: number[] = [];
    const timed = async (f: () => void) => { const s = performance.now(); f(); await nextPaint(); times.push(performance.now() - s); };
    const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    for (let k = 0; k < 6; k++) {
      await timed(() => { void player().seek(1 + k * 4.3); });
      await timed(() => key('s'));
      await timed(() => store().select({ kind: 'clip', clipID: store().project.clips[k + 2].id }));
      await timed(() => store().select(null));
      await timed(() => store().undo());
    }
    await timed(() => key('r')); await timed(() => key('c')); await timed(() => key('v'));
    check(quantile(times, 0.95) <= 60, `editing: action → painted p50 ${ms(quantile(times, 0.5))}, p95 ${ms(quantile(times, 0.95))}, max ${ms(Math.max(...times))} (${times.length} actions)`);

    // ---- 7. Timeline zoom and scroll.
    mon.start();
    const zoomIn = document.querySelectorAll<HTMLButtonElement>('.bar-zoom button')[1];
    for (let k = 0; k < 6; k++) { zoomIn.click(); await sleep(60); }
    for (let k = 0; k < 90; k++) { scroller.scrollLeft += 40; await new Promise((r) => requestAnimationFrame(r)); }
    document.querySelectorAll<HTMLButtonElement>('.bar-zoom button')[2].click();
    const zoomUi = mon.stop();
    check(zoomUi.hitches <= 1 && zoomUi.p95 <= 34, `timeline zoom/scroll: ${describe(zoomUi)}`);

    // ---- 8. Export 10 s at 1080p60 while the editor stays open.
    const tmp = await odak().selftestTempDir();
    mon.start();
    t = performance.now();
    await exportProject(store().project, new MediaLibrary(pkg), `${tmp}/perf.mp4`, { ...store().project.export, format: 'mp4', resolution: 'p1080', fps: 60 },
      () => {}, undefined, { range: { from: 0, to: 10 } });
    const exportSecs = (performance.now() - t) / 1000;
    const exUi = mon.stop();
    check(10 / exportSecs >= 1, `export 1080p60: ${(10 / exportSecs).toFixed(2)}× real time (10 s in ${exportSecs.toFixed(1)} s)`);
    check(exUi.max <= 250, `export UI: ${describe(exUi)}`);

    // ---- 9. Backgrounds: drawing each theme once at 1080p (later frames reuse it).
    // (an odd size so nothing is cached; reading a pixel makes the GPU actually finish drawing)
    const themeTimes = themes.map((th) => {
      const s0 = performance.now();
      themeCanvas(th.id, 1921, 1080).getContext('2d')!.getImageData(0, 0, 1, 1);
      return [th.id, performance.now() - s0] as const;
    });
    const slowest = themeTimes.reduce((a, b) => (b[1] > a[1] ? b : a));
    check(slowest[1] <= 150, `themes at 1080p: slowest ${slowest[0]} ${ms(slowest[1])}, all ${themeTimes.length} in ${ms(themeTimes.reduce((s0, x) => s0 + x[1], 0))}`);

    const heap1 = heap();
    log.push(`JS heap: ${heap0.toFixed(0)} → ${heap1.toFixed(0)} MB`);
    if (outside.length) log.push(`outside events during the run: ${outside.join(', ')}`);
  } catch (e) {
    check(false, `exception: ${(e as Error).stack ?? e}`);
    failures++;
  }
  log.push(`perftest took ${((performance.now() - begun) / 1000).toFixed(1)}s`);
  odak().selftestDone({ ok: failures === 0, log });
}
