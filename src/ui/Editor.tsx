import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { odak } from '../bridge.ts';
import { type ZoomSegment, assetOf, clipDuration, clipStarts, isFollow, projectDuration } from '../core/model.ts';
import { addZoomAt, deleteZoom, regenerateAutoZooms, updateZoom } from '../core/edit.ts';
import { MediaLibrary } from '../media/media.ts';
import { Player } from '../media/player.ts';
import { ExportDialog } from './ExportDialog.tsx';
import { Inspector } from './Inspector.tsx';
import { type EditorStore, useStore } from './store.ts';

export function timecode(t: number, cs = true) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t - Math.floor(t)) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${cs ? '.' + String(c).padStart(2, '0') : ''}`;
}

export function Editor({ store, onClose }: { store: EditorStore; onClose: () => void }) {
  useStore(store);
  const p = store.project;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lib = useMemo(() => new MediaLibrary(store.pkg), [store.pkg]);
  const [player, setPlayer] = useState<Player | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);

  useEffect(() => {
    const pl = new Player(canvasRef.current!, lib, setTime, setPlaying);
    setPlayer(pl);
    return () => { pl.destroy(); lib.dispose(); };
  }, [lib]);

  // Every edit reaches the preview (camera timelines are cached, so this is cheap).
  useEffect(() => {
    if (!player) return;
    void player.setProject(p).then(() => setAspect(player.canvasSize.width / player.canvasSize.height))
      .catch((e) => store.setError(`Önizleme hazırlanamadı: ${(e as Error).message}`));
  }, [player, p, store]);

  useEffect(() => {
    const open = () => setShowExport(true);
    window.addEventListener('odak:export', open);
    return () => window.removeEventListener('odak:export', open);
  }, []);

  const seek = (t: number) => { player?.pause(); void player?.seek(t); };
  const step = (frames: number) => seek((player?.currentTime ?? time) + frames / p.export.fps);
  const sel = store.selection;

  const addZoom = () => {
    const r = addZoomAt(p, player?.currentTime ?? time);
    if ('error' in r) { store.setError(r.error); return; }
    store.update(() => r.project);
    store.select({ kind: 'zoom', clipID: r.clipID, zoomID: r.zoomID });
  };
  const deleteSelected = () => {
    if (sel?.kind !== 'zoom') return;
    store.update((q) => deleteZoom(q, sel.clipID, sel.zoomID));
    store.select(null);
  };
  const regenerate = async () => {
    const tracks = new Map(await Promise.all(p.media.map(async (m) => [m.id, await lib.cursor(m)] as const)));
    store.update((q) => regenerateAutoZooms(q, (id) => tracks.get(id) ?? null));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      if (e.key === ' ') { e.preventDefault(); player?.toggle(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const duration = projectDuration(p);
  return (
    <div className="editor">
      <header className="toolbar">
        <button onClick={onClose} title="Ana ekrana dön (proje kaydedilir)">‹ Projeler</button>
        <div className="title"><b>{p.name}</b><span>{store.saveStatus}</span></div>
        <div className="row">
          <button disabled={!store.canUndo} onClick={() => store.undo()} title="Geri Al">↶</button>
          <button disabled={!store.canRedo} onClick={() => store.redo()} title="Yinele">↷</button>
          <button onClick={() => void odak().reveal(`${store.pkg}/project.json`)} title="Proje klasörünü göster">Klasör</button>
          <button className="primary" onClick={() => setShowExport(true)}>Dışa Aktar</button>
        </div>
      </header>
      <div className="workspace">
        <div className="stage">
          <div className="preview">
            <canvas ref={canvasRef} style={{ aspectRatio: String(aspect) }} onClick={() => player?.toggle()} />
          </div>
          <div className="transport">
            <button className="ghost" onClick={() => step(-1)} title="Bir kare geri (←)">⏮</button>
            <button className="ghost play" onClick={() => player?.toggle()} title="Oynat / Duraklat (boşluk)">{playing ? '❚❚' : '▶'}</button>
            <button className="ghost" onClick={() => step(1)} title="Bir kare ileri (→)">⏭</button>
            <span className="mono muted">{timecode(time)} / {timecode(duration)}</span>
            <span className="spacer" />
            <button onClick={addZoom} title="Oynatma çizgisinde yeni zoom">＋ Zoom Ekle</button>
            <button onClick={() => void regenerate()} title="Dokunulmamış otomatik zoom'ları tıklamalardan yeniden üret; elle düzenlenenler korunur">✦ Otomatik Zoom</button>
          </div>
        </div>
        <Inspector store={store} lib={lib} seek={seek} onDelete={deleteSelected} />
      </div>
      <Timeline store={store} time={time} seek={seek} />
      {showExport && <ExportDialog store={store} lib={lib} onClose={() => setShowExport(false)} />}
      {store.error && (
        <div className="modal-backdrop" onClick={() => store.setError(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <h3>Odak</h3><p className="pre">{store.error}</p>
            <div className="row end"><button className="primary" onClick={() => store.setError(null)}>Tamam</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- timeline

const INSET = 18;

function Timeline({ store, time, seek }: { store: EditorStore; time: number; seek: (t: number) => void }) {
  const p = store.project;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  const duration = Math.max(projectDuration(p), 0.5);
  const pps = (width - INSET * 2) / duration;
  const starts = clipStarts(p);

  const scrub = (e: React.PointerEvent) => {
    const el = ref.current!;
    const at = (x: number) => seek((x - el.getBoundingClientRect().left - INSET) / pps);
    store.select(null);
    at(e.clientX);
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ }
    const move = (ev: PointerEvent) => at(ev.clientX);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const tick = steps.find((s) => s * pps >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += tick) ticks.push(t);

  return (
    <div className="timeline" ref={ref} onPointerDown={scrub}>
      {ticks.map((t) => (
        <div key={t} className="tick" style={{ left: INSET + t * pps }}><span>{timecode(t, false)}</span></div>
      ))}
      <div className="lane-label">ZOOM</div>
      {p.clips.map((clip, i) => {
        const x = INSET + starts[i] * pps;
        const media = assetOf(p, clip.mediaID);
        const selected = store.selection?.kind === 'clip' && store.selection.clipID === clip.id;
        return (
          <div key={clip.id}>
            <div className={`clip ${selected ? 'selected' : ''}`} style={{ left: x, width: Math.max(clipDuration(clip) * pps, 2) }}
                 onPointerDown={(e) => { e.stopPropagation(); store.select({ kind: 'clip', clipID: clip.id }); }}>
              <span>{media?.kind === 'externalVideo' ? '🎞' : '🖥'} {media?.displayName ?? '?'} <i>{timecode(clipDuration(clip), false)}</i></span>
            </div>
            {clip.zooms.map((z) => {
              const s = Math.max(z.start, clip.sourceStart), e = Math.min(z.end, clip.sourceEnd);
              if (e <= s) return null;
              return <ZoomBlock key={z.id} store={store} clipID={clip.id} zoom={z} pps={pps} seek={seek}
                                left={x + (s - clip.sourceStart) * pps} width={Math.max((e - s) * pps, 6)}
                                toTimeline={(src) => starts[i] + (src - clip.sourceStart)} />;
            })}
          </div>
        );
      })}
      <div className="playhead" style={{ left: INSET + time * pps }} />
    </div>
  );
}

function ZoomBlock({ store, clipID, zoom, pps, left, width, seek, toTimeline }: {
  store: EditorStore; clipID: string; zoom: ZoomSegment; pps: number; left: number; width: number;
  seek: (t: number) => void; toTimeline: (src: number) => number;
}) {
  const selected = store.selection?.kind === 'zoom' && store.selection.zoomID === zoom.id;

  const drag = (part: 'body' | 'left' | 'right') => (e: React.PointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ }
    const snap = { ...zoom }, x0 = e.clientX;
    store.select({ kind: 'zoom', clipID, zoomID: zoom.id });
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / pps;
      if (Math.abs(ev.clientX - x0) < 2) return;
      store.update((q) => updateZoom(q, clipID, zoom.id, (z) => {
        if (part === 'body') return { ...z, start: snap.start + d, end: snap.end + d };
        if (part === 'left') return { ...z, start: Math.min(snap.start + d, snap.end - 0.3) };
        return { ...z, end: Math.max(snap.end + d, snap.start + 0.3) };
      }), `drag-${zoom.id}`);
      seek(toTimeline(part === 'right' ? snap.end + d : snap.start + d));
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div className={`zoom ${zoom.isGenerated ? 'auto' : 'manual'} ${selected ? 'selected' : ''}`} style={{ left, width }}
         onPointerDown={drag('body')} title={`${zoom.isGenerated ? 'Otomatik' : 'Düzenlenmiş'} zoom · sürükle: taşı · kenarlar: süre`}>
      <div className="handle l" onPointerDown={drag('left')} />
      <span>{isFollow(zoom.focus) ? '➚' : '⌖'} ×{zoom.scale.toFixed(1)}</span>
      <div className="handle r" onPointerDown={drag('right')} />
    </div>
  );
}
