// The API the Electron main process exposes to the UI (see electron/preload.ts).
import type { CursorTrack, Project } from './core/model.ts';

export interface DisplayInfo { id: number; name: string; width: number; height: number; scaleFactor: number; primary: boolean }

export interface RecordingOptions { displayId: number; systemAudio: boolean }

/** Written by the native capture helper (same fields on macOS and Windows). */
export interface RecordingInfo {
  video: string;
  systemAudio: string | null;
  microphone: string | null;
  cursor: string;
  duration: number;
  width: number;
  height: number;
  pixelsPerPoint: number;
}

export type RecordingFinished =
  | { ok: true; pkg: string; mediaID: string; info: RecordingInfo; startedAt: number }
  | { ok: false; error: string };

export type MenuCommand = 'new' | 'open' | 'export' | 'undo' | 'redo';

export interface OdakAPI {
  platform: 'darwin' | 'win32' | 'linux';
  isSelftest: boolean;
  isUiTest: boolean;
  uiTestProject(): Promise<string | null>;
  uiTestCapture(name: string): Promise<string>;
  requestScreenPermission(): Promise<boolean>;
  askMediaAccess(kind: 'camera' | 'microphone'): Promise<boolean>;
  resetPermissions(): Promise<boolean>;
  log(...parts: unknown[]): void;
  revealLog(): Promise<void>;
  pickImage(): Promise<string | null>;
  importAsset(pkg: string, src: string): Promise<string>;
  createPackage(name: string): Promise<string>;
  loadProject(pkg: string): Promise<{ project?: Project; error?: string }>;
  saveProject(pkg: string, project: Project): Promise<void>;
  fileSize(pkg: string, rel: string): Promise<number>;
  readFile(pkg: string, rel: string, start: number, end: number): Promise<Uint8Array>;
  readCursor(pkg: string, rel: string): Promise<CursorTrack | null>;
  writeFile(pkg: string, rel: string, data: Uint8Array): Promise<void>;
  fileOpen(path: string): Promise<number>;
  fileWrite(handle: number, data: Uint8Array, position: number): Promise<void>;
  fileClose(handle: number, remove?: boolean, truncateTo?: number): Promise<void>;
  openProjectDialog(): Promise<string | null>;
  saveVideoDialog(defaultName: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  recents(): Promise<string[]>;
  addRecent(pkg: string): Promise<void>;
  displays(): Promise<DisplayInfo[]>;
  screenPermission(): Promise<'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'>;
  openPermissionSettings(): Promise<void>;
  captureAvailable(): Promise<{ ok: boolean; reason?: string }>;
  startRecording(o: RecordingOptions): Promise<{ ok: true; pkg: string; mediaID: string; t0: number } | { ok: false; error: string; code?: 'permission' | 'error' }>;
  stopRecording(): Promise<void>;
  onRecordingFinished(cb: (r: RecordingFinished) => void): () => void;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  selftestTempDir(): Promise<string>;
  selftestDone(result: { ok: boolean; log: string[] }): void;
}

declare global {
  interface Window { odak: OdakAPI }
}

export const odak = () => window.odak;
