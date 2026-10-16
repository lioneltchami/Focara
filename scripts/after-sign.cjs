// macOS keeps privacy permissions (screen recording, camera, microphone) tied to an app's
// "designated requirement". An ad-hoc signature's default requirement is its exact hash, so every
// new build would lose the permissions. Re-sign the app bundle with a requirement on the bundle
// identifier instead, so permissions granted once survive updates.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Respect explicit unsigned builds; re-signing them here can make strict verification fail.
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return;
  // electron-builder deliberately skips signing pull-request builds; do not verify an unsigned bundle here.
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Preserve electron-builder's Developer ID signature for release builds. It already gives
  // macOS a stable designated requirement across updates.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    return;
  }
  const id = context.packager.appInfo.id;
  execFileSync('codesign', ['--force', '--sign', '-', `-r=designated => identifier "${id}"`, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
