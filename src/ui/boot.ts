/**
 * The boot curtain: camera selection and fatal-error reporting.
 *
 * Device labels are empty until permission has been granted at least once, so
 * the flow is: open a default stream -> enumerate with real labels -> let the
 * user pick -> reopen on the chosen device. The choice persists, so this is a
 * one-time cost per browser profile.
 */

import { listCameras, rememberDeviceId, rememberedDeviceId } from '../input/camera.ts';

const boot = document.getElementById('boot') as HTMLDivElement;

export function setBootMessage(text: string): void {
  boot.classList.remove('hidden');
  boot.innerHTML = '';
  const el = document.createElement('div');
  el.textContent = text;
  boot.appendChild(el);
}

export function hideBoot(): void {
  boot.classList.add('hidden');
}

export function showFatal(error: unknown): void {
  boot.classList.remove('hidden');
  boot.innerHTML = '';

  const title = document.createElement('div');
  title.textContent = 'rHUD — failed to start';

  const detail = document.createElement('div');
  detail.className = 'err';
  detail.textContent = error instanceof Error ? error.message : String(error);

  const hint = document.createElement('div');
  hint.className = 'err';
  hint.textContent =
    'Camera access needs localhost or HTTPS. If the phone is not listed, ' +
    'wake it and confirm Continuity Camera is available in Control Centre.';

  boot.append(title, detail, hint);
  console.error('[rHUD]', error);
}

/**
 * Shows the XR entry button and resolves when it is pressed.
 *
 * A session can only be requested from a user gesture, so this cannot be
 * skipped or automated away — the button is a platform requirement, not a
 * design choice.
 */
export function showEnterXR(subtitle: string): Promise<void> {
  return new Promise((resolve) => {
    boot.classList.remove('hidden');
    boot.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = 'rHUD';

    const detail = document.createElement('div');
    detail.textContent = subtitle;
    detail.style.cssText = 'opacity:0.6;font-size:11px';

    const button = document.createElement('button');
    button.textContent = 'enter ar';
    button.style.fontSize = '15px';
    button.onclick = () => resolve();

    boot.append(title, detail, button);
  });
}

/**
 * Advances to the next enumerated camera and reloads.
 *
 * Reloading rather than hot-swapping the stream is deliberate: tearing down
 * the tracker, the video texture and the source in place is a lot of moving
 * parts to get right for what is fundamentally a debugging affordance, and the
 * model is already cached so a reload costs about a second. Being able to walk
 * the device list quickly matters more than doing it elegantly — device labels
 * on macOS are often ambiguous enough that trying them is faster than reading
 * them.
 */
export async function cycleCamera(): Promise<void> {
  const cameras = await listCameras();
  if (cameras.length === 0) return;

  const current = rememberedDeviceId();
  const index = cameras.findIndex((c) => c.deviceId === current);
  const next = cameras[(index + 1) % cameras.length]!;

  console.log('[rHUD] switching to:', next.label);
  rememberDeviceId(next.deviceId);
  window.location.reload();
}

/**
 * Presents the camera picker. Resolves with the chosen deviceId.
 * `force` skips the remembered choice, for the `R` shortcut.
 */
export async function chooseCamera(force = false): Promise<string | undefined> {
  const cameras = await listCameras();
  if (cameras.length === 0) return undefined;

  const remembered = rememberedDeviceId();
  if (!force && remembered && cameras.some((c) => c.deviceId === remembered)) {
    return remembered;
  }
  if (cameras.length === 1 && !force) {
    rememberDeviceId(cameras[0]!.deviceId);
    return cameras[0]!.deviceId;
  }

  return new Promise((resolve) => {
    boot.classList.remove('hidden');
    boot.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = 'select camera';

    const select = document.createElement('select');
    for (const cam of cameras) {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label;
      if (cam.deviceId === remembered) opt.selected = true;
      select.appendChild(opt);
    }

    const button = document.createElement('button');
    button.textContent = 'engage';
    button.onclick = () => {
      const id = select.value;
      rememberDeviceId(id);
      resolve(id);
    };

    boot.append(title, select, button);
  });
}
