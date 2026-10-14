import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Project, clipDuration, clipStarts, followCursor, locate, newClip, newProject, projectDuration } from '../src/core/model.ts';
import {
  applyQuietRanges, deleteClip, duplicateClip, findQuietRanges, insertClip, isolateRange, moveClip, removeRange,
  setClipSpeed, speedRange, splitAt, trimClip,
} from '../src/core/edit.ts';

function project(): Project {
  const p = newProject('t');
  p.media = [{ id: 'M', kind: 'screenRecording', displayName: 'x', videoFile: 'v', duration: 20, pixelWidth: 100, pixelHeight: 100, pixelsPerPoint: 1 }];
  const c = newClip('M', 0, 20);
  c.zooms = [{ id: 'Z1', start: 2, end: 6, scale: 2, focus: followCursor(), isGenerated: true },
             { id: 'Z2', start: 12, end: 15, scale: 2, focus: followCursor(), isGenerated: true }];
  p.clips = [c];
  return p;
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

test('split at the playhead keeps content and divides zooms', () => {
  const r = splitAt(project(), 4);
  assert.ok('project' in r);
  if (!('project' in r)) return;
  const [a, b] = r.project.clips;
  assert.ok(near(a.sourceEnd, 4) && near(b.sourceStart, 4) && near(projectDuration(r.project), 20));
  assert.deepEqual(a.zooms.map((z) => [z.start, z.end]), [[2, 4]]);
  assert.deepEqual(b.zooms.map((z) => [z.start, z.end]), [[4, 6], [12, 15]]);
  assert.notEqual(a.zooms[0].id, b.zooms[0].id, 'zoom ids stay unique');
  assert.ok('error' in splitAt(project(), 0.05), 'refuses to split at the very edge');
});

test('delete closes the gap; trim, move, duplicate', () => {
  let p = project();
  const r = splitAt(p, 5); if (!('project' in r)) return assert.fail();
  p = r.project;
  const [a, b] = p.clips;
  assert.ok(near(projectDuration(deleteClip(p, a.id)), 15));
  p = trimClip(p, b.id, 'end', 30);
  assert.ok(near(p.clips[1].sourceEnd, 20), 'trim stays within the media');
  p = trimClip(p, b.id, 'start', 8);
  assert.ok(near(projectDuration(p), 5 + 12));
  p = moveClip(p, b.id, 0);
  assert.deepEqual(p.clips.map((c) => c.id), [b.id, a.id]);
  const d = duplicateClip(p, a.id)!;
  assert.equal(d.project.clips.length, 3);
  assert.ok(near(projectDuration(d.project), 12 + 5 + 5));
});

test('speed changes timeline length and the time mapping', () => {
  let p = project();
  p = setClipSpeed(p, p.clips[0].id, 4);
  assert.ok(near(projectDuration(p), 5));
  const l = locate(p, 2.5)!;
  assert.ok(near(l.sourceTime, 10), 'timeline 2.5 s at 4× is source 10 s');
});

test('remove a range across clips', () => {
  let p = project();
  const r = splitAt(p, 10); if (!('project' in r)) return assert.fail();
  p = r.project;
  p = removeRange(p, 8, 13);
  assert.ok(near(projectDuration(p), 15));
  const starts = clipStarts(p);
  assert.equal(p.clips.length, 2);
  assert.ok(near(p.clips[0].sourceEnd, 8) && near(p.clips[1].sourceStart, 13) && near(starts[1], 8));
});

test('a range can become its own clips, or be sped up', () => {
  let p = project();
  const r = splitAt(p, 10); if (!('project' in r)) return assert.fail();
  p = r.project;
  const iso = isolateRange(p, 8, 13);
  assert.equal(iso.project.clips.length, 4);
  assert.equal(iso.clipIDs.length, 2, 'the range spans two clips');
  const starts = clipStarts(iso.project);
  const inside = iso.project.clips.filter((c) => iso.clipIDs.includes(c.id));
  assert.ok(near(inside[0].sourceStart, 8) && near(inside[1].sourceEnd, 13) && near(starts[1], 8));
  assert.ok(near(projectDuration(iso.project), 20), 'isolating changes nothing in time');

  const sp = speedRange(p, 8, 13, 4);
  assert.ok(near(projectDuration(sp.project), 15 + 5 / 4));
  assert.ok(sp.project.clips.filter((c) => sp.clipIDs.includes(c.id)).every((c) => c.speed === 4));

  // A range edge just inside a clip boundary (closer than a split allows) still takes that clip whole.
  const edge = removeRange(p, 10.05, 13);
  assert.ok(near(projectDuration(edge), 20 - 3.05, 0.06), `${projectDuration(edge)}`);
});

test('insert a clip of another media after the current one', () => {
  const p = project();
  p.media.push({ id: 'E', kind: 'externalVideo', displayName: 'e', videoFile: 'e.mp4', duration: 3, pixelWidth: 10, pixelHeight: 10, pixelsPerPoint: 1 });
  const q = insertClip(p, newClip('E', 0, 3), 0);
  assert.equal(q.clips[1].mediaID, 'E');
  assert.ok(near(projectDuration(q), 23));
});

test('quiet moments: no frames, no cursor, no sound', () => {
  // Activity everywhere except 5–11 s.
  const frameTimes = Float64Array.from({ length: 200 }, (_, i) => i * 0.1).filter((t) => t < 5 || t > 11);
  const ranges = findQuietRanges({ cursor: { samples: [], clicks: [] }, frameTimes, audio: null, audioStep: 0.1 }, 20);
  assert.equal(ranges.length, 1);
  assert.ok(ranges[0].start > 5 && ranges[0].start < 6 && ranges[0].end < 11 && ranges[0].end > 10, JSON.stringify(ranges));
  // Talking during the pause keeps it.
  const audio = new Float32Array(200); for (let i = 60; i < 90; i++) audio[i] = 0.3;
  const talked = findQuietRanges({ cursor: null, frameTimes, audio, audioStep: 0.1 }, 20);
  assert.ok(talked.every((r) => r.end - r.start < 3), JSON.stringify(talked));

  const p = project();
  const sped = applyQuietRanges(p, 'M', ranges, 'speed', 4);
  assert.equal(sped.clips.length, 3);
  assert.equal(sped.clips[1].speed, 4);
  const len = ranges[0].end - ranges[0].start;
  assert.ok(near(projectDuration(sped), 20 - len + len / 4, 1e-6));
  const cut = applyQuietRanges(p, 'M', ranges, 'cut');
  assert.ok(near(projectDuration(cut), 20 - len, 1e-6));
  assert.ok(cut.clips.every((c) => clipDuration(c) > 0));
});
