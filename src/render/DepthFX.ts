/**
 * Stylizes the real world using the headset's depth map.
 *
 * WebXR still cannot hand a page the passthrough *colour* pixels, so a literal
 * video filter — the Sobel-and-scanlines treatment Feed.ts applies on the Mac —
 * is not available in a session. What the Quest 3 does expose is a real-time
 * depth frame of the room, derived from its tracking cameras and good to about
 * five metres.
 *
 * Depth turns out to be the better input anyway. Edges found in a colour image
 * are edges in a *picture* — they fire on shadows, posters and patterned rugs.
 * Edges found in depth are real geometry: the actual silhouette of your desk,
 * the corner where two walls meet. Contour bands become topographic lines that
 * wrap physical surfaces, and a scan pulse can sweep outward through the room
 * by true distance. That is a great deal closer to a machine that understands
 * the space than any image filter would be.
 *
 * Everything is additive, because the compositor puts our framebuffer over
 * passthrough — light can be added to the world but the world cannot be
 * repainted.
 */

import {
  AdditiveBlending,
  NormalBlending,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { config } from '../config.ts';
import { theme } from './theme.ts';

// Clip-space directly: this quad always covers the viewport, whichever eye is
// being rendered, so no camera transform is involved.
const vertexShader = /* glsl */ `
void main() {
  gl_Position = vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uDepth;
uniform float uDepthWidth;
uniform float uDepthHeight;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uRange;      // metres; beyond this the depth map is unreliable
uniform float uEdge;
uniform float uContour;
uniform float uContourFreq;
uniform float uScan;
uniform float uDebug;      // 0 off, 1 raw texture channels, 2 linearized metres
uniform vec3  uPrimary;
uniform vec3  uWhite;

/**
 * Both eyes live in one depth array texture, side by side: the left eye is
 * layer 0 and the right eye layer 1, selected by which half of the wide
 * framebuffer the fragment falls in. Same convention three uses for its own
 * occlusion pass.
 */
vec4 rawTexel(vec2 coord) {
  if (coord.x >= 1.0) return texture(uDepth, vec3(coord.x - 1.0, coord.y, 1));
  return texture(uDepth, vec3(coord.x, coord.y, 0));
}

float rawDepth(vec2 coord) {
  return rawTexel(coord).r;
}

/** Window-space depth is heavily nonlinear; convert to metres. */
float linearDepth(vec2 coord) {
  float d = rawDepth(coord);
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

void main() {
  vec2 coord = vec2(gl_FragCoord.x / uDepthWidth, gl_FragCoord.y / uDepthHeight);
  vec2 texel = vec2(1.0 / uDepthWidth, 1.0 / uDepthHeight);

  float z = linearDepth(coord);

  // ---- diagnostics ------------------------------------------------------
  // The WebXR depth texture's encoding is not something to guess at: it may be
  // window-space depth, or raw values needing rawValueToMeters, and the two
  // look identical from the outside — both produce "nothing visible". These
  // modes show the actual contents so the guessing stops.
  if (uDebug > 0.5) {
    vec4 t = rawTexel(coord);
    if (uDebug < 1.5) {
      // Channels laid out directly: red = .r, green = .g, blue = .a. A smooth
      // gradient anywhere means the texture is live and it is only the
      // interpretation that is wrong. Flat black means it never bound.
      gl_FragColor = vec4(t.r, t.g, t.a, 1.0);
      return;
    }
    // Linearized metres as a repeating ramp — banding proves the conversion
    // tracks real distance.
    float m = fract(z * 0.5);
    gl_FragColor = vec4(m, 1.0 - m, abs(z) * 0.1, 1.0);
    return;
  }

  // Nothing useful past the sensor's range, and the sky/unknown reads as far.
  float valid = 1.0 - smoothstep(uRange * 0.8, uRange, z);
  if (valid <= 0.001) discard;

  float intensity = 0.0;
  float hot = 0.0;

  // --- silhouette edges --------------------------------------------------
  // Central differences on linear depth. Dividing by z makes the threshold
  // scale-invariant: without it, near objects would be solid outline and
  // distant ones would vanish, because the same physical step spans fewer
  // metres of gradient the further away it is.
  float zl = linearDepth(coord - vec2(texel.x, 0.0));
  float zr = linearDepth(coord + vec2(texel.x, 0.0));
  float zu = linearDepth(coord + vec2(0.0, texel.y));
  float zd = linearDepth(coord - vec2(0.0, texel.y));

  float grad = (abs(zr - zl) + abs(zu - zd)) / max(z, 0.05);
  float edge = smoothstep(0.02, 0.14, grad);
  intensity += edge * uEdge;
  hot += edge * 0.45;

  // --- depth contours ----------------------------------------------------
  // Bands at fixed metre intervals, so they wrap real surfaces like a
  // topographic map and slide as you move.
  float cf = z * uContourFreq;
  float ring = abs(fract(cf) - 0.5);
  float w = max(fwidth(cf), 1e-4) * 1.4;
  float contour = 1.0 - smoothstep(0.5 - w, 0.5, ring);
  intensity += contour * uContour;

  // --- scan pulse --------------------------------------------------------
  // A shell of light travelling outward through the room. Reads as the space
  // being actively measured rather than merely drawn on.
  float scanZ = fract(uTime * 0.13) * uRange;
  float shell = exp(-abs(z - scanZ) * 5.0);
  float lead = smoothstep(0.06, 0.0, abs(z - scanZ));
  intensity += (shell * 0.5 + lead) * uScan;
  hot += lead * uScan * 0.8;

  vec3 color = mix(uPrimary, uWhite, clamp(hot, 0.0, 1.0) * 0.6);
  float alpha = clamp(intensity, 0.0, 2.0) * valid;

  gl_FragColor = vec4(color * alpha, alpha);
}
`;

export class DepthFX {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  /** True once a depth texture has actually been supplied by the runtime. */
  active = false;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: config.depthfx.debug > 0 ? NormalBlending : AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uDepth: { value: null },
        uDepthWidth: { value: 1 },
        uDepthHeight: { value: 1 },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uTime: { value: 0 },
        uRange: { value: config.depthfx.range },
        uEdge: { value: config.depthfx.edge },
        uContour: { value: config.depthfx.contour },
        uContourFreq: { value: config.depthfx.contourFreq },
        uScan: { value: config.depthfx.scan },
        uDebug: { value: config.depthfx.debug },
        uPrimary: { value: theme.primary },
        uWhite: { value: theme.white },
      },
    });

    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    // Drawn before the hand reticles so they read as being in front of the
    // stylized world rather than buried in it.
    this.mesh.renderOrder = -10;
    this.mesh.visible = false;
  }

  /**
   * Pulls this frame's depth texture off the renderer.
   *
   * Depth sensing is requested as an *optional* feature — a Quest 2, or a
   * headset with the permission declined, simply will not supply one — so this
   * has to cope with the texture never arriving rather than assuming it.
   */
  update(renderer: WebGLRenderer, session: XRSession, time: number): void {
    if (!config.depthfx.enabled) {
      this.mesh.visible = false;
      this.active = false;
      return;
    }

    const texture = renderer.xr.hasDepthSensing?.() ? renderer.xr.getDepthTexture?.() : null;
    if (!texture) {
      this.mesh.visible = false;
      this.active = false;
      return;
    }

    const cameraXR = renderer.xr.getCamera();
    const viewport = cameraXR.cameras[0]?.viewport;
    if (!viewport) return;

    const u = this.material.uniforms;
    u.uDepth!.value = texture as unknown as Texture;
    u.uDepthWidth!.value = viewport.z;
    u.uDepthHeight!.value = viewport.w;
    // The runtime encodes depth against the session's own near/far, so these
    // must come from the render state rather than from our camera.
    u.uNear!.value = session.renderState.depthNear;
    u.uFar!.value = session.renderState.depthFar;
    u.uTime!.value = time;
    u.uRange!.value = config.depthfx.range;
    u.uEdge!.value = config.depthfx.edge;
    u.uContour!.value = config.depthfx.contour;
    u.uContourFreq!.value = config.depthfx.contourFreq;
    u.uScan!.value = config.depthfx.scan;
    u.uDebug!.value = config.depthfx.debug;

    this.mesh.visible = true;
    this.active = true;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
