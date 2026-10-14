import { Mp4OutputFormat, Output, QUALITY_HIGH, StreamTarget, VideoSample, VideoSampleSource, getFirstEncodableVideoCodec } from 'mediabunny';
import { odak } from '../bridge.ts';
import { WavTimeline, wavHeader } from './wav.ts';

// Webcam + microphone recording (runs in the app on both macOS and Windows, with device choice).
// Camera and microphone come from one MediaStream, so lip sync is kept; both are placed on the
// screen recording's timeline using its first-frame time (t0, Unix ms) reported by the helper.

declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame | AudioData> };
};

const nowEpoch = () => performance.timeOrigin + performance.now();

/** Maps a stream's own timestamps (ms) to Unix ms using the smallest observed delivery delay. */
export class ClockMap {
  offset = Infinity;
  samples = 0;
  observe(tsMs: number, arrivalMs: number) {
    if (this.samples++ < 60) this.offset = Math.min(this.offset, arrivalMs - tsMs);
  }
  map(tsMs: number) { return tsMs + this.offset; }
}

export interface SideDevices { cameraId: string | null; micId: string | null; noiseSuppression: boolean }
export interface SideResult { cameraFile?: string; micFile?: string }

export class SideRecorder {
  private video: MediaStreamTrack | null;
  private audio: MediaStreamTrack | null;
  private vclock = new ClockMap();
  private aclock = new ClockMap();
  private firstAudio: { ts: number; arrival: number } | null = null;
  private target: { pkg: string; mediaID: string; t0: number } | null = null;
  private pendingVideo: VideoFrame[] = [];
  private pendingAudio: AudioData[] = [];
  private loops: Promise<void>[] = [];
  private readers: ReadableStreamDefaultReader<VideoFrame | AudioData>[] = [];
  private duration = Infinity;
  private out: Output | null = null;
  private vsrc: VideoSampleSource | null = null;
  private camHandle: number | null = null;
  private lastT = -1;
  private camFrames = 0;
  private wav: WavTimeline | null = null;
  private micHandle: number | null = null;
  private micPos = 44;
  private micBuf: Uint8Array[] = [];
  private micBytes = 0;
  private writes: Promise<void> = Promise.resolve();

  private constructor(readonly stream: MediaStream) {
    this.video = stream.getVideoTracks()[0] ?? null;
    this.audio = stream.getAudioTracks()[0] ?? null;
  }

