import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, shell, systemPreferences } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type LangPref, helperMessage, isLangPref, lang, resolveLang, setLang, systemLang, t } from '../src/i18n/index.ts';

const isSelftest = process.argv.includes('--selftest');
const uiTestIndex = process.argv.indexOf('--uitest');
const uiTestProject = uiTestIndex >= 0 ? process.argv[uiTestIndex + 1] : null;
// Performance test: a heavy project driven through the real editor in a visible window.
const isPerftest = process.argv.includes('--perftest');
// Documentation screenshots: builds a demo project and captures the editor into a folder.
const docIndex = process.argv.indexOf('--docshots');
const docshotsDir = docIndex >= 0 ? path.resolve(process.argv[docIndex + 1] ?? 'docs/images') : null;
const isTest = isSelftest || !!uiTestProject || isPerftest || !!docshotsDir;
// `--lang tr|en` fixes the interface language for this run (tests use it; it's never saved).
const langArg = ((v) => (v === 'tr' || v === 'en' ? v : null))(process.argv[process.argv.indexOf('--lang') + 1]);
const devUrl = process.env.ODAK_DEV_URL;
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const PROJECT_EXT = '.focus';

let mainWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;

app.setName('Focara');
if (isTest) {
  // Tests keep their own app data (recent projects, settings), away from the user's.
  app.setPath('userData', path.join(os.tmpdir(), 'odak-test-data'));
  // Tests use Chromium's built-in fake camera and microphone (no real devices or permissions).
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

// ---------------------------------------------------------------- diagnostics log

/** ~/Library/Logs/Focara/focus.log (macOS) or %APPDATA%/Focara/logs/focus.log (Windows). */
const logFile = () => path.join(app.getPath('logs'), 'focus.log');
function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    if (fs.existsSync(logFile()) && fs.statSync(logFile()).size > 2_000_000) fs.renameSync(logFile(), logFile() + '.1');
    fs.appendFileSync(logFile(), line);
  } catch { /* logging must never break the app */ }
}
function permissions() {
  if (!isMac) return {};
  return { screen: systemPreferences.getMediaAccessStatus('screen'), camera: systemPreferences.getMediaAccessStatus('camera'),
           microphone: systemPreferences.getMediaAccessStatus('microphone') };
}
ipcMain.on('log', (_e, ...parts: unknown[]) => log('[ui]', ...parts));
ipcMain.handle('log:reveal', () => { log('log revealed'); shell.showItemInFolder(logFile()); });

// Focara was previously called Focus; the original app name was Odak. On first start as Focara, bring over profile data
// from the newest existing app folder. Nothing is overwritten, and project files stay where they are.
if (!isTest) {
  const to = app.getPath('userData');
  for (const previousName of ['Focus', 'Odak']) {
    const from = path.join(app.getPath('appData'), previousName);
    if (from !== to && fs.existsSync(from)) {
      for (const name of ['recents.json', 'settings.json', 'Local Storage']) {
        const src = path.join(from, name), dst = path.join(to, name);
        try {
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.mkdirSync(to, { recursive: true });
            fs.cpSync(src, dst, { recursive: true });
            log('brought over from previous app folder', { previousName, name });
          }
        } catch (e) { log('could not bring over from previous app folder', { previousName, name, error: String(e) }); }
      }
    }
  }
}

// ---------------------------------------------------------------- paths & files

const defaultFolder = () => path.join(app.getPath('videos'), 'Focara'); // ~/Movies on macOS, ~/Videos on Windows
let selftestDir: string | null = null;

