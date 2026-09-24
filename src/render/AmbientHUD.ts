/**
 * The visor: everything that isn't attached to a hand.
 *
 * Corner brackets framing the view, edge tick rulers, a heading tape that
 * scrolls as you turn your head, scrolling data blocks, a scan sweep and a
 * centre targeting mark. One quad, one draw call, drawn analytically for the
 * same reasons the reticle is — crisp at any resolution and animation is free.
 *
 * Head-locked in XR: the quad rides the camera transform so the frame stays
 * fixed relative to your view, which is what makes it read as a visor rather
 * than as an object in the room. In mirror mode it simply covers the canvas.
 *
 * Deliberately sparse in the centre. The whole point is peripheral texture —
 * anything drawn where you are actually looking becomes an obstruction within
 * about a minute of wearing it.
 */

import { AdditiveBlending, Group, Mesh, PlaneGeometry, ShaderMaterial } from 'three';
import type { PerspectiveCamera } from 'three';
import { config } from '../config.ts';
import { theme } from './theme.ts';
import { LAYER } from './Stage.ts';
import type { Viewport } from '../core/viewport.ts';

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
uniform float uAspect;
uniform float uHeading;   // radians, drives the heading tape
uniform float uHands;     // 0..2 tracked
uniform float uAlert;     // 0..1 gesture engaged
uniform float uOpacity;
uniform vec3  uPrimary;
uniform vec3  uAccent;
uniform vec3  uWhite;

const float PI  = 3.14159265;
const float TAU = 6.28318531;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

/** Anti-aliased "is v within t of target". */
float band(float v, float target, float t) {
  float w = fwidth(v) * 1.2;
  return 1.0 - smoothstep(t - w, t + w, abs(v - target));
}

/** 1 inside [lo, hi]. */
float span(float v, float lo, float hi) {
  return step(lo, v) * step(v, hi);
}

/**
 * Rows of pseudo-random bars that reshuffle a few times a second. Reads as
 * dense telemetry at a glance without needing a font atlas — actual legible
 * text would demand attention the periphery should not be asking for.
 */
float dataBlock(vec2 lp, float rows, float seedBase) {
  float inside = span(lp.x, 0.0, 1.0) * span(lp.y, 0.0, 1.0);
  float row = floor(lp.y * rows);
  float seed = floor(uTime * 3.0) * 0.37 + row * 7.13 + seedBase;
  float len = 0.2 + hash(vec2(seed, row)) * 0.75;
  float bar = step(lp.x, len);
  float rowBand = 1.0 - smoothstep(0.24, 0.40, abs(fract(lp.y * rows) - 0.5));
  return inside * bar * rowBand;
}

