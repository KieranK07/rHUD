/**
 * Bootstrap and the frame loop.
 *
 * Two modes behind one pipeline:
 *
 *   mirror — phone camera -> MediaPipe -> pixel space, drawn on the Mac screen
 *   xr     — Quest hand tracking -> metric world space, drawn over passthrough
 *
 * The only differences are which HandSource supplies frames, which JointSpace
 * they are mapped through, and whether the post chain runs. Smoothing, derived
 * features, gestures and the reticle are identical in both.
 *
 * In mirror mode detection and rendering run at independent rates: inference is
 * driven by camera frames while rendering runs on rAF, with the One Euro
 * filters interpolating across the gap. In XR the headset delivers joints on
 * the frame callback, so the two are already in step.
 */

import { Vector3, type PerspectiveCamera } from 'three';
import { BUILD_ID } from './buildId.ts';
import { config } from './config.ts';
import { ActionBus } from './action/ActionBus.ts';
import { GestureRecognizer } from './core/gestures.ts';
import { HandTracker } from './core/HandState.ts';
import { MetricSpace, Viewport, type JointSpace } from './core/viewport.ts';
import { listCameras, openCamera, rememberedDeviceId, type CameraHandle } from './input/camera.ts';
import { MediaPipeHandSource } from './input/MediaPipeHandSource.ts';
import { WebXRHandSource } from './input/WebXRHandSource.ts';
import type { Chirality } from './input/HandSource.ts';
import { AmbientHUD } from './render/AmbientHUD.ts';
import { DepthFX } from './render/DepthFX.ts';
import { Feed } from './render/Feed.ts';
import { Reticle } from './render/Reticle.ts';
import { Skeleton } from './render/Skeleton.ts';
import { Stage } from './render/Stage.ts';
import { enterXR, supportedXRMode } from './xr/session.ts';
import {
  chooseCamera,
  cycleCamera,
  hideBoot,
  setBootMessage,
  showEnterXR,
  showFatal,
} from './ui/boot.ts';
import { DebugPanel } from './ui/DebugPanel.ts';
import { XRReadout } from './ui/XRReadout.ts';

/** Everything downstream of the source, shared by both modes. */
class Hud {
  readonly bus = new ActionBus();
  readonly tracker = new HandTracker();
  readonly gestures: GestureRecognizer;
  readonly skeleton: Skeleton;
  readonly panel: DebugPanel;
  readonly ambient: AmbientHUD;
  private reticles = new Map<Chirality, Reticle>();

  constructor(
    private stage: Stage,
    private flat: boolean,
  ) {
    this.gestures = new GestureRecognizer(this.bus);
    this.skeleton = new Skeleton(flat);
    this.panel = new DebugPanel(this.bus);
    this.ambient = new AmbientHUD(flat);
    this.ambient.root.visible = config.ambient.enabled;
    stage.scene.add(this.skeleton.lines, this.skeleton.points, this.skeleton.normals, this.ambient.root);
  }

  /** Advance derived state, gestures and visuals for one rendered frame. */
  render(
    space: JointSpace,
    latest: Parameters<HandTracker['update']>[0],
    dt: number,
    time: number,
    viewer: Vector3 | null = null,
  ): void {
    this.tracker.update(latest, space, dt);
    const hands = this.tracker.hands;

    this.gestures.update(hands, performance.now());

    let anyActive = false;
    for (const hand of hands) {
      const active =
        this.gestures.isActive(hand.chirality, 'pinch') ||
        this.gestures.isActive(hand.chirality, 'fist');
      anyActive = anyActive || (active && hand.present);
      this.reticleFor(hand.chirality).update(hand, time, active, viewer);
    }

    this.skeleton.update(hands);
    if (config.ambient.enabled) {
      this.ambient.update(time, hands.filter((h) => h.present).length, anyActive);
    }
  }

  get hands() {
    return this.tracker.hands;
  }

  /** Per-hand detail for the in-headset readout. */
  readoutLines(): string[] {
    const out: string[] = [`palmOffset ${config.hand.palmOffset.toFixed(2)}`];
    for (const hand of this.tracker.hands) {
      if (!hand.present) continue;
      const reticle = this.reticles.get(hand.chirality);
      out.push(
        `${hand.chirality[0]!.toUpperCase()} side ${reticle ? (reticle.side > 0 ? '+1' : '-1') : ' ?'}` +
          ` dot ${reticle ? reticle.lastDot.toFixed(2) : '?'}` +
          ` span ${hand.spanRadius.toFixed(3)} n.z ${hand.palmNormal.z.toFixed(2)}`,
      );
    }
    return out;
  }

