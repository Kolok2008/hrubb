import gsap from 'gsap';
import * as THREE from 'three';
import { CriticalSpring, Spring6DOF } from '../animation/SpringSystem';
import type { WorldCollider } from '../types';
import { groundHeightAt, WORLD_HALF } from '../world/terrain';

export type FootstepPhase = 'heel' | 'toe' | 'debris' | 'breath';

export interface FootstepEvent {
  speed: number;
  sprintBlend: number;
  crouch: number;
  exhausted: boolean;
  foot: -1 | 1; // -1 = left, +1 = right
  cadenceScale: number;
  stepIndex: number;
}

export class PlayerController {
  public readonly pos = new THREE.Vector3();
  public readonly vel = new THREE.Vector3();
  public yaw = 0;
  public pitch = 0;

  public keys: Record<string, boolean> = {};
  public sens = 0.0022;
  public eye = 1.65;
  public crouch = 0;
  public crouchTarget = 0;
  public stepPhase = 0;
  public speed = 0;
  public slow = 1;
  public strafeInput = 0;
  public sprintBlend = 0;

  public enabled = false;
  public externalCameraControl = false;
  public bootsLevel = 0;
  public moveInput = new THREE.Vector2();
  public sprint = false;
  public stamina = 100;
  public exhausted = false;
  public running = false;

  public getNoiseMultiplier(): number {
    return this.bootsLevel >= 2 ? 0.62 : this.bootsLevel === 1 ? 0.8 : 1.0;
  }

  // Professional analytic 6-DOF spring rigs for buttery-smooth, comfortable AAA camera feel
  private readonly velXSpring = new CriticalSpring(0, 12.5);
  private readonly velZSpring = new CriticalSpring(0, 12.5);
  private readonly groundYSpring = new CriticalSpring(0, 15);
  private readonly crouchSpring = new CriticalSpring(0, 9.5);
  private readonly gaitAmpSpring = new CriticalSpring(0, 7.5);
  private readonly sprintSpring = new CriticalSpring(0, 6.5);
  private readonly strafeRollSpring = new CriticalSpring(0, 8.5);
  private readonly sprintPitchSpring = new CriticalSpring(0, 6.0);
  private readonly cameraImpulse = new Spring6DOF(15, 0.86, 17, 0.88);

  // Smooth GSAP-driven FOV transitions (idle/walk <-> sprint <-> crouch)
  private readonly fovState = { value: 72 };
  private fovTarget = 72;
  private fovTween: gsap.core.Tween | null = null;
  private breathTime = 0;

  // GSAP footstep choreographer: locks camera heel-dip/roll/pitch to exact audio sub-phases
  private readonly stepCam = { dipY: 0, rollZ: 0, pitchX: 0 };
  private stepTl: gsap.core.Timeline | null = null;
  private stepCount = 0;
  private paused = false;

  public onStep: ((speed: number) => void) | null = null;
  public onStepPhase: ((phase: FootstepPhase, ev: FootstepEvent) => void) | null = null;
  public onBasketDip: ((intensity: number, foot: -1 | 1) => void) | null = null;
  public onLook: ((dx: number, dy: number) => void) | null = null;

  private readonly _fwd = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _wish = new THREE.Vector3();

  private readonly handleKeyDown: (e: KeyboardEvent) => void;
  private readonly handleKeyUp: (e: KeyboardEvent) => void;
  private readonly handleBlur: () => void;
  private readonly handleMouseMove: (e: MouseEvent) => void;

  constructor(
    private readonly cam: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly colliders: WorldCollider[],
  ) {
    this.handleKeyDown = (e) => {
      this.keys[e.code] = true;
    };
    this.handleKeyUp = (e) => {
      this.keys[e.code] = false;
    };
    this.handleBlur = () => {
      this.keys = {};
      this.moveInput.set(0, 0);
    };
    this.handleMouseMove = (e) => {
      if (!this.enabled || document.pointerLockElement !== this.dom) return;
      this.look(e.movementX, e.movementY);
    };

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('mousemove', this.handleMouseMove);
  }

  /**
   * Injects a comfortable, damped 6-DOF impact cushion (instead of harsh sinusoidal screen jitter).
   */
  public addShake(amount: number) {
    const a = THREE.MathUtils.clamp(amount, 0, 0.05);
    const sign = Math.random() < 0.5 ? -1 : 1;
    this.cameraImpulse.impulsePos(sign * a * 0.6, -a * 0.85, a * 0.4);
    this.cameraImpulse.impulseRot(-a * 1.4, sign * a * 0.5, sign * a * 1.6);
  }

