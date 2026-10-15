// Background themes, drawn procedurally (our own artwork, no image assets). Every theme uses a
// fixed-seed random generator, so it renders identically in the preview and in the export.

import { N } from '../i18n/index.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** `pro`: calm looks for business, product and teaching videos; `fun`: playful and seasonal. */
export type ThemeGroup = 'pro' | 'fun';
export interface Theme { id: string; title: string; emoji: string; group: ThemeGroup; draw: (ctx: Ctx, w: number, h: number) => void }

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

/** Fine film grain from a small noise tile (deterministic). */
function grain(ctx: Ctx, w: number, h: number, alpha: number, seed = 5) {
  // The tile lives where the canvas it fills does (thumbnails are drawn on the CPU): a thumbnail
  // filled from a GPU tile waits for the GPU to hand the pixels back, and a full-size background
  // filled from a CPU tile made the first frames of playback late.
  const size = 192, tile = new OffscreenCanvas(size, size), t = tile.getContext('2d', { willReadFrequently: onCpu.has(ctx) })!;
  const img = t.createImageData(size, size), r = rng(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = r() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = Math.round(r() * 255 * alpha);
  }
  t.putImageData(img, 0, 0);
  ctx.save(); ctx.fillStyle = ctx.createPattern(tile, 'repeat')!; ctx.fillRect(0, 0, w, h); ctx.restore();
}

/** Darker corners, to keep the eye in the middle. */
function vignette(ctx: Ctx, w: number, h: number, alpha: number) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${alpha})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

