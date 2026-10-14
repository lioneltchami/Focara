import { type Clip, type CursorTrack, type Project, type ZoomSegment, assetOf, followCursor, locate, uuid } from './model.ts';
import { generateAutoZooms } from './zoom.ts';

// Pure editing operations used by the editor UI (and tested headlessly).

/**
 * Keeps a zoom inside its clip's media and between its original neighbours, so a drag can never
 * jump over or overlap another zoom. A move keeps the length; a resize clamps the edges.
 */
export function fitZoom(z: ZoomSegment, original: ZoomSegment, clip: Clip): ZoomSegment {
  const others = clip.zooms.filter((o) => o.id !== original.id);
  const lo = Math.max(clip.sourceStart, ...others.filter((o) => o.start < original.start).map((o) => o.end));
  const hi = Math.min(clip.sourceEnd, ...others.filter((o) => o.start >= original.start).map((o) => o.start));
  const out = { ...z };
  const minLen = Math.min(0.3, Math.max(hi - lo, 0));
  const moved = Math.abs((z.end - z.start) - (original.end - original.start)) < 1e-9 && z.start !== original.start;
  if (moved) {
    const len = Math.min(z.end - z.start, hi - lo);
    out.start = Math.min(Math.max(z.start, lo), hi - len);
    out.end = out.start + len;
  } else {
    out.start = Math.min(Math.max(z.start, lo), hi - minLen);
    out.end = Math.min(Math.max(z.end, out.start + minLen), hi);
  }
  out.scale = Math.min(Math.max(z.scale, 1.1), 5);
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
