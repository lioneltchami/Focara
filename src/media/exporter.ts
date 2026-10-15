import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, BufferSource, BufferTarget, CanvasSource, Input, MovOutputFormat,
  Mp4OutputFormat, Output, type OutputFormat, QUALITY_HIGH, QUALITY_LOW, QUALITY_MEDIUM, StreamTarget, WavOutputFormat,
  WebMOutputFormat, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
  type AudioCodec, type Quality, type VideoCodec, type VideoSample,
} from 'mediabunny';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import {
  type ExportFormat, type ExportSettings, type Project, type Size, type VideoCodecChoice, assetOf, canvasSize, clipDuration,
  clipStarts, formatOf, locate, projectDuration,
} from '../core/model.ts';
import { odak } from '../bridge.ts';
import { t } from '../i18n/index.ts';
import type { ClipRenderData } from '../render/renderer.ts';
import { type MediaLibrary, frameTime } from './media.ts';
import { renderSample } from './player.ts';

const SAMPLE_RATE = 48000;
const CHUNK = 2; // seconds of audio mixed and video rendered per step (keeps tracks interleaved)

export interface ExportOptions {
  /** Export only this part of the timeline (seconds). */
  range?: { from: number; to: number };
  /** PNG: the timeline time of the frame. */
  frameTime?: number;
}
export interface ExportResult { videoCodec: string | null; audioCodec: string | null }

const qualities: Record<ExportSettings['quality'], Quality> = { high: QUALITY_HIGH, medium: QUALITY_MEDIUM, small: QUALITY_LOW };
export const codecIds: Record<VideoCodecChoice, VideoCodec> = { h264: 'avc', hevc: 'hevc', av1: 'av1', vp9: 'vp9' };

/** Video codecs a container may carry, the user's choice first. */
export function videoCodecsFor(format: ExportFormat, choice: VideoCodecChoice): VideoCodec[] {
  const allowed: VideoCodec[] = format === 'webm' ? ['vp9', 'av1', 'vp8'] : format === 'mov' ? ['avc', 'hevc'] : ['avc', 'hevc', 'av1'];
  const first = codecIds[choice];
  return allowed.includes(first) ? [first, ...allowed.filter((c) => c !== first)] : allowed;
}
const audioCodecsFor = (format: ExportFormat): AudioCodec[] =>
  format === 'webm' ? ['opus', 'vorbis'] : format === 'wav' ? ['pcm-s16'] : ['aac', 'opus'];

function containerFor(format: ExportFormat): OutputFormat {
  if (format === 'mov') return new MovOutputFormat({ fastStart: false });
  if (format === 'webm') return new WebMOutputFormat();
  if (format === 'wav') return new WavOutputFormat();
  return new Mp4OutputFormat({ fastStart: false }); // mp4, m4a
}

/** Output frame size: the export settings, or a GIF's own (smaller) width. */
export function outputSize(p: Project, s: ExportSettings): Size {
  const base = canvasSize(p, s);
  if (s.format !== 'gif') return base;
  const w = Math.min(base.width, Math.max(160, Math.round(s.gifWidth / 2) * 2));
  return { width: w, height: Math.round((base.height * w) / base.width / 2) * 2 };
}

/**
 * Renders the project (or a part of it) with the same renderer the preview uses. Each output
 * frame t = from + k / fps uses the last source frame starting at or before its source time —
 * the same rule the preview's paused frame uses.
 */
export async function exportProject(p: Project, lib: MediaLibrary, path: string, settings: ExportSettings,
                                    onProgress: (f: number) => void, signal?: AbortSignal, opts: ExportOptions = {}): Promise<ExportResult> {
  const format = settings.format ?? 'mp4';
  const total = projectDuration(p);
  const from = Math.max(0, Math.min(total, opts.range?.from ?? 0));
  const to = Math.max(from, Math.min(total, opts.range?.to ?? total));
  if (to - from < 1e-3 && format !== 'png') throw new Error(t('Dışa aktarılacak bir şey yok (süre 0).'));

  const handle = await odak().fileOpen(path);
  let failed = true;
  try {
    const write = (data: Uint8Array, position: number) => odak().fileWrite(handle, data, position);
    let result: ExportResult;
    if (format === 'png') result = await writeFrame(p, lib, settings, opts.frameTime ?? from, write);
    else if (format === 'gif') result = await writeGif(p, lib, settings, from, to, write, onProgress, signal);
    else result = await writeMedia(p, lib, settings, from, to, write, onProgress, signal);
    failed = false;
    onProgress(1);
    return result;
  } finally {
    await odak().fileClose(handle, failed);
  }
}

