import {
  type CameraSegment, type Clip, type CursorTrack, type Project, type ZoomSegment, assetOf, clipDuration, clipStarts, followCursor,
  locate, projectDuration, uuid,
} from './model.ts';
import type { CameraLayout } from './cameraLayout.ts';
import { generateAutoZooms } from './zoom.ts';

// Pure editing operations used by the editor UI (and tested headlessly).

/**
 * Keeps a zoom inside its clip's media and between its original neighbours, so a drag can never
 * jump over or overlap another zoom. A move keeps the length; a resize clamps the edges.
 */
export function fitZoom(z: ZoomSegment, original: ZoomSegment, clip: Clip): ZoomSegment {
  const out = fitSpan(z, original, clip.zooms, clip, 0.3);
  out.scale = Math.min(Math.max(z.scale, 1.1), 5);
  return out;
}

/** The same rule for any timed piece of a clip (zooms, camera segments). */
function fitSpan<T extends { id: string; start: number; end: number }>(z: T, original: T, list: T[], clip: Clip, minLength: number): T {
  const others = list.filter((o) => o.id !== original.id);
  const lo = Math.max(clip.sourceStart, ...others.filter((o) => o.start < original.start).map((o) => o.end));
  const hi = Math.min(clip.sourceEnd, ...others.filter((o) => o.start >= original.start).map((o) => o.start));
  const out = { ...z };
  const minLen = Math.min(minLength, Math.max(hi - lo, 0));
  const moved = Math.abs((z.end - z.start) - (original.end - original.start)) < 1e-9 && z.start !== original.start;
  if (moved) {
    const len = Math.min(z.end - z.start, hi - lo);
    out.start = Math.min(Math.max(z.start, lo), hi - len);
    out.end = out.start + len;
  } else {
    out.start = Math.min(Math.max(z.start, lo), hi - minLen);
    out.end = Math.min(Math.max(z.end, out.start + minLen), hi);
  }
  return out;
}

const sortZooms = (zs: ZoomSegment[]) => [...zs].sort((a, b) => a.start - b.start);

export function updateZoom(p: Project, clipID: string, zoomID: string, change: (z: ZoomSegment) => ZoomSegment): Project {
  return {
    ...p,
    clips: p.clips.map((c) => {
      if (c.id !== clipID) return c;
      const original = c.zooms.find((z) => z.id === zoomID);
      if (!original) return c;
      const next = fitZoom({ ...change({ ...original }), isGenerated: false }, original, c);
      return { ...c, zooms: sortZooms(c.zooms.map((z) => (z.id === zoomID ? next : z))) };
    }),
  };
}

export type AddResult = { project: Project; clipID: string; zoomID: string } | { error: string };

export function addZoomAt(p: Project, time: number): AddResult {
  const loc = locate(p, time);
  if (!loc) return { error: 'Zaman çizelgesi boş.' };
  const clip = p.clips[loc.index], t = loc.sourceTime;
  const nextStart = Math.min(clip.sourceEnd, ...clip.zooms.filter((z) => z.start > t).map((z) => z.start));
  if (clip.zooms.some((z) => z.start <= t && z.end > t) || nextStart - t < 0.3) {
    return { error: 'Oynatma çizgisinin olduğu yerde zaten bir zoom var.' };
  }
  const z: ZoomSegment = { id: uuid(), start: t, end: Math.min(t + 2.5, nextStart), scale: 2, focus: followCursor(), isGenerated: false };
  return {
    project: { ...p, clips: p.clips.map((c, i) => (i === loc.index ? { ...c, zooms: sortZooms([...c.zooms, z]) } : c)) },
    clipID: clip.id, zoomID: z.id,
  };
}

export function deleteZoom(p: Project, clipID: string, zoomID: string): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === clipID ? { ...c, zooms: c.zooms.filter((z) => z.id !== zoomID) } : c)) };
}

