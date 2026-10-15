import { useEffect } from 'react';
import { type LanguageState, odak } from '../bridge.ts';
import { type LangPref, languages, t } from '../i18n/index.ts';

/** App settings: interface language (system / Türkçe / English) and the diagnostics log. */
export function SettingsDialog({ state, onPick, onClose }: { state: LanguageState; onPick: (pref: LangPref) => void; onClose: () => void }) {
  // While open, keys belong to the dialog (Esc closes it) and never reach the editor behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const systemName = languages.find((l) => l.id === state.system)?.name ?? '—';
  const options: [LangPref, string][] = [['auto', t('Sistem dili')], ...languages.map((l) => [l.id, l.name] as [LangPref, string])];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <h2>{t('Ayarlar')}</h2>
        <section className="setting">
          {/* Always in both languages, so it can be found whatever the current one is. */}
          <h3 data-raw>Dil · Language</h3>
          <div className="segmented language">
            {options.map(([pref, name]) => (
              <button key={pref} className={state.pref === pref ? 'on' : ''} onClick={() => onPick(pref)} data-raw={pref !== 'auto' || undefined}>{name}</button>
            ))}
          </div>
          <p className="muted small">{t('Bilgisayarının dili: {name}. “Sistem dili” seçiliyken Focara bu dille açılır; Türkçe dışındaki diller için İngilizce kullanılır.', { name: systemName })}</p>
        </section>
        <section className="setting">
          <h3>{t('Tanılama')}</h3>
          <p className="muted small">{t('Bir sorun olursa bu kayıt dosyası neyin ters gittiğini gösterir. Videolarından hiçbir şey içermez.')}</p>
          <button onClick={() => void odak().revealLog()}>{t('Tanılama Kaydını Göster')}</button>
        </section>
        <div className="row end"><button className="primary" onClick={onClose}>{t('Tamam')}</button></div>
      </div>
    </div>
  );
}
