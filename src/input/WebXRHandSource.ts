/**
 * WebXR implementation of HandSource — the Quest path.
 *
 * This is the file the seam was built for. The headset tracks hands itself, so
 * there is no inference, no camera latency to compensate and no confidence
 * tuning: joints arrive as real poses in world space, already metric. Nothing
 * downstream changes.
 *
 * Unlike the MediaPipe source this cannot own its own loop — XR joint poses are
 * only readable from inside an XRFrame callback — so `update()` is driven by
 * the render loop in main.ts.
 */

import { JOINT, JOINT_COUNT } from './HandSource.ts';
import type { Chirality, HandFrame, HandSource, RawHand, Vec3 } from './HandSource.ts';

/**
 * WebXR's 25 joints mapped onto rHUD's canonical 21, indexed to match JOINT.
 *
 * The four finger metacarpals are dropped: they sit inside the palm, have no
 * MediaPipe equivalent, and nothing derives from them. Note that a finger's
 * *knuckle* is `phalanx-proximal`, not `metacarpal` — the metacarpal is the
 * base of the bone running through the palm. Mapping MCP to the metacarpal
 * would place every reticle an inch or two too far toward the wrist.
 */
const XR_JOINT_NAMES: string[] = [];
XR_JOINT_NAMES[JOINT.WRIST] = 'wrist';
XR_JOINT_NAMES[JOINT.THUMB_CMC] = 'thumb-metacarpal';
XR_JOINT_NAMES[JOINT.THUMB_MCP] = 'thumb-phalanx-proximal';
XR_JOINT_NAMES[JOINT.THUMB_IP] = 'thumb-phalanx-distal';
XR_JOINT_NAMES[JOINT.THUMB_TIP] = 'thumb-tip';
XR_JOINT_NAMES[JOINT.INDEX_MCP] = 'index-finger-phalanx-proximal';
XR_JOINT_NAMES[JOINT.INDEX_PIP] = 'index-finger-phalanx-intermediate';
XR_JOINT_NAMES[JOINT.INDEX_DIP] = 'index-finger-phalanx-distal';
XR_JOINT_NAMES[JOINT.INDEX_TIP] = 'index-finger-tip';
XR_JOINT_NAMES[JOINT.MIDDLE_MCP] = 'middle-finger-phalanx-proximal';
XR_JOINT_NAMES[JOINT.MIDDLE_PIP] = 'middle-finger-phalanx-intermediate';
XR_JOINT_NAMES[JOINT.MIDDLE_DIP] = 'middle-finger-phalanx-distal';
XR_JOINT_NAMES[JOINT.MIDDLE_TIP] = 'middle-finger-tip';
XR_JOINT_NAMES[JOINT.RING_MCP] = 'ring-finger-phalanx-proximal';
XR_JOINT_NAMES[JOINT.RING_PIP] = 'ring-finger-phalanx-intermediate';
XR_JOINT_NAMES[JOINT.RING_DIP] = 'ring-finger-phalanx-distal';
XR_JOINT_NAMES[JOINT.RING_TIP] = 'ring-finger-tip';
XR_JOINT_NAMES[JOINT.PINKY_MCP] = 'pinky-finger-phalanx-proximal';
XR_JOINT_NAMES[JOINT.PINKY_PIP] = 'pinky-finger-phalanx-intermediate';
XR_JOINT_NAMES[JOINT.PINKY_DIP] = 'pinky-finger-phalanx-distal';
XR_JOINT_NAMES[JOINT.PINKY_TIP] = 'pinky-finger-tip';

export class WebXRHandSource implements HandSource {
  readonly kind = 'webxr' as const;
  /** Meaningless here — no image plane. Kept to satisfy the interface. */
  readonly frameSize = { width: 0, height: 0 };

  private frame: HandFrame | null = null;
  /** Reused across frames; joint counts are fixed so nothing needs reallocating. */
  private scratch = new Map<Chirality, RawHand>();

  handsTracked = 0;

  async start(): Promise<void> {
    // Nothing to initialise — the session supplies everything.
  }

  stop(): void {
    this.frame = null;
  }

  latest(): HandFrame | null {
    return this.frame;
  }

  /** Called once per XR frame from the render loop. */
  update(xrFrame: XRFrame, referenceSpace: XRReferenceSpace, timestamp: number): void {
    const hands: RawHand[] = [];

    for (const inputSource of xrFrame.session.inputSources) {
      const hand = inputSource.hand;
      if (!hand) continue;

      const chirality: Chirality = inputSource.handedness === 'left' ? 'left' : 'right';
      const raw = this.ensure(chirality);

      if (readJoints(xrFrame, referenceSpace, hand, raw.joints)) {
        hands.push(raw);
      }
    }

    this.handsTracked = hands.length;
    this.frame = { timestamp, hands };
  }

  private ensure(chirality: Chirality): RawHand {
    let raw = this.scratch.get(chirality);
    if (!raw) {
      raw = {
        chirality,
        confidence: 1,
        joints: Array.from({ length: JOINT_COUNT }, () => ({ x: 0, y: 0, z: 0 })),
      };
      this.scratch.set(chirality, raw);
    }
    return raw;
  }
}

/**
 * Fills `out` with world-space joint positions.
 *
 * Returns false if any joint is unavailable — the runtime drops poses when a
 * hand leaves the tracking volume, and a partially-filled rig would leave stale
 * joints mixed with fresh ones, which reads as the hand tearing apart. Better
 * to report the hand as absent and let the grace window in HandTracker hold the
 * reticle steady.
 */
function readJoints(
  xrFrame: XRFrame,
  referenceSpace: XRReferenceSpace,
  hand: XRHand,
  out: Vec3[],
): boolean {
  for (let i = 0; i < JOINT_COUNT; i++) {
    const name = XR_JOINT_NAMES[i];
    if (!name) return false;

    const space = hand.get(name as unknown as never);
    if (!space) return false;

    const pose = xrFrame.getJointPose?.(space, referenceSpace);
    if (!pose) return false;

    const p = pose.transform.position;
    out[i]!.x = p.x;
    out[i]!.y = p.y;
    out[i]!.z = p.z;
  }
  return true;
}
