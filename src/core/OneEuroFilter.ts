/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * An EMA forces a single choice between jitter and lag: smooth enough to stop
 * a resting hand from boiling, and a moving hand drags behind by a visible
 * margin. One Euro adapts its cutoff to speed — heavy smoothing when slow,
 * light when fast — which is exactly the asymmetry hand tracking needs.
 *
 * Tuning: set beta to 0 and lower minCutoff until a still hand stops
 * shimmering, then raise beta until fast motion stops lagging.
 */

export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

const TAU = 2 * Math.PI;

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (TAU * cutoff);
  return 1 / (1 + tau / dt);
}

/** Single scalar channel. */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(private params: OneEuroParams) {}

  /** Rate of change at the last update, in units per second. Drives velocity lead. */
  get velocity(): number {
    return this.dxPrev;
  }

  setParams(params: OneEuroParams): void {
    this.params = params;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  /** @param t seconds */
  filter(x: number, t: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }

    // Clamped so a stalled tab or a dropped frame can't produce a wild dt.
    const dt = Math.min(Math.max(t - this.tPrev, 1e-4), 0.1);
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    this.dxPrev = this.dxPrev + alpha(this.params.dCutoff, dt) * (dx - this.dxPrev);

    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dxPrev);
    const xFiltered = this.xPrev + alpha(cutoff, dt) * (x - this.xPrev);

    this.xPrev = xFiltered;
    return xFiltered;
  }
}

/** Three independent channels sharing one parameter set. */
export class Vec3Filter {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private fz: OneEuroFilter;

  constructor(params: OneEuroParams) {
    this.fx = new OneEuroFilter(params);
    this.fy = new OneEuroFilter(params);
    this.fz = new OneEuroFilter(params);
  }

  setParams(params: OneEuroParams): void {
    this.fx.setParams(params);
    this.fy.setParams(params);
    this.fz.setParams(params);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }

  filter(
    x: number,
    y: number,
    z: number,
    t: number,
    out: { x: number; y: number; z: number },
  ): void {
    out.x = this.fx.filter(x, t);
    out.y = this.fy.filter(y, t);
    out.z = this.fz.filter(z, t);
  }

  velocity(out: { x: number; y: number; z: number }): void {
    out.x = this.fx.velocity;
    out.y = this.fy.velocity;
    out.z = this.fz.velocity;
  }
}