/** A soft round light (for mesh gradients and bokeh). */
function blob(ctx: Ctx, x: number, y: number, r: number, rgb: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`); g.addColorStop(0.55, `rgba(${rgb},${alpha * 0.45})`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

const line = (m: number, k: number) => Math.max(1, m * k);

export const themes: Theme[] = [
  {
    id: 'eglenceli', title: N('Eğlenceli'), emoji: '🎈', group: 'fun',
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
    id: 'yilbasi', title: N('Yılbaşı'), emoji: '🎄', group: 'fun',
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
    id: 'sonbahar', title: N('Sonbahar'), emoji: '🍂', group: 'fun',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#ffd27a', '#f39a4c', '#a8452a']);
      const r = rng(1023), m = Math.min(w, h);
      glow(ctx, w * 0.85, h * 0.12, m * 0.5, 'rgba(255,240,200,ALPHA)', 0.55);
      const colors = ['#d35400', '#e67e22', '#c0392b', '#f1c40f', '#a04000', '#f39c12', '#8b3a1a'];
      for (let i = 0; i < 55; i++) leaf(ctx, r() * w, r() * h, m * (0.022 + r() * 0.035), r() * Math.PI * 2, pick(r, colors));
    },
  },
  {
    id: 'kutlama', title: N('Kutlama'), emoji: '🎉', group: 'fun',
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
    id: 'bahar', title: N('Bahar'), emoji: '🌸', group: 'fun',
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
    id: 'uzay', title: N('Uzay'), emoji: '🪐', group: 'fun',
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
    id: 'okyanus', title: N('Okyanus'), emoji: '🌊', group: 'fun',
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
    id: 'minimal', title: N('Sade açık'), emoji: '⬜️', group: 'pro',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#f7f7fa', '#e6e7ee']);
      const m = Math.min(w, h), step = m * 0.035;
      ctx.fillStyle = 'rgba(0,0,0,0.07)';
      for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) { ctx.beginPath(); ctx.arc(x, y, m * 0.0018, 0, Math.PI * 2); ctx.fill(); }
    },
  },
  {
    id: 'gece', title: N('Sade koyu'), emoji: '⬛️', group: 'pro',
    draw(ctx, w, h) {
      gradient(ctx, w, h, ['#1d1d24', '#2c2c38']);
      const m = Math.min(w, h), step = m * 0.035;
      glow(ctx, w * 0.5, h * 0.45, m * 0.7, 'rgba(123,108,255,ALPHA)', 0.18);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) { ctx.beginPath(); ctx.arc(x, y, m * 0.0018, 0, Math.PI * 2); ctx.fill(); }
    },
  },
  // ---------------------------------------------------------------- professional
  {
    id: 'kurumsal', title: N('Kurumsal'), emoji: '🏢', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h);
      gradient(ctx, w, h, ['#0a1430', '#122852', '#0b1838'], 0.6);
      glow(ctx, w * 0.08, h * 0.05, m * 0.9, 'rgba(56,120,255,ALPHA)', 0.28);
      glow(ctx, w * 0.95, h * 1.05, m * 0.8, 'rgba(20,184,166,ALPHA)', 0.16);
      // Light beams from the top right.
      ctx.save(); ctx.translate(w * 1.02, -h * 0.08);
      for (const [a, wd, al] of [[2.05, 0.10, 0.10], [2.2, 0.05, 0.08], [2.36, 0.14, 0.07], [2.55, 0.06, 0.06]]) {
        ctx.save(); ctx.rotate(a);
        const g = ctx.createLinearGradient(0, 0, Math.hypot(w, h), 0);
        g.addColorStop(0, `rgba(150,190,255,${al})`); g.addColorStop(1, 'rgba(150,190,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, -m * wd / 2, Math.hypot(w, h), m * wd);
        ctx.restore();
      }
      ctx.restore();
      // Dot grid, fading towards the centre.
      const step = m * 0.03;
      for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) {
        const d = Math.min(1, Math.hypot((x - w * 0.12) / w, (y - h * 0.9) / h) * 2.2);
        const a = 0.34 * (1 - d);
        if (a <= 0.01) continue;
        ctx.fillStyle = `rgba(160,190,255,${a})`; ctx.beginPath(); ctx.arc(x, y, Math.max(0.8, m * 0.0024), 0, Math.PI * 2); ctx.fill();
      }
      // Fine rings, bottom right.
      ctx.lineWidth = line(m, 0.0012);
      for (let i = 0; i < 9; i++) {
        ctx.strokeStyle = `rgba(140,180,255,${0.12 - i * 0.011})`;
        ctx.beginPath(); ctx.arc(w * 0.92, h * 0.98, m * (0.12 + i * 0.07), 0, Math.PI * 2); ctx.stroke();
      }
      grain(ctx, w, h, 0.05);
    },
  },
  {
    id: 'grafit', title: N('Grafit'), emoji: '◼️', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h);
      gradient(ctx, w, h, ['#1b1c20', '#232429', '#18191c'], 0.5, true);
      glow(ctx, w * 0.5, -h * 0.15, m * 1.1, 'rgba(255,255,255,ALPHA)', 0.11);
      // Brushed-metal streaks.
      const r = rng(31);
      for (let i = 0; i < 260; i++) {
        const y = r() * h, x = r() * w, len = w * (0.1 + r() * 0.4);
        ctx.strokeStyle = `rgba(255,255,255,${0.008 + r() * 0.018})`; ctx.lineWidth = line(m, 0.0008);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y + len * 0.02); ctx.stroke();
      }
      // A hairline horizon.
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.08)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, h * 0.86, w, line(m, 0.0012));
      vignette(ctx, w, h, 0.5);
      grain(ctx, w, h, 0.07, 9);
    },
  },
  {
    id: 'mermer', title: N('Mermer'), emoji: '🏛️', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h), r = rng(1907);
      gradient(ctx, w, h, ['#f6f4f0', '#ece8e1', '#f3f0ea'], 0.8);
      for (let i = 0; i < 14; i++) blob(ctx, r() * w, r() * h, m * (0.2 + r() * 0.4), '170,160,150', 0.05 + r() * 0.05);
      // Veins: wandering curves with soft edges; a few gold ones.
      const vein = (gold: boolean) => {
        let x = r() * w * 1.2 - w * 0.1, y = r() < 0.5 ? -h * 0.05 : r() * h;
        let a = 0.3 + r() * 0.9;
        const pts: [number, number][] = [[x, y]];
        for (let k = 0; k < 60; k++) {
          a += (r() - 0.5) * 0.45; x += Math.cos(a) * m * 0.03; y += Math.sin(a) * m * 0.03;
          pts.push([x, y]);
        }
        const path = () => { ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); };
        // A broad, faint cloud along the vein first (real marble veins bleed into the stone).
        ctx.save();
        ctx.strokeStyle = gold ? 'rgba(181,146,76,0.06)' : 'rgba(120,112,104,0.05)';
        ctx.lineWidth = m * (0.012 + r() * 0.02); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.filter = `blur(${Math.max(1, m * 0.008)}px)`;
        path(); ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.strokeStyle = gold ? 'rgba(181,146,76,0.55)' : `rgba(110,104,98,${0.12 + r() * 0.18})`;
        ctx.shadowColor = gold ? 'rgba(181,146,76,0.5)' : 'rgba(110,104,98,0.35)'; ctx.shadowBlur = m * 0.006;
        ctx.lineWidth = line(m, gold ? 0.0016 : 0.0008 + r() * 0.002); ctx.lineJoin = 'round';
        ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.stroke();
        ctx.restore();
      };
      for (let i = 0; i < 16; i++) vein(false);
      for (let i = 0; i < 3; i++) vein(true);
      grain(ctx, w, h, 0.035, 3);
    },
  },
  {
    id: 'blueprint', title: N('Teknik çizim'), emoji: '📐', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h);
      gradient(ctx, w, h, ['#0e3f6e', '#0b3460', '#082a4f'], 0.5);
      const minor = m * 0.025;
      for (let x = 0, i = 0; x < w; x += minor, i++) { ctx.fillStyle = `rgba(255,255,255,${i % 4 ? 0.05 : 0.11})`; ctx.fillRect(x, 0, line(m, 0.0008), h); }
      for (let y = 0, i = 0; y < h; y += minor, i++) { ctx.fillStyle = `rgba(255,255,255,${i % 4 ? 0.05 : 0.11})`; ctx.fillRect(0, y, w, line(m, 0.0008)); }
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = line(m, 0.0014);
      ctx.font = `${Math.max(8, m * 0.016)}px ui-monospace, Menlo, Consolas, monospace`;
      // A part with a bore, its centre lines and a diameter (top left).
      const cx = w * 0.11, cy = h * 0.2, R = m * 0.12;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.45, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([m * 0.012, m * 0.006]);
      ctx.beginPath(); ctx.moveTo(cx - R * 1.3, cy); ctx.lineTo(cx + R * 1.3, cy); ctx.moveTo(cx, cy - R * 1.3); ctx.lineTo(cx, cy + R * 1.3); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('Ø 240', cx + R * 0.7, cy - R * 0.85);
      // A dimension line with arrows (bottom).
      const dy = h * 0.93, x0 = w * 0.32, x1 = w * 0.68, ar = m * 0.012;
      ctx.beginPath(); ctx.moveTo(x0, dy); ctx.lineTo(x1, dy);
      ctx.moveTo(x0, dy - m * 0.025); ctx.lineTo(x0, dy + m * 0.012); ctx.moveTo(x1, dy - m * 0.025); ctx.lineTo(x1, dy + m * 0.012);
      ctx.moveTo(x0 + ar, dy - ar / 2); ctx.lineTo(x0, dy); ctx.lineTo(x0 + ar, dy + ar / 2);
      ctx.moveTo(x1 - ar, dy - ar / 2); ctx.lineTo(x1, dy); ctx.lineTo(x1 - ar, dy + ar / 2); ctx.stroke();
      ctx.fillText('1920', (x0 + x1) / 2 - m * 0.022, dy - m * 0.012);
      // A protractor arc (bottom right) and a title block.
      const px = w * 0.9, py = h * 0.86, pr = m * 0.16;
      ctx.beginPath(); ctx.arc(px, py, pr, Math.PI, Math.PI * 1.5); ctx.stroke();
      for (let k = 0; k <= 9; k++) {
        const a = Math.PI + (k / 9) * (Math.PI / 2), l = k % 3 ? 0.06 : 0.12;
        ctx.beginPath(); ctx.moveTo(px + Math.cos(a) * pr, py + Math.sin(a) * pr); ctx.lineTo(px + Math.cos(a) * pr * (1 - l), py + Math.sin(a) * pr * (1 - l)); ctx.stroke();
      }
      ctx.strokeRect(w * 0.78, h * 0.035, w * 0.19, m * 0.09);
      ctx.beginPath(); ctx.moveTo(w * 0.78, h * 0.035 + m * 0.045); ctx.lineTo(w * 0.97, h * 0.035 + m * 0.045); ctx.stroke();
      ctx.fillText('FOCARA · REV A', w * 0.79, h * 0.035 + m * 0.032);
      ctx.fillText('SCALE 1:1', w * 0.79, h * 0.035 + m * 0.077);
      vignette(ctx, w, h, 0.35);
    },
  },
  {
    id: 'aurora', title: N('Aurora'), emoji: '🌌', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h);
      gradient(ctx, w, h, ['#070b1a', '#0c1226'], 0.5, true);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      blob(ctx, w * 0.12, h * 0.15, m * 0.95, '99,102,241', 0.42);
      blob(ctx, w * 0.82, h * 0.1, m * 0.8, '236,72,153', 0.30);
      blob(ctx, w * 0.55, h * 0.95, m * 0.95, '20,184,166', 0.34);
      blob(ctx, w * 0.95, h * 0.75, m * 0.6, '59,130,246', 0.30);
      blob(ctx, w * 0.3, h * 0.7, m * 0.5, '168,85,247', 0.22);
      ctx.restore();
      grain(ctx, w, h, 0.06, 13);
    },
  },
  {
    id: 'pastel', title: N('Pastel'), emoji: '🫧', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h);
      gradient(ctx, w, h, ['#f8fafc', '#f1f5f9'], 0.5, true);
      blob(ctx, w * 0.1, h * 0.1, m * 0.9, '199,210,254', 0.85);
      blob(ctx, w * 0.9, h * 0.2, m * 0.8, '251,207,232', 0.75);
      blob(ctx, w * 0.75, h * 0.95, m * 0.9, '186,230,253', 0.8);
      blob(ctx, w * 0.2, h * 0.95, m * 0.7, '221,214,254', 0.7);
      blob(ctx, w * 0.5, h * 0.5, m * 0.5, '255,255,255', 0.5);
      grain(ctx, w, h, 0.025, 17);
    },
  },
  {
    id: 'topografya', title: N('Topoğrafya'), emoji: '🗺️', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h), r = rng(4242);
      gradient(ctx, w, h, ['#0f1f1c', '#13291f', '#0d1b18'], 0.7);
      glow(ctx, w * 0.5, h * 0.5, m * 0.9, 'rgba(110,231,183,ALPHA)', 0.06);
      // Contour lines around a few summits, each ring a slightly wobbly loop.
      const summits = [[w * 0.06, h * 0.9, 26], [w * 0.95, h * 0.12, 22], [w * 0.88, h * 1.05, 14], [w * 0.15, h * -0.05, 12]] as const;
      for (const [sx, sy, rings] of summits) {
        const phase = r() * 10, lobes = 3 + Math.floor(r() * 3);
        for (let k = 1; k <= rings; k++) {
          const base = m * 0.035 * k;
          ctx.strokeStyle = `rgba(167,243,208,${k % 5 ? 0.12 : 0.22})`; ctx.lineWidth = line(m, k % 5 ? 0.001 : 0.0016);
          ctx.beginPath();
          for (let i = 0; i <= 120; i++) {
            const a = (i / 120) * Math.PI * 2;
            const rr = base * (1 + 0.12 * Math.sin(a * lobes + phase + k * 0.15) + 0.05 * Math.sin(a * (lobes + 2) - phase));
            const x = sx + Math.cos(a) * rr, y = sy + Math.sin(a) * rr * 0.8;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.stroke();
        }
      }
      vignette(ctx, w, h, 0.4);
    },
  },
  {
    id: 'kagit', title: N('Kağıt'), emoji: '📜', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h), r = rng(808);
      gradient(ctx, w, h, ['#f6f0e4', '#efe6d4', '#f4ecdd'], 0.9);
      for (let i = 0; i < 10; i++) blob(ctx, r() * w, r() * h, m * (0.2 + r() * 0.35), '160,130,90', 0.035);
      // Paper fibres.
      for (let i = 0; i < 900; i++) {
        const x = r() * w, y = r() * h, a = r() * Math.PI, l = m * (0.004 + r() * 0.014);
        ctx.strokeStyle = `rgba(120,90,50,${0.03 + r() * 0.05})`; ctx.lineWidth = line(m, 0.0006);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + l * 0.2, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
      }
      grain(ctx, w, h, 0.05, 21);
      const g = ctx.createRadialGradient(w / 2, h / 2, m * 0.4, w / 2, h / 2, Math.hypot(w, h) * 0.62);
      g.addColorStop(0, 'rgba(120,80,30,0)'); g.addColorStop(1, 'rgba(120,80,30,0.18)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    },
  },
  {
    id: 'siyah-altin', title: N('Siyah & Altın'), emoji: '✨', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h), gold = (a: number) => `rgba(212,175,55,${a})`;
      gradient(ctx, w, h, ['#0b0b0d', '#151418', '#0c0b0e'], 0.6);
      glow(ctx, w * 0.5, h * 0.4, m * 0.8, 'rgba(212,175,55,ALPHA)', 0.07);
      // Art-deco fans in the bottom corners.
      for (const [fx, dir] of [[0, 1], [w, -1]] as const) {
        ctx.lineWidth = line(m, 0.0012);
        for (let k = 1; k <= 7; k++) { ctx.strokeStyle = gold(0.34 - k * 0.03); ctx.beginPath(); ctx.arc(fx, h, m * 0.06 * k, Math.PI + (dir > 0 ? Math.PI / 2 : 0), dir > 0 ? Math.PI * 2 : Math.PI * 1.5); ctx.stroke(); }
        for (let k = 0; k <= 8; k++) {
          const a = dir > 0 ? Math.PI * 1.5 + (k / 8) * (Math.PI / 2) : Math.PI + (k / 8) * (Math.PI / 2);
          ctx.strokeStyle = gold(0.18); ctx.beginPath(); ctx.moveTo(fx, h); ctx.lineTo(fx + Math.cos(a) * m * 0.42, h + Math.sin(a) * m * 0.42); ctx.stroke();
        }
      }
      // A thin double frame with stepped corners.
      const i1 = m * 0.03, i2 = m * 0.042, c = m * 0.05;
      ctx.strokeStyle = gold(0.5); ctx.lineWidth = line(m, 0.0014);
      ctx.strokeRect(i1, i1, w - 2 * i1, h - 2 * i1);
      ctx.strokeStyle = gold(0.25); ctx.lineWidth = line(m, 0.001);
      ctx.beginPath();
      ctx.moveTo(i2 + c, i2); ctx.lineTo(w - i2 - c, i2); ctx.lineTo(w - i2, i2 + c); ctx.lineTo(w - i2, h - i2 - c); ctx.lineTo(w - i2 - c, h - i2);
      ctx.lineTo(i2 + c, h - i2); ctx.lineTo(i2, h - i2 - c); ctx.lineTo(i2, i2 + c); ctx.closePath(); ctx.stroke();
      for (const [x, y] of [[i1, i1], [w - i1, i1], [i1, h - i1], [w - i1, h - i1]]) {
        ctx.fillStyle = gold(0.7); ctx.beginPath(); ctx.moveTo(x, y - m * 0.008); ctx.lineTo(x + m * 0.008, y); ctx.lineTo(x, y + m * 0.008); ctx.lineTo(x - m * 0.008, y); ctx.fill();
      }
      grain(ctx, w, h, 0.05, 27);
    },
  },
  {
    id: 'bokeh', title: N('Ofis ışıkları'), emoji: '💡', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h), r = rng(616);
      gradient(ctx, w, h, ['#0e1628', '#18233b', '#2a2433'], 0.4, true);
      // Out-of-focus lights: cool up top, warm lower down.
      for (let i = 0; i < 70; i++) {
        const y = r() * h, warm = y / h + (r() - 0.5) * 0.5 > 0.5;
        const rgb = warm ? pick(r, ['255,196,140', '255,170,100', '255,220,170']) : pick(r, ['150,190,255', '190,210,255', '140,170,240']);
        const rad = m * (0.015 + r() * r() * 0.08), x = r() * w, a = 0.06 + r() * 0.16;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, `rgba(${rgb},${a * 0.7})`); g.addColorStop(0.85, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
      }
      vignette(ctx, w, h, 0.45);
      grain(ctx, w, h, 0.04, 33);
    },
  },
  {
    id: 'finans', title: N('Finans'), emoji: '📈', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h), r = rng(2024);
      gradient(ctx, w, h, ['#0a1120', '#0d1a2e', '#0a1424'], 0.5);
      for (let i = 1; i < 8; i++) { ctx.fillStyle = 'rgba(148,163,184,0.06)'; ctx.fillRect(0, (h * i) / 8, w, line(m, 0.0008)); }
      for (let i = 1; i < 14; i++) { ctx.fillStyle = 'rgba(148,163,184,0.04)'; ctx.fillRect((w * i) / 14, 0, line(m, 0.0008), h); }
      // Faint candles behind, then two trending lines with soft areas.
      let v = 0.62;
      const n = 46, bw = w / n;
      for (let i = 0; i < n; i++) {
        const o = v, c = Math.max(0.15, Math.min(0.9, v + (r() - 0.56) * 0.06)), hi = Math.max(o, c) + r() * 0.03, lo = Math.min(o, c) - r() * 0.03;
        const up = c > o; v = c;
        ctx.fillStyle = up ? 'rgba(52,211,153,0.10)' : 'rgba(248,113,113,0.09)';
        ctx.fillRect(i * bw + bw * 0.5, h * (1 - hi) * 0.9 + h * 0.08, line(m, 0.001), h * (hi - lo) * 0.9);
        ctx.fillRect(i * bw + bw * 0.25, h * (1 - Math.max(o, c)) * 0.9 + h * 0.08, bw * 0.5, Math.max(line(m, 0.001), h * Math.abs(c - o) * 0.9));
      }
      const series = (seed: number, start: number, drift: number, rgb: string, alpha: number) => {
        const rr = rng(seed); let y = start;
        const pts: [number, number][] = [];
        for (let i = 0; i <= 60; i++) { y = Math.max(0.1, Math.min(0.92, y - drift + (rr() - 0.5) * 0.05)); pts.push([(i / 60) * w, h * y]); }
        const g = ctx.createLinearGradient(0, h * 0.2, 0, h);
        g.addColorStop(0, `rgba(${rgb},${alpha * 0.35})`); g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.beginPath(); pts.forEach(([x, yy], i) => (i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy))); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); pts.forEach(([x, yy], i) => (i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy)));
        ctx.strokeStyle = `rgba(${rgb},${alpha})`; ctx.lineWidth = line(m, 0.003); ctx.lineJoin = 'round'; ctx.stroke();
      };
      series(7, 0.8, 0.008, '96,165,250', 0.28);
      series(11, 0.85, 0.011, '52,211,153', 0.45);
      vignette(ctx, w, h, 0.45);
    },
  },
  {
    id: 'cam', title: N('Cam'), emoji: '🪟', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h);
      gradient(ctx, w, h, ['#1e1b4b', '#1e3a8a', '#0f766e'], 0.8);
      blob(ctx, w * 0.15, h * 0.2, m * 0.6, '244,114,182', 0.45);
      blob(ctx, w * 0.85, h * 0.25, m * 0.55, '250,204,21', 0.3);
      blob(ctx, w * 0.75, h * 0.9, m * 0.7, '45,212,191', 0.45);
      blob(ctx, w * 0.2, h * 0.85, m * 0.5, '129,140,248', 0.5);
      // Frosted panels: the background seen through blurred glass, with a light rim.
      const panels: [number, number, number, number][] = [[-0.04, 0.08, 0.3, 0.42], [0.72, -0.06, 0.34, 0.36], [0.62, 0.6, 0.42, 0.5], [0.04, 0.62, 0.26, 0.32]];
      for (const [px, py, pw, ph] of panels) {
        const x = px * w, y = py * h, pw2 = pw * w, ph2 = ph * h, rad = m * 0.04;
        ctx.save();
        ctx.beginPath(); ctx.roundRect(x, y, pw2, ph2, rad); ctx.clip();
        ctx.filter = `blur(${Math.max(1, m * 0.03)}px)`;
        ctx.drawImage(ctx.canvas, 0, 0);
        ctx.filter = 'none';
        const g = ctx.createLinearGradient(x, y, x + pw2, y + ph2);
        g.addColorStop(0, 'rgba(255,255,255,0.22)'); g.addColorStop(1, 'rgba(255,255,255,0.06)');
        ctx.fillStyle = g; ctx.fillRect(x, y, pw2, ph2);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = line(m, 0.0014);
        ctx.beginPath(); ctx.roundRect(x, y, pw2, ph2, rad); ctx.stroke();
      }
      grain(ctx, w, h, 0.04, 41);
    },
  },
  {
    id: 'geometrik', title: N('Geometrik'), emoji: '🔷', group: 'pro',
    draw(ctx, w, h) {
      const m = Math.min(w, h), r = rng(5150);
      // Low-poly: a jittered grid split into triangles, shaded by a soft light from the top left.
      const cell = m * 0.12, cols = Math.ceil(w / cell) + 2, rows = Math.ceil(h / cell) + 2;
      const pts: [number, number][][] = [];
      for (let j = 0; j < rows; j++) {
        pts.push([]);
        for (let i = 0; i < cols; i++) pts[j].push([(i - 0.5) * cell + (r() - 0.5) * cell * 0.7, (j - 0.5) * cell + (r() - 0.5) * cell * 0.7]);
      }
      const shade = (x: number, y: number) => {
        const k = Math.min(1, Math.hypot(x / w, y / h) / 1.2), n = (r() - 0.5) * 0.08;
        const mix = (a: number, b: number) => Math.round(a + (b - a) * Math.min(1, Math.max(0, k + n)));
        return `rgb(${mix(38, 9)},${mix(70, 18)},${mix(120, 38)})`;
      };
      const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.closePath();
        ctx.fillStyle = shade((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3); ctx.fill();
        ctx.strokeStyle = 'rgba(148,197,255,0.07)'; ctx.lineWidth = line(m, 0.0008); ctx.stroke();
      };
      for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
        const p = pts[j][i], q = pts[j][i + 1], s2 = pts[j + 1][i], t2 = pts[j + 1][i + 1];
        if ((i + j) % 2) { tri(p, q, t2); tri(p, t2, s2); } else { tri(p, q, s2); tri(q, t2, s2); }
      }
      glow(ctx, w * 0.2, h * 0.1, m * 0.8, 'rgba(96,165,250,ALPHA)', 0.18);
      vignette(ctx, w, h, 0.35);
    },
  },
];

function hexToRgba(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},ALPHA)`;
}

