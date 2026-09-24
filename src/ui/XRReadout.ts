/**
 * Telemetry you can actually read while wearing the headset.
 *
 * The DOM debug panel is invisible inside an immersive session and the console
 * needs a tethered laptop, which leaves the headset a black box — every wrong
 * guess costs a full round trip of "does this look right now?". This draws the
 * same numbers to a canvas and hangs it in view.
 *
 * Redrawn a few times a second rather than per frame: uploading a canvas
 * texture means a full GPU transfer, and none of these values are worth 72 Hz.
 */

import { CanvasTexture, Group, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { Camera } from 'three';
import { themeHex } from '../render/theme.ts';

const WIDTH = 1024;
const HEIGHT = 512;
const REDRAW_HZ = 4;

export interface ReadoutData {
  buildId: string;
  depthActive: boolean;
  enabledFeatures: readonly string[];
  fps: number;
  handsTracked: number;
  lines: string[];
}

export class XRReadout {
  readonly root = new Group();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: CanvasTexture;
  private mesh: Mesh;
  private lastDraw = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.ctx = this.canvas.getContext('2d')!;

    this.texture = new CanvasTexture(this.canvas);
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;

    this.mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    // Low and slightly left, out of the way of whatever you are looking at.
    this.mesh.position.set(-0.24, -0.30, -1.0);
    this.mesh.scale.set(0.52, 0.26, 1);
    this.mesh.renderOrder = 100;
    this.root.add(this.mesh);
    this.root.renderOrder = 100;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** Pin to the head. Must be given renderer.xr.getCamera(), not the camera
   *  passed to render() — only the former carries the real pose. */
  followCamera(camera: Camera): void {
    this.root.position.setFromMatrixPosition(camera.matrixWorld);
    this.root.quaternion.setFromRotationMatrix(camera.matrixWorld);
  }

  update(now: number, data: ReadoutData): void {
    if (!this.root.visible) return;
    if (now - this.lastDraw < 1000 / REDRAW_HZ) return;
    this.lastDraw = now;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = 'rgba(3, 12, 18, 0.72)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = themeHex.deep;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, WIDTH - 4, HEIGHT - 4);

    ctx.font = '30px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';

    let y = 22;
    const line = (text: string, color = themeHex.primary): void => {
      ctx.fillStyle = color;
      ctx.fillText(text, 24, y);
      y += 38;
    };

    line(`rHUD  build ${data.buildId}   ${data.fps.toFixed(0)}fps`, themeHex.primary);
    line(
      `depth   ${data.depthActive ? 'ACTIVE' : 'UNAVAILABLE'}`,
      data.depthActive ? themeHex.primary : themeHex.accent,
    );

    // The granted feature list is the single most useful thing here: it
    // separates "the effect is subtle" from "the runtime never gave it to us".
    const feats = data.enabledFeatures.join(' ') || '(none reported)';
    ctx.font = '22px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#7fb8cc';
    for (const chunk of wrap(feats, 46)) {
      ctx.fillText(chunk, 24, y);
      y += 26;
    }
    y += 6;

    ctx.font = '28px ui-monospace, Menlo, monospace';
    line(`hands   ${data.handsTracked}`);
    for (const l of data.lines) line(l, '#eafcff');

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
  }
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > width) {
      if (current) out.push(current.trim());
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
  }
  if (current) out.push(current);
  return out;
}