/** Resolves a package-relative path and refuses anything that escapes the package. */
function inPackage(pkg: string, rel: string): string {
  const root = path.resolve(pkg);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(t('Geçersiz yol: {path}', { path: rel }));
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

/**
 * Writes through a temporary file and a rename, so a crash never leaves a half-written file.
 * Writes to the same file run one after another (autosaves can overlap on a slow disk), each with
 * its own temporary name; on Windows a rename that a virus scanner or indexer briefly blocks is retried.
 */
const writeQueues = new Map<string, Promise<void>>();
let tmpSeq = 0;
async function writeAtomic(file: string, data: string | Uint8Array) {
  const run = async () => {
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await fsp.writeFile(tmp, data);
    for (let attempt = 0; ; attempt++) {
      try { await fsp.rename(tmp, file); return; } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) { await new Promise((r) => setTimeout(r, 30 * (attempt + 1))); continue; }
        await fsp.rm(tmp, { force: true });
        throw e;
      }
    }
  };
  const next = (writeQueues.get(file) ?? Promise.resolve()).catch(() => {}).then(run);
  writeQueues.set(file, next);
  try { await next; } finally { if (writeQueues.get(file) === next) writeQueues.delete(file); }
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
  if (!fs.existsSync(file)) return { error: t('“{name}” bir Focara projesi değil (project.json yok).', { name: path.basename(pkg) }) };
  try {
    const project = JSON.parse(await fsp.readFile(file, 'utf8'));
    const missing: string[] = [];
    for (const m of project.media ?? []) {
      for (const rel of [m.videoFile, m.systemAudioFile, m.microphoneFile, m.cursorFile]) {
        if (rel && !fs.existsSync(inPackage(pkg, rel))) missing.push(rel);
      }
    }
    if (missing.length) return { error: t('Projedeki medya dosyaları bulunamadı: {files}', { files: missing.join(', ') }) };
    return { project };
  } catch (err) {
    return { error: t('Proje okunamadı: {detail}', { detail: (err as Error).message }) };
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
  if (!h) throw new Error(t('Dosya açık değil.'));
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
    title: t('Proje Aç'),
    defaultPath: defaultFolder(),
    // Project packages are folders; macOS also accepts projects from Odak (the old name) and Kadraj (same format).
    properties: isMac ? ['openFile', 'openDirectory', 'treatPackageAsDirectory'] : ['openDirectory'],
    filters: isMac ? [{ name: t('Focara Projesi'), extensions: ['focus', 'odak', 'kadraj'] }] : undefined,
  });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

ipcMain.handle('dialog:saveExport', async (_e, name: string, ext: string, label: string) => {
  const safeExt = /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'mp4';
  const r = await dialog.showSaveDialog(mainWindow!, {
    title: t('Dışa Aktar'),
    defaultPath: path.join(app.getPath(safeExt === 'png' ? 'pictures' : safeExt === 'm4a' || safeExt === 'wav' ? 'music' : 'videos'), `${name}.${safeExt}`),
    filters: [{ name: label, extensions: [safeExt] }],
  });
  if (r.canceled || !r.filePath) return null;
  // Keep the extension the format needs even if the name was typed without it.
  return path.extname(r.filePath).toLowerCase() === `.${safeExt}` ? r.filePath : `${r.filePath}.${safeExt}`;
});

