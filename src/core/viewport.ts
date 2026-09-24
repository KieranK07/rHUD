/**
 * The one cover-fit transform.
 *
 * The camera frame and the canvas almost never share an aspect ratio, so the
 * video is scaled to cover and centre-cropped. The trap: if the video is drawn
 * with CSS `object-fit: cover` while landmarks are mapped by hand in JS, the
 * two transforms disagree by a few percent and reticles sit *near* the hands
 * but never *on* them — and it looks like a tracking problem, not a layout one.
 *
 * So the feed quad and the joint mapping both derive from this object, and
 * nothing else is allowed to compute a video-to-screen mapping.
 *
 * Output is in pixels, Y-up, origin bottom-left — matching the Y-up orthographic
 * camera in Stage.ts. Image space is Y-down, so the flip happens here, once.
 */

import type { Vec3 } from '../input/HandSource.ts';

/**
 * Converts joints from a source's native coordinates into the space the render
 * layer draws in.
 *
 * Two implementations, and the difference is the whole 2D/XR split:
 * `Viewport` maps normalized image coords onto canvas pixels for the phone
 * path, while `MetricSpace` is a pass-through for WebXR, whose joints already
 * arrive as metres in world space.
 *
 * Everything in HandState — palm centre, normal, curl, pinch — is written
 * against this rather than against pixels, so the derivations are identical in
 * both modes and only the units differ.
 */
export interface JointSpace {
  toRender(joint: Vec3, out: Vec3): void;
  /**
   * Lower bound for `spanRadius`, in this space's units. Guards against a
   * degenerate detection producing a zero-size or NaN reticle — and must be
   * unit-aware, since a pixel floor applied to metres would be catastrophic.
   */
  readonly minSpan: number;
}

/**
 * WebXR hand joints are already metres in world space, so there is nothing to
 * convert. Exists so the XR path can satisfy the same interface rather than
 * threading a null through HandState.
 */
export class MetricSpace implements JointSpace {
  /** 2 cm — below any plausible real hand, above float noise. */
  readonly minSpan = 0.02;

  toRender(joint: Vec3, out: Vec3): void {
    out.x = joint.x;
    out.y = joint.y;
    out.z = joint.z;
  }
}

export class Viewport implements JointSpace {
  /** Pixels. Roughly a hand small enough that tracking is meaningless anyway. */
  readonly minSpan = 12;

  /** Canvas size in CSS pixels. */
  width = 1;
  height = 1;
  /** Source frame size in pixels. */
  frameWidth = 1;
  frameHeight = 1;

  /** Frame scaled to cover the canvas. */
  displayWidth = 1;
  displayHeight = 1;
  /** Top-left of the scaled frame, Y-down, may be negative (the crop). */
  offsetX = 0;
  offsetY = 0;

  resize(width: number, height: number, frameWidth: number, frameHeight: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.frameWidth = Math.max(1, frameWidth);
    this.frameHeight = Math.max(1, frameHeight);

    const scale = Math.max(this.width / this.frameWidth, this.height / this.frameHeight);
    this.displayWidth = this.frameWidth * scale;
    this.displayHeight = this.frameHeight * scale;
    this.offsetX = (this.width - this.displayWidth) / 2;
    this.offsetY = (this.height - this.displayHeight) / 2;
  }

  /** Normalized image coords (0..1, Y-down) -> canvas pixels (Y-up). */
  toScreenX(nx: number): number {
    return nx * this.displayWidth + this.offsetX;
  }

  toScreenY(ny: number): number {
    return this.height - (ny * this.displayHeight + this.offsetY);
  }

  /**
   * Joint depth is relative and roughly scaled to normalized image width, so
   * it converts with the same factor as X. Keeps the reticle's tilt in the
   * same units as its position.
   */
  toScreenZ(nz: number): number {
    return nz * this.displayWidth;
  }

  toRender(joint: Vec3, out: Vec3): void {
    out.x = this.toScreenX(joint.x);
    out.y = this.toScreenY(joint.y);
    out.z = this.toScreenZ(joint.z);
  }

  /** Scalar lengths in normalized image units -> pixels. */
  toScreenLength(n: number): number {
    return n * this.displayWidth;
  }
}