/** MP4 / MOV / WebM (video + audio) and M4A / WAV (audio only). */
async function writeMedia(p: Project, lib: MediaLibrary, settings: ExportSettings, from: number, to: number,
                          write: (d: Uint8Array, pos: number) => Promise<void>, onProgress: (f: number) => void, signal?: AbortSignal): Promise<ExportResult> {
  const format = settings.format;
  const withVideo = formatOf(format).kind === 'video';
  const container = containerFor(format);
  const duration = to - from;
  const size = canvasSize(p, settings);
  const fps = settings.fps;
  const frames = withVideo ? Math.max(1, Math.round(duration * fps)) : 0;

  let videoCodec: VideoCodec | null = null;
  if (withVideo) {
    const supported = container.getSupportedVideoCodecs();
    videoCodec = await getFirstEncodableVideoCodec(videoCodecsFor(format, settings.codec).filter((c) => supported.includes(c)),
      { width: size.width, height: size.height });
    if (!videoCodec) throw new Error(t('Bu bilgisayarda {format} için uygun bir video kodlayıcı bulunamadı. Başka bir biçim ya da kodek dene.', { format: t(formatOf(format).title) }));
  }
  const audioSources = await Promise.all(p.clips.map((c) => lib.audioOf(p, c)));
  const hasAudio = audioSources.some((a) => a.length > 0);
  const supportedAudio = container.getSupportedAudioCodecs();
  const audioCodec = hasAudio || !withVideo
    ? await getFirstEncodableAudioCodec(audioCodecsFor(format).filter((c) => supportedAudio.includes(c)), { numberOfChannels: 2, sampleRate: SAMPLE_RATE })
    : null;
  if (!withVideo && !audioCodec) throw new Error(t('Bu bilgisayarda bu ses biçimi için kodlayıcı bulunamadı.'));

  const target = new StreamTarget(new WritableStream({ write: (chunk) => write(chunk.data, chunk.position) }),
    { chunked: true, chunkSize: 4 * 1024 * 1024 });
  const output = new Output({ format: container, target });
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const video = videoCodec ? new CanvasSource(canvas, { codec: videoCodec, bitrate: qualities[settings.quality ?? 'high'], keyFrameInterval: 2 }) : null;
  if (video) output.addVideoTrack(video, { frameRate: fps });
  const audio = audioCodec ? new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_HIGH }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();

  const starts = clipStarts(p);
  // Audio encoders (AAC in particular) prepend "priming" samples that not every player removes.
  // Feed the audio that much earlier so it lands exactly on the video everywhere.
  const delay = audioCodec ? await encoderDelay(audioCodec, format) : 0;
  const data = withVideo ? await lib.allRenderData(p) : [];
  const it = withVideo ? renderFrames(p, lib, data, ctx, size, fps, from, frames, signal) : null;
  let frame = 0;
  try {
    for (let chunkStart = 0; chunkStart < duration - 1e-9; chunkStart += CHUNK) {
      if (signal?.aborted) throw new DOMException(t('İptal edildi'), 'AbortError');
      const chunkEnd = Math.min(duration, chunkStart + CHUNK);
      if (audio) {
        const a = Math.min(duration, chunkStart + delay), b = Math.min(duration, chunkEnd + delay);
        if (b > a) await audio.add(await mixAudio(p, audioSources, starts, from + a, from + b));
        if (!withVideo) onProgress(chunkEnd / duration);
      }
      for (; it && frame < frames && frame / fps < chunkEnd - 1e-9; frame++) {
        await it.next();
        await video!.add(frame / fps, 1 / fps);
        if (frame % 15 === 0) onProgress(frame / frames);
      }
    }
  } finally {
    await it?.return(undefined);
  }
  await output.finalize();
  return { videoCodec, audioCodec };
}

/**
 * Renders `count` frames from timeline time `from` into ctx, one per step. Each clip's frames
 * come from one sequential reader, so every source packet is decoded at most once.
 */