  public look(dx: number, dy: number) {
    this.yaw -= dx * this.sens;
    this.pitch -= dy * this.sens;
    this.pitch = Math.max(-1.45, Math.min(1.35, this.pitch));
    this.onLook?.(dx, dy);
  }

  public setPose(x: number, z: number, yaw = 0, pitch = 0) {
    const gy = groundHeightAt(x, z);
    this.pos.set(x, gy, z);
    this.yaw = yaw;
    this.pitch = pitch;
    this.vel.set(0, 0, 0);
    this.velXSpring.snap(0);
    this.velZSpring.snap(0);
    this.groundYSpring.snap(gy);
    this.crouchSpring.snap(0);
    this.gaitAmpSpring.snap(0);
    this.sprintSpring.snap(0);
    this.strafeRollSpring.snap(0);
    this.sprintPitchSpring.snap(0);
    this.cameraImpulse.reset();
    this.stepTl?.kill();
    this.stepCam.dipY = 0;
    this.stepCam.rollZ = 0;
    this.stepCam.pitchX = 0;
    this.apply(0);
  }

  public setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.stepTl?.pause();
      this.fovTween?.pause();
    } else {
      if (this.stepTl?.paused()) this.stepTl.resume();
      if (this.fovTween?.paused()) this.fovTween.resume();
    }
  }

  private updateFovTarget(target: number) {
    if (Math.abs(target - this.fovTarget) < 0.05) return;
    this.fovTarget = target;
    this.fovTween?.kill();
    this.fovTween = gsap.to(this.fovState, {
      value: target,
      duration: target > this.fovState.value ? 0.42 : 0.52,
      ease: 'power2.out',
      overwrite: 'auto',
    });
  }

  /**
   * Choreographs a single stride via GSAP: locks the camera heel-dip/roll/pitch curve,
   * viewmodel basket weight drop, and multi-phase audio events (heel -> toe -> debris -> breath).
   */
  private triggerFootstepTimeline(ev: FootstepEvent) {
    this.stepTl?.kill();

    const stealthScale = 1 - ev.crouch * 0.62;
    const paceScale = (0.72 + ev.sprintBlend * 0.52) * (ev.exhausted ? 1.15 : 1);
    const weight = stealthScale * paceScale;

    // Comfortable, non-jarring micro-amplitude camera weight curve
    const dipDepth = (0.006 + ev.sprintBlend * 0.004) * stealthScale * (ev.exhausted ? 1.18 : 1);
    const rollAmt = (0.0024 + ev.sprintBlend * 0.0014) * stealthScale;
    const pitchAmt = (0.0025 + ev.sprintBlend * 0.0015) * stealthScale * (ev.exhausted ? 1.25 : 1);

    const tl = gsap.timeline({
      onStart: () => {
        this.onStepPhase?.('heel', ev);
        this.onBasketDip?.(weight, ev.foot);
      },
    });

    // Phase 1 (t = 0.00): Heel strike + camera cushion dip + basket weight drop
    tl.to(
      this.stepCam,
      {
        dipY: -dipDepth,
        rollZ: ev.foot * rollAmt,
        pitchX: -pitchAmt,
        duration: 0.13,
        ease: 'sine.inOut',
      },
      0,
    );

    // Phase 2 (t = 0.075): Bottom of weight transfer -> toe-off roll/scuff + smooth upward lift
    tl.call(
      () => {
        this.onStepPhase?.('toe', ev);
      },
      [],
      0.13,
    ).to(
      this.stepCam,
      {
        dipY: dipDepth * 0.16,
        rollZ: 0,
        pitchX: pitchAmt * 0.22,
        duration: 0.2,
        ease: 'sine.inOut',
      },
      0.075,
    );

    // Phase 3 (t = 0.115): Push-off lift -> micro-pebble scatter / dry leaf crinkle
    tl.call(
      () => {
        this.onStepPhase?.('debris', ev);
      },
      [],
      0.115,
    );

    // Phase 4 (Exhausted cadence): Synchronized tired exhale on alternating steps
    if (ev.exhausted && ev.stepIndex % 2 === 0) {
      tl.call(
        () => {
          this.onStepPhase?.('breath', ev);
        },
        [],
        0.155,
      );
    }

    // Settle back cleanly to neutral
    tl.to(
      this.stepCam,
      {
        dipY: 0,
        rollZ: 0,
        pitchX: 0,
        duration: 0.095,
        ease: 'power2.out',
      },
      0.2,
    );

    tl.timeScale(ev.cadenceScale);
    if (this.paused) tl.pause();
    this.stepTl = tl;
  }

  public update(dt: number) {
    let f = 0;
    let r = 0;

    if (this.enabled) {
      const k = this.keys;
      f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) + this.moveInput.y;
      r = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0) + this.moveInput.x;
      const len = Math.hypot(f, r);
      if (len > 1) {
        f /= len;
        r /= len;
      }

      let run = (k.ShiftLeft || k.ShiftRight || this.sprint) && f > 0.15 && !this.exhausted;
      const drainRate = this.bootsLevel >= 2 ? 10.2 : this.bootsLevel === 1 ? 12.6 : 16;
      const regenMult = this.bootsLevel >= 2 ? 1.45 : this.bootsLevel === 1 ? 1.25 : 1.0;
      if (run) {
        this.stamina -= dt * drainRate;
        if (this.stamina <= 0) {
          this.stamina = 0;
          this.exhausted = true;
          run = false;
        }
      } else {
        this.stamina = Math.min(100, this.stamina + dt * (len > 0.1 ? 9 : 16) * regenMult);
      }
      if (this.exhausted && this.stamina > 35) this.exhausted = false;
      this.running = run;

      this.crouchTarget = k.KeyC || k.ControlLeft ? 1 : 0;

      const baseSpeed =
        (run ? 5.8 : this.exhausted ? 2.2 : 2.95) * (this.crouch > 0.5 ? 0.5 : 1) * this.slow;
      this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this._wish.copy(this._fwd).multiplyScalar(f * baseSpeed).addScaledVector(this._right, r * baseSpeed);

      // Critically-damped velocity response: snappy starts, silky stops
      this.velXSpring.omega = len > 0.05 ? 12.5 : 9.5;
      this.velZSpring.omega = len > 0.05 ? 12.5 : 9.5;
      this.vel.x = this.velXSpring.step(this._wish.x, dt);
      this.vel.z = this.velZSpring.step(this._wish.z, dt);
    } else {
      this.running = false;
      this.velXSpring.omega = 9.0;
      this.velZSpring.omega = 9.0;
      this.vel.x = this.velXSpring.step(0, dt);
      this.vel.z = this.velZSpring.step(0, dt);
    }

    this.strafeInput = r;

    // Move & respect steep slopes
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const h0 = groundHeightAt(this.pos.x, this.pos.z);
    const h1 = groundHeightAt(nx, nz);
    const dist = Math.hypot(nx - this.pos.x, nz - this.pos.z);
    const slopeFactor = (dist > 0 ? (h1 - h0) / dist : 0) > 0.6 ? 0.25 : 1;
    this.pos.x += (nx - this.pos.x) * slopeFactor;
    this.pos.z += (nz - this.pos.z) * slopeFactor;

    // World collisions (boxes & cylinders)
    for (const c of this.colliders) {
      if (c.box) {
        const dx = this.pos.x - c.x;
        const dz = this.pos.z - c.z;
        const cos = Math.cos(c.rot);
        const sin = Math.sin(c.rot);
        const lx = dx * cos - dz * sin - c.cx;
        const lz = dx * sin + dz * cos - c.cz;
        const ox = c.hw + 0.3 - Math.abs(lx);
        const oz = c.hd + 0.3 - Math.abs(lz);
        if (ox > 0 && oz > 0) {
          let nlx = lx;
          let nlz = lz;
          if (ox < oz) nlx = Math.sign(lx) * (c.hw + 0.3);
          else nlz = Math.sign(lz) * (c.hd + 0.3);
          const rx = nlx + c.cx;
          const rz = nlz + c.cz;
          this.pos.x = c.x + rx * cos + rz * sin;
          this.pos.z = c.z - rx * sin + rz * cos;
        }
        continue;
      }
      const dx = this.pos.x - c.x;
      const dz = this.pos.z - c.z;
      const rr = c.r + 0.3;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        this.pos.x = c.x + (dx / d) * rr;
        this.pos.z = c.z + (dz / d) * rr;
      }
    }

    const lim = WORLD_HALF - 6;
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x));
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));
    const gy = groundHeightAt(this.pos.x, this.pos.z);
    this.pos.y = this.groundYSpring.step(gy, dt);

    this.apply(dt);
  }

  private apply(dt: number) {
    this.breathTime += dt;
    const spd = Math.hypot(this.vel.x, this.vel.z);
    this.speed = spd;

    // Smooth analytic spring blends (no abrupt thresholds!)
    this.crouch = this.crouchSpring.step(Math.min(1, this.crouchTarget), dt);
    this.sprintBlend = this.sprintSpring.step(this.running && spd > 2.2 ? 1 : 0, dt);

    const gaitTarget = THREE.MathUtils.clamp((spd - 0.15) / 2.6, 0, 1);
    const gaitAmp = this.gaitAmpSpring.step(gaitTarget, dt);

    // Smooth GSAP FOV shift (72° walk, 77° sprint, 69° crouch)
    const desiredFov = this.running && spd > 2.4 ? 77.5 : this.crouchTarget > 0.5 ? 69.5 : 72;
    this.updateFovTarget(desiredFov);
    if (Math.abs(this.cam.fov - this.fovState.value) > 0.005) {
      this.cam.fov = this.fovState.value;
      this.cam.updateProjectionMatrix();
    }

    // Advance stride phase smoothly proportional to ground speed
    const prevPhase = this.stepPhase;
    const strideRate = THREE.MathUtils.lerp(1.75, 1.48, this.sprintBlend);
    this.stepPhase += spd * dt * strideRate;
    if (Math.floor(prevPhase) !== Math.floor(this.stepPhase) && spd > 0.45) {
      this.onStep?.(spd);
      const stepIndex = this.stepCount++;
      const foot: -1 | 1 = stepIndex % 2 === 0 ? 1 : -1;
      const cadenceScale = THREE.MathUtils.clamp(
        (0.84 + this.sprintBlend * 0.48) * (1 - this.crouch * 0.2) * (this.exhausted ? 0.84 : 1),
        0.68,
        1.45,
      );
      this.triggerFootstepTimeline({
        speed: spd,
        sprintBlend: this.sprintBlend,
        crouch: this.crouch,
        exhausted: this.exhausted,
        foot,
        cadenceScale,
        stepIndex,
      });
    }

    // C-infinity smooth organic figure-8 head motion (ZERO Math.abs sharp cusps!)
    const phaseRad = this.stepPhase * Math.PI;
    const vAmp = THREE.MathUtils.lerp(0.02, 0.027, this.sprintBlend) * (1 - this.crouch * 0.45);
    const hAmp = THREE.MathUtils.lerp(0.012, 0.015, this.sprintBlend) * (1 - this.crouch * 0.4);
    const bobY = ((1 - Math.cos(phaseRad * 2)) * 0.5 - 0.5) * vAmp * gaitAmp;
    const bobX = Math.sin(phaseRad) * hAmp * gaitAmp;

    // Subtle organic idle breathing
    const idleBreath = Math.sin(this.breathTime * 1.45) * 0.0032 * (1 - gaitAmp * 0.6);

    // Gentle, comfortable strafe roll & micro sprint lean
    const strafeRoll = this.strafeRollSpring.step(-this.strafeInput * (0.012 + this.sprintBlend * 0.007), dt);
    const sprintPitch = this.sprintPitchSpring.step(-this.sprintBlend * 0.01, dt);

    // Step 6-DOF cushion/impact spring
    this.cameraImpulse.step(dt);

    const eyeH = this.eye - this.crouch * 0.72;
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    const localX = bobX + this.cameraImpulse.pos.x;
    const localZ = this.cameraImpulse.pos.z;

    if (this.externalCameraControl) return;

    this.cam.position.set(
      this.pos.x + cosY * localX + sinY * localZ,
      this.pos.y + eyeH + bobY + idleBreath + this.stepCam.dipY + this.cameraImpulse.pos.y,
      this.pos.z - sinY * localX + cosY * localZ,
    );

    this.cam.rotation.order = 'YXZ';
    this.cam.rotation.set(
      this.pitch + sprintPitch + this.stepCam.pitchX + this.cameraImpulse.rot.x,
      this.yaw + this.cameraImpulse.rot.y,
      strafeRoll + bobX * 0.08 + this.stepCam.rollZ + this.cameraImpulse.rot.z,
    );
  }

  public dispose() {
    this.stepTl?.kill();
    this.fovTween?.kill();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('mousemove', this.handleMouseMove);
  }
}
