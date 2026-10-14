import { useEffect, useRef, useState } from 'react';
import {
  type CameraSettings, type Clip, type CursorStyle, type RGBA, type StyleSettings, type ZoomSegment,
  assetOf, fixedFocus, followCursor, isFollow, zoomSpeeds,
} from '../core/model.ts';
import { odak } from '../bridge.ts';
import { drawCursor } from '../render/renderer.ts';
import { gradientPresets, themeCanvas, themes } from '../render/themes.ts';
import { updateZoom } from '../core/edit.ts';
import type { MediaLibrary } from '../media/media.ts';
import { timecode } from './Editor.tsx';
import type { EditorStore } from './store.ts';

export function Inspector({ store, lib, seek, onDelete }: { store: EditorStore; lib: MediaLibrary; seek: (t: number) => void; onDelete: () => void }) {
  const s = store.selection;
  const clip = s?.kind === 'zoom' ? store.project.clips.find((c) => c.id === s.clipID) : undefined;
  const zoom = s?.kind === 'zoom' ? clip?.zooms.find((z) => z.id === s.zoomID) : undefined;
  return (
    <aside className="inspector">
      {clip && zoom
        ? <ZoomInspector key={zoom.id} store={store} lib={lib} clip={clip} zoom={zoom} seek={seek} onDelete={onDelete} />
        : <StyleInspector store={store} lib={lib} />}
    </aside>
  );
}

function ZoomInspector({ store, lib, clip, zoom, seek, onDelete }: {
  store: EditorStore; lib: MediaLibrary; clip: Clip; zoom: ZoomSegment; seek: (t: number) => void; onDelete: () => void;
}) {
  const set = (key: string, change: (z: ZoomSegment) => ZoomSegment) =>
    store.update((p) => updateZoom(p, clip.id, zoom.id, change), `${key}-${zoom.id}`);
  const fixed = !isFollow(zoom.focus);
  const starts = store.project.clips.map((_, i, a) => a.slice(0, i).reduce((t, c) => t + (c.sourceEnd - c.sourceStart), 0));
  const clipStart = starts[store.project.clips.findIndex((c) => c.id === clip.id)] ?? 0;

  const switchFocus = async (toFixed: boolean) => {
    if (!toFixed) { set('focus', (z) => ({ ...z, focus: followCursor() })); return; }
    // Start from where the camera currently looks, so switching doesn't jump.
    const asset = assetOf(store.project, clip.mediaID)!;
    const data = await lib.renderData(clip, asset, store.project.style);
    const c = data.timeline.camera((zoom.start + zoom.end) / 2);
    set('focus', (z) => ({ ...z, focus: fixedFocus(c.x, c.y) }));
  };

  return (
    <>
      <section>
        <h3>Zoom</h3>
        <span className={`badge ${zoom.isGenerated ? 'auto' : 'manual'}`}>{zoom.isGenerated ? 'Otomatik oluşturuldu' : 'Elle düzenlendi'}</span>
        <label className="field">Miktar
          <div className="row">
            <input type="range" min={1.1} max={4} step={0.01} value={zoom.scale}
                   onChange={(e) => set('scale', (z) => ({ ...z, scale: Number(e.target.value) }))} />
            <span className="mono value">×{zoom.scale.toFixed(2)}</span>
          </div>
        </label>
        <div className="segmented">
          <button className={!fixed ? 'on' : ''} onClick={() => void switchFocus(false)}>İmleci takip et</button>
          <button className={fixed ? 'on' : ''} onClick={() => void switchFocus(true)}>Sabit nokta</button>
        </div>
        {'fixed' in zoom.focus
          ? <>
              <p className="muted small">Görüntüde odaklanılacak yere tıkla ya da sürükle.</p>
              <FocusPicker lib={lib} store={store} clip={clip} zoom={zoom}
                           onChange={(x, y) => set('point', (z) => ({ ...z, focus: fixedFocus(x, y) }))} />
            </>
          : <p className="muted small">Kamera, imlecin bu aralıkta en çok vakit geçirdiği bölgelere yumuşakça kayar.</p>}
      </section>
      <section>
        <h3>Zamanlama</h3>
        <TimeField label="Başlangıç" value={zoom.start - clip.sourceStart} onCommit={(v) => set('start', (z) => ({ ...z, start: clip.sourceStart + v }))} />
        <TimeField label="Bitiş" value={zoom.end - clip.sourceStart} onCommit={(v) => set('end', (z) => ({ ...z, end: clip.sourceStart + v }))} />
        <div className="field row between"><span>Süre</span><span className="mono">{(zoom.end - zoom.start).toFixed(2)} sn</span></div>
        <div className="row between">
          <button onClick={() => seek(clipStart + Math.max(0, zoom.start - clip.sourceStart - 0.5))}>Başına Git</button>
          <button className="danger" onClick={onDelete}>Sil</button>
        </div>
      </section>
    </>
  );
}

