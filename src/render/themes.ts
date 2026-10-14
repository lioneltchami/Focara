// Background themes, drawn procedurally (our own artwork, no image assets). Every theme uses a
// fixed-seed random generator, so it renders identically in the preview and in the export.

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Theme { id: string; title: string; emoji: string; draw: (ctx: Ctx, w: number, h: number) => void }

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)];

function gradient(ctx: Ctx, w: number, h: number, stops: string[], x1 = 0.35, vertical = false) {
  const g = vertical ? ctx.createLinearGradient(0, 0, 0, h) : ctx.createLinearGradient(0, 0, w * x1, h);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function glow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color.replace('ALPHA', String(alpha)));
  g.addColorStop(1, color.replace('ALPHA', '0'));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function star(ctx: Ctx, x: number, y: number, r: number, points = 5, inner = 0.45) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI * i) / points - Math.PI / 2, rr = i % 2 ? r * inner : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function snowflake(ctx: Ctx, x: number, y: number, r: number, rot: number) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1, r * 0.12);
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -r);
    ctx.moveTo(0, -r * 0.55); ctx.lineTo(-r * 0.25, -r * 0.78);
    ctx.moveTo(0, -r * 0.55); ctx.lineTo(r * 0.25, -r * 0.78);
    ctx.stroke();
  }
  ctx.restore();
}

function leaf(ctx: Ctx, x: number, y: number, s: number, rot: number, color: string) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.bezierCurveTo(s * 0.75, -s * 0.55, s * 0.6, s * 0.45, 0, s);
  ctx.bezierCurveTo(-s * 0.6, s * 0.45, -s * 0.75, -s * 0.55, 0, -s);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = 'rgba(80, 30, 10, 0.45)'; ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.beginPath(); ctx.moveTo(0, -s * 0.9); ctx.lineTo(0, s * 1.25); ctx.stroke();
  for (const k of [-0.4, 0, 0.4]) {
    ctx.beginPath(); ctx.moveTo(0, s * k); ctx.lineTo(s * 0.38, s * (k - 0.3)); ctx.moveTo(0, s * k); ctx.lineTo(-s * 0.38, s * (k - 0.3)); ctx.stroke();
  }
  ctx.restore();
}

