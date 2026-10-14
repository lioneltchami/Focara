// End-to-end check that runs inside the real app (Electron renderer), on macOS and Windows:
// synthetic recording -> auto zoom -> save/reopen -> export MP4 -> compare preview frames with
// exported frames -> measure audio sync in the export.
import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, CanvasSource, CustomSource, EncodedPacketSink, Input,
  Mp4OutputFormat, Output, QUALITY_HIGH, StreamTarget, VideoSampleSink, WavOutputFormat,
  getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
} from 'mediabunny';
import { odak } from './bridge.ts';
import { type CursorTrack, type MediaAsset, newClip, newProject, normalizeProject, uuid } from './core/model.ts';
import { generateAutoZooms } from './core/zoom.ts';
import { exportProject } from './media/exporter.ts';
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
    lib.dispose();
  } catch (err) {
    check(false, `exception: ${(err as Error).stack ?? err}`);
  }
  log.push(`selftest took ${((performance.now() - started) / 1000).toFixed(1)}s`);
  odak().selftestDone({ ok: failures === 0, log });
}
