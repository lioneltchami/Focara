import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Project, newClip, newProject } from '../src/core/model.ts';
import { MAGNIFIER_TRANSITION, defaultMagnifier, magnifierAt, magnifierTrack } from '../src/core/magnifier.ts';
import { addMagnifier, deleteMagnifier, duplicateClip, removeRange, splitAt, updateMagnifier } from '../src/core/edit.ts';

function project(): Project {
  const p = newProject('t');
  p.media = [{ id: 'M', kind: 'screenRecording', displayName: 'x', videoFile: 'v', cursorFile: 'c', duration: 20, pixelWidth: 100, pixelHeight: 100, pixelsPerPoint: 1 }];
  p.clips = [newClip('M', 0, 20)];
  return p;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('the lens pops open, stays, and closes', () => {
  const { project: p, ids } = addMagnifier(project(), 4, 8, defaultMagnifier());
  assert.equal(ids.length, 1);
  const track = magnifierTrack(p);
  assert.equal(magnifierAt(track, 3.9), null, 'closed before');
  assert.equal(magnifierAt(track, 8.01), null, 'closed after');
  assert.equal(magnifierAt(track, 6)?.open, 1, 'fully open in the middle');
  const opening = [0.25, 0.5, 0.75, 0.95].map((k) => magnifierAt(track, 4 + k * MAGNIFIER_TRANSITION)!.open);
  assert.ok(opening[0] > 0 && opening[0] < opening[1] && opening.some((v) => v > 1), `opens with a little overshoot: ${opening.map((v) => v.toFixed(2))}`);
  const closing = [0.75, 0.5, 0.25].map((k) => magnifierAt(track, 8 - k * MAGNIFIER_TRANSITION)!.open);
  assert.ok(closing[0] > closing[1] && closing[1] > closing[2] && closing[2] > 0, `closes smoothly: ${closing.map((v) => v.toFixed(2))}`);
});

test('a cut inside a lens part keeps it open; edits keep it with its footage', () => {
  let p = addMagnifier(project(), 4, 8, defaultMagnifier()).project;
  const r = splitAt(p, 6); if (!('project' in r)) return assert.fail();
  p = r.project;
  assert.equal(p.clips[0].magnifiers.length, 1);
  assert.equal(p.clips[1].magnifiers.length, 1);
  assert.equal(magnifierTrack(p).length, 1, 'the two pieces play as one');
  assert.equal(magnifierAt(magnifierTrack(p), 6.01)?.open, 1, 'no closing at the cut');
  const t2 = magnifierTrack(removeRange(p, 1, 2));
  assert.ok(near(t2[0].start, 3) && near(t2[0].end, 7), JSON.stringify(t2));
  const d = duplicateClip(p, p.clips[1].id)!;
  assert.notEqual(d.project.clips[2].magnifiers[0].id, d.project.clips[1].magnifiers[0].id);
});

test('settings are kept in range; delete removes it', () => {
  let p = addMagnifier(project(), 4, 8, defaultMagnifier()).project;
  const id = p.clips[0].magnifiers[0].id;
  p = updateMagnifier(p, p.clips[0].id, id, (s) => ({ ...s, size: 2, zoom: 0.5, shape: 'rounded', end: 30 }));
  const m = p.clips[0].magnifiers[0];
  assert.ok(m.size === 0.7 && m.zoom === 1.25 && m.shape === 'rounded' && near(m.end, 20), JSON.stringify(m));
  p = deleteMagnifier(p, p.clips[0].id, id);
  assert.equal(p.clips[0].magnifiers.length, 0);
});
