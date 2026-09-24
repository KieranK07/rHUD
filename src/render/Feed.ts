/**
 * The camera feed, as a fullscreen quad inside the scene.
 *
 * Critically it is *not* a CSS-positioned <video> behind the canvas: its size
 * and position come from the same Viewport that maps joints to pixels, so the
 * image and the reticles cannot drift apart. See core/viewport.ts.
 *
 * The shader pushes the raw feed toward machine vision — Sobel edges, banded
 * luminance, scanlines — and dims it so HUD elements read clearly on top.
 */

import {
  LinearFilter,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  VideoTexture,
} from 'three';
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

uniform sampler2D uMap;
uniform vec2  uTexel;
uniform float uTime;
uniform float uStylize;
uniform float uEdgeGain;
uniform float uScanline;
uniform float uVignette;
uniform float uAberration;
uniform float uExposure;
uniform vec3  uPrimary;
uniform vec3  uDeep;

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float lumaAt(vec2 uv) {
  return luma(texture2D(uMap, uv).rgb);
}

// Sobel magnitude. Edges are what make a video feed read as "analysed"
// rather than "recorded".
float sobel(vec2 uv) {
  float tl = lumaAt(uv + uTexel * vec2(-1.0,  1.0));
  float t  = lumaAt(uv + uTexel * vec2( 0.0,  1.0));
  float tr = lumaAt(uv + uTexel * vec2( 1.0,  1.0));
  float l  = lumaAt(uv + uTexel * vec2(-1.0,  0.0));
  float r  = lumaAt(uv + uTexel * vec2( 1.0,  0.0));
  float bl = lumaAt(uv + uTexel * vec2(-1.0, -1.0));
  float b  = lumaAt(uv + uTexel * vec2( 0.0, -1.0));
  float br = lumaAt(uv + uTexel * vec2( 1.0, -1.0));

  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy =  tl + 2.0 * t + tr - bl - 2.0 * b - br;
  return length(vec2(gx, gy));
}

void main() {
  vec2 uv = vUv;
  vec2 fromCentre = uv - 0.5;

  // Radial channel split, strongest at the edges — reads as cheap optics.
  vec2 offset = fromCentre * uAberration * 0.004;
  vec3 raw;
  raw.r = texture2D(uMap, uv + offset).r;
  raw.g = texture2D(uMap, uv).g;
  raw.b = texture2D(uMap, uv - offset).b;

  float l = luma(raw);

  // Stepped luminance: the flat, quantised look of a synthetic display.
  float bands = floor(l * 6.0) / 6.0;
  vec3 stylized = mix(uDeep * 0.6, uPrimary * 0.55, bands);

  float edge = clamp(sobel(uv) * uEdgeGain, 0.0, 1.5);
  stylized += uPrimary * edge * 0.9;

  vec3 color = mix(raw, stylized, uStylize) * uExposure;

  // Scanlines in screen space, drifting slowly so they don't alias into a
  // static moire against the video's own pixel grid.
  float scan = sin((vUv.y * 900.0) + uTime * 1.5) * 0.5 + 0.5;
  color *= 1.0 - uScanline * scan;

  float vig = smoothstep(0.85, 0.15, length(fromCentre));
  color *= mix(1.0, vig, uVignette);

  gl_FragColor = vec4(color, 1.0);
}
`;

export class Feed {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private texture: VideoTexture;

  constructor(video: HTMLVideoElement) {
    this.texture = new VideoTexture(video);
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.colorSpace = SRGBColorSpace;

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uMap: { value: this.texture },
        uTexel: { value: new Vector2(1 / video.videoWidth, 1 / video.videoHeight) },
        uTime: { value: 0 },
        uStylize: { value: config.feed.stylize },
        uEdgeGain: { value: config.feed.edgeGain },
        uScanline: { value: config.feed.scanlineIntensity },
        uVignette: { value: config.feed.vignette },
        uAberration: { value: config.feed.aberration },
        uExposure: { value: config.feed.exposure },
        uPrimary: { value: theme.primary },
        uDeep: { value: theme.deep },
      },
    });

    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = 0;
    this.mesh.position.z = LAYER.FEED;
  }

  /** Match the quad to the cover-fit rectangle Viewport computed. */
  layout(viewport: Viewport): void {
    this.mesh.scale.set(viewport.displayWidth, viewport.displayHeight, 1);
    this.mesh.position.x = viewport.width / 2;
    this.mesh.position.y = viewport.height / 2;

    const texel = this.material.uniforms.uTexel!.value as Vector2;
    texel.set(1 / viewport.frameWidth, 1 / viewport.frameHeight);
  }

  update(time: number): void {
    const u = this.material.uniforms;
    u.uTime!.value = time;
    u.uStylize!.value = config.feed.stylize;
    u.uEdgeGain!.value = config.feed.edgeGain;
    u.uScanline!.value = config.feed.scanlineIntensity;
    u.uVignette!.value = config.feed.vignette;
    u.uAberration!.value = config.feed.aberration;
    u.uExposure!.value = config.feed.exposure;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
