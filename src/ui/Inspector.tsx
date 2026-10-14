import { useEffect, useRef, useState } from 'react';
import {
  type CameraPosition, type CameraSegment, type CameraSettings, type Clip, type CursorStyle, type RGBA, type StyleSettings, type ZoomSegment,
  assetOf, clipDuration, clipStarts, fixedFocus, followCursor, isFollow, toLocal, zoomSpeeds,
} from '../core/model.ts';
import { odak } from '../bridge.ts';
import { drawCursor } from '../render/renderer.ts';
import { gradientPresets, themeCanvas, themes } from '../render/themes.ts';
import { setClipSpeed, trimClip, updateCameraSegment, updateZoom } from '../core/edit.ts';
import { cameraPositions } from '../core/cameraLayout.ts';
import type { MediaLibrary } from '../media/media.ts';
import { type EditActions, timecode } from './Editor.tsx';
import type { EditorStore } from './store.ts';

export function Inspector({ store, lib, seek, onDelete, actions }: {
  store: EditorStore; lib: MediaLibrary; seek: (t: number) => void; onDelete: () => void; actions: EditActions;
}) {
  const s = store.selection;
  const selClip = s?.kind === 'clip' ? store.project.clips.find((c) => c.id === s.clipID) : undefined;
  if (selClip) return <aside className="inspector"><ClipInspector store={store} clip={selClip} actions={actions} seek={seek} /></aside>;
  if (s?.kind === 'camera') {
    const c = store.project.clips.find((x) => x.id === s.clipID);
    const seg = c?.cameraSegments.find((x) => x.id === s.segID);
    if (c && seg) return <aside className="inspector"><CameraSegmentInspector key={seg.id} store={store} clip={c} seg={seg} seek={seek} onDelete={onDelete} /></aside>;
  }
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
  const clipStart = clipStarts(store.project)[store.project.clips.findIndex((c) => c.id === clip.id)] ?? 0;

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
          <button onClick={() => seek(clipStart + Math.max(0, toLocal(clip, zoom.start) - 0.5))}>Başına Git</button>
          <button className="danger" onClick={onDelete}>Sil</button>
        </div>
      </section>
    </>
  );
}

/** Nine places for the camera bubble. */
function PositionPicker({ value, onChange }: { value: CameraPosition; onChange: (p: CameraPosition) => void }) {
  return (
    <div className="positions">
      {cameraPositions.map((p) => (
        <button key={p.id} className={value === p.id ? 'on' : ''} title={p.title} onClick={() => onChange(p.id)}>{p.icon}</button>
      ))}
    </div>
  );
}

