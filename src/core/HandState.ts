/**
 * Turns raw joints into the handful of quantities the HUD actually draws with,
 * and owns the smoothing and the appear/disappear lifecycle.
 *
 * All positions here are canvas pixels, Y-up, via Viewport — the render layer
 * never touches normalized image space.
 */

import { config } from '../config.ts';
import { FINGERS, JOINT, JOINT_COUNT } from '../input/HandSource.ts';
import type { Chirality, HandFrame, RawHand, Vec3 } from '../input/HandSource.ts';
import { Vec3Filter } from './OneEuroFilter.ts';
import type { JointSpace } from './viewport.ts';

export interface HandState {
  chirality: Chirality;
  /** True while the hand is detected or inside its loss grace window. */
  present: boolean;
  confidence: number;

  /** Smoothed canonical rig, canvas pixels, Y-up. */
  joints: Vec3[];

  /** Centroid of wrist + the four finger MCPs — far steadier than the wrist alone. */
  palmCenter: Vec3;
  /**
   * Orthonormal palm frame: normal points out through the palm, right runs
   * index-knuckle to pinky-knuckle, up completes it.
   *
   * A full basis rather than a normal plus a roll angle, because roll can only
   * be expressed as a single scalar when there is a screen to measure it
   * against. In XR the hand rotates freely in three dimensions and a
   * screen-space `atan2` is meaningless, so orientation has to come from the
   * hand's own geometry to work in both modes.
   */
  palmNormal: Vec3;
  palmRight: Vec3;
  palmUp: Vec3;
  /** Wrist-to-middle-MCP distance, in render-space units. The HUD's unit of scale. */
  spanRadius: number;

  /** Thumb-tip to index-tip distance over palm span: 0 pinched, ~1 open. */
  pinch: number;
  /** Per finger, thumb first. 0 straight .. 1 fully curled. */
  curl: number[];

  /** Palm speed in px/s, for motion trails and lead compensation. */
  speed: number;
  /** 0..1 lock-on ramp. Drives the acquisition animation. */
  acquire: number;
}

const ACQUIRE_RATE = 2.6; // full lock-on in ~380ms
const RELEASE_RATE = 4.5;

export class HandTracker {
  private states = new Map<Chirality, InternalState>();
  private lastFrameTimestamp = -1;

  /** Stable list for rendering; hands not present are still included so the
   *  release animation can play out. */
  get hands(): HandState[] {
    return [...this.states.values()].map((s) => s.pub);
  }

  /**
   * @param frame most recent detection, or null if none has landed yet
   * @param space maps source joints into render space (pixels, or metres in XR)
   * @param dt    seconds since last render tick (render runs faster than detection)
   */
  update(frame: HandFrame | null, space: JointSpace, dt: number): void {
    const isNewFrame = frame !== null && frame.timestamp !== this.lastFrameTimestamp;
    if (frame && isNewFrame) {
      this.lastFrameTimestamp = frame.timestamp;
      const seen = new Set<Chirality>();

      for (const hand of frame.hands) {
        seen.add(hand.chirality);
        const state = this.ensure(hand.chirality);
        applyDetection(state, hand, space, frame.timestamp / 1000);
      }

      for (const [chirality, state] of this.states) {
        if (!seen.has(chirality)) state.lastSeen = Math.min(state.lastSeen, frame.timestamp);
      }
    }

    // Presence and animation advance every render tick, not just on detection,
    // so the lock-on ramp stays smooth when inference stutters.
    const now = performance.now();
    for (const state of this.states.values()) {
      const missingFor = now - state.lastSeen;
      state.pub.present = missingFor < config.hand.lostGraceMs;

      const target = state.pub.present ? 1 : 0;
      const rate = target > state.pub.acquire ? ACQUIRE_RATE : RELEASE_RATE;
      state.pub.acquire = approach(state.pub.acquire, target, rate * dt);

      if (!state.pub.present && state.pub.acquire < 0.001) {
        state.filters.forEach((f) => f.reset());
      }
    }
  }

  private ensure(chirality: Chirality): InternalState {
    let state = this.states.get(chirality);
    if (!state) {
      state = createState(chirality);
      this.states.set(chirality, state);
    }
    return state;
  }
}

interface InternalState {
  pub: HandState;
  filters: Vec3Filter[];
  lastSeen: number;
  prevPalm: Vec3;
}

function createState(chirality: Chirality): InternalState {
  const params = config.smoothing;
  return {
    pub: {
      chirality,
      present: false,
      confidence: 0,
      joints: Array.from({ length: JOINT_COUNT }, () => ({ x: 0, y: 0, z: 0 })),
      palmCenter: { x: 0, y: 0, z: 0 },
      palmNormal: { x: 0, y: 0, z: 1 },
      palmRight: { x: 1, y: 0, z: 0 },
      palmUp: { x: 0, y: 1, z: 0 },
      spanRadius: 1,
      pinch: 1,
      curl: [0, 0, 0, 0, 0],
      speed: 0,
      acquire: 0,
    },
    filters: Array.from({ length: JOINT_COUNT }, () => new Vec3Filter(params)),
    lastSeen: -Infinity,
    prevPalm: { x: 0, y: 0, z: 0 },
  };
}

const PALM_JOINTS = [
  JOINT.WRIST,
  JOINT.INDEX_MCP,
  JOINT.MIDDLE_MCP,
  JOINT.RING_MCP,
  JOINT.PINKY_MCP,
];

