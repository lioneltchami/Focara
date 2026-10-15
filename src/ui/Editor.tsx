import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { odak } from '../bridge.ts';
import { type CameraSegment, type CameraPosition, type Clip, type MagnifierSegment, type Project, type MediaAsset, type ZoomSegment, assetOf, clipDuration, clipStarts, isFollow, newClip, projectDuration, toLocal } from '../core/model.ts';
import { cameraPositions } from '../core/cameraLayout.ts';
import { defaultMagnifier } from '../core/magnifier.ts';
import {
  addCameraSegment, addMagnifier, addZoomAt, deleteCameraSegment, deleteClip, deleteMagnifier, updateMagnifier, deleteZoom, duplicateClip, insertClip, isolateRange, moveClip,
  regenerateAutoZooms, removeRange, speedRange, splitAt, trimClip, updateCameraSegment, updateZoom,
} from '../core/edit.ts';
import { MediaLibrary } from '../media/media.ts';
import { Player } from '../media/player.ts';
import type { SideDevices } from '../media/sideRecorder.ts';
import { ExportDialog } from './ExportDialog.tsx';
import { Inspector, holdThumbs } from './Inspector.tsx';
import { QuietDialog } from './QuietDialog.tsx';
import { RecordSetup } from './RecordSetup.tsx';
import { type EditorStore, saveStatusText, useStore } from './store.ts';
import { N, t } from '../i18n/index.ts';

