import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, shell, systemPreferences } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const isSelftest = process.argv.includes('--selftest');
const uiTestIndex = process.argv.indexOf('--uitest');
const uiTestProject = uiTestIndex >= 0 ? process.argv[uiTestIndex + 1] : null;
const isTest = isSelftest || !!uiTestProject;
const devUrl = process.env.ODAK_DEV_URL;
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const PROJECT_EXT = '.odak';

let mainWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;

app.setName('Odak');
if (isTest) {
  // Tests use Chromium's built-in fake camera and microphone (no real devices or permissions).
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

// ---------------------------------------------------------------- paths & files

const defaultFolder = () => path.join(app.getPath('videos'), 'Odak'); // ~/Movies on macOS, ~/Videos on Windows
let selftestDir: string | null = null;

/** Resolves a package-relative path and refuses anything that escapes the package. */
function inPackage(pkg: string, rel: string): string {
  const root = path.resolve(pkg);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Geçersiz yol: ${rel}`);
  return full;
}

async function createPackage(name: string): Promise<string> {
  const folder = selftestDir ?? defaultFolder();
  await fsp.mkdir(folder, { recursive: true });
  const safe = name.replace(/[\\/:*?"<>|]/g, '-');
  let pkg = path.join(folder, safe + PROJECT_EXT);
  for (let n = 2; fs.existsSync(pkg); n++) pkg = path.join(folder, `${safe} ${n}${PROJECT_EXT}`);
  await fsp.mkdir(path.join(pkg, 'media'), { recursive: true });
  return pkg;
}

async function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

const readHandles = new Map<string, Promise<fsp.FileHandle>>();
function readHandle(file: string) {
  let h = readHandles.get(file);
  if (!h) { h = fsp.open(file, 'r'); readHandles.set(file, h); h.catch(() => readHandles.delete(file)); }
  return h;
}

const writeHandles = new Map<number, { fh: fsp.FileHandle; path: string }>();
let nextHandle = 1;

const recentsFile = () => path.join(app.getPath('userData'), 'recents.json');
async function recents(): Promise<string[]> {
  try {
    const list: string[] = JSON.parse(await fsp.readFile(recentsFile(), 'utf8'));
    return list.filter((p) => fs.existsSync(path.join(p, 'project.json')));
  } catch { return []; }
}

// ---------------------------------------------------------------- IPC: projects & files

ipcMain.handle('project:create', (_e, name: string) => createPackage(name));

ipcMain.handle('project:load', async (_e, pkg: string) => {
  const file = path.join(pkg, 'project.json');
  if (!fs.existsSync(file)) return { error: `“${path.basename(pkg)}” bir Odak projesi değil (project.json yok).` };
  try {
    const project = JSON.parse(await fsp.readFile(file, 'utf8'));
    const missing: string[] = [];
    for (const m of project.media ?? []) {
      for (const rel of [m.videoFile, m.systemAudioFile, m.microphoneFile, m.cursorFile]) {
        if (rel && !fs.existsSync(inPackage(pkg, rel))) missing.push(rel);
      }
    }
    if (missing.length) return { error: `Projedeki medya dosyaları bulunamadı: ${missing.join(', ')}` };
    return { project };
  } catch (err) {
    return { error: `Proje okunamadı: ${(err as Error).message}` };
  }
});

ipcMain.handle('project:save', (_e, pkg: string, project: unknown) =>
  writeAtomic(path.join(pkg, 'project.json'), JSON.stringify(project, null, 2)));

ipcMain.handle('file:size', async (_e, pkg: string, rel: string) => (await fsp.stat(inPackage(pkg, rel))).size);

ipcMain.handle('file:read', async (_e, pkg: string, rel: string, start: number, end: number) => {
  const fh = await readHandle(inPackage(pkg, rel));
  const buf = Buffer.alloc(Math.max(0, end - start));
  const { bytesRead } = await fh.read(buf, 0, buf.length, start);
  return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
});

ipcMain.handle('file:readCursor', async (_e, pkg: string, rel: string) => {
  try { return JSON.parse(await fsp.readFile(inPackage(pkg, rel), 'utf8')); } catch { return null; }
});

ipcMain.handle('file:write', async (_e, pkg: string, rel: string, data: Uint8Array) => {
  const file = inPackage(pkg, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, data);
});

ipcMain.handle('file:open', async (_e, file: string) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fh = await fsp.open(file, 'w');
  const id = nextHandle++;
  writeHandles.set(id, { fh, path: file });
  return id;
});

ipcMain.handle('file:writeAt', async (_e, id: number, data: Uint8Array, position: number) => {
  const h = writeHandles.get(id);
  if (!h) throw new Error('Dosya açık değil');
  await h.fh.write(data, 0, data.length, position);
});

ipcMain.handle('file:close', async (_e, id: number, remove: boolean, truncateTo?: number) => {
  const h = writeHandles.get(id);
  if (!h) return;
  writeHandles.delete(id);
  if (typeof truncateTo === 'number' && !remove) await h.fh.truncate(truncateTo);
  await h.fh.close();
  for (const [file, ph] of readHandles) if (file === h.path) { (await ph).close().catch(() => {}); readHandles.delete(file); }
  if (remove) await fsp.rm(h.path, { force: true });
});

ipcMain.handle('dialog:openProject', async () => {
  const r = await dialog.showOpenDialog(mainWindow!, {
    title: 'Proje Aç',
    defaultPath: defaultFolder(),
    // Project packages are folders; macOS also accepts Kadraj projects (same format).
    properties: isMac ? ['openFile', 'openDirectory', 'treatPackageAsDirectory'] : ['openDirectory'],
    filters: isMac ? [{ name: 'Odak Projesi', extensions: ['odak', 'kadraj'] }] : undefined,
  });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

ipcMain.handle('dialog:saveVideo', async (_e, name: string) => {
  const r = await dialog.showSaveDialog(mainWindow!, {
    title: 'Video Dışa Aktar',
    defaultPath: path.join(app.getPath('videos'), name),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  return r.canceled ? null : r.filePath ?? null;
});

ipcMain.handle('dialog:pickImage', async () => {
  const r = await dialog.showOpenDialog(mainWindow!, {
    title: 'Arka Plan Görseli Seç', properties: ['openFile'],
    filters: [{ name: 'Görseller', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

/** Copies a file into the project so the project stays self-contained. */
ipcMain.handle('project:importAsset', async (_e, pkg: string, src: string) => {
  const ext = path.extname(src).toLowerCase() || '.bin';
  const rel = `assets/${randomUUID().toUpperCase()}${ext}`;
  await fsp.mkdir(path.join(pkg, 'assets'), { recursive: true });
  await fsp.copyFile(src, inPackage(pkg, rel));
  return rel;
});

ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('shell:open', async (_e, p: string) => { await shell.openPath(p); });
ipcMain.handle('recents:list', () => recents());
ipcMain.handle('recents:add', async (_e, pkg: string) => {
  const list = [pkg, ...(await recents()).filter((p) => p !== pkg)].slice(0, 20);
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await writeAtomic(recentsFile(), JSON.stringify(list));
});

// ---------------------------------------------------------------- recording (native helper)

ipcMain.handle('capture:displays', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, name: d.label || `Ekran ${i + 1}`,
    width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor),
    scaleFactor: d.scaleFactor, primary: d.id === primary,
  }));
});

ipcMain.handle('capture:permission', () =>
  isMac ? systemPreferences.getMediaAccessStatus('screen') : 'granted');

ipcMain.handle('capture:requestPermission', async () => {
  if (!isMac) return true;
  const h = helperPath();
  if (!fs.existsSync(h)) return false;
  // Asking from the helper attributes the request to Odak (the responsible app).
  const out = await new Promise<string>((resolve) => {
    const p = spawn(h, ['permission', '--request']);
    let s = ''; p.stdout.on('data', (d: Buffer) => { s += d.toString(); }); p.on('exit', () => resolve(s)); p.on('error', () => resolve(''));
  });
  return out.includes('"granted":true');
});

ipcMain.handle('capture:openSettings', () => {
  if (isMac) return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return shell.openExternal('ms-settings:privacy');
});

function helperPath(): string {
  const exe = isWin ? 'odak-capture.exe' : 'odak-capture';
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', exe);
  const sub = isWin ? path.join('native', 'win', 'target', 'release') : path.join('native', 'mac', 'build');
  return path.join(app.getAppPath(), sub, exe);
}

ipcMain.handle('capture:available', () => {
  if (!isMac && !isWin) return { ok: false, reason: 'Kayıt şimdilik yalnızca macOS ve Windows\'ta destekleniyor.' };
  const h = helperPath();
  return fs.existsSync(h) ? { ok: true } : { ok: false, reason: `Kayıt yardımcısı bulunamadı: ${h}. README'deki derleme adımını çalıştırın.` };
});

