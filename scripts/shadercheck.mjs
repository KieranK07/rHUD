/**
 * Headless shader smoke test.
 *
 * Shaders only compile once a camera stream exists, which makes the riskiest
 * code in the project also the least reachable. This loads dev/shadercheck.html
 * against a synthetic hand in headless Chrome, then reads the framebuffer back
 * to confirm the reticle actually rasterized — compiling and drawing are not
 * the same thing.
 *
 * Requires the dev server to be running. Exits non-zero on failure.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The dev server runs http on localhost but https under `dev:lan`, so try both
// rather than failing confusingly depending on which one happens to be up.
const URLS = process.env.RHUD_URL
  ? [process.env.RHUD_URL]
  : [
      'http://localhost:5173/dev/shadercheck.html',
      'https://localhost:5173/dev/shadercheck.html',
    ];

const TIMEOUT_MS = Number(process.env.RHUD_SHADERCHECK_TIMEOUT ?? 30000);

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  // Playwright's headless shell, if a browser install left one behind. It
  // starts far more reliably than Chrome.app, which drags in the updater.
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    const shells = readdirSync(cache)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse();
    for (const shell of shells) {
      const bin = join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }

  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(chrome)) return chrome;
  return null;
}

const bin = findChrome();
if (!bin) {
  console.error('[shadercheck] no Chrome binary found — set CHROME_BIN');
  process.exit(2);
}

function run(url) {
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      [
        '--headless',
        '--disable-gpu',
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
        '--ignore-certificate-errors', // dev:lan serves a self-signed cert
        '--window-size=1280,720',
        '--virtual-time-budget=8000',
        `--user-data-dir=${join(process.env.TMPDIR ?? '/tmp', 'rhud-shadercheck')}`,
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    // Chrome.app often writes the DOM and then never exits, so stop reading
    // as soon as the verdict is in, and kill it outright if it hangs.
    let dom = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      const match = /id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
      resolve(
        match
          ? match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          : null,
      );
    };
    const timer = setTimeout(() => {
      console.error(`[shadercheck] Chrome gave no verdict in ${TIMEOUT_MS / 1000}s, killed it`);
      finish();
    }, TIMEOUT_MS);
    child.stdout.on('data', (c) => {
      dom += c;
      if (/RESULT: (PASS|FAIL)[\s\S]*<\/pre>/.test(dom)) finish();
    });
    child.on('close', finish);
    child.on('error', finish);
  });
}

let report = null;
for (const url of URLS) {
  report = await run(url);
  if (report) break;
}

if (!report) {
  console.error('[shadercheck] no output — is the dev server running? tried:\n  ' + URLS.join('\n  '));
  process.exit(1);
}

console.log(report.trim());
process.exit(report.includes('RESULT: PASS') ? 0 : 1);
