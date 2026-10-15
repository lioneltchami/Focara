import type { VideoSample, VideoSampleSink } from 'mediabunny';
import { type ExportSettings, type Project, type Size, assetOf, canvasSize, clipDuration, clipStarts, locate, projectDuration } from '../core/model.ts';
import { type ClipRenderData, drawFrame } from '../render/renderer.ts';
import type { MediaLibrary } from './media.ts';
import { odak } from '../bridge.ts';

/** Geometry is resolution independent; the preview renders at up to 1080p. */
export function previewSettings(p: Project): ExportSettings {
  return { ...p.export, resolution: 'p1080' };
}

/** Draws one sample (or nothing) for a clip at a source time. Shared with the exporter. */
export function renderSample(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, canvas: Size,
                             sample: VideoSample | null, data: ClipRenderData, sourceTime: number,
                             camera: VideoSample | null = null) {
  drawFrame(ctx, canvas, sample ? (c, x, y, w, h) => sample.draw(c, x, y, w, h) : null,
    sample ? { width: sample.displayWidth, height: sample.displayHeight } : { width: 1, height: 1 }, data, sourceTime,
    camera ? { draw: (c, x, y, w, h) => camera.draw(c, x, y, w, h), size: { width: camera.displayWidth, height: camera.displayHeight } } : null);
}

/** Sequential decoding for playback: keeps the last frame starting at or before t. */
class FrameCursor {
  private it: AsyncGenerator<VideoSample, void, unknown>;
  private current: VideoSample | null = null;
  private next: VideoSample | null = null;
  private primed = false;
  constructor(sink: VideoSampleSink, start: number, end: number) { this.it = sink.samples(Math.max(0, start - 0.1), end + 0.1); }
  async at(t: number): Promise<VideoSample | null> {
    if (!this.primed) {
      this.primed = true;
      const a = await this.it.next(); this.current = a.done ? null : a.value;
      const b = a.done ? null : await this.it.next(); this.next = b && !b.done ? b.value : null;
    }
    while (this.next && this.next.timestamp <= t) {
      this.current?.close(); this.current = this.next;
      const r = await this.it.next(); this.next = r.done ? null : r.value;
    }
    return this.current;
  }
  async close() { this.current?.close(); this.next?.close(); this.current = this.next = null; await this.it.return(undefined); }
}

/** Playback measurements for the performance test. */
export class PlaybackStats {
  frames = 0;
  late = 0;
  stills = 0;
  drawMs: number[] = [];
  maxGap = 0;
  private last = 0;
  /** A frame drawn while playing; `lag` is how far behind the clock its content is (seconds). */
  played(lag: number) {
    const now = performance.now();
    if (this.last) this.maxGap = Math.max(this.maxGap, now - this.last);
    this.last = now;
    this.frames++;
    if (lag > 2.5 / 60) this.late++;
  }
}

/**
 * Preview playback. The Web Audio clock is the master clock: audio buffers of every source are
 * scheduled on it, and video frames are drawn for the time it reports.
 */
export class Player {
  currentTime = 0;
  playing = false;
  private project: Project | null = null;
  private data: ClipRenderData[] = [];
  private size: Size = { width: 1920, height: 1080 };
  private ctx: CanvasRenderingContext2D;
  private audio: AudioContext | null = null;
  private gen = 0;
  private pendingDraw: { t: number; fast: boolean } | null = null;
  private exactTimer: ReturnType<typeof setTimeout> | null = null;
  private drawing: Promise<void> | null = null;
  private lastError = 0;
  /** Set by the performance test only. */
  stats: PlaybackStats | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private clockStart = 0;
  private timeStart = 0;

  constructor(readonly canvas: HTMLCanvasElement, private lib: MediaLibrary,
              private onTime: (t: number) => void, private onPlaying: (p: boolean) => void) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  get duration() { return this.project ? projectDuration(this.project) : 0; }
  get canvasSize() { return this.size; }

