import { createRoot } from 'react-dom/client';
import { odak } from './bridge.ts';

if (odak().isSelftest) {
  void import('./selftest.ts').then((m) => m.runSelftest());
} else {
  if (odak().isUiTest) void import('./uitest.ts').then((m) => m.runUiTest());
  void import('./ui/App.tsx').then(({ App }) => {
    createRoot(document.getElementById('root')!).render(<App />);
  });
}