function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(value.toFixed(2));
  useEffect(() => setText(value.toFixed(2)), [value]);
  const commit = () => { const v = Number(text.replace(',', '.')); if (Number.isFinite(v)) onCommit(v); else setText(value.toFixed(2)); };
  return (
    <label className="field row between">{label}
      <span className="row">
        <input className="num" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
               onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
        <span className="muted">sn</span>
        <button className="ghost tiny" onClick={() => onCommit(value - 0.1)}>−</button>
        <button className="ghost tiny" onClick={() => onCommit(value + 0.1)}>+</button>
      </span>
    </label>
  );
}

function FocusPicker({ lib, store, clip, zoom, onChange }: {
  lib: MediaLibrary; store: EditorStore; clip: Clip; zoom: ZoomSegment; onChange: (x: number, y: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const asset = assetOf(store.project, clip.mediaID)!;
  const mid = (zoom.start + zoom.end) / 2;
  const point = 'fixed' in zoom.focus ? zoom.focus.fixed : { x: 0.5, y: 0.5 };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const m = await lib.open(asset.videoFile);
      const s = await m.videoSink?.getSample(mid);
      if (!s || cancelled || !canvas.current) { s?.close(); return; }
      const c = canvas.current;
      c.width = 560; c.height = Math.round(560 * s.displayHeight / s.displayWidth);
      s.draw(c.getContext('2d')!, 0, 0, c.width, c.height);
      s.close();
    })();
    return () => { cancelled = true; };
  }, [lib, asset.videoFile, mid]);

  const pick = (e: React.PointerEvent) => {
    const el = box.current!;
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      onChange(Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1));
    };
    at(e);
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ }
    const move = (ev: PointerEvent) => at(ev);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const vw = 100 / zoom.scale, vh = 100 / zoom.scale;
  const left = Math.min(Math.max(point.x * 100 - vw / 2, 0), 100 - vw);
  const top = Math.min(Math.max(point.y * 100 - vh / 2, 0), 100 - vh);
  return (
    <div className="focus-picker" ref={box} onPointerDown={pick} style={{ aspectRatio: String(asset.pixelWidth / asset.pixelHeight) }}>
      <canvas ref={canvas} />
      <div className="viewport" style={{ left: `${left}%`, top: `${top}%`, width: `${vw}%`, height: `${vh}%` }} />
      <div className="dot" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />
    </div>
  );
}

