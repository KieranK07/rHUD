/**
 * Telemetry overlay: render rate, detection rate, inference cost, per-hand
 * state, and a rolling log of actions off the bus.
 *
 * Detection rate and inference time are here specifically to make the latency
 * budget visible — the velocity-lead constant in config is meant to be set
 * against measured numbers, not guessed.
 */

import type { Action, ActionBus } from '../action/ActionBus.ts';
import type { HandState } from '../core/HandState.ts';
import type { CameraHandle } from '../input/camera.ts';
import { themeHex } from '../render/theme.ts';

const MAX_LOG = 8;

export class DebugPanel {
  private root: HTMLDivElement;
  private statsEl: HTMLPreElement;
  private logEl: HTMLDivElement;
  private log: string[] = [];

  private frames = 0;
  private fps = 0;
  private windowStart = performance.now();
  private lastVideoTime = -1;
  private lastAdvanceAt = performance.now();
  private deviceLabel = 'device unknown';
  private probeCtx: CanvasRenderingContext2D | null;

  constructor(bus: ActionBus) {
    this.root = document.createElement('div');
    this.root.style.cssText = `
      position: fixed; top: 14px; left: 14px; z-index: 20;
      font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: ${themeHex.primary};
      text-shadow: 0 0 8px rgba(95,233,255,0.35);
      pointer-events: none; user-select: none;
      min-width: 260px;
    `;

    this.statsEl = document.createElement('pre');
    this.statsEl.style.cssText = 'margin: 0; white-space: pre;';

    this.logEl = document.createElement('div');
    this.logEl.style.cssText = `margin-top: 10px; color: ${themeHex.accent}; opacity: 0.9;`;

    this.root.append(this.statsEl, this.logEl);
    document.body.appendChild(this.root);

    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 18;
    this.probeCtx = probe.getContext('2d', { willReadFrequently: true });

    bus.pipe((action) => this.push(action));
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none';
  }

  private push(action: Action): void {
    const t = (action.t / 1000).toFixed(2).padStart(7, ' ');
    const extra = action.data
      ? ' ' +
        Object.entries(action.data)
          .map(([k, v]) => `${k}=${v.toFixed(2)}`)
          .join(' ')
      : '';
    this.log.unshift(`${t}  ${action.hand.padEnd(5)} ${action.type}${extra}`);
    if (this.log.length > MAX_LOG) this.log.pop();
    this.logEl.textContent = this.log.join('\n');
    this.logEl.style.whiteSpace = 'pre';
  }

  update(
    hands: HandState[],
    detectionsPerSecond: number,
    inferenceMs: number,
    camera: CameraHandle,
  ): void {
    this.frames++;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 500) {
      this.fps = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.windowStart = now;
    }

    const lines = [
      `rHUD  render ${this.fps.toFixed(0).padStart(3)}fps   detect ${detectionsPerSecond
        .toFixed(0)
        .padStart(3)}fps   infer ${inferenceMs.toFixed(1).padStart(5)}ms`,
      this.feedLine(camera),
      '',
    ];

    const present = hands.filter((h) => h.present);
    if (present.length === 0) {
      lines.push('no hands');
    } else {
      for (const h of present) {
        lines.push(
          `${h.chirality.toUpperCase().padEnd(6)} conf ${h.confidence.toFixed(2)}  ` +
            `span ${h.spanRadius.toFixed(0).padStart(3)}px  pinch ${h.pinch.toFixed(2)}`,
        );
        lines.push(
          `       curl ${h.curl.map((c) => c.toFixed(1)).join(' ')}  ` +
            `speed ${h.speed.toFixed(0).padStart(4)}px/s`,
        );
      }
    }

    lines.push('', 'S skeleton   H panel   F feed   C cycle camera   R re-pick');
    this.statsEl.textContent = lines.join('\n');
  }

  /**
   * Feed health. `stalled` is the one that matters: a stream can report a
   * correct size and a live track while delivering no frames at all, which is
   * exactly how Continuity Camera presents before the phone wakes.
   */
  private feedLine(camera: CameraHandle): string {
    const video = camera.video;
    const track = camera.stream.getVideoTracks()[0];

    const advanced = video.currentTime !== this.lastVideoTime;
    if (advanced) {
      this.lastVideoTime = video.currentTime;
      this.lastAdvanceAt = performance.now();
    }
    const stalledMs = performance.now() - this.lastAdvanceAt;
    const state = stalledMs > 500 ? `STALLED ${(stalledMs / 1000).toFixed(1)}s` : 'live';

    // A stream can be live and still be entirely black, so report mean
    // brightness too. That separates "wrong device" from "device sending
    // nothing but black" — they look identical on screen.
    const brightness = this.sampleBrightness(video);
    const dark = brightness >= 0 && brightness < 4 ? '  ALL BLACK' : '';

    return (
      `feed  ${video.videoWidth}x${video.videoHeight}  ${state}` +
      `  muted=${String(track?.muted ?? '?')}` +
      `  luma ${brightness < 0 ? '--' : brightness.toFixed(0)}${dark}\n` +
      `      ${this.deviceLabel}`
    );
  }

  setDevice(label: string, index: number, total: number): void {
    this.deviceLabel = `[${index + 1}/${total}] ${label}`;
  }

  /**
   * Downsamples the video into a tiny canvas and averages it. Cheap enough to
   * run every frame at 32x18, and the only way to tell from inside the page
   * whether a "working" camera is actually producing an image.
   */
  private sampleBrightness(video: HTMLVideoElement): number {
    if (video.readyState < 2 || video.videoWidth === 0) return -1;

    const ctx = this.probeCtx;
    if (!ctx) return -1;

    try {
      ctx.drawImage(video, 0, 0, 32, 18);
      const { data } = ctx.getImageData(0, 0, 32, 18);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      }
      return sum / (data.length / 4);
    } catch {
      return -1;
    }
  }
}