export async function* renderFrames(p: Project, lib: MediaLibrary, data: ClipRenderData[], ctx: OffscreenCanvasRenderingContext2D, size: Size,
                             fps: number, from: number, count: number, signal?: AbortSignal): AsyncGenerator<number, void, unknown> {
  const total = projectDuration(p);
  const at = (k: number) => locate(p, Math.min(from + k / fps, total - 1e-6))!;
  let readerClip = -1;
  let reader: AsyncGenerator<VideoSample | null, void, unknown> | null = null;
  let camReader: AsyncGenerator<VideoSample | null, void, unknown> | null = null;
  try {
    for (let k = 0; k < count; k++) {
      if (signal?.aborted) throw new DOMException(t('İptal edildi'), 'AbortError');
      const loc = at(k);
      if (loc.index !== readerClip) {
        await reader?.return(undefined); await camReader?.return(undefined);
        readerClip = loc.index;
        const clip = p.clips[readerClip];
        const media = await lib.open(assetOf(p, clip.mediaID)!.videoFile);
        const times: number[] = [];
        for (let j = k; j < count; j++) { const l = at(j); if (l.index !== readerClip) break; times.push(l.sourceTime); }
        reader = media.videoSink ? media.videoSink.samplesAtTimestamps(times.map((t) => frameTime(media, t))) : null;
        const cam = await lib.camera(p, clip);
        camReader = cam ? cam.videoSink!.samplesAtTimestamps(times.map((t) => frameTime(cam, t))) : null;
      }
      const r = reader ? await reader.next() : null;
      const sample = r && !r.done ? r.value : null;
      const c = camReader ? await camReader.next() : null;
      const camSample = c && !c.done ? c.value : null;
      renderSample(ctx, size, sample, data[loc.index], loc.sourceTime, camSample);
      sample?.close(); camSample?.close();
      yield k;
    }
  } finally {
    await reader?.return(undefined); await camReader?.return(undefined);
  }
}

/**
 * Animated GIF: a palette per frame (screen content keeps sharp colours), identical frames
 * merged into one longer frame (a still screen costs almost nothing), written as it goes.
 */