const scratch = { x: 0, y: 0, z: 0 };
const vel = { x: 0, y: 0, z: 0 };

function applyDetection(
  state: InternalState,
  hand: RawHand,
  space: JointSpace,
  timeSeconds: number,
): void {
  const pub = state.pub;
  state.lastSeen = performance.now();
  pub.confidence = hand.confidence;

  const lead = config.smoothing.velocityLead;

  for (let i = 0; i < JOINT_COUNT; i++) {
    const raw = hand.joints[i];
    const filter = state.filters[i]!;
    if (!raw) continue;

    space.toRender(raw, scratch);
    filter.setParams(config.smoothing);
    filter.filter(scratch.x, scratch.y, scratch.z, timeSeconds, pub.joints[i]!);

    // Push the smoothed position forward along its own velocity to offset
    // camera pipeline latency. Zero by default — measure before enabling.
    if (lead > 0) {
      filter.velocity(vel);
      pub.joints[i]!.x += vel.x * lead;
      pub.joints[i]!.y += vel.y * lead;
      pub.joints[i]!.z += vel.z * lead;
    }
  }

  const j = pub.joints;

  // Palm centre: centroid over the wrist and knuckles.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const idx of PALM_JOINTS) {
    cx += j[idx]!.x;
    cy += j[idx]!.y;
    cz += j[idx]!.z;
  }
  const prev = state.prevPalm;
  prev.x = pub.palmCenter.x;
  prev.y = pub.palmCenter.y;
  pub.palmCenter.x = cx / PALM_JOINTS.length;
  pub.palmCenter.y = cy / PALM_JOINTS.length;
  pub.palmCenter.z = cz / PALM_JOINTS.length;

  pub.speed = Math.hypot(pub.palmCenter.x - prev.x, pub.palmCenter.y - prev.y) * 60;

  // Scale unit. Guarded so a degenerate detection can't produce a zero-size
  // or NaN reticle.
  pub.spanRadius = Math.max(space.minSpan, dist(j[JOINT.WRIST]!, j[JOINT.MIDDLE_MCP]!));

  computePalmBasis(pub);

  // Dividing by span makes this scale-invariant, so one threshold works
  // whether the hand is at arm's length or filling the frame.
  pub.pinch = dist(j[JOINT.THUMB_TIP]!, j[JOINT.INDEX_TIP]!) / pub.spanRadius;

  for (let f = 0; f < FINGERS.length; f++) {
    pub.curl[f] = fingerCurl(pub, f);
  }
}

/**
 * Builds an orthonormal frame from wrist, index MCP and pinky MCP.
 *
 * Normal is the cross product of the two knuckle vectors. Sign convention: for
 * a right hand with the palm toward the camera the raw cross product points
 * away from the viewer, so it is negated; left hands come out correct as-is.
 * The result always points out through the palm, whichever side is being
 * observed.
 *
 * Right is then the knuckle axis with any component along the normal removed
 * (Gram-Schmidt), which matters because the three joints are never perfectly
 * coplanar in practice and an unorthogonalised axis would shear the reticle.
 */
function computePalmBasis(pub: HandState): void {
  const wrist = pub.joints[JOINT.WRIST]!;
  const index = pub.joints[JOINT.INDEX_MCP]!;
  const pinky = pub.joints[JOINT.PINKY_MCP]!;

  const ax = index.x - wrist.x;
  const ay = index.y - wrist.y;
  const az = index.z - wrist.z;
  const bx = pinky.x - wrist.x;
  const by = pinky.y - wrist.y;
  const bz = pinky.z - wrist.z;

  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;

  if (pub.chirality === 'right') {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  const nLen = Math.hypot(nx, ny, nz) || 1;
  nx /= nLen;
  ny /= nLen;
  nz /= nLen;
  pub.palmNormal.x = nx;
  pub.palmNormal.y = ny;
  pub.palmNormal.z = nz;

  // Knuckle axis, index -> pinky.
  let rx = pinky.x - index.x;
  let ry = pinky.y - index.y;
  let rz = pinky.z - index.z;

  // Remove the component along the normal so the frame stays square.
  const dot = rx * nx + ry * ny + rz * nz;
  rx -= dot * nx;
  ry -= dot * ny;
  rz -= dot * nz;

  const rLen = Math.hypot(rx, ry, rz) || 1;
  pub.palmRight.x = rx / rLen;
  pub.palmRight.y = ry / rLen;
  pub.palmRight.z = rz / rLen;

  // up = normal x right, completing a right-handed frame.
  pub.palmUp.x = ny * pub.palmRight.z - nz * pub.palmRight.y;
  pub.palmUp.y = nz * pub.palmRight.x - nx * pub.palmRight.z;
  pub.palmUp.z = nx * pub.palmRight.y - ny * pub.palmRight.x;
}

/**
 * Curl as the shortfall between the chain's end-to-end distance and its total
 * bone length: straight fingers span their full length, curled ones fold in.
 * Angle-free, so it degrades gracefully when a joint is badly estimated.
 */
function fingerCurl(pub: HandState, fingerIndex: number): number {
  const chain = FINGERS[fingerIndex]!;
  let bones = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    bones += dist(pub.joints[chain[i]!]!, pub.joints[chain[i + 1]!]!);
  }
  if (bones < 1e-3) return 0;
  const span = dist(pub.joints[chain[0]!]!, pub.joints[chain[chain.length - 1]!]!);
  return clamp01(1 - span / bones);
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function approach(current: number, target: number, step: number): number {
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}