/** Replaces untouched generated zooms; zooms the user created or edited are kept. */
export function regenerateAutoZooms(p: Project, cursorOf: (mediaID: string) => CursorTrack | null): Project {
  return {
    ...p,
    clips: p.clips.map((c) => {
      const media = assetOf(p, c.mediaID);
      const track = media?.kind === 'screenRecording' ? cursorOf(media.id) : null;
      if (!media || !track) return c;
      const kept = c.zooms.filter((z) => !z.isGenerated);
      const fresh = generateAutoZooms(track, media.duration).filter((z) =>
        z.end > c.sourceStart && z.start < c.sourceEnd && !kept.some((k) => k.start < z.end && z.start < k.end));
      return { ...c, zooms: sortZooms([...kept, ...fresh]) };
    }),
  };
}

// ---------------------------------------------------------------- clip editing

const MIN_CLIP = 0.1; // seconds of source

/** Pieces of a clip (zooms, camera segments) inside [a, b], clipped to it; too-short leftovers are dropped. */
function within<T extends { id: string; start: number; end: number }>(list: T[], a: number, b: number, newIds: boolean, minLength: number): T[] {
  return list
    .filter((z) => z.end > a && z.start < b)
    .map((z) => ({ ...z, id: newIds ? uuid() : z.id, start: Math.max(z.start, a), end: Math.min(z.end, b) }))
    .filter((z) => z.end - z.start >= minLength);
}
const zoomsWithin = (zooms: ZoomSegment[], a: number, b: number, newIds: boolean) => within(zooms, a, b, newIds, 0.3);
const MIN_CAMERA = 0.05;

/** Splits a clip at a source time; the right part gets a new id. */
export function splitClipAtSource(p: Project, clipID: string, source: number): { project: Project; rightID: string } | { error: string } {
  const i = p.clips.findIndex((c) => c.id === clipID);
  if (i < 0) return { error: 'Klip bulunamadı.' };
  const c = p.clips[i];
  if (source - c.sourceStart < MIN_CLIP || c.sourceEnd - source < MIN_CLIP) return { error: 'Bölmek için klibin kenarına çok yakınsın.' };
  const cams = c.cameraSegments ?? [];
  const left: Clip = { ...c, sourceEnd: source, zooms: zoomsWithin(c.zooms, c.sourceStart, source, false),
    cameraSegments: within(cams, c.sourceStart, source, false, MIN_CAMERA) };
  const right: Clip = { ...c, id: uuid(), sourceStart: source, zooms: zoomsWithin(c.zooms, source, c.sourceEnd, true),
    cameraSegments: within(cams, source, c.sourceEnd, true, MIN_CAMERA) };
  const clips = [...p.clips];
  clips.splice(i, 1, left, right);
  return { project: { ...p, clips }, rightID: right.id };
}

/** Splits the clip under the playhead. */
export function splitAt(p: Project, time: number) {
  const loc = locate(p, time);
  if (!loc) return { error: 'Zaman çizelgesi boş.' } as const;
  return splitClipAtSource(p, p.clips[loc.index].id, loc.sourceTime);
}

/** Removes a clip; later clips move up (no gap is left). */
export function deleteClip(p: Project, clipID: string): Project {
  return { ...p, clips: p.clips.filter((c) => c.id !== clipID) };
}

/** Moves a clip's start or end to a source time, within its media. */
export function trimClip(p: Project, clipID: string, edge: 'start' | 'end', source: number): Project {
  return {
    ...p,
    clips: p.clips.map((c) => {
      if (c.id !== clipID) return c;
      const media = assetOf(p, c.mediaID);
      const max = media?.duration ?? c.sourceEnd;
      if (edge === 'start') return { ...c, sourceStart: Math.min(Math.max(0, source), c.sourceEnd - MIN_CLIP) };
      return { ...c, sourceEnd: Math.max(Math.min(max, source), c.sourceStart + MIN_CLIP) };
    }),
  };
}

export function moveClip(p: Project, clipID: string, toIndex: number): Project {
  const from = p.clips.findIndex((c) => c.id === clipID);
  if (from < 0) return p;
  const clips = [...p.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(toIndex > from ? toIndex - 1 : toIndex, clips.length)), 0, c);
  return { ...p, clips };
}

export function duplicateClip(p: Project, clipID: string): { project: Project; newID: string } | null {
  const i = p.clips.findIndex((c) => c.id === clipID);
  if (i < 0) return null;
  const copy: Clip = { ...p.clips[i], id: uuid(), zooms: p.clips[i].zooms.map((z) => ({ ...z, id: uuid() })),
    cameraSegments: (p.clips[i].cameraSegments ?? []).map((s) => ({ ...s, id: uuid() })) };
  const clips = [...p.clips];
  clips.splice(i + 1, 0, copy);
  return { project: { ...p, clips }, newID: copy.id };
}

