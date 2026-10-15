// Project document model. The JSON layout matches Kadraj's project.json, so the two apps
// can open each other's projects.
//
// Times stored on clips and zooms are *source* times (seconds into the media file), so
// trimming or reordering clips never moves a zoom relative to the content it frames.

export type Focus = { followCursor: Record<string, never> } | { fixed: { x: number; y: number } };

export interface ZoomSegment {
  id: string;
  start: number;
  end: number;
  scale: number;
  focus: Focus;
  /** True while the segment is untouched output of the auto-zoom generator. */
  isGenerated: boolean;
}

/** How the webcam appears: a bubble somewhere on the canvas, the whole frame, or not at all. */
export type CameraMode = 'bubble' | 'full' | 'hidden';

/** A part of a clip where the camera has its own layout (source times, like zooms). */
export interface CameraSegment {
  id: string;
  start: number;
  end: number;
  mode: CameraMode;
  position: CameraPosition;
  /** Bubble height as a fraction of the canvas height. */
  size: number;
}

export type MagnifierShape = 'circle' | 'rounded';

/** A part of a clip where a magnifying lens follows the cursor (source times, like zooms). */
export interface MagnifierSegment {
  id: string;
  start: number;
  end: number;
  /** Lens diameter as a fraction of the frame's short side. */
  size: number;
  /** How much the lens magnifies (×). */
  zoom: number;
  shape: MagnifierShape;
}

export interface Clip {
  id: string;
  mediaID: string;
  sourceStart: number;
  sourceEnd: number;
  zooms: ZoomSegment[];
  /** Camera layout changes inside this clip; outside them the project's camera settings apply. */
  cameraSegments: CameraSegment[];
  /** Magnifier lens over the cursor during these parts. */
  magnifiers: MagnifierSegment[];
  /** Playback speed (1 = normal). Audio is muted while a clip plays faster or slower. */
  speed: number;
  videoVolume: number;
  systemAudioVolume: number;
  microphoneVolume: number;
}

export interface MediaAsset {
  id: string;
  kind: 'screenRecording' | 'externalVideo';
  displayName: string;
  /** Paths are relative to the project package, always with forward slashes. */
  videoFile: string;
  systemAudioFile?: string;
  microphoneFile?: string;
  cursorFile?: string;
  /** Webcam video recorded alongside the screen (same timeline as the screen video). */
  cameraFile?: string;
  duration: number;
  pixelWidth: number;
  pixelHeight: number;
  /** Pixels per point of the recorded display (cursor art is sized in points). */
  pixelsPerPoint: number;
  recordedAt?: number;
}

export interface RGBA { r: number; g: number; b: number; a: number }

export type ZoomSpeed = 'gentle' | 'normal' | 'quick';
export const zoomSpeeds: { id: ZoomSpeed; title: string; stiffness: number }[] = [
  { id: 'gentle', title: 'Yumuşak', stiffness: 70 },
  { id: 'normal', title: 'Normal', stiffness: 140 },
  { id: 'quick', title: 'Hızlı', stiffness: 260 },
];
export const stiffnessOf = (s: ZoomSpeed) => zoomSpeeds.find((z) => z.id === s)?.stiffness ?? 140;

export type BackgroundKind = 'gradient' | 'theme' | 'image';
export type CursorStyle = 'arrow' | 'arrow-dark' | 'arrow-color' | 'dot';
export type ClickStyle = 'ring' | 'pulse';
export type CameraPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type CameraShape = 'circle' | 'rounded' | 'square';

export interface CameraSettings {
  show: boolean;
  position: CameraPosition;
  /** Height of the camera bubble as a fraction of the canvas height. */
  size: number;
  shape: CameraShape;
  mirror: boolean;
  border: boolean;
}

export interface StyleSettings {
  backgroundKind: BackgroundKind;
  backgroundTop: RGBA;
  backgroundBottom: RGBA;
  backgroundTheme: string;
  /** Package-relative path of a user image (copied into the project). */
  backgroundImage: string | null;
  /** 0…1 blur of the background image. */
  backgroundBlur: number;
  /** Fraction of the shorter canvas side left as margin around the screen. */
  padding: number;
  /** Corner radius as a fraction of the shorter screen side. */
  cornerRadius: number;
  shadow: boolean;
  showCursor: boolean;
  cursorStyle: CursorStyle;
  cursorColor: RGBA;
  cursorScale: number;
  smoothCursor: boolean;
  /** Soft halo behind the cursor, handy for tutorials. */
  cursorHighlight: boolean;
  /** Fade the cursor out after it has been still for a moment. */
  hideIdleCursor: boolean;
  clickRipple: boolean;
  clickStyle: ClickStyle;
  zoomSpeed: ZoomSpeed;
  camera: CameraSettings;
}