function CameraSegmentInspector({ store, clip, seg, seek, onDelete }: {
  store: EditorStore; clip: Clip; seg: CameraSegment; seek: (t: number) => void; onDelete: () => void;
}) {
  const set = (key: string, change: (s: CameraSegment) => CameraSegment) =>
    store.update((p) => updateCameraSegment(p, clip.id, seg.id, change), `${key}-${seg.id}`);
  const clipStart = clipStarts(store.project)[store.project.clips.findIndex((c) => c.id === clip.id)] ?? 0;
  return (
    <>
      <section>
        <h3>Kamera bölümü</h3>
        <p className="muted small">Bu aralıkta kamera burada durur. Başında yerine yumuşakça kayar, sonunda genel ayara geri döner.</p>
        <div className="segmented">
          {([['bubble', 'Balon'], ['full', 'Tam ekran'], ['hidden', 'Gizle']] as const).map(([k, t]) => (
            <button key={k} className={seg.mode === k ? 'on' : ''} onClick={() => set('mode', (x) => ({ ...x, mode: k }))}>{t}</button>
          ))}
        </div>
        {seg.mode === 'bubble' && <>
          <div className="field">Konum</div>
          <PositionPicker value={seg.position} onChange={(v) => set('position', (x) => ({ ...x, position: v }))} />
          <label className="field">Boyut
            <div className="row">
              <input type="range" min={0.12} max={0.6} step={0.005} value={seg.size} onChange={(e) => set('size', (x) => ({ ...x, size: Number(e.target.value) }))} />
              <span className="mono value">{Math.round(seg.size * 100)}%</span>
            </div>
          </label>
        </>}
        {seg.mode === 'full' && <p className="muted small">Kamera tüm görüntüyü kaplar; örneğin girişte ya da konuşurken.</p>}
        {seg.mode === 'hidden' && <p className="muted small">Kamera bu aralıkta görünmez (yavaşça kaybolur ve geri gelir).</p>}
      </section>
      <section>
        <h3>Zamanlama</h3>
        <TimeField label="Başlangıç" value={seg.start - clip.sourceStart} onCommit={(v) => set('start', (x) => ({ ...x, start: clip.sourceStart + v }))} />
        <TimeField label="Bitiş" value={seg.end - clip.sourceStart} onCommit={(v) => set('end', (x) => ({ ...x, end: clip.sourceStart + v }))} />
        <div className="field row between"><span>Süre</span><span className="mono">{(toLocal(clip, seg.end) - toLocal(clip, seg.start)).toFixed(2)} sn</span></div>
        <div className="row between">
          <button onClick={() => seek(clipStart + Math.max(0, toLocal(clip, seg.start) - 0.7))}>Başına Git</button>
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
            <PositionPicker value={st.camera.position} onChange={(v) => setCam('position', v)} />
            <label className="field">Boyut<input type="range" min={0.12} max={0.5} step={0.005} value={st.camera.size} onChange={(e) => setCam('size', Number(e.target.value))} /></label>
            <div className="segmented">
              {([['circle', 'Daire'], ['rounded', 'Yuvarlak köşe'], ['square', 'Kare']] as const).map(([k, t]) => (
                <button key={k} className={st.camera.shape === k ? 'on' : ''} onClick={() => setCam('shape', k)}>{t}</button>
              ))}
            </div>
            <label className="check"><input type="checkbox" checked={st.camera.mirror} onChange={(e) => setCam('mirror', e.target.checked)} /> Ayna görüntüsü</label>
            <label className="check"><input type="checkbox" checked={st.camera.border} onChange={(e) => setCam('border', e.target.checked)} /> Beyaz çerçeve</label>
          </>}
          <p className="muted small">Belli bir aralıkta kamerayı başka yere taşımak, tam ekran yapmak ya da gizlemek için: aralığı seç, <b>📷 Kamera</b>.</p>
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

const SPEEDS = [0.5, 1, 1.5, 2, 4, 8];

function ClipInspector({ store, clip, actions, seek }: { store: EditorStore; clip: Clip; actions: EditActions; seek: (t: number) => void }) {
  const p = store.project;
  const media = assetOf(p, clip.mediaID);
  const index = p.clips.findIndex((c) => c.id === clip.id);
  const start = clipStarts(p)[index] ?? 0;
  const vol = (key: 'systemAudioVolume' | 'microphoneVolume' | 'videoVolume', v: number) =>
    store.update((q) => ({ ...q, clips: q.clips.map((c) => (c.id === clip.id ? { ...c, [key]: v } : c)) }), `vol-${key}-${clip.id}`);
  return (
    <>
      <section>
        <h3>Klip {index + 1} / {p.clips.length}</h3>
        <span className={`badge ${media?.kind === 'externalVideo' ? 'manual' : 'auto'}`}>
          {media?.kind === 'externalVideo' ? 'Eklenen video' : 'Ekran kaydı'} · {media?.displayName}
        </span>
        <TimeField label="Kaynakta başlangıç" value={clip.sourceStart} onCommit={(v) => store.update((q) => trimClip(q, clip.id, 'start', v))} />
        <TimeField label="Kaynakta bitiş" value={clip.sourceEnd} onCommit={(v) => store.update((q) => trimClip(q, clip.id, 'end', v))} />
        <div className="field row between"><span>Videodaki süre</span><span className="mono">{clipDuration(clip).toFixed(2)} sn</span></div>
        <p className="muted small">İpucu: zaman çizelgesinde klibin kenarlarını sürükleyerek de kırpabilirsin; bitiş kenarı oynatma çizgisine yapışır.</p>
      </section>
      <section>
        <h3>Hız</h3>
        <div className="segmented">
          {SPEEDS.map((sp) => <button key={sp} className={(clip.speed || 1) === sp ? 'on' : ''} onClick={() => store.update((q) => setClipSpeed(q, clip.id, sp))}>×{sp}</button>)}
        </div>
        {(clip.speed || 1) !== 1 && <p className="muted small">Bu klip ×{clip.speed} oynuyor; sesi kapalı.</p>}
      </section>
      {media && (media.systemAudioFile || media.microphoneFile || media.kind === 'externalVideo') && (
        <section>
          <h3>Bu klibin sesi</h3>
          {media.systemAudioFile && <label className="field">Sistem sesi<input type="range" min={0} max={2} step={0.01} value={clip.systemAudioVolume} onChange={(e) => vol('systemAudioVolume', Number(e.target.value))} /></label>}
          {media.microphoneFile && <label className="field">Mikrofon<input type="range" min={0} max={2} step={0.01} value={clip.microphoneVolume} onChange={(e) => vol('microphoneVolume', Number(e.target.value))} /></label>}
          {media.kind === 'externalVideo' && <label className="field">Video sesi<input type="range" min={0} max={2} step={0.01} value={clip.videoVolume} onChange={(e) => vol('videoVolume', Number(e.target.value))} /></label>}
        </section>
      )}
      <section>
        <h3>İşlemler</h3>
        <div className="row wrap">
          <button onClick={actions.split} title="S">✂ Oynatma çizgisinden böl</button>
          <button onClick={() => actions.duplicate(clip.id)}>⧉ Çoğalt</button>
          <button onClick={() => seek(start)}>Başına git</button>
          <button className="danger" onClick={() => actions.deleteClip(clip.id)}>Sil</button>
        </div>
        <p className="muted small">Sıralamak için klibi zaman çizelgesinde sürükle.</p>
      </section>
    </>
  );
}
