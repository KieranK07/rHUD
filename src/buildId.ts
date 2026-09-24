/**
 * Identifies the running bundle.
 *
 * Injected as a meta tag by the build-stamp plugin in vite.config.ts rather
 * than through `define`, whose substitution does not run in Vite's dev
 * transform — the bare identifier would reach the browser and throw.
 */
export const BUILD_ID =
  document.querySelector('meta[name="rhud-build"]')?.getAttribute('content') ?? 'unknown';
