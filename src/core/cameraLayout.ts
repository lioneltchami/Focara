import {
  type CameraMode, type CameraPosition, type CameraSettings, type CameraShape, type Project, type Size, clipStarts,
  projectDuration, toLocal,
} from './model.ts';

// Where the webcam sits over time. Outside camera segments the project's camera settings apply;
// inside one the camera moves (or grows to the full frame, or fades out) with a short eased
// transition. Everything here works in timeline seconds, so a cut between two clips that keep the
// same layout never makes the camera move.

export interface CameraLayout { mode: CameraMode; position: CameraPosition; size: number }

/** A stretch of the timeline with its own layout. */
export interface CameraSpan {
  start: number;
  end: number;
  layout: CameraLayout;
  /** Layout the camera comes from at `start` (null: the project's camera settings). */
  from: CameraLayout | null;
  /** False at the very start of the video (already in place). */
  easeIn: boolean;
  /** False when the next span starts right here (it takes over) or the video ends. */
  easeOut: boolean;
}

/** Seconds the camera takes to move into a layout (and back out of it). */
export const CAMERA_TRANSITION = 0.5;

export const cameraPositions: { id: CameraPosition; icon: string; title: string }[] = [
  { id: 'top-left', icon: '↖', title: 'Sol üst' }, { id: 'top-center', icon: '↑', title: 'Üst orta' }, { id: 'top-right', icon: '↗', title: 'Sağ üst' },
  { id: 'middle-left', icon: '←', title: 'Sol orta' }, { id: 'center', icon: '•', title: 'Orta' }, { id: 'middle-right', icon: '→', title: 'Sağ orta' },
  { id: 'bottom-left', icon: '↙', title: 'Sol alt' }, { id: 'bottom-center', icon: '↓', title: 'Alt orta' }, { id: 'bottom-right', icon: '↘', title: 'Sağ alt' },
];

export const baseLayout = (c: CameraSettings): CameraLayout => ({ mode: c.show ? 'bubble' : 'hidden', position: c.position, size: c.size });

const sameLayout = (a: CameraLayout, b: CameraLayout) =>
  a.mode === b.mode && (a.mode !== 'bubble' || (a.position === b.position && Math.abs(a.size - b.size) < 1e-6));

/** The project's camera segments on the timeline, with neighbouring equal pieces joined. */
export function cameraTrack(p: Project): CameraSpan[] {
  const starts = clipStarts(p);
  const pieces: { start: number; end: number; layout: CameraLayout }[] = [];
  p.clips.forEach((c, i) => {
    for (const s of c.cameraSegments ?? []) {
      const a = Math.max(s.start, c.sourceStart), b = Math.min(s.end, c.sourceEnd);
      if (b - a <= 1e-6) continue;
      pieces.push({ start: starts[i] + toLocal(c, a), end: starts[i] + toLocal(c, b), layout: { mode: s.mode, position: s.position, size: s.size } });
    }
  });
  pieces.sort((x, y) => x.start - y.start);
  const joined: typeof pieces = [];
  for (const s of pieces) {
    const last = joined[joined.length - 1];
    if (last && s.start - last.end < 0.02 && sameLayout(last.layout, s.layout)) last.end = Math.max(last.end, s.end);
    else joined.push({ ...s });
  }
  const total = projectDuration(p);
  return joined.map((s, i) => {
    const prev = joined[i - 1], next = joined[i + 1];
    const afterPrev = !!prev && s.start - prev.end < 0.02;
    return {
      ...s,
      from: afterPrev ? prev.layout : null,
      easeIn: s.start > 1e-6,
      easeOut: !(next && next.start - s.end < 0.02) && s.end < total - 1e-6,
    };
  });
}

/** The camera's box on the canvas: rounded rect, opacity, and how much of a "bubble" it is (shadow/border). */
export interface CameraBox { x: number; y: number; width: number; height: number; radius: number; alpha: number; frame: number }

export function layoutBox(canvas: Size, layout: CameraLayout, shape: CameraShape): CameraBox {
  if (layout.mode === 'full') return { x: 0, y: 0, width: canvas.width, height: canvas.height, radius: 0, alpha: 1, frame: 0 };
  const h = canvas.height * layout.size;
  const w = shape === 'rounded' ? h * (4 / 3) : h;
  const margin = Math.min(canvas.width, canvas.height) * 0.035;
  const pos = layout.position;
  const x = pos.endsWith('left') ? margin : pos.endsWith('right') ? canvas.width - margin - w : (canvas.width - w) / 2;
  const y = pos.startsWith('top') ? margin : pos.startsWith('bottom') ? canvas.height - margin - h : (canvas.height - h) / 2;
  const radius = shape === 'circle' ? h / 2 : shape === 'rounded' ? h * 0.12 : h * 0.02;
  if (layout.mode === 'hidden') {
    // Fades out while shrinking a little towards its centre.
    const k = 0.85;
    return { x: x + (w * (1 - k)) / 2, y: y + (h * (1 - k)) / 2, width: w * k, height: h * k, radius: radius * k, alpha: 0, frame: 1 };
  }
  return { x, y, width: w, height: h, radius, alpha: 1, frame: 1 };
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const mix = (a: CameraBox, b: CameraBox, k: number): CameraBox => ({
  x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, width: a.width + (b.width - a.width) * k, height: a.height + (b.height - a.height) * k,
  radius: a.radius + (b.radius - a.radius) * k, alpha: a.alpha + (b.alpha - a.alpha) * k, frame: a.frame + (b.frame - a.frame) * k,
});

/** Where the camera is at timeline time t. */
export function cameraBoxAt(canvas: Size, camera: CameraSettings, spans: CameraSpan[], t: number): CameraBox {
  const base = layoutBox(canvas, baseLayout(camera), camera.shape);
  const s = spans.find((x) => t >= x.start && t < x.end);
  if (!s) return base;
  const target = layoutBox(canvas, s.layout, camera.shape);
  const T = Math.min(CAMERA_TRANSITION, (s.end - s.start) / (s.easeIn && s.easeOut ? 2 : 1));
  if (T <= 0) return target;
  if (s.easeIn && t - s.start < T) {
    const from = s.from ? layoutBox(canvas, s.from, camera.shape) : base;
    return mix(from, target, ease((t - s.start) / T));
  }
  if (s.easeOut && s.end - t < T) return mix(base, target, ease((s.end - t) / T));
  return target;
}