  /** Installs a new edit state and redraws the current frame (playback continues). */
  async setProject(p: Project) {
    const data = await this.lib.allRenderData(p);
    const structureChanged = !this.project || JSON.stringify(this.project.clips.map(c => [c.id, c.mediaID, c.sourceStart, c.sourceEnd, c.videoVolume, c.systemAudioVolume, c.microphoneVolume]))
      !== JSON.stringify(p.clips.map(c => [c.id, c.mediaID, c.sourceStart, c.sourceEnd, c.videoVolume, c.systemAudioVolume, c.microphoneVolume]));
    this.project = p;
    this.data = data;
    const size = canvasSize(p, previewSettings(p));
    this.size = size;
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.canvas.width = size.width; this.canvas.height = size.height;
    }
    this.currentTime = Math.min(this.currentTime, this.duration);
    if (this.playing && structureChanged) { this.pause(); this.play(); }
    else if (!this.playing) await this.drawAt(this.currentTime);
  }

  /**
   * Draws the exact frame for timeline time t (the frame the exporter would produce).
   * Requests are coalesced: while one frame decodes, only the newest requested time is kept,
   * so dragging the playhead never runs a pile of full-resolution decoders at once.
   */
  drawAt(t: number, fast = false): Promise<void> {
    this.pendingDraw = { t, fast };
    this.drawing ??= (async () => {
      while (this.pendingDraw !== null) {
        const next = this.pendingDraw;
        this.pendingDraw = null;
        try { await this.drawOnce(next.t, next.fast); } catch (e) { this.decodeFailed(e, next.t); }
      }
    })().finally(() => { this.drawing = null; });
    return this.drawing;
  }

  /**
   * Dragging the playhead: show the nearest key frame at once (one frame to decode instead of
   * up to a second's worth), and the exact frame as soon as the pointer rests or lets go.
   */
  scrub(t: number) {
    if (this.playing) this.stopPlayback();
    this.currentTime = Math.min(Math.max(0, t), this.duration);
    this.onTime(this.currentTime);
    void this.drawAt(this.currentTime, true);
    if (this.exactTimer) clearTimeout(this.exactTimer);
    this.exactTimer = setTimeout(() => { this.exactTimer = null; void this.drawAt(this.currentTime); }, 120);
  }

  /** Resolves once no paused-frame draw is pending (including the exact frame after scrubbing). */
  async idle(): Promise<void> {
    while (this.drawing || this.exactTimer) {
      await (this.drawing ?? new Promise((r) => setTimeout(r, 20)));
    }
  }

  private async drawOnce(t: number, fast = false) {
    const began = performance.now();
    const p = this.project;
    if (!p) return;
    const loc = locate(p, t);
    if (!loc) { this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.size.width, this.size.height); return; }
    const clip = p.clips[loc.index];
    const media = await this.lib.open(assetOf(p, clip.mediaID)!.videoFile);
    let at = loc.sourceTime;
    if (fast && media.videoPackets) {
      // The key frame at or before t; if the cut trimmed it away, the first key frame inside the clip.
      let key = await media.videoPackets.getKeyPacket(loc.sourceTime, { metadataOnly: true });
      while (key && key.timestamp < clip.sourceStart) key = await media.videoPackets.getNextKeyPacket(key, { metadataOnly: true });
      if (key && key.timestamp < clip.sourceEnd) at = key.timestamp;
    }
    const cam = await this.lib.camera(p, clip);
    const [sample, camSample] = await Promise.all([
      media.videoSink ? media.videoSink.getSample(at) : null,
      cam ? cam.videoSink!.getSample(loc.sourceTime) : null,
    ]);
    if (this.playing) { sample?.close(); camSample?.close(); return; }
    renderSample(this.ctx, this.size, sample, this.data[loc.index], loc.sourceTime, camSample);
    sample?.close(); camSample?.close();
    if (this.stats) { this.stats.stills++; this.stats.drawMs.push(performance.now() - began); }
  }

  async seek(t: number) {
    if (this.exactTimer) { clearTimeout(this.exactTimer); this.exactTimer = null; }
    const wasPlaying = this.playing;
    if (wasPlaying) this.stopPlayback();
    this.currentTime = Math.min(Math.max(0, t), this.duration);
    this.onTime(this.currentTime);
    if (wasPlaying) this.play(); else await this.drawAt(this.currentTime);
  }

  private clock() {
    return this.timeStart + (this.audio!.currentTime - this.clockStart);
  }

  play() {
    const p = this.project;
    if (!p || this.playing || !p.clips.length) return;
    if (this.currentTime >= this.duration - 0.05) this.currentTime = 0;
    this.audio ??= new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    void this.audio.resume();
    const gen = ++this.gen;
    this.playing = true; this.onPlaying(true);
    this.timeStart = this.currentTime;
    this.clockStart = this.audio.currentTime + 0.12;
    void this.scheduleAudio(gen, p);
    void this.videoLoop(gen, p);
  }

  pause() {
    if (!this.playing) return;
    this.currentTime = Math.min(this.clock(), this.duration);
    this.stopPlayback();
    this.onTime(this.currentTime);
    void this.drawAt(this.currentTime);
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  private stopPlayback() {
    this.gen++;
    this.playing = false; this.onPlaying(false);
    for (const n of this.nodes) { try { n.stop(); } catch { /* already stopped */ } }
    this.nodes = [];
  }

  private async scheduleAudio(gen: number, p: Project) {
    const ac = this.audio!;
    const starts = clipStarts(p);
    const from = this.timeStart;
    for (let i = 0; i < p.clips.length; i++) {
      const clip = p.clips[i], clipStart = starts[i], clipEnd = clipStart + clipDuration(clip);
      if (clipEnd <= from) continue;
      if ((clip.speed || 1) !== 1) continue; // sped-up / slowed clips play silently
      const srcFrom = clip.sourceStart + Math.max(0, from - clipStart);
      const sources = await this.lib.audioOf(p, clip);
      await Promise.all(sources.map(async ({ sink, volume }) => {
        const gain = ac.createGain();
        gain.gain.value = volume;
        gain.connect(ac.destination);
        for await (const b of sink.buffers(Math.max(0, srcFrom - 0.2), clip.sourceEnd)) {
          if (gen !== this.gen) return;
          const timelineAt = clipStart + (b.timestamp - clip.sourceStart);
          const ctxAt = this.clockStart + (timelineAt - from);
          const offset = Math.max(0, srcFrom - b.timestamp);
          if (offset >= b.duration) continue;
          const node = ac.createBufferSource();
          node.buffer = b.buffer;
          node.connect(gain);
          node.start(Math.max(ctxAt + offset, ac.currentTime), offset);
          node.stop(this.clockStart + (clipEnd - from));
          this.nodes.push(node);
          node.onended = () => { this.nodes = this.nodes.filter((n) => n !== node); };
          // Stay a few seconds ahead of the clock, no more.
          while (gen === this.gen && ctxAt - ac.currentTime > 3) await new Promise((r) => setTimeout(r, 150));
        }
      }));
      if (gen !== this.gen) return;
    }
  }

  /** A frame that fails to decode is skipped instead of stopping the preview; it is logged (rate limited). */
  private decodeFailed(e: unknown, t: number) {
    if (performance.now() - this.lastError < 2000) return;
    this.lastError = performance.now();
    const loc = this.project && locate(this.project, t);
    const file = loc ? assetOf(this.project!, this.project!.clips[loc.index].mediaID)?.videoFile : undefined;
    odak().log('preview decode failed', { t: Number(t.toFixed(3)), file, error: String((e as Error)?.message ?? e) });
  }

  /**
   * Draws frames for the audio clock. A clip's decoders are opened before playback reaches it
   * (PREROLL seconds ahead), so a cut never waits for a decoder to catch up from a key frame.
   */
  private async videoLoop(gen: number, p: Project) {
    const starts = clipStarts(p);
    // How early to open a clip: more when its first frame is far from a key frame (more to decode).
    const leadFor = async (index: number) => {
      const clip = p.clips[index];
      const media = await this.lib.open(assetOf(p, clip.mediaID)!.videoFile);
      const key = await media.videoPackets?.getKeyPacket(clip.sourceStart, { metadataOnly: true });
      const behind = key ? clip.sourceStart - key.timestamp : 0;
      return Math.min(6, 1.5 + behind * 0.5);
    };
    let lead = 1.5, leadIndex = -1;
    type Cursors = { index: number; screen: FrameCursor | null; camera: FrameCursor | null; ready: Promise<unknown> };
    const open = async (index: number, from: number): Promise<Cursors> => {
      const clip = p.clips[index];
      const media = await this.lib.open(assetOf(p, clip.mediaID)!.videoFile);
      const screen = media.videoSink ? new FrameCursor(media.videoSink, from, clip.sourceEnd) : null;
      const cam = await this.lib.camera(p, clip);
      const camera = cam ? new FrameCursor(cam.videoSink!, from, clip.sourceEnd) : null;
      // Start decoding now; by the time playback gets here the first frames are waiting.
      return { index, screen, camera, ready: Promise.all([screen?.at(from), camera?.at(from)]) };
    };
    const release = (c: Cursors | null) => { if (c) void c.ready.catch(() => {}).then(() => Promise.allSettled([c.screen?.close(), c.camera?.close()])); };
    let current = null as Cursors | null, upcoming = null as Cursors | null;
    try {
      while (gen === this.gen) {
        const t = Math.max(this.timeStart, this.clock());
        if (t >= this.duration) {
          this.stopPlayback();
          this.currentTime = this.duration;
          this.onTime(this.currentTime);
          break;
        }
        this.currentTime = t;
        this.onTime(t);
        const loc = locate(p, t)!;
        let frame: VideoSample | null, camFrame: VideoSample | null;
        try {
          if (current?.index !== loc.index) {
            release(current);
            if (upcoming?.index === loc.index) { current = upcoming; upcoming = null; }
            else { release(upcoming); upcoming = null; current = await open(loc.index, loc.sourceTime); }
            await current.ready;
          }
          const clipEnd = starts[loc.index] + clipDuration(p.clips[loc.index]);
          if (leadIndex !== loc.index + 1 && loc.index + 1 < p.clips.length) { leadIndex = loc.index + 1; lead = await leadFor(loc.index + 1); }
          if (!upcoming && loc.index + 1 < p.clips.length && clipEnd - t < lead) {
            upcoming = await open(loc.index + 1, p.clips[loc.index + 1].sourceStart);
            upcoming.ready.catch(() => {});
          }
          [frame, camFrame] = await Promise.all([current.screen?.at(loc.sourceTime) ?? null, current.camera?.at(loc.sourceTime) ?? null]);
        } catch (e) {
          // Reopen the decoders at the current time on the next pass; the clock keeps running.
          this.decodeFailed(e, t);
          release(current); release(upcoming);
          current = upcoming = null;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        if (gen !== this.gen) break;
        renderSample(this.ctx, this.size, frame, this.data[loc.index], loc.sourceTime, camFrame);
        if (this.stats && frame) {
          const c = p.clips[loc.index];
          this.stats.played(this.clock() - (starts[loc.index] + (frame.timestamp - c.sourceStart) / (c.speed || 1)));
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    } finally {
      release(current); release(upcoming);
    }
  }

  destroy() {
    this.stopPlayback();
    void this.audio?.close();
  }
}
