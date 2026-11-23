import * as THREE from 'three';

/**
 * Exact analytic critically-damped 1D harmonic oscillator (zeta = 1.0).
 * 100% frame-rate independent, C1-continuous, never overshoots or explodes at any dt.
 * Ideal for comfortable AAA camera movement, crouch, strafe bank, sprint blends, and wolf locomotion.
 */
export class CriticalSpring {
  public value: number;
  public velocity = 0;
  /** Natural angular frequency (rad/s). Higher = snappier, lower = floatier. */
  public omega: number;

  constructor(initial = 0, omega = 10) {
    this.value = initial;
    this.omega = omega;
  }

  public snap(val: number) {
    this.value = val;
    this.velocity = 0;
  }

  public impulse(dv: number) {
    this.velocity += dv;
  }

  public step(target: number, dt: number): number {
    if (dt <= 0) return this.value;
    const w = this.omega;
    const d = this.value - target;
    const exp = Math.exp(-w * dt);
    const vPlusWd = this.velocity + w * d;
    this.value = target + (d + vPlusWd * dt) * exp;
    this.velocity = (this.velocity - w * vPlusWd * dt) * exp;
    return this.value;
  }
}

/**
 * Exact analytic damped 1D harmonic oscillator supporting underdamped (zeta < 1),
 * critically damped (zeta = 1), and overdamped (zeta > 1) motion.
 * Guarantees stability at any frame rate while giving tactile elastic weight to weapon recoil,
 * basket pendulum physics, and soft camera footstep/impact cushions.
 */
export class DampedSpring {
  public value: number;
  public velocity = 0;
  public omega: number;
  public zeta: number;

  constructor(initial = 0, omega = 16, zeta = 0.72) {
    this.value = initial;
    this.omega = omega;
    this.zeta = zeta;
  }

  public snap(val: number) {
    this.value = val;
    this.velocity = 0;
  }

  public impulse(dv: number) {
    this.velocity += dv;
  }

  public step(target: number, dt: number): number {
    if (dt <= 0) return this.value;
    const w = this.omega;
    const z = this.zeta;
    const x0 = this.value - target;
    const v0 = this.velocity;

    if (z < 0.999) {
      // Underdamped analytic solution
      const wd = w * Math.sqrt(1 - z * z);
      const exp = Math.exp(-z * w * dt);
      const cos = Math.cos(wd * dt);
      const sin = Math.sin(wd * dt);
      const c2 = (v0 + z * w * x0) / wd;
      this.value = target + exp * (x0 * cos + c2 * sin);
      this.velocity =
        exp * ((c2 * wd - x0 * z * w) * cos - (x0 * wd + c2 * z * w) * sin);
    } else if (z > 1.001) {
      // Overdamped analytic solution
      const sq = Math.sqrt(z * z - 1);
      const r1 = -w * (z - sq);
      const r2 = -w * (z + sq);
      const c2 = (v0 - r1 * x0) / (r2 - r1);
      const c1 = x0 - c2;
      const e1 = Math.exp(r1 * dt);
      const e2 = Math.exp(r2 * dt);
      this.value = target + c1 * e1 + c2 * e2;
      this.velocity = c1 * r1 * e1 + c2 * r2 * e2;
    } else {
      // Critically damped analytic solution
      const exp = Math.exp(-w * dt);
      const vPlusWx = v0 + w * x0;
      this.value = target + (x0 + vPlusWx * dt) * exp;
      this.velocity = (v0 - w * vPlusWx * dt) * exp;
    }
    return this.value;
  }
}

/**
 * 6-Degree-of-Freedom analytic spring rig (3 translation + 3 Euler rotation channels).
 * Zero allocations in step().
 */
export class Spring6DOF {
  public readonly pos = new THREE.Vector3();
  public readonly rot = new THREE.Vector3();
  private readonly px: DampedSpring;
  private readonly py: DampedSpring;
  private readonly pz: DampedSpring;
  private readonly rx: DampedSpring;
  private readonly ry: DampedSpring;
  private readonly rz: DampedSpring;

  constructor(posOmega = 16, posZeta = 0.78, rotOmega = 18, rotZeta = 0.72) {
    this.px = new DampedSpring(0, posOmega, posZeta);
    this.py = new DampedSpring(0, posOmega, posZeta);
    this.pz = new DampedSpring(0, posOmega, posZeta);
    this.rx = new DampedSpring(0, rotOmega, rotZeta);
    this.ry = new DampedSpring(0, rotOmega, rotZeta);
    this.rz = new DampedSpring(0, rotOmega, rotZeta);
  }

  public impulsePos(x: number, y: number, z: number) {
    this.px.impulse(x);
    this.py.impulse(y);
    this.pz.impulse(z);
  }

  public impulseRot(x: number, y: number, z: number) {
    this.rx.impulse(x);
    this.ry.impulse(y);
    this.rz.impulse(z);
  }

  public step(
    dt: number,
    tx = 0,
    ty = 0,
    tz = 0,
    trx = 0,
    try_ = 0,
    trz = 0,
  ) {
    this.pos.set(
      this.px.step(tx, dt),
      this.py.step(ty, dt),
      this.pz.step(tz, dt),
    );
    this.rot.set(
      this.rx.step(trx, dt),
      this.ry.step(try_, dt),
      this.rz.step(trz, dt),
    );
  }

  public reset() {
    this.px.snap(0);
    this.py.snap(0);
    this.pz.snap(0);
    this.rx.snap(0);
    this.ry.snap(0);
    this.rz.snap(0);
    this.pos.set(0, 0, 0);
    this.rot.set(0, 0, 0);
  }
}
