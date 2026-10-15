import { type Clip, type CursorStyle, type CursorTrack, type MediaAsset, type RGBA, type Size, type StyleSettings, screenRect, toLocal } from '../core/model.ts';
import { type CameraBox, type CameraSpan, baseLayout, cameraBoxAt, layoutBox } from '../core/cameraLayout.ts';
import { type MagnifierSettings, type MagnifierSpan, magnifierAt } from '../core/magnifier.ts';
import { CameraTimeline } from '../core/zoom.ts';
import { imageCanvas, themeCanvas } from './themes.ts';

// The single frame renderer. The live preview and the exporter both call drawFrame with the
// same inputs, which is what keeps the exported video identical to what the editor shows.

export interface ClipRenderData {
  clip: Clip;
  asset: MediaAsset;
  timeline: CameraTimeline;
  style: StyleSettings;
  /** Decoded user background image (when the style uses one). */
  backgroundImage?: ImageBitmap | null;
  /** Where this clip starts on the timeline, and the project's camera layout track (timeline seconds). */
  timelineStart?: number;
  cameraSpans?: CameraSpan[];
  magnifierSpans?: MagnifierSpan[];
}

export function makeRenderData(clip: Clip, asset: MediaAsset, track: CursorTrack | null, style: StyleSettings): ClipRenderData {
  const timeline = new CameraTimeline(asset.kind === 'screenRecording' ? track : null, clip.zooms,
    { width: asset.pixelWidth, height: asset.pixelHeight }, asset.duration, style.zoomSpeed, style.smoothCursor);
  return { clip, asset, timeline, style };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type DrawSource = (ctx: Ctx, x: number, y: number, w: number, h: number) => void;
export interface Overlay { draw: DrawSource; size: Size }

export const RIPPLE_DURATION = 0.45;
const IDLE_AFTER = 1.5, IDLE_FADE = 0.35;
const css = (c: RGBA, alpha = c.a) =>
  `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${alpha})`;

export function drawBackground(ctx: Ctx, canvas: Size, style: StyleSettings, image?: ImageBitmap | null) {
  if (style.backgroundKind === 'theme') {
    ctx.drawImage(themeCanvas(style.backgroundTheme, canvas.width, canvas.height), 0, 0);
    return;
  }
  if (style.backgroundKind === 'image' && image) {
    ctx.drawImage(imageCanvas(image, canvas.width, canvas.height, style.backgroundBlur), 0, 0);
    return;
  }
  const g = ctx.createLinearGradient(0, 0, canvas.width * 0.35, canvas.height);
  g.addColorStop(0, css(style.backgroundTop));
  g.addColorStop(1, css(style.backgroundBottom));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/**
 * @param source  draws the decoded screen frame into a rect, or null when no frame is available
 * @param srcSize size of the decoded screen frame
 * @param t       seconds into the clip's media
 * @param camera  the webcam frame at the same time, if the recording has one
 */
export function drawFrame(ctx: Ctx, canvas: Size, source: DrawSource | null, srcSize: Size, data: ClipRenderData, t: number,
                          camera: Overlay | null = null) {
  const style = data.style;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawBackground(ctx, canvas, style, data.backgroundImage);
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
  // Magnifier: a lens over the cursor showing the screen under it larger (drawn under the cursor).
  if (p && data.asset.kind === 'screenRecording' && data.magnifierSpans?.length) {
    const lens = magnifierAt(data.magnifierSpans, (data.timelineStart ?? 0) + toLocal(data.clip, t));
    if (lens) {
      const c = { x: r.x + (p.x / data.asset.pixelWidth) * w, y: r.y + (p.y / data.asset.pixelHeight) * h };
      drawMagnifier(ctx, canvas, source, r, c, lens.settings, lens.open);
    }
  }
  if (style.showCursor && data.asset.kind === 'screenRecording' && p) {
    const ax = data.asset.pixelWidth, ay = data.asset.pixelHeight;
    const toCanvas = (x: number, y: number) => ({ x: r.x + (x / ax) * w, y: r.y + (y / ay) * h });
    // Cursor art is sized in points of the recorded display, then follows the zoom.
    const pointScale = data.asset.pixelsPerPoint * (w / ax) * style.cursorScale;
    if (style.clickRipple) {
      for (const c of data.timeline.downClicks) {
        if (c.t > t || t - c.t >= RIPPLE_DURATION) continue;
        drawClick(ctx, toCanvas(c.x, c.y), (t - c.t) / RIPPLE_DURATION, pointScale, style);
      }
    }
    let alpha = 1;
    if (style.hideIdleCursor) {
      const idle = data.timeline.idleFor(t);
      alpha = idle <= IDLE_AFTER ? 1 : Math.max(0, 1 - (idle - IDLE_AFTER) / IDLE_FADE);
    }
    if (alpha > 0.001) {
      ctx.save();
      ctx.globalAlpha = alpha;
      const at = toCanvas(p.x, p.y);
      if (style.cursorHighlight) {
        const rad = 20 * pointScale;
        const g = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, rad);
        g.addColorStop(0, css(style.cursorColor, 0.42)); g.addColorStop(0.7, css(style.cursorColor, 0.22)); g.addColorStop(1, css(style.cursorColor, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(at.x, at.y, rad, 0, Math.PI * 2); ctx.fill();
      }
      drawCursor(ctx, at, pointScale, style.cursorStyle, style.cursorColor);
      ctx.restore();
    }
  }

  if (camera) {
    const box = cameraBoxAt(canvas, style.camera, data.cameraSpans ?? [], (data.timelineStart ?? 0) + toLocal(data.clip, t));
    if (box.alpha > 0.002) drawCamera(ctx, canvas, camera, style, box);
  }
  ctx.restore();
}

function drawClick(ctx: Ctx, at: { x: number; y: number }, age: number, pointScale: number, style: StyleSettings) {
  const eased = 1 - Math.pow(1 - age, 3);
  const size = (10 + 26 * eased) * pointScale;
  if (style.clickStyle === 'pulse') {
    ctx.fillStyle = css(style.cursorColor, 0.45 * (1 - age));
    ctx.beginPath(); ctx.arc(at.x, at.y, size * 0.5, 0, Math.PI * 2); ctx.fill();
    return;
  }
  const alpha = 0.9 * (1 - age);
  const rad = size * 0.4297;
  ctx.beginPath(); ctx.arc(at.x, at.y, rad, 0, Math.PI * 2);
  ctx.lineWidth = size * (22 / 256); ctx.strokeStyle = `rgba(0, 0, 0, ${0.35 * alpha})`; ctx.stroke();
  ctx.lineWidth = size * (12 / 256); ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`; ctx.stroke();
}

/** Our own cursor artwork, in points with the tip at (3, 3). */
const ARROW: [number, number][] = [[3, 3], [3, 21], [7.6, 16.9], [10.6, 23.4], [13.4, 22.1], [10.5, 15.8], [16.4, 15.8]];

export function drawCursor(ctx: Ctx, tip: { x: number; y: number }, scale: number, style: CursorStyle, color: RGBA) {
  ctx.save();
  ctx.translate(tip.x, tip.y);
  ctx.scale(scale, scale);
  if (style === 'dot') {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'; ctx.shadowBlur = 3 * scale; ctx.shadowOffsetY = 0.8 * scale;
    ctx.beginPath(); ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = css(color, 1); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.translate(-3, -3);
  ctx.beginPath();
  ARROW.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  const fill = style === 'arrow-dark' ? 'rgb(20, 20, 20)' : style === 'arrow-color' ? css(color, 1) : '#fff';
  const stroke = style === 'arrow' ? 'rgb(20, 20, 20)' : '#fff';
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 2.2 * scale;
  ctx.shadowOffsetY = 0.8 * scale;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

/** Where the camera bubble goes with the project's camera settings. */
export function cameraRect(canvas: Size, style: StyleSettings): { x: number; y: number; width: number; height: number } {
  const b = layoutBox(canvas, { ...baseLayout(style.camera), mode: 'bubble' }, style.camera.shape);
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/**
 * The lens: the screen drawn again, `zoom` times larger around the cursor, inside a circle or a
 * rounded square that grows from nothing as `open` goes 0 → 1 (slightly past 1 when it pops open).
 */
function drawMagnifier(ctx: Ctx, canvas: Size, source: DrawSource, r: { x: number; y: number; width: number; height: number },
                       c: { x: number; y: number }, s: MagnifierSettings, open: number) {
  const unit = Math.min(canvas.width, canvas.height);
  const R = ((unit * s.size) / 2) * open;
  if (R < 1) return;
  const zoom = 1 + (s.zoom - 1) * Math.min(1, open);
  const path = () => {
    ctx.beginPath();
    if (s.shape === 'circle') ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    else ctx.roundRect(c.x - R, c.y - R, 2 * R, 2 * R, R * 0.3);
  };
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'; ctx.shadowBlur = unit * 0.035; ctx.shadowOffsetY = unit * 0.01;
  ctx.fillStyle = '#16161c'; path(); ctx.fill();
  ctx.restore();
  ctx.save();
  path(); ctx.clip();
  source(ctx, c.x + (r.x - c.x) * zoom, c.y + (r.y - c.y) * zoom, r.width * zoom, r.height * zoom);
  const sheen = ctx.createLinearGradient(0, c.y - R, 0, c.y + R);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.16)'); sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen; ctx.fillRect(c.x - R, c.y - R, 2 * R, 2 * R);
  ctx.restore();
  ctx.save();
  ctx.lineWidth = Math.max(1.5, unit * 0.005); ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  path(); ctx.stroke();
  ctx.restore();
}

/** Draws the webcam into its box (a circle is a square box with half-height corners). */
function drawCamera(ctx: Ctx, canvas: Size, cam: Overlay, style: StyleSettings, box: CameraBox) {
  const c = style.camera;
  const path = () => {
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, Math.max(0, Math.min(box.radius, box.width / 2, box.height / 2)));
  };
  const unit = Math.min(canvas.width, canvas.height);
  ctx.save();
  ctx.globalAlpha = box.alpha;
  if (box.frame > 0.01) {
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${0.45 * box.frame})`; ctx.shadowBlur = unit * 0.03; ctx.shadowOffsetY = unit * 0.006;
    ctx.fillStyle = '#000'; path(); ctx.fill();
    ctx.restore();
  }

  ctx.save();
  path(); ctx.clip();
  // Cover: scale the frame to fill the box and crop the overflow.
  const k = Math.max(box.width / cam.size.width, box.height / cam.size.height);
  const dw = cam.size.width * k, dh = cam.size.height * k;
  const dx = box.x + (box.width - dw) / 2, dy = box.y + (box.height - dh) / 2;
  if (c.mirror) {
    ctx.translate(box.x + box.width / 2, 0); ctx.scale(-1, 1); ctx.translate(-(box.x + box.width / 2), 0);
  }
  cam.draw(ctx, dx, dy, dw, dh);
  ctx.restore();

  if (c.border && box.frame > 0.01) {
    ctx.save();
    ctx.lineWidth = unit * 0.006; ctx.strokeStyle = `rgba(255, 255, 255, ${0.95 * box.frame})`;
    path(); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
