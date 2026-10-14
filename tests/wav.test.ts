import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WavTimeline, wavHeader } from '../src/media/wav.ts';

test('microphone WAV alignment matches the native helpers', () => {
  const w = new WavTimeline(48000, 2);
  const chunks: Uint8Array[] = [];
  const block = (v: number) => new Float32Array(4800 * 2).fill(v);
  chunks.push(...w.place(480, block(0.5)));    // 10 ms late -> silence first
  chunks.push(...w.place(5280, block(-0.5)));  // contiguous
  chunks.push(...w.place(9600, block(0.25)));  // overlaps 10 ms -> first 480 dropped
  const pad = w.padTo(1.0); if (pad) chunks.push(pad);
  const bytes = Buffer.concat(chunks);
  const s = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  const at = (f: number) => s[f * 2];
  assert.equal(s.length / 2, 48000);
  assert.deepEqual([at(479), at(480)], [0, 16383]);
  assert.deepEqual([at(5279), at(5280)], [16383, -16383]);
  assert.deepEqual([at(10079), at(10080)], [-16383, 8191]);
  assert.deepEqual([at(14399), at(14400)], [8191, 0]);
  const h = Buffer.from(wavHeader(48000, 2, bytes.length));
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(40), bytes.length);
});
