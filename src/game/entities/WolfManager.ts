import gsap from 'gsap';
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { CriticalSpring } from '../animation/SpringSystem';
import type { AudioEngine } from '../audio/AudioEngine';
import type { WorldCollider } from '../types';
import { groundHeightAt, groundNormalAt, trailDistance, WORLD_HALF } from '../world/terrain';

function cloneSkinned(source: THREE.Object3D): THREE.Object3D {
  const sourceLookup = new Map<THREE.Object3D, THREE.Object3D>();
  const cloneLookup = new Map<THREE.Object3D, THREE.Object3D>();
  const clone = source.clone();

  const walkPair = (a: THREE.Object3D, b: THREE.Object3D) => {
    sourceLookup.set(b, a);
    cloneLookup.set(a, b);
    for (let i = 0; i < a.children.length; i++) {
      walkPair(a.children[i], b.children[i]);
    }
  };
  walkPair(source, clone);

  clone.traverse((node) => {
    if (!(node as THREE.SkinnedMesh).isSkinnedMesh) return;
    const skinned = node as THREE.SkinnedMesh;
    const orig = sourceLookup.get(node) as THREE.SkinnedMesh;
    const bones = orig.skeleton.bones;
    skinned.skeleton = orig.skeleton.clone();
    skinned.bindMatrix.copy(orig.bindMatrix);
    skinned.skeleton.bones = bones.map((b) => cloneLookup.get(b) as THREE.Bone);
    skinned.bind(skinned.skeleton, skinned.bindMatrix);
  });
  return clone;
}

interface WolfUnit {
  obj: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  walk: THREE.AnimationAction;
  idle: THREE.AnimationAction;
  mats: THREE.MeshStandardMaterial[];
  hp: number;
  state: 'wander' | 'chase' | 'investigate';
  t: number;
  moving: boolean;
  heading: number;
  atk: number;
  flash: number;
  dead: number;
  knock: THREE.Vector3;
  growled: boolean;
  investigatePos: THREE.Vector3;
  investigateTimer: number;
  // Smooth kinematic springs & GSAP authored motion channels
  speedSpring: CriticalSpring;
  yawSpring: CriticalSpring;
  pitchSpring: CriticalSpring;
  bankSpring: CriticalSpring;
  walkWeightSpring: CriticalSpring;
  animFx: {
    lungeBoost: number;
    lungePitch: number;
    hopY: number;
    fallRoll: number;
    sinkY: number;
  };
  activeTweens: gsap.core.Animation[];
}

export interface WolfHitResult {
  status: 'hit' | 'kill';
  point: THREE.Vector3;
}

export class WolfManager {
  public readonly list: WolfUnit[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly slopeNormal = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly gltf: GLTF,
    private readonly colliders: WorldCollider[],
    private readonly audio: AudioEngine,
  ) {}

  private killUnitTweens(w: WolfUnit) {
    for (const tw of w.activeTweens) tw.kill();
    w.activeTweens.length = 0;
  }

