import { useCallback, useEffect, useRef, useState } from 'react';
import { type DisplayInfo, odak } from '../bridge.ts';
import type { SideDevices } from '../media/sideRecorder.ts';

const mod = odak().platform === 'darwin' ? '⌘' : 'Ctrl+';

/** Display, system audio, microphone and camera choices + start button (home screen and “Kayıt Ekle”). */
export function RecordSetup({ busy, onStart, startLabel = '● Kaydı Başlat' }: {
  busy: boolean;
  onStart: (displayId: number, systemAudio: boolean, devices: SideDevices) => Promise<boolean>;
  startLabel?: string;
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
    odak().log('record clicked', { display, systemAudio, camera: !!camId, mic: !!micId });
    // Release the preview so the recorder can open the camera.
    (preview.current?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    const ok = await onStart(display, systemAudio, { cameraId: camId || null, micId: micId || null, noiseSuppression });
    if (!ok) void refresh();
  };

  const needsPermission = odak().platform === 'darwin' && permission !== 'granted';
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;

  return (
    <>
    {!available.ok && <div className="notice warn">{available.reason}</div>}
    {needsPermission && (
      <div className="notice warn">
        <b>Ekran kaydı izni gerekiyor.</b> Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Sesi Kaydı'nda
        Odak'ı aç. macOS izin verildikten sonra uygulamanın yeniden başlatılmasını isteyebilir.
        <div className="row"><button className="primary" onClick={async () => {
            if (!(await odak().requestScreenPermission())) await odak().openPermissionSettings();
            void refresh();
          }}>İzin İste / Ayarları Aç</button>
          <button onClick={async () => { await odak().resetPermissions(); void refresh(); }} title="Odak güncellendiyse eski izinleri temizler">İzinleri Sıfırla</button>
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
      {busy ? 'Başlatılıyor…' : startLabel}
    </button>
    <p className="muted small">Durdurmak için ekranın üstündeki paneli ya da {mod}Shift+2'yi kullan.</p>
    </>
  );
}
