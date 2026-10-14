// 16-bit PCM WAV with timeline alignment — the same rules as the native helpers:
// frame 0 is the first screen frame; gaps become silence, overlaps are dropped.

export function wavHeader(rate: number, channels: number, dataBytes: number): Uint8Array {
  const b = new ArrayBuffer(44), v = new DataView(b);
  const text = (o: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, dataBytes, true);
  return new Uint8Array(b);
}

export class WavTimeline {
  frames = 0;
  readonly rate: number;
  readonly channels: number;
  constructor(rate: number, channels: number) { this.rate = rate; this.channels = channels; }

  /** Bytes to append for `samples` (interleaved floats) that belong at timeline frame `start`. */
  place(start: number, samples: Float32Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    const count = Math.floor(samples.length / this.channels);
    let skip = 0;
    if (start > this.frames) out.push(this.silence(start - this.frames));
    else if (start < this.frames) skip = this.frames - start;
    if (skip >= count) return out;
    const n = (count - skip) * this.channels;
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) pcm[i] = Math.max(-1, Math.min(1, samples[skip * this.channels + i])) * 32767;
    this.frames += count - skip;
    out.push(new Uint8Array(pcm.buffer));
    return out;
  }

  /** Silence up to the recording length (or nothing if already that long). */
  padTo(duration: number): Uint8Array | null {
    const target = Math.round(duration * this.rate);
    return target > this.frames ? this.silence(target - this.frames) : null;
  }

  private silence(n: number) {
    this.frames += n;
    return new Uint8Array(n * this.channels * 2);
  }
}
