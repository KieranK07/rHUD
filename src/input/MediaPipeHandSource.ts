/**
 * MediaPipe Tasks Vision implementation of HandSource.
 *
 * This is the only file in the project that imports @mediapipe/*. Everything
 * downstream consumes HandFrame.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { config } from '../config.ts';
import type { CameraHandle } from './camera.ts';
import type { Chirality, HandFrame, HandSource, RawHand, Vec3 } from './HandSource.ts';

/** Vendored by scripts/fetch-assets.mjs — no CDN at runtime. */
const WASM_PATH = '/wasm';
const MODEL_PATH = '/models/hand_landmarker.task';

export class MediaPipeHandSource implements HandSource {
  readonly kind = 'mediapipe' as const;

  private landmarker: HandLandmarker | null = null;
  private frame: HandFrame | null = null;
  private running = false;
  private rvfcHandle: number | null = null;
  private lastVideoTime = -1;

  /** Rolling detection rate and cost, surfaced in the debug panel. */
  detectionsPerSecond = 0;
  lastInferenceMs = 0;
  private detectionCount = 0;
  private rateWindowStart = 0;

  constructor(private camera: CameraHandle) {}

  get frameSize(): { width: number; height: number } {
    return { width: this.camera.width, height: this.camera.height };
  }

  async start(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);

    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_PATH,
        delegate: config.tracker.delegate,
      },
      runningMode: 'VIDEO',
      numHands: config.tracker.numHands,
      minHandDetectionConfidence: config.tracker.minHandDetectionConfidence,
      minHandPresenceConfidence: config.tracker.minHandPresenceConfidence,
      minTrackingConfidence: config.tracker.minTrackingConfidence,
    });

    this.running = true;
    this.rateWindowStart = performance.now();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.rvfcHandle !== null && 'cancelVideoFrameCallback' in this.camera.video) {
      this.camera.video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.landmarker?.close();
    this.landmarker = null;
  }

  latest(): HandFrame | null {
    return this.frame;
  }

  /**
   * Detection is driven by requestVideoFrameCallback rather than rAF so it
   * fires once per *camera* frame. Pinning it to rAF would either re-run
   * inference on identical frames or miss frames when the display and capture
   * rates disagree — and Continuity Camera's rate is not the display's.
   * Rendering stays on rAF independently; see main.ts.
   */
  private scheduleNext(): void {
    if (!this.running) return;
    const video = this.camera.video;

    if ('requestVideoFrameCallback' in video) {
      this.rvfcHandle = video.requestVideoFrameCallback(() => {
        this.detect();
        this.scheduleNext();
      });
    } else {
      // Safari < 15.4 and friends.
      requestAnimationFrame(() => {
        this.detect();
        this.scheduleNext();
      });
    }
  }

  private detect(): void {
    const landmarker = this.landmarker;
    if (!landmarker) return;

    const video = this.camera.video;
    // Guard against feeding the same frame twice: MediaPipe rejects
    // non-monotonic timestamps in VIDEO mode.
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;

    const t0 = performance.now();
    const result = landmarker.detectForVideo(video, t0);
    this.lastInferenceMs = performance.now() - t0;

    const hands: RawHand[] = [];
    for (let i = 0; i < result.landmarks.length; i++) {
      const joints = result.landmarks[i];
      const category = result.handedness[i]?.[0];
      if (!joints || !category) continue;

      hands.push({
        chirality: flipChirality(category.categoryName),
        confidence: category.score,
        joints: joints.map(toVec3),
        worldJoints: result.worldLandmarks[i]?.map(toVec3),
      });
    }

    this.frame = { timestamp: t0, hands };
    this.trackRate(t0);
  }

  private trackRate(now: number): void {
    this.detectionCount++;
    const elapsed = now - this.rateWindowStart;
    if (elapsed >= 500) {
      this.detectionsPerSecond = (this.detectionCount * 1000) / elapsed;
      this.detectionCount = 0;
      this.rateWindowStart = now;
    }
  }
}

function toVec3(l: { x: number; y: number; z: number }): Vec3 {
  return { x: l.x, y: l.y, z: l.z };
}

/**
 * MediaPipe classifies handedness *assuming a mirrored selfie image* — that
 * assumption is baked into the model, not a setting. rHUD's camera is
 * world-facing (POV, pointed at the user's own hands), so every label comes
 * back inverted and has to be flipped here at the boundary.
 *
 * Do not "fix" this by removing the flip. If handedness ever looks wrong,
 * check whether the camera is mirrored before touching this function — a
 * mirrored preview is the far more likely culprit.
 */
function flipChirality(categoryName: string): Chirality {
  return categoryName === 'Left' ? 'right' : 'left';
}