function flower(ctx: Ctx, x: number, y: number, r: number, rot: number, color: string) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = color;
  for (let i = 0; i < 5; i++) {
    ctx.rotate((Math.PI * 2) / 5);
    ctx.beginPath(); ctx.ellipse(0, -r * 0.55, r * 0.38, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(255, 214, 102, 0.95)';
  ctx.beginPath(); ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function tree(ctx: Ctx, x: number, base: number, hgt: number) {
  const w = hgt * 0.62;
  ctx.fillStyle = '#4a2f1b';
  ctx.fillRect(x - hgt * 0.05, base - hgt * 0.12, hgt * 0.1, hgt * 0.12);
  const greens = ['#0f5132', '#146c43', '#198754'];
  for (let i = 0; i < 3; i++) {
    const top = base - hgt * (0.42 + i * 0.27), bottom = base - hgt * (0.1 + i * 0.25), width = w * (1 - i * 0.24);
    ctx.fillStyle = greens[i];
    ctx.beginPath(); ctx.moveTo(x, top - hgt * 0.12); ctx.lineTo(x + width / 2, bottom); ctx.lineTo(x - width / 2, bottom); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#ffd23f'; star(ctx, x, base - hgt * 1.08, hgt * 0.08); ctx.fill();
}

function balloon(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = Math.max(1, r * 0.04);
  ctx.beginPath(); ctx.moveTo(x, y + r * 1.15);
  ctx.bezierCurveTo(x - r * 0.3, y + r * 1.8, x + r * 0.3, y + r * 2.4, x, y + r * 3.2); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(x, y, r * 0.85, r * 1.05, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - r * 0.12, y + r * 1.02); ctx.lineTo(x + r * 0.12, y + r * 1.02); ctx.lineTo(x, y + r * 1.18); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.ellipse(x - r * 0.3, y - r * 0.4, r * 0.18, r * 0.3, -0.5, 0, Math.PI * 2); ctx.fill();
}

export const themes: Theme[] = [
  {
    id: 'eglenceli', title: 'Eğlenceli', emoji: '🎈',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#ff5fa2', '#ff9a5a', '#ffd84d']);
      const r = rng(7), m = Math.min(w, h);
      const colors = ['#ffffff', '#6c5ce7', '#00c2a8', '#ff2e63', '#ffe66d', '#3ec7ff'];
      for (let i = 0; i < 70; i++) {
        const x = r() * w, y = r() * h, s = m * (0.012 + r() * 0.05), c = pick(r, colors), kind = r();
        ctx.globalAlpha = 0.55 + r() * 0.4;
        if (kind < 0.3) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill(); }
        else if (kind < 0.5) { ctx.strokeStyle = c; ctx.lineWidth = s * 0.35; ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.stroke(); }
        else if (kind < 0.75) {
          ctx.strokeStyle = c; ctx.lineWidth = s * 0.3; ctx.lineCap = 'round'; ctx.beginPath();
          const rot = r() * Math.PI;
          for (let k = 0; k <= 24; k++) {
            const u = (k / 24 - 0.5) * s * 4, v = Math.sin((k / 24) * Math.PI * 3) * s * 0.5;
            const px = x + u * Math.cos(rot) - v * Math.sin(rot), py = y + u * Math.sin(rot) + v * Math.cos(rot);
            k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle = c; ctx.save(); ctx.translate(x, y); ctx.rotate(r() * Math.PI * 2);
          ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.9, s * 0.7); ctx.lineTo(-s * 0.9, s * 0.7); ctx.closePath(); ctx.fill(); ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
    },
  },
  {
    id: 'yilbasi', title: 'Yılbaşı', emoji: '🎄',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#0b1d3a', '#17325a', '#123d33'], 0, true);
      const r = rng(2026), m = Math.min(w, h);
      for (let i = 0; i < 160; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.6})`;
        ctx.beginPath(); ctx.arc(r() * w, r() * h * 0.8, m * (0.0012 + r() * 0.0025), 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 45; i++) { ctx.globalAlpha = 0.35 + r() * 0.55; snowflake(ctx, r() * w, r() * h, m * (0.008 + r() * 0.022), r() * Math.PI); }
      ctx.globalAlpha = 1;
      // String lights along the top.
      const bulbs = ['#ff4d4d', '#ffd23f', '#3ddc84', '#4dabff', '#ff8cf0'];
      for (const [y0, sag, phase] of [[h * 0.035, h * 0.06, 0], [h * 0.02, h * 0.1, 0.5]] as const) {
        ctx.strokeStyle = 'rgba(30,40,30,0.9)'; ctx.lineWidth = Math.max(1, m * 0.002);
        ctx.beginPath();
        for (let k = 0; k <= 60; k++) { const u = k / 60; const y = y0 + sag * Math.sin(Math.PI * ((u * 3 + phase) % 1)); k ? ctx.lineTo(u * w, y) : ctx.moveTo(0, y); }
        ctx.stroke();
        for (let k = 0; k < 24; k++) {
          const u = (k + 0.5 + phase) / 24, x = u * w, y = y0 + sag * Math.sin(Math.PI * ((u * 3 + phase) % 1)) + m * 0.008;
          const c = bulbs[k % bulbs.length];
          glow(ctx, x, y, m * 0.03, hexToRgba(c), 0.45);
          ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(x, y, m * 0.006, m * 0.009, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Snowy ground and trees at the bottom corners.
      ctx.fillStyle = '#eef6ff';
      ctx.beginPath(); ctx.moveTo(0, h);
      for (let k = 0; k <= 40; k++) ctx.lineTo((k / 40) * w, h - h * 0.05 - Math.sin(k * 0.7) * h * 0.012);
      ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
      for (const [x, s] of [[w * 0.04, 0.3], [w * 0.11, 0.22], [w * 0.9, 0.26], [w * 0.965, 0.34]] as const) tree(ctx, x, h - h * 0.04, h * s);
    },
  },
  {
    id: 'sonbahar', title: 'Sonbahar', emoji: '🍂',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#ffd27a', '#f39a4c', '#a8452a']);
      const r = rng(1023), m = Math.min(w, h);
      glow(ctx, w * 0.85, h * 0.12, m * 0.5, 'rgba(255,240,200,ALPHA)', 0.55);
      const colors = ['#d35400', '#e67e22', '#c0392b', '#f1c40f', '#a04000', '#f39c12', '#8b3a1a'];
      for (let i = 0; i < 55; i++) leaf(ctx, r() * w, r() * h, m * (0.022 + r() * 0.035), r() * Math.PI * 2, pick(r, colors));
    },
  },
  {
    id: 'kutlama', title: 'Kutlama', emoji: '🎉',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#3a1c71', '#d76d77', '#ffaf7b']);
      const r = rng(99), m = Math.min(w, h);
      const colors = ['#ffd23f', '#ff4d6d', '#4dd4ff', '#7bff8a', '#ffffff', '#b388ff'];
      for (let i = 0; i < 10; i++) {
        ctx.strokeStyle = pick(r, colors); ctx.globalAlpha = 0.7; ctx.lineWidth = m * 0.006; ctx.lineCap = 'round';
        const y0 = r() * h, amp = m * (0.02 + r() * 0.04), freq = 2 + r() * 4;
        ctx.beginPath();
        for (let k = 0; k <= 80; k++) { const u = k / 80; const y = y0 + Math.sin(u * Math.PI * freq + i) * amp; k ? ctx.lineTo(u * w, y) : ctx.moveTo(0, y); }
        ctx.stroke();
      }
      for (let i = 0; i < 220; i++) {
        ctx.globalAlpha = 0.7 + r() * 0.3; ctx.fillStyle = pick(r, colors);
        const x = r() * w, y = r() * h, s = m * (0.004 + r() * 0.01);
        ctx.save(); ctx.translate(x, y); ctx.rotate(r() * Math.PI);
        if (r() < 0.6) ctx.fillRect(-s, -s * 0.45, s * 2, s * 0.9); else { ctx.beginPath(); ctx.arc(0, 0, s * 0.7, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffe680';
      for (let i = 0; i < 18; i++) { star(ctx, r() * w, r() * h, m * (0.008 + r() * 0.014), 4, 0.35); ctx.fill(); }
      const bc = ['#ff4d6d', '#ffd23f', '#4dd4ff', '#b388ff', '#7bff8a'];
      [[0.05, 0.2], [0.1, 0.33], [0.03, 0.55], [0.94, 0.18], [0.89, 0.36], [0.96, 0.6]].forEach(([fx, fy], i) =>
        balloon(ctx, w * fx, h * fy, m * 0.045, bc[i % bc.length]));
    },
  },
  {
    id: 'bahar', title: 'Bahar', emoji: '🌸',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#d7f5e9', '#f9e1f0', '#ffd6e5']);
      const r = rng(321), m = Math.min(w, h);
      for (let i = 0; i < 14; i++) { ctx.globalAlpha = 0.25; ctx.fillStyle = pick(r, ['#ffffff', '#c8f2dc', '#ffc4dd']); ctx.beginPath(); ctx.arc(r() * w, r() * h, m * (0.05 + r() * 0.12), 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
      for (let i = 0; i < 50; i++) { ctx.globalAlpha = 0.7 + r() * 0.3; flower(ctx, r() * w, r() * h, m * (0.012 + r() * 0.026), r() * Math.PI, pick(r, ['#ff8fb8', '#ffb3cf', '#ffffff', '#f7a1c4'])); }
      ctx.globalAlpha = 1;
    },
  },
  {
    id: 'uzay', title: 'Uzay', emoji: '🪐',
    draw(ctx, w, h) {
      const g = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
      g.addColorStop(0, '#1d1b4b'); g.addColorStop(1, '#05050f');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      const r = rng(4242), m = Math.min(w, h);
      glow(ctx, w * 0.2, h * 0.75, m * 0.6, 'rgba(155,89,255,ALPHA)', 0.35);
      glow(ctx, w * 0.85, h * 0.25, m * 0.5, 'rgba(0,200,255,ALPHA)', 0.25);
      for (let i = 0; i < 380; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.75})`;
        ctx.beginPath(); ctx.arc(r() * w, r() * h, m * (0.0008 + r() * r() * 0.004), 0, Math.PI * 2); ctx.fill();
      }
      const px = w * 0.1, py = h * 0.16, pr = m * 0.09;
      const pg = ctx.createLinearGradient(px - pr, py - pr, px + pr, py + pr);
      pg.addColorStop(0, '#ffb86b'); pg.addColorStop(1, '#c0392b');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,220,180,0.75)'; ctx.lineWidth = m * 0.008;
      ctx.beginPath(); ctx.ellipse(px, py, pr * 1.8, pr * 0.45, -0.35, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#d9dce8'; ctx.beginPath(); ctx.arc(w * 0.92, h * 0.85, m * 0.04, 0, Math.PI * 2); ctx.fill();
    },
  },
  {
    id: 'okyanus', title: 'Okyanus', emoji: '🌊',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#7fdcf0', '#2a9fc4', '#0b4a6e'], 0, true);
      const r = rng(77), m = Math.min(w, h);
      const waves = ['rgba(255,255,255,0.18)', 'rgba(20,120,170,0.45)', 'rgba(10,80,130,0.55)', 'rgba(5,50,90,0.65)'];
      waves.forEach((c, i) => {
        const base = h * (0.55 + i * 0.12), amp = h * 0.025, f = 2.5 + i;
        ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(0, h);
        for (let k = 0; k <= 80; k++) { const u = k / 80; ctx.lineTo(u * w, base + Math.sin(u * Math.PI * f + i * 1.7) * amp); }
        ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
      });
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      for (let i = 0; i < 40; i++) { ctx.lineWidth = Math.max(1, m * 0.002); ctx.beginPath(); ctx.arc(r() * w, h * 0.3 + r() * h * 0.7, m * (0.004 + r() * 0.012), 0, Math.PI * 2); ctx.stroke(); }
    },
  },
  {
    id: 'minimal', title: 'Sade açık', emoji: '⬜️',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#f7f7fa', '#e6e7ee']);
      const m = Math.min(w, h), step = m * 0.035;
      ctx.fillStyle = 'rgba(0,0,0,0.07)';
      for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) { ctx.beginPath(); ctx.arc(x, y, m * 0.0018, 0, Math.PI * 2); ctx.fill(); }
    },
  },
  {
    id: 'gece', title: 'Sade koyu', emoji: '⬛️',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#1d1d24', '#2c2c38']);
      const m = Math.min(w, h), step = m * 0.035;
      glow(ctx, w * 0.5, h * 0.45, m * 0.7, 'rgba(123,108,255,ALPHA)', 0.18);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) { ctx.beginPath(); ctx.arc(x, y, m * 0.0018, 0, Math.PI * 2); ctx.fill(); }
    },
  },
];

