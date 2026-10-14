import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Strict Content-Security-Policy for the packaged app (the dev server needs inline scripts).
const csp: Plugin = {
  name: 'odak-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:" />`),
};

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react(), csp],
  build: { outDir: '../dist', emptyOutDir: true, target: 'chrome140', chunkSizeWarningLimit: 2000 },
});
