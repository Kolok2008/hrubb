import gsap from 'gsap';
import * as THREE from 'three';
import { CriticalSpring, Spring6DOF } from '../animation/SpringSystem';
import type { KnifeSpec } from '../types';
import { buildForagingBasket, buildWipeCloth } from './HandsBuilder';
import {
  applyViewmodelDepth,
  buildKnifeModel,
  SlashTrailRibbon,
  type KnifeRig,
} from './KnifeBuilder';

export type SwingKind = 'forehand' | 'backhand' | 'overhead' | 'thrust';

export interface ActiveSwingState {
  kind: SwingKind;
  progress: number; // 0 -> 1
  active: boolean; // true during hit frames
  heavy: boolean;
  /** World-space slash direction vector (unit) */
  slashDirWorld: THREE.Vector3;
  /** World-space blade tip & heel projected into world reach for collision */
  rayOrigin: THREE.Vector3;
  rayDir: THREE.Vector3;
  swingSpeed: number;
  damageMultiplier: number;
  forceMultiplier: number;
}

interface PoseChannel {
  px: number;
  py: number;
  pz: number;
  rx: number;
  ry: number;
  rz: number;
}

export class ViewModelController {
  public readonly root: THREE.Group;
  public readonly rightGroup: THREE.Group;
  public readonly leftGroup: THREE.Group;
  private readonly knifeMount: THREE.Group;
  public readonly basket: THREE.Group;
  public readonly contents: THREE.Group;
  private readonly wipeCloth: THREE.Mesh;
  private readonly trail: SlashTrailRibbon;
  private readonly knifeEnvMap: THREE.Texture | null;

  public knifeRig: KnifeRig | null = null;
  private knifeSpec: KnifeSpec;

  private readonly rightRest = new THREE.Vector3(0.24, -0.2, -0.38);
  private readonly leftRest = new THREE.Vector3(-0.27, -0.26, -0.52);

  // --- Analytic 6-DOF Springs (reactive camera sway, material recoil, basket pendulum) ---
  private readonly swaySpring = new Spring6DOF(13, 0.88, 14, 0.86);
  private readonly recoilSpring = new Spring6DOF(24, 0.66, 26, 0.62);
  private readonly basketSpring = new Spring6DOF(11, 0.6, 9.5, 0.52);
  private readonly runSpring = new CriticalSpring(0, 6.2);
  private readonly crouchSpring = new CriticalSpring(0, 8.5);
  private readonly gaitSpring = new CriticalSpring(0, 7.5);
  private readonly strafeSpring = new CriticalSpring(0, 8.0);

  // --- GSAP-driven authored animation channels ---
  private readonly swingPose: PoseChannel & {
    progress: number;
    strikeT: number;
    active: number;
    leftX: number;
    leftZ: number;
  } = {
    px: 0,
    py: 0,
    pz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    progress: 1,
    strikeT: 0,
    active: 0,
    leftX: 0,
    leftZ: 0,
  };

  private readonly chargePose: PoseChannel & { ratio: number } = {
    px: 0,
    py: 0,
    pz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    ratio: 0,
  };

  private readonly drawPose: PoseChannel = {
    px: 0,
    py: 0,
    pz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
  };

  private readonly wipePose = {
    knifeAmt: 0,
    clothX: 0,
    clothY: 0,
    clothZ: 0,
    clothRot: 0,
    active: 0,
  };

  private swingTl: gsap.core.Timeline | null = null;
  private chargeTween: gsap.core.Tween | null = null;
  private drawTl: gsap.core.Timeline | null = null;
  private wipeTl: gsap.core.Timeline | null = null;

  // Motion & combat state
  private t = 0;
  private swingKind: SwingKind = 'forehand';
  private swingHeavy = false;
  private comboStep = 0;
  private comboWindow = 0;
  private charging = false;
  private chargeStartTime = 0;
  private swingHitThisArc = false;
  private trailWasActive = false;
  private dirtLevel = 0;
  private bloodLevel = 0;

  // Pre-allocated scratch vectors (zero GC in tick)
  private readonly _tipWorld = new THREE.Vector3();
  private readonly _heelWorld = new THREE.Vector3();
  private readonly _camFwd = new THREE.Vector3();
  private readonly _camRight = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _slashDir = new THREE.Vector3();
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3();