  static async open(d: SideDevices): Promise<SideRecorder | null> {
    if (!d.cameraId && !d.micId) return null;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: d.cameraId ? { deviceId: { exact: d.cameraId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } : false,
      audio: d.micId ? {
        deviceId: { exact: d.micId }, echoCancellation: false, noiseSuppression: d.noiseSuppression,
        autoGainControl: false, sampleRate: { ideal: 48000 },
      } : false,
    });
    const r = new SideRecorder(stream);
    r.begin();
    return r;
  }

  get hasCamera() { return !!this.video; }

  private begin() {
    const run = (track: MediaStreamTrack, handle: (x: VideoFrame & AudioData) => Promise<void>) => {
      const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 8 }).readable.getReader();
      this.readers.push(reader);
      this.loops.push((async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          try { await handle(value as VideoFrame & AudioData); } catch (e) { console.error('side recorder', e); }
        }
      })());
    };
    if (this.video) run(this.video, (f) => this.onVideo(f));
    if (this.audio) run(this.audio, (a) => this.onAudio(a));
  }

  /** Called once the screen helper reports its first frame. */
  async setTarget(pkg: string, mediaID: string, t0: number) {
    const dir = `${pkg}/media/${mediaID}`;
    if (this.video) {
      const s = this.video.getSettings();
      const w = (Math.round((s.width ?? 1280) / 2) * 2), h = (Math.round((s.height ?? 720) / 2) * 2);
      const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: w, height: h });
      if (codec) {
        const handle = await odak().fileOpen(`${dir}/camera.mp4`);
        this.camHandle = handle;
        this.out = new Output({
          format: new Mp4OutputFormat({ fastStart: false }),
          target: new StreamTarget(new WritableStream({ write: (c) => odak().fileWrite(handle, c.data, c.position) }), { chunked: true }),
        });
        this.vsrc = new VideoSampleSource({ codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
        this.out.addVideoTrack(this.vsrc, { frameRate: Math.round(s.frameRate ?? 30) });
        await this.out.start();
      }
    }
    if (this.audio) {
      this.micHandle = await odak().fileOpen(`${dir}/mic.wav`);
      await odak().fileWrite(this.micHandle, wavHeader(48000, 1, 0), 0);
    }
    this.target = { pkg, mediaID, t0 };
  }

  private async onVideo(frame: VideoFrame) {
    this.vclock.observe(frame.timestamp / 1000, nowEpoch());
    if (!this.target) {
      this.pendingVideo.push(frame);
      while (this.pendingVideo.length > 45) this.pendingVideo.shift()!.close();
      return;
    }
    for (const f of this.pendingVideo.splice(0)) await this.writeVideo(f);
    await this.writeVideo(frame);
  }

  private async writeVideo(frame: VideoFrame) {
    const t = (this.vclock.map(frame.timestamp / 1000) - this.target!.t0) / 1000;
    if (!this.vsrc || t < 0 || t <= this.lastT || t > this.duration) { frame.close(); return; }
    this.lastT = t;
    const sample = new VideoSample(frame, { timestamp: t });
    try { await this.vsrc.add(sample); this.camFrames++; } finally { sample.close(); }
  }

  private async onAudio(data: AudioData) {
    const arrival = nowEpoch();
    this.aclock.observe(data.timestamp / 1000, arrival);
    this.firstAudio ??= { ts: data.timestamp / 1000, arrival };
    if (!this.target) {
      this.pendingAudio.push(data);
      while (this.pendingAudio.length > 400) this.pendingAudio.shift()!.close();
      return;
    }
    for (const a of this.pendingAudio.splice(0)) this.writeAudio(a);
    this.writeAudio(data);
  }

  /** Audio and video of one capture share a clock; use the video's mapping to keep lip sync. */
  private audioToEpoch(tsMs: number) {
    const fa = this.firstAudio;
    if (this.video && this.vclock.samples > 0 && fa && Math.abs(fa.ts + this.vclock.offset - fa.arrival) < 300) {
      return this.vclock.map(tsMs);
    }
    return this.aclock.map(tsMs);
  }

  private writeAudio(data: AudioData) {
    try {
      if (!this.micHandle) return;
      const rate = data.sampleRate, ch = data.numberOfChannels, n = data.numberOfFrames;
      this.wav ??= new WavTimeline(rate, Math.min(ch, 2));
      const outCh = this.wav.channels;
      const planes: Float32Array[] = [];
      for (let c = 0; c < outCh; c++) {
        const p = new Float32Array(n);
        data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        planes.push(p);
      }
      const inter = new Float32Array(n * outCh);
      for (let i = 0; i < n; i++) for (let c = 0; c < outCh; c++) inter[i * outCh + c] = planes[c][i];
      const start = Math.round(((this.audioToEpoch(data.timestamp / 1000) - this.target!.t0) / 1000) * rate);
      if (start / rate > this.duration) return;
      for (const b of this.wav.place(start, inter)) this.queueMic(b);
    } finally {
      data.close();
    }
  }

  private queueMic(b: Uint8Array, force = false) {
    if (b.length) { this.micBuf.push(b); this.micBytes += b.length; }
    if (!force && this.micBytes < 128 * 1024) return;
    const all = new Uint8Array(this.micBytes);
    let o = 0;
    for (const c of this.micBuf) { all.set(c, o); o += c.length; }
    this.micBuf = []; this.micBytes = 0;
    const pos = this.micPos, handle = this.micHandle!;
    this.micPos += all.length;
    this.writes = this.writes.then(() => odak().fileWrite(handle, all, pos));
  }

  /** Stops capture and finishes the files, trimmed/padded to the screen recording's length. */
  async stop(duration: number): Promise<SideResult> {
    this.duration = duration;
    for (const t of this.stream.getTracks()) t.stop();
    await Promise.race([Promise.all(this.loops), new Promise((r) => setTimeout(r, 3000))]);
    for (const r of this.readers) r.cancel().catch(() => {});
    this.pendingVideo.forEach((f) => f.close()); this.pendingAudio.forEach((a) => a.close());
    const t = this.target;
    const res: SideResult = {};
    if (this.out && this.camHandle !== null) {
      if (this.camFrames > 0) { await this.out.finalize(); await odak().fileClose(this.camHandle); res.cameraFile = `media/${t!.mediaID}/camera.mp4`; }
      else { await this.out.cancel().catch(() => {}); await odak().fileClose(this.camHandle, true); }
    }
    if (this.micHandle !== null) {
      if (this.wav) {
        const pad = this.wav.padTo(duration);
        if (pad) this.queueMic(pad);
        this.queueMic(new Uint8Array(0), true);
        await this.writes;
        // Exactly the screen recording's length: audio captured after the stop is cut off.
        const frames = Math.min(this.wav.frames, Math.round(duration * this.wav.rate));
        const bytes = frames * this.wav.channels * 2;
        await odak().fileWrite(this.micHandle, wavHeader(this.wav.rate, this.wav.channels, bytes), 0);
        await odak().fileClose(this.micHandle, false, 44 + bytes);
        res.micFile = `media/${t!.mediaID}/mic.wav`;
      } else await odak().fileClose(this.micHandle, true);
    }
    return res;
  }

  /** Abandons the recording (e.g. the screen capture failed to start). */
  async cancel() {
    for (const t of this.stream.getTracks()) t.stop();
    for (const r of this.readers) r.cancel().catch(() => {});
    this.pendingVideo.forEach((f) => f.close()); this.pendingAudio.forEach((a) => a.close());
    if (this.out) await this.out.cancel().catch(() => {});
    if (this.camHandle !== null) await odak().fileClose(this.camHandle, true);
    if (this.micHandle !== null) await odak().fileClose(this.micHandle, true);
  }
}
