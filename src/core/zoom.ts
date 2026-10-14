import {
  type CursorTrack, type Size, type ZoomSegment, type ZoomSpeed, type ClickEvent,
  cursorPosition, followCursor, isFollow, stiffnessOf, uuid,
} from './model.ts';

// Same algorithm and parameters as Kadraj, so both apps produce the same zooms and motion.

/**
 * Turns clicks into zoom segments: each left click opens a window that starts a little before
 * the click and holds for a while after it; windows separated by a short gap merge, so a burst
 * of activity becomes one continuous zoom that pans instead of zooming in and out repeatedly.
 */
export const autoZoomParams = { leadIn: 0.45, hold: 2.6, mergeGap: 1.8, ignoreTail: 0.8, minimumDuration: 1.2, scale: 2 };

export function generateAutoZooms(track: CursorTrack, duration: number, p = autoZoomParams): ZoomSegment[] {
  const downs = track.clicks
    .filter((c) => c.isDown && c.button === 0 && c.t < duration - p.ignoreTail)
    .map((c) => c.t)
    .sort((a, b) => a - b);
  const windows: [number, number][] = [];
  for (const t of downs) {
    const w: [number, number] = [Math.max(0, t - p.leadIn), Math.min(duration, t + p.hold)];
    const last = windows[windows.length - 1];
    if (last && w[0] - last[1] <= p.mergeGap) last[1] = Math.max(last[1], w[1]);
    else windows.push(w);
  }
  return windows
    .filter(([s, e]) => e - s >= p.minimumDuration)
    .map(([start, end]) => ({ id: uuid(), start, end, scale: p.scale, focus: followCursor(), isGenerated: true }));
}

/**
 * Where the camera looks inside a cursor-following zoom: cursor positions are split, in time
 * order, into spatial groups that each fit comfortably in the zoomed viewport; the camera aims
 * at the dwell-time weighted centre of the group the cursor is currently in.
 */
export interface FocusGroup { firstTime: number; x: number; y: number }

export function focusPlan(track: CursorTrack, source: Size, zoom: ZoomSegment, viewportFill = 0.55): FocusGroup[] {
  const w = Math.max(source.width, 1), h = Math.max(source.height, 1);
  const pts: { t: number; x: number; y: number }[] = [];
  const p0 = cursorPosition(track, zoom.start);
  if (p0) pts.push({ t: zoom.start, x: p0.x / w, y: p0.y / h });
  let kept = pts[pts.length - 1];
  for (const s of track.samples) {
    if (s.t <= zoom.start || s.t >= zoom.end) continue;
    const p = { t: s.t, x: s.x / w, y: s.y / h };
    if (kept && Math.hypot((p.x - kept.x) * w, (p.y - kept.y) * h) < 4) continue;
    pts.push(p); kept = p;
  }
  if (!pts.length) return [];

  const limit = viewportFill / Math.max(zoom.scale, 1);
  const groups: FocusGroup[] = [];
  let members: typeof pts = [];
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  const close = (end: number) => {
    if (!members.length) return;
    let sw = 0, sx = 0, sy = 0;
    members.forEach((m, i) => {
      const next = i + 1 < members.length ? members[i + 1].t : end;
      const weight = Math.max(next - m.t, 0.001);
      sw += weight; sx += m.x * weight; sy += m.y * weight;
    });
    groups.push({ firstTime: members[0].t, x: sx / sw, y: sy / sw });
  };
  for (const m of pts) {
    if (!members.length) { members = [m]; minX = maxX = m.x; minY = maxY = m.y; continue; }
    const nx0 = Math.min(minX, m.x), nx1 = Math.max(maxX, m.x), ny0 = Math.min(minY, m.y), ny1 = Math.max(maxY, m.y);
    if (nx1 - nx0 <= limit && ny1 - ny0 <= limit) {
      members.push(m); minX = nx0; maxX = nx1; minY = ny0; maxY = ny1;
    } else {
      close(m.t);
      members = [m]; minX = maxX = m.x; minY = maxY = m.y;
    }
  }
  close(zoom.end);
  return groups;
}

function groupTarget(groups: FocusGroup[], t: number): { x: number; y: number } | null {
  if (!groups.length) return null;
  let cur = groups[0];
  for (const g of groups) if (g.firstTime <= t) cur = g;
  return cur;
}

export interface CameraState { scale: number; x: number; y: number }

/**
 * Camera and cursor motion for one media file, simulated once over the whole source duration
 * at a fixed rate. Preview and export both sample these arrays, so motion is identical however
 * the video is played, scrubbed or rendered.
 */
