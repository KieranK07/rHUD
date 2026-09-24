/**
 * Renderer, camera, and the post chain.
 *
 * The camera is orthographic in **canvas pixels, Y-up, origin bottom-left** —
 * the same space Viewport emits. Placing a reticle is then just
 * `mesh.position.set(palm.x, palm.y, z)` with no conversion, which removes an
 * entire category of drift bug from the render layer.
 */

import {
  Color,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type WebGLRendererParameters,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Vector2 } from 'three';
import { config } from '../config.ts';
import { theme } from './theme.ts';

/** Draw order along Z. Ortho range is generous enough that exact values are free. */
export const LAYER = {
  FEED: -100,
  SKELETON: 0,
  AMBIENT: 5,
  RETICLE: 10,
} as const;

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: OrthographicCamera;
  /**
   * Driven by the headset in XR; unused in mirror mode.
   *
   * The near plane is 0.1m rather than the more usual 0.01m because the depth
   * map DepthFX reads is encoded against this frustum — a near plane an order
   * of magnitude closer crushes almost all depth precision into the first few
   * centimetres and leaves the rest of the room quantised into mush. Hands
   * never get within 10cm of your eyes, so nothing is lost.
   */
  readonly xrCamera = new PerspectiveCamera(70, 1, 0.1, 100);
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;

  xr = false;
  width = 1;
  height = 1;

  constructor(canvas: HTMLCanvasElement) {
    const params: WebGLRendererParameters = {
      canvas,
      antialias: true,
      // Required for passthrough: the headset composites the real world behind
      // whatever this canvas draws, so it has to be able to render transparent.
      alpha: true,
      powerPreference: 'high-performance',
    };
    this.renderer = new WebGLRenderer(params);
    this.renderer.setClearColor(new Color(theme.base), 1);
    this.renderer.autoClear = true;

    this.scene.background = new Color(theme.base);

    // Placeholder frustum; resize() sets the real one before first render.
    this.camera = new OrthographicCamera(0, 1, 1, 0, -2000, 2000);
    this.camera.position.z = 1000;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const b = config.render.bloom;
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), b.strength, b.radius, b.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    const dpr = Math.min(window.devicePixelRatio, config.render.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);

    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = height;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Switches to passthrough rendering.
   *
   * Two things have to change together. The scene background and clear alpha
   * go transparent, or the HUD paints over the real world and you get VR in a
   * black void instead of AR. And the post chain is bypassed: EffectComposer
   * renders through its own fullscreen render targets, which do not survive
   * WebXR's stereo framebuffer — running it in a session produces a black or
   * single-eye image.
   *
   * Losing UnrealBloomPass means losing the glow, so the reticle shader's own
   * exponential falloff has to carry it. See `glowBoost` in Reticle.
   */
  setXRMode(enabled: boolean): void {
    this.xr = enabled;
    if (enabled) {
      this.scene.background = null;
      this.renderer.setClearColor(new Color(0x000000), 0);
    } else {
      this.scene.background = new Color(theme.base);
      this.renderer.setClearColor(new Color(theme.base), 1);
    }
  }

  render(): void {
    if (this.xr) {
      this.renderer.render(this.scene, this.xrCamera);
      return;
    }

    const b = config.render.bloom;
    this.bloom.strength = b.strength;
    this.bloom.radius = b.radius;
    this.bloom.threshold = b.threshold;
    this.composer.render();
  }
}
