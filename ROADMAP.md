# rHUD roadmap

Each phase ends at something visible on screen. Status reflects what has been
built, not what has been validated against a real camera — see "Next" below.

| # | Phase | Status |
|---|---|---|
| 0 | Scaffold, camera picker, feed on screen | built |
| 1 | MediaPipe + raw landmark overlay | built |
| 2 | `HandState`, One Euro smoothing, derived features | built |
| 3 | Reticle | built |
| 4 | Feed stylization + bloom | built |
| 5 | Gestures + action bus + on-screen log | built |
| 6 | Live tuning panel | not started |
| 7 | WebXR path | built, untested on hardware |

## Next: validate phase 1 against the real camera

Everything above is verified only by typecheck and the headless shader test
(`npm run shadercheck`, which drives a synthetic hand). None of it has met an
actual iPhone yet, and the assumptions most likely to be wrong are all in
phase 1:

- **Registration.** The cover-fit maths is the load-bearing piece. Run with `S`
  and confirm the skeleton dots stay welded to the knuckles during fast motion.
  Everything downstream is worthless if this drifts.
- **Handedness.** The POV inversion fix in `MediaPipeHandSource.flipChirality()`
  is reasoned from how MediaPipe was trained, not yet observed. Hold up one hand
  and check the label.
- **Near-field tracking.** Confidence thresholds were lowered to 0.35 on the
  expectation that POV hands are large, clipped and self-occluding. The real
  numbers may want to go lower still, or the model may hold up better than
  feared.
- **Continuity Camera latency.** Unknown until measured. It sets
  `smoothing.velocityLead`, which is currently 0 precisely because guessing it
  would be worse than leaving it off.
- **Palm normal sign.** Derived analytically per chirality; if reticles tilt the
  wrong way on one hand, that's the culprit.

## Phase 7 — Quest: what to verify first

The port is written but has never met a headset. Run `npm run dev:lan`, open
`https://<mac-ip>:5173` in the Quest browser, accept the self-signed cert
warning, press ENTER AR. In likely-failure order:

- **Does a session start at all?** `hand-tracking` is a *required* feature, so
  if the headset has hand tracking disabled in settings the request rejects
  outright rather than degrading. That is deliberate — rHUD has no input
  without it — but it means "nothing happens" has an obvious first thing to
  check.
- **Joint mapping.** `WebXRHandSource` maps 25 WebXR joints onto the canonical
  21. If reticles sit an inch toward the wrist, the MCP mapping picked
  `-metacarpal` instead of `-phalanx-proximal`.
- **Palm normal sign.** Derived per chirality and verified only in 2D. If rings
  face inward on one hand, that is the culprit.
- **Reticle scale.** `hand.reticleScale` was tuned against pixels. At 2.1x a
  ~9cm palm span gives a ~38cm ring, which may read as far too large in a
  headset.
- **Glow.** No bloom in a session; `uGlowBoost` is doing the work and its
  strength is a guess.
- **Passthrough actually showing.** If the world is black, something opaque is
  in the scene or clear alpha is not 0.

There is no debug panel in XR — it is a DOM overlay and invisible inside a
session. Worth building an in-scene equivalent early, because tuning blind is
miserable.

## World stylization

`DepthFX` replaces the passthrough filter that WebXR cannot provide. Tunables
live in `config.depthfx`: `edge` is the main effect, `contour`/`contourFreq`
the topographic bands, `scan` the travelling pulse, `range` the cutoff.

Untested on hardware. The console logs whether the runtime actually granted
depth sensing on entry — check that first if nothing appears, since it is
requested as an optional feature and silently absent on a Quest 2 or if the
permission is declined.

The head-locked visor (`AmbientHUD`) is built but **off by default**
(`config.ambient.enabled`) — a frame pinned to your view reads as a screen
strapped to your face rather than as part of the world.

## Phase 6 — tuning panel

Reticle feel is not something to iterate on through rebuilds. Wants live sliders
over `config.ts` with localStorage persistence: smoothing constants, gesture
thresholds, bloom, feed stylization.

## Phase 7 — WebXR

Done, pending hardware validation. What it actually took, beyond the new source:

- `JointSpace` abstraction so `HandState` stops assuming pixels
- an orthonormal palm basis replacing the screen-space roll angle
- bypassing the post chain in a session, with shader-side glow replacing bloom
- transparent scene background and clear alpha for passthrough

**The render layer did not carry over completely unchanged.** The reticle,
gestures and smoothing did. `Feed.ts` did not: WebXR cannot read passthrough
pixels, so the stylized machine-vision treatment has no input in a session and
is absent from the XR scene. That is a platform limitation, not a design
choice, and it reverses if Meta ships raw camera access to the browser.

## Later

- Real action sinks behind `ActionBus` — the stub already emits intents
  (`pinch.start`), so this is one adapter file, not a refactor.
- Radial menus anchored to the palm, selected by pointing.
- Two-handed gestures (pull-apart to scale, rotate).
- Recording and playback of `HandFrame` streams, so tuning doesn't require
  standing in front of a camera performing gestures on repeat.
