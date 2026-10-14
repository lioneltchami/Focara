// Drives the real UI with DOM events (no OS-level input): home screen, open project, add/drag/
// edit zooms, fixed focus, undo/redo, style toggle, playback, export dialog, autosave.
import { odak } from './bridge.ts';
import { type Project, normalizeProject } from './core/model.ts';
import type { EditorStore } from './ui/store.ts';

const log: string[] = [];
let failures = 0;
const check = (ok: boolean, msg: string) => { log.push(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T | null;
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const byText = (sel: string, text: string) => $$(sel).find((e) => e.textContent?.includes(text)) ?? null;

async function until(what: string, cond: () => boolean, ms = 8000) {
  const t = performance.now();
  while (!cond()) { if (performance.now() - t > ms) throw new Error(`timeout: ${what}`); await sleep(30); }
}
const hooks = () => (window as unknown as { __odak: { openProject: (p: string) => Promise<void>; store: EditorStore | null } }).__odak;
const store = () => hooks().store!;
const project = (): Project => store().project;
const click = (el: Element | null) => { if (!el) throw new Error('element yok'); (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); };
function pointer(el: Element, type: string, x: number, y: number) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }));
}
function setRange(el: HTMLInputElement, v: number) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const selectedZoom = () => {
  const s = store().selection;
  return s?.kind === 'zoom' ? project().clips.find((c) => c.id === s.clipID)?.zooms.find((z) => z.id === s.zoomID) : undefined;
};

