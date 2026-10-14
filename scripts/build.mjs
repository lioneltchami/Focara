// Builds the main/preload bundles (esbuild) and the UI (Vite). Same on macOS and Windows.
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';

export async function buildElectron(watch = false) {
  for (const [entry, out] of [['electron/main.ts', 'dist-electron/main.cjs'], ['electron/preload.ts', 'dist-electron/preload.cjs']]) {
    await esbuild({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs',
      target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'warning' });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build.mjs')) {
  await buildElectron();
  await vite({ configFile: 'vite.config.ts', logLevel: 'warn' });
  console.log('build ok');
}
