/**
 * The seam between hand tracking and everything else.
 *
 * Nothing downstream of this file may import a MediaPipe type. Today the only
 * implementation is MediaPipeHandSource (phone camera -> WASM inference); on a
 * Quest it will be WebXRHandSource (headset supplies joints directly). Both
 * produce the same HandFrame, so the render layer never learns which one is
 * running.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * rHUD's canonical joint rig — 21 joints, the practical common denominator.
 *
 * MediaPipe emits exactly these. WebXR's XRHand emits 25: the same joints plus
 * four extra metacarpals, which get dropped during mapping. Defining our own
 * enum rather than leaning on MediaPipe's ordering means neither source's
 * dialect leaks into shared code, and no downstream file indexes joints by
 * magic number.
 */
export const JOINT = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export const JOINT_COUNT = 21;

/** Per-finger joint chains, thumb first. Used for curl and rendering. */
export const FINGERS = [
  [JOINT.THUMB_CMC, JOINT.THUMB_MCP, JOINT.THUMB_IP, JOINT.THUMB_TIP],
  [JOINT.INDEX_MCP, JOINT.INDEX_PIP, JOINT.INDEX_DIP, JOINT.INDEX_TIP],
  [JOINT.MIDDLE_MCP, JOINT.MIDDLE_PIP, JOINT.MIDDLE_DIP, JOINT.MIDDLE_TIP],
  [JOINT.RING_MCP, JOINT.RING_PIP, JOINT.RING_DIP, JOINT.RING_TIP],
  [JOINT.PINKY_MCP, JOINT.PINKY_PIP, JOINT.PINKY_DIP, JOINT.PINKY_TIP],
] as const;

/** Bone pairs for the skeleton debug overlay. */
export const BONES: ReadonlyArray<readonly [number, number]> = [
  [JOINT.WRIST, JOINT.THUMB_CMC],
  [JOINT.WRIST, JOINT.INDEX_MCP],
  [JOINT.WRIST, JOINT.PINKY_MCP],
  [JOINT.INDEX_MCP, JOINT.MIDDLE_MCP],
  [JOINT.MIDDLE_MCP, JOINT.RING_MCP],
  [JOINT.RING_MCP, JOINT.PINKY_MCP],
  ...FINGERS.flatMap((chain) =>
    chain.slice(0, -1).map((j, i) => [j, chain[i + 1]!] as const),
  ),
];

export type Chirality = 'left' | 'right';

export interface RawHand {
  chirality: Chirality;
  /** Tracker's own confidence, 0..1. */
  confidence: number;
  /** Canonical rig in normalized image space: x,y in 0..1, z relative depth. */
  joints: Vec3[];
  /** Metric coordinates in metres, origin at hand centre. Absent on some sources. */
  worldJoints?: Vec3[];
}

export interface HandFrame {
  /** Source clock, milliseconds. Monotonic within a session. */
  timestamp: number;
  hands: RawHand[];
}

export interface HandSource {
  readonly kind: 'mediapipe' | 'webxr';
  /** Resolution of the underlying image, for the cover-fit transform. */
  readonly frameSize: { width: number; height: number };
  start(): Promise<void>;
  stop(): void;
  /** Most recent frame, or null before the first detection lands. */
  latest(): HandFrame | null;
}
