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
      drawCursorImage(ctx, at, pointScale, style.cursorStyle, style.cursorColor);
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

const cursorImage: { key: string; canvas: OffscreenCanvas | null } = { key: '', canvas: null };

/**
 * The cursor art for a frame: drawn on the CPU at its exact size and sub-pixel position, then copied
 * in pixel for pixel. Drawn directly, the GPU blurs the arrow's shadow in textures sized to fit, and
 * in the odd frame where one fits exactly it needs a pipeline of its own, which it then builds in
 * the middle of playback. A copied image always draws the same way.
 */
function drawCursorImage(ctx: Ctx, tip: { x: number; y: number }, scale: number, style: CursorStyle, color: RGBA) {
  // Room for the art and its shadow: the arrow reaches 17 points right of the tip and 25 below,
  // the dot 12 around it.
  const left = Math.ceil(12 * scale) + 2, top = left;
  const width = left + Math.ceil(17 * scale) + 2, height = top + Math.ceil(25 * scale) + 2;
  const x = Math.floor(tip.x) - left, y = Math.floor(tip.y) - top;
  const probe: unknown = ctx;
  if (probe instanceof KindProbe) { probe.copy('cursor', x, y, width, height); return; }
  const fx = tip.x - Math.floor(tip.x), fy = tip.y - Math.floor(tip.y);
  const key = `${style} ${css(color)} ${scale} ${fx} ${fy}`;
  if (cursorImage.key !== key || !cursorImage.canvas) {
    const c = cursorImage.canvas ??= new OffscreenCanvas(width, height);
    if (c.width !== width || c.height !== height) { c.width = width; c.height = height; }
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, width, height);
    drawCursor(g, { x: left + fx, y: top + fy }, scale, style, color);
    cursorImage.key = key;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cursorImage.canvas, x, y);
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

/**
 * What a frame is drawn with — shapes, paints, blur sizes, image scaling, opacity, clips — but not
 * where. Chromium's GPU canvas builds a pipeline the first time it meets a new kind of drawing, and
 * the window presents nothing until it's ready: well under a millisecond normally, 100–350 ms when
 * the machine is busy or the system's shader cache is cold. Frames of the same kind need the same
 * pipelines, so the player draws one frame of each kind before playback needs it.
 */
export function frameKind(canvas: Size, srcSize: Size, data: ClipRenderData, t: number, camera: Size | null): string {
  const probe = new KindProbe(canvas);
  drawFrame(probe as unknown as Ctx, canvas, probe.image('screen', srcSize), srcSize, data, t,
    camera ? { draw: probe.image('camera', camera), size: camera } : null);
  return probe.kinds.join(' ');
}

/** A piece of a path in canvas pixels (bounds, and a rounded rect's corner radius). */
interface Piece { kind: string; x0: number; y0: number; x1: number; y1: number; r: number }

/** Stands in for a 2D context and writes down the kind of each drawing (see frameKind). */
class KindProbe {
  readonly kinds: string[] = [];
  private shape: Piece[] = [];
  // drawFrame only translates, scales and mirrors, so a, d, e, f is all of its transform.
  private s = { a: 1, d: 1, e: 0, f: 0, alpha: 1, blur: 0, offset: 0, shadow: false, fill: 'color', stroke: 'color', line: 1, clip: '' };
  private stack: (typeof this.s)[] = [];
  private canvas: Size;
  constructor(canvas: Size) { this.canvas = canvas; }