interface Recording {
  proc: ChildProcessWithoutNullStreams;
  pkg: string; mediaID: string; startedAt: number;
  events: { event: string; [k: string]: unknown }[];
  waiters: ((e: { event: string; [k: string]: unknown }) => boolean)[];
  stopping: boolean;
  stderr: string;
}
let recording: Recording | null = null;

function nextEvent(r: Recording, names: string[], timeoutMs: number): Promise<{ event: string; [k: string]: unknown }> {
  return new Promise((resolve) => {
    const found = r.events.find((e) => names.includes(e.event) || e.event === 'error' || e.event === 'exit');
    if (found) return resolve(found);
    const timer = setTimeout(() => resolve({ event: 'error', message: 'Kayıt yardımcısı yanıt vermedi.' }), timeoutMs);
    r.waiters.push((e) => {
      if (!(names.includes(e.event) || e.event === 'error' || e.event === 'exit')) return false;
      clearTimeout(timer); resolve(e); return true;
    });
  });
}

ipcMain.handle('media:ask', async (_e, kind: 'camera' | 'microphone') => {
  if (!isMac) return true;
  if (systemPreferences.getMediaAccessStatus(kind) === 'granted') return true;
  return systemPreferences.askForMediaAccess(kind);
});

ipcMain.handle('capture:start', async (_e, o: { displayId: number; systemAudio: boolean }) => {
  if (recording) return { ok: false, error: 'Zaten kayıt yapılıyor.' };
  const display = screen.getAllDisplays().find((d) => d.id === o.displayId) ?? screen.getPrimaryDisplay();
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  const pkg = await createPackage(`Kayıt ${stamp}`);
  const mediaID = randomUUID().toUpperCase();
  const out = path.join(pkg, 'media', mediaID);
  await fsp.mkdir(out, { recursive: true });

  const args = ['record', '--out', out, '--fps', '60'];
  if (isMac) args.push('--display-id', String(display.id), '--exclude-pid', String(process.pid));
  if (isWin) {
    const b = screen.dipToScreenRect(null, display.bounds);
    args.push('--bounds', `${b.x},${b.y},${b.width},${b.height}`, '--scale', String(display.scaleFactor));
  }
  // The microphone (and camera) are recorded by the app itself, so the user can pick devices.
  if (o.systemAudio) args.push('--system-audio');

  const proc = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const r: Recording = { proc, pkg, mediaID, startedAt: Date.now() / 1000, events: [], waiters: [], stopping: false, stderr: '' };
  const emit = (ev: { event: string; [k: string]: unknown }) => {
    r.events.push(ev);
    r.waiters = r.waiters.filter((w) => !w(ev));
    if (ev.event === 'error' && recording === r && !r.stopping) void stopRecording(String(ev.message ?? 'Kayıt hatası'));
  };
  let buf = '';
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { emit(JSON.parse(line)); } catch { /* ignore non-JSON output */ }
    }
  });
  proc.stderr.on('data', (d: Buffer) => { r.stderr = (r.stderr + d.toString('utf8')).slice(-4000); });
  proc.on('exit', (code) => emit({ event: 'exit', code }));
  proc.on('error', (err) => emit({ event: 'error', message: err.message }));

  const first = await nextEvent(r, ['started'], 20000);
  if (first.event !== 'started') {
    proc.kill();
    await fsp.rm(pkg, { recursive: true, force: true });
    const msg = first.code === 'permission'
      ? 'Ekran kaydı izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Sesi Kaydı\'nda Odak\'ı açın ve uygulamayı yeniden başlatın.'
      : String(first.message ?? (r.stderr.trim() || 'Kayıt başlatılamadı.'));
    return { ok: false, error: msg };
  }
  recording = r;
  mainWindow?.hide();
  showHud(display);
  globalShortcut.register('CommandOrControl+Shift+2', () => void stopRecording());
  return { ok: true, pkg, mediaID, t0: typeof first.t0 === 'number' ? first.t0 : Date.now() };
});

