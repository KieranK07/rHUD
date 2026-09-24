/**
 * Every tunable in one place. Values here are live-editable from the tuning
 * panel (press `T`) and persisted to localStorage, so treat these as defaults
 * rather than constants.
 */

export const config = {
  camera: {
    /** Requested capture resolution. 720p is the sweet spot: 1080p costs
     *  inference time for detail the model downsamples away anyway. */
    width: 1280,
    height: 720,
    frameRate: 60,
  },

  tracker: {
    numHands: 2,
    /**
     * Deliberately below MediaPipe's 0.5 defaults. A POV camera sees hands
     * that are large, frequently clipped by the frame edge, self-occluding
     * and motion-blurred — the defaults drop tracking constantly in exactly
     * the poses this HUD is for. Lower thresholds trade a few jittery frames
     * for continuity, which is the right trade when a reticle popping out of
     * existence is the worst possible artifact.
     */
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
    /** Prefer GPU inference; falls back to CPU automatically if unavailable. */
    delegate: 'GPU' as 'GPU' | 'CPU',
  },

  smoothing: {
    /**
     * One Euro filter. Lower minCutoff = steadier when still but laggier;
     * higher beta = more responsive when moving fast. Tune minCutoff first
     * with a still hand, then beta with a fast one.
     */
    minCutoff: 1.7,
    beta: 0.045,
    dCutoff: 1.0,
    /**
     * Advance the smoothed position along its velocity to hide camera
     * pipeline latency. Continuity Camera adds real delay; measure it with
     * the debug panel before trusting this. Seconds.
     */
    velocityLead: 0.0,
  },

  hand: {
    /** Frames a hand may go missing before its reticle releases. Prevents
     *  flicker on brief detection dropouts. */
    lostGraceMs: 220,
    /** Reticle radius as a multiple of palm span. */
    reticleScale: 2.1,
    /**
     * How far to float the reticle off the hand, as a multiple of palm span.
     * Direction is chosen automatically so it always sits on the side facing
     * the viewer — see Reticle.viewerSide().
     */
    palmOffset: 0.9,
  },

  gestures: {
    /** Pinch distance / palm span. Scale-invariant, so thresholds hold at
     *  any distance from the camera. Hysteresis gap prevents chatter. */
    pinchEngage: 0.34,
    pinchRelease: 0.46,
    /** Mean finger curl, 0 (straight) .. 1 (fully closed). */
    fistEngage: 0.72,
    fistRelease: 0.6,
    openEngage: 0.22,
    openRelease: 0.34,
    /** A gesture must hold this long before it fires. */
    dwellMs: 90,
    /** Minimum gap between repeat fires of the same gesture. */
    cooldownMs: 400,
  },

  ambient: {
    /**
     * The head-locked visor frame. Off by default: a frame pinned to your view
     * reads as a screen strapped to your face rather than as part of the
     * world. The world stylization in `depthfx` does that job better.
     */
    enabled: false,
    /** Overall strength of the visor frame. Drop it if the periphery gets busy. */
    opacity: 0.85,
    /** XR only: metres in front of the viewer. */
    distance: 1.6,
    /** XR only: vertical field of view the frame spans, degrees. Below the
     *  headset's own FOV so the brackets land inside your view, not past it. */
    fovDegrees: 78,
  },

  depthfx: {
    /**
     * Stylizes the real world from the headset's depth map. Quest 3 / 3S only —
     * requested as an optional feature, so it silently stays off elsewhere.
     */
    enabled: true,
    /** Metres. Meta's depth is unreliable past roughly this. */
    range: 5.0,
    /** Glowing silhouettes on real geometry. The main effect. */
    edge: 0.9,
    /** Topographic bands wrapping real surfaces. */
    contour: 0.16,
    /** Contour lines per metre. */
    contourFreq: 2.2,
    /** Outward-travelling scan pulse. */
    scan: 0.22,
    /**
     * Diagnostic view. 0 = normal stylization, 1 = raw texture channels,
     * 2 = linearized metres as a ramp. Currently 1 while the depth texture's
     * encoding is being established — set to 0 once it is known.
     */
    debug: 1,
  },

  render: {
    /** Cap devicePixelRatio. Retina at 3x on a full-screen canvas is a lot of
     *  fragment work for a bloom pass that blurs it anyway. */
    maxPixelRatio: 2,
    bloom: {
      strength: 0.85,
      radius: 0.6,
      /** Above the video's brightness so the HUD glows and the feed doesn't
       *  wash out. */
      threshold: 0.42,
    },
  },

  feed: {
    /** 0 = raw camera, 1 = full machine-vision stylization. */
    stylize: 0.85,
    edgeGain: 1.5,
    scanlineIntensity: 0.16,
    vignette: 0.55,
    aberration: 0.4,
    /** Dim the underlying video so HUD elements read clearly on top. */
    exposure: 0.55,
  },

  debug: {
    showSkeleton: false,
    showPanel: true,
  },
};

export type Config = typeof config;
