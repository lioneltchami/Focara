import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, BufferSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat,
  Output, QUALITY_HIGH, StreamTarget, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
  type AudioCodec, type VideoCodec, type VideoSample,
} from 'mediabunny';
import { type ExportSettings, type Project, assetOf, canvasSize, clipDuration, clipStarts, locate, projectDuration } from '../core/model.ts';
import { odak } from '../bridge.ts';
import type { MediaLibrary } from './media.ts';
import { renderSample } from './player.ts';

const SAMPLE_RATE = 48000;
const CHUNK = 2; // seconds of audio mixed and video rendered per step (keeps tracks interleaved)

export interface ExportProgress { fraction: number }

/**
 * Renders the project to an MP4 file with the same renderer the preview uses. Each output frame
 * t = k / fps uses the last source frame starting at or before its source time — the same rule
 * the preview's paused frame uses.
 */
export async function exportProject(p: Project, lib: MediaLibrary, path: string, settings: ExportSettings,
                                    onProgress: (f: number) => void, signal?: AbortSignal): Promise<{ videoCodec: string; audioCodec: string | null }> {
  const size = canvasSize(p, settings);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const duration = projectDuration(p);
  const fps = settings.fps;
  const frames = Math.max(1, Math.round(duration * fps));
  const data = await lib.allRenderData(p);

  const order: VideoCodec[] = settings.codec === 'hevc' ? ['hevc', 'avc', 'vp9', 'av1'] : ['avc', 'hevc', 'vp9', 'av1'];
  const videoCodec = await getFirstEncodableVideoCodec(order, { width: size.width, height: size.height });
  if (!videoCodec) throw new Error('Bu bilgisayarda MP4 için uygun bir video kodlayıcı bulunamadı.');
  const audioSources = await Promise.all(p.clips.map((c) => lib.audioOf(p, c)));
  const hasAudio = audioSources.some((a) => a.length > 0);
  const audioCodec = hasAudio ? await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: SAMPLE_RATE }) : null;

  const handle = await odak().fileOpen(path);
  let failed = true;
  try {
    const target = new StreamTarget(new WritableStream({
      write: (chunk) => odak().fileWrite(handle, chunk.data, chunk.position),
    }), { chunked: true, chunkSize: 4 * 1024 * 1024 });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    const video = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(video, { frameRate: fps });
    const audio = audioCodec ? new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_HIGH }) : null;
    if (audio) output.addAudioTrack(audio);
    await output.start();

    const starts = clipStarts(p);
    // Audio encoders (AAC in particular) prepend "priming" samples that MP4 players do not all
    // remove. Feed the audio that much earlier so it lands exactly on the video in every player.
    const delay = audioCodec ? await encoderDelay(audioCodec) : 0;
    let frame = 0;
    // Per-clip sequential frame readers (decode each packet at most once).
    let readerClip = -1;
    let reader: AsyncGenerator<VideoSample | null, void, unknown> | null = null;
    let camReader: AsyncGenerator<VideoSample | null, void, unknown> | null = null;

    for (let chunkStart = 0; chunkStart < duration - 1e-9; chunkStart += CHUNK) {
      if (signal?.aborted) throw new DOMException('İptal edildi', 'AbortError');
      const chunkEnd = Math.min(duration, chunkStart + CHUNK);

      if (audio) {
        const a = Math.min(duration, chunkStart + delay), b = Math.min(duration, chunkEnd + delay);
        if (b > a) await audio.add(await mixAudio(p, audioSources, starts, a, b));
      }

      for (; frame < frames && frame / fps < chunkEnd - 1e-9; frame++) {
        if (signal?.aborted) throw new DOMException('İptal edildi', 'AbortError');
        const t = frame / fps;
        const loc = locate(p, t)!;
        if (loc.index !== readerClip) {
          if (reader) await reader.return(undefined);
          if (camReader) await camReader.return(undefined);
          readerClip = loc.index;
          const clip = p.clips[readerClip];
          const media = await lib.open(assetOf(p, clip.mediaID)!.videoFile);
          const times: number[] = [];
          for (let k = frame; k < frames && (locate(p, k / fps)!.index === readerClip); k++) times.push(locate(p, k / fps)!.sourceTime);
          reader = media.videoSink ? media.videoSink.samplesAtTimestamps(times) : null;
          const cam = await lib.camera(p, clip);
          camReader = cam ? cam.videoSink!.samplesAtTimestamps(times) : null;
        }
        const r = reader ? await reader.next() : null;
        const sample = r && !r.done ? r.value : null;
        const c = camReader ? await camReader.next() : null;
        const camSample = c && !c.done ? c.value : null;
        renderSample(ctx, size, sample, data[loc.index], loc.sourceTime, camSample);
        sample?.close(); camSample?.close();
        await video.add(t, 1 / fps);
        if (frame % 15 === 0) onProgress(frame / frames);
      }
    }
    if (reader) await reader.return(undefined);
    if (camReader) await camReader.return(undefined);
    await output.finalize();
    failed = false;
    onProgress(1);
    return { videoCodec, audioCodec };
  } finally {
    await odak().fileClose(handle, failed);
  }
}

const delays = new Map<string, Promise<number>>();

/** Measures how many seconds of priming the platform's encoder adds (cached per codec). */
export function encoderDelay(codec: AudioCodec): Promise<number> {
  let d = delays.get(codec);
  if (!d) {
    d = (async () => {
      const target = new BufferTarget();
      const out = new Output({ format: new Mp4OutputFormat(), target });
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
    delays.set(codec, d);
  }
  return d;
}

/** Mixes every audio source of every clip overlapping [from, to) into one stereo buffer. */
async function mixAudio(p: Project, sources: { sink: import('mediabunny').AudioBufferSink; volume: number }[][],
                        starts: number[], from: number, to: number): Promise<AudioBuffer> {
  const length = Math.max(1, Math.round((to - from) * SAMPLE_RATE));
  const ac = new OfflineAudioContext(2, length, SAMPLE_RATE);
  for (let i = 0; i < p.clips.length; i++) {
    const clip = p.clips[i], cs = starts[i], ce = cs + clipDuration(clip);
    if (ce <= from || cs >= to) continue;
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
