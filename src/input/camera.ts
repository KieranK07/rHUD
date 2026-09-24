/**
 * Camera acquisition and device selection.
 *
 * The iPhone arrives over Continuity Camera as an ordinary `videoinput`, with
 * no flag distinguishing it from the built-in FaceTime camera — hence the
 * picker, and hence persisting the choice, since re-picking on every reload
 * gets old fast.
 */

const STORAGE_KEY = 'rhud.cameraDeviceId';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraHandle {
  video: HTMLVideoElement;
  stream: MediaStream;
  width: number;
  height: number;
  stop(): void;
}

export function rememberedDeviceId(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function rememberDeviceId(id: string): void {
  localStorage.setItem(STORAGE_KEY, id);
}

/**
 * Device labels are blank until permission is granted, so this must run after
 * a getUserMedia call has resolved at least once.
 */
export async function listCameras(): Promise<CameraDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

export async function openCamera(opts: {
  deviceId?: string | undefined;
  width: number;
  height: number;
  frameRate: number;
}): Promise<CameraHandle> {
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      width: { ideal: opts.width },
      height: { ideal: opts.height },
      frameRate: { ideal: opts.frameRate },
    },
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    throw describeCameraError(error, opts.deviceId);
  }

  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  // Must be in the document. Chrome does not reliably decode frames into a
  // detached <video>, and Continuity Camera — whose stream starts muted and
  // delivers nothing until the phone wakes — takes that path every time.
  // Kept 1px and invisible; the visible image is the WebGL feed quad.
  video.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(video);

  video.srcObject = stream;

  try {
    await video.play();
  } catch {
    // Autoplay policy can reject even a muted stream while frames still flow.
    // Let the readiness check arbitrate rather than failing here.
  }

  await waitForFrames(video, stream);

  return {
    video,
    stream,
    // Getters, not snapshots: Continuity Camera commonly renegotiates
    // resolution shortly after the stream starts, and a stale frame size
    // silently corrupts the cover-fit transform.
    get width() {
      return video.videoWidth;
    },
    get height() {
      return video.videoHeight;
    },
    stop() {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}

/**
 * Waits for the stream to actually deliver pixels — not merely to report
 * dimensions.
 *
 * Continuity Camera publishes metadata almost immediately but arrives with its
 * track `muted`, sending nothing until the phone wakes and connects, which can
 * take several seconds. Treating "has dimensions" as "is ready" therefore
 * produces a live-looking handle that renders pure black. Readiness here means
 * all of: non-zero dimensions, decoded data available, an unmuted live track,
 * and a currentTime that has actually advanced.
 *
 * Polled rather than event-driven because `unmute`, `loadeddata` and `resize`
 * fire inconsistently for this device class, and missing one strands the app
 * on the boot curtain forever.
 */
function waitForFrames(
  video: HTMLVideoElement,
  stream: MediaStream,
  timeoutMs = 20000,
): Promise<void> {
  const track = stream.getVideoTracks()[0];
  const start = performance.now();
  let firstTime = -1;

  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const hasSize = video.videoWidth > 0 && video.videoHeight > 0;
      const hasData = video.readyState >= 2; // HAVE_CURRENT_DATA
      const live = !track || (!track.muted && track.readyState === 'live');

      if (firstTime < 0 && hasData) firstTime = video.currentTime;
      const advancing = firstTime >= 0 && video.currentTime > firstTime;

      if (hasSize && hasData && live && advancing) {
        resolve();
        return;
      }

      if (performance.now() - start > timeoutMs) {
        reject(
          new Error(
            `Camera opened but never delivered frames after ${(timeoutMs / 1000).toFixed(0)}s ` +
              `(size=${video.videoWidth}x${video.videoHeight}, readyState=${video.readyState}, ` +
              `muted=${String(track?.muted)}, track=${String(track?.readyState)}). ` +
              'For Continuity Camera: unlock the phone, keep it near the Mac with Wi-Fi and ' +
              'Bluetooth on, and quit anything else holding the camera.',
          ),
        );
        return;
      }

      setTimeout(poll, 80);
    };
    poll();
  });
}

function describeCameraError(error: unknown, deviceId?: string): Error {
  const name = error instanceof Error ? error.name : '';
  const detail = deviceId ? ` (device ${deviceId.slice(0, 12)}…)` : '';

  switch (name) {
    case 'OverconstrainedError':
      return new Error(
        `Camera rejected the requested format${detail}. The device may be asleep, or may ` +
          'not support the requested resolution.',
      );
    case 'NotReadableError':
      return new Error(
        `Camera is held by another application${detail}. Quit anything else using it ` +
          '(Photo Booth, FaceTime, Zoom) and retry.',
      );
    case 'NotAllowedError':
      return new Error('Camera permission denied. Grant access in the browser site settings.');
    default:
      return error instanceof Error ? error : new Error(String(error));
  }
}
