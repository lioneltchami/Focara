import { useCallback, useEffect, useRef, useState } from 'react';
import { type RecordingFinished, odak } from '../bridge.ts';
import { type MediaAsset, type Project, newClip, newProject, normalizeProject } from '../core/model.ts';
import { generateAutoZooms } from '../core/zoom.ts';
import { insertClip } from '../core/edit.ts';
import { type SideDevices, type SideResult, SideRecorder } from '../media/sideRecorder.ts';
import { Editor } from './Editor.tsx';
import { RecordSetup } from './RecordSetup.tsx';
import { EditorStore } from './store.ts';
import './styles.css';

const baseName = (p: string) => p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '').replace(/\.(odak|kadraj)$/, '');

export function App() {
  const [store, setStore] = useState<EditorStore | null>(null);
  const [alert, setAlertState] = useState<{ text: string; permission: boolean } | null>(null);
  const setAlert = useCallback((text: string | null, permission = false) => {
    if (text) odak().log('alert', text);
    setAlertState(text ? { text, permission } : null);
  }, []);
  useEffect(() => {
    const onError = (e: ErrorEvent) => odak().log('error', e.message, e.error?.stack ?? '');
    const onReject = (e: PromiseRejectionEvent) => odak().log('unhandled', String(e.reason?.stack ?? e.reason));
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onReject);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onReject); };
  }, []);
  const [busy, setBusy] = useState(false);
  const storeRef = useRef(store);
  storeRef.current = store;
  // Camera + microphone recorder; lives here so it survives while the window is hidden.
  const side = useRef<SideRecorder | null>(null);
  // When set, the running recording is added to this open project instead of creating one.
  const appendTo = useRef<string | null>(null);

  const startRecording = useCallback(async (displayId: number, systemAudio: boolean, devices: SideDevices, intoProject?: string) => {
    setBusy(true);
    try {
      if (devices.micId) await odak().askMediaAccess('microphone');
      if (devices.cameraId) await odak().askMediaAccess('camera');
      side.current = await SideRecorder.open(devices);
    } catch (e) {
      setBusy(false);
      const err = e as Error;
      odak().log('camera/mic open failed', err.name, err.message, devices);
      const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      setAlert(denied
        ? 'macOS kameraya/mikrofona erişime izin vermedi. Uygulama güncellendiyse eski izin geçersiz kalmış olabilir: “İzinleri Sıfırla”ya bas, sonra kaydı yeniden başlatıp izin ver.'
        : `Kamera/mikrofon açılamadı: ${err.name}: ${err.message}`, denied);
      return false;
    }
    if (intoProject) await storeRef.current?.flush();
    const r = await odak().startRecording({ displayId, systemAudio, pkg: intoProject });
    if (!r.ok) {
      await side.current?.cancel(); side.current = null;
      setBusy(false); setAlert(r.error, r.code === 'permission');
      return false;
    }
    appendTo.current = intoProject ?? null;
    await side.current?.setTarget(r.pkg, r.mediaID, r.t0);
    return true;
  }, []);

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
    odak().log('recording finished', r.ok ? { pkg: r.pkg, info: r.info } : { error: r.error });
    const rec = side.current;
    side.current = null;
    if (!r.ok) { await rec?.cancel(); setBusy(false); setAlert(r.error); return; }
    const { info } = r;
    const extra: SideResult = rec ? await rec.stop(info.duration).catch((e): SideResult => { odak().log('camera/mic stop failed', String((e as Error).stack ?? e)); setAlert(`Kamera/mikrofon kaydı tamamlanamadı: ${(e as Error).message}`); return {}; }) : {};
    setBusy(false);
    const track = await odak().readCursor(r.pkg, info.cursor);
    const asset: MediaAsset = {
      id: r.mediaID, kind: 'screenRecording', displayName: 'Ekran kaydı', videoFile: info.video,
      systemAudioFile: info.systemAudio ?? undefined, microphoneFile: extra.micFile ?? info.microphone ?? undefined,
      cameraFile: extra.cameraFile, cursorFile: info.cursor, duration: info.duration, pixelWidth: info.width, pixelHeight: info.height,
      pixelsPerPoint: info.pixelsPerPoint, recordedAt: r.startedAt,
    };
    const clip = newClip(asset.id, 0, info.duration);
    clip.zooms = track ? generateAutoZooms(track, info.duration) : [];
    const target = appendTo.current;
    appendTo.current = null;
    const open = storeRef.current;
    if (target && open && open.pkg === r.pkg) {
      // “Kayıt Ekle”: the new recording goes to the end of the open project.
      open.update((p) => insertClip({ ...p, media: [...p.media, { ...asset, displayName: `Kayıt ${p.media.filter((m) => m.kind === 'screenRecording').length + 1}` }] }, clip));
      open.select({ kind: 'clip', clipID: clip.id });
      window.dispatchEvent(new CustomEvent('odak:seekToClip', { detail: clip.id }));
      return;
    }
    const project = newProject(baseName(r.pkg));
    project.media = [asset];
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
        ? <Editor key={store.pkg} store={store} onClose={closeProject} busy={busy}
                  onRecordInto={(d, a, dev) => startRecording(d, a, dev, store.pkg)} />
        : <Home onOpen={openProject} onShowOpen={showOpen} busy={busy} onStart={startRecording} />}
      {alert && (
        <div className="modal-backdrop" onClick={() => setAlert(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <h3>Odak</h3>
            <p className="pre">{alert.text}</p>
            <div className="row between">
              <button className="ghost" onClick={() => void odak().revealLog()}>Tanılama Kaydı</button>
              <span className="row">
                {alert.permission && odak().platform === 'darwin' && (
                  <button onClick={async () => {
                    await odak().resetPermissions();
                    setAlert('Odak\'ın izinleri sıfırlandı.\n\nŞimdi “Kaydı Başlat”a bas: macOS ekran kaydı (ve seçtiysen kamera/mikrofon) iznini yeniden soracak. Ekran kaydı iznini verdikten sonra macOS Odak\'ı kapatıp yeniden açmanı isteyebilir.');
                  }}>İzinleri Sıfırla</button>
                )}
                <button className="primary" onClick={() => setAlert(null)}>Tamam</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Home({ onOpen, onShowOpen, busy, onStart }: {
  onOpen: (pkg: string) => void; onShowOpen: () => void; busy: boolean;
  onStart: (displayId: number, systemAudio: boolean, devices: SideDevices) => Promise<boolean>;
}) {
  const [recents, setRecents] = useState<string[]>([]);
  useEffect(() => {
    const load = () => void odak().recents().then(setRecents);
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  return (
    <div className="home">
      <section className="record">
        <div className="hero-icon">◎</div>
        <h1>Yeni kayıt</h1>
        <p className="muted center">
          Ekranı imleç olmadan kaydeder; imleci ve tıklamaları ayrıca saklar.<br />
          Zoom'lar tıklamalardan otomatik oluşur, sonra hepsini düzenleyebilirsin.
        </p>
        <RecordSetup busy={busy} onStart={onStart} />
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