void main() {
  // Centred, aspect-corrected: y spans -1..1, x spans -aspect..aspect.
  vec2 c = (vUv - 0.5) * 2.0 * vec2(uAspect, 1.0);
  vec2 q = abs(c);
  vec2 lim = vec2(uAspect - 0.10, 0.90);

  float intensity = 0.0;
  float hot = 0.0;

  // --- corner brackets ---------------------------------------------------
  // Mirrored by working in |c|, so one expression draws all four.
  float armLen = 0.34;
  float hArm = span(q.x, lim.x - armLen, lim.x) * band(q.y, lim.y, 0.006);
  float vArm = span(q.y, lim.y - armLen * 0.62, lim.y) * band(q.x, lim.x, 0.006);
  float brackets = max(hArm, vArm);
  intensity += brackets * 1.1;
  hot += brackets * 0.4;

  // Inner accent pips just inside each bracket corner.
  float pip = span(q.x, lim.x - 0.10, lim.x - 0.06) * band(q.y, lim.y - 0.045, 0.005);
  intensity += pip * 0.8;

  // --- edge tick rulers, top and bottom ---------------------------------
  float tickPhase = fract(c.x * 3.2 + 0.5);
  float major = step(0.82, fract(c.x * 0.8 + 0.5));
  float tickLen = mix(0.022, 0.05, major);
  float ruler = band(q.y, lim.y - 0.075 - tickLen * 0.5, tickLen * 0.5)
              * (1.0 - smoothstep(0.06, 0.11, abs(tickPhase - 0.5)))
              * span(q.x, 0.0, lim.x - 0.36);
  intensity += ruler * mix(0.45, 0.9, major);

  // --- heading tape ------------------------------------------------------
  // Scrolls with yaw, so turning your head moves the world past the frame.
  // Cheap, but it is most of what makes the visor feel attached to a machine
  // that knows where it is pointing.
  float tapeY = band(c.y, lim.y - 0.16, 0.004);
  float headingX = c.x + uHeading * 0.9;
  float tapeTick = 1.0 - smoothstep(0.02, 0.04, abs(fract(headingX * 2.0) - 0.5));
  float tapeMajor = step(0.75, fract(headingX * 0.5));
  float tape = band(c.y, lim.y - 0.16 - mix(0.012, 0.028, tapeMajor) * 0.5,
                    mix(0.012, 0.028, tapeMajor) * 0.5)
             * tapeTick * span(q.x, 0.0, 0.72);
  intensity += tape * 0.85 + tapeY * span(q.x, 0.0, 0.74) * 0.25;

  // --- centre targeting mark --------------------------------------------
  float rc = length(c);
  float centreRing = band(rc, 0.055, 0.0022);
  float gap = step(0.16, abs(fract(atan(c.y, c.x) / TAU * 4.0 + 0.125) - 0.5));
  intensity += centreRing * gap * 0.7;

  // Four short radial ticks around it.
  float cross = band(q.y, 0.0, 0.0018) * span(q.x, 0.075, 0.115)
              + band(q.x, 0.0, 0.0018) * span(q.y, 0.075, 0.115);
  intensity += cross * 0.6;

  // --- data blocks -------------------------------------------------------
  vec2 blA = (c - vec2(-lim.x + 0.02, -lim.y + 0.06)) / vec2(0.34, 0.26);
  intensity += dataBlock(blA, 7.0, 0.0) * 0.5;

  vec2 blB = (c - vec2(lim.x - 0.30, -lim.y + 0.06)) / vec2(0.28, 0.20);
  intensity += dataBlock(blB, 5.0, 3.7) * 0.42;

  // --- scan sweep --------------------------------------------------------
  // Travels bottom to top on a long cycle, bright line with a soft trail.
  float sweepY = fract(uTime * 0.11) * 2.2 - 1.1;
  float sweepD = c.y - sweepY;
  float sweepLine = band(c.y, sweepY, 0.0015);
  float sweepTrail = exp(-max(sweepD, 0.0) * 26.0) * step(0.0, sweepD);
  float sweepMask = span(q.x, 0.0, lim.x);
  intensity += (sweepLine * 0.6 + sweepTrail * 0.10) * sweepMask;

  // --- tracking status: one pip per hand, top centre ---------------------
  for (int i = 0; i < 2; i++) {
    float on = step(float(i) + 0.5, uHands);
    float x = (float(i) - 0.5) * 0.06;
    float pipMark = span(c.x, x - 0.016, x + 0.016) * band(c.y, lim.y - 0.055, 0.008);
    // Idle slots stay faintly visible so the row reads as capacity, not noise.
    intensity += pipMark * mix(0.12, 1.0, on);
    hot += pipMark * on * 0.5;
  }

  // --- alert wash --------------------------------------------------------
  // Edge-only, pulsing, when a gesture engages.
  float edge = smoothstep(lim.y - 0.30, lim.y, q.y) + smoothstep(lim.x - 0.30, lim.x, q.x);
  float pulse = 0.5 + 0.5 * sin(uTime * 7.0);
  intensity += clamp(edge, 0.0, 1.0) * uAlert * pulse * 0.10;

  // --- corner vignette glow ---------------------------------------------
  intensity += smoothstep(0.75, 1.35, length(c / vec2(uAspect, 1.0))) * 0.05;

  vec3 color = mix(uPrimary, uAccent, uAlert * 0.8);
  color = mix(color, uWhite, clamp(hot, 0.0, 1.0) * 0.5);

  float alpha = clamp(intensity, 0.0, 2.0) * uOpacity;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

export class AmbientHUD {
  /** Rides the camera in XR; identity in mirror mode. */
  readonly root = new Group();
  readonly mesh: Mesh;
  private material: ShaderMaterial;

  constructor(private flat: boolean) {
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: 1.6 },
        uHeading: { value: 0 },
        uHands: { value: 0 },
        uAlert: { value: 0 },
        uOpacity: { value: config.ambient.opacity },
        uPrimary: { value: theme.primary },
        uAccent: { value: theme.accent },
        uWhite: { value: theme.white },
      },
    });

    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.root.add(this.mesh);

    if (!flat) {
      // Sits in front of the viewer, sized to a slice of the field of view so
      // the frame lands in the periphery rather than off the edge of it.
      const dist = config.ambient.distance;
      const height = 2 * dist * Math.tan((config.ambient.fovDegrees * Math.PI) / 360);
      this.mesh.position.set(0, 0, -dist);
      this.mesh.scale.set(height * 1.6, height, 1);
      this.material.uniforms.uAspect!.value = 1.6;
    }
  }

  /** Mirror mode: cover the canvas exactly. */
  layoutFlat(viewport: Viewport): void {
    if (!this.flat) return;
    this.mesh.scale.set(viewport.width, viewport.height, 1);
    this.mesh.position.set(viewport.width / 2, viewport.height / 2, LAYER.AMBIENT);
    this.material.uniforms.uAspect!.value = viewport.width / viewport.height;
  }

  /**
   * XR: copy the camera's world transform onto the root so the frame stays
   * pinned to the view. The camera is not part of the scene graph, so
   * parenting to it would not propagate matrix updates — this reads the
   * already-updated matrixWorld instead.
   */
  followCamera(camera: PerspectiveCamera): void {
    if (this.flat) return;
    this.root.position.setFromMatrixPosition(camera.matrixWorld);
    this.root.quaternion.setFromRotationMatrix(camera.matrixWorld);

    // Yaw drives the heading tape.
    const e = camera.matrixWorld.elements;
    this.material.uniforms.uHeading!.value = Math.atan2(e[8]!, e[10]!);
  }

  update(time: number, handsTracked: number, alert: boolean): void {
    const u = this.material.uniforms;
    u.uTime!.value = time;
    u.uHands!.value = handsTracked;
    u.uOpacity!.value = config.ambient.opacity;

    // Ease the alert wash rather than snapping, so a brief gesture does not
    // flash the whole frame.
    const target = alert ? 1 : 0;
    const current = u.uAlert!.value as number;
    u.uAlert!.value = current + (target - current) * 0.12;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
