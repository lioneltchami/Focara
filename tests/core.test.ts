import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CursorTrack, type Project, newClip, newProject, fixedFocus, projectDuration } from '../src/core/model.ts';
import { CameraTimeline, generateAutoZooms } from '../src/core/zoom.ts';
import { addZoomAt, deleteZoom, regenerateAutoZooms, updateZoom } from '../src/core/edit.ts';

// The same synthetic cursor Kadraj's selftest uses (1920×1200, 10 s).
function syntheticCursor(): CursorTrack {
  const t: CursorTrack = { samples: [], clicks: [] };
  for (let i = 0; i <= 1200; i++) {
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
    t.clicks.push({ t: tm, x, y, isDown: true, button: 0 });
    t.clicks.push({ t: tm + 0.08, x, y, isDown: false, button: 0 });
  }
  return t;
}

test('auto zoom matches Kadraj (Swift) output', () => {
  const z = generateAutoZooms(syntheticCursor(), 10);
  assert.deepEqual(z.map((s) => [+s.start.toFixed(2), +s.end.toFixed(2), s.scale]), [[0.55, 4.3, 2], [7.55, 10, 2]]);
});

test('camera motion matches Kadraj (Swift) values to 3 decimals', () => {
  const track = syntheticCursor();
  const tl = new CameraTimeline(track, generateAutoZooms(track, 10), { width: 1920, height: 1200 }, 10, 'normal', true);
  // Printed by Kadraj's selftest for the same input.
  const kadraj: [number, number, number, number][] = [
    [0.2, 1.0, 0.5, 0.5], [0.6, 1.114, 0.449, 0.449], [0.9, 1.898, 0.263, 0.263], [1.3, 1.998, 0.25, 0.252],
    [2.5, 2.0, 0.25, 0.252], [4.4, 1.547, 0.323, 0.323], [5.0, 1.002, 0.499, 0.499], [7.6, 1.114, 0.551, 0.551],
    [8.4, 1.999, 0.75, 0.75], [9.9, 2.0, 0.75, 0.75],
  ];
  for (const [t, s, x, y] of kadraj) {
    const c = tl.camera(t);
    assert.ok(Math.abs(c.scale - s) < 0.0015 && Math.abs(c.x - x) < 0.0015 && Math.abs(c.y - y) < 0.0015,
      `t=${t}: got ×${c.scale.toFixed(3)} (${c.x.toFixed(3)}, ${c.y.toFixed(3)}), Kadraj ×${s} (${x}, ${y})`);
  }
  let max = 0;
  for (let i = 0; i <= 1000; i++) max = Math.max(max, tl.camera(i / 100).scale);
  assert.ok(max <= 2.0001, `no overshoot (max ${max})`);
});

test('editing operations behave like Kadraj', () => {
  const track = syntheticCursor();
  let p: Project = newProject('t');
  p.media = [{ id: 'M', kind: 'screenRecording', displayName: 'x', videoFile: 'v', duration: 10, pixelWidth: 1920, pixelHeight: 1200, pixelsPerPoint: 2 }];
  const clip = newClip('M', 0, 10);
  clip.zooms = generateAutoZooms(track, 10);
  p.clips = [clip];
  assert.equal(projectDuration(p), 10);

  const r = addZoomAt(p, 5);
  assert.ok(!('error' in r));
  if ('error' in r) return;
  p = r.project;
  let z = p.clips[0].zooms.find((s) => s.id === r.zoomID)!;
  assert.ok(Math.abs(z.start - 5) < 1e-9 && z.end <= 7.55 + 1e-9, 'new zoom fits before the next one');

  const len = z.end - z.start, s0 = z.start, e0 = z.end;
  for (let step = 1; step <= 20; step++) p = updateZoom(p, clip.id, r.zoomID, (s) => ({ ...s, start: s0 + step * 0.2, end: e0 + step * 0.2 }));
  z = p.clips[0].zooms.find((s) => s.id === r.zoomID)!;
  assert.ok(Math.abs(z.end - z.start - len) < 1e-9 && z.end <= 7.55 + 1e-9, 'drag stops at neighbour');

  p = updateZoom(p, clip.id, r.zoomID, (s) => ({ ...s, start: 3 }));
  z = p.clips[0].zooms.find((s) => s.id === r.zoomID)!;
  assert.ok(Math.abs(z.start - 4.3) < 0.011, 'left edge clamps at previous end');

  p = updateZoom(p, clip.id, r.zoomID, (s) => ({ ...s, scale: 3, focus: fixedFocus(0.8, 0.2) }));
  z = p.clips[0].zooms.find((s) => s.id === r.zoomID)!;
  assert.ok(z.scale === 3 && !z.isGenerated && 'fixed' in z.focus);
  const tl = new CameraTimeline(track, p.clips[0].zooms, { width: 1920, height: 1200 }, 10, 'normal', true);
  const c = tl.camera((z.start + z.end) / 2 + 0.6);
  assert.ok(Math.abs(c.scale - 3) < 0.02 && Math.abs(c.x - 0.8) < 0.01 && Math.abs(c.y - 0.2) < 0.01, 'camera uses fixed focus');

  const gen = p.clips[0].zooms.find((s) => s.isGenerated)!;
  p = deleteZoom(p, clip.id, gen.id);
  assert.equal(p.clips[0].zooms.length, 2);
  p = regenerateAutoZooms(p, () => track);
  const zs = p.clips[0].zooms;
  assert.equal(zs.length, 3);
  assert.ok(zs.some((s) => s.id === r.zoomID && s.scale === 3), 'edited zoom kept');
  for (let i = 1; i < zs.length; i++) assert.ok(zs[i].start >= zs[i - 1].end - 1e-9, 'no overlaps');
});
