import { useEffect, useRef, useState } from 'react';
import { type Clip, type RGBA, type StyleSettings, type ZoomSegment, assetOf, fixedFocus, followCursor, isFollow, zoomSpeeds } from '../core/model.ts';
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
        : <StyleInspector store={store} />}
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

const toHex = (c: RGBA) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): RGBA => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: 1 });

function StyleInspector({ store }: { store: EditorStore }) {
  const st = store.project.style;
  const set = <K extends keyof StyleSettings>(key: K, value: StyleSettings[K]) =>
    store.update((p) => ({ ...p, style: { ...p.style, [key]: value } }), `style-${key}`);
  return (
    <>
      <section>
        <h3>Görünüm</h3>
        <div className="field row between">Arka plan
          <span className="row">
            <input type="color" value={toHex(st.backgroundTop)} onChange={(e) => set('backgroundTop', fromHex(e.target.value))} />
            <input type="color" value={toHex(st.backgroundBottom)} onChange={(e) => set('backgroundBottom', fromHex(e.target.value))} />
          </span>
        </div>
        <label className="field">Kenar boşluğu<input type="range" min={0} max={0.2} step={0.001} value={st.padding} onChange={(e) => set('padding', Number(e.target.value))} /></label>
        <label className="field">Köşe<input type="range" min={0} max={0.06} step={0.001} value={st.cornerRadius} onChange={(e) => set('cornerRadius', Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={st.shadow} onChange={(e) => set('shadow', e.target.checked)} /> Gölge</label>
      </section>
      <section>
        <h3>İmleç</h3>
        <label className="check"><input type="checkbox" checked={st.showCursor} onChange={(e) => set('showCursor', e.target.checked)} /> İmleci göster</label>
        <label className="field">Boyut<input type="range" min={0.6} max={3} step={0.01} value={st.cursorScale} onChange={(e) => set('cursorScale', Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={st.smoothCursor} onChange={(e) => set('smoothCursor', e.target.checked)} /> Hareketi yumuşat</label>
        <label className="check"><input type="checkbox" checked={st.clickRipple} onChange={(e) => set('clickRipple', e.target.checked)} /> Tıklama halkası</label>
      </section>
      <section>
        <h3>Zoom geçişi</h3>
        <div className="segmented">
          {zoomSpeeds.map((z) => <button key={z.id} className={st.zoomSpeed === z.id ? 'on' : ''} onClick={() => set('zoomSpeed', z.id)}>{z.title}</button>)}
        </div>
        <p className="muted small">Bir zoom'u düzenlemek için zaman çizelgesinde üzerine tıkla.</p>
      </section>
      <section>
        <h3>Kayıt</h3>
        {store.project.media.map((m) => (
          <div key={m.id} className="media-info">
            <b>{m.displayName}</b>
            <span className="muted small">{m.pixelWidth}×{m.pixelHeight} · {timecode(m.duration, false)}</span>
            {(m.systemAudioFile || m.microphoneFile) && (
              <span className="muted small">Ses: {[m.systemAudioFile && 'sistem sesi', m.microphoneFile && 'mikrofon'].filter(Boolean).join(', ')}</span>
            )}
          </div>
        ))}
      </section>
    </>
  );
}
