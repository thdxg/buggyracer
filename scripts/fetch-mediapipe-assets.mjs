// Copies the MediaPipe wasm bundle out of node_modules and downloads the hand
// landmarker model, so the venue demo never depends on a third-party CDN.
import { mkdirSync, copyFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'client/public/mediapipe/wasm');
const modelDst = join(root, 'client/public/models/hand_landmarker.task');

// Pinned model revision. "latest" in the upstream path is a floating pointer; pin it.
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

mkdirSync(wasmDst, { recursive: true });
mkdirSync(dirname(modelDst), { recursive: true });

if (!existsSync(wasmSrc)) {
  console.error('! @mediapipe/tasks-vision wasm folder missing - run bun install first');
  process.exit(1);
}
for (const f of readdirSync(wasmSrc)) {
  copyFileSync(join(wasmSrc, f), join(wasmDst, f));
}
console.log(`copied ${readdirSync(wasmDst).length} wasm files -> client/public/mediapipe/wasm`);

if (existsSync(modelDst)) {
  console.log('model already present, skipping download');
} else {
  const res = await fetch(MODEL_URL);
  if (!res.ok) {
    console.error(`! model download failed: ${res.status} ${res.statusText}`);
    console.error(`  fetch it manually into ${modelDst}`);
    process.exit(1);
  }
  writeFileSync(modelDst, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded hand_landmarker.task (${(existsSync(modelDst) && (await import('node:fs')).statSync(modelDst).size / 1024 / 1024).toFixed(2)} MB)`);
}