async function writeGif(p: Project, lib: MediaLibrary, settings: ExportSettings, from: number, to: number,
                        write: (d: Uint8Array, pos: number) => Promise<void>, onProgress: (f: number) => void, signal?: AbortSignal): Promise<ExportResult> {
  const size = outputSize(p, settings);
  const fps = Math.min(30, Math.max(5, settings.gifFps || 15));
  const count = Math.max(1, Math.round((to - from) * fps));
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const data = await lib.allRenderData(p);
  // Manual mode: the header is written once here, so the stream can be drained after every frame
  // (gifenc's auto mode would start a new file after each reset).
  const gif = GIFEncoder({ auto: false });
  gif.writeHeader();
  let position = 0, writtenCs = 0, first = true;
  let pending: { index: Uint8Array; palette: number[][]; endFrame: number } | null = null;
  let previous: Uint32Array | null = null;
  // GIF delays are in centiseconds: round against the ideal clock so the length never drifts.
  const flush = async () => {
    if (!pending) return;
    const endCs = Math.round((pending.endFrame / fps) * 100);
    const delayCs = Math.max(2, endCs - writtenCs);
    writtenCs += delayCs;
    gif.writeFrame(pending.index, size.width, size.height, { palette: pending.palette, delay: delayCs * 10, first, repeat: 0 });
    first = false;
    const bytes = gif.bytes();
    gif.reset();
    await write(bytes, position);
    position += bytes.length;
    pending = null;
  };
  for await (const k of renderFrames(p, lib, data, ctx, size, fps, from, count, signal)) {
    const rgba = ctx.getImageData(0, 0, size.width, size.height).data;
    const pixels = new Uint32Array(rgba.buffer);
    if (pending && previous && sameFrame(previous, pixels)) { pending.endFrame = k + 1; continue; }
    await flush();
    const palette = quantize(rgba, 256);
    pending = { index: applyPalette(rgba, palette), palette, endFrame: k + 1 };
    previous = pixels;
    if (k % 5 === 0) onProgress(k / count);
    // Quantizing is CPU work: give the UI a turn now and then.
    if (k % 3 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await flush();
  gif.finish();
  const tail = gif.bytes();
  await write(tail, position);
  return { videoCodec: 'gif', audioCodec: null };
}

function sameFrame(a: Uint32Array, b: Uint32Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** One frame as PNG, at the export size (for thumbnails). */
async function writeFrame(p: Project, lib: MediaLibrary, settings: ExportSettings, time: number,
                          write: (d: Uint8Array, pos: number) => Promise<void>): Promise<ExportResult> {
  const size = canvasSize(p, settings);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const loc = locate(p, Math.min(Math.max(0, time), projectDuration(p) - 1e-6));
  if (!loc) throw new Error(t('Zaman çizelgesi boş.'));
  const clip = p.clips[loc.index];
  const data = await lib.allRenderData(p);
  const media = await lib.open(assetOf(p, clip.mediaID)!.videoFile);
  const sample = media.videoSink ? await media.videoSink.getSample(frameTime(media, loc.sourceTime)) : null;
  const cam = await lib.camera(p, clip);
  const camSample = cam ? await cam.videoSink!.getSample(frameTime(cam, loc.sourceTime)) : null;
  renderSample(ctx, size, sample, data[loc.index], loc.sourceTime, camSample);
  sample?.close(); camSample?.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  await write(new Uint8Array(await blob.arrayBuffer()), 0);
  return { videoCodec: 'png', audioCodec: null };
}

const delays = new Map<string, Promise<number>>();

/**
 * Measures how many seconds of priming the platform's encoder adds in a container, as a player
 * decoding the file would see it (cached per codec and container).
 */
export function encoderDelay(codec: AudioCodec, format: ExportFormat = 'mp4'): Promise<number> {
  if (codec.startsWith('pcm')) return Promise.resolve(0);
  const key = `${codec}/${format}`;
  let d = delays.get(key);
  if (!d) {
    d = (async () => {
      const target = new BufferTarget();
      const out = new Output({ format: containerFor(format === 'm4a' ? 'mp4' : format), target });
      const src = new AudioBufferSource({ codec, bitrate: QUALITY_HIGH });
      out.addAudioTrack(src);
      await out.start();
      const ac = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
      const buf = ac.createBuffer(2, SAMPLE_RATE, SAMPLE_RATE);
      const at = Math.round(0.3 * SAMPLE_RATE);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < 960; i++) data[at + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE);
      }
      await src.add(buf);
      await out.finalize();
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer!) });
      const sink = new AudioBufferSink((await input.getPrimaryAudioTrack())!);
      for await (const b of sink.buffers()) {
        const data = b.buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          if (Math.abs(data[i]) > 0.2) return Math.max(0, Math.round((b.timestamp + i / SAMPLE_RATE) * SAMPLE_RATE - at) / SAMPLE_RATE);
        }
      }
      return 0;
    })();
    delays.set(key, d);
  }
  return d;
}

/** Mixes every audio source of every clip overlapping [from, to) into one stereo buffer. */
async function mixAudio(p: Project, sources: { sink: AudioBufferSink; volume: number }[][],
                        starts: number[], from: number, to: number): Promise<AudioBuffer> {
  const length = Math.max(1, Math.round((to - from) * SAMPLE_RATE));
  const ac = new OfflineAudioContext(2, length, SAMPLE_RATE);
  for (let i = 0; i < p.clips.length; i++) {
    const clip = p.clips[i], cs = starts[i], ce = cs + clipDuration(clip);
    if (ce <= from || cs >= to) continue;
    if ((clip.speed || 1) !== 1) continue; // sped-up / slowed clips are silent (same as the preview)
    const srcA = clip.sourceStart + Math.max(0, from - cs);
    const srcB = clip.sourceStart + Math.min(ce, to) - cs;
    const segStart = Math.max(cs, from) - from;    // where this clip's audio begins in the chunk
    const segEnd = Math.min(ce, to) - from;
    for (const { sink, volume } of sources[i]) {
      const gain = ac.createGain();
      gain.gain.value = volume;
      gain.connect(ac.destination);
      for await (const b of sink.buffers(Math.max(0, srcA - 0.2), srcB)) {
        const at = segStart + (b.timestamp - srcA);
        const offset = Math.max(0, -at);
        if (offset >= b.duration) continue;
        const node = ac.createBufferSource();
        node.buffer = b.buffer;
        node.connect(gain);
        node.start(Math.max(0, at), offset);
        node.stop(segEnd);
      }
    }
  }
  return ac.startRendering();
}
