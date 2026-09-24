/**
 * WebXR session lifecycle.
 *
 * `immersive-ar` on a Quest means passthrough: the headset composites the real
 * world behind whatever the page draws. The page must therefore render with a
 * transparent background — anything opaque, including a clear colour, paints
 * over reality and turns the HUD into plain VR in a black void.
 */

import type { WebGLRenderer } from 'three';

export type XRMode = 'immersive-ar' | 'immersive-vr';

export async function supportedXRMode(): Promise<XRMode | null> {
  const xr = navigator.xr;
  if (!xr) return null;

  try {
    if (await xr.isSessionSupported('immersive-ar')) return 'immersive-ar';
    // Headsets without passthrough can still run the HUD against a black void,
    // which is useful for checking tracking and visuals.
    if (await xr.isSessionSupported('immersive-vr')) return 'immersive-vr';
  } catch {
    return null;
  }
  return null;
}

export async function enterXR(renderer: WebGLRenderer, mode: XRMode): Promise<XRSession> {
  const session = await navigator.xr!.requestSession(mode, {
    // hand-tracking is required, not optional: without it rHUD has no input at
    // all and would present an empty scene rather than failing honestly.
    requiredFeatures: ['local-floor', 'hand-tracking'],
    // depth-sensing is optional by contrast — it powers the world stylization
    // in DepthFX, but a headset without it should still run the HUD.
    optionalFeatures: ['bounded-floor', 'layers', 'depth-sensing'],
    depthSensing: {
      // gpu-optimized ONLY, deliberately. three initialises depth sensing just
      // when `session.depthUsage == 'gpu-optimized'` — offering cpu-optimized
      // as a fallback is actively harmful, because a runtime that picks it
      // leaves three ignoring the depth data entirely and the effect silently
      // does nothing. Better to be handed no depth at all than depth in a form
      // that cannot be used.
      usagePreference: ['gpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    },
  } as XRSessionInit);

  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);

  return session;
}
