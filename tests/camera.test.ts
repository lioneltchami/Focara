import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Project, defaultCamera, newClip, newProject, projectDuration } from '../src/core/model.ts';
import { CAMERA_TRANSITION, cameraBoxAt, cameraTrack, layoutBox } from '../src/core/cameraLayout.ts';
import { addCameraSegment, deleteCameraSegment, duplicateClip, removeRange, splitAt, updateCameraSegment } from '../src/core/edit.ts';

const canvas = { width: 1920, height: 1080 };
const cam = { ...defaultCamera(), position: 'bottom-right' as const, shape: 'circle' as const, size: 0.28 };
function project(): Project {
  const p = newProject('t');
  p.media = [{ id: 'M', kind: 'screenRecording', displayName: 'x', videoFile: 'v', cameraFile: 'c', duration: 20, pixelWidth: 100, pixelHeight: 100, pixelsPerPoint: 1 }];
  p.clips = [newClip('M', 0, 20)];
  p.style.camera = cam;
  return p;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const left = { mode: 'bubble' as const, position: 'top-left' as const, size: 0.2 };

test('a camera segment moves the bubble there, with an eased transition in and out', () => {
  const { project: p, ids } = addCameraSegment(project(), 5, 9, left);
  assert.equal(ids.length, 1);
  const track = cameraTrack(p);
  assert.equal(track.length, 1);
  const base = layoutBox(canvas, { mode: 'bubble', position: 'bottom-right', size: 0.28 }, 'circle');
  const target = layoutBox(canvas, left, 'circle');
  assert.deepEqual(cameraBoxAt(canvas, cam, track, 4.9), base, 'before: project settings');
  assert.deepEqual(cameraBoxAt(canvas, cam, track, 7), target, 'inside: the segment layout');
  assert.deepEqual(cameraBoxAt(canvas, cam, track, 9.1), base, 'after: back');
  const mid = cameraBoxAt(canvas, cam, track, 5 + CAMERA_TRANSITION / 2);
  assert.ok(near(mid.x, (base.x + target.x) / 2, 1) && near(mid.y, (base.y + target.y) / 2, 1), 'half-way through the move');
  const out = cameraBoxAt(canvas, cam, track, 9 - CAMERA_TRANSITION / 4);
  assert.ok(out.x > target.x && out.x < base.x, 'moves back before the segment ends');
});

test('full frame and hidden', () => {
  const p = addCameraSegment(addCameraSegment(project(), 2, 4, { mode: 'full', position: 'center', size: 0.3 }).project, 10, 12,
    { mode: 'hidden', position: 'center', size: 0.3 }).project;
  const track = cameraTrack(p);
  assert.deepEqual(cameraBoxAt(canvas, cam, track, 3), { x: 0, y: 0, width: 1920, height: 1080, radius: 0, alpha: 1, frame: 0 });
  assert.equal(cameraBoxAt(canvas, cam, track, 11).alpha, 0);
  assert.ok(cameraBoxAt(canvas, cam, track, 10 + CAMERA_TRANSITION / 2).alpha > 0.2, 'fades out');
});

test('a cut inside a segment does not make the camera move; edits keep segments with their content', () => {
  let p = addCameraSegment(project(), 5, 9, left).project;
  const r = splitAt(p, 7); if (!('project' in r)) return assert.fail();
  p = r.project;
  assert.equal(p.clips[0].cameraSegments.length, 1);
  assert.equal(p.clips[1].cameraSegments.length, 1);
  const track = cameraTrack(p);
  assert.equal(track.length, 1, 'the two pieces play as one');
  assert.deepEqual(cameraBoxAt(canvas, cam, track, 7.01), layoutBox(canvas, left, 'circle'));

  // Removing time before the segment moves it along with its content.
  const q = removeRange(p, 1, 3);
  const t2 = cameraTrack(q);
  assert.ok(near(t2[0].start, 3) && near(t2[0].end, 7), JSON.stringify(t2));
  // Duplicates get their own segment ids.
  const d = duplicateClip(p, p.clips[1].id)!;
  assert.notEqual(d.project.clips[2].cameraSegments[0].id, d.project.clips[1].cameraSegments[0].id);
});

test('adjacent segments hand over directly; a new segment replaces what is under it', () => {
  let p = addCameraSegment(project(), 4, 8, left).project;
  p = addCameraSegment(p, 8, 12, { mode: 'full', position: 'center', size: 0.3 }).project;
  const track = cameraTrack(p);
  assert.equal(track.length, 2);
  assert.ok(!track[0].easeOut && track[1].from?.position === 'top-left', 'first hands over to the second');
  const at = cameraBoxAt(canvas, cam, track, 8 + CAMERA_TRANSITION / 2);
  const a = layoutBox(canvas, left, 'circle');
  assert.ok(near(at.width, (a.width + 1920) / 2, 1), 'goes straight from the bubble to full frame');

  const over = addCameraSegment(p, 6, 10, { mode: 'hidden', position: 'center', size: 0.3 }).project;
  const segs = over.clips[0].cameraSegments.map((s) => [s.start, s.end, s.mode]);
  assert.deepEqual(segs, [[4, 6, 'bubble'], [6, 10, 'hidden'], [10, 12, 'full']]);
});

test('editing a segment stays inside its clip and away from neighbours', () => {
  let p = addCameraSegment(project(), 4, 8, left).project;
  p = addCameraSegment(p, 10, 12, left).project;
  const [s1] = p.clips[0].cameraSegments;
  p = updateCameraSegment(p, p.clips[0].id, s1.id, (s) => ({ ...s, end: 15, size: 2 }));
  const u = p.clips[0].cameraSegments[0];
  assert.ok(near(u.end, 10) && u.size === 0.6, JSON.stringify(u));
  p = deleteCameraSegment(p, p.clips[0].id, s1.id);
  assert.equal(p.clips[0].cameraSegments.length, 1);
  assert.ok(near(projectDuration(p), 20));
});