async function stopRecording(failure?: string) {
  const r = recording;
  if (!r || r.stopping) return;
  r.stopping = true;
  hudWindow?.webContents.send('hud:finishing');
  globalShortcut.unregister('CommandOrControl+Shift+2');
  if (r.proc.exitCode === null) r.proc.stdin.write('stop\n');
  const fin = await nextEvent(r, ['finished'], 60000);
  recording = null;
  hudWindow?.close(); hudWindow = null;
  mainWindow?.show(); mainWindow?.focus();
  if (fin.event === 'finished') {
    const info = fin as unknown as Record<string, unknown>;
    const rel = (f: unknown) => (typeof f === 'string' ? `media/${r.mediaID}/${f}` : null);
    mainWindow?.webContents.send('recording:finished', {
      ok: true, pkg: r.pkg, mediaID: r.mediaID, startedAt: r.startedAt,
      info: {
        video: rel(info.video), systemAudio: rel(info.systemAudio), microphone: rel(info.microphone),
        cursor: rel(info.cursor), duration: info.duration, width: info.width, height: info.height,
        pixelsPerPoint: info.pixelsPerPoint,
      },
    });
  } else {
    if (r.proc.exitCode === null) r.proc.kill();
    mainWindow?.webContents.send('recording:finished', {
      ok: false, error: failure ?? String(fin.message ?? (r.stderr.trim() || 'Kayıt tamamlanamadı.')),
    });
  }
}

ipcMain.handle('capture:stop', () => stopRecording());