  private reticleFor(chirality: Chirality): Reticle {
    let reticle = this.reticles.get(chirality);
    if (!reticle) {
      reticle = new Reticle(this.flat);
      this.reticles.set(chirality, reticle);
      this.stage.scene.add(reticle.mesh);
    }
    return reticle;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const xrMode = await supportedXRMode();
  if (xrMode) await bootXR(canvas, xrMode);
  else await bootMirror(canvas);
}

/** Quest path: headset hand tracking over passthrough. */
async function bootXR(canvas: HTMLCanvasElement, mode: 'immersive-ar' | 'immersive-vr'): Promise<void> {
  const stage = new Stage(canvas);
  stage.resize(window.innerWidth, window.innerHeight);
  stage.setXRMode(true);

  const hud = new Hud(stage, false);
  const source = new WebXRHandSource();
  const space = new MetricSpace();
  const depthfx = new DepthFX();
  const readout = new XRReadout();
  stage.scene.add(depthfx.mesh, readout.root);

  await showEnterXR(
    `build ${BUILD_ID} · ` +
      (mode === 'immersive-ar' ? 'hand tracking · passthrough' : 'hand tracking · no passthrough'),
  );

  const session = await enterXR(stage.renderer, mode);
  hideBoot();

  // Skeleton on by default in XR: it is the only way to confirm the 25->21
  // joint mapping landed correctly, and it carries the palm normal rays.
  hud.skeleton.setVisible(true);
  hud.panel.setVisible(false); // a DOM overlay is not visible inside a session

  let lastTime = performance.now();
  const viewerPos = new Vector3();
  let fps = 0;
  let frames = 0;
  let fpsWindow = performance.now();

  stage.renderer.setAnimationLoop((_time, xrFrame) => {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    const referenceSpace = stage.renderer.xr.getReferenceSpace();
    if (xrFrame && referenceSpace) {
      source.update(xrFrame, referenceSpace, now);
    }

    // Head pose must come from renderer.xr.getCamera(). three's updateCamera
    // writes the headset pose into its own internal ArrayCamera and leaves the
    // camera passed to render() untouched, so stage.xrCamera.matrixWorld stays
    // identity — which previously put the "viewer" at the floor origin between
    // the user's feet and made the reticle's side selection meaningless.
    const headCamera = stage.renderer.xr.getCamera();
    viewerPos.setFromMatrixPosition(headCamera.matrixWorld);

    hud.render(space, source.latest(), dt, now / 1000, viewerPos);
    if (config.ambient.enabled) hud.ambient.followCamera(headCamera as unknown as PerspectiveCamera);
    depthfx.update(stage.renderer, session, now / 1000);

    frames++;
    if (now - fpsWindow >= 500) {
      fps = (frames * 1000) / (now - fpsWindow);
      frames = 0;
      fpsWindow = now;
    }

    readout.followCamera(headCamera);
    readout.update(now, {
      buildId: BUILD_ID,
      depthActive: depthfx.active,
      enabledFeatures: session.enabledFeatures ?? [],
      fps,
      handsTracked: hud.hands.filter((h) => h.present).length,
      lines: hud.readoutLines(),
    });

    stage.render();
  });

  // Report once whether the runtime actually granted depth sensing — the
  // difference between "the effect is subtle" and "the effect is absent".
  setTimeout(() => {
    console.log(
      `[rHUD] depth sensing: ${depthfx.active ? 'active' : 'unavailable'}` +
        ` — enabledFeatures: ${JSON.stringify(session.enabledFeatures ?? [])}`,
    );
  }, 1500);

  session.addEventListener('end', () => {
    stage.renderer.setAnimationLoop(null);
    setBootMessage('rHUD — session ended');
  });
}

/** Mac path: phone camera, MediaPipe, drawn flat on screen. */
async function bootMirror(canvas: HTMLCanvasElement): Promise<void> {
  setBootMessage('rHUD — requesting camera');
  let camera: CameraHandle = await openCamera({
    deviceId: rememberedDeviceId() ?? undefined,
    ...config.camera,
  });

  const chosen = await chooseCamera();
  if (chosen && chosen !== currentDeviceId(camera)) {
    camera.stop();
    // A phone over Continuity Camera can take several seconds to wake and
    // start sending, so say so rather than appearing to hang.
    setBootMessage('rHUD — waking camera');
    camera = await openCamera({ deviceId: chosen, ...config.camera });
  }

  setBootMessage('rHUD — loading tracker');
  const source = new MediaPipeHandSource(camera);
  await source.start();

  const stage = new Stage(canvas);
  const viewport = new Viewport();
  const feed = new Feed(camera.video);
  const hud = new Hud(stage, true);
  stage.scene.add(feed.mesh);

  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    viewport.resize(width, height, camera.width, camera.height);
    stage.resize(width, height);
    feed.layout(viewport);
    hud.ambient.layoutFlat(viewport);
  };
  resize();
  window.addEventListener('resize', resize);
  // Continuity Camera can renegotiate its resolution seconds after the stream
  // starts. Without this the cover-fit transform keeps the old frame size and
  // every reticle sits slightly off its hand.
  camera.video.addEventListener('resize', resize);

