import { useRef, useState } from 'react';
import { odak } from '../bridge.ts';
import { type ExportSettings, canvasSize, projectDuration, resolutions } from '../core/model.ts';
import { exportProject } from '../media/exporter.ts';
import type { MediaLibrary } from '../media/media.ts';
import { timecode } from './Editor.tsx';
import type { EditorStore } from './store.ts';

export function ExportDialog({ store, lib, onClose }: { store: EditorStore; lib: MediaLibrary; onClose: () => void }) {
  const [settings, setSettings] = useState<ExportSettings>(store.project.export);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(0);
  const size = canvasSize(store.project, settings);
  const set = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const start = async () => {
    const path = await odak().saveVideoDialog(`${store.project.name}.mp4`);
    if (!path) return;
    store.update((p) => ({ ...p, export: settings }));
    await store.flush();
    setError(null); setResult(null); setProgress(0); started.current = performance.now();
    abort.current = new AbortController();
    try {
      await exportProject(store.project, lib, path, settings, setProgress, abort.current.signal);
      setResult(path);
    } catch (e) {
      setError((e as Error).name === 'AbortError' ? 'Dışa aktarma iptal edildi.' : (e as Error).message);
    }
    setProgress(null);
  };

  const remaining = () => {
    if (progress === null || progress < 0.02) return 'Hazırlanıyor…';
    const el = (performance.now() - started.current) / 1000;
    return `%${Math.round(progress * 100)} · yaklaşık ${Math.round((el / progress) * (1 - progress))} sn kaldı`;
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Video Dışa Aktar</h2>
        <fieldset disabled={progress !== null} className="form">
          <label>Çözünürlük<select value={settings.resolution} onChange={(e) => set('resolution', e.target.value as ExportSettings['resolution'])}>
            {resolutions.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
          <label>En-boy<select value={settings.aspect} onChange={(e) => set('aspect', e.target.value as ExportSettings['aspect'])}>
            <option value="wide">16:9</option><option value="recording">Kayıtla aynı</option></select></label>
          <label>Kare hızı<select value={settings.fps} onChange={(e) => set('fps', Number(e.target.value))}>
            <option value={30}>30 fps</option><option value={60}>60 fps</option></select></label>
          <label>Kodek<select value={settings.codec} onChange={(e) => set('codec', e.target.value as ExportSettings['codec'])}>
            <option value="h264">H.264 (en uyumlu)</option><option value="hevc">HEVC (daha küçük)</option></select></label>
          <div className="row between"><span>Çıktı</span><span className="mono">{size.width}×{size.height} MP4 · {timecode(projectDuration(store.project), false)}</span></div>
        </fieldset>
        {progress !== null && <div className="progress"><div style={{ width: `${progress * 100}%` }} /><span>{remaining()}</span></div>}
        {result && <p className="ok">✓ Hazır: {result.replace(/^.*[\\/]/, '')}</p>}
        {error && <p className="err">{error}</p>}
        <div className="row between">
          <span className="row">
            {result && <><button onClick={() => void odak().reveal(result)}>Klasörde Göster</button><button onClick={() => void odak().openPath(result)}>Aç</button></>}
          </span>
          <span className="row">
            {progress !== null
              ? <button onClick={() => abort.current?.abort()}>İptal</button>
              : <><button onClick={onClose}>Kapat</button><button className="primary" onClick={() => void start()}>Dışa Aktar…</button></>}
          </span>
        </div>
      </div>
    </div>
  );
}
