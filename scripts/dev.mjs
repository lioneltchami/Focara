// Development: Vite dev server for the UI + Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { buildElectron } from './build.mjs';
import electron from 'electron';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen(5173);
await buildElectron();
const url = server.resolvedUrls.local[0];
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ODAK_DEV_URL: url } });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