export function setClipSpeed(p: Project, clipID: string, speed: number): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === clipID ? { ...c, speed: Math.min(16, Math.max(0.25, speed)) } : c)) };
}

/**
 * Splits at both ends of the timeline range [a, b] and returns the clips that now lie inside it.
 * A split refused because it is too close to a clip edge means that edge already is the boundary,
 * so membership allows that much slack.
 */
export function isolateRange(p: Project, a: number, b: number): { project: Project; clipIDs: string[] } {
  if (b - a < 0.01) return { project: p, clipIDs: [] };
  let q = p;
  for (const t of [b, a]) {
    const r = splitAt(q, t);
    if ('project' in r) q = r.project;
  }
  const starts = clipStarts(q);
  const clipIDs = q.clips.filter((c, i) => {
    const slack = MIN_CLIP / (c.speed || 1) + 1e-6;
    return starts[i] >= a - slack && starts[i] + clipDuration(c) <= b + slack;
  }).map((c) => c.id);
  return { project: q, clipIDs };
}

/** Removes the timeline range [a, b] (seconds), across clips. */
export function removeRange(p: Project, a: number, b: number): Project {
  const { project: q, clipIDs } = isolateRange(p, a, b);
  return { ...q, clips: q.clips.filter((c) => !clipIDs.includes(c.id)) };
}

/** Plays the timeline range [a, b] at another speed (its clips become separate clips). */
export function speedRange(p: Project, a: number, b: number, speed: number): { project: Project; clipIDs: string[] } {
  const r = isolateRange(p, a, b);
  return { project: r.clipIDs.reduce((q, id) => setClipSpeed(q, id, speed), r.project), clipIDs: r.clipIDs };
}

/** Inserts a clip after the given index (or at the end). */
export function insertClip(p: Project, clip: Clip, afterIndex = p.clips.length - 1): Project {
  const clips = [...p.clips];
  clips.splice(Math.min(afterIndex + 1, clips.length), 0, clip);
  return { ...p, clips };
}

// ---------------------------------------------------------------- quiet moments

export interface Activity {
  /** Cursor track of the recording (moves and clicks count as activity). */
  cursor: CursorTrack | null;
  /** Times of video frames: screen captures only deliver frames when the screen changes. */
  frameTimes: Float64Array | null;
  /** Audio loudness envelope (peak per `audioStep` seconds), mixed over all sources. */
  audio: Float32Array | null;
  audioStep: number;
}

export interface QuietOptions { minLength: number; margin: number; audioThreshold: number }
export const quietDefaults: QuietOptions = { minLength: 2, margin: 0.35, audioThreshold: 0.02 };

/**
 * Finds stretches of a screen recording where nothing happens: the screen doesn't change,
 * the cursor doesn't move or click, and nobody speaks. Returns source-time ranges, already
 * shrunk by a margin so the cut or speed-up never clips the start/end of an action.
 */
export function findQuietRanges(act: Activity, duration: number, o: QuietOptions = quietDefaults): { start: number; end: number }[] {
  const step = 0.1, n = Math.ceil(duration / step);
  const busy = new Uint8Array(n);
  const mark = (t: number, pad: number) => {
    for (let i = Math.max(0, Math.floor((t - pad) / step)); i <= Math.min(n - 1, Math.floor((t + pad) / step)); i++) busy[i] = 1;
  };
  const tr = act.cursor;
  if (tr) {
    for (let i = 1; i < tr.samples.length; i++) {
      const a = tr.samples[i - 1], b = tr.samples[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 2) mark(b.t, 0.4);
    }
    for (const c of tr.clicks) mark(c.t, 0.5);
  }
  if (act.frameTimes) {
    // Ignore the first frame and the repeated last frame the recorder adds at the stop.
    for (let i = 1; i < act.frameTimes.length - 1; i++) mark(act.frameTimes[i], 0.3);
  }
  if (act.audio) {
    for (let i = 0; i < act.audio.length; i++) if (act.audio[i] > o.audioThreshold) mark(i * act.audioStep, 0.3);
  }
  const out: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && !busy[i];
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      const s = runStart * step + o.margin, e = Math.min(duration, i * step) - o.margin;
      if (e - s >= o.minLength - 2 * o.margin && e - s > 0.3) out.push({ start: s, end: e });
      runStart = -1;
    }
  }
  return out;
}

