// End-to-end check that runs inside the real app (Electron renderer), on macOS and Windows:
// synthetic recording -> auto zoom -> save/reopen -> export MP4 -> compare preview frames with
// exported frames -> measure audio sync in the export.
import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, CanvasSource, CustomSource, EncodedPacketSink, Input,
  Mp4OutputFormat, Output, QUALITY_HIGH, StreamTarget, VideoSampleSink, WavOutputFormat,
  getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
} from 'mediabunny';
import { odak } from './bridge.ts';
import { type CursorTrack, type MediaAsset, type Project, newClip, newProject, normalizeProject, uuid } from './core/model.ts';
import { SideRecorder } from './media/sideRecorder.ts';
import { generateAutoZooms } from './core/zoom.ts';
import { encoderDelay, exportProject } from './media/exporter.ts';
import { duplicateClip, insertClip, setClipSpeed, splitClipAtSource, trimClip } from './core/edit.ts';
import { projectDuration } from './core/model.ts';
import { MediaLibrary } from './media/media.ts';
import { Player } from './media/player.ts';

const W = 1920, H = 1200, FPS = 60, SECONDS = 10;
const BEEPS = [2.0, 6.0];
const log: string[] = [];
let failures = 0;
const check = (ok: boolean, msg: string) => { log.push(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failures++; };

async function writeFile(path: string, build: (target: StreamTarget) => Promise<void>) {
  const h = await odak().fileOpen(path);
  try {
    await build(new StreamTarget(new WritableStream({ write: (c) => odak().fileWrite(h, c.data, c.position) }), { chunked: true }));
  } finally { await odak().fileClose(h); }
}

function drawSynthetic(ctx: OffscreenCanvasRenderingContext2D, i: number) {
  ctx.fillStyle = 'rgb(242,242,242)'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgb(191,191,191)';
  for (let x = 0; x < W; x += 80) ctx.fillRect(x, 0, 2, H);
  for (let y = 0; y < H; y += 80) ctx.fillRect(0, y, W, 2);
  ['rgb(230,51,51)', 'rgb(51,153,230)', 'rgb(51,204,77)'].forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(200 + k * 600, H - 400 - k * 250, 300, 200); });
  ctx.fillStyle = 'rgb(26,26,26)'; ctx.fillRect((i * 13) % (W - 60), H - 120, 60, 60);
  ctx.fillStyle = '#000'; ctx.font = 'bold 64px monospace'; ctx.fillText(`frame ${String(i).padStart(4, '0')}`, 700, 200);
}

function syntheticCursor(): CursorTrack {
  const t: CursorTrack = { samples: [], clicks: [] };
  for (let i = 0; i <= SECONDS * 120; i++) {
    const s = i / 120;
    let p: [number, number];
    if (s < 0.8) p = [960 - 700 * s, 600 - 375 * s];
    else if (s < 3.5) p = [400 + 40 * Math.sin(s * 3), 300 + 20 * Math.cos(s * 2)];
    else if (s < 6.5) p = [400, 300];
    else if (s < 7.6) { const f = (s - 6.5) / 1.1; p = [400 + 1100 * f, 300 + 600 * f]; }
    else p = [1500, 900];
    t.samples.push({ t: s, x: p[0], y: p[1] });
  }
  for (const [tm, x, y] of [[1.0, 420, 310], [1.7, 380, 290], [8.0, 1500, 900]]) {
    t.clicks.push({ t: tm, x, y, isDown: true, button: 0 }, { t: tm + 0.08, x, y, isDown: false, button: 0 });
  }
  return t;
}

function pixels(c: OffscreenCanvas) { return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; }
function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let se = 0;
  for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const d = a[i + k] - b[i + k]; se += d * d; }
  const mse = se / ((a.length / 4) * 3);
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const baseOf = (p: string) => p.replace(/^.*[\\/]/, '');

