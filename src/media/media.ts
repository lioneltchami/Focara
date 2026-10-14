import { ALL_FORMATS, AudioBufferSink, CustomSource, EncodedPacketSink, Input, VideoSampleSink, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';
import { type Clip, type CursorTrack, type MediaAsset, type Project, type StyleSettings, assetOf, clipStarts } from '../core/model.ts';
import { cameraTrack } from '../core/cameraLayout.ts';
import { type ClipRenderData, makeRenderData } from '../render/renderer.ts';
import { odak } from '../bridge.ts';

// Media files are read through the main process in byte ranges (works the same on every OS).

export interface MediaFile {
  input: Input;
  video: InputVideoTrack | null;
  audio: InputAudioTrack | null;
  videoSink: VideoSampleSink | null;
  audioSink: AudioBufferSink | null;
}

export class MediaLibrary {
  private files = new Map<string, Promise<MediaFile>>();
  private cursors = new Map<string, Promise<CursorTrack | null>>();
  private renderCache = new Map<string, ClipRenderData>();
  private images = new Map<string, Promise<ImageBitmap | null>>();
  private envelopes = new Map<string, Promise<Float32Array | null>>();
  private frameTimesCache = new Map<string, Promise<Float64Array | null>>();
  static readonly ENVELOPE_STEP = 0.05;

  constructor(readonly pkg: string) {}

  open(rel: string): Promise<MediaFile> {
    let f = this.files.get(rel);
    if (!f) {
      f = (async () => {
        const pkg = this.pkg;
        const input = new Input({
          formats: ALL_FORMATS,
          source: new CustomSource({
            getSize: () => odak().fileSize(pkg, rel),
            read: (start, end) => odak().readFile(pkg, rel, start, end),
            prefetchProfile: 'fileSystem',
          }),
        });
        const video = (await input.getPrimaryVideoTrack()) ?? null;
        const audio = (await input.getPrimaryAudioTrack()) ?? null;
        return {
          input, video, audio,
          videoSink: video && (await video.canDecode()) ? new VideoSampleSink(video) : null,
          audioSink: audio && (await audio.canDecode()) ? new AudioBufferSink(audio) : null,
        };
      })();
      this.files.set(rel, f);
      f.catch(() => this.files.delete(rel));
    }
    return f;
  }

  cursor(asset: MediaAsset): Promise<CursorTrack | null> {
    if (!asset.cursorFile) return Promise.resolve(null);
    let c = this.cursors.get(asset.id);
    if (!c) { c = odak().readCursor(this.pkg, asset.cursorFile); this.cursors.set(asset.id, c); }
    return c;
  }

  /** A package image (e.g. the background) decoded once. */
  image(rel: string): Promise<ImageBitmap | null> {
    let i = this.images.get(rel);
    if (!i) {
      i = (async () => {
        const size = await odak().fileSize(this.pkg, rel);
        const bytes = await odak().readFile(this.pkg, rel, 0, size);
        return createImageBitmap(new Blob([bytes as BlobPart]));
      })().catch(() => null);
      this.images.set(rel, i);
    }
    return i;
  }

  /** Camera timelines are cached per clip edit state so small edits rebuild quickly. */
  async renderData(clip: Clip, asset: MediaAsset, style: StyleSettings): Promise<ClipRenderData> {
    const key = JSON.stringify([clip.id, clip.zooms, asset.id, style.zoomSpeed, style.smoothCursor]);
    const backgroundImage = style.backgroundKind === 'image' && style.backgroundImage ? await this.image(style.backgroundImage) : null;
    const hit = this.renderCache.get(key);
    if (hit) return { ...hit, clip, style, backgroundImage };
    const d = makeRenderData(clip, asset, await this.cursor(asset), style);
    if (this.renderCache.size > 64) this.renderCache.clear();
    this.renderCache.set(key, d);
    return { ...d, backgroundImage };
  }

  /** The webcam track of a clip's recording, when it has one and the camera is shown. */
  async camera(p: Project, clip: Clip): Promise<MediaFile | null> {
    const m = assetOf(p, clip.mediaID);
    if (!m?.cameraFile || !p.style.camera.show) return null;
    const f = await this.open(m.cameraFile);
    return f.videoSink ? f : null;
  }

  async allRenderData(p: Project): Promise<ClipRenderData[]> {
    const spans = cameraTrack(p), starts = clipStarts(p);
    const data = await Promise.all(p.clips.map((c) => this.renderData(c, assetOf(p, c.mediaID)!, p.style)));
    return data.map((d, i) => ({ ...d, timelineStart: starts[i], cameraSpans: spans }));
  }

  /** Audio sources of a clip, each with its volume (kept separate until mixing). */
  async audioOf(p: Project, clip: Clip): Promise<{ sink: AudioBufferSink; volume: number }[]> {
    const m = assetOf(p, clip.mediaID);
    if (!m) return [];
    const list: [string | undefined, number][] = m.kind === 'screenRecording'
      ? [[m.systemAudioFile, clip.systemAudioVolume], [m.microphoneFile, clip.microphoneVolume]]
      : [[m.videoFile, clip.videoVolume]];
    const out: { sink: AudioBufferSink; volume: number }[] = [];
    for (const [rel, volume] of list) {
      if (!rel || volume <= 0) continue;
      const f = await this.open(rel);
      if (f.audioSink) out.push({ sink: f.audioSink, volume });
    }
    return out;
  }

  /** Peak loudness per 50 ms over all audio of a media (for waveforms and quiet detection). */
  envelope(asset: MediaAsset): Promise<Float32Array | null> {
    let e = this.envelopes.get(asset.id);
    if (!e) {
      e = (async () => {
        const files = asset.kind === 'screenRecording' ? [asset.systemAudioFile, asset.microphoneFile] : [asset.videoFile];
        const step = MediaLibrary.ENVELOPE_STEP;
        const out = new Float32Array(Math.ceil(asset.duration / step) + 1);
        let any = false;
        for (const rel of files) {
          if (!rel) continue;
          const f = await this.open(rel);
          if (!f.audioSink) continue;
          any = true;
          for await (const b of f.audioSink.buffers()) {
            const rate = b.buffer.sampleRate, chs = b.buffer.numberOfChannels;
            const data = Array.from({ length: chs }, (_, c) => b.buffer.getChannelData(c));
            for (let i = 0; i < b.buffer.length; i += 32) {
              const k = Math.floor((b.timestamp + i / rate) / step);
              if (k < 0 || k >= out.length) continue;
              let v = 0;
              for (const d of data) v = Math.max(v, Math.abs(d[i]));
              if (v > out[k]) out[k] = v;
            }
          }
        }
        return any ? out : null;
      })().catch(() => null);
      this.envelopes.set(asset.id, e);
    }
    return e;
  }

  /** Timestamps of the screen video's frames (read from packet headers, no decoding). */
  frameTimes(asset: MediaAsset): Promise<Float64Array | null> {
    let f = this.frameTimesCache.get(asset.id);
    if (!f) {
      f = (async () => {
        const m = await this.open(asset.videoFile);
        if (!m.video) return null;
        const sink = new EncodedPacketSink(m.video);
        const times: number[] = [];
        for (let p = await sink.getFirstPacket({ metadataOnly: true }); p; p = await sink.getNextPacket(p, { metadataOnly: true })) times.push(p.timestamp);
        return Float64Array.from(times.sort((a, b) => a - b));
      })().catch(() => null);
      this.frameTimesCache.set(asset.id, f);
    }
    return f;
  }

  dispose() {
    for (const f of this.files.values()) f.then((m) => m.input.dispose()).catch(() => {});
    this.files.clear();
  }
}