export async function runUiTest() {
  try {
    const pkg = await odak().uiTestProject();
    if (!pkg) throw new Error('no project');
    await until('home', () => !!$('.home'));
    await sleep(300);
    check(!!byText('button', 'Kaydı Başlat') && !!$('.projects'), 'home screen shows recording panel and projects');
    log.push(`shot: ${await odak().uiTestCapture('1-home')}`);

    await hooks().openProject(pkg);
    await until('editor', () => !!$('.editor') && $$('.zoom').length > 0);
    await sleep(1200);
    const initialZooms = project().clips[0].zooms.length;
    check(initialZooms >= 1, `editor opened the project with ${initialZooms} zoom(s)`);
    log.push(`shot: ${await odak().uiTestCapture('2-editor')}`);

    // Seek with the timeline to an empty spot after the first zoom and add a zoom there.
    const tl = $('.timeline')!;
    const r = tl.getBoundingClientRect();
    const dur = project().clips.reduce((s, c) => s + c.sourceEnd - c.sourceStart, 0);
    const pps = (r.width - 36) / dur;
    const firstEnd = project().clips[0].zooms[0].end;
    const nextStart = project().clips[0].zooms[1]?.start ?? dur;
    const target = (firstEnd + nextStart) / 2 - 0.3;
    pointer(tl, 'pointerdown', r.left + 18 + target * pps, r.top + 10); pointer(tl, 'pointerup', r.left + 18 + target * pps, r.top + 10);
    await sleep(200);
    click(byText('button', 'Zoom Ekle'));
    await until('zoom added', () => project().clips[0].zooms.length === initialZooms + 1);
    const added = selectedZoom()!;
    check(!!added && !added.isGenerated && Math.abs(added.start - target) < 0.1, `“Zoom Ekle” adds a selected zoom at the playhead (${added?.start.toFixed(2)}s)`);
    check(!!byText('.inspector h3', 'Zoom') && !!byText('.badge', 'Elle düzenlendi'), 'inspector shows the selected zoom');

    // Drag the block far left: it must stop at the previous zoom and keep its length.
    const block = $('.zoom.selected')!;
    const b = block.getBoundingClientRect();
    const len = added.end - added.start;
    pointer(block, 'pointerdown', b.left + b.width / 2, b.top + 10);
    pointer(block, 'pointermove', b.left + b.width / 2 - 400, b.top + 10);
    pointer(block, 'pointerup', b.left + b.width / 2 - 400, b.top + 10);
    await sleep(100);
    const moved = selectedZoom()!;
    check(moved.start < added.start - 0.2 && Math.abs(moved.end - moved.start - len) < 1e-6 && Math.abs(moved.start - firstEnd) < 1e-6,
      `dragging moves the zoom and stops at the neighbour (${moved.start.toFixed(2)}–${moved.end.toFixed(2)})`);

    setRange($<HTMLInputElement>('.inspector input[type=range]')!, 3);
    await sleep(50);
    check(Math.abs(selectedZoom()!.scale - 3) < 1e-9, 'amount slider sets ×3');

    click(byText('.segmented button', 'Sabit nokta'));
    await until('fixed focus', () => !!$('.focus-picker'));
    await sleep(400);
    const fp = $('.focus-picker')!.getBoundingClientRect();
    pointer($('.focus-picker')!, 'pointerdown', fp.left + fp.width * 0.8, fp.top + fp.height * 0.2);
    pointer($('.focus-picker')!, 'pointerup', fp.left + fp.width * 0.8, fp.top + fp.height * 0.2);
    await sleep(50);
    const f = selectedZoom()!.focus;
    check('fixed' in f && Math.abs(f.fixed.x - 0.8) < 0.01 && Math.abs(f.fixed.y - 0.2) < 0.01, 'focus picker sets a fixed point at (0.8, 0.2)');
    log.push(`shot: ${await odak().uiTestCapture('3-zoom-inspector')}`);

    click(byText('.toolbar button', '↶'));
    await sleep(50);
    const undone = selectedZoom()?.focus;
    check(!!undone && !('fixed' in undone && Math.abs(undone.fixed.x - 0.8) < 0.01), 'undo reverts the focus point');
    click(byText('.toolbar button', '↷'));
    await sleep(50);
    const redone = selectedZoom()?.focus;
    check(!!redone && 'fixed' in redone && Math.abs(redone.fixed.x - 0.8) < 0.01, 'redo restores it');

    // Deselect by clicking the timeline, then change the look.
    pointer(tl, 'pointerdown', r.left + 30, r.top + 10); pointer(tl, 'pointerup', r.left + 30, r.top + 10);
    await until('style inspector', () => !!byText('.inspector h3', 'Arka plan'));
    click(byText('.inspector label', 'Gölge')?.querySelector('input') ?? null);
    await sleep(50);
    check(project().style.shadow === false, 'shadow checkbox updates the project style');

    click(byText('.inspector .segmented button', 'Tema'));
    await until('themes', () => $$('.theme').length >= 8);
    click(byText('.theme', 'Kutlama'));
    await sleep(400);
    check(project().style.backgroundKind === 'theme' && project().style.backgroundTheme === 'kutlama' && project().style.padding >= 0.1,
      'choosing the “Kutlama” theme sets the background (and enough padding to show it)');
    click($$('.cursor-opt').find((b) => b.title === 'Nokta') ?? null);
    await sleep(50);
    check(project().style.cursorStyle === 'dot', 'cursor style “Nokta” is applied');
    click(byText('.inspector label', 'Vurgu halkası')?.querySelector('input') ?? null);
    await sleep(50);
    check(project().style.cursorHighlight === true, 'highlight toggle is applied');
    if (project().media.some((m) => m.cameraFile)) {
      click($$('.corners button').find((b) => b.textContent === '↖') ?? null);
      click(byText('.inspector .segmented button', 'Yuvarlak köşe'));
      await sleep(50);
      check(project().style.camera.position === 'top-left' && project().style.camera.shape === 'rounded', 'camera position and shape controls work');
    } else check(false, 'test project has a camera recording');
    await sleep(600);
    log.push(`shot: ${await odak().uiTestCapture('4-looks')}`);

    click($('.transport .play'));
    await sleep(1500);
    const playingLabel = $('.transport .play')!.textContent;
    const timeText = $('.transport .mono')!.textContent ?? '';
    click($('.transport .play'));
    await sleep(200);
    check(playingLabel === '❚❚' && !timeText.startsWith('00:00.0'), `play advances time (${timeText.split(' / ')[0]})`);
    check($('.transport .play')!.textContent === '▶', 'pause stops playback');

    click(byText('.toolbar button', 'Dışa Aktar'));
    await until('export dialog', () => !!byText('.modal h2', 'Video Dışa Aktar'));
    check(!!byText('.modal button', 'Dışa Aktar…'), 'export dialog opens with its options');
    log.push(`shot: ${await odak().uiTestCapture('5-export-dialog')}`);
    click(byText('.modal button', 'Kapat'));
    await until('dialog closed', () => !byText('.modal h2', 'Video Dışa Aktar'));

    await sleep(800);
    const saved = await odak().loadProject(pkg);
    check(!!saved.project && JSON.stringify(normalizeProject(saved.project)) === JSON.stringify(project()), 'autosave wrote the edits to project.json');
    log.push(`shot: ${await odak().uiTestCapture('6-editor-final')}`);
  } catch (e) {
    check(false, `exception: ${(e as Error).stack ?? e}`);
  }
  odak().selftestDone({ ok: failures === 0, log });
}