  hud.skeleton.setVisible(config.debug.showSkeleton);
  hud.panel.setVisible(config.debug.showPanel);
  installShortcuts({ hud, feed });
  await reportDevices(camera, hud.panel);

  hideBoot();

  let lastTime = performance.now();

  const tick = (): void => {
    requestAnimationFrame(tick);

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    hud.render(viewport, source.latest(), dt, now / 1000);
    feed.update(now / 1000);
    hud.panel.update(hud.hands, source.detectionsPerSecond, source.lastInferenceMs, camera);
    stage.render();
  };

  tick();
}

function currentDeviceId(camera: CameraHandle): string | undefined {
  return camera.stream.getVideoTracks()[0]?.getSettings().deviceId;
}

/**
 * Logs every enumerated camera and marks the active one.
 *
 * macOS device labels are frequently ambiguous — virtual cameras, DeskView and
 * Continuity Camera entries can all appear alongside the real hardware, and an
 * entry existing is no guarantee it will produce an image. Having the full list
 * with the live one marked turns "the feed is black" into a question you can
 * actually answer.
 */
async function reportDevices(camera: CameraHandle, panel: DebugPanel): Promise<void> {
  const active = currentDeviceId(camera);
  const cameras = await listCameras();
  const index = cameras.findIndex((c) => c.deviceId === active);

  console.log(
    `[rHUD] ${cameras.length} camera(s) — active marked ▶ (press C to cycle)\n` +
      cameras
        .map(
          (c, i) =>
            `${c.deviceId === active ? ' ▶ ' : '   '}${i + 1}. ${c.label}  ` +
            `(${c.deviceId.slice(0, 16)}…)`,
        )
        .join('\n'),
  );

  const track = camera.stream.getVideoTracks()[0];
  console.log('[rHUD] active track:', track?.label, track?.getSettings());

  panel.setDevice(
    cameras[index]?.label ?? track?.label ?? 'unknown',
    index < 0 ? 0 : index,
    cameras.length,
  );
}

function installShortcuts(ctx: { hud: Hud; feed: Feed }): void {
  let skeletonOn = config.debug.showSkeleton;
  let panelOn = config.debug.showPanel;
  let feedOn = true;

  window.addEventListener('keydown', (event) => {
    switch (event.key.toLowerCase()) {
      case 's':
        skeletonOn = !skeletonOn;
        ctx.hud.skeleton.setVisible(skeletonOn);
        break;
      case 'h':
        panelOn = !panelOn;
        ctx.hud.panel.setVisible(panelOn);
        document.body.classList.toggle('show-cursor', panelOn);
        break;
      case 'f':
        // Drops the video to black — previews how the HUD will read on a
        // see-through display.
        feedOn = !feedOn;
        ctx.feed.mesh.visible = feedOn;
        break;
      case 'c':
        void cycleCamera();
        break;
      case 'r':
        void chooseCamera(true).then(() => window.location.reload());
        break;
    }
  });
}

main().catch(showFatal);