function showHud(display: Electron.Display) {
  const w = 260, h = 56;
  hudWindow = new BrowserWindow({
    width: w, height: h,
    x: Math.round(display.workArea.x + display.workArea.width / 2 - w / 2), y: display.workArea.y + 12,
    frame: false, transparent: true, resizable: false, movable: true, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: true, show: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  hudWindow.setAlwaysOnTop(true, 'screen-saver');
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWindow.setContentProtection(true); // keep the panel out of the recording
  void hudWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HUD_HTML));
  hudWindow.once('ready-to-show', () => hudWindow?.showInactive());
}

const HUD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;font:13px -apple-system,'Segoe UI',sans-serif;overflow:hidden}
.p{display:flex;align-items:center;gap:12px;height:56px;padding:0 14px;box-sizing:border-box;border-radius:14px;background:rgba(0,0,0,.84);color:#fff;-webkit-app-region:drag}
.d{width:10px;height:10px;border-radius:50%;background:#ff3b30}.t{font-family:ui-monospace,Consolas,monospace;flex:1}
button{-webkit-app-region:no-drag;border:0;border-radius:8px;background:#ff3b30;color:#fff;font-weight:600;padding:7px 12px;cursor:pointer}
button:disabled{opacity:.6}</style></head><body><div class="p"><div class="d"></div><div class="t" id="t">00:00</div>
<button id="b">Durdur · ${isMac ? '⌘⇧2' : 'Ctrl+Shift+2'}</button></div><script>
const s=Date.now();setInterval(()=>{const e=Math.floor((Date.now()-s)/1000);document.getElementById('t').textContent=String(Math.floor(e/60)).padStart(2,'0')+':'+String(e%60).padStart(2,'0')},500);
const b=document.getElementById('b');b.onclick=()=>{b.disabled=true;b.textContent='Kaydediliyor…';window.odak.stopRecording()};
window.odak.onHudFinishing&&window.odak.onHudFinishing(()=>{b.disabled=true;b.textContent='Kaydediliyor…'});
</script></body></html>`;

// ---------------------------------------------------------------- selftest

ipcMain.handle('uitest:project', () => uiTestProject);
ipcMain.handle('uitest:capture', async (_e, name: string) => {
  const img = await mainWindow!.webContents.capturePage();
  selftestDir ??= await fsp.mkdtemp(path.join(os.tmpdir(), 'odak-uitest-'));
  const file = path.join(selftestDir, `${name}.png`);
  await fsp.writeFile(file, img.toPNG());
  return file;
});

ipcMain.handle('selftest:dir', async () => {
  selftestDir ??= await fsp.mkdtemp(path.join(os.tmpdir(), 'odak-selftest-'));
  return selftestDir;
});
ipcMain.on('selftest:done', (_e, result: { ok: boolean; log: string[] }) => {
  for (const line of result.log) process.stdout.write(line + '\n');
  process.stdout.write((result.ok ? 'ALL PASSED' : 'SELFTEST FAILED') + ` → ${selftestDir}\n`);
  app.exit(result.ok ? 0 : 1);
});

// ---------------------------------------------------------------- windows & menu

function send(cmd: string) { mainWindow?.webContents.send('menu', cmd); }

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Dosya',
      submenu: [
        { label: 'Yeni Kayıt', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Proje Aç…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: 'Video Dışa Aktar…', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: 'Çıkış' }]),
      ],
    },
    {
      label: 'Düzen',
      submenu: [
        { label: 'Geri Al', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Yinele', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Kes' }, { role: 'copy', label: 'Kopyala' }, { role: 'paste', label: 'Yapıştır' },
        { role: 'selectAll', label: 'Tümünü Seç' },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [{ role: 'togglefullscreen', label: 'Tam Ekran' }, { role: 'toggleDevTools', label: 'Geliştirici Araçları' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1100, minHeight: 720,
    show: false, title: 'Odak', backgroundColor: '#1e1e22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      additionalArguments: isSelftest ? ['--selftest'] : uiTestProject ? ['--uitest'] : [],
      // Keep timers and capture running while the window is hidden during a recording.
      backgroundThrottling: false,
      offscreen: !!uiTestProject,
    },
  });
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  if (!isTest) mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    if (isTest) { process.stdout.write(`renderer gone: ${d.reason}\n`); app.exit(3); }
  });
  if (isTest) {
    mainWindow.webContents.on('console-message', (e) => process.stdout.write(`[renderer] ${e.message}\n`));
    setTimeout(() => { process.stdout.write('SELFTEST TIMEOUT\n'); app.exit(2); }, 240000);
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); else mainWindow.show(); });
});

app.on('window-all-closed', () => { if (!isMac || isTest) app.quit(); });
app.on('before-quit', (e) => {
  if (recording && !recording.stopping) { e.preventDefault(); void stopRecording().then(() => app.quit()); }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
