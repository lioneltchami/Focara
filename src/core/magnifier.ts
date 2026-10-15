import { type MagnifierShape, type Project, clipStarts, projectDuration, toLocal } from './model.ts';

// The magnifier: a lens that follows the cursor during chosen parts of the video and shows what is
// under it larger. Like camera layouts, it is worked out on the timeline, so a cut inside a lens
// part doesn't make the lens close and reopen.

export interface MagnifierSettings { size: number; zoom: number; shape: MagnifierShape }
export const defaultMagnifier = (): MagnifierSettings => ({ size: 0.32, zoom: 2, shape: 'circle' });

export interface MagnifierSpan { start: number; end: number; settings: MagnifierSettings; easeIn: boolean; easeOut: boolean }

/** Seconds the lens takes to open (with a little overshoot) and to close. */
export const MAGNIFIER_TRANSITION = 0.25;

const same = (a: MagnifierSettings, b: MagnifierSettings) =>
  a.shape === b.shape && Math.abs(a.size - b.size) < 1e-6 && Math.abs(a.zoom - b.zoom) < 1e-6;

/** The project's lens parts on the timeline, neighbouring equal pieces joined. */
export function magnifierTrack(p: Project): MagnifierSpan[] {
  const starts = clipStarts(p);
  const pieces: { start: number; end: number; settings: MagnifierSettings }[] = [];
  p.clips.forEach((c, i) => {
    for (const s of c.magnifiers ?? []) {
      const a = Math.max(s.start, c.sourceStart), b = Math.min(s.end, c.sourceEnd);
      if (b - a <= 1e-6) continue;
      pieces.push({ start: starts[i] + toLocal(c, a), end: starts[i] + toLocal(c, b), settings: { size: s.size, zoom: s.zoom, shape: s.shape } });
    }
  });
  pieces.sort((x, y) => x.start - y.start);
  const joined: typeof pieces = [];
  for (const s of pieces) {
    const last = joined[joined.length - 1];
    if (last && s.start - last.end < 0.02 && same(last.settings, s.settings)) last.end = Math.max(last.end, s.end);
    else joined.push({ ...s });
  }
  const total = projectDuration(p);
  return joined.map((s, i) => ({
    ...s,
    easeIn: s.start > 1e-6 && !(i > 0 && s.start - joined[i - 1].end < 0.02),
    easeOut: s.end < total - 1e-6 && !(i + 1 < joined.length && joined[i + 1].start - s.end < 0.02),
  }));
}

const easeOutBack = (x: number) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

/** The lens at timeline time t: its settings and how open it is (0–1, briefly above 1 while popping open). */
export function magnifierAt(spans: MagnifierSpan[], t: number): { settings: MagnifierSettings; open: number } | null {
  const s = spans.find((x) => t >= x.start && t < x.end);
  if (!s) return null;
  const T = Math.min(MAGNIFIER_TRANSITION, (s.end - s.start) / 2);
  const inK = s.easeIn && T > 0 ? Math.min(1, (t - s.start) / T) : 1;
  const outK = s.easeOut && T > 0 ? Math.min(1, (s.end - t) / T) : 1;
  // Opening and closing never overlap (T is at most half the part).
  const open = inK < 1 ? easeOutBack(inK) : outK < 1 ? easeOutCubic(outK) : 1;
  return open > 0.001 ? { settings: s.settings, open } : null;
}
