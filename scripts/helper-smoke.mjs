// Records ~3 s with the native capture helper and checks its output files.
// Used in CI on Windows; on macOS it is skipped when screen-recording permission is missing.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny';

const exe = process.platform === 'win32' ? 'native/win/target/release/odak-capture.exe' : 'native/mac/build/odak-capture';
if (process.platform === 'darwin') {
  // Preflight without prompting: skip on machines (like CI) without screen-recording permission.
  const pre = spawnSync(exe, ['permission'], { encoding: 'utf8' });
  if (!pre.stdout.includes('"granted":true')) { console.log('SKIP: no screen recording permission on this machine'); process.exit(0); }
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'odak-helper-'));
const args = ['record', '--out', out, '--fps', '30', '--system-audio'];
if (process.platform === 'darwin') args.push('--display-id', '1');
const p = spawn(exe, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const events = [];
let buf = '';
const waiters = [];
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const e = JSON.parse(line);
    console.log('helper:', line);
    events.push(e);
    waiters.splice(0).forEach((w) => w());
  }
});
const next = async (names, ms) => {
  const t = Date.now();
  for (;;) {
    const e = events.find((x) => names.includes(x.event) || x.event === 'error');
    if (e) return e;
    if (Date.now() - t > ms) return { event: 'error', message: 'timeout' };
    await new Promise((r) => { waiters.push(r); setTimeout(r, 200); });
  }
};

const started = await next(['started'], 20000);
if (started.event !== 'started') {
  if (started.code === 'permission') { console.log('SKIP: no screen recording permission on this machine'); process.exit(0); }
  console.error('FAIL: helper did not start:', started.message); process.exit(1);
}
await new Promise((r) => setTimeout(r, 3000));
p.stdin.write('stop\n');
const fin = await next(['finished'], 30000);
if (fin.event !== 'finished') { console.error('FAIL:', fin.message); process.exit(1); }

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failures++; };
const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path.join(out, fin.video)) });
const vt = await input.getPrimaryVideoTrack();
const vdur = await vt.computeDuration();
check(fin.duration > 2.5 && fin.duration < 6, `recording length ${fin.duration.toFixed(2)}s`);
check(vt && (await vt.getCodecParameterString())?.startsWith('avc') || fin.width > 4096, `video codec ${await vt.getCodecParameterString()}`);
check(vt.displayWidth === fin.width && vt.displayHeight === fin.height, `video ${vt.displayWidth}×${vt.displayHeight}`);
// The video covers the recording from its start. macOS writes frames only when the screen changes
// and ends the video exactly at the stop; the Windows encoder writes a constant frame rate (it
// repeats the last image, also a little past the stop — the editor uses the recording's duration).
const packets = new EncodedPacketSink(vt);
const ts = [];
for (let pk = await packets.getFirstPacket({ metadataOnly: true }); pk; pk = await packets.getNextPacket(pk, { metadataOnly: true })) ts.push(pk.timestamp);
ts.sort((a, b) => a - b);
console.log(`INFO: ${ts.length} frames in the file (helper sent ${fin.frames ?? '?'}); first ${ts.slice(0, 3).map((x) => x.toFixed(3)).join(' ')} … last ${ts.slice(-3).map((x) => x.toFixed(3)).join(' ')}`);
check(ts.length > 0 && ts[0] <= 0.05, `video starts with the recording (first frame ${ts[0]?.toFixed(3)}s)`);
check(ts.length > 0 && ts[ts.length - 1] >= fin.duration - 0.25, `video covers the recording (last frame ${ts[ts.length - 1]?.toFixed(2)}s of ${fin.duration.toFixed(2)}s)`);
if (process.platform === 'darwin') {
  check(ts[ts.length - 1] <= fin.duration + 0.05 && Math.abs(vdur - fin.duration) < 0.1, `video ends with the recording (${vdur.toFixed(2)}s)`);
} else console.log(`NOTE: constant-rate video runs to ${vdur.toFixed(2)}s (recording ${fin.duration.toFixed(2)}s)`);
const cursor = JSON.parse(fs.readFileSync(path.join(out, fin.cursor), 'utf8'));
check(Array.isArray(cursor.samples) && cursor.samples.length > 0 && Array.isArray(cursor.clicks), `cursor.json has ${cursor.samples.length} samples`);
if (fin.systemAudio) {
  const wav = fs.readFileSync(path.join(out, fin.systemAudio));
  const rate = wav.readUInt32LE(24), ch = wav.readUInt16LE(22), frames = wav.readUInt32LE(40) / (ch * 2);
  check(Math.abs(frames / rate - fin.duration) < 0.05, `system.wav ${(frames / rate).toFixed(2)}s matches recording`);
} else console.log('NOTE: no system audio file (no audio device on this machine?)');
console.log(failures ? `${failures} FAILED` : 'HELPER OK', '→', out);
process.exit(failures ? 1 : 0);