export const defaultCamera = (): CameraSettings => ({
  show: true, position: 'bottom-right', size: 0.28, shape: 'circle', mirror: true, border: true,
});

export type Resolution = 'p720' | 'p1080' | 'p1440' | 'p2160';
export const resolutions: { id: Resolution; title: string; height: number }[] = [
  { id: 'p720', title: '720p', height: 720 },
  { id: 'p1080', title: '1080p', height: 1080 },
  { id: 'p1440', title: '1440p', height: 1440 },
  { id: 'p2160', title: '4K', height: 2160 },
];

export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif' | 'm4a' | 'wav' | 'png';
export type VideoCodecChoice = 'h264' | 'hevc' | 'av1' | 'vp9';
export type ExportQuality = 'high' | 'medium' | 'small';
/** Frame shape: 16:9, the recording's own, vertical 9:16 (Shorts/Reels/TikTok) or square. */
export type Aspect = 'wide' | 'recording' | 'vertical' | 'square';

export interface ExportSettings {
  format: ExportFormat;
  /** Height of the frame (for vertical and square: its width). */
  resolution: Resolution;
  fps: number;
  codec: VideoCodecChoice;
  quality: ExportQuality;
  aspect: Aspect;
  /** GIF only: width in pixels and frames per second. */
  gifWidth: number;
  gifFps: number;
}

export const exportFormats: { id: ExportFormat; title: string; ext: string; kind: 'video' | 'gif' | 'audio' | 'image'; note: string; codecs?: VideoCodecChoice[] }[] = [
  { id: 'mp4', title: 'MP4', ext: 'mp4', kind: 'video', note: 'YouTube ve her yer', codecs: ['h264', 'hevc', 'av1'] },
  { id: 'mov', title: 'MOV', ext: 'mov', kind: 'video', note: 'Final Cut, iMovie, Premiere', codecs: ['h264', 'hevc'] },
  { id: 'webm', title: 'WebM', ext: 'webm', kind: 'video', note: 'Web siteleri, küçük dosya', codecs: ['vp9', 'av1'] },
  { id: 'gif', title: 'GIF', ext: 'gif', kind: 'gif', note: 'README, sohbet · sessiz' },
  { id: 'm4a', title: 'Ses · M4A', ext: 'm4a', kind: 'audio', note: 'Yalnızca ses (AAC)' },
  { id: 'wav', title: 'Ses · WAV', ext: 'wav', kind: 'audio', note: 'Kayıpsız ses' },
  { id: 'png', title: 'Kare · PNG', ext: 'png', kind: 'image', note: 'Kapak görseli için tek kare' },
];
export const formatOf = (id: ExportFormat) => exportFormats.find((f) => f.id === id) ?? exportFormats[0];
export const codecTitles: Record<VideoCodecChoice, string> = {
  h264: 'H.264 (en uyumlu)', hevc: 'HEVC (daha küçük)', av1: 'AV1 (en küçük, yavaş)', vp9: 'VP9',
};

export interface Project {
  formatVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  media: MediaAsset[];
  clips: Clip[];
  style: StyleSettings;
  export: ExportSettings;
}

export interface CursorSample { t: number; x: number; y: number }
export interface ClickEvent { t: number; x: number; y: number; isDown: boolean; button: number }
export interface CursorTrack { samples: CursorSample[]; clicks: ClickEvent[] }

export const uuid = () => crypto.randomUUID().toUpperCase();
export const now = () => Date.now() / 1000;

export const defaultStyle = (): StyleSettings => ({
  backgroundKind: 'gradient',
  backgroundTop: { r: 0.2, g: 0.24, b: 0.42, a: 1 },
  backgroundBottom: { r: 0.53, g: 0.33, b: 0.55, a: 1 },
  backgroundTheme: 'eglenceli',
  backgroundImage: null,
  backgroundBlur: 0,
  padding: 0.07,
  cornerRadius: 0.018,
  shadow: true,
  showCursor: true,
  cursorStyle: 'arrow',
  cursorColor: { r: 0.48, g: 0.42, b: 1, a: 1 },
  cursorScale: 1.4,
  smoothCursor: true,
  cursorHighlight: false,
  hideIdleCursor: false,
  clickRipple: true,
  clickStyle: 'ring',
  zoomSpeed: 'normal',
  camera: defaultCamera(),
});

