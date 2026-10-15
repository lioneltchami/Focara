import { useEffect, useState } from 'react';
import { projectDuration } from '../core/model.ts';
import { applyQuietRanges, findQuietRanges, quietDefaults } from '../core/edit.ts';
import { MediaLibrary } from '../media/media.ts';
import { timecode } from './Editor.tsx';
import type { EditorStore } from './store.ts';
import { t } from '../i18n/index.ts';

type Found = { mediaID: string; ranges: { start: number; end: number }[] };

/**
 * Finds the moments where nothing happens (screen unchanged, cursor still, silence) in the
 * project's screen recordings, and speeds them up or cuts them out in one step.
 */
export function QuietDialog({ store, lib, onClose }: { store: EditorStore; lib: MediaLibrary; onClose: () => void }) {
  const [minLength, setMinLength] = useState(2);
  const [mode, setMode] = useState<'speed' | 'cut'>('speed');
  const [speed, setSpeed] = useState(4);
  const [found, setFound] = useState<Found[] | null>(null);

  useEffect(() => {
    let alive = true;
    setFound(null);
    void (async () => {
      const p = store.project;
      const out: Found[] = [];
      for (const m of p.media) {
        const clips = p.clips.filter((c) => c.mediaID === m.id && (c.speed || 1) === 1);
        if (m.kind !== 'screenRecording' || !clips.length) continue;
        const [cursor, frameTimes, audio] = await Promise.all([lib.cursor(m), lib.frameTimes(m), lib.envelope(m)]);
        const ranges = findQuietRanges({ cursor, frameTimes, audio, audioStep: MediaLibrary.ENVELOPE_STEP }, m.duration, { ...quietDefaults, minLength })
          // only the parts that are actually on the timeline (at normal speed)
          .flatMap((r) => clips.map((c) => ({ start: Math.max(r.start, c.sourceStart), end: Math.min(r.end, c.sourceEnd) })))
          .filter((r) => r.end - r.start > 0.3);
        if (ranges.length) out.push({ mediaID: m.id, ranges });
      }
      if (alive) setFound(out);
    })();
    return () => { alive = false; };
  }, [minLength, lib, store]);

  const all = found?.flatMap((f) => f.ranges) ?? [];
  const total = all.reduce((s, r) => s + r.end - r.start, 0);
  const saved = mode === 'cut' ? total : total * (1 - 1 / speed);
  const before = projectDuration(store.project);

  const apply = () => {
    if (!found?.length) return;
    store.update((p) => found.reduce((q, f) => applyQuietRanges(q, f.mediaID, f.ranges, mode, speed), p));
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>{t('Durgun anlar')}</h2>
        <p className="muted small">
          {t('Ekranın değişmediği, imlecin kıpırdamadığı ve ses olmayan anları bulur. Her anın başında ve sonunda kısa bir pay bırakılır, böylece hiçbir hareketin ucu kesilmez.')}
        </p>
        <label className="field">{t('En kısa durgun an: {s} sn', { s: minLength.toFixed(1) })}
          <input type="range" min={1} max={8} step={0.5} value={minLength} onChange={(e) => setMinLength(Number(e.target.value))} />
        </label>
        <div className="segmented">
          <button className={mode === 'speed' ? 'on' : ''} onClick={() => setMode('speed')}>{t('Hızlandır')}</button>
          <button className={mode === 'cut' ? 'on' : ''} onClick={() => setMode('cut')}>{t('Kes')}</button>
        </div>
        {mode === 'speed' && (
          <div className="segmented">
            {[2, 4, 8].map((s) => <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>×{s}</button>)}
          </div>
        )}
        {found === null
          ? <p className="muted">{t('Kayıt inceleniyor…')}</p>
          : all.length === 0
            ? <p className="muted">{t('Bu ayarla durgun an bulunamadı.')}</p>
            : <>
                <p>{t('Bulunan yer: {n} · toplam {s} sn', { n: all.length, s: total.toFixed(1) })}<br />
                  {t('Video süresi: {before} → {after}', { before: timecode(before, false), after: timecode(Math.max(0, before - saved), false) })}</p>
                <ul className="quiet-list">
                  {all.slice(0, 8).map((r, i) => <li key={i} className="mono">{timecode(r.start)} – {timecode(r.end)} ({t('{s} sn', { s: (r.end - r.start).toFixed(1) })})</li>)}
                  {all.length > 8 && <li className="muted">{t('… ve {n} yer daha', { n: all.length - 8 })}</li>}
                </ul>
              </>}
        <p className="muted small">{t('Hızlandırılan yerlerde ses kapatılır. İstemediğin bir yeri sonradan klibi seçip hızını 1× yaparak geri alabilirsin.')}</p>
        <div className="row end">
          <button onClick={onClose}>{t('Vazgeç')}</button>
          <button className="primary" disabled={!all.length} onClick={apply}>{mode === 'cut' ? t('Kes') : t('×{n} Hızlandır', { n: speed })}</button>
        </div>
      </div>
    </div>
  );
}

