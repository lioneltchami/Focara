import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CursorTrack, type MediaAsset, type Project, type StyleSettings, canvasSize, newClip, newProject } from '../src/core/model.ts';
import { cameraTrack } from '../src/core/cameraLayout.ts';
import { magnifierTrack, defaultMagnifier } from '../src/core/magnifier.ts';
import { addCameraSegment, addMagnifier } from '../src/core/edit.ts';
import { generateAutoZooms } from '../src/core/zoom.ts';
import { type ClipRenderData, frameKind, makeRenderData } from '../src/render/renderer.ts';

// The player draws one frame of each kind before playback so the GPU never has to build a
// pipeline mid-playback (see frameKind); these check the kinds without a GPU.

const SRC = { width: 2560, height: 1600 }, CAM = { width: 1280, height: 720 };

function track(): CursorTrack {
  const t: CursorTrack = { samples: [], clicks: [] };
  for (let i = 0; i <= 20 * 60; i++) {
    const s = i / 60;
    // Moves for 9 s, rests (the idle cursor fades out), then moves again.
    const m = s < 9 ? s : s < 13 ? 9 : s - 4;
    t.samples.push({ t: s, x: 1280 + 900 * Math.sin(m * 0.7), y: 800 + 500 * Math.cos(m * 0.5) });
  }
  for (const c of [2, 5.5, 15]) t.clicks.push({ t: c, x: 1280, y: 800, isDown: true, button: 0 }, { t: c + 0.08, x: 1280, y: 800, isDown: false, button: 0 });
  return t;
}

function setup(style: Partial<StyleSettings> = {}) {
  const asset: MediaAsset = { id: 'M', kind: 'screenRecording', displayName: 'x', videoFile: 'v', cursorFile: 'c', cameraFile: 'k',
    duration: 20, pixelWidth: SRC.width, pixelHeight: SRC.height, pixelsPerPoint: 2 };
  let p: Project = newProject('t');
  p.media = [asset];
  const clip = newClip('M', 0, 20);
  clip.zooms = generateAutoZooms(track(), 20);
  p.clips = [clip];
  p.style = { ...p.style, hideIdleCursor: true, cursorHighlight: true, ...style };
  p = addCameraSegment(p, 4, 7, { mode: 'full', position: 'center', size: 0.3 }).project;
  p = addCameraSegment(p, 10, 14, { mode: 'bubble', position: 'top-center', size: 0.22 }).project;
  p = addMagnifier(p, 15, 17, defaultMagnifier()).project;
  const data: ClipRenderData = { ...makeRenderData(p.clips[0], asset, track(), p.style), timelineStart: 0, cameraSpans: cameraTrack(p), magnifierSpans: magnifierTrack(p) };
  const canvas = canvasSize(p, { ...p.export, resolution: 'p1080' });
  return { kind: (t: number) => frameKind(canvas, SRC, data, t, CAM) };
}

test('every frame the renderer draws can be described (any cursor, click or camera style)', () => {
  for (const cursorStyle of ['arrow', 'arrow-dark', 'arrow-color', 'dot'] as const) {
    for (const clickStyle of ['ring', 'pulse'] as const) {
      const { kind } = setup({ cursorStyle, clickStyle, camera: { ...newProject('t').style.camera, show: true, shape: 'circle', border: true, mirror: true } });
      for (let t = 0; t < 20; t += 1 / 30) assert.ok(kind(t).length > 0);
    }
  }
});

test('frames that need other GPU pipelines are of another kind; similar frames share one', () => {
  const { kind } = setup();
  const kinds = new Set<string>();
  for (let t = 0; t < 20; t += 1 / 30) kinds.add(kind(t));
  assert.ok(kinds.size > 5 && kinds.size < 300, `${kinds.size} kinds in 600 frames`);
  assert.match(kind(2.1), /^.*fill\(arc/, 'a click ripple');
  assert.notEqual(kind(2.1), kind(3.5), 'ripple or not');
  assert.match(kind(5.5), /camera\(up/, 'full-frame camera scaled up');
  assert.match(kind(9.2), /cursor\(/, 'the cursor while it rests');
  assert.doesNotMatch(kind(11.5), /cursor\(/, 'no cursor once it has faded out');
  assert.match(kind(16), /screen\(up/, 'the lens shows the screen larger');
});
