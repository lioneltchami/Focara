import { useEffect, useRef, useState } from 'react';
import { canEncodeVideo } from 'mediabunny';
import { odak } from '../bridge.ts';
import {
  type Aspect, type ExportFormat, type ExportSettings, type VideoCodecChoice, codecTitles, defaultExport, exportFormats, formatOf,
  projectDuration, resolutions,
} from '../core/model.ts';
import { codecIds, exportProject, outputSize } from '../media/exporter.ts';
import type { MediaLibrary } from '../media/media.ts';
import { timecode } from './Editor.tsx';
import type { EditorStore } from './store.ts';
import { N, t } from '../i18n/index.ts';

export const aspects: { id: Aspect; title: string }[] = [
  { id: 'wide', title: N('16:9 yatay') }, { id: 'vertical', title: N('9:16 dikey (Shorts, Reels)') },
  { id: 'square', title: N('1:1 kare') }, { id: 'recording', title: N('Kayıtla aynı') },
];

export function ExportDialog({ store, lib, onClose, range, time }: {
  store: EditorStore; lib: MediaLibrary; onClose: () => void; range: { a: number; b: number } | null; time: number;
}) {
  const [settings, setSettings] = useState<ExportSettings>({ ...defaultExport(), ...store.project.export });
  const [onlyRange, setOnlyRange] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usable, setUsable] = useState<Partial<Record<VideoCodecChoice, boolean>>>({});
  const abort = useRef<AbortController | null>(null);
  const started = useRef(0);
  const fmt = formatOf(settings.format);
  const size = outputSize(store.project, settings);
  const total = projectDuration(store.project);
  const span = onlyRange && range ? { from: range.a, to: range.b } : { from: 0, to: total };
  const set = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) => {
    setSettings((s) => ({ ...s, [k]: v }));
    // The frame shape is part of the look: the preview follows it right away.
    if (k === 'aspect') store.update((p) => ({ ...p, export: { ...p.export, aspect: v as Aspect } }), 'export-aspect');
  };

  // Which video codecs this computer can encode at this size.
  useEffect(() => {
    let alive = true;
    void Promise.all((['h264', 'hevc', 'av1', 'vp9'] as const).map(async (c) =>
      [c, await canEncodeVideo(codecIds[c], { width: size.width, height: size.height }).catch(() => false)] as const))
      .then((r) => { if (alive) setUsable(Object.fromEntries(r)); });
    return () => { alive = false; };
  }, [size.width, size.height]);

  const pickFormat = (f: ExportFormat) => setSettings((s) => {
    const codecs = formatOf(f).codecs;
    return { ...s, format: f, codec: codecs && !codecs.includes(s.codec) ? codecs[0] : s.codec };
  });

  const start = async () => {
    const path = await odak().saveExportDialog(store.project.name, fmt.ext, t(fmt.title));
    if (!path) return;
    store.update((p) => ({ ...p, export: settings }));
    await store.flush();
    setError(null); setResult(null); setProgress(0); started.current = performance.now();
    abort.current = new AbortController();
    try {
      await exportProject(store.project, lib, path, settings, setProgress, abort.current.signal,
        { range: onlyRange && range ? span : undefined, frameTime: time });
      setResult(path);
    } catch (e) {
      setError((e as Error).name === 'AbortError' ? t('Dışa aktarma iptal edildi.') : (e as Error).message);
    }
    setProgress(null);
  };

  const remaining = () => {
    if (progress === null || progress < 0.02) return t('Hazırlanıyor…');
    const el = (performance.now() - started.current) / 1000;
    return t('%{p} · yaklaşık {s} sn kaldı', { p: Math.round(progress * 100), s: Math.round((el / progress) * (1 - progress)) });
  };
  const length = timecode(span.to - span.from, false);
  const summary = fmt.kind === 'image' ? `${size.width}×${size.height} PNG · ${t('{time} anındaki kare', { time: timecode(time) })}`
    : fmt.kind === 'audio' ? `${t(fmt.title)} · ${length}`
    : fmt.kind === 'gif' ? `${size.width}×${size.height} GIF · ${settings.gifFps} fps · ${length} · ${t('sessiz')}`
    : `${size.width}×${size.height} ${t(fmt.title)} · ${settings.fps} fps · ${length}`;

  return (
    <div className="modal-backdrop">
      <div className="modal export">
        <h2>{t('Dışa Aktar')}</h2>
        <fieldset disabled={progress !== null} className="form">
          <div className="formats">
            {exportFormats.map((f) => (
              <button key={f.id} className={`format ${settings.format === f.id ? 'on' : ''}`} onClick={() => pickFormat(f.id)}>
                <b>{t(f.title)}</b><span>{t(f.note)}</span>
              </button>
            ))}
          </div>
          {(fmt.kind === 'video' || fmt.kind === 'image') && (
            <label>{t('Çözünürlük')}<select value={settings.resolution} onChange={(e) => set('resolution', e.target.value as ExportSettings['resolution'])}>
              {resolutions.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
          )}
          {fmt.kind !== 'audio' && (
            <label>{t('En-boy')}<select value={settings.aspect} onChange={(e) => set('aspect', e.target.value as Aspect)}>
              {aspects.map((a) => <option key={a.id} value={a.id}>{t(a.title)}</option>)}</select></label>
          )}
          {fmt.kind === 'video' && <>
            <label>{t('Kare hızı')}<select value={settings.fps} onChange={(e) => set('fps', Number(e.target.value))}>
              {[24, 30, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}</select></label>
            <label>{t('Kodek')}<select value={settings.codec} onChange={(e) => set('codec', e.target.value as VideoCodecChoice)}>
              {fmt.codecs!.map((c) => <option key={c} value={c} disabled={usable[c] === false}>{t(codecTitles[c])}{usable[c] === false ? ` — ${t('bu bilgisayarda yok')}` : ''}</option>)}
            </select></label>
            <label>{t('Kalite')}<select value={settings.quality} onChange={(e) => set('quality', e.target.value as ExportSettings['quality'])}>
              <option value="high">{t('Yüksek')}</option><option value="medium">{t('Orta')}</option><option value="small">{t('Küçük dosya')}</option></select></label>
          </>}
          {fmt.kind === 'gif' && <>
            <label>{t('Genişlik')}<select value={settings.gifWidth} onChange={(e) => set('gifWidth', Number(e.target.value))}>
              {[480, 640, 800, 960, 1280].map((w) => <option key={w} value={w}>{w} px</option>)}</select></label>
            <label>{t('Kare hızı')}<select value={settings.gifFps} onChange={(e) => set('gifFps', Number(e.target.value))}>
              {[10, 15, 20, 25].map((f) => <option key={f} value={f}>{f} fps</option>)}</select></label>
            {span.to - span.from > 30 && <p className="muted small">{t('Uzun GIF\'ler çok büyük olur. Zaman çizelgesinde bir aralık seçip yalnızca onu aktarabilirsin.')}</p>}
          </>}
          {fmt.kind === 'image' && <p className="muted small">{t('Oynatma çizgisinin olduğu kare kaydedilir; YouTube kapak görseli için iyi bir başlangıç.')}</p>}
          {range && fmt.kind !== 'image' && (
            <label className="check"><input type="checkbox" checked={onlyRange} onChange={(e) => setOnlyRange(e.target.checked)} />
              {t('Yalnızca seçili aralık ({from} – {to})', { from: timecode(range.a), to: timecode(range.b) })}</label>
          )}
          <div className="row between"><span>{t('Çıktı')}</span><span className="mono">{summary}</span></div>
        </fieldset>
        {progress !== null && <div className="progress"><div style={{ width: `${progress * 100}%` }} /><span>{remaining()}</span></div>}
        {result && <p className="ok">✓ {t('Hazır: {file}', { file: result.replace(/^.*[\\/]/, '') })}</p>}
        {error && <p className="err">{error}</p>}
        <div className="row between">
          <span className="row">
            {result && <><button onClick={() => void odak().reveal(result)}>{t('Klasörde Göster')}</button><button onClick={() => void odak().openPath(result)}>{t('Aç')}</button></>}
          </span>
          <span className="row">
            {progress !== null
              ? <button onClick={() => abort.current?.abort()}>{t('İptal')}</button>
              : <><button onClick={onClose}>{t('Kapat')}</button><button className="primary" onClick={() => void start()}>{t('Dışa Aktar…')}</button></>}
          </span>
        </div>
      </div>
    </div>
  );
}