ipcMain.handle('dialog:importVideo', async () => {
  const r = await dialog.showOpenDialog(mainWindow!, {
    title: t('Video Ekle'), properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('Videolar'), extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

/** Copies an external video into the project (projects stay self-contained). */
ipcMain.handle('project:importMedia', async (_e, pkg: string, src: string) => {
  const id = randomUUID().toUpperCase();
  const name = path.basename(src).replace(/[\\/:*?"<>|]/g, '-');
  const rel = `media/${id}/${name}`;
  await fsp.mkdir(path.join(pkg, 'media', id), { recursive: true });
  await fsp.copyFile(src, inPackage(pkg, rel));
  log('media imported', { src, rel });
  return { id, rel, name: path.basename(src).replace(/\.[^.]+$/, '') };
});

ipcMain.handle('project:removeMedia', async (_e, pkg: string, id: string) => {
  await fsp.rm(inPackage(pkg, `media/${id}`), { recursive: true, force: true });
});

ipcMain.handle('dialog:pickImage', async () => {
  const r = await dialog.showOpenDialog(mainWindow!, {
    title: t('Arka Plan Görseli Seç'), properties: ['openFile'],
    filters: [{ name: t('Görseller'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
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
    id: d.id, name: d.label || t('Ekran {n}', { n: i + 1 }),
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
  // Asking from the helper attributes the request to Focara (the responsible app).
  const out = await new Promise<string>((resolve) => {
    const p = spawn(h, ['permission', '--request']);
    let s = ''; p.stdout.on('data', (d: Buffer) => { s += d.toString(); }); p.on('exit', () => resolve(s)); p.on('error', () => resolve(''));
  });
  return out.includes('"granted":true');
});

ipcMain.handle('capture:resetPermissions', async () => {
  if (!isMac) return true;
  const id = 'com.lioneltchami.focara';
  const results: string[] = [];
  for (const service of ['ScreenCapture', 'Camera', 'Microphone']) {
    results.push(await new Promise<string>((resolve) => execFile('tccutil', ['reset', service, id], (err, out, errOut) =>
      resolve(`${service}: ${err ? `error ${errOut || err.message}` : (out.trim() || 'ok')}`))));
  }
  log('permissions reset by user', results);
  return true;
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
  if (!isMac && !isWin) return { ok: false, reason: t('Kayıt şimdilik yalnızca macOS ve Windows\'ta destekleniyor.') };
  const h = helperPath();
  return fs.existsSync(h) ? { ok: true } : { ok: false, reason: t('Kayıt yardımcısı bulunamadı: {path}. README\'deki derleme adımını çalıştırın.', { path: h }) };
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
    const timer = setTimeout(() => resolve({ event: 'error', message: t('Kayıt yardımcısı yanıt vermedi.') }), timeoutMs);
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

ipcMain.handle('capture:start', async (_e, o: { displayId: number; systemAudio: boolean; pkg?: string }) => {
  if (recording) return { ok: false, error: t('Zaten kayıt yapılıyor.') };
  const display = screen.getAllDisplays().find((d) => d.id === o.displayId) ?? screen.getPrimaryDisplay();
  // Local time, as the user reads the clock (toISOString would be UTC).
  const now = new Date(), two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`;
  // Adding a recording to an open project writes into that project's package.
  const appending = !!o.pkg && fs.existsSync(path.join(o.pkg, 'project.json'));
  const pkg = appending ? o.pkg! : await createPackage(t('Kayıt {stamp}', { stamp }));
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

  log('capture:start', { version: app.getVersion(), platform: process.platform, helper: helperPath(), args, permissions: permissions() });
  const proc = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const r: Recording = { proc, pkg, mediaID, startedAt: Date.now() / 1000, events: [], waiters: [], stopping: false, stderr: '' };
  const emit = (ev: { event: string; [k: string]: unknown }) => {
    log('helper', ev);
    r.events.push(ev);
    r.waiters = r.waiters.filter((w) => !w(ev));
    if (ev.event === 'error' && recording === r && !r.stopping) void stopRecording(helperMessage(String(ev.message ?? t('Kayıt hatası'))));
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
    log('capture:start failed', first, { stderr: r.stderr.trim().slice(-2000) });
    proc.kill();
    await fsp.rm(appending ? out : pkg, { recursive: true, force: true });
    const msg = first.code === 'permission'
      ? t('macOS ekran kaydına izin vermedi.\n\nSistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Sesi Kaydı\'nda Focara açık görünüyorsa bile, uygulama güncellendiyse macOS eski izni geçersiz sayar: Focara\'yı listeden “–” ile kaldırın, sonra Focara\'da kaydı yeniden başlatıp izin verin ve Focara\'yı yeniden açın.')
      : first.message ? helperMessage(String(first.message)) : (r.stderr.trim() || t('Kayıt başlatılamadı.'));
    return { ok: false, error: msg, code: first.code === 'permission' ? 'permission' : 'error' };
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
  log('capture:stop', fin, r.stderr.trim() ? { stderr: r.stderr.trim().slice(-2000) } : '');
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
      ok: false, error: failure ?? (fin.message ? helperMessage(String(fin.message)) : (r.stderr.trim() || t('Kayıt tamamlanamadı.'))),
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
  void hudWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(hudHtml()));
  hudWindow.once('ready-to-show', () => hudWindow?.showInactive());
}

const hudHtml = () => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;font:13px -apple-system,'Segoe UI',sans-serif;overflow:hidden}
.p{display:flex;align-items:center;gap:12px;height:56px;padding:0 14px;box-sizing:border-box;border-radius:14px;background:rgba(0,0,0,.84);color:#fff;-webkit-app-region:drag}
.d{width:10px;height:10px;border-radius:50%;background:#ff3b30}.t{font-family:ui-monospace,Consolas,monospace;flex:1}
button{-webkit-app-region:no-drag;border:0;border-radius:8px;background:#ff3b30;color:#fff;font-weight:600;padding:7px 12px;cursor:pointer}
button:disabled{opacity:.6}</style></head><body><div class="p"><div class="d"></div><div class="t" id="t">00:00</div>
<button id="b">${t('Durdur')} · ${isMac ? '⌘⇧2' : 'Ctrl+Shift+2'}</button></div><script>
const s=Date.now();setInterval(()=>{const e=Math.floor((Date.now()-s)/1000);document.getElementById('t').textContent=String(Math.floor(e/60)).padStart(2,'0')+':'+String(e%60).padStart(2,'0')},500);
const b=document.getElementById('b');const saving=${JSON.stringify(t('Kaydediliyor…'))};
b.onclick=()=>{b.disabled=true;b.textContent=saving;window.odak.stopRecording()};
window.odak.onHudFinishing&&window.odak.onHudFinishing(()=>{b.disabled=true;b.textContent=saving});
</script></body></html>`;

// ---------------------------------------------------------------- selftest

ipcMain.handle('uitest:project', () => uiTestProject);
ipcMain.handle('docshots:dir', () => docshotsDir);
// Real mouse input through Chromium's input pipeline (pointer capture etc.), for the UI test only.
ipcMain.handle('uitest:input', async (_e, events: { type: 'mouseDown' | 'mouseUp' | 'mouseMove'; x: number; y: number; held?: boolean }[]) => {
  if (!isTest || !mainWindow) return;
  // sendInputEvent only reaches a focused window (Windows CI windows start unfocused).
  mainWindow.focus(); mainWindow.webContents.focus();
  for (const ev of events) {
    mainWindow.webContents.sendInputEvent({ type: ev.type, x: Math.round(ev.x), y: Math.round(ev.y), button: 'left', clickCount: 1,
      modifiers: ev.held || ev.type === 'mouseDown' ? ['leftbuttondown'] : [] });
    await new Promise((r) => setTimeout(r, 16));
  }
});

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

// ---------------------------------------------------------------- settings: interface language

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
/** Saved choice; tests and `--lang` runs keep theirs in memory only. */
let langPref: LangPref = 'auto';
const keepLanguage = !isTest && !langArg;
function systemLanguages(): string[] {
  try { const l = app.getPreferredSystemLanguages(); if (l.length) return l; } catch { /* older systems */ }
  return [app.getLocale()];
}
function loadLanguage() {
  let saved: unknown = null;
  if (keepLanguage) { try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).language; } catch { /* first start */ } }
  // Tests run in Turkish unless told otherwise; the docs screenshots are for the English README.
  langPref = langArg ?? (docshotsDir ? 'en' : isTest ? 'tr' : isLangPref(saved) ? saved : 'auto');
  setLang(resolveLang(langPref, systemLanguages()));
}
async function setLanguage(pref: LangPref) {
  langPref = pref;
  setLang(resolveLang(pref, systemLanguages()));
  buildMenu();
  mainWindow?.webContents.send('settings:language', { pref, lang: lang() });
  log('language', { pref, lang: lang(), system: systemLanguages() });
  if (keepLanguage) {
    try {
      await fsp.mkdir(app.getPath('userData'), { recursive: true });
      await writeAtomic(settingsFile(), JSON.stringify({ language: pref }));
    } catch (e) { log('settings save failed', String(e)); }
  }
  return { pref, lang: lang() };
}
ipcMain.on('settings:get', (e) => { e.returnValue = { pref: langPref, lang: lang(), system: systemLang(systemLanguages()) }; });
ipcMain.handle('settings:setLanguage', (_e, pref: unknown) => (isLangPref(pref) ? setLanguage(pref) : { pref: langPref, lang: lang() }));

// ---------------------------------------------------------------- windows & menu

function send(cmd: string) { mainWindow?.webContents.send('menu', cmd); }

function buildMenu() {
  const settings: Electron.MenuItemConstructorOptions = { label: t('Ayarlar…'), accelerator: 'CmdOrCtrl+,', click: () => send('settings') };
  // Always in both languages, so it can be found whatever the current one is.
  const language: Electron.MenuItemConstructorOptions = {
    label: 'Dil · Language',
    submenu: ([['auto', t('Sistem dili')], ['tr', 'Türkçe'], ['en', 'English']] as const).map(([pref, label]) => (
      { label, type: 'radio' as const, checked: langPref === pref, click: () => void setLanguage(pref) })),
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'Focara',
      submenu: [
        { role: 'about' as const, label: t('Focara Hakkında') },
        { type: 'separator' as const },
        settings, language,
        { type: 'separator' as const },
        { role: 'services' as const, label: t('Servisler') },
        { type: 'separator' as const },
        { role: 'hide' as const, label: t('Focara\'yı Gizle') },
        { role: 'hideOthers' as const, label: t('Diğerlerini Gizle') },
        { role: 'unhide' as const, label: t('Tümünü Göster') },
        { type: 'separator' as const },
        { role: 'quit' as const, label: t('Focara\'dan Çık') },
      ],
    }] : []),
    {
      label: t('Dosya'),
      submenu: [
        { label: t('Yeni Kayıt'), accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: t('Proje Aç…'), accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: t('Video Dışa Aktar…'), accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        ...(isMac ? [] : [{ type: 'separator' as const }, settings, language, { type: 'separator' as const }, { role: 'quit' as const, label: t('Çıkış') }]),
      ],
    },
    {
      label: t('Düzen'),
      submenu: [
        { label: t('Geri Al'), accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: t('Yinele'), accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: t('Kes') }, { role: 'copy', label: t('Kopyala') }, { role: 'paste', label: t('Yapıştır') },
        { role: 'selectAll', label: t('Tümünü Seç') },
      ],
    },
    {
      label: t('Görünüm'),
      submenu: [{ role: 'togglefullscreen', label: t('Tam Ekran') }, { role: 'toggleDevTools', label: t('Geliştirici Araçları') }],
    },
    {
      label: t('Yardım'),
      submenu: [{ label: t('Tanılama Kaydını Göster'), click: () => { shell.showItemInFolder(logFile()); } }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: docshotsDir ? 1440 : 1320, height: docshotsDir ? 900 : 860, minWidth: 1100, minHeight: 720,
    show: false, title: 'Focara', backgroundColor: '#1e1e22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      additionalArguments: isSelftest ? ['--selftest'] : isPerftest ? ['--perftest', ...process.argv.filter((a) => a === '--perf-report')]
        : docshotsDir ? ['--docshots'] : uiTestProject ? ['--uitest'] : [],
      // Keep timers and capture running while the window is hidden during a recording.
      backgroundThrottling: false,
      // Documentation images at 2× (sharp on high-DPI screens, and the editor GIF zooms into them).
      offscreen: docshotsDir ? { deviceScaleFactor: 2 } : !!uiTestProject,
    },
  });
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  if (!isTest) mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Measured like real use: on screen (without taking focus).
  // The perf window must be on screen (real vsync and GPU) but drives itself with DOM events;
  // ignoring OS mouse input keeps a stray click (say, on "Kaydı Başlat") from derailing the run.
  if (isPerftest) mainWindow.once('ready-to-show', () => { mainWindow?.setIgnoreMouseEvents(true); mainWindow?.showInactive(); });
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    if (isTest) { process.stdout.write(`renderer gone: ${d.reason}\n`); app.exit(3); }
  });
  if (isTest) {
    mainWindow.webContents.on('console-message', (e) => process.stdout.write(`[renderer] ${e.message}\n`));
    setTimeout(() => { process.stdout.write('SELFTEST TIMEOUT\n'); app.exit(2); }, isPerftest || docshotsDir ? 900000 : 240000);
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  loadLanguage();
  log('app start', { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, permissions: permissions(),
                     language: { pref: langPref, lang: lang(), system: systemLanguages() } });
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); else mainWindow.show(); });
});

app.on('window-all-closed', () => { if (!isMac || isTest) app.quit(); });
app.on('before-quit', (e) => {
  if (recording && !recording.stopping) { e.preventDefault(); void stopRecording().then(() => app.quit()); }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
