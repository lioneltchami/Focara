import { useCallback, useEffect, useRef, useState } from 'react';
import { type DisplayInfo, type RecordingFinished, odak } from '../bridge.ts';
import { type MediaAsset, type Project, newClip, newProject, normalizeProject } from '../core/model.ts';
import { generateAutoZooms } from '../core/zoom.ts';
import { Editor } from './Editor.tsx';
import { EditorStore } from './store.ts';
import './styles.css';

const baseName = (p: string) => p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '').replace(/\.(odak|kadraj)$/, '');
const mod = odak().platform === 'darwin' ? '⌘' : 'Ctrl+';

export function App() {
  const [store, setStore] = useState<EditorStore | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const storeRef = useRef(store);
  storeRef.current = store;

  const openProject = useCallback(async (pkg: string, project?: Project) => {
    const r = project ? { project } : await odak().loadProject(pkg);
    if (!r.project) { setAlert(r.error ?? 'Proje açılamadı.'); return; }
    await storeRef.current?.flush();
    await odak().addRecent(pkg);
    setStore(new EditorStore(pkg, normalizeProject(r.project)));
  }, []);

  // Test hooks for the headless UI test (never set in normal use).
  if (odak().isUiTest) Object.assign(window, { __odak: { openProject, store } });

  const closeProject = useCallback(async () => {
    await storeRef.current?.flush();
    setStore(null);
  }, []);

  const showOpen = useCallback(async () => {
    const pkg = await odak().openProjectDialog();
    if (pkg) await openProject(pkg);
  }, [openProject]);

  // A finished recording becomes a project with automatic zooms, then opens in the editor.
  useEffect(() => odak().onRecordingFinished(async (r: RecordingFinished) => {
    setBusy(false);
    if (!r.ok) { setAlert(r.error); return; }
    const { info } = r;
    const track = await odak().readCursor(r.pkg, info.cursor);
    const asset: MediaAsset = {
      id: r.mediaID, kind: 'screenRecording', displayName: 'Ekran kaydı', videoFile: info.video,
      systemAudioFile: info.systemAudio ?? undefined, microphoneFile: info.microphone ?? undefined,
      cursorFile: info.cursor, duration: info.duration, pixelWidth: info.width, pixelHeight: info.height,
      pixelsPerPoint: info.pixelsPerPoint, recordedAt: r.startedAt,
    };
    const project = newProject(baseName(r.pkg));
    project.media = [asset];
    const clip = newClip(asset.id, 0, info.duration);
    clip.zooms = track ? generateAutoZooms(track, info.duration) : [];
    project.clips = [clip];
    await odak().saveProject(r.pkg, project);
    await openProject(r.pkg, project);
  }), [openProject]);

  useEffect(() => odak().onMenu((cmd) => {
    const s = storeRef.current;
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
    if (cmd === 'new') void closeProject();
    else if (cmd === 'open') void showOpen();
    else if (cmd === 'export') window.dispatchEvent(new Event('odak:export'));
    else if (cmd === 'undo') { if (typing) document.execCommand('undo'); else s?.undo(); }
    else if (cmd === 'redo') { if (typing) document.execCommand('redo'); else s?.redo(); }
  }), [closeProject, showOpen]);

  return (
    <>
      {store
        ? <Editor key={store.pkg} store={store} onClose={closeProject} />
        : <Home onOpen={openProject} onShowOpen={showOpen} busy={busy} setBusy={setBusy} setAlert={setAlert} />}
      {alert && (
        <div className="modal-backdrop" onClick={() => setAlert(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <h3>Odak</h3>
            <p className="pre">{alert}</p>
            <div className="row end"><button className="primary" onClick={() => setAlert(null)}>Tamam</button></div>
          </div>
        </div>
      )}
    </>
  );
}

function Home({ onOpen, onShowOpen, busy, setBusy, setAlert }: {
  onOpen: (pkg: string) => void; onShowOpen: () => void; busy: boolean;
  setBusy: (b: boolean) => void; setAlert: (s: string) => void;
}) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [display, setDisplay] = useState<number | null>(null);
  const [systemAudio, setSystemAudio] = useState(true);
  const [microphone, setMicrophone] = useState(false);
  const [permission, setPermission] = useState<string>('granted');
  const [available, setAvailable] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [recents, setRecents] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const d = await odak().displays();
    setDisplays(d);
    setDisplay((cur) => (cur !== null && d.some((x) => x.id === cur) ? cur : d.find((x) => x.primary)?.id ?? d[0]?.id ?? null));
    setPermission(await odak().screenPermission());
    setAvailable(await odak().captureAvailable());
    setRecents(await odak().recents());
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const start = async () => {
    if (display === null) return;
    setBusy(true);
    const r = await odak().startRecording({ displayId: display, systemAudio, microphone });
    if (!r.ok) { setBusy(false); setAlert(r.error); void refresh(); }
  };

  const needsPermission = odak().platform === 'darwin' && permission !== 'granted';

  return (
    <div className="home">
      <section className="record">
        <div className="hero-icon">◎</div>
        <h1>Yeni kayıt</h1>
        <p className="muted center">
          Ekranı imleç olmadan kaydeder; imleci ve tıklamaları ayrıca saklar.<br />
          Zoom'lar tıklamalardan otomatik oluşur, sonra hepsini düzenleyebilirsin.
        </p>
        {!available.ok && <div className="notice warn">{available.reason}</div>}
        {needsPermission && (
          <div className="notice warn">
            <b>Ekran kaydı izni gerekiyor.</b> Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Sesi Kaydı'nda
            Odak'ı aç. macOS izin verildikten sonra uygulamanın yeniden başlatılmasını isteyebilir.
            <div className="row"><button className="primary" onClick={async () => {
                if (!(await odak().requestScreenPermission())) await odak().openPermissionSettings();
                void refresh();
              }}>İzin İste / Ayarları Aç</button>
              <button onClick={() => void refresh()}>Yeniden Denetle</button></div>
          </div>
        )}
        <div className="form">
          <label>Ekran
            <select value={display ?? ''} onChange={(e) => setDisplay(Number(e.target.value))}>
              {displays.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.width}×{d.height}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={systemAudio} onChange={(e) => setSystemAudio(e.target.checked)} /> Sistem sesini kaydet</label>
          <label className="check"><input type="checkbox" checked={microphone} onChange={(e) => setMicrophone(e.target.checked)} /> Mikrofonu kaydet</label>
        </div>
        <button className="record-btn" disabled={busy || display === null || !available.ok} onClick={() => void start()}>
          {busy ? 'Başlatılıyor…' : '● Kaydı Başlat'}
        </button>
        <p className="muted small">Durdurmak için ekranın üstündeki paneli ya da {mod}Shift+2'yi kullan.</p>
      </section>
      <aside className="projects">
        <div className="row between"><h2>Projeler</h2><button onClick={onShowOpen}>Aç…</button></div>
        {recents.length === 0
          ? <p className="muted small">Henüz proje yok. Kayıtlar Filmler/Videolar klasöründeki “Odak” klasörüne kaydedilir.</p>
          : <ul className="recent">{recents.map((p) => (
              <li key={p}><button className="link" onClick={() => onOpen(p)}>
                <span className="name">{baseName(p)}</span><span className="path">{p}</span>
              </button><button className="ghost" title="Klasörde göster" onClick={() => void odak().reveal(p)}>↗</button></li>
            ))}</ul>}
      </aside>
    </div>
  );
}
