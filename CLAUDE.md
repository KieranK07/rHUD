# rHUD

Iron Man–style hand-tracked HUD. A phone acts as a POV camera over the user's
hands via macOS Continuity Camera; the Mac screen shows a stylized realtime
render with reticles locked onto each hand. Gestures resolve to named actions.

The eventual target is a Quest 3 / Android XR headset, where WebXR supplies
hand joints directly and this codebase's render layer carries over unchanged.

## Commands

```bash
npm run dev          # vite dev server on :5173 (localhost, http)
npm run dev:lan      # https on the LAN — required for Quest testing
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + production build
npm run shadercheck  # headless shader smoke test (needs dev server running)
npm run assets       # re-vendor MediaPipe wasm + model (runs on postinstall)
```

Keyboard, in-app: `S` skeleton overlay · `H` debug panel · `F` blank the video
feed · `R` re-pick camera.

## Non-negotiables

These are the things that will silently ruin the project if broken. Each exists
for a reason that is not obvious from the code alone.

**1. Nothing downstream of `src/input/HandSource.ts` may import a MediaPipe
type.** That interface is the seam that makes the Quest port a matter of adding
one file. `MediaPipeHandSource.ts` is the only place `@mediapipe/*` appears —
keep it that way.

**2. There is exactly one video-to-screen transform,
`src/core/viewport.ts`.** (Mirror mode only — XR uses `MetricSpace`.) The feed quad and the joint mapping both derive from
it. If the video is ever drawn by CSS or a second transform is computed
anywhere, the reticles will sit *near* the hands but never *on* them — and it
will read as a tracking bug, sending you looking in entirely the wrong place.

**3. MediaPipe's handedness labels are inverted here, and
`flipChirality()` in `MediaPipeHandSource.ts` corrects them.** The model
classifies left/right assuming a *mirrored selfie* image; rHUD's camera is
world-facing. If handedness looks wrong, check whether something introduced a
mirror before touching that function.

**4. The camera is never mirrored.** POV framing means the user sees their own
hands as they actually are.

## Coordinate spaces

There are three, and mixing them is the main source of registration bugs:

| Space | Units | Origin | Where |
|---|---|---|---|
| Image | 0..1 normalized | top-left, **Y-down** | raw `RawHand.joints` (MediaPipe) |
| Screen | canvas pixels, **Y-up** | bottom-left | mirror mode, after `Viewport` |
| World | metres | headset reference space | XR mode, after `MetricSpace` |

`JointSpace` is the abstraction over the last two: `Viewport` for mirror mode,
`MetricSpace` (a pass-through) for XR. Everything in `HandState` is written
against it, so the derivations are identical and only the units differ. Anything
with a hard-coded pixel constant is therefore a bug in XR — `minSpan` on
`JointSpace` exists for exactly this reason.

`Viewport.toRender()` performs the Y flip, once. The orthographic camera in
`Stage.ts` is configured to match screen space exactly, so a reticle is placed
with `mesh.position.set(palm.x, palm.y, z)` and no conversion.

## Architecture

```
camera.ts ─► MediaPipeHandSource ─┐                    ┌─ Viewport ─┐
                                  ├─► HandFrame ──────►┤            ├─► HandTracker ─► HandState[] ─┬─► Reticle
Quest     ─► WebXRHandSource ─────┘   (the seam)       └─ MetricSpace┘   smoothing +                ├─► Skeleton
                                                          (JointSpace)   derived features           └─► GestureRecognizer ─► ActionBus
```

**Detection and rendering run at independent rates.** Inference is driven by
`requestVideoFrameCallback` (real camera frames); rendering runs on rAF and
consumes whatever the latest frame is. One Euro filters interpolate across the
gap, so the HUD stays smooth at display rate even when inference is slow or
uneven. Do not couple them.

**`HandState` is the render layer's only input.** Adding a visual that needs a
new quantity means deriving it in `HandState.ts`, not reaching back to raw
joints from a render file.

**Scale-invariance.** Anything compared against a threshold is divided by
`spanRadius` (wrist-to-middle-MCP, in pixels) so it behaves identically whether
the hand is at arm's length or filling the frame. `pinch` is the model to
follow.

**Hysteresis on every gesture.** Separate engage/release thresholds plus dwell
and cooldown. A single threshold sits exactly where tracking noise lives and
machine-guns events.

## Look

Palette lives in `src/render/theme.ts` (mirrored as CSS variables in
`index.html`): ice-cyan `#5fe9ff` primary, `#0a2a3a` deep, amber `#ffb23f` for
engaged/alert, `#03070a` base.

