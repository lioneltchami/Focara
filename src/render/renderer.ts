import { type Clip, type CursorTrack, type MediaAsset, type RGBA, type Size, type StyleSettings, screenRect } from '../core/model.ts';
import { CameraTimeline } from '../core/zoom.ts';

// The single frame renderer. The live preview and the exporter both call drawFrame with the
// same inputs, which is what keeps the exported video identical to what the editor shows.

export interface ClipRenderData {
  clip: Clip;
  asset: MediaAsset;
  timeline: CameraTimeline;
  style: StyleSettings;
}

export function makeRenderData(clip: Clip, asset: MediaAsset, track: CursorTrack | null, style: StyleSettings): ClipRenderData {
  const timeline = new CameraTimeline(asset.kind === 'screenRecording' ? track : null, clip.zooms,
    { width: asset.pixelWidth, height: asset.pixelHeight }, asset.duration, style.zoomSpeed, style.smoothCursor);
  return { clip, asset, timeline, style };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type DrawSource = (ctx: Ctx, x: number, y: number, w: number, h: number) => void;

export const RIPPLE_DURATION = 0.45;
const css = (c: RGBA, alpha = c.a) =>
  `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${alpha})`;

export function drawBackground(ctx: Ctx, canvas: Size, style: StyleSettings) {
  const g = ctx.createLinearGradient(0, 0, canvas.width * 0.35, canvas.height);
  g.addColorStop(0, css(style.backgroundTop));
  g.addColorStop(1, css(style.backgroundBottom));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/**
 * @param source  draws the decoded source frame into a rect, or null when no frame is available
 * @param srcSize size of the decoded source frame
 * @param t       seconds into the clip's media
 */
export function drawFrame(ctx: Ctx, canvas: Size, source: DrawSource | null, srcSize: Size, data: ClipRenderData, t: number) {
  const style = data.style;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawBackground(ctx, canvas, style);
  if (!source) { ctx.restore(); return; }

  const base = screenRect(canvas, srcSize, style.padding);
  const cam = data.timeline.camera(t);
  const s = cam.scale;
  // Zoomed screen rect: the focus point sits at the screen centre; the timeline clamps the
  // focus so this rect always covers the unzoomed screen area.
  const w = base.width * s, h = base.height * s;
  const r = { x: base.x + base.width / 2 - cam.x * w, y: base.y + base.height / 2 - cam.y * h, width: w, height: h };
  const radius = Math.max(0, Math.min(style.cornerRadius * Math.min(base.width, base.height) * s, Math.min(w, h) / 2));

  if (style.shadow) {
    const strength = Math.max(0, 1 - (s - 1) * 1.5);
    if (strength > 0.01) {
      const blur = 0.025 * Math.min(base.width, base.height);
      ctx.save();
      ctx.shadowColor = `rgba(0, 0, 0, ${0.55 * strength})`;
      ctx.shadowBlur = blur * 2;
      ctx.shadowOffsetY = blur * 0.35;
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.roundRect(r.x, r.y, r.width, r.height, radius); ctx.fill();
      ctx.restore();
    }
  }

  ctx.save();
  ctx.beginPath(); ctx.roundRect(r.x, r.y, r.width, r.height, radius); ctx.clip();
  source(ctx, r.x, r.y, r.width, r.height);
  ctx.restore();

  const p = data.timeline.cursor(t);
  if (style.showCursor && data.asset.kind === 'screenRecording' && p) {
    const ax = data.asset.pixelWidth, ay = data.asset.pixelHeight;
    const toCanvas = (x: number, y: number) => ({ x: r.x + (x / ax) * w, y: r.y + (y / ay) * h });
    // Cursor art is sized in points of the recorded display, then follows the zoom.
    const pointScale = data.asset.pixelsPerPoint * (w / ax) * style.cursorScale;
    if (style.clickRipple) {
      for (const c of data.timeline.downClicks) {
        if (c.t > t || t - c.t >= RIPPLE_DURATION) continue;
        const age = (t - c.t) / RIPPLE_DURATION;
        const eased = 1 - Math.pow(1 - age, 3);
        const size = (10 + 26 * eased) * pointScale;
        const at = toCanvas(c.x, c.y);
        const alpha = 0.9 * (1 - age);
        const rad = size * 0.4297;
        ctx.beginPath(); ctx.arc(at.x, at.y, rad, 0, Math.PI * 2);
        ctx.lineWidth = size * (22 / 256); ctx.strokeStyle = `rgba(0, 0, 0, ${0.35 * alpha})`; ctx.stroke();
        ctx.lineWidth = size * (12 / 256); ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`; ctx.stroke();
      }
    }
    drawArrow(ctx, toCanvas(p.x, p.y), pointScale);
  }
  ctx.restore();
}

/** Our own cursor artwork, in points with the tip at (3, 3). */
const ARROW: [number, number][] = [[3, 3], [3, 21], [7.6, 16.9], [10.6, 23.4], [13.4, 22.1], [10.5, 15.8], [16.4, 15.8]];

function drawArrow(ctx: Ctx, tip: { x: number; y: number }, scale: number) {
  ctx.save();
  ctx.translate(tip.x, tip.y);
  ctx.scale(scale, scale);
  ctx.translate(-3, -3);
  ctx.beginPath();
  ARROW.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 2.2 * scale;
  ctx.shadowOffsetY = 0.8 * scale;
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = 'rgb(20, 20, 20)';
  ctx.stroke();
  ctx.restore();
}
