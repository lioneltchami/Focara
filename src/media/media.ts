import { ALL_FORMATS, AudioBufferSink, CustomSource, Input, VideoSampleSink, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';
import { type Clip, type CursorTrack, type MediaAsset, type Project, type StyleSettings, assetOf } from '../core/model.ts';
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

  /** Camera timelines are cached per clip edit state so small edits rebuild quickly. */
  async renderData(clip: Clip, asset: MediaAsset, style: StyleSettings): Promise<ClipRenderData> {
    const key = JSON.stringify([clip.id, clip.zooms, asset.id, style.zoomSpeed, style.smoothCursor]);
    const hit = this.renderCache.get(key);
    if (hit) return { ...hit, clip, style };
    const d = makeRenderData(clip, asset, await this.cursor(asset), style);
    if (this.renderCache.size > 64) this.renderCache.clear();
    this.renderCache.set(key, d);
    return d;
  }

  async allRenderData(p: Project): Promise<ClipRenderData[]> {
    return Promise.all(p.clips.map((c) => this.renderData(c, assetOf(p, c.mediaID)!, p.style)));
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

  dispose() {
    for (const f of this.files.values()) f.then((m) => m.input.dispose()).catch(() => {});
    this.files.clear();
  }
}