  save() { this.stack.push({ ...this.s }); }
  restore() { this.s = this.stack.pop() ?? this.s; }
  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number) { Object.assign(this.s, { a, d, e, f }); }
  translate(x: number, y: number) { this.s.e += this.s.a * x; this.s.f += this.s.d * y; }
  scale(x: number, y: number) { this.s.a *= x; this.s.d *= y; }
  set globalAlpha(a: number) { this.s.alpha = a; }
  set shadowBlur(b: number) { this.s.blur = b; }
  set shadowOffsetY(o: number) { this.s.offset = o; }
  set shadowColor(c: string) { this.s.shadow = c !== 'transparent' && !/,\s*0(\.0*)?\)$/.test(c); }
  set fillStyle(p: string | { kind: string }) { this.s.fill = typeof p === 'string' ? 'color' : p.kind; }
  set strokeStyle(p: string | { kind: string }) { this.s.stroke = typeof p === 'string' ? 'color' : p.kind; }
  set lineWidth(w: number) { this.s.line = w; }
  set lineJoin(_: string) {}
  set imageSmoothingEnabled(_: boolean) {}
  set imageSmoothingQuality(_: string) {}
  createLinearGradient() { return { kind: 'linear', addColorStop() {} }; }
  createRadialGradient() { return { kind: 'radial', addColorStop() {} }; }

  beginPath() { this.shape = []; }
  roundRect(x: number, y: number, w: number, h: number, r: number) { this.shape.push(this.piece(r > 0 ? 'rrect' : 'rect', x, y, x + w, y + h, Math.min(r, w / 2, h / 2))); }
  arc(x: number, y: number, r: number) { this.shape.push(this.piece('arc', x - r, y - r, x + r, y + r, 0)); }
  moveTo(x: number, y: number) { this.shape.push(this.piece('path', x, y, x, y, 0)); }
  lineTo(x: number, y: number) {
    const last = this.shape[this.shape.length - 1], p = this.piece('', x, y, x, y, 0);
    if (last) Object.assign(last, { x0: Math.min(last.x0, p.x0), y0: Math.min(last.y0, p.y0), x1: Math.max(last.x1, p.x1), y1: Math.max(last.y1, p.y1) });
  }
  closePath() {}
  clip() { this.s.clip += `[${this.describe(0)}]`; }
  fill() { this.add(`fill(${this.describe(this.spread())})`, this.s.fill); }
  stroke() {
    const hairline = Math.abs(this.s.line * this.s.a) < 1 ? ' hairline' : '';
    this.add(`stroke(${this.describe(this.spread() + Math.abs(this.s.line * this.s.a) / 2)}${hairline})`, this.s.stroke);
  }
  fillRect(x: number, y: number, w: number, h: number) { this.add(`fill(${this.where(this.piece('rect', x, y, x + w, y + h, 0), this.spread())})`, this.s.fill); }
  drawImage() { this.add('background', ''); }
  /** Stands in for copying an image made on the CPU (the cursor) in at whole pixels. */
  copy(name: string, x: number, y: number, w: number, h: number) { this.add(`${name}(${this.where(this.piece('', x, y, x + w, y + h, 0), 0)})`, ''); }
  /** Stands in for drawing a video frame: scaled up or down, and where. */
  image(name: string, size: Size): DrawSource {
    return (_c, x, y, w, h) => {
      const p = this.piece('', x, y, x + w, y + h, 0);
      this.add(`${name}(${p.x1 - p.x0 > size.width ? 'up' : 'down'} ${this.where(p, 0)})`, '');
    };
  }

  private piece(kind: string, x0: number, y0: number, x1: number, y1: number, r: number): Piece {
    const { a, d, e, f } = this.s;
    const X = [a * x0 + e, a * x1 + e], Y = [d * y0 + f, d * y1 + f];
    return { kind, x0: Math.min(...X), x1: Math.max(...X), y0: Math.min(...Y), y1: Math.max(...Y), r: r * Math.abs(a) };
  }

  /** How far a shadow reaches past the shape. */
  private spread() { const s = this.s; return s.shadow && s.blur > 0 ? s.blur * 1.5 + Math.abs(s.offset) : 0; }

  private describe(spread: number) { return this.shape.map((p) => `${p.kind} ${this.where(p, spread)}`).join('+'); }

  /**
   * Where a piece lies: covering the canvas, inside it or crossing its edges; whether the edges
   * that show fall between pixels (anti-aliased) and rounded corners show; and, when it is blurred
   * or masked, its size class (masks are drawn into textures of a few sizes).
   */
  private where(p: Piece, spread: number) {
    const { width: W, height: H } = this.canvas;
    const x0 = p.x0 - spread, y0 = p.y0 - spread, x1 = p.x1 + spread, y1 = p.y1 + spread, r = p.r;
    const size = this.spread() > 0 || p.kind === 'rrect' ? ` ${Math.round(Math.log2(Math.max(1, x1 - x0, y1 - y0)) * 2)}` : '';
    // A canvas corner is covered unless it falls in the rounded-off part of a corner.
    const covered = (px: number, py: number) =>
      Math.hypot(px - Math.min(Math.max(px, x0 + r), x1 - r), py - Math.min(Math.max(py, y0 + r), y1 - r)) <= r;
    if (x0 <= 0 && y0 <= 0 && x1 >= W && y1 >= H && covered(0, 0) && covered(W, 0) && covered(0, H) && covered(W, H)) return 'covers' + size;
    const showsBetween = (v: number, end: number) => v > 0 && v < end && Math.abs(v - Math.round(v)) > 1e-3;
    const aa = showsBetween(x0, W) || showsBetween(x1, W) || showsBetween(y0, H) || showsBetween(y1, H) ? ' aa' : '';
    const corners = r > 0 && [[x0, y0], [x1 - r, y0], [x0, y1 - r], [x1 - r, y1 - r]].some(([cx, cy]) => cx < W && cx + r > 0 && cy < H && cy + r > 0) ? ' corners' : '';
    return (x0 >= 0 && y0 >= 0 && x1 <= W && y1 <= H ? 'inside' : 'crosses') + aa + corners + size;
  }

  private add(op: string, paint: string) {
    const s = this.s;
    // Shadows are blurred with kernels of radius 3σ (σ = blur / 2), larger ones at a reduced scale:
    // a kind per scale and radius.
    let sigma = s.blur / 2, scale = 0;
    while (sigma > 4) { sigma /= 2; scale++; }
    const blur = s.shadow && s.blur > 0 ? ` blur${scale}:${Math.ceil(3 * sigma - 1e-9)}` : '';
    this.kinds.push(`${op}${paint && ' ' + paint}${s.alpha < 1 ? ' translucent' : ''}${blur}${s.clip && ' clip' + s.clip}`);
  }
}