The reticle is drawn analytically in a fragment shader from polar coordinates —
one quad, one draw call per hand, crisp at any scale, with free animation of
dash phase and sweep. Do not rebuild it out of ring geometry.

It is oriented by `HandState`'s orthonormal palm basis (`palmNormal`,
`palmRight`, `palmUp`) so rings foreshorten into ellipses as the hand turns;
that perspective response is most of what sells the illusion that they are
attached rather than following. A basis rather than a normal-plus-roll-angle,
because a roll scalar only means something when there is a screen to measure it
against — in XR the hand rotates freely in 3D.

Bloom is what makes it glow in mirror mode. Its threshold sits above the feed's
brightness so the HUD blooms and the video does not wash out — if the feed's
`exposure` in `config.ts` changes, re-check `render.bloom.threshold`.

**Bloom does not run in XR.** `EffectComposer` renders through its own
fullscreen targets, which do not survive WebXR's stereo framebuffer. `Stage`
bypasses the post chain in a session, and the reticle shader's `uGlowBoost`
adds a wide exponential halo to compensate. Tune the two together or the HUD
will look right on the Mac and flat in the headset.

## The two modes

| | mirror (Mac) | xr (Quest) |
|---|---|---|
| source | `MediaPipeHandSource` | `WebXRHandSource` |
| space | `Viewport` (pixels) | `MetricSpace` (metres) |
| camera | ortho, pixel-matched | perspective, headset-driven |
| feed | stylized video quad | passthrough, **not readable** |
| post | bloom via composer | none — shader glow instead |
| loop | rAF + `requestVideoFrameCallback` | `setAnimationLoop` |

`main.ts` picks the mode from `navigator.xr` support. Everything between the
source and the reticle is shared.

WebXR cannot sample passthrough *colour* pixels — Meta exposes those only to
native apps — so `Feed.ts` has nothing to work with in a session and is absent
from the XR scene. `DepthFX.ts` is the replacement: it stylizes the real world
from the headset's **depth** map instead (Quest 3/3S, `depth-sensing`, good to
~5 m), drawing glowing silhouettes on real geometry, topographic contour bands
and an outward scan pulse. Depth edges are real geometry rather than image
edges, so they don't fire on shadows and posters the way a colour Sobel would.

Two things that will silently break it: the depth texture is a
`sampler2DArray` with **layer 0 = left eye, layer 1 = right eye**, selected by
which half of the wide framebuffer the fragment lands in — same convention as
three's own occlusion pass. And it is encoded against
`session.renderState.depthNear/Far`, which is why `Stage.xrCamera` uses a
**0.1 m near plane**: at 0.01 m nearly all depth precision collapses into the
first few centimetres and the room quantises to mush. The scene background and clear alpha must stay transparent or the
HUD paints over reality and you get VR in a black void.

## Tuning

Everything adjustable is in `src/config.ts`. Notable:

- `tracker.*Confidence` sit at 0.35, below MediaPipe's 0.5 defaults. Hands near
  a POV camera are large, clipped by the frame edge, self-occluding and
  motion-blurred; the defaults drop tracking constantly in exactly the poses
  this HUD is for. A reticle popping out of existence is worse than a few
  jittery frames.
- `smoothing.minCutoff` / `beta` — tune `minCutoff` first with a still hand
  until it stops shimmering, then `beta` with a fast one until it stops lagging.
- `smoothing.velocityLead` compensates camera pipeline latency. **Measure the
  real figure from the debug panel before setting it**; guessing produces
  reticles that overshoot.

## Verification

Typecheck and `npm run shadercheck` cover the parts a machine can check. The
rest needs eyes:

- **Registration** (the one that matters): `S` for the skeleton overlay, then
  splay your fingers and move fast across the frame. Dots must stay welded to
  the knuckles. Drift here invalidates everything downstream.
- **Handedness**: hold up one hand only, confirm the panel labels it correctly.
- **Bounds**: frame edges, one hand, two hands, no hands, entering/leaving — no
  flicker, no stuck reticles.
- **Perf**: the debug panel reports render fps, detection fps and inference ms.
  Targets are 60 / ≥30 / <20ms.

LAN and headset testing need HTTPS (`vite --host` plus a cert) — `getUserMedia`
and WebXR both require a secure context, and only `localhost` is exempt.

## Notes

`public/wasm/` and `public/models/` are vendored at install time by
`scripts/fetch-assets.mjs` and gitignored. No CDN at runtime.

No test framework yet. When the pure maths stabilizes, `OneEuroFilter`,
`Viewport` and the `HandState` derivations are the parts worth unit testing —
they're deterministic and everything else depends on them.
