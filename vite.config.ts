import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR and getUserMedia both require a secure context, and only localhost is
// exempt. Testing on the Quest therefore means serving the LAN address over
// HTTPS — hence the self-signed cert, which the headset browser will warn about
// once per session before letting you continue.
const lan = process.env.RHUD_LAN === '1';

// Stamped into the page so a stale bundle in the headset browser is obvious
// rather than looking like a broken feature. Injected as a meta tag instead of
// via `define`, because define substitution does not run in the dev transform —
// the identifier would survive to the browser and throw a ReferenceError.
const buildId = Date.now().toString(36).slice(-6);

const buildStamp = {
  name: 'rhud-build-stamp',
  transformIndexHtml() {
    return [{ tag: 'meta', attrs: { name: 'rhud-build', content: buildId }, injectTo: 'head' }];
  },
} as const;

export default defineConfig({
  plugins: lan ? [basicSsl(), buildStamp] : [buildStamp],
  server: {
    port: 5173,
    host: lan ? true : 'localhost',
    // The Quest browser is happy to serve a cached bundle across a restart.
    headers: { 'Cache-Control': 'no-store' },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
});