function hexToRgba(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},ALPHA)`;
}

/** Ready-made colour gradients for the "Renk" background mode. */
export const gradientPresets: { title: string; top: string; bottom: string }[] = [
  { title: 'Gece', top: '#333d6b', bottom: '#87548c' },
  { title: 'Okyanus', top: '#1e9ad6', bottom: '#2d3a8c' },
  { title: 'Gün batımı', top: '#ff7e5f', bottom: '#feb47b' },
  { title: 'Orman', top: '#134e5e', bottom: '#71b280' },
  { title: 'Şeker', top: '#ff6fb5', bottom: '#7b6cff' },
  { title: 'Kömür', top: '#232526', bottom: '#414345' },
  { title: 'Lavanta', top: '#b8a9ff', bottom: '#f3c4fb' },
  { title: 'Nane', top: '#b2f5ea', bottom: '#38b2ac' },
];

const cache = new Map<string, OffscreenCanvas>();

/** The theme rendered at a given size (cached: themes are static). */
export function themeCanvas(id: string, w: number, h: number): OffscreenCanvas {
  const key = `${id}|${w}x${h}`;
  let c = cache.get(key);
  if (!c) {
    c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    (themes.find((t) => t.id === id) ?? themes[0]).draw(ctx, w, h);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    cache.set(key, c);
  }
  return c;
}

const imageCache = new WeakMap<object, Map<string, OffscreenCanvas>>();

/** A user image scaled to cover the canvas, optionally blurred (cached per size and blur). */
export function imageCanvas(img: ImageBitmap, w: number, h: number, blur: number): OffscreenCanvas {
  let m = imageCache.get(img);
  if (!m) { m = new Map(); imageCache.set(img, m); }
  const key = `${w}x${h}|${blur.toFixed(3)}`;
  let c = m.get(key);
  if (!c) {
    c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    const k = Math.max(w / img.width, h / img.height);
    const px = blur * Math.min(w, h) * 0.04;
    // Draw a little larger when blurring so the soft edges stay outside the canvas.
    const grow = px > 0 ? 1 + (4 * px) / Math.min(w, h) : 1;
    const dw = img.width * k * grow, dh = img.height * k * grow;
    if (px > 0) ctx.filter = `blur(${px}px)`;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    if (m.size > 6) m.delete(m.keys().next().value!);
    m.set(key, c);
  }
  return c;
}
