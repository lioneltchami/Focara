import { useCallback, useEffect, useRef, useState } from 'react';
import { type DisplayInfo, type RecordingFinished, odak } from '../bridge.ts';
import { type MediaAsset, type Project, newClip, newProject, normalizeProject } from '../core/model.ts';
import { generateAutoZooms } from '../core/zoom.ts';
import { type SideDevices, type SideResult, SideRecorder } from '../media/sideRecorder.ts';
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
  // Camera + microphone recorder; lives here so it survives while the window is hidden.
  const side = useRef<SideRecorder | null>(null);

  const startRecording = useCallback(async (displayId: number, systemAudio: boolean, devices: SideDevices) => {
    setBusy(true);
    try {
      if (devices.micId) await odak().askMediaAccess('microphone');
      if (devices.cameraId) await odak().askMediaAccess('camera');
      side.current = await SideRecorder.open(devices);
    } catch (e) {
      setBusy(false);
      setAlert(`Kamera/mikrofon açılamadı: ${(e as Error).message}\nSistem ayarlarında Odak'a kamera ve mikrofon izni verildiğinden emin ol.`);
      return false;
    }
    const r = await odak().startRecording({ displayId, systemAudio });
    if (!r.ok) {
      await side.current?.cancel(); side.current = null;
      setBusy(false); setAlert(r.error);
      return false;
    }
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
    const rec = side.current;
    side.current = null;
    if (!r.ok) { await rec?.cancel(); setBusy(false); setAlert(r.error); return; }
    const { info } = r;
    const extra: SideResult = rec ? await rec.stop(info.duration).catch((e): SideResult => { setAlert(`Kamera/mikrofon kaydı tamamlanamadı: ${(e as Error).message}`); return {}; }) : {};
    setBusy(false);
    const track = await odak().readCursor(r.pkg, info.cursor);
    const asset: MediaAsset = {
      id: r.mediaID, kind: 'screenRecording', displayName: 'Ekran kaydı', videoFile: info.video,
      systemAudioFile: info.systemAudio ?? undefined, microphoneFile: extra.micFile ?? info.microphone ?? undefined,
      cameraFile: extra.cameraFile, cursorFile: info.cursor, duration: info.duration, pixelWidth: info.width, pixelHeight: info.height,
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
        : <Home onOpen={openProject} onShowOpen={showOpen} busy={busy} onStart={startRecording} />}
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

function Home({ onOpen, onShowOpen, busy, onStart }: {
  onOpen: (pkg: string) => void; onShowOpen: () => void; busy: boolean;
  onStart: (displayId: number, systemAudio: boolean, devices: SideDevices) => Promise<boolean>;
}) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [display, setDisplay] = useState<number | null>(null);
  const [systemAudio, setSystemAudio] = useState(true);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>(() => localStorage.getItem('odak.mic') ?? '');
  const [camId, setCamId] = useState<string>(() => localStorage.getItem('odak.camera') ?? '');
  const [noiseSuppression, setNoiseSuppression] = useState(() => localStorage.getItem('odak.ns') !== '0');
  const [permission, setPermission] = useState<string>('granted');
  const [available, setAvailable] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [recents, setRecents] = useState<string[]>([]);
  const preview = useRef<HTMLVideoElement>(null);

  const loadDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    setMics(all.filter((d) => d.kind === 'audioinput' && d.deviceId));
    setCams(all.filter((d) => d.kind === 'videoinput' && d.deviceId));
  }, []);

  const refresh = useCallback(async () => {
    const d = await odak().displays();
    setDisplays(d);
    setDisplay((cur) => (cur !== null && d.some((x) => x.id === cur) ? cur : d.find((x) => x.primary)?.id ?? d[0]?.id ?? null));
    setPermission(await odak().screenPermission());
    setAvailable(await odak().captureAvailable());
    setRecents(await odak().recents());
    await loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    navigator.mediaDevices.addEventListener?.('devicechange', loadDevices);
    return () => { window.removeEventListener('focus', refresh); navigator.mediaDevices.removeEventListener?.('devicechange', loadDevices); };
  }, [refresh, loadDevices]);

  useEffect(() => { localStorage.setItem('odak.mic', micId); localStorage.setItem('odak.camera', camId); localStorage.setItem('odak.ns', noiseSuppression ? '1' : '0'); }, [micId, camId, noiseSuppression]);

  // Live camera preview so the framing can be checked before recording.
  useEffect(() => {
    if (!camId) return;
    let stream: MediaStream | null = null, cancelled = false;
    void (async () => {
      await odak().askMediaAccess('camera');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camId }, width: { ideal: 640 } } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (preview.current) preview.current.srcObject = stream;
        void loadDevices(); // labels become available after permission
      } catch { setCamId(''); }
    })();
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camId, loadDevices]);

  // Device labels are only exposed after access was granted once.
  const askFor = async (kind: 'microphone' | 'camera') => {
    await odak().askMediaAccess(kind);
    try { const s = await navigator.mediaDevices.getUserMedia(kind === 'camera' ? { video: true } : { audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { /* denied */ }
    await loadDevices();
  };

  const start = async () => {
    if (display === null) return;
    // Release the preview so the recorder can open the camera.
    (preview.current?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    const ok = await onStart(display, systemAudio, { cameraId: camId || null, micId: micId || null, noiseSuppression });
    if (!ok) void refresh();
  };

  const needsPermission = odak().platform === 'darwin' && permission !== 'granted';
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;

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
          <label>Mikrofon
            <select value={micId} onChange={(e) => setMicId(e.target.value)} onFocus={() => { if (!mics.some((m) => m.label)) void askFor('microphone'); }}>
              <option value="">Kapalı</option>
              {mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Mikrofon')}</option>)}
            </select>
          </label>
          {micId && <label className="check"><input type="checkbox" checked={noiseSuppression} onChange={(e) => setNoiseSuppression(e.target.checked)} /> Gürültü azaltma</label>}
          <label>Kamera
            <select value={camId} onChange={(e) => setCamId(e.target.value)} onFocus={() => { if (!cams.some((c) => c.label)) void askFor('camera'); }}>
              <option value="">Kapalı</option>
              {cams.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Kamera')}</option>)}
            </select>
          </label>
          {camId && <video ref={preview} className="cam-preview" autoPlay muted playsInline />}
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
