/**
 * Raw landmark overlay — the registration test.
 *
 * This is the tool that answers "is the reticle misplaced, or is tracking
 * wrong?". Dots are drawn at the smoothed joint positions with no styling
 * between them and the transform, so if they sit exactly on the knuckles
 * during fast motion, the cover-fit maths is correct and any remaining
 * misalignment is the reticle's own placement. Toggle with `S`.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
} from 'three';
import { BONES, JOINT_COUNT } from '../input/HandSource.ts';
import type { HandState } from '../core/HandState.ts';
import { LAYER } from './Stage.ts';
import { theme } from './theme.ts';

const MAX_HANDS = 2;

export class Skeleton {
  readonly points: Points;
  readonly lines: LineSegments;
  /** Palm normal rays, drawn in accent so they read apart from the bones. */
  readonly normals: LineSegments;

  private pointPositions: Float32Array;
  private linePositions: Float32Array;
  private normalPositions: Float32Array;

  /** @param flat mirror mode — pin to a draw layer. In XR, use real depth. */
  constructor(private flat = true) {
    this.pointPositions = new Float32Array(MAX_HANDS * JOINT_COUNT * 3);
    const pointGeo = new BufferGeometry();
    pointGeo.setAttribute('position', new BufferAttribute(this.pointPositions, 3));
    this.points = new Points(
      pointGeo,
      new PointsMaterial({
        color: theme.accent,
        size: 7,
        sizeAttenuation: false,
        transparent: true,
        depthTest: false,
        blending: AdditiveBlending,
      }),
    );

    this.linePositions = new Float32Array(MAX_HANDS * BONES.length * 2 * 3);
    const lineGeo = new BufferGeometry();
    lineGeo.setAttribute('position', new BufferAttribute(this.linePositions, 3));
    this.lines = new LineSegments(
      lineGeo,
      new LineBasicMaterial({
        color: theme.white,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        blending: AdditiveBlending,
      }),
    );

    // Two segments per hand: palm centre along the normal, and a stub marking
    // where the reticle is actually placed. Seeing the normal removes the main
    // unknown in "why is the reticle on the wrong side".
    this.normalPositions = new Float32Array(MAX_HANDS * 2 * 2 * 3);
    const normalGeo = new BufferGeometry();
    normalGeo.setAttribute('position', new BufferAttribute(this.normalPositions, 3));
    this.normals = new LineSegments(
      normalGeo,
      new LineBasicMaterial({
        color: theme.accent,
        transparent: true,
        depthTest: false,
        blending: AdditiveBlending,
      }),
    );
    this.normals.frustumCulled = false;
    this.normals.renderOrder = 21;

    this.points.frustumCulled = false;
    this.lines.frustumCulled = false;
    this.points.renderOrder = 20;
    this.lines.renderOrder = 20;
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.points.visible = visible;
    this.lines.visible = visible;
    this.normals.visible = visible;
  }

  update(hands: HandState[]): void {
    if (!this.points.visible) return;

    let p = 0;
    let l = 0;

    for (const hand of hands) {
      if (!hand.present) continue;

      for (let i = 0; i < JOINT_COUNT && p < this.pointPositions.length - 2; i++) {
        const j = hand.joints[i]!;
        this.pointPositions[p++] = j.x;
        this.pointPositions[p++] = j.y;
        this.pointPositions[p++] = this.flat ? LAYER.SKELETON : j.z;
      }

      for (const [a, b] of BONES) {
        if (l >= this.linePositions.length - 5) break;
        const ja = hand.joints[a]!;
        const jb = hand.joints[b]!;
        this.linePositions[l++] = ja.x;
        this.linePositions[l++] = ja.y;
        this.linePositions[l++] = this.flat ? LAYER.SKELETON : ja.z;
        this.linePositions[l++] = jb.x;
        this.linePositions[l++] = jb.y;
        this.linePositions[l++] = this.flat ? LAYER.SKELETON : jb.z;
      }
    }

    // Palm normal rays.
    let n = 0;
    for (const hand of hands) {
      if (!hand.present || n >= this.normalPositions.length - 11) continue;
      const c = hand.palmCenter;
      const len = hand.spanRadius * 2.0;
      const zBase = this.flat ? LAYER.SKELETON : c.z;
      this.normalPositions[n++] = c.x;
      this.normalPositions[n++] = c.y;
      this.normalPositions[n++] = zBase;
      this.normalPositions[n++] = c.x + hand.palmNormal.x * len;
      this.normalPositions[n++] = c.y + hand.palmNormal.y * len;
      this.normalPositions[n++] = this.flat ? LAYER.SKELETON : c.z + hand.palmNormal.z * len;
    }
    this.normalPositions.fill(-10000, n);
    (this.normals.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;

    // Park unused vertices offscreen rather than resizing the buffers.
    this.pointPositions.fill(-10000, p);
    this.linePositions.fill(-10000, l);

    (this.points.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.lines.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }
}