export function timecode(t: number, cs = true) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t - Math.floor(t)) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${cs ? '.' + String(c).padStart(2, '0') : ''}`;
}

/** Timeline tools: select/move/trim, select a time range, cut where you click. */
export type Tool = 'select' | 'range' | 'blade';

const toolHints: Record<Tool, string> = {
  select: N('Seç: tıkla → seç · sürükle → sırala · kenarı sürükle → kırp · Shift+sürükle → aralık'),
  range: N('Aralık: kliplerin üstünde sürükle → bir kısmı seç; sonra Sil, Ayır ya da hızlandır'),
  blade: N('Makas: klibe tıkla → tam oradan böler (oynatma çizgisine yapışır)'),
};

export interface EditActions {
  split: () => void;
  duplicate: (clipID: string) => void;
  deleteClip: (clipID: string) => void;
  time: () => number;
}

export function Editor({ store, onClose, busy, onRecordInto, onSettings }: {
  store: EditorStore; onClose: () => void; busy: boolean; onSettings: () => void;
  onRecordInto: (displayId: number, systemAudio: boolean, devices: SideDevices) => Promise<boolean>;
}) {
  useStore(store);
  const p = store.project;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lib = useMemo(() => new MediaLibrary(store.pkg), [store.pkg]);
  const [player, setPlayer] = useState<Player | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dialog, setDialog] = useState<'export' | 'record' | 'quiet' | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [range, setRange] = useState<{ a: number; b: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [flash, setFlashState] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setFlash = (text: string) => {
    clearTimeout(flashTimer.current);
    setFlashState(text);
    flashTimer.current = setTimeout(() => setFlashState(null), 2500);
  };

  useEffect(() => {
    const pl = new Player(canvasRef.current!, lib, setTime, (p) => { holdThumbs(p); setPlaying(p); });
    setPlayer(pl);
    return () => { pl.destroy(); lib.dispose(); };
  }, [lib]);

  // Every edit reaches the preview (camera timelines are cached, so this is cheap).
  useEffect(() => {
    if (!player) return;
    void player.setProject(p).then(() => setAspect(player.canvasSize.width / player.canvasSize.height))
      .catch((e) => store.setError(t('Önizleme hazırlanamadı: {detail}', { detail: (e as Error).message })));
  }, [player, p, store]);

  const seek = useCallback((t: number) => { player?.pause(); void player?.seek(t); }, [player]);
  const scrubTo = useCallback((t: number) => player?.scrub(t), [player]);
  const now = () => player?.currentTime ?? time;

  useEffect(() => {
    const open = () => setDialog('export');
    const toClip = (e: Event) => {
      const i = store.project.clips.findIndex((c) => c.id === (e as CustomEvent).detail);
      if (i >= 0) seek(clipStarts(store.project)[i]);
    };
    window.addEventListener('odak:export', open);
    window.addEventListener('odak:seekToClip', toClip);
    return () => { window.removeEventListener('odak:export', open); window.removeEventListener('odak:seekToClip', toClip); };
  }, [seek, store]);

  const step = (frames: number) => seek(now() + frames / p.export.fps);
  const sel = store.selection;

  const addZoom = () => {
    const r = addZoomAt(p, now());
    if ('error' in r) { store.setError(r.error); return; }
    store.update(() => r.project);
    store.select({ kind: 'zoom', clipID: r.clipID, zoomID: r.zoomID });
  };
  /** The selected range becomes its own clip(s), ready to move, speed up or delete. */
  const isolate = () => {
    if (!range) return;
    const r = isolateRange(store.project, range.a, range.b);
    if (!r.clipIDs.length) return;
    store.update(() => r.project);
    store.select({ kind: 'clip', clipID: r.clipIDs[0] });
    setRange(null);
    setTool('select');
  };
  const speedUp = (speed: number) => {
    if (!range) return;
    const r = speedRange(store.project, range.a, range.b, speed);
    if (!r.clipIDs.length) return;
    store.update(() => r.project);
    store.select({ kind: 'clip', clipID: r.clipIDs[0] });
    setRange(null);
    seek(range.a);
  };
  /**
   * Gives the selected range (or the next 3 s from the playhead) its own camera layout. It starts
   * mirrored to the other side, so the change is visible at once; the panel on the right edits it.
   */
  const hasCamera = p.media.some((m) => m.cameraFile);
  const addCamera = () => {
    const a = range ? range.a : now(), b = range ? range.b : Math.min(now() + 3, projectDuration(store.project));
    const c = store.project.style.camera;
    const flip: CameraPosition = c.position.endsWith('right') ? c.position.replace('right', 'left') as CameraPosition
      : c.position.endsWith('left') ? c.position.replace('left', 'right') as CameraPosition : 'bottom-right';
    const r = addCameraSegment(store.project, a, b, { mode: 'bubble', position: flip, size: c.size });
    if (!r.ids.length) { setFlash(t('Kamera bölümü için en az 0.1 sn seç.')); return; }
    store.update(() => r.project);
    store.select({ kind: 'camera', clipID: r.ids[0].clipID, segID: r.ids[0].segID });
    setRange(null);
    setTool('select');
  };
  /** A magnifier lens over the cursor for the selected range (or the next 3 s from the playhead). */
  const hasCursor = p.media.some((m) => m.kind === 'screenRecording' && m.cursorFile);
  const addLens = () => {
    const a = range ? range.a : now(), b = range ? range.b : Math.min(now() + 3, projectDuration(store.project));
    const r = addMagnifier(store.project, a, b, defaultMagnifier());
    if (!r.ids.length) { setFlash(t('Büyüteç için en az 0.1 sn seç.')); return; }
    store.update(() => r.project);
    store.select({ kind: 'magnifier', clipID: r.ids[0].clipID, segID: r.ids[0].segID });
    setRange(null);
    setTool('select');
  };
  /** Scissors tool: split exactly where the user clicked. */
  const cutAt = (t: number) => {
    const r = splitAt(store.project, t);
    if ('error' in r) { setFlash(r.error); return; }
    store.update(() => r.project);
    store.select({ kind: 'clip', clipID: r.rightID });
    seek(t);
  };
  const split = () => {
    if (range) { isolate(); return; }
    const r = splitAt(store.project, now());
    if ('error' in r) { store.setError(r.error); return; }
    store.update(() => r.project);
    store.select({ kind: 'clip', clipID: r.rightID });
  };
  const removeClip = (clipID: string) => {
    if (store.project.clips.length <= 1) { store.setError(t('Projede en az bir klip kalmalı.')); return; }
    store.update((q) => deleteClip(q, clipID));
    store.select(null);
  };
  const duplicate = (clipID: string) => {
    const r = duplicateClip(store.project, clipID);
    if (r) { store.update(() => r.project); store.select({ kind: 'clip', clipID: r.newID }); }
  };
  const deleteSelected = () => {
    if (range) {
      const q = removeRange(store.project, range.a, range.b);
      if (!q.clips.length) { store.setError(t('Tüm içerik silinemez; en az bir parça kalmalı.')); return; }
      store.update(() => q);
      setRange(null);
      seek(range.a);
      return;
    }
    if (sel?.kind === 'zoom') { store.update((q) => deleteZoom(q, sel.clipID, sel.zoomID)); store.select(null); }
    else if (sel?.kind === 'camera') { store.update((q) => deleteCameraSegment(q, sel.clipID, sel.segID)); store.select(null); }
    else if (sel?.kind === 'magnifier') { store.update((q) => deleteMagnifier(q, sel.clipID, sel.segID)); store.select(null); }
    else if (sel?.kind === 'clip') removeClip(sel.clipID);
  };
  const regenerate = async () => {
    const tracks = new Map(await Promise.all(p.media.map(async (m) => [m.id, await lib.cursor(m)] as const)));
    store.update((q) => regenerateAutoZooms(q, (id) => tracks.get(id) ?? null));
  };

  /** Copies a video file into the project and appends it as a clip (after the selected clip). */
  const importFile = useCallback(async (src: string) => {
    const { id, rel, name } = await odak().importMedia(store.pkg, src);
    try {
      const f = await lib.open(rel);
      if (!f.video) throw new Error(t('Dosyada video bulunamadı.'));
      if (!f.videoSink) throw new Error(t('Bu videonun kodeği bu bilgisayarda çözülemiyor (H.264/HEVC/VP9/AV1 MP4 ya da MOV deneyin).'));
      const duration = await f.input.computeDuration();
      const asset: MediaAsset = {
        id, kind: 'externalVideo', displayName: name, videoFile: rel, duration,
        pixelWidth: f.video.displayWidth, pixelHeight: f.video.displayHeight, pixelsPerPoint: 1,
      };
      const clip = newClip(id, 0, duration);
      const q = store.project;
      const after = store.selection?.kind === 'clip' ? q.clips.findIndex((c) => c.id === (store.selection as { clipID: string }).clipID) : q.clips.length - 1;
      store.update((x) => insertClip({ ...x, media: [...x.media, asset] }, clip, after));
      store.select({ kind: 'clip', clipID: clip.id });
      return clip.id;
    } catch (e) {
      await odak().removeMedia(store.pkg, id);
      throw e;
    }
  }, [lib, store]);

  const importVideos = async () => {
    const files = await odak().importVideoDialog();
    if (!files.length) return;
    setImporting(true);
    for (const f of files) {
      try { await importFile(f); } catch (e) { store.setError(t('“{name}” eklenemedi: {detail}', { name: f.replace(/^.*[\\/]/, ''), detail: (e as Error).message })); }
    }
    setImporting(false);
  };

  if (odak().isUiTest) Object.assign(window, { __odakEditor: { importFile, setRange, player, range } });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select') || dialog) return;
      if (e.key === ' ') { e.preventDefault(); player?.toggle(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
      else if (e.metaKey || e.ctrlKey || e.altKey) return;
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); split(); }
      else if (e.key === 'v' || e.key === 'V') setTool('select');
      else if (e.key === 'r' || e.key === 'R') setTool('range');
      else if (e.key === 'c' || e.key === 'C') setTool('blade');
      else if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); addZoom(); }
      else if ((e.key === 'k' || e.key === 'K') && hasCamera) { e.preventDefault(); addCamera(); }
      else if ((e.key === 'b' || e.key === 'B') && hasCursor) { e.preventDefault(); addLens(); }
      else if (e.key === 'Escape') { setRange(null); store.select(null); setTool('select'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const actions: EditActions = { split, duplicate, deleteClip: removeClip, time: now };
  const duration = projectDuration(p);
  return (
    <div className="editor">
      <header className="toolbar">
        <button onClick={onClose} title={t('Ana ekrana dön (proje kaydedilir)')}>‹ {t('Projeler')}</button>
        <div className="title"><b data-raw>{p.name}</b><span>{saveStatusText(store.saveStatus)}</span></div>
        <div className="row">
          <button disabled={!store.canUndo} onClick={() => store.undo()} title={t('Geri Al')}>↶</button>
          <button disabled={!store.canRedo} onClick={() => store.redo()} title={t('Yinele')}>↷</button>
          <button className="settings-btn" onClick={onSettings} title={t('Ayarlar: dil ve tanılama')}>⚙</button>
          <button onClick={() => void odak().reveal(`${store.pkg}/project.json`)} title={t('Proje klasörünü göster')}>{t('Klasör')}</button>
          <button className="primary" onClick={() => setDialog('export')}>{t('Dışa Aktar')}</button>
        </div>
      </header>
      <div className="workspace">
        <div className="stage">
          <div className="preview">
            <canvas ref={canvasRef} style={{ aspectRatio: String(aspect) }} onClick={() => player?.toggle()} />
          </div>
          <div className="transport">
            <button className="ghost" onClick={() => step(-1)} title={t('Bir kare geri (←, Shift+← 10 kare)')}>⏮</button>
            <button className="ghost play" onClick={() => player?.toggle()} title={t('Oynat / Duraklat (boşluk)')}>{playing ? '❚❚' : '▶'}</button>
            <button className="ghost" onClick={() => step(1)} title={t('Bir kare ileri (→)')}>⏭</button>
            <span className="mono muted time">{timecode(time)} / {timecode(duration)}</span>
          </div>
        </div>
        <Inspector store={store} lib={lib} seek={seek} onDelete={deleteSelected} actions={actions} />
      </div>
      <Timeline store={store} lib={lib} time={time} playing={playing} seek={seek} scrubTo={scrubTo} range={range} setRange={setRange} tool={tool}
                hint={flash ?? (range ? t('{s} sn seçili · Sil, Ayır ya da ×2 / ×4', { s: (range.b - range.a).toFixed(2) }) : t(toolHints[tool]))} warn={!!flash}
                onDeleteRange={deleteSelected} onIsolate={isolate} onSpeed={speedUp} onCut={cutAt} onCamera={hasCamera ? addCamera : null} onLens={hasCursor ? addLens : null}
                bar={<>
                  <div className="tool-group modes">
                    <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title={t('Seç (V): tıkla seç, sürükle sırala, kenardan kırp')}>↖ {t('Seç')}</button>
                    <button className={tool === 'range' ? 'on' : ''} onClick={() => setTool('range')} title={t('Aralık (R): kliplerin üstünde sürükleyerek bir kısmı seç')}>↔ {t('Aralık')}</button>
                    <button className={tool === 'blade' ? 'on' : ''} onClick={() => setTool('blade')} title={t('Makas (C): klibe tıkladığın yerden böl')}>✂ {t('Makas')}</button>
                  </div>
                  <div className="tool-group">
                    <button onClick={split} title={t('Oynatma çizgisinden böl (S); aralık seçiliyse iki ucundan böler')}>┆ {t('Böl')}</button>
                    <button onClick={deleteSelected} disabled={!range && !sel} title={t('Seçili klibi, zoom\'u ya da aralığı sil (Sil)')}>⌫ {t('Sil')}</button>
                  </div>
                  <div className="tool-group">
                    <button onClick={() => void importVideos()} disabled={importing} title={t('Bilgisayardan video ekle')}>{importing ? t('Ekleniyor…') : `＋ ${t('Video')}`}</button>
                    <button onClick={() => setDialog('record')} disabled={busy} title={t('Bu projeye yeni bir ekran kaydı ekle')}>{t('● Kayıt')}</button>
                    <button onClick={() => setDialog('quiet')} title={t('Ekranın değişmediği, imlecin durduğu ve sesin olmadığı anları bul')}>⏩ {t('Durgun anlar')}</button>
                  </div>
                  <div className="tool-group">
                    <button onClick={addZoom} title={t('Oynatma çizgisinde yeni zoom (Z)')}>＋ {t('Zoom')}</button>
                    <button onClick={() => void regenerate()} title={t('Dokunulmamış otomatik zoom\'ları tıklamalardan yeniden üret; elle düzenlenenler korunur')}>✦ {t('Oto zoom')}</button>
                    <button onClick={addCamera} disabled={!hasCamera}
                            title={hasCamera ? t('Seçili aralıkta (ya da oynatma çizgisinden 3 sn) kamerayı başka yere taşı, büyüt ya da gizle (K)') : t('Bu projede kamera kaydı yok')}>📷 {t('Kamera')}</button>
                    <button onClick={addLens} disabled={!hasCursor}
                            title={hasCursor ? t('Seçili aralıkta (ya da oynatma çizgisinden 3 sn) imlecin altını büyüteçle göster (B)') : t('Büyüteç ekran kayıtlarında imleci takip eder')}>🔍 {t('Büyüteç')}</button>
                  </div>
                </>} />
      {dialog === 'export' && <ExportDialog store={store} lib={lib} onClose={() => setDialog(null)} range={range} time={now()} />}
      {dialog === 'quiet' && <QuietDialog store={store} lib={lib} onClose={() => setDialog(null)} />}
      {dialog === 'record' && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{t('Projeye kayıt ekle')}</h2>
            <p className="muted small">{t('Yeni kayıt bu projenin sonuna eklenir; otomatik zoom\'ları da oluşturulur.')}</p>
            <RecordSetup busy={busy} startLabel={`● ${t('Kaydı Başlat ve Ekle')}`} onStart={async (d, a, dev) => {
              const ok = await onRecordInto(d, a, dev);
              if (ok) setDialog(null);
              return ok;
            }} />
            <div className="row end"><button onClick={() => setDialog(null)}>{t('Vazgeç')}</button></div>
          </div>
        </div>
      )}
      {store.error && (
        <div className="modal-backdrop" onClick={() => store.setError(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <h3>Focara</h3><p className="pre">{store.error}</p>
            <div className="row end"><button className="primary" onClick={() => store.setError(null)}>{t('Tamam')}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- timeline

const INSET = 18;
const SNAP_PX = 7;

function Timeline({ store, lib, time, playing, seek, scrubTo, range, setRange, tool, bar, hint, warn, onDeleteRange, onIsolate, onSpeed, onCut, onCamera, onLens }: {
  store: EditorStore; lib: MediaLibrary; time: number; playing: boolean; seek: (t: number) => void; scrubTo: (t: number) => void;
  range: { a: number; b: number } | null; setRange: (r: { a: number; b: number } | null) => void;
  tool: Tool; bar: React.ReactNode; hint: string; warn: boolean;
  onDeleteRange: () => void; onIsolate: () => void; onSpeed: (s: number) => void; onCut: (t: number) => void;
  onCamera: (() => void) | null;
  onLens: (() => void) | null;
}) {
  const p = store.project;
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [drop, setDrop] = useState<{ clipID: string; index: number; x: number } | null>(null);
  const [envelopes, setEnvelopes] = useState<Map<string, Float32Array | null>>(new Map());
  const [scrubbing, setScrubbing] = useState(false);
  const [bladeAt, setBladeAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth((w) => (Math.abs(w - e.contentRect.width) < 0.5 ? w : e.contentRect.width)));
    ro.observe(scroller.current!);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (tool !== 'blade') setBladeAt(null); }, [tool]);
  // Waveforms (decoded once per media, in the background).
  const mediaKey = p.media.map((m) => m.id).join(',');
  useEffect(() => {
    let alive = true;
    for (const m of store.project.media) {
      void lib.envelope(m).then((e) => { if (alive) setEnvelopes((old) => new Map(old).set(m.id, e)); });
    }
    return () => { alive = false; };
  }, [lib, mediaKey, store]);

  const total = projectDuration(p);
  const duration = Math.max(total, 0.5);
  const pps = ((width - INSET * 2) / duration) * zoom;
  const inner = Math.max(width, INSET * 2 + duration * pps);
  const starts = clipStarts(p);
  const xOf = (t: number) => INSET + t * pps;
  const tOf = (clientX: number) => {
    const el = scroller.current!;
    return (clientX - el.getBoundingClientRect().left + el.scrollLeft - INSET) / pps;
  };
  const clampT = (t: number) => Math.max(0, Math.min(total, t));

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = xOf(time);
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 80;
  });

  const zoomBy = (f: number, anchorClientX?: number) => {
    const el = scroller.current!;
    const anchorT = anchorClientX !== undefined ? tOf(anchorClientX) : time;
    const next = Math.min(80, Math.max(1, zoom * f));
    setZoom(next);
    requestAnimationFrame(() => {
      const npps = ((width - INSET * 2) / duration) * next;
      const off = anchorClientX !== undefined ? anchorClientX - el.getBoundingClientRect().left : el.clientWidth / 2;
      el.scrollLeft = INSET + anchorT * npps - off;
    });
  };

  /**
   * Follows one drag until the button is released. Listens on the whole window (the release may
   * happen anywhere, and pointer capture can't be relied on: the up event may land on whatever
   * moved under the pointer, such as the playhead). A real move with no button held means the
   * release was missed (e.g. outside the window): the drag ends there, so hovering never drags.
   */
  const drag = (e: React.PointerEvent, onMove: (ev: PointerEvent, dx: number) => void, onUp?: (ev: PointerEvent, moved: boolean) => void) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ }
    const x0 = e.clientX;
    let moved = false, done = false, last: PointerEvent = e.nativeEvent;
    const finish = (ev: PointerEvent) => {
      if (done) return;
      done = true;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', lost);
      onUp?.(ev, moved);
    };
    const move = (ev: PointerEvent) => {
      if (ev.isTrusted && ev.buttons === 0) { finish(last); return; }
      last = ev;
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      onMove(ev, ev.clientX - x0);
    };
    const lost = () => finish(last);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', lost);
  };
  // While dragging near an edge of the visible area, scroll along.
  const follow = (clientX: number) => {
    const el = scroller.current!, r = el.getBoundingClientRect();
    if (clientX < r.left + 30) el.scrollLeft -= 24;
    else if (clientX > r.right - 30) el.scrollLeft += 24;
  };

  /** Moves the playhead with the pointer (the preview follows frame by frame). */
  const scrub = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setScrubbing(true);
    seek(clampT(tOf(e.clientX)));
    // While dragging: quick key-frame previews; on release: the exact frame.
    drag(e, (ev) => { follow(ev.clientX); scrubTo(clampT(tOf(ev.clientX))); }, (ev) => { setScrubbing(false); seek(clampT(tOf(ev.clientX))); });
  };

  /** Drags out a time range (Aralık tool, or Shift+drag with any tool). */
  const selectRange = (e: React.PointerEvent) => {
    const t0 = clampT(tOf(e.clientX));
    store.select(null);
    drag(e, (ev, dx) => {
      if (Math.abs(dx) < 4) return;
      follow(ev.clientX);
      const t1 = clampT(tOf(ev.clientX));
      setRange({ a: Math.min(t0, t1), b: Math.max(t0, t1) });
    }, (_ev, moved) => { if (!moved) { setRange(null); seek(t0); } });
  };
  const rangeEdge = (which: 'a' | 'b') => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!range) return;
    const r0 = range;
    drag(e, (ev) => {
      follow(ev.clientX);
      const t = clampT(tOf(ev.clientX));
      const a = which === 'a' ? t : r0.a, b = which === 'b' ? t : r0.b;
      setRange({ a: Math.min(a, b), b: Math.max(a, b) });
    });
  };

  /** Where the scissors would cut: under the pointer, snapping to the playhead. */
  const cutTime = (clientX: number) => {
    let t = tOf(clientX);
    if (Math.abs(t - time) * pps < SNAP_PX) t = time;
    return t > 0 && t < total ? t : null;
  };

  // Lanes (clips and zooms pass the event on when the tool isn't "select").
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (tool === 'blade') { const t = cutTime(e.clientX); if (t !== null) onCut(t); return; }
    if (tool === 'range' || e.shiftKey) { selectRange(e); return; }
    store.select(null); setRange(null);
    scrub(e);
  };

  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const tick = steps.find((s) => s * pps >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += tick) ticks.push(t);

  return (
    <div className="timeline-wrap">
      <div className="timeline-bar">
        <div className="bar-tools">{bar}</div>
        <span className={`bar-hint ${warn ? 'warn' : ''}`} title={hint}>{hint}</span>
        <div className="bar-zoom">
          <button className="ghost tiny" onClick={() => zoomBy(1 / 1.6)} title={t('Uzaklaştır')}>−</button>
          <button className="ghost tiny" onClick={() => zoomBy(1.6)} title={t('Yakınlaştır (Ctrl/⌘ + tekerlek)')}>＋</button>
          <button className="ghost tiny" onClick={() => setZoom(1)} title={t('Tümünü sığdır')}>⤢</button>
        </div>
      </div>
      <div className={`timeline tool-${tool}`} ref={scroller}
           onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX); } }}>
        <div className="timeline-inner" style={{ width: inner }} onPointerDown={down}
             onPointerMove={(e) => { if (tool === 'blade') setBladeAt(cutTime(e.clientX)); }}
             onPointerLeave={() => setBladeAt(null)}>
          <div className="ruler" onPointerDown={scrub} title={t('Tıkla ya da sürükle: oynatma çizgisini taşı')}>
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: xOf(t) }}><span>{timecode(t, tick < 1)}</span></div>
            ))}
          </div>
          {range && (
            <div className="range" style={{ left: xOf(range.a), width: Math.max(2, (range.b - range.a) * pps) }}>
              <div className="range-handle l" onPointerDown={rangeEdge('a')} title={t('Aralığın başı')} />
              <div className="range-handle r" onPointerDown={rangeEdge('b')} title={t('Aralığın sonu')} />
              <div className="range-bar" onPointerDown={(e) => e.stopPropagation()}>
                <span className="mono">{t('{s} sn', { s: (range.b - range.a).toFixed(2) })}</span>
                <button onClick={onDeleteRange} title={t('Bu kısmı sil (Sil)')}>⌫ {t('Sil')}</button>
                <button onClick={onIsolate} title={t('Bu kısmı ayrı bir klip yap (S)')}>┆ {t('Ayır')}</button>
                <button onClick={() => onSpeed(2)} title={t('Bu kısmı 2 kat hızlı oynat')}>⏩ ×2</button>
                <button onClick={() => onSpeed(4)} title={t('Bu kısmı 4 kat hızlı oynat')}>⏩ ×4</button>
                {onCamera && <button onClick={onCamera} title={t('Bu kısımda kamerayı başka yere taşı, büyüt ya da gizle')}>📷 {t('Kamera')}</button>}
                {onLens && <button onClick={onLens} title={t('Bu kısımda imlecin altını büyüteçle göster')}>🔍 {t('Büyüteç')}</button>}
              </div>
            </div>
          )}
          <div className="lane-label">{t('ZOOM')}</div>
          {onCamera && <div className="lane-label cam">{t('KAMERA')}</div>}
          {onLens && <div className="lane-label lens">{t('BÜYÜTEÇ')}</div>}
          {p.clips.map((clip, i) => {
            const x = xOf(starts[i]), w = clipDuration(clip) * pps;
            const media = assetOf(p, clip.mediaID);
            const selected = store.selection?.kind === 'clip' && store.selection.clipID === clip.id;
            return (
              <div key={clip.id}>
                <ClipBlock store={store} clip={clip} media={media} index={i} left={x} width={w} pps={pps} selected={selected} tool={tool}
                           envelope={envelopes.get(clip.mediaID) ?? null} drag={drag} time={time} clipStart={starts[i]}
                           seek={seek} tOf={tOf} starts={starts} setDrop={setDrop} xOf={xOf} />
                {clip.zooms.map((z) => {
                  const s = Math.max(z.start, clip.sourceStart), e = Math.min(z.end, clip.sourceEnd);
                  if (e <= s) return null;
                  return <ZoomBlock key={z.id} store={store} clip={clip} zoom={z} pps={pps} seek={seek} tool={tool}
                                    left={x + toLocal(clip, s) * pps} width={Math.max(toLocal(clip, e) * pps - toLocal(clip, s) * pps, 6)}
                                    toTimeline={(src) => starts[i] + toLocal(clip, src)} drag={drag} />;
                })}
                {onCamera && (clip.cameraSegments ?? []).map((cs) => {
                  const s = Math.max(cs.start, clip.sourceStart), e = Math.min(cs.end, clip.sourceEnd);
                  if (e <= s) return null;
                  return <SegmentBlock key={cs.id} kind="camera" className={`cam-seg ${cs.mode}`} label={cameraLabel(cs)} title={t('Kamera bölümü')}
                                       update={(q, f) => updateCameraSegment(q, clip.id, cs.id, f)}
                                       store={store} clip={clip} seg={cs} pps={pps} seek={seek} tool={tool} drag={drag}
                                       left={x + toLocal(clip, s) * pps} width={Math.max(toLocal(clip, e) * pps - toLocal(clip, s) * pps, 6)}
                                       toTimeline={(src) => starts[i] + toLocal(clip, src)} />;
                })}
                {onLens && (clip.magnifiers ?? []).map((ms) => {
                  const s = Math.max(ms.start, clip.sourceStart), e = Math.min(ms.end, clip.sourceEnd);
                  if (e <= s) return null;
                  return <SegmentBlock key={ms.id} kind="magnifier" className="lens-seg" label={lensLabel(ms)} title={t('Büyüteç')}
                                       update={(q, f) => updateMagnifier(q, clip.id, ms.id, f)}
                                       store={store} clip={clip} seg={ms} pps={pps} seek={seek} tool={tool} drag={drag}
                                       left={x + toLocal(clip, s) * pps} width={Math.max(toLocal(clip, e) * pps - toLocal(clip, s) * pps, 6)}
                                       toTimeline={(src) => starts[i] + toLocal(clip, src)} />;
                })}
              </div>
            );
          })}
          {drop && <div className="drop-marker" style={{ left: drop.x }} />}
          {tool === 'blade' && bladeAt !== null && (
            <div className={`blade-line ${bladeAt === time ? 'snapped' : ''}`} style={{ left: xOf(bladeAt) }}><span>✂ {timecode(bladeAt)}</span></div>
          )}
          {/* Moved by a transform (its own layer): playing never repaints the timeline under it. */}
          <div className={`playhead ${scrubbing ? 'dragging' : ''}`} style={{ transform: `translateX(${xOf(time)}px)` }}>
            <div className="playhead-knob" onPointerDown={scrub} title={t('Tut ve sürükle: videoda ileri-geri git')} />
            {tool === 'select' && <div className="playhead-grip" onPointerDown={scrub} />}
            {scrubbing && <span className="playhead-time">{timecode(time)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClipBlock({ store, clip, media, index, left, width, pps, selected, tool, envelope, drag, time, clipStart, seek, tOf, starts, setDrop, xOf }: {
  store: EditorStore; clip: Clip; media: MediaAsset | undefined; index: number; left: number; width: number; pps: number;
  selected: boolean; tool: Tool; envelope: Float32Array | null; time: number; clipStart: number; starts: number[];
  drag: (e: React.PointerEvent, m: (ev: PointerEvent, dx: number) => void, u?: (ev: PointerEvent, moved: boolean) => void) => void;
  seek: (t: number) => void; tOf: (x: number) => number; xOf: (t: number) => number;
  setDrop: (d: { clipID: string; index: number; x: number } | null) => void;
}) {
  const speed = clip.speed || 1;
  // Body: click selects and seeks; drag reorders.
  const body = (e: React.PointerEvent) => {
    if (tool !== 'select' || e.shiftKey || e.button !== 0) return; // the timeline handles range / scissors
    e.stopPropagation();
    store.select({ kind: 'clip', clipID: clip.id });
    const clips = store.project.clips;
    let target = index;
    drag(e, (ev) => {
      const t = tOf(ev.clientX);
      target = clips.length;
      for (let k = 0; k < clips.length; k++) if (t < starts[k] + clipDuration(clips[k]) / 2) { target = k; break; }
      const x = target < clips.length ? xOf(starts[target]) : xOf(starts[clips.length - 1] + clipDuration(clips[clips.length - 1]));
      setDrop({ clipID: clip.id, index: target, x });
    }, (ev, moved) => {
      setDrop(null);
      if (!moved) { seek(tOf(ev.clientX)); return; }
      if (target !== index && target !== index + 1) store.update((q) => moveClip(q, clip.id, target));
    });
  };
  // Edges: trim (the end edge snaps to the playhead).
  const edge = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    store.select({ kind: 'clip', clipID: clip.id });
    const s0 = clip.sourceStart, e0 = clip.sourceEnd;
    drag(e, (_ev, dx) => {
      let src = (which === 'start' ? s0 : e0) + (dx / pps) * speed;
      if (which === 'end') {
        const edgeT = clipStart + (src - s0) / speed;
        if (Math.abs(edgeT - time) * pps < SNAP_PX) src = s0 + (time - clipStart) * speed;
      }
      store.update((q) => trimClip(q, clip.id, which, src), `trim-${clip.id}-${which}`);
      seek(which === 'start' ? clipStart : clipStart + (Math.max(src, s0) - s0) / speed - 0.001);
    });
  };
  return (
    <div className={`clip ${media?.kind === 'externalVideo' ? 'external' : ''} ${selected ? 'selected' : ''}`}
         style={{ left, width: Math.max(width, 2) }} onPointerDown={body}>
      <Waveform envelope={envelope} clip={clip} width={Math.max(width, 2)} />
      <span className="clip-label">
        {media?.kind === 'externalVideo' ? '🎞' : '🖥'} <span data-raw>{media?.displayName ?? '?'}</span> <i>{timecode(clipDuration(clip), false)}</i>
        {speed !== 1 && <b className="speed">×{speed}</b>}
        {media?.cameraFile && <i title={t('Kamera var')}> · 📷</i>}
      </span>
      <div className="trim l" onPointerDown={edge('start')} title={t('Başı kırp')} />
      <div className="trim r" onPointerDown={edge('end')} title={t('Sonu kırp (oynatma çizgisine yapışır)')} />
    </div>
  );
}

function Waveform({ envelope, clip, width }: { envelope: Float32Array | null; clip: Clip; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = Math.min(Math.round(width), 4096), h = 50, dpr = 2;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!envelope) return;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    const step = MediaLibrary.ENVELOPE_STEP, len = clip.sourceEnd - clip.sourceStart;
    for (let x = 0; x < w; x++) {
      const a = clip.sourceStart + (x / w) * len, b = clip.sourceStart + ((x + 1) / w) * len;
      let v = 0;
      for (let k = Math.floor(a / step); k <= Math.floor(b / step) && k < envelope.length; k++) v = Math.max(v, envelope[k] ?? 0);
      const bh = Math.max(1, Math.min(1, v * 1.6) * h * 0.9) * dpr;
      ctx.fillRect(x * dpr, (h * dpr - bh) / 2, dpr, bh);
    }
  }, [envelope, clip.sourceStart, clip.sourceEnd, width]);
  return <canvas ref={ref} className="wave" style={{ width: Math.min(width, 4096) }} />;
}

function ZoomBlock({ store, clip, zoom, pps, left, width, seek, toTimeline, drag, tool }: {
  store: EditorStore; clip: Clip; zoom: ZoomSegment; pps: number; left: number; width: number; tool: Tool;
  seek: (t: number) => void; toTimeline: (src: number) => number;
  drag: (e: React.PointerEvent, m: (ev: PointerEvent, dx: number) => void, u?: (ev: PointerEvent, moved: boolean) => void) => void;
}) {
  const selected = store.selection?.kind === 'zoom' && store.selection.zoomID === zoom.id;
  const speed = clip.speed || 1;
  const start = (part: 'body' | 'left' | 'right') => (e: React.PointerEvent) => {
    if (tool !== 'select' || e.shiftKey || e.button !== 0) return;
    e.stopPropagation();
    const snap = { ...zoom };
    store.select({ kind: 'zoom', clipID: clip.id, zoomID: zoom.id });
    drag(e, (_ev, dx) => {
      if (Math.abs(dx) < 2) return;
      const d = (dx / pps) * speed;
      store.update((q) => updateZoom(q, clip.id, zoom.id, (z) => {
        if (part === 'body') return { ...z, start: snap.start + d, end: snap.end + d };
        if (part === 'left') return { ...z, start: Math.min(snap.start + d, snap.end - 0.3) };
        return { ...z, end: Math.max(snap.end + d, snap.start + 0.3) };
      }), `drag-${zoom.id}`);
      seek(toTimeline(part === 'right' ? snap.end + d : snap.start + d));
    });
  };
  return (
    <div className={`zoom ${zoom.isGenerated ? 'auto' : 'manual'} ${selected ? 'selected' : ''}`} style={{ left, width }}
         onPointerDown={start('body')} title={zoom.isGenerated ? t('Otomatik zoom · sürükle: taşı · kenarlar: süre') : t('Düzenlenmiş zoom · sürükle: taşı · kenarlar: süre')}>
      <div className="handle l" onPointerDown={start('left')} />
      <span>{isFollow(zoom.focus) ? '➚' : '⌖'} ×{zoom.scale.toFixed(1)}</span>
      <div className="handle r" onPointerDown={start('right')} />
    </div>
  );
}

const cameraLabel = (seg: CameraSegment) =>
  seg.mode === 'full' ? `⛶ ${t('Tam ekran')}` : seg.mode === 'hidden' ? `⊘ ${t('Gizli')}` : `📷 ${t(cameraPositions.find((p) => p.id === seg.position)?.title ?? '')}`;

const lensLabel = (seg: MagnifierSegment) => `🔍 ×${seg.zoom.toFixed(1)}`;

/** A camera layout or magnifier block: drag to move, drag the edges to resize, click for its settings. */
function SegmentBlock<T extends { id: string; start: number; end: number }>({ kind, className, label, title, update, store, clip, seg, pps, left, width, seek, toTimeline, drag, tool }: {
  kind: 'camera' | 'magnifier'; className: string; label: string; title: string;
  update: (q: Project, change: (s: T) => T) => Project;
  store: EditorStore; clip: Clip; seg: T; pps: number; left: number; width: number; tool: Tool;
  seek: (t: number) => void; toTimeline: (src: number) => number;
  drag: (e: React.PointerEvent, m: (ev: PointerEvent, dx: number) => void, u?: (ev: PointerEvent, moved: boolean) => void) => void;
}) {
  const selected = store.selection?.kind === kind && store.selection.segID === seg.id;
  const speed = clip.speed || 1;
  const start = (part: 'body' | 'left' | 'right') => (e: React.PointerEvent) => {
    if (tool !== 'select' || e.shiftKey || e.button !== 0) return;
    e.stopPropagation();
    const snap = { ...seg };
    store.select({ kind, clipID: clip.id, segID: seg.id });
    drag(e, (_ev, dx) => {
      if (Math.abs(dx) < 2) return;
      const d = (dx / pps) * speed;
      store.update((q) => update(q, (z) => {
        if (part === 'body') return { ...z, start: snap.start + d, end: snap.end + d };
        if (part === 'left') return { ...z, start: Math.min(snap.start + d, snap.end - 0.2) };
        return { ...z, end: Math.max(snap.end + d, snap.start + 0.2) };
      }), `drag-${seg.id}`);
      seek(toTimeline(part === 'right' ? snap.end + d : snap.start + d));
    }, (_ev, moved) => { if (!moved) seek(toTimeline(seg.start)); });
  };
  return (
    <div className={`${className} ${selected ? 'selected' : ''}`} style={{ left, width }} onPointerDown={start('body')}
         title={t('{what} · sürükle: taşı · kenarlar: süre · tıkla: ayarları sağda', { what: title })}>
      <div className="handle l" onPointerDown={start('left')} />
      <span>{label}</span>
      <div className="handle r" onPointerDown={start('right')} />
    </div>
  );
}
