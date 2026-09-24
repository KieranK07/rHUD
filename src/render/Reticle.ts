/**
 * The circles.
 *
 * Each hand gets exactly one quad, and the entire reticle — every ring, tick,
 * dash, sweep and bracket — is drawn analytically in its fragment shader from
 * polar coordinates. Building it out of real ring geometry would mean dozens
 * of meshes per hand, resolution-dependent tessellation, and no cheap way to
 * animate dash phase; a distance-field shader gives crisp edges at any scale,
 * one draw call, and free animation.
 *
 * The quad is oriented by the palm normal, so rings foreshorten into ellipses
 * as the hand turns. That perspective response is most of what sells the
 * illusion that they're attached to the hand rather than following it.
 */

import { AdditiveBlending, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { config } from '../config.ts';
import type { HandState } from '../core/HandState.ts';
import { theme } from './theme.ts';
import { LAYER } from './Stage.ts';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform float uTime;
uniform float uAcquire;   // 0..1 lock-on ramp
uniform float uPinch;     // 0 pinched .. 1 open
uniform float uActive;    // 0..1 gesture engaged
uniform float uCurl[5];
uniform float uGlowBoost; // compensates for the absent bloom pass in XR
uniform vec3  uPrimary;
uniform vec3  uAccent;
uniform vec3  uWhite;

const float PI  = 3.14159265;
const float TAU = 6.28318531;

// Anti-aliased band around a radius. w comes from fwidth so lines stay one
// pixel wide however far the hand is from the camera.
float ring(float r, float radius, float thickness, float w) {
  return 1.0 - smoothstep(thickness - w, thickness + w, abs(r - radius));
}

// Repeating angular gate: 1 inside each dash, 0 in the gaps.
float dashes(float a, float count, float duty, float phase) {
  float f = fract(a * count / TAU + phase);
  return 1.0 - smoothstep(duty - 0.06, duty + 0.06, f);
}

// Soft falloff either side of a radius — this is what the bloom pass picks up.
float glow(float r, float radius, float falloff) {
  return exp(-abs(r - radius) * falloff);
}

// The quad is deliberately larger than the reticle drawn on it.
//
// Everything soft — the halo, the acquisition brackets sweeping in from
// outside — extends well past the outermost ring. With a tight quad those
// tails hit the geometry edge and get cut off square, which reads as a faint
// box around each hand rather than a circle. Padding gives them room to fall
// off to zero on their own, and the bounds fade below guarantees it.
#define PAD 1.6

void main() {
  vec2 p = (vUv - 0.5) * 2.0 * PAD;

  // Ease the whole assembly inward as it locks on.
  float e = uAcquire * uAcquire * (3.0 - 2.0 * uAcquire);
  float scale = mix(1.34, 1.0, e);

  float r = length(p) / scale;
  float a = atan(p.y, p.x);
  float w = fwidth(r) * 1.4;

  float intensity = 0.0;
  float hot = 0.0; // accumulates the near-white highlights

  // --- outer: fine dashes, slow clockwise drift -------------------------
  float outer = ring(r, 0.95, 0.006, w) * dashes(a, 72.0, 0.55, -uTime * 0.02);
  intensity += outer * 0.9;

  // --- tick belt: every 9th tick reads longer ---------------------------
  float tickPhase = fract(a * 36.0 / TAU);
  float major = step(0.888, fract(a * 4.0 / TAU + 0.5));
  float tickLen = mix(0.035, 0.075, major);
  float belt = ring(r, 0.86 - tickLen * 0.5, tickLen * 0.5, w)
             * dashes(a, 36.0, 0.16, 0.0);
  intensity += belt * mix(0.55, 1.0, major);

  // --- mid: three heavy arcs, counter-rotating -------------------------
  float arcs = ring(r, 0.70, 0.016, w) * dashes(a, 3.0, 0.26, uTime * 0.07);
  intensity += arcs * 1.2;
  hot += arcs * 0.5;

  // --- thin constant ring ----------------------------------------------
  intensity += ring(r, 0.55, 0.004, w) * 0.6;

  // --- radar sweep, trailing comet -------------------------------------
  float sweepAngle = fract((a - uTime * 0.55) / TAU);
  float sweep = pow(1.0 - sweepAngle, 10.0);
  float sweepBand = smoothstep(0.55, 0.58, r) * smoothstep(0.95, 0.90, r);
  intensity += sweep * sweepBand * 0.5;

  // --- inner ring closes as the fingers pinch ---------------------------
  float innerR = mix(0.16, 0.40, clamp(uPinch, 0.0, 1.0));
  float inner = ring(r, innerR, 0.012, w);
  intensity += inner * 1.4;
  hot += inner * 0.8;
  intensity += glow(r, innerR, 26.0) * 0.30;

  // --- per-finger curl readout: five stubs across the lower arc ---------
  for (int i = 0; i < 5; i++) {
    float ang = -PI * 0.5 + (float(i) - 2.0) * 0.16;
    float d = abs(mod(a - ang + PI, TAU) - PI);
    float slot = 1.0 - smoothstep(0.03, 0.045, d);
    float len = 0.04 + uCurl[i] * 0.09;
    intensity += ring(r, 0.46 - len * 0.5, len * 0.5, w) * slot * 0.9;
  }

  // --- corner brackets converge on lock-on ------------------------------
  // Start radius stays inside PAD so the sweep-in is never clipped.
  float bracketR = mix(1.34, 1.06, e);
  float diag = mod(a + PI * 0.25 + PI, PI * 0.5) - PI * 0.25;
  float window = 1.0 - smoothstep(0.16, 0.20, abs(diag));
  float bracket = ring(r, bracketR, 0.010, w) * window;
  intensity += bracket * 1.3;
  hot += bracket * 0.6;

  // --- centre crosshair -------------------------------------------------
  float cross = (1.0 - smoothstep(0.002, 0.006, abs(p.y / scale)))
              * (1.0 - smoothstep(0.10, 0.12, abs(p.x / scale)));
  cross += (1.0 - smoothstep(0.002, 0.006, abs(p.x / scale)))
         * (1.0 - smoothstep(0.10, 0.12, abs(p.y / scale)));
  intensity += cross * 0.35;

  // --- faint interior wash so the disc reads as a surface ---------------
  intensity += smoothstep(0.95, 0.0, r) * 0.05;

  // Wide, soft halo around every ring. Redundant when UnrealBloomPass is in
  // the chain, and the only source of glow when it is not — which is the case
  // for the whole XR path, since post-processing cannot run in stereo.
  if (uGlowBoost > 0.0) {
    float halo = glow(r, 0.95, 5.0) + glow(r, 0.70, 6.0) + glow(r, innerR, 8.0);
    intensity += halo * uGlowBoost * 0.5;
  }

  // Circular cutoff, well inside the quad edge. Without this any soft tail
  // reaching the geometry boundary gets sliced off flat and the reticle reads
  // as a square.
  intensity *= 1.0 - smoothstep(1.40, 1.58, r);

  vec3 color = mix(uPrimary, uAccent, uActive);
  color = mix(color, uWhite, clamp(hot, 0.0, 1.0) * 0.55);

  float alpha = clamp(intensity, 0.0, 3.0) * uAcquire;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/** Must match `PAD` in the fragment shader above. */
const QUAD_PAD = 1.6;

export class Reticle {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private basis = new Matrix4();
  /** Latched lift direction; see viewerSide(). Public for the XR readout. */
  side = 1;
  /** Last viewer/normal dot product, exposed for diagnostics. */
  lastDot = 0;
  private right = new Vector3();
  private up = new Vector3();
  private normal = new Vector3();

  /**
   * @param flat mirror mode — pin the reticle to a fixed draw layer in pixel
   *   space. In XR it sits at the palm's real world depth instead.
   */
  constructor(private flat = true) {
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAcquire: { value: 0 },
        uPinch: { value: 1 },
        uActive: { value: 0 },
        uCurl: { value: [0, 0, 0, 0, 0] },
        uGlowBoost: { value: flat ? 0 : 1 },
        uPrimary: { value: theme.primary },
        uAccent: { value: theme.accent },
        uWhite: { value: theme.white },
      },
    });

    // Local space spans -1..1, so mesh scale maps directly to reticle radius.
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.position.z = LAYER.RETICLE;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /**
   * Which way to lift the reticle: +1 along the palm normal, -1 against it.
   * Latched, with a dead zone, so an edge-on palm does not oscillate.
   */
  private viewerSide(hand: HandState, viewer: Vector3 | null): number {
    let dot: number;
    if (viewer) {
      dot =
        (viewer.x - hand.palmCenter.x) * hand.palmNormal.x +
        (viewer.y - hand.palmCenter.y) * hand.palmNormal.y +
        (viewer.z - hand.palmCenter.z) * hand.palmNormal.z;
    } else {
      // Mirror mode: the orthographic camera looks straight down -Z, so the
      // viewer direction is exactly +Z and the normal's z component is the
      // whole answer.
      dot = hand.palmNormal.z;
    }

    this.lastDot = dot;
    const threshold = hand.spanRadius * 0.15;
    if (dot > threshold) this.side = 1;
    else if (dot < -threshold) this.side = -1;
    return this.side;
  }

  update(hand: HandState, time: number, active: boolean, viewer: Vector3 | null = null): void {
    // Keep drawing through the release ramp, then drop out entirely.
    this.mesh.visible = hand.acquire > 0.002;
    if (!this.mesh.visible) return;

    // Float the reticle off the hand, always on the side facing the viewer.
    //
    // A fixed sign along the palm normal cannot be right: hold your palms
    // toward your face and the normal points at you, turn them away and it
    // points away, so the reticle ends up buried behind the hand half the
    // time. Choosing the side from the viewing direction means it is always in
    // front, whichever way the hand is turned.
    //
    // The sign is latched with a dead zone so a palm held edge-on — where the
    // dot product hovers around zero — does not flip the reticle back and
    // forth every frame.
    const towardViewer = this.viewerSide(hand, viewer);
    const lift = hand.spanRadius * config.hand.palmOffset * towardViewer;
    this.mesh.position.set(
      hand.palmCenter.x + hand.palmNormal.x * lift,
      hand.palmCenter.y + hand.palmNormal.y * lift,
      (this.flat ? LAYER.RETICLE : hand.palmCenter.z + hand.palmNormal.z * lift),
    );

    // PAD compensation: the shader draws the reticle across only the inner
    // 1/PAD of the quad, so the mesh has to be that much larger to keep the
    // rings the same size on the hand.
    const radius = hand.spanRadius * config.hand.reticleScale * QUAD_PAD;
    this.mesh.scale.set(radius, radius, radius);

    // Orient straight from the palm's own frame. Composing a swing-to-normal
    // with a separate roll angle would reintroduce the screen-space assumption
    // the basis exists to remove, and gimbal when the palm faces the viewer.
    this.right.set(hand.palmRight.x, hand.palmRight.y, hand.palmRight.z);
    this.up.set(hand.palmUp.x, hand.palmUp.y, hand.palmUp.z);
    this.normal.set(hand.palmNormal.x, hand.palmNormal.y, hand.palmNormal.z);
    this.basis.makeBasis(this.right, this.up, this.normal);
    this.mesh.quaternion.setFromRotationMatrix(this.basis);

    const u = this.material.uniforms;
    u.uTime!.value = time;
    u.uAcquire!.value = hand.acquire;
    u.uPinch!.value = Math.min(1, hand.pinch / config.gestures.pinchRelease);
    u.uActive!.value = active ? 1 : 0;
    (u.uCurl!.value as number[]).splice(0, 5, ...hand.curl);
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