/** Ready-made colour gradients for the "Renk" background mode. */
export const gradientPresets: { title: string; top: string; bottom: string }[] = [
  { title: N('Gece'), top: '#333d6b', bottom: '#87548c' },
  { title: N('Okyanus'), top: '#1e9ad6', bottom: '#2d3a8c' },
  { title: N('Gün batımı'), top: '#ff7e5f', bottom: '#feb47b' },
  { title: N('Orman'), top: '#134e5e', bottom: '#71b280' },
  { title: N('Şeker'), top: '#ff6fb5', bottom: '#7b6cff' },
  { title: N('Kömür'), top: '#232526', bottom: '#414345' },
  { title: N('Lavanta'), top: '#b8a9ff', bottom: '#f3c4fb' },
  { title: N('Nane'), top: '#b2f5ea', bottom: '#38b2ac' },
];

/** Display order: the most eye-catching professional looks first, then the calm basics. */
const order = ['topografya', 'aurora', 'pastel', 'geometrik', 'blueprint', 'cam', 'siyah-altin', 'mermer', 'kurumsal', 'bokeh', 'finans', 'grafit', 'kagit', 'gece', 'minimal'];
export const themesOf = (group: ThemeGroup) => themes.filter((t) => t.group === group)
  .sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));

const cache = new Map<string, OffscreenCanvas>();
const thumbs = new Map<string, OffscreenCanvas>();
/** Contexts of thumbnails, which are drawn on the CPU (see themeCanvas). */
const onCpu = new WeakSet<Ctx>();

/**
 * The theme rendered at a given size (cached: themes are static). Small thumbnails are kept in
 * their own cache, so opening the theme list never pushes out the full-size background. They are
 * drawn on the CPU (quick at that size): on the GPU every theme's kinds of drawing need pipelines
 * of their own, which on a first launch keeps the GPU from showing anything for a moment.
 */
export function themeCanvas(id: string, w: number, h: number): OffscreenCanvas {
  const key = `${id}|${w}x${h}`;
  const store = w * h <= 400 * 240 ? thumbs : cache;
  let c = store.get(key);
  if (!c) {
    c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: store === thumbs })!;
    if (store === thumbs) onCpu.add(ctx);
    (themes.find((t) => t.id === id) ?? themes[0]).draw(ctx, w, h);
    if (store === cache && cache.size >= 4) cache.delete(cache.keys().next().value!);
    store.set(key, c);
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
