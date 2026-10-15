import { useSyncExternalStore } from 'react';
import { type Project, now } from '../core/model.ts';
import { odak } from '../bridge.ts';

export type Selection =
  | { kind: 'zoom'; clipID: string; zoomID: string }
  | { kind: 'camera'; clipID: string; segID: string }
  | { kind: 'magnifier'; clipID: string; segID: string }
  | { kind: 'clip'; clipID: string }
  | null;

/** Editor state with undo/redo and debounced autosave (same behaviour as Kadraj's EditorModel). */
export class EditorStore {
  project: Project;
  selection: Selection = null;
  saveStatus = 'Kaydedildi';
  error: string | null = null;
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private lastKey: string | null = null;
  private lastTime = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(readonly pkg: string, project: Project) { this.project = project; }

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  private emit() { this.version++; this.listeners.forEach((l) => l()); }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** Repeated changes with the same key within a second (drags, sliders) form one undo step. */
  update(change: (p: Project) => Project, coalesce?: string) {
    const next = change(this.project);
    if (next === this.project || JSON.stringify(next) === JSON.stringify(this.project)) return;
    const t = performance.now();
    if (!(coalesce && coalesce === this.lastKey && t - this.lastTime < 1000)) {
      this.undoStack.push(this.project);
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.lastKey = coalesce ?? null; this.lastTime = t;
    this.redoStack = [];
    this.apply(next);
  }

  undo() { const p = this.undoStack.pop(); if (!p) return; this.redoStack.push(this.project); this.lastKey = null; this.apply(p); }
  redo() { const p = this.redoStack.pop(); if (!p) return; this.undoStack.push(this.project); this.lastKey = null; this.apply(p); }

  select(s: Selection) { this.selection = s; this.emit(); }
  setError(e: string | null) { this.error = e; this.emit(); }

  private apply(p: Project) {
    this.project = { ...p, updatedAt: now() };
    const s = this.selection;
    if (s?.kind === 'zoom' && !this.project.clips.find((c) => c.id === s.clipID)?.zooms.some((z) => z.id === s.zoomID)) this.selection = null;
    if (s?.kind === 'clip' && !this.project.clips.some((c) => c.id === s.clipID)) this.selection = null;
    this.scheduleSave();
    this.emit();
  }

  private scheduleSave() {
    this.saveStatus = 'Kaydediliyor…';
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 400);
  }

  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      await odak().saveProject(this.pkg, this.project);
      this.saveStatus = 'Kaydedildi';
    } catch (e) {
      this.saveStatus = 'Kaydedilemedi';
      this.error = `Proje kaydedilemedi: ${(e as Error).message}`;
    }
    this.emit();
  }
}

export function useStore(store: EditorStore) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}