export const defaultExport = (): ExportSettings => ({
  format: 'mp4', resolution: 'p1080', fps: 60, codec: 'h264', quality: 'high', aspect: 'wide', gifWidth: 800, gifFps: 15,
});

export function newProject(name: string): Project {
  return {
    formatVersion: 1, id: uuid(), name, createdAt: now(), updatedAt: now(),
    media: [], clips: [], style: defaultStyle(), export: defaultExport(),
  };
}

export function newClip(mediaID: string, sourceStart: number, sourceEnd: number): Clip {
  return { id: uuid(), mediaID, sourceStart, sourceEnd, zooms: [], cameraSegments: [], magnifiers: [], speed: 1, videoVolume: 1, systemAudioVolume: 1, microphoneVolume: 1 };
}

/** Fills fields missing from older or foreign project files with defaults. */
export function normalizeProject(p: Project): Project {
  return {
    ...newProject(p.name ?? 'Proje'),
    ...p,
    style: { ...defaultStyle(), ...(p.style ?? {}), camera: { ...defaultCamera(), ...(p.style?.camera ?? {}) } },
    export: { ...defaultExport(), ...(p.export ?? {}) },
    clips: (p.clips ?? []).map((c) => ({ ...newClip(c.mediaID, c.sourceStart, c.sourceEnd), ...c, zooms: c.zooms ?? [], cameraSegments: c.cameraSegments ?? [], magnifiers: c.magnifiers ?? [] })),
    media: p.media ?? [],
  };
}

export const isFollow = (f: Focus): f is { followCursor: Record<string, never> } => 'followCursor' in f;
export const followCursor = (): Focus => ({ followCursor: {} });
export const fixedFocus = (x: number, y: number): Focus => ({ fixed: { x, y } });

/** Length of the clip on the output timeline (source length divided by speed). */
export const clipDuration = (c: Clip) => Math.max(0, (c.sourceEnd - c.sourceStart) / (c.speed || 1));
/** Clip-local timeline seconds <-> source seconds. */
export const toSource = (c: Clip, local: number) => c.sourceStart + local * (c.speed || 1);
export const toLocal = (c: Clip, source: number) => (source - c.sourceStart) / (c.speed || 1);
export const projectDuration = (p: Project) => p.clips.reduce((s, c) => s + clipDuration(c), 0);
export const assetOf = (p: Project, id: string) => p.media.find((m) => m.id === id);

export function clipStarts(p: Project): number[] {
  let t = 0;
  return p.clips.map((c) => { const s = t; t += clipDuration(c); return s; });
}

/** Output-timeline time -> clip index and source time. */
export function locate(p: Project, time: number): { index: number; sourceTime: number } | null {
  let t = 0;
  for (let i = 0; i < p.clips.length; i++) {
    const c = p.clips[i];
    const d = clipDuration(c);
    if (time < t + d || i === p.clips.length - 1) {
      return { index: i, sourceTime: toSource(c, Math.min(Math.max(time - t, 0), d)) };
    }
    t += d;
  }
  return null;
}

export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

export function canvasSize(p: Project, s: ExportSettings = p.export): Size {
  const h = resolutions.find((r) => r.id === s.resolution)?.height ?? 1080;
  if (s.aspect === 'vertical') return { width: h, height: Math.round((h * 16) / 9 / 2) * 2 };
  if (s.aspect === 'square') return { width: h, height: h };
  let aspect = 16 / 9;
  const first = p.clips[0] && assetOf(p, p.clips[0].mediaID);
  if (s.aspect === 'recording' && first) aspect = first.pixelWidth / Math.max(first.pixelHeight, 1);
  return { width: Math.round((h * aspect) / 2) * 2, height: h };
}

/** Where the unzoomed screen sits on the canvas (top-left origin). */
export function screenRect(canvas: Size, source: Size, padding: number): Rect {
  const margin = padding * Math.min(canvas.width, canvas.height);
  const aw = canvas.width - 2 * margin, ah = canvas.height - 2 * margin;
  const k = Math.min(aw / source.width, ah / source.height);
  const w = source.width * k, h = source.height * k;
  return { x: (canvas.width - w) / 2, y: (canvas.height - h) / 2, width: w, height: h };
}

export function cursorPosition(track: CursorTrack, t: number): { x: number; y: number } | null {
  const s = track.samples;
  if (!s.length) return null;
  if (t <= s[0].t) return { x: s[0].x, y: s[0].y };
  const last = s[s.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].t <= t) lo = mid; else hi = mid; }
  const a = s[lo], b = s[hi];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
