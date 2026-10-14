// Drives the real UI with DOM events (no OS-level input): home screen, open project, add/drag/
// edit zooms, fixed focus, undo/redo, style toggle, playback, export dialog, autosave.
import { odak } from './bridge.ts';
import { type Project, clipDuration, clipStarts, normalizeProject, projectDuration } from './core/model.ts';
import type { EditorStore } from './ui/store.ts';
import { speedRange } from './core/edit.ts';

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
    const tl = $('.timeline-inner')!;
    const r = tl.getBoundingClientRect();
    const dur = project().clips.reduce((s, c) => s + c.sourceEnd - c.sourceStart, 0);
    const pps = (r.width - 36) / dur;
    const firstEnd = project().clips[0].zooms[0].end;
    const nextStart = project().clips[0].zooms[1]?.start ?? dur;
    const target = (firstEnd + nextStart) / 2 - 0.3;
    pointer(tl, 'pointerdown', r.left + 18 + target * pps, r.top + 10); pointer(tl, 'pointerup', r.left + 18 + target * pps, r.top + 10);
    await sleep(200);
    click(byText('.timeline-bar button', '＋ Zoom'));
    await until('zoom added', () => project().clips[0].zooms.length === initialZooms + 1);
    const added = selectedZoom()!;
    check(!!added && !added.isGenerated && Math.abs(added.start - target) < 0.1, `“＋ Zoom” adds a selected zoom at the playhead (${added?.start.toFixed(2)}s)`);
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

    // ---- Clip editing through the real timeline and inspector
    const ed = (window as unknown as { __odakEditor: { importFile: (p: string) => Promise<string>; player: { currentTime: number } } }).__odakEditor;
    const inner = () => $('.timeline-inner')!;
    const xAt = (t: number) => { const sc = $('.timeline')!; const pps = (sc.clientWidth - 36) / projectDuration(project()); return inner().getBoundingClientRect().left + 18 + t * pps; };
    const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const clipEls = () => $$('.clip');
    const y = (el: Element) => el.getBoundingClientRect().top + 20;

    pointer(inner(), 'pointerdown', xAt(5), y(inner()) + 160); pointer(inner(), 'pointerup', xAt(5), y(inner()) + 160);
    await sleep(150);
    const n0 = project().clips.length;
    key('s');
    await until('split', () => project().clips.length === n0 + 1);
    check(Math.abs(project().clips[0].sourceEnd - ed.player.currentTime) < 0.05 && store().selection?.kind === 'clip', `S splits at the playhead (${project().clips[0].sourceEnd.toFixed(2)} s)`);

    click(byText('.inspector button', 'Çoğalt'));
    await until('duplicate', () => project().clips.length === n0 + 2);
    check(true, 'Çoğalt duplicates the clip');
    click(byText('.inspector .segmented button', '×2'));
    await sleep(50);
    const selC = () => project().clips.find((c) => c.id === (store().selection as { clipID: string }).clipID)!;
    check(selC().speed === 2, 'speed ×2 from the clip inspector');

    const first = clipEls()[0], h = first.querySelector('.trim.r')!, hr = h.getBoundingClientRect();
    const end0 = project().clips[0].sourceEnd;
    pointer(h, 'pointerdown', hr.left + 4, hr.top + 10); pointer(h, 'pointermove', hr.left - 60, hr.top + 10); pointer(h, 'pointerup', hr.left - 60, hr.top + 10);
    await sleep(80);
    check(project().clips[0].sourceEnd < end0 - 0.2, `dragging the end edge trims (${end0.toFixed(2)} → ${project().clips[0].sourceEnd.toFixed(2)} s)`);

    const lastId = project().clips[project().clips.length - 1].id;
    const last = clipEls()[clipEls().length - 1], lr = last.getBoundingClientRect(), fr = clipEls()[0].getBoundingClientRect();
    pointer(last, 'pointerdown', lr.left + lr.width / 2, lr.top + 20); pointer(last, 'pointermove', fr.left + 5, fr.top + 20); pointer(last, 'pointerup', fr.left + 5, fr.top + 20);
    await sleep(80);
    check(project().clips[0].id === lastId, 'dragging a clip reorders it to the front');

    // Zooming the timeline view must only widen the timeline's content, never the window layout.
    const appW = () => $('.editor')!.getBoundingClientRect().width;
    const w0 = appW(), in0 = inner().getBoundingClientRect().width;
    click($$('.bar-zoom button')[1]);
    await sleep(600);
    const w1 = appW(), in1 = inner().getBoundingClientRect().width;
    check(Math.abs(w1 - w0) < 1 && in1 > in0 * 1.5 && in1 < in0 * 1.7 && document.documentElement.scrollWidth <= window.innerWidth,
      `timeline ＋ zooms the timeline only (window ${w0.toFixed(0)} → ${w1.toFixed(0)} px, timeline ${in0.toFixed(0)} → ${in1.toFixed(0)} px)`);
    click($$('.bar-zoom button')[2]);
    await sleep(200);

    // Playhead: grab the red head and drag it; the ruler scrubs too.
    const knob = $('.playhead-knob')!, kr = knob.getBoundingClientRect();
    pointer(knob, 'pointerdown', kr.left + 8, kr.top + 8); pointer(knob, 'pointermove', xAt(3), kr.top + 8);
    await sleep(60);
    const dragging = !!$('.playhead.dragging') && !!$('.playhead-time');
    pointer(knob, 'pointerup', xAt(3), kr.top + 8);
    await sleep(120);
    check(dragging && Math.abs(ed.player.currentTime - 3) < 0.08, `dragging the playhead head moves it (→ ${ed.player.currentTime.toFixed(2)} s)`);
    const ruler = $('.ruler')!;
    pointer(ruler, 'pointerdown', xAt(1), y(ruler)); pointer(ruler, 'pointermove', xAt(2), y(ruler)); pointer(ruler, 'pointerup', xAt(2), y(ruler));
    await sleep(120);
    check(Math.abs(ed.player.currentTime - 2) < 0.08 && !$('.range'), `dragging on the ruler scrubs (→ ${ed.player.currentTime.toFixed(2)} s)`);
    log.push(`shot: ${await odak().uiTestCapture('5a-playhead')}`);

    // Scissors (C): click on a clip to cut exactly there.
    key('c');
    await until('scissors tool', () => !!$('.timeline.tool-blade'));
    const nB = project().clips.length;
    const cutX = xAt(1.5), cutClip = clipEls()[0];
    pointer(cutClip, 'pointermove', cutX, y(cutClip));
    await sleep(30);
    const preview = !!$('.blade-line');
    pointer(cutClip, 'pointerdown', cutX, y(cutClip)); pointer(inner(), 'pointerup', cutX, y(cutClip));
    await sleep(80);
    check(preview && project().clips.length === nB + 1 && clipStarts(project()).some((t) => Math.abs(t - 1.5) < 0.05),
      'scissors tool shows the cut line and splits where clicked');

    // Range (R): drag over the clips to select a part, then speed it up / make it a clip / delete it.
    click(byText('.timeline-bar button', 'Aralık'));
    await until('range tool', () => !!$('.timeline.tool-range'));
    const dragRange = async (a: number, b: number) => {
      const c0 = clipEls()[0];
      pointer(c0, 'pointerdown', xAt(a), y(c0)); pointer(inner(), 'pointermove', xAt(b), y(c0)); pointer(inner(), 'pointerup', xAt(b), y(c0));
      await until('range', () => !!$('.range-bar'));
    };
    const curRange = () => (window as unknown as { __odakEditor: { range: { a: number; b: number } | null } }).__odakEditor.range!;
    let before = projectDuration(project());
    await dragRange(2, 3.5);
    log.push(`shot: ${await odak().uiTestCapture('5b-range')}`);
    const r1 = curRange(), prev = project();
    click(byText('.range-bar button', '×2'));
    await sleep(80);
    const expected = projectDuration(speedRange(prev, r1.a, r1.b, 2).project);
    check(Math.abs(r1.a - 2) < 0.05 && Math.abs(r1.b - 3.5) < 0.05 && Math.abs(projectDuration(project()) - expected) < 1e-6 && expected < before - 0.3 && !$('.range'),
      `range ${r1.a.toFixed(2)}–${r1.b.toFixed(2)} s at ×2 (${before.toFixed(2)} → ${projectDuration(project()).toFixed(2)} s)`);
    store().undo();
    await sleep(50);
    await dragRange(2, 3.5);
    const r2 = curRange();
    click(byText('.range-bar button', 'Ayır'));
    await sleep(80);
    const sel = project().clips.findIndex((c) => c.id === (store().selection as { clipID: string } | null)?.clipID);
    const st = clipStarts(project()), ends = st.map((t, i) => t + clipDuration(project().clips[i]));
    check(sel >= 0 && Math.abs(st[sel] - r2.a) < 0.11 && ends.some((t) => Math.abs(t - r2.b) < 0.11) && !!$('.timeline.tool-select'),
      'Ayır cuts at both ends of the range, selects it and returns to Seç');

    before = projectDuration(project());
    key('r');
    await until('range tool', () => !!$('.timeline.tool-range'));
    await dragRange(1, 2.5);
    key('Delete');
    await sleep(80);
    check(Math.abs(projectDuration(project()) - (before - 1.5)) < 0.05, `range select + Delete removes 1.5 s (${before.toFixed(2)} → ${projectDuration(project()).toFixed(2)} s)`);
    key('Escape');

    const cam = project().media.find((m) => m.cameraFile)?.cameraFile;
    const newId = await ed.importFile(`${pkg}/${cam}`);
    await sleep(100);
    const imported = project().clips.find((c) => c.id === newId);
    check(!!imported && project().media.some((m) => m.id === imported.mediaID && m.kind === 'externalVideo') && clipDuration(imported) > 9,
      'importing a video adds it as a clip');

    click(byText('.timeline-bar button', 'Durgun'));
    await until('quiet dialog', () => !!byText('.modal h2', 'Durgun anlar') && !byText('.modal p', 'inceleniyor'), 15000);
    check(!!byText('.modal button', 'Hızlandır'), 'quiet moments dialog analyses the recording');
    log.push(`shot: ${await odak().uiTestCapture('5-quiet')}`);
    click(byText('.modal button', 'Vazgeç'));
    await until('quiet closed', () => !byText('.modal h2', 'Durgun anlar'));

    const n1 = project().clips.length;
    store().select({ kind: 'clip', clipID: newId });
    await sleep(30);
    key('Delete');
    await until('clip deleted', () => project().clips.length === n1 - 1);
    click(byText('.toolbar button', '↶'));
    await until('undo delete', () => project().clips.length === n1);
    check(true, 'Delete removes the selected clip, undo brings it back');
    await sleep(300);
    log.push(`shot: ${await odak().uiTestCapture('6-timeline')}`);

    click(byText('.toolbar button', 'Dışa Aktar'));
    await until('export dialog', () => !!byText('.modal h2', 'Video Dışa Aktar'));
    check(!!byText('.modal button', 'Dışa Aktar…'), 'export dialog opens with its options');
    log.push(`shot: ${await odak().uiTestCapture('7-export-dialog')}`);
    click(byText('.modal button', 'Kapat'));
    await until('dialog closed', () => !byText('.modal h2', 'Video Dışa Aktar'));

    await sleep(800);
    const saved = await odak().loadProject(pkg);
    check(!!saved.project && JSON.stringify(normalizeProject(saved.project)) === JSON.stringify(project()), 'autosave wrote the edits to project.json');
    log.push(`shot: ${await odak().uiTestCapture('8-editor-final')}`);
  } catch (e) {
    check(false, `exception: ${(e as Error).stack ?? e}`);
  }
  odak().selftestDone({ ok: failures === 0, log });
}