  constructor(
    camera: THREE.Camera,
    scene: THREE.Scene,
    initialKnife: KnifeSpec,
    knifeEnvMap: THREE.Texture | null = null,
  ) {
    this.knifeSpec = initialKnife;
    this.knifeEnvMap = knifeEnvMap;
    this.root = new THREE.Group();
    camera.add(this.root);

    // Right side: pure forged knife (no hands)
    this.rightGroup = new THREE.Group();
    this.knifeMount = new THREE.Group();
    this.rightGroup.add(this.knifeMount);
    this.root.add(this.rightGroup);

    // Left side: woven foraging basket + folded checkered wipe cloth (no hands)
    this.leftGroup = new THREE.Group();
    const basketBuilt = buildForagingBasket();
    this.basket = basketBuilt.group;
    this.contents = basketBuilt.contents;
    this.basket.position.set(0, -0.18, 0);
    this.leftGroup.add(this.basket);

    this.wipeCloth = buildWipeCloth();
    this.wipeCloth.position.set(0.02, 0.04, -0.02);
    this.leftGroup.add(this.wipeCloth);

    this.root.add(this.leftGroup);

    this.trail = new SlashTrailRibbon(scene);
    this.mountKnifeImmediate(initialKnife);

    this.root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh;
        m.castShadow = false;
        m.receiveShadow = false;
        m.frustumCulled = false;
        m.renderOrder = 10;
      }
    });
  }

  private mountKnifeImmediate(spec: KnifeSpec) {
    this.knifeSpec = spec;
    if (this.knifeRig) {
      this.knifeMount.remove(this.knifeRig.group);
    }
    const rig = buildKnifeModel(spec.look, true, this.knifeEnvMap);
    rig.group.rotation.order = 'XYZ';
    rig.group.rotation.set(-0.98, Math.PI / 2 - 0.18, 0.14);
    rig.group.position.set(0, -0.045, 0.045);
    rig.group.scale.setScalar(1.25);
    rig.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.renderOrder = 10;
        obj.frustumCulled = false;
      }
    });
    this.knifeMount.add(rig.group);
    this.knifeRig = rig;
    this.knifeRig.setStain(this.dirtLevel, this.bloodLevel);
  }

  /**
   * Switches the active knife with a smooth GSAP holster -> swap -> draw choreography.
   */
  public setKnife(spec: KnifeSpec, animate = true) {
    this.cancelCharge();
    this.drawTl?.kill();
    if (!animate) {
      this.mountKnifeImmediate(spec);
      Object.assign(this.drawPose, { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 });
      return;
    }

    this.drawTl = gsap.timeline();
    this.drawTl
      .to(this.drawPose, {
        py: -0.24,
        pz: 0.1,
        rx: -0.55,
        rz: -0.35,
        duration: 0.14,
        ease: 'power2.in',
      })
      .call(() => {
        this.mountKnifeImmediate(spec);
        this.drawPose.rx = 0.42;
        this.drawPose.ry = -0.35;
        this.drawPose.rz = 0.35;
      })
      .to(this.drawPose, {
        px: 0,
        py: 0,
        pz: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        duration: 0.36,
        ease: 'back.out(1.35)',
      });
  }

  private paused = false;

  public setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.swingTl?.pause();
      this.chargeTween?.pause();
      this.drawTl?.pause();
      this.wipeTl?.pause();
    } else {
      if (this.swingTl?.paused()) this.swingTl.resume();
      if (this.chargeTween?.paused()) this.chargeTween.resume();
      if (this.drawTl?.paused()) this.drawTl.resume();
      if (this.wipeTl?.paused()) this.wipeTl.resume();
    }
  }

  public setStain(dirt: number, blood?: number) {
    this.dirtLevel = dirt;
    if (blood !== undefined) this.bloodLevel = blood;
    this.knifeRig?.setStain(this.dirtLevel, this.bloodLevel);
  }

  public addBlood(amount: number) {
    this.bloodLevel = Math.min(1, this.bloodLevel + amount);
    this.knifeRig?.setStain(this.dirtLevel, this.bloodLevel);
  }

  public getChargeRatio(): number {
    return this.chargePose.ratio;
  }

  public getComboStep(): number {
    return this.comboStep;
  }

  public isSwinging(): boolean {
    return this.swingPose.progress < 0.995;
  }

  public hasHitCurrentSwing(): boolean {
    return this.swingHitThisArc;
  }

  public markSwingHit() {
    this.swingHitThisArc = true;
  }

  public onLookDelta(dx: number, dy: number) {
    const cx = THREE.MathUtils.clamp(-dx * 0.0012, -0.14, 0.14);
    const cy = THREE.MathUtils.clamp(dy * 0.0012, -0.14, 0.14);
    this.swaySpring.impulsePos(cx, cy, 0);
    this.swaySpring.impulseRot(-cy * 1.8, cx * 2.2, -cx * 1.5);
    this.basketSpring.impulseRot(0, 0, -cx * 3.8);
  }

  /**
   * Synchronized weight transfer on GSAP footstep heel strike for basket & viewmodel grounding.
   */
  public onFootstepDip(intensity: number, foot: -1 | 1) {
    const w = THREE.MathUtils.clamp(intensity, 0, 1.5);
    this.basketSpring.impulsePos(0, -0.042 * w, 0.008 * w);
    this.basketSpring.impulseRot(0.08 * w, 0, foot * 0.24 * w);
    this.swaySpring.impulsePos(0, -0.012 * w, 0);
  }

  public beginCharge() {
    if (this.wipePose.active > 0.05 || this.swingPose.progress < 0.72) return;
    this.charging = true;
    this.chargeStartTime = this.t;
    this.chargeTween?.kill();
    this.chargeTween = gsap.to(this.chargePose, {
      ratio: 1,
      px: 0.095,
      py: 0.055,
      pz: 0.145,
      rx: 0.4,
      ry: -0.28,
      rz: 0.34,
      duration: 0.44,
      delay: 0.1,
      ease: 'power2.out',
    });
  }

  private cancelCharge() {
    this.charging = false;
    this.chargeTween?.kill();
    this.chargeTween = gsap.to(this.chargePose, {
      ratio: 0,
      px: 0,
      py: 0,
      pz: 0,
      rx: 0,
      ry: 0,
      rz: 0,
      duration: 0.14,
      ease: 'power2.out',
    });
  }

  /**
   * Launches a multi-phase GSAP timeline for combo slashes (forehand, backhand, overhead)
   * or heavy charged thrusts/cleaves with crisp anticipation, explosive cut, and fluid recovery.
   */
  public releaseSwing(forceHeavy = false): { started: boolean; heavy: boolean; kind: SwingKind } {
    const wasCharging = this.charging;
    const heldTime = wasCharging ? this.t - this.chargeStartTime : 0;
    this.cancelCharge();

    if (this.wipePose.active > 0.05) return { started: false, heavy: false, kind: this.swingKind };
    if (this.swingPose.progress < 0.64) return { started: false, heavy: false, kind: this.swingKind };

    const isHeavy = forceHeavy || (wasCharging && heldTime >= 0.32);
    const speedScale = Math.max(0.75, this.knifeSpec.speed || 1);

    if (isHeavy) {
      this.swingKind = Math.random() < 0.55 ? 'thrust' : 'overhead';
      this.comboStep = 0;
      this.comboWindow = 0;
    } else {
      const sequence: SwingKind[] = ['forehand', 'backhand', 'overhead'];
      this.swingKind = sequence[this.comboStep % sequence.length];
      this.comboStep = (this.comboStep + 1) % 3;
      this.comboWindow = 0.8;
    }

    this.swingHeavy = isHeavy;
    this.swingHitThisArc = false;
    this.trailWasActive = false;

    this.swingTl?.kill();
    this.swingPose.progress = 0;
    this.swingPose.strikeT = 0;
    this.swingPose.active = 0;

    const invS = 1 / speedScale;
    const tl = gsap.timeline({
      onComplete: () => {
        this.swingPose.progress = 1;
        this.swingPose.active = 0;
      },
    });

    if (this.swingKind === 'forehand') {
      const tWind = 0.08 * invS;
      const tCut = 0.12 * invS;
      const tRec = 0.19 * invS;
      tl.to(this.swingPose, {
        px: 0.14,
        py: 0.11,
        pz: 0.06,
        rx: 0.36,
        ry: -0.52,
        rz: -0.44,
        progress: 0.22,
        duration: tWind,
        ease: 'power2.out',
      })
        .set(this.swingPose, { active: 1 })
        .to(this.swingPose, {
          px: -0.34,
          py: -0.14,
          pz: -0.22,
          rx: -0.44,
          ry: 1.52,
          rz: 1.15,
          leftX: -0.045,
          leftZ: 0.055,
          strikeT: 1,
          progress: 0.58,
          duration: tCut,
          ease: 'power4.out',
        })
        .set(this.swingPose, { active: 0 })
        .to(this.swingPose, {
          px: 0,
          py: 0,
          pz: 0,
          rx: 0,
          ry: 0,
          rz: 0,
          leftX: 0,
          leftZ: 0,
          progress: 1,
          duration: tRec,
          ease: 'power3.inOut',
        });
    } else if (this.swingKind === 'backhand') {
      const tWind = 0.08 * invS;
      const tCut = 0.12 * invS;
      const tRec = 0.18 * invS;
      tl.to(this.swingPose, {
        px: -0.28,
        py: -0.09,
        pz: 0.05,
        rx: -0.22,
        ry: 1.12,
        rz: 1.18,
        leftX: -0.055,
        leftZ: 0.065,
        progress: 0.22,
        duration: tWind,
        ease: 'power2.out',
      })
        .set(this.swingPose, { active: 1 })
        .to(this.swingPose, {
          px: 0.18,
          py: 0.12,
          pz: -0.2,
          rx: 0.34,
          ry: -0.82,
          rz: -0.72,
          leftX: 0.02,
          leftZ: 0.02,
          strikeT: 1,
          progress: 0.58,
          duration: tCut,
          ease: 'power4.out',
        })
        .set(this.swingPose, { active: 0 })
        .to(this.swingPose, {
          px: 0,
          py: 0,
          pz: 0,
          rx: 0,
          ry: 0,
          rz: 0,
          leftX: 0,
          leftZ: 0,
          progress: 1,
          duration: tRec,
          ease: 'power3.inOut',
        });
    } else if (this.swingKind === 'overhead') {
      const scale = isHeavy ? 1.18 : 1.0;
      const tWind = 0.11 * invS * scale;
      const tCut = 0.12 * invS;
      const tRec = 0.22 * invS * scale;
      tl.to(this.swingPose, {
        px: -0.06,
        py: 0.25,
        pz: 0.09,
        rx: 0.94,
        ry: 0.22,
        rz: 0.18,
        progress: 0.24,
        duration: tWind,
        ease: 'power2.out',
      })
        .set(this.swingPose, { active: 1 })
        .to(this.swingPose, {
          px: -0.07,
          py: -0.22,
          pz: -0.27,
          rx: -1.24,
          ry: 0.26,
          rz: 0.2,
          leftZ: 0.075,
          strikeT: 1,
          progress: 0.56,
          duration: tCut,
          ease: 'power4.out',
        })
        .set(this.swingPose, { active: 0 })
        .to(this.swingPose, {
          px: 0,
          py: 0,
          pz: 0,
          rx: 0,
          ry: 0,
          rz: 0,
          leftZ: 0,
          progress: 1,
          duration: tRec,
          ease: 'power3.inOut',
        });
    } else {
      // Heavy Forward Thrust / Lunge stab
      const tWind = 0.1 * invS;
      const tCut = 0.11 * invS;
      const tRec = 0.24 * invS;
      tl.to(this.swingPose, {
        px: -0.05,
        py: -0.03,
        pz: 0.17,
        rx: -0.14,
        ry: 0.28,
        rz: 0.52,
        progress: 0.22,
        duration: tWind,
        ease: 'power2.out',
      })
        .set(this.swingPose, { active: 1 })
        .to(this.swingPose, {
          px: -0.1,
          py: 0.02,
          pz: -0.39,
          rx: -0.22,
          ry: 0.36,
          rz: 0.68,
          leftZ: 0.095,
          strikeT: 1,
          progress: 0.56,
          duration: tCut,
          ease: 'expo.out',
        })
        .set(this.swingPose, { active: 0 })
        .to(this.swingPose, {
          px: 0,
          py: 0,
          pz: 0,
          rx: 0,
          ry: 0,
          rz: 0,
          leftZ: 0,
          progress: 1,
          duration: tRec,
          ease: 'power3.inOut',
        });
    }

    this.swingTl = tl;
    return { started: true, heavy: isHeavy, kind: this.swingKind };
  }

  /**
   * Applies realistic elastic 6-DOF spring recoil / deflection on material strike.
   */
  public triggerImpactRecoil(
    material: 'hard' | 'wood' | 'soft' | 'flesh',
    intensity = 1,
  ) {
    if (material === 'hard') {
      this.recoilSpring.impulsePos(0.42 * intensity, 0.34 * intensity, 0.52 * intensity);
      this.recoilSpring.impulseRot(2.8 * intensity, 1.4 * intensity, -2.6 * intensity);
    } else if (material === 'wood') {
      this.recoilSpring.impulsePos(0.24 * intensity, 0.16 * intensity, 0.34 * intensity);
      this.recoilSpring.impulseRot(1.8 * intensity, 0.7 * intensity, -1.3 * intensity);
    } else if (material === 'flesh') {
      this.recoilSpring.impulsePos(0.14 * intensity, -0.06 * intensity, 0.22 * intensity);
      this.recoilSpring.impulseRot(0.9 * intensity, -0.4 * intensity, 0.6 * intensity);
    } else {
      this.recoilSpring.impulsePos(0.05 * intensity, -0.03 * intensity, 0.08 * intensity);
    }
  }

  /**
   * Choreographed GSAP timeline for wiping mud/blood off the blade with the checkered cloth (R).
   */
  public triggerWipe() {
    this.cancelCharge();
    this.wipeTl?.kill();

    const tl = gsap.timeline({
      onComplete: () => {
        this.wipePose.active = 0;
        this.wipeCloth.visible = false;
        this.basket.visible = true;
      },
    });

    this.wipePose.active = 1;
    this.wipeCloth.visible = true;
    this.basket.visible = false;

    tl.to(this.wipePose, {
      knifeAmt: 1,
      clothX: 0.33,
      clothY: 0.13,
      clothZ: 0.11,
      clothRot: 0.25,
      duration: 0.24,
      ease: 'power2.out',
    })
      .to(this.wipePose, {
        clothX: 0.4,
        clothZ: 0.05,
        clothRot: -0.35,
        duration: 0.18,
        ease: 'sine.inOut',
        onStart: () => {
          this.dirtLevel *= 0.4;
          this.bloodLevel *= 0.4;
          this.knifeRig?.setStain(this.dirtLevel, this.bloodLevel);
        },
      })
      .to(this.wipePose, {
        clothX: 0.31,
        clothZ: 0.13,
        clothRot: 0.32,
        duration: 0.18,
        ease: 'sine.inOut',
      })
      .to(this.wipePose, {
        clothX: 0.41,
        clothZ: 0.04,
        clothRot: -0.3,
        duration: 0.18,
        ease: 'sine.inOut',
        onStart: () => {
          this.dirtLevel = 0;
          this.bloodLevel = 0;
          this.knifeRig?.setStain(0, 0);
        },
      })
      .to(this.wipePose, {
        knifeAmt: 0,
        clothX: 0,
        clothY: 0,
        clothZ: 0,
        clothRot: 0,
        duration: 0.26,
        ease: 'power2.inOut',
      });

    this.wipeTl = tl;
  }

  public addToBasket(mushroomObj: THREE.Object3D) {
    const clone = mushroomObj.clone(true);
    clone.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        const m = c as THREE.Mesh;
        const mat = Array.isArray(m.material)
          ? m.material.map((mm) => applyViewmodelDepth(mm.clone()))
          : applyViewmodelDepth(m.material.clone());
        m.material = mat;
        m.renderOrder = 11;
        m.castShadow = false;
        m.frustumCulled = false;
      }
    });
    const idx = this.contents.children.length;
    const angle = idx * 2.39996;
    const rad = 0.03 + 0.11 * Math.sqrt((idx % 14) / 14);
    clone.position.set(Math.cos(angle) * rad, Math.floor(idx / 14) * 0.035, Math.sin(angle) * rad);
    clone.rotation.set(
      (Math.random() - 0.5) * 1.4,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * 1.4,
    );
    const sz = 0.62 / Math.max(0.6, (mushroomObj.userData.size as number) || 1);
    clone.scale.setScalar(Math.min(0.85, sz));
    this.contents.add(clone);

    // Tactile spring bounce when mushroom drops into the woven basket
    this.basketSpring.impulsePos(0, -0.18, 0.03);
    this.basketSpring.impulseRot(0.35, 0, 1.9);
  }

  public clearBasket() {
    while (this.contents.children.length > 0) {
      this.contents.remove(this.contents.children[0]);
    }
  }

  public update(
    dt: number,
    camera: THREE.Camera,
    moveSpeed: number,
    crouch: number,
    stepPhase: number,
    running: boolean,
    exhausted: boolean,
    strafeInput = 0,
  ): ActiveSwingState | null {
    this.t += dt;

    if (this.comboWindow > 0) {
      this.comboWindow = Math.max(0, this.comboWindow - dt);
      if (this.comboWindow === 0) this.comboStep = 0;
    }

    // Step all analytic 6-DOF & critical springs
    const speedNorm = THREE.MathUtils.clamp((moveSpeed - 0.1) / 3.0, 0, 1);
    const gait = this.gaitSpring.step(speedNorm, dt);
    const runB = this.runSpring.step(running && moveSpeed > 2.2 ? 1 : 0, dt);
    const crouchB = this.crouchSpring.step(crouch, dt);
    const strafeB = this.strafeSpring.step(strafeInput, dt);

    this.swaySpring.step(dt);
    this.recoilSpring.step(dt);

    // Smooth C-infinity figure-8 gait bob (matches PlayerController smooth harmonics)
    const stride = stepPhase * Math.PI;
    const bobX = Math.sin(stride) * gait * THREE.MathUtils.lerp(0.009, 0.015, runB);
    const bobY = ((1 - Math.cos(stride * 2)) * 0.5 - 0.5) * gait * THREE.MathUtils.lerp(0.01, 0.016, runB);
    const breath = Math.sin(this.t * (1.55 + runB * 1.4)) * (0.0035 + runB * 0.002);
    const fatigueJitter = exhausted ? Math.sin(this.t * 22) * 0.0014 : 0;

    // Basket natural pendulum physics driven by stride + camera turns
    const targetBasketRoll = Math.sin(stride) * gait * THREE.MathUtils.lerp(0.06, 0.14, runB) - strafeB * 0.08;
    const targetBasketPitch = Math.cos(stride * 2) * gait * runB * 0.06;
    this.basketSpring.step(dt, 0, 0, 0, targetBasketPitch, 0, targetBasketRoll);

    // Build active world-space swing collision packet during GSAP hit frames
    let activeSwing: ActiveSwingState | null = null;
    if (this.swingPose.progress < 0.995) {
      camera.getWorldDirection(this._camFwd).normalize();
      this._camRight.crossVectors(this._camFwd, camera.up).normalize();
      this._camUp.crossVectors(this._camRight, this._camFwd).normalize();

      if (this.swingKind === 'forehand') {
        this._slashDir
          .copy(this._camRight)
          .multiplyScalar(-0.85)
          .addScaledVector(this._camUp, -0.45)
          .addScaledVector(this._camFwd, 0.35)
          .normalize();
      } else if (this.swingKind === 'backhand') {
        this._slashDir
          .copy(this._camRight)
          .multiplyScalar(0.85)
          .addScaledVector(this._camUp, 0.38)
          .addScaledVector(this._camFwd, 0.35)
          .normalize();
      } else if (this.swingKind === 'overhead') {
        this._slashDir
          .copy(this._camUp)
          .multiplyScalar(-0.85)
          .addScaledVector(this._camFwd, 0.52)
          .normalize();
      } else {
        this._slashDir.copy(this._camFwd);
      }

      const st = this.swingPose.strikeT;
      const arcOffset =
        this.swingKind === 'forehand'
          ? THREE.MathUtils.lerp(0.28, -0.28, st)
          : this.swingKind === 'backhand'
            ? THREE.MathUtils.lerp(-0.28, 0.28, st)
            : 0;
      const vertOffset =
        this.swingKind === 'overhead'
          ? THREE.MathUtils.lerp(0.25, -0.22, st)
          : this.swingKind === 'forehand'
            ? THREE.MathUtils.lerp(0.12, -0.1, st)
            : 0;

      this._rayOrigin.copy(camera.position);
      this._rayDir
        .copy(this._camFwd)
        .addScaledVector(this._camRight, arcOffset)
        .addScaledVector(this._camUp, vertOffset)
        .normalize();

      activeSwing = {
        kind: this.swingKind,
        progress: this.swingPose.progress,
        active: this.swingPose.active > 0.5,
        heavy: this.swingHeavy,
        slashDirWorld: this._slashDir,
        rayOrigin: this._rayOrigin,
        rayDir: this._rayDir,
        swingSpeed: this.swingHeavy ? 1.45 : 1.0,
        damageMultiplier: this.swingHeavy ? 1.65 : this.swingKind === 'overhead' ? 1.3 : 1.0,
        forceMultiplier: this.swingHeavy ? 1.7 : this.swingKind === 'overhead' ? 1.35 : 1.0,
      };
    }

    // --- Compose Layered Pose Sum for Right Knife ---
    const wipeAmt = this.wipePose.knifeAmt;
    const swayX = THREE.MathUtils.clamp(this.swaySpring.pos.x, -0.055, 0.055);
    const swayY = THREE.MathUtils.clamp(this.swaySpring.pos.y, -0.045, 0.045);

    this.rightGroup.position.set(
      this.rightRest.x +
        bobX +
        swayX +
        this.swingPose.px +
        this.chargePose.px +
        this.drawPose.px +
        this.recoilSpring.pos.x -
        wipeAmt * 0.16 -
        runB * 0.045 -
        strafeB * 0.016 +
        fatigueJitter,
      this.rightRest.y +
        bobY +
        breath +
        swayY +
        this.swingPose.py +
        this.chargePose.py +
        this.drawPose.py +
        this.recoilSpring.pos.y +
        wipeAmt * 0.05 -
        runB * 0.055 -
        crouchB * 0.022,
      this.rightRest.z +
        bobX * 0.35 +
        this.swingPose.pz +
        this.chargePose.pz +
        this.drawPose.pz +
        this.recoilSpring.pos.z -
        wipeAmt * 0.04 +
        runB * 0.035,
    );

    this.rightGroup.rotation.set(
      0.06 +
        this.swingPose.rx +
        this.chargePose.rx +
        this.drawPose.rx +
        this.recoilSpring.rot.x +
        this.swaySpring.rot.x -
        runB * 0.28 -
        wipeAmt * 0.35,
      -0.14 +
        this.swingPose.ry +
        this.chargePose.ry +
        this.drawPose.ry +
        this.recoilSpring.rot.y +
        this.swaySpring.rot.y +
        runB * 0.28 +
        wipeAmt * 0.72,
      -0.08 +
        this.swingPose.rz +
        this.chargePose.rz +
        this.drawPose.rz +
        this.recoilSpring.rot.z +
        this.swaySpring.rot.z +
        runB * 0.24 -
        strafeB * 0.08 +
        wipeAmt * 1.15,
    );

    // --- Compose Layered Pose Sum for Left Basket & Wipe Cloth ---
    this.leftGroup.position.set(
      this.leftRest.x -
        bobX * 0.65 +
        swayX * 0.7 +
        this.swingPose.leftX +
        this.wipePose.clothX +
        this.basketSpring.pos.x -
        strafeB * 0.012,
      this.leftRest.y +
        bobY * 0.7 +
        breath +
        swayY * 0.7 +
        this.wipePose.clothY +
        this.basketSpring.pos.y -
        crouchB * 0.038 -
        runB * 0.045,
      this.leftRest.z -
        bobX * 0.35 +
        this.swingPose.leftZ +
        this.wipePose.clothZ +
        this.basketSpring.pos.z,
    );

    this.leftGroup.rotation.set(0.16 - bobX * 0.8, -0.45, 0.08 - strafeB * 0.06);

    this.basket.rotation.set(
      this.basketSpring.rot.x,
      0.55,
      this.basketSpring.rot.z + Math.sin(this.t * 1.9) * 0.012,
    );

    if (this.wipeCloth.visible) {
      this.wipeCloth.rotation.set(0.4 + this.wipePose.clothRot, 0.3, -0.45 + this.wipePose.clothRot * 0.8);
    }

    // --- Update World-Space Slash Trail Ribbon ---
    if (this.knifeRig && this.root.visible) {
      this.root.updateMatrixWorld(true);
      const localTip = this.knifeRig.tipMarker.getWorldPosition(this._tipWorld);
      const localHeel = this.knifeRig.heelMarker.getWorldPosition(this._heelWorld);

      if (activeSwing && activeSwing.active) {
        if (!this.trailWasActive) {
          this.trail.begin(localTip, localHeel, activeSwing.heavy);
          this.trailWasActive = true;
        }
        this.trail.update(dt, localTip, localHeel);
      } else {
        if (this.trailWasActive) {
          this.trail.end();
          this.trailWasActive = false;
        }
        this.trail.update(dt);
      }
    } else {
      this.trail.end();
      this.trail.update(dt);
    }

    return activeSwing;
  }

  public dispose() {
    this.swingTl?.kill();
    this.chargeTween?.kill();
    this.drawTl?.kill();
    this.wipeTl?.kill();
    this.trail.dispose();
  }
}