  public spawn(px: number, pz: number, isNight: boolean) {
    for (let tries = 0; tries < 30; tries++) {
      const a = Math.random() * Math.PI * 2;
      const dist = 48 + Math.random() * 40;
      const x = px + Math.cos(a) * dist;
      const z = pz + Math.sin(a) * dist;
      if (Math.abs(x) > WORLD_HALF - 15 || Math.abs(z) > WORLD_HALF - 15) continue;
      if (!isNight && trailDistance(x, z) < 22) continue;

      const obj = cloneSkinned(this.gltf.scene);
      obj.scale.setScalar(0.2);
      obj.rotation.order = 'YXZ';
      const mats: THREE.MeshStandardMaterial[] = [];
      obj.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          const m = c as THREE.Mesh;
          m.castShadow = true;
          m.frustumCulled = false;
          const clonedMat = (m.material as THREE.MeshStandardMaterial).clone();
          clonedMat.metalness = 0;
          clonedMat.roughness = 0.9;
          clonedMat.color.set('#7a6a58');
          m.material = clonedMat;
          mats.push(clonedMat);
        }
      });

      const gy = groundHeightAt(x, z);
      const initHeading = Math.random() * Math.PI * 2;
      obj.position.set(x, gy, z);
      obj.rotation.y = initHeading;
      this.scene.add(obj);

      // Continuous weight-blended locomotion blend tree (Idle <-> Walking never pop or reset!)
      const mixer = new THREE.AnimationMixer(obj);
      const findClip = (part: string) =>
        this.gltf.animations.find((c) => c.name.includes(part)) || this.gltf.animations[0];
      const walk = mixer.clipAction(findClip('Walking'));
      const idle = mixer.clipAction(findClip('Idle'));
      idle.enabled = true;
      walk.enabled = true;
      idle.setEffectiveWeight(1);
      walk.setEffectiveWeight(0);
      idle.play();
      walk.play();

      this.list.push({
        obj,
        mixer,
        walk,
        idle,
        mats,
        hp: 3.2,
        state: 'wander',
        t: 0,
        moving: false,
        heading: initHeading,
        atk: 0,
        flash: 0,
        dead: 0,
        knock: new THREE.Vector3(),
        growled: false,
        investigatePos: new THREE.Vector3(),
        investigateTimer: 0,
        speedSpring: new CriticalSpring(0, 6.2),
        yawSpring: new CriticalSpring(initHeading, 8.5),
        pitchSpring: new CriticalSpring(0, 8.0),
        bankSpring: new CriticalSpring(0, 7.5),
        walkWeightSpring: new CriticalSpring(0, 7.0),
        animFx: {
          lungeBoost: 0,
          lungePitch: 0,
          hopY: 0,
          fallRoll: 0,
          sinkY: 0,
        },
        activeTweens: [],
      });
      return;
    }
  }

  public distract(x: number, z: number, radius = 28): boolean {
    let distractedAny = false;
    for (const w of this.list) {
      if (w.dead > 0) continue;
      const dist = Math.hypot(w.obj.position.x - x, w.obj.position.z - z);
      if (dist > radius) continue;
      w.state = 'investigate';
      w.investigatePos.set(x, 0, z);
      w.investigateTimer = 6.5;
      w.growled = false;
      distractedAny = true;
    }
    return distractedAny;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    nightFactor: number,
    onPath: boolean,
    wolfHuntActive = false,
    mistFactor = 0,
  ): number {
    let damageDealt = 0;
    const maxWolves = nightFactor > 0.5 || wolfHuntActive ? 4 : 2;
    if (this.list.filter((w) => !w.dead).length < maxWolves && Math.random() < dt * (wolfHuntActive ? 0.34 : 0.2)) {
      this.spawn(playerPos.x, playerPos.z, nightFactor > 0.5 || wolfHuntActive);
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const w = this.list[i];
      const o = w.obj;
      w.mixer.update(dt);
      w.flash = Math.max(0, w.flash - dt * 4);
      for (const mat of w.mats) mat.emissive.setRGB(w.flash * 0.85, 0, 0);

      if (w.dead > 0) {
        w.dead += dt;
        // Apply GSAP-eased death collapse & gentle ground settle
        w.knock.multiplyScalar(Math.exp(-dt * 7));
        o.position.x += w.knock.x * dt;
        o.position.z += w.knock.z * dt;
        o.position.y = groundHeightAt(o.position.x, o.position.z) + w.animFx.sinkY;
        o.rotation.z = w.animFx.fallRoll;
        if (w.dead > 9) {
          this.killUnitTweens(w);
          this.scene.remove(o);
          this.list.splice(i, 1);
        }
        continue;
      }

      const dx = playerPos.x - o.position.x;
      const dz = playerPos.z - o.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 140) {
        this.killUnitTweens(w);
        this.scene.remove(o);
        this.list.splice(i, 1);
        continue;
      }

      const aggroRange = (nightFactor > 0.5 ? 26 : 16) + (wolfHuntActive ? 4 : 0) + mistFactor * 3;
      const canAggro = nightFactor > 0.5 || wolfHuntActive ? dist < aggroRange : dist < aggroRange && !onPath;
      if (canAggro && w.state === 'wander') {
        w.state = 'chase';
        if (!w.growled) {
          this.audio.growl();
          w.growled = true;
        }
      }
      if (w.state === 'investigate') {
        w.investigateTimer -= dt;
        if (dist < 4.0) {
          w.state = 'chase';
          if (!w.growled) {
            this.audio.growl();
            w.growled = true;
          }
        } else if (w.investigateTimer <= 0) {
          w.state = 'wander';
        }
      }
      if (w.state === 'chase' && (dist > 40 || (onPath && nightFactor < 0.5 && !wolfHuntActive && dist > 6))) {
        w.state = 'wander';
        w.growled = false;
      }

      let targetSpd = 0;
      if (w.state === 'wander') {
        w.t -= dt;
        if (w.t < 0) {
          w.t = 2.4 + Math.random() * 4;
          w.heading += (Math.random() - 0.5) * 1.9;
          w.moving = Math.random() < 0.62;
        }
        targetSpd = w.moving ? 1.35 : 0;
      } else if (w.state === 'investigate') {
        const ix = w.investigatePos.x - o.position.x;
        const iz = w.investigatePos.z - o.position.z;
        const iDist = Math.hypot(ix, iz);
        if (iDist > 1.2) {
          w.heading = Math.atan2(ix, iz);
          targetSpd = 4.2;
        } else {
          targetSpd = 0;
        }
      } else {
        w.heading = Math.atan2(dx, dz);
        targetSpd = dist > 1.5 ? (wolfHuntActive ? 6.25 : 5.9) : 0;
        w.atk -= dt;
        if (dist < 1.95 && w.atk <= 0) {
          w.atk = 1.35;
          damageDealt += 14;
          this.audio.bite();

          // GSAP-authored attack lunge arc (springy leap + subtle pitch + smooth landing)
          const lungeTl = gsap.timeline();
          lungeTl
            .to(w.animFx, {
              lungeBoost: 3.4,
              lungePitch: -0.18,
              hopY: 0.2,
              duration: 0.14,
              ease: 'power2.out',
            })
            .to(w.animFx, {
              lungeBoost: 0,
              lungePitch: 0.06,
              hopY: 0,
              duration: 0.22,
              ease: 'power2.inOut',
            })
            .to(w.animFx, {
              lungePitch: 0,
              duration: 0.14,
              ease: 'sine.out',
            });
          w.activeTweens.push(lungeTl);
        }
      }

      // Critically-damped speed & yaw smoothing (zero instant snaps)
      const smoothSpd = w.speedSpring.step(targetSpd + w.animFx.lungeBoost, dt);

      // Unwrap target heading cleanly around current yawSpring value for shortest-arc rotation
      const currentYaw = w.yawSpring.value;
      const shortestDelta = Math.atan2(Math.sin(w.heading - currentYaw), Math.cos(w.heading - currentYaw));
      const smoothYaw = w.yawSpring.step(currentYaw + shortestDelta, dt);

      const vx = Math.sin(smoothYaw) * smoothSpd + w.knock.x;
      const vz = Math.cos(smoothYaw) * smoothSpd + w.knock.z;
      w.knock.multiplyScalar(Math.exp(-dt * 6));
      o.position.x += vx * dt;
      o.position.z += vz * dt;

      for (const col of this.colliders) {
        if (col.box) continue;
        const cx = o.position.x - col.x;
        const cz = o.position.z - col.z;
        const rr = col.r + 0.4;
        const d2 = cx * cx + cz * cz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const k = rr / Math.sqrt(d2);
          o.position.x = col.x + cx * k;
          o.position.z = col.z + cz * k;
          if (w.state === 'wander') w.heading += 1.4;
        }
      }

      // Terrain slope pitch alignment + subtle chase turn banking
      const gy = groundHeightAt(o.position.x, o.position.z);
      o.position.y = gy + w.animFx.hopY;
      groundNormalAt(o.position.x, o.position.z, this.slopeNormal);
      const fwdDotSlope =
        Math.sin(smoothYaw) * this.slopeNormal.x + Math.cos(smoothYaw) * this.slopeNormal.z;
      const targetSlopePitch = THREE.MathUtils.clamp(fwdDotSlope * 0.85, -0.4, 0.4);
      const smoothPitch = w.pitchSpring.step(targetSlopePitch, dt);

      const turnRate = THREE.MathUtils.clamp(w.yawSpring.velocity, -4, 4);
      const targetBank = -turnRate * THREE.MathUtils.clamp(smoothSpd / 6, 0, 1) * 0.065;
      const smoothBank = w.bankSpring.step(targetBank, dt);

      o.rotation.set(smoothPitch + w.animFx.lungePitch, smoothYaw, smoothBank);

      // Continuous Locomotion Blend-Tree: smooth Idle <-> Walking weight & stride-locked timeScale
      const desiredWalkW = THREE.MathUtils.smoothstep(smoothSpd, 0.08, 1.35);
      const walkW = w.walkWeightSpring.step(desiredWalkW, dt);
      w.walk.setEffectiveWeight(walkW);
      w.idle.setEffectiveWeight(1 - walkW);
      w.walk.setEffectiveTimeScale(THREE.MathUtils.clamp((smoothSpd / 1.35) * 0.68, 0.55, 2.85));
    }

    return damageDealt;
  }

  public hit(
    origin: THREE.Vector3,
    rayDir: THREE.Vector3,
    slashDir: THREE.Vector3,
    reach: number,
    damage: number,
    force: number,
  ): WolfHitResult | null {
    const fwdXZ = new THREE.Vector3(rayDir.x, 0, rayDir.z).normalize();
    for (const w of this.list) {
      if (w.dead > 0) continue;
      this.tmp.set(w.obj.position.x - origin.x, 0, w.obj.position.z - origin.z);
      const dist = this.tmp.length();
      if (dist > reach + 0.4) continue;
      if (this.tmp.normalize().dot(fwdXZ) < 0.5) continue;

      w.hp -= damage;
      w.flash = 1;
      const knockDir = fwdXZ.clone().addScaledVector(slashDir, 0.4).normalize();
      w.knock.copy(knockDir).multiplyScalar(Math.max(6.5, force * 1.15));
      w.state = 'chase';
      w.atk = Math.max(w.atk, 0.65);
      this.audio.yelp();

      const hitPt = w.obj.position.clone().add(new THREE.Vector3(0, 0.65, 0));
      if (w.hp <= 0) {
        w.dead = 0.001;
        this.killUnitTweens(w);
        // Smoothly fade out skeletal motion and animate physical GSAP collapse
        w.idle.fadeOut(0.28);
        w.walk.fadeOut(0.28);
        const deathTl = gsap.timeline();
        deathTl
          .to(w.animFx, {
            fallRoll: Math.PI / 2,
            duration: 0.48,
            ease: 'bounce.out',
          })
          .to(
            w.animFx,
            {
              sinkY: -0.35,
              duration: 2.8,
              ease: 'power1.in',
            },
            '+=5.4',
          );
        w.activeTweens.push(deathTl);
        return { status: 'kill', point: hitPt };
      } else {
        // Tactile GSAP hit-flinch micro-hop
        const flinch = gsap.timeline();
        flinch
          .to(w.animFx, { hopY: 0.14, lungePitch: 0.2, duration: 0.09, ease: 'power2.out' })
          .to(w.animFx, { hopY: 0, lungePitch: 0, duration: 0.22, ease: 'power2.inOut' });
        w.activeTweens.push(flinch);
      }
      return { status: 'hit', point: hitPt };
    }
    return null;
  }

  public dispose() {
    for (const w of this.list) {
      this.killUnitTweens(w);
    }
  }
}