function StyleInspector({ store, lib }: { store: EditorStore; lib: MediaLibrary }) {
  const p = store.project, st = p.style;
  const set = <K extends keyof StyleSettings>(key: K, value: StyleSettings[K]) =>
    store.update((q) => ({ ...q, style: { ...q.style, [key]: value } }), `style-${key}`);
  const setMany = (patch: Partial<StyleSettings>, key: string) =>
    store.update((q) => ({ ...q, style: { ...q.style, ...patch } }), `style-${key}`);
  const setCam = <K extends keyof CameraSettings>(key: K, value: CameraSettings[K]) =>
    store.update((q) => ({ ...q, style: { ...q.style, camera: { ...q.style.camera, [key]: value } } }), `camera-${key}`);
  const hasCamera = p.media.some((m) => m.cameraFile);
  const hasAudio = p.media.some((m) => m.systemAudioFile || m.microphoneFile);
  const [imageError, setImageError] = useState<string | null>(null);

  const pickImage = async () => {
    const src = await odak().pickImage();
    if (!src) return;
    try {
      const rel = await odak().importAsset(store.pkg, src);
      if (!(await lib.image(rel))) { setImageError('Bu görsel açılamadı. PNG, JPG ya da WEBP dene.'); return; }
      setImageError(null);
      setMany({ backgroundKind: 'image', backgroundImage: rel, padding: Math.max(st.padding, 0.08) }, 'image');
    } catch (e) { setImageError((e as Error).message); }
  };

  return (
    <>
      <section>
        <h3>Arka plan</h3>
        <div className="segmented">
          {([['gradient', 'Renk'], ['theme', 'Tema'], ['image', 'Görsel']] as const).map(([k, t]) => (
            <button key={k} className={st.backgroundKind === k ? 'on' : ''} onClick={() => set('backgroundKind', k)}>{t}</button>
          ))}
        </div>
        {st.backgroundKind === 'gradient' && <>
          <div className="swatches">
            {gradientPresets.map((g) => (
              <button key={g.title} title={g.title} className="swatch" style={{ background: `linear-gradient(135deg, ${g.top}, ${g.bottom})` }}
                      onClick={() => setMany({ backgroundTop: fromHex(g.top), backgroundBottom: fromHex(g.bottom) }, 'preset')} />
            ))}
          </div>
          <div className="field row between">Özel renkler
            <span className="row">
              <input type="color" value={toHex(st.backgroundTop)} onChange={(e) => set('backgroundTop', fromHex(e.target.value))} />
              <input type="color" value={toHex(st.backgroundBottom)} onChange={(e) => set('backgroundBottom', fromHex(e.target.value))} />
            </span>
          </div>
        </>}
        {st.backgroundKind === 'theme' && (
          <div className="themes">
            {themes.map((t) => (
              <button key={t.id} className={`theme ${st.backgroundTheme === t.id ? 'on' : ''}`} title={t.title}
                      onClick={() => setMany({ backgroundTheme: t.id, padding: Math.max(st.padding, 0.1) }, 'theme')}>
                <ThemeThumb id={t.id} />
                <span>{t.emoji} {t.title}</span>
              </button>
            ))}
          </div>
        )}
        {st.backgroundKind === 'image' && <>
          <div className="row">
            <button className="primary" onClick={() => void pickImage()}>Görsel Seç…</button>
            {st.backgroundImage && <span className="muted small">Projeye kopyalandı</span>}
          </div>
          {imageError && <p className="err small">{imageError}</p>}
          {!st.backgroundImage && <p className="muted small">Bilgisayarından bir görsel seç; projeye kopyalanır, ekranın arkasını kaplar.</p>}
          {st.backgroundImage && <label className="field">Bulanıklık<input type="range" min={0} max={1} step={0.01} value={st.backgroundBlur} onChange={(e) => set('backgroundBlur', Number(e.target.value))} /></label>}
        </>}
        <label className="field">Kenar boşluğu<input type="range" min={0} max={0.2} step={0.001} value={st.padding} onChange={(e) => set('padding', Number(e.target.value))} /></label>
        <label className="field">Köşe<input type="range" min={0} max={0.06} step={0.001} value={st.cornerRadius} onChange={(e) => set('cornerRadius', Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={st.shadow} onChange={(e) => set('shadow', e.target.checked)} /> Gölge</label>
      </section>
      <section>
        <h3>İmleç</h3>
        <label className="check"><input type="checkbox" checked={st.showCursor} onChange={(e) => set('showCursor', e.target.checked)} /> İmleci göster</label>
        <div className="cursors">
          {([['arrow', 'Beyaz ok'], ['arrow-dark', 'Siyah ok'], ['arrow-color', 'Renkli ok'], ['dot', 'Nokta']] as const).map(([k, t]) => (
            <button key={k} className={`cursor-opt ${st.cursorStyle === k ? 'on' : ''}`} title={t} onClick={() => set('cursorStyle', k)}>
              <CursorThumb style={k} color={st.cursorColor} /><span>{t}</span>
            </button>
          ))}
        </div>
        <div className="field row between">Renk (nokta, renkli ok, vurgu, tıklama)
          <input type="color" value={toHex(st.cursorColor)} onChange={(e) => set('cursorColor', fromHex(e.target.value))} />
        </div>
        <label className="field">Boyut<input type="range" min={0.6} max={3} step={0.01} value={st.cursorScale} onChange={(e) => set('cursorScale', Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={st.cursorHighlight} onChange={(e) => set('cursorHighlight', e.target.checked)} /> Vurgu halkası</label>
        <label className="check"><input type="checkbox" checked={st.smoothCursor} onChange={(e) => set('smoothCursor', e.target.checked)} /> Hareketi yumuşat</label>
        <label className="check"><input type="checkbox" checked={st.hideIdleCursor} onChange={(e) => set('hideIdleCursor', e.target.checked)} /> Hareketsizken gizle</label>
        <label className="check"><input type="checkbox" checked={st.clickRipple} onChange={(e) => set('clickRipple', e.target.checked)} /> Tıklama efekti</label>
        {st.clickRipple && (
          <div className="segmented">
            <button className={st.clickStyle === 'ring' ? 'on' : ''} onClick={() => set('clickStyle', 'ring')}>Halka</button>
            <button className={st.clickStyle === 'pulse' ? 'on' : ''} onClick={() => set('clickStyle', 'pulse')}>Dolgu</button>
          </div>
        )}
      </section>
      {hasCamera && (
        <section>
          <h3>Kamera</h3>
          <label className="check"><input type="checkbox" checked={st.camera.show} onChange={(e) => setCam('show', e.target.checked)} /> Kamerayı göster</label>
          {st.camera.show && <>
            <div className="corners">
              {([['top-left', '↖'], ['top-right', '↗'], ['bottom-left', '↙'], ['bottom-right', '↘']] as const).map(([k, t]) => (
                <button key={k} className={st.camera.position === k ? 'on' : ''} title="Konum" onClick={() => setCam('position', k)}>{t}</button>
              ))}
            </div>
            <label className="field">Boyut<input type="range" min={0.12} max={0.5} step={0.005} value={st.camera.size} onChange={(e) => setCam('size', Number(e.target.value))} /></label>
            <div className="segmented">
              {([['circle', 'Daire'], ['rounded', 'Yuvarlak köşe'], ['square', 'Kare']] as const).map(([k, t]) => (
                <button key={k} className={st.camera.shape === k ? 'on' : ''} onClick={() => setCam('shape', k)}>{t}</button>
              ))}
            </div>
            <label className="check"><input type="checkbox" checked={st.camera.mirror} onChange={(e) => setCam('mirror', e.target.checked)} /> Ayna görüntüsü</label>
            <label className="check"><input type="checkbox" checked={st.camera.border} onChange={(e) => setCam('border', e.target.checked)} /> Beyaz çerçeve</label>
          </>}
        </section>
      )}
      {hasAudio && (
        <section>
          <h3>Ses</h3>
          {p.media.some((m) => m.systemAudioFile) && (
            <label className="field">Sistem sesi<input type="range" min={0} max={2} step={0.01} value={p.clips[0]?.systemAudioVolume ?? 1}
              onChange={(e) => store.update((q) => ({ ...q, clips: q.clips.map((c) => ({ ...c, systemAudioVolume: Number(e.target.value) })) }), 'vol-system')} /></label>
          )}
          {p.media.some((m) => m.microphoneFile) && (
            <label className="field">Mikrofon<input type="range" min={0} max={2} step={0.01} value={p.clips[0]?.microphoneVolume ?? 1}
              onChange={(e) => store.update((q) => ({ ...q, clips: q.clips.map((c) => ({ ...c, microphoneVolume: Number(e.target.value) })) }), 'vol-mic')} /></label>
          )}
        </section>
      )}
      <section>
        <h3>Zoom geçişi</h3>
        <div className="segmented">
          {zoomSpeeds.map((z) => <button key={z.id} className={st.zoomSpeed === z.id ? 'on' : ''} onClick={() => set('zoomSpeed', z.id)}>{z.title}</button>)}
        </div>
        <p className="muted small">Bir zoom'u düzenlemek için zaman çizelgesinde üzerine tıkla.</p>
      </section>
      <section>
        <h3>Kayıt</h3>
        {p.media.map((m) => (
          <div key={m.id} className="media-info">
            <b>{m.displayName}</b>
            <span className="muted small">{m.pixelWidth}×{m.pixelHeight} · {timecode(m.duration, false)}</span>
            <span className="muted small">{[m.systemAudioFile && 'sistem sesi', m.microphoneFile && 'mikrofon', m.cameraFile && 'kamera'].filter(Boolean).join(' · ') || 'yalnızca ekran'}</span>
          </div>
        ))}
      </section>
    </>
  );
}

function ThemeThumb({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    c.width = 160; c.height = 90;
    c.getContext('2d')!.drawImage(themeCanvas(id, 160, 90), 0, 0);
  }, [id]);
  return <canvas ref={ref} />;
}

function CursorThumb({ style, color }: { style: CursorStyle; color: RGBA }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!, dpr = 2;
    c.width = 36 * dpr; c.height = 36 * dpr;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    drawCursor(ctx, style === 'dot' ? { x: 18 * dpr, y: 18 * dpr } : { x: 10 * dpr, y: 6 * dpr }, 1.2 * dpr, style, color);
  }, [style, color]);
  return <canvas ref={ref} style={{ width: 36, height: 36 }} />;
}

const toHex = (c: RGBA) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): RGBA => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: 1 });