function openAbsolute(path: string) {
  const pkg = dirOf(path), rel = baseOf(path);
  return new Input({ formats: ALL_FORMATS, source: new CustomSource({ getSize: () => odak().fileSize(pkg, rel), read: (s, e) => odak().readFile(pkg, rel, s, e) }) });
}

export async function runSelftest() {
  const started = performance.now();
  try {
    log.push(`platform: ${odak().platform}`);
    const tmp = await odak().selftestTempDir();
    const pkg = await odak().createPackage('SelfTest');
    const mediaID = uuid();
    const dir = `${pkg}/media/${mediaID}`;

    // 1. Synthetic screen recording + system audio with beeps + cursor data.
    const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9'], { width: W, height: H });
    log.push(`encoders: video=${vcodec}`);
    if (!vcodec) throw new Error('no video encoder');
    await writeFile(`${dir}/screen.mp4`, async (target) => {
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d')!;
      const out = new Output({ format: new Mp4OutputFormat(), target });
      const src = new CanvasSource(canvas, { codec: vcodec, bitrate: 20e6, keyFrameInterval: 1 });
      out.addVideoTrack(src, { frameRate: FPS });
      await out.start();
      for (let i = 0; i < SECONDS * FPS; i++) { drawSynthetic(ctx, i); await src.add(i / FPS, 1 / FPS); }
      await out.finalize();
    });
    await writeFile(`${dir}/camera.mp4`, async (target) => {
      const canvas = new OffscreenCanvas(640, 480);
      const ctx = canvas.getContext('2d')!;
      const out = new Output({ format: new Mp4OutputFormat(), target });
      const src = new CanvasSource(canvas, { codec: vcodec, bitrate: 3e6, keyFrameInterval: 1 });
      out.addVideoTrack(src, { frameRate: 30 });
      await out.start();
      for (let i = 0; i < SECONDS * 30; i++) {
        ctx.fillStyle = `hsl(${(i * 3) % 360}, 60%, 45%)`; ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = '#f2c9a0'; ctx.beginPath(); ctx.arc(320, 250, 120, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000'; ctx.font = 'bold 48px monospace'; ctx.fillText(`cam ${i}`, 40, 80);
        await src.add(i / 30, 1 / 30);
      }
      await out.finalize();
    });
    const acodec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000 });
    log.push(`encoders: audio=${acodec}`);
    await writeFile(`${dir}/system.wav`, async (target) => {
      const out = new Output({ format: new WavOutputFormat(), target });
      const src = new AudioBufferSource({ codec: 'pcm-s16' });
      out.addAudioTrack(src);
      await out.start();
      const ac = new OfflineAudioContext(2, SECONDS * 48000, 48000);
      const buf = ac.createBuffer(2, SECONDS * 48000, 48000);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (const b of BEEPS) for (let i = 0; i < 2400; i++) d[Math.round(b * 48000) + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
      }
      await src.add(buf);
      await out.finalize();
    });
    const track = syntheticCursor();
    await odak().writeFile(pkg, `media/${mediaID}/cursor.json`, new TextEncoder().encode(JSON.stringify(track)));

    {
      const srcIn = new Input({ formats: ALL_FORMATS, source: new CustomSource({ getSize: () => odak().fileSize(pkg, `media/${mediaID}/system.wav`), read: (a, b) => odak().readFile(pkg, `media/${mediaID}/system.wav`, a, b) }) });
      const st = (await srcIn.getPrimaryAudioTrack())!;
      const sink = new AudioBufferSink(st);
      const first = await sink.getBuffer(0);
      let onset: number | null = null;
      for await (const b of sink.buffers(1.5, 2.5)) { const d = b.buffer.getChannelData(0); for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.3) { onset = b.timestamp + i / b.buffer.sampleRate; break; } if (onset !== null) break; }
      log.push(`source audio: first buffer ts=${first?.timestamp} firstTimestamp=${await srcIn.getFirstTimestamp()} beep@${onset}`);
    }
    // 2. Project with auto zooms; save and reopen.
    const asset: MediaAsset = {
      id: mediaID, kind: 'screenRecording', displayName: 'Test', videoFile: `media/${mediaID}/screen.mp4`,
      systemAudioFile: `media/${mediaID}/system.wav`, cursorFile: `media/${mediaID}/cursor.json`,
      cameraFile: `media/${mediaID}/camera.mp4`,
      duration: SECONDS, pixelWidth: W, pixelHeight: H, pixelsPerPoint: 2,
    };
    const project = newProject('SelfTest');
    project.media = [asset];
    const clip = newClip(mediaID, 0, SECONDS);
    clip.zooms = generateAutoZooms(track, SECONDS);
    project.clips = [clip];
    check(clip.zooms.length === 2, `auto zooms ${clip.zooms.map((z) => `[${z.start.toFixed(2)}–${z.end.toFixed(2)}]`).join(' ')}`);
    await odak().saveProject(pkg, project);
    const loaded = await odak().loadProject(pkg);
    check(!!loaded.project && JSON.stringify(normalizeProject(loaded.project)) === JSON.stringify(project), 'project round-trips through project.json');
    const reopened = normalizeProject(loaded.project!);

    // 3. Export.
    const lib = new MediaLibrary(pkg);
    const mp4 = `${tmp}/export.mp4`;
    const t0 = performance.now();
    const codecs = await exportProject(reopened, lib, mp4, reopened.export, () => {});
    log.push(`export: ${((performance.now() - t0) / 1000).toFixed(1)}s, codecs ${codecs.videoCodec}/${codecs.audioCodec}`);
    const ex = openAbsolute(mp4);
    const vt = (await ex.getPrimaryVideoTrack())!;
    const at = await ex.getPrimaryAudioTrack();
    const duration = await vt.computeDuration();
    let count = 0;
    const packets = new EncodedPacketSink(vt);
    for (let p = await packets.getFirstPacket(); p; p = await packets.getNextPacket(p)) count++;
    log.push(`exported: ${duration.toFixed(3)}s ${vt.displayWidth}x${vt.displayHeight}, ${count} frames, audio=${!!at}`);
    check(Math.abs(duration - SECONDS) < 0.02, `exported video duration ${duration.toFixed(3)}s matches timeline`);
    check(vt.displayWidth === 1920 && vt.displayHeight === 1080, 'exported canvas is 1920×1080');
    check(count === SECONDS * FPS, `exported ${count} frames (expected ${SECONDS * FPS})`);

    // 4. Preview frame (the editor's Player) vs exported frame at the same time.
    const preview = document.createElement('canvas');
    const player = new Player(preview, lib, () => {}, () => {});
    await player.setProject(reopened);
    const exSink = new VideoSampleSink(vt);
    const grab = (draw: (c: OffscreenCanvasRenderingContext2D) => void) => {
      const c = new OffscreenCanvas(1920, 1080); draw(c.getContext('2d')!); return pixels(c);
    };
    for (const t of [0.5, 2.5, 4.6, 8.3, 9.5]) {
      await player.seek(t);
      const p = grab((c) => c.drawImage(preview, 0, 0));
      const s1 = await exSink.getSample(t + 1e-6), s2 = await exSink.getSample(t + 3 / FPS + 1e-6);
      const e = grab((c) => s1!.draw(c, 0, 0)), late = grab((c) => s2!.draw(c, 0, 0));
      s1!.close(); s2!.close();
      const same = psnr(p, e), off = psnr(p, late);
      if (t === 2.5) {
        for (const [name, px] of [['preview', p], ['export', e]] as const) {
          const c = new OffscreenCanvas(1920, 1080); c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), 1920, 1080), 0, 0);
          const blob = await c.convertToBlob({ type: 'image/png' });
          await odak().writeFile(pkg, `${name}-2.5s.png`, new Uint8Array(await blob.arrayBuffer()));
        }
      }
      check(same > 35 && same > off + 3, `t=${t}: preview vs export ${same.toFixed(1)} dB (vs 3 frames later ${off.toFixed(1)} dB)`);
    }
    player.destroy();

    // 5. Audio sync: beeps must land where they were in the source.
    if (at) {
      const sink = new AudioBufferSink(at);
      for (const beep of BEEPS) {
        let onset: number | null = null;
        for await (const b of sink.buffers(beep - 0.5, beep + 0.5)) {
          const d = b.buffer.getChannelData(0);
          for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.3) { onset = b.timestamp + i / b.buffer.sampleRate; break; }
          if (onset !== null) break;
        }
        check(onset !== null && Math.abs(onset - beep) < 0.01, `audio beep at ${beep}s found at ${onset?.toFixed(4)}s`);
      }
    } else check(false, 'exported file has an audio track');
    // 6. Other looks: background image, theme, cursor styles, camera placements — same parity.
    const bg = new OffscreenCanvas(1600, 900);
    const bctx = bg.getContext('2d')!;
    const g = bctx.createLinearGradient(0, 0, 1600, 900); g.addColorStop(0, '#0f766e'); g.addColorStop(1, '#f59e0b');
    bctx.fillStyle = g; bctx.fillRect(0, 0, 1600, 900);
    for (let i = 0; i < 40; i++) { bctx.fillStyle = `hsla(${i * 37}, 80%, 60%, 0.8)`; bctx.beginPath(); bctx.arc((i * 211) % 1600, (i * 97) % 900, 30 + (i % 5) * 12, 0, Math.PI * 2); bctx.fill(); }
    await odak().writeFile(pkg, 'assets/bg.png', new Uint8Array(await (await bg.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    const looks: [string, (p: Project) => Project][] = [
      ['image+dot+pulse+camera rounded top-left', (p) => ({ ...p, style: { ...p.style, backgroundKind: 'image', backgroundImage: 'assets/bg.png', backgroundBlur: 0.4,
        cursorStyle: 'dot', cursorHighlight: true, clickStyle: 'pulse', camera: { ...p.style.camera, shape: 'rounded', position: 'top-left', mirror: false } } })],
      ['theme yilbasi+color arrow+idle hide', (p) => ({ ...p, style: { ...p.style, backgroundKind: 'theme', backgroundTheme: 'yilbasi', padding: 0.1,
        cursorStyle: 'arrow-color', hideIdleCursor: true, camera: { ...p.style.camera, shape: 'square', position: 'bottom-left', size: 0.2 } } })],
    ];
    for (const [name, apply] of looks) {
      const variant = apply(reopened);
      const vlib = new MediaLibrary(pkg);
      const file = `${tmp}/export-${name.split(' ')[0]}.mp4`;
      await exportProject(variant, vlib, file, { ...variant.export, fps: 30 }, () => {});
      const vin = openAbsolute(file);
      const vsink = new VideoSampleSink((await vin.getPrimaryVideoTrack())!);
      const vp = new Player(document.createElement('canvas'), vlib, () => {}, () => {});
      await vp.setProject(variant);
      for (const t of [1.0, 2.5, 8.6]) {
        await vp.seek(t);
        const pv = grab((c) => c.drawImage(vp.canvas, 0, 0));
        const s1 = await vsink.getSample(t + 1e-6);
        const ev = grab((c) => s1!.draw(c, 0, 0)); s1!.close();
        const db = psnr(pv, ev);
        check(db > 35, `${name} t=${t}: preview vs export ${db.toFixed(1)} dB`);
        if (t === 2.5) {
          const c = new OffscreenCanvas(1920, 1080); c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(ev), 1920, 1080), 0, 0);
          await odak().writeFile(pkg, `look-${name.split(' ')[0]}.png`, new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
        }
      }
      vp.destroy(); vlib.dispose();
    }

    // 7. Editing: cut, speed, an imported video and a duplicate — durations, parity, audio placement.
    const extPath = `${tmp}/dis-video.mp4`;
    const delay = await encoderDelay(acodec!);
    await writeFile(extPath, async (target) => {
      const canvas = new OffscreenCanvas(640, 360);
      const ctx = canvas.getContext('2d')!;
      const out = new Output({ format: new Mp4OutputFormat(), target });
      const vs = new CanvasSource(canvas, { codec: vcodec, bitrate: 2e6, keyFrameInterval: 1 });
      out.addVideoTrack(vs, { frameRate: 30 });
      const as = new AudioBufferSource({ codec: acodec!, bitrate: QUALITY_HIGH });
      out.addAudioTrack(as);
      await out.start();
      // Beep at 1.0 s (fed early by the encoder's priming delay, like the exporter does).
      const ac = new OfflineAudioContext(2, 4 * 48000, 48000), ab = ac.createBuffer(2, 4 * 48000, 48000);
      for (let ch = 0; ch < 2; ch++) { const d = ab.getChannelData(ch); const at = Math.round((1.0 - delay) * 48000); for (let i = 0; i < 2400; i++) d[at + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / 48000); }
      await as.add(ab);
      for (let i = 0; i < 120; i++) { ctx.fillStyle = `hsl(${i * 3}, 70%, 50%)`; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#fff'; ctx.font = 'bold 40px monospace'; ctx.fillText(`dis ${i}`, 30, 60); await vs.add(i / 30, 1 / 30); }
      await out.finalize();
    });
    const imported = await odak().importMedia(pkg, extPath);
    const extAsset: MediaAsset = { id: imported.id, kind: 'externalVideo', displayName: imported.name, videoFile: imported.rel, duration: 4, pixelWidth: 640, pixelHeight: 360, pixelsPerPoint: 1 };
    let ed: Project = { ...reopened, media: [...reopened.media, extAsset] };
    const c0 = ed.clips[0].id;
    let sp = splitClipAtSource(ed, c0, 3); if (!('project' in sp)) throw new Error(sp.error); ed = sp.project; const bId = sp.rightID;   // A 0–3 | B 3–10
    sp = splitClipAtSource(ed, bId, 8); if (!('project' in sp)) throw new Error(sp.error); ed = sp.project; const dId = sp.rightID;      // B 3–8 | D 8–10
    ed = trimClip(ed, bId, 'start', 5);              // B 5–8
    ed = setClipSpeed(ed, bId, 2);                   // B lasts 1.5 s
    ed = insertClip(ed, newClip(extAsset.id, 0, 4), 1); // A | B | ext | D
    const dup = duplicateClip(ed, dId)!; ed = dup.project; // … | D | D′
    const expected = 3 + 1.5 + 4 + 2 + 2;
    check(Math.abs(projectDuration(ed) - expected) < 1e-9, `edited timeline is ${projectDuration(ed)} s (A 3 + B 3@×2 + video 4 + D 2 + copy 2)`);
    const elib = new MediaLibrary(pkg);
    const efile = `${tmp}/export-edited.mp4`;
    await exportProject(ed, elib, efile, { ...ed.export, fps: 30 }, () => {});
    const ein = openAbsolute(efile);
    const evt = (await ein.getPrimaryVideoTrack())!;
    const edur = await evt.computeDuration();
    check(Math.abs(edur - expected) < 0.04, `edited export is ${edur.toFixed(3)} s`);
    const esink = new VideoSampleSink(evt);
    const ep = new Player(document.createElement('canvas'), elib, () => {}, () => {});
    await ep.setProject(ed);
    for (const [t, what] of [[1.0, 'cut clip'], [3.6, '×2 clip'], [6.0, 'imported video'], [9.5, 'clip after video'], [11.8, 'duplicate']] as const) {
      await ep.seek(t);
      const pv = grab((c) => c.drawImage(ep.canvas, 0, 0));
      const s1 = await esink.getSample(t + 1e-6);
      const ev = grab((c) => s1!.draw(c, 0, 0)); s1!.close();
      check(psnr(pv, ev) > 35, `${what} t=${t}: preview vs export ${psnr(pv, ev).toFixed(1)} dB`);
    }
    ep.destroy();
    const eat = await ein.getPrimaryAudioTrack();
    const onsets: number[] = [];
    if (eat) {
      const asink = new AudioBufferSink(eat);
      let last = -1;
      for await (const b of asink.buffers()) {
        const d = b.buffer.getChannelData(0);
        for (let i = 0; i < d.length; i++) {
          const tt = b.timestamp + i / b.buffer.sampleRate;
          if (Math.abs(d[i]) > 0.3 && tt - last > 0.5) { onsets.push(tt); last = tt; }
        }
      }
    }
    // A keeps its beep at 2.0; B (×2) is silent; the video's beep (1.0 s in) lands at 3 + 1.5 + 1.0 = 5.5.
    check(onsets.length === 2 && Math.abs(onsets[0] - 2.0) < 0.01 && Math.abs(onsets[1] - 5.5) < 0.01,
      `edited audio beeps at ${onsets.map((x) => x.toFixed(4)).join(', ')} s (expected 2.0000, 5.5000)`);
    elib.dispose();

    // 8. Camera + microphone recorder with Chromium's fake devices.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cam = devices.find((d) => d.kind === 'videoinput'), mic = devices.find((d) => d.kind === 'audioinput');
    log.push(`fake devices: camera=${cam?.label ?? '-'} mic=${mic?.label ?? '-'}`);
    const side = await SideRecorder.open({ cameraId: cam?.deviceId ?? null, micId: mic?.deviceId ?? null, noiseSuppression: false });
    const sideID = uuid();
    const recT0 = Date.now() + 300;
    await side!.setTarget(pkg, sideID, recT0);
    await new Promise((r) => setTimeout(r, 2600));
    const res = await side!.stop(2.0);
    check(!!res.cameraFile && !!res.micFile, `camera + mic files written (${res.cameraFile}, ${res.micFile})`);
    if (res.cameraFile) {
      const ci = new Input({ formats: ALL_FORMATS, source: new CustomSource({ getSize: () => odak().fileSize(pkg, res.cameraFile!), read: (a, b) => odak().readFile(pkg, res.cameraFile!, a, b) }) });
      const ct = (await ci.getPrimaryVideoTrack())!;
      const cp = new EncodedPacketSink(ct);
      let n = 0, first = Infinity, last = 0;
      for (let pk = await cp.getFirstPacket(); pk; pk = await cp.getNextPacket(pk)) { n++; first = Math.min(first, pk.timestamp); last = Math.max(last, pk.timestamp); }
      // Frames after the stop may follow; the clip ends at the screen recording's length anyway.
      check(n >= 40 && first >= 0 && first < 0.2 && last >= 1.9, `camera: ${n} frames, ${first.toFixed(3)}–${last.toFixed(3)}s on the screen timeline`);
    }
    if (res.micFile) {
      const size = await odak().fileSize(pkg, res.micFile);
      const head = new DataView((await odak().readFile(pkg, res.micFile, 0, 44)).slice().buffer);
      const rate = head.getUint32(24, true), ch = head.getUint16(22, true), bytes = head.getUint32(40, true);
      check(bytes === size - 44 && Math.abs(bytes / (rate * ch * 2) - 2.0) < 0.002, `mic.wav: ${rate} Hz ×${ch}, ${(bytes / (rate * ch * 2)).toFixed(3)}s`);
    }
    lib.dispose();
  } catch (err) {
    check(false, `exception: ${(err as Error).stack ?? err}`);
  }
  log.push(`selftest took ${((performance.now() - started) / 1000).toFixed(1)}s`);
  odak().selftestDone({ ok: failures === 0, log });
}
