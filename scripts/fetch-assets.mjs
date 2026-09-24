// Vendors the MediaPipe runtime into public/ so the app boots offline and fast.
//
// Two things get pulled in:
//   public/wasm/   - copied out of node_modules (the tasks-vision WASM runtime)
//   public/models/ - downloaded once from Google's model CDN (~7.8 MB)
//
// Both are gitignored. Runs on postinstall; safe to re-run (skips existing files).

import { mkdir, copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const WASM_SRC = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const WASM_DEST = join(root, 'public/wasm');

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const MODEL_DEST = join(root, 'public/models/hand_landmarker.task');

async function copyWasm() {
  if (!existsSync(WASM_SRC)) {
    console.warn('[assets] tasks-vision wasm not found — run npm install first');
    return;
  }
  await mkdir(WASM_DEST, { recursive: true });
  const files = await readdir(WASM_SRC);
  for (const f of files) {
    await copyFile(join(WASM_SRC, f), join(WASM_DEST, f));
  }
  console.log(`[assets] wasm runtime -> public/wasm (${files.length} files)`);
}

async function fetchModel() {
  if (existsSync(MODEL_DEST)) {
    const { size } = await stat(MODEL_DEST);
    console.log(`[assets] model already present (${(size / 1e6).toFixed(1)} MB)`);
    return;
  }
  await mkdir(dirname(MODEL_DEST), { recursive: true });
  console.log('[assets] downloading hand_landmarker.task …');

  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status} ${res.statusText}`);

  await writeFile(MODEL_DEST, Buffer.from(await res.arrayBuffer()));
  const { size } = await stat(MODEL_DEST);
  console.log(`[assets] model -> public/models (${(size / 1e6).toFixed(1)} MB)`);
}

await copyWasm();
await fetchModel();