/** Speeds up (or removes) the given source ranges in every clip that uses the media. */
export function applyQuietRanges(p: Project, mediaID: string, ranges: { start: number; end: number }[], mode: 'speed' | 'cut', speed = 4): Project {
  let q = p;
  for (const r of ranges) {
    for (const c of q.clips.filter((x) => x.mediaID === mediaID && x.sourceEnd > r.start && x.sourceStart < r.end)) {
      let id = c.id;
      const a = Math.max(r.start, c.sourceStart), b = Math.min(r.end, c.sourceEnd);
      if (a - c.sourceStart >= MIN_CLIP) { const s = splitClipAtSource(q, id, a); if ('project' in s) { q = s.project; id = s.rightID; } }
      const cur = q.clips.find((x) => x.id === id)!;
      if (cur.sourceEnd - b >= MIN_CLIP) { const s = splitClipAtSource(q, id, b); if ('project' in s) q = s.project; }
      q = mode === 'cut' ? deleteClip(q, id) : setClipSpeed(q, id, speed);
    }
  }
  return q;
}

// ---------------------------------------------------------------- camera segments

const sortByStart = <T extends { start: number }>(list: T[]) => [...list].sort((a, b) => a.start - b.start);

/**
 * Gives the timeline range [a, b] its own camera layout. The range may cross clips (one segment
 * per clip; they play as one). Existing segments under the range are cut back or replaced.
 */
export function addCameraSegment(p: Project, a: number, b: number, layout: CameraLayout): { project: Project; ids: { clipID: string; segID: string }[] } {
  a = Math.max(0, a); b = Math.min(projectDuration(p), b);
  const ids: { clipID: string; segID: string }[] = [];
  if (b - a < 0.1) return { project: p, ids };
  const starts = clipStarts(p);
  const clips = p.clips.map((c, i) => {
    const t0 = starts[i], t1 = t0 + clipDuration(c);
    if (b <= t0 || a >= t1) return c;
    const speed = c.speed || 1;
    const sa = c.sourceStart + (Math.max(a, t0) - t0) * speed, sb = c.sourceStart + (Math.min(b, t1) - t0) * speed;
    if (sb - sa < MIN_CAMERA) return c;
    const kept = (c.cameraSegments ?? []).flatMap((s) => {
      if (s.end <= sa || s.start >= sb) return [s];
      const parts: CameraSegment[] = [];
      if (sa - s.start >= MIN_CAMERA) parts.push({ ...s, end: sa });
      if (s.end - sb >= MIN_CAMERA) parts.push({ ...s, id: parts.length ? uuid() : s.id, start: sb });
      return parts;
    });
    const seg: CameraSegment = { id: uuid(), start: sa, end: sb, ...layout };
    ids.push({ clipID: c.id, segID: seg.id });
    return { ...c, cameraSegments: sortByStart([...kept, seg]) };
  });
  return { project: { ...p, clips }, ids };
}

/** Changes one camera segment; times stay inside the clip and between its neighbours. */
export function updateCameraSegment(p: Project, clipID: string, segID: string, change: (s: CameraSegment) => CameraSegment): Project {
  return {
    ...p,
    clips: p.clips.map((c) => {
      if (c.id !== clipID) return c;
      const list = c.cameraSegments ?? [];
      const original = list.find((s) => s.id === segID);
      if (!original) return c;
      const next = fitSpan(change({ ...original }), original, list, c, 0.2);
      next.size = Math.min(Math.max(next.size, 0.1), 0.6);
      return { ...c, cameraSegments: sortByStart(list.map((s) => (s.id === segID ? next : s))) };
    }),
  };
}

export function deleteCameraSegment(p: Project, clipID: string, segID: string): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === clipID ? { ...c, cameraSegments: (c.cameraSegments ?? []).filter((s) => s.id !== segID) } : c)) };
}
