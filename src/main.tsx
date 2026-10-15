import { createRoot } from 'react-dom/client';
import { odak } from './bridge.ts';
import { setLang } from './i18n/index.ts';

// The interface language (the system's, or the one picked in Settings) before anything is drawn.
const language = odak().settings();
setLang(language.lang);
document.documentElement.lang = language.lang;

if (odak().isSelftest) {
  void import('./selftest.ts').then((m) => m.runSelftest());
} else {
  if (odak().isPerfTest) void import('./perftest.ts').then((m) => m.runPerfTest());
  else if (odak().isDocshots) void import('./docshots.ts').then((m) => m.runDocshots());
  else if (odak().isUiTest) void import('./uitest.ts').then((m) => m.runUiTest());
  void import('./ui/App.tsx').then(({ App }) => {
    createRoot(document.getElementById('root')!).render(<App />);
  });
}