export class CameraTimeline {
  static readonly rate = 120;
  readonly duration: number;
  readonly hasCursor: boolean;
  readonly downClicks: ClickEvent[];
  private scale: Float64Array;
  private fx: Float64Array;
  private fy: Float64Array;
  private cx: Float64Array;
  private cy: Float64Array;

  constructor(track: CursorTrack | null, zooms: ZoomSegment[], source: Size, duration: number,
              speed: ZoomSpeed, smoothCursor: boolean) {
    this.duration = duration;
    const n = Math.max(Math.ceil(duration * CameraTimeline.rate) + 2, 2);
    const dt = 1 / CameraTimeline.rate;
    const zs = [...zooms].sort((a, b) => a.start - b.start);
    const tr: CursorTrack = track ?? { samples: [], clicks: [] };
    const plans = zs.map((z) => (isFollow(z.focus) ? focusPlan(tr, source, z) : []));
    const scale = new Float64Array(n), fx = new Float64Array(n), fy = new Float64Array(n);

    // Critically damped springs: fast to settle, never overshoot.
    const k = stiffnessOf(speed), c = 2 * Math.sqrt(k);
    const panK = k * 0.8, panC = 2 * Math.sqrt(panK);
    let logS = 0, vS = 0, px = 0.5, py = 0.5, vx = 0, vy = 0, tx = 0.5, ty = 0.5;
    const sub = 8, h = dt / sub;
    let zi = 0;
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      while (zi < zs.length && zs[zi].end <= t) zi++;
      let targetScale = 1;
      if (zi < zs.length && zs[zi].start <= t) {
        const z = zs[zi];
        targetScale = Math.max(1, z.scale);
        if ('fixed' in z.focus) { tx = z.focus.fixed.x; ty = z.focus.fixed.y; }
        else { const g = groupTarget(plans[zi], t); if (g) { tx = g.x; ty = g.y; } }
      }
      // While fully zoomed out the focus is invisible: jump straight to the new target so the
      // next zoom heads directly at it instead of sweeping across.
      if (Math.exp(logS) < 1.01) { px = tx; py = ty; vx = 0; vy = 0; }
      const goal = Math.log(targetScale);
      for (let s = 0; s < sub; s++) {
        vS += (-k * (logS - goal) - c * vS) * h; logS += vS * h;
        vx += (-panK * (px - tx) - panC * vx) * h;
        vy += (-panK * (py - ty) - panC * vy) * h;
        px += vx * h; py += vy * h;
      }
      if (Math.abs(logS - goal) < 1e-5 && Math.abs(vS) < 1e-5) { logS = goal; vS = 0; }
      const sc = Math.exp(logS), half = 0.5 / sc;
      scale[i] = sc;
      fx[i] = Math.min(Math.max(px, half), 1 - half);
      fy[i] = Math.min(Math.max(py, half), 1 - half);
    }
    this.scale = scale; this.fx = fx; this.fy = fy;

    // Cursor path, optionally smoothed with a stiff spring to remove jitter.
    const cx = new Float64Array(n), cy = new Float64Array(n);
    this.hasCursor = tr.samples.length > 0;
    if (this.hasCursor) {
      const ck = 900, cc = 2 * Math.sqrt(ck);
      let x = tr.samples[0].x, y = tr.samples[0].y, vx2 = 0, vy2 = 0;
      for (let i = 0; i < n; i++) {
        const raw = cursorPosition(tr, i * dt) ?? { x, y };
        if (smoothCursor) {
          for (let s = 0; s < sub; s++) {
            vx2 += (-ck * (x - raw.x) - cc * vx2) * h; vy2 += (-ck * (y - raw.y) - cc * vy2) * h;
            x += vx2 * h; y += vy2 * h;
          }
        } else { x = raw.x; y = raw.y; }
        cx[i] = x; cy[i] = y;
      }
    }
    this.cx = cx; this.cy = cy;
    this.downClicks = tr.clicks.filter((c) => c.isDown);
  }

  private sample(a: Float64Array, t: number): number {
    const f = Math.min(Math.max(t, 0), this.duration) * CameraTimeline.rate;
    const i = Math.min(Math.floor(f), a.length - 2);
    const w = f - i;
    return a[i] * (1 - w) + a[i + 1] * w;
  }

  camera(t: number): CameraState {
    const s = this.sample(this.scale, t), half = 0.5 / s;
    return {
      scale: s,
      x: Math.min(Math.max(this.sample(this.fx, t), half), 1 - half),
      y: Math.min(Math.max(this.sample(this.fy, t), half), 1 - half),
    };
  }

  /** Cursor position in source pixels (top-left origin). */
  cursor(t: number): { x: number; y: number } | null {
    return this.hasCursor ? { x: this.sample(this.cx, t), y: this.sample(this.cy, t) } : null;
  }
}
