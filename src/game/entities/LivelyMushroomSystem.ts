import gsap from 'gsap';
import * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import type { SpeciesId, WorldCollider } from '../types';
import type { SurfaceType } from '../world/SurfaceDetector';
import { groundHeightAt, HUT_POSE, trailDistance, WORLD_HALF } from '../world/terrain';

export type LivelyState =
  | 'idle'
  | 'alert'
  | 'startled'
  | 'fleeing'
  | 'seeking_cover'
  | 'burrowing';

export interface LivelyMushroomRef {
  group: THREE.Group;
  species: SpeciesId;
  x: number;
  z: number;
  pile: THREE.Group | null;
  alive: boolean;
  lively?: boolean;
  livelyData?: LivelyAgent;
}

export interface CoverSpot {
  x: number;
  z: number;
}

export interface LivelyAgent {
  state: LivelyState;
  // Horizontal & ballistic vertical jump physics
  vx: number;
  vz: number;
  posY: number;
  vy: number;
  grounded: boolean;
  hopPause: number;
  heading: number;
  jukePhase: number;
  legPhase: number;
  // Noise alertness & 5-10s burrow choreography
  alertness: number;
  alertChirpCooldown: number;
  fleeTimer: number;
  burrowTargetTime: number;
  digParticleCooldown: number;
  coverTarget: CoverSpot | null;
  sporeCooldown: number;
  stunTimer: number;
  burrowCount: number;
  // Articulated procedural rootlet legs
  rootletsGroup: THREE.Group | null;
  rootletLegs: THREE.Group[];
  // GSAP-driven artistic squash-and-stretch / spin / rootlet reveal channels
  anim: {
    sx: number;
    sy: number;
    sz: number;
    spinY: number;
    sinkY: number;
    rootScale: number;
    wiggle: number;
  };
  tl: gsap.core.Timeline | null;
}

export interface FairyRingRecord {
  x: number;
  z: number;
  radius: number;
  discovered: boolean;
  group: THREE.Group;
  ringMat: THREE.MeshBasicMaterial;
  motes: THREE.Mesh[];
  moteAngles: number[];
}

interface SporeParticle {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  active: boolean;
}

const MAX_SPORES = 160;
const HOP_GRAVITY = -14.2;

export const SURFACE_NOISE_MULT: Record<SurfaceType, number> = {
  stone: 1.28,
  leaves: 1.22,
  wood: 1.18,
  dirt: 1.0,
  moss: 0.62,
};

/**
 * Physical & GSAP-choreographed living mushroom system:
 * - Discrete footstep acoustic noise detection (pure audio & mushroom behavior, no ground rings)
 * - Alertness build-up (idle -> alert shiver/turn/chirp -> startled)
 * - True ballistic gravity hops with GSAP takeoff stretch, landing squash, and kicking rootlet legs
 * - 5-10s chase -> active cover seeking (near trees/bushes) -> 0.85s telegraphed digging (still catchable!) -> fresh leaf pile
 * - Mystical Fairy Rings across forest clearings
 */
export class LivelyMushroomSystem {
  public readonly fairyRings: FairyRingRecord[] = [];
  private readonly fxGroup = new THREE.Group();
  private readonly ringGroup = new THREE.Group();
  private readonly spores: SporeParticle[] = [];

  private readonly sporeGeo: THREE.OctahedronGeometry;
  private readonly sporeMat: THREE.MeshBasicMaterial;
  private readonly ringMoteGeo: THREE.OctahedronGeometry;
  private readonly ringMoteMat: THREE.MeshBasicMaterial;
  private readonly rootletMat: THREE.MeshStandardMaterial;
  private readonly rootletSegGeo: THREE.CylinderGeometry;

  private paused = false;
  private elapsed = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly colliders: WorldCollider[],
    private readonly audio: AudioEngine,
  ) {
    this.scene.add(this.fxGroup);
    this.scene.add(this.ringGroup);

    this.sporeGeo = new THREE.OctahedronGeometry(0.036, 0);
    this.sporeMat = new THREE.MeshBasicMaterial({
      color: '#ffd972',
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.ringMoteGeo = new THREE.OctahedronGeometry(0.042, 0);
    this.ringMoteMat = new THREE.MeshBasicMaterial({
      color: '#ffe48c',
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.rootletMat = new THREE.MeshStandardMaterial({
      color: '#cbb289',
      roughness: 0.9,
      metalness: 0,
    });
    this.rootletSegGeo = new THREE.CylinderGeometry(0.007, 0.0025, 0.075, 5);
    this.rootletSegGeo.translate(0, -0.036, 0);

    // Zero-GC spore pool
    for (let i = 0; i < MAX_SPORES; i++) {
      const mat = this.sporeMat.clone();
      const mesh = new THREE.Mesh(this.sporeGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.fxGroup.add(mesh);
      this.spores.push({
        mesh,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        life: 1,
        active: false,
      });
    }
  }

  public isCatchableFleeing(m: LivelyMushroomRef): boolean {
    if (!m.lively || !m.livelyData || !m.alive) return false;
    const s = m.livelyData.state;
    return s === 'startled' || s === 'fleeing' || s === 'seeking_cover' || s === 'burrowing';
  }

  private buildRootlets(): { group: THREE.Group; legs: THREE.Group[] } {
    const group = new THREE.Group();
    group.name = 'livelyRootlets';
    group.position.y = 0.025;
    group.scale.setScalar(0.001); // Tucked cleanly underground while idle

    const legs: THREE.Group[] = [];
    const legCount = 6;
    for (let i = 0; i < legCount; i++) {
      const a = (i / legCount) * Math.PI * 2;
      const pivot = new THREE.Group();
      pivot.position.set(Math.cos(a) * 0.024, 0, Math.sin(a) * 0.024);
      pivot.rotation.y = -a;

      const upper = new THREE.Mesh(this.rootletSegGeo, this.rootletMat);
      upper.rotation.z = 0.48;
      pivot.add(upper);

      const foot = new THREE.Mesh(this.rootletSegGeo, this.rootletMat);
      foot.scale.set(0.85, 0.72, 0.85);
      foot.position.set(0.032, -0.056, 0);
      foot.rotation.z = -0.35;
      pivot.add(foot);

      group.add(pivot);
      legs.push(pivot);
    }
    return { group, legs };
  }

  public createAgent(rootletsGroup: THREE.Group, rootletLegs: THREE.Group[]): LivelyAgent {
    return {
      state: 'idle',
      vx: 0,
      vz: 0,
      posY: 0,
      vy: 0,
      grounded: true,
      hopPause: 0,
      heading: Math.random() * Math.PI * 2,
      jukePhase: Math.random() * Math.PI * 2,
      legPhase: Math.random() * Math.PI * 2,
      alertness: 0,
      alertChirpCooldown: 0,
      fleeTimer: 0,
      burrowTargetTime: 5 + Math.random() * 5,
      digParticleCooldown: 0,
      coverTarget: null,
      sporeCooldown: 0.25 + Math.random() * 0.4,
      stunTimer: 0,
      burrowCount: 0,
      rootletsGroup,
      rootletLegs,
      anim: {
        sx: 1,
        sy: 1,
        sz: 1,
        spinY: 0,
        sinkY: 0,
        rootScale: 0.001,
        wiggle: 0,
      },
      tl: null,
    };
  }

  public attachLivelyAura(m: LivelyMushroomRef) {
    m.lively = true;
    const { group: rootletsGroup, legs } = this.buildRootlets();
    m.group.add(rootletsGroup);
    m.livelyData = this.createAgent(rootletsGroup, legs);
  }

  public emitSpores(x: number, y: number, z: number, count: number, spread = 0.55, life = 3.8) {
    let spawned = 0;
    for (let i = 0; i < this.spores.length && spawned < count; i++) {
      const p = this.spores[i];
      if (p.active) continue;
      p.active = true;
      p.age = 0;
      p.life = life * (0.75 + Math.random() * 0.5);
      p.mesh.visible = true;
      p.mesh.position.set(
        x + (Math.random() - 0.5) * 0.22,
        y + 0.08 + Math.random() * 0.14,
        z + (Math.random() - 0.5) * 0.22,
      );
      p.mesh.scale.setScalar(0.65 + Math.random() * 0.75);
      p.vx = (Math.random() - 0.5) * spread;
      p.vy = 0.22 + Math.random() * 0.45;
      p.vz = (Math.random() - 0.5) * spread;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
      spawned++;
    }
  }

  /**
   * Called on every GSAP footstep heel impact: checks acoustic distance
   * to raise alertness on nearby lively mushrooms and startle them if loud enough.
   */
  public onFootstepNoise(
    x: number,
    z: number,
    speed: number,
    sprintBlend: number,
    crouch: number,
    surface: SurfaceType,
    mushrooms: LivelyMushroomRef[],
    playerPos: THREE.Vector3,
    callbacks: {
      onAlert?: (m: LivelyMushroomRef) => void;
      onStartled?: (m: LivelyMushroomRef) => void;
    },
    noiseMult = 1.0,
  ) {
    const surfMult = (SURFACE_NOISE_MULT[surface] ?? 1.0) * noiseMult;
    const isStealth = crouch > 0.5;
    const baseRadius = isStealth
      ? THREE.MathUtils.lerp(0.8, 1.35, THREE.MathUtils.clamp(speed / 2.2, 0, 1))
      : THREE.MathUtils.lerp(2.4, 7.2, sprintBlend) * THREE.MathUtils.clamp(speed / 2.7, 0.55, 1.25);
    const noiseRadius = baseRadius * surfMult;
    const loudness = isStealth
      ? 0.15 * surfMult
      : THREE.MathUtils.clamp((0.45 + sprintBlend * 0.72) * surfMult, 0.25, 1.45);

    for (const m of mushrooms) {
      if (!m.alive || !m.lively || !m.livelyData) continue;
      const dist = Math.hypot(m.x - x, m.z - z);

      const data = m.livelyData;
      if (data.state !== 'idle' && data.state !== 'alert') continue;
      if (data.stunTimer > 0) continue;

      // Hidden under a leaf pile muffles incoming noise by ~45%
      const effectiveRadius = m.pile ? noiseRadius * 0.55 : noiseRadius;
      if (dist >= effectiveRadius) continue;

      const proximity = 1 - dist / effectiveRadius;
      const deltaAlert = (0.35 + proximity * 0.95) * loudness * (m.pile ? 0.55 : 1);
      data.alertness = Math.min(1.2, data.alertness + deltaAlert);

      if (!m.pile && data.alertness >= 1.0) {
        this.startle(m, playerPos, () => callbacks.onStartled?.(m));
      } else if (!m.pile && data.alertness >= 0.35 && data.state === 'idle') {
        this.enterAlert(m, playerPos, dist);
        callbacks.onAlert?.(m);
      } else if (!m.pile && data.state === 'alert') {
        this.pulseAlertShiver(data);
      }
    }
  }

  /**
   * Called when a thrown stone or stick lands nearby:
   * flushes hidden lively mushrooms out of leaf piles and startles nearby exposed ones.
   */
  public onProjectileNoise(
    x: number,
    z: number,
    mushrooms: LivelyMushroomRef[],
    callbacks: {
      onFlushPile?: (m: LivelyMushroomRef) => void;
      onStartled?: (m: LivelyMushroomRef) => void;
    },
  ): boolean {
    const impactOrigin = new THREE.Vector3(x, groundHeightAt(x, z), z);
    let affected = false;
    for (const m of mushrooms) {
      if (!m.alive || !m.lively || !m.livelyData) continue;
      const dist = Math.hypot(m.x - x, m.z - z);
      if (m.pile && dist < 6.8) {
        affected = true;
        callbacks.onFlushPile?.(m);
        this.startle(m, impactOrigin, () => callbacks.onStartled?.(m));
      } else if (!m.pile && dist < 7.8 && (m.livelyData.state === 'idle' || m.livelyData.state === 'alert')) {
        affected = true;
        this.startle(m, impactOrigin, () => callbacks.onStartled?.(m));
      }
    }
    return affected;
  }

  private enterAlert(m: LivelyMushroomRef, playerPos: THREE.Vector3, dist: number) {
    const data = m.livelyData;
    if (!data) return;
    data.state = 'alert';
    data.heading = Math.atan2(playerPos.x - m.x, playerPos.z - m.z);
    if (data.alertChirpCooldown <= 0) {
      data.alertChirpCooldown = 1.6;
      this.audio.mushroomAlert(dist);
    }
    this.emitSpores(m.x, groundHeightAt(m.x, m.z) + 0.1, m.z, 5, 0.5, 2.2);
    this.pulseAlertShiver(data);
  }

  private pulseAlertShiver(data: LivelyAgent) {
    data.tl?.kill();
    const tl = gsap.timeline();
    tl.to(data.anim, { sx: 1.12, sy: 0.9, sz: 1.12, wiggle: 1, duration: 0.08, ease: 'power2.out' })
      .to(data.anim, { sx: 0.94, sy: 1.08, sz: 0.94, wiggle: -0.8, duration: 0.09, ease: 'sine.inOut' })
      .to(data.anim, { sx: 1, sy: 1, sz: 1, wiggle: 0, duration: 0.14, ease: 'elastic.out(1, 0.55)' });
    if (this.paused) tl.pause();
    data.tl = tl;
  }

  /**
   * Builds terrain-conforming luminous Fairy Rings with harvestable ring mushrooms & 1 central lively trophy.
   */
  public spawnFairyRings(
    rnd: () => number,
    spawnMushroom: (x: number, z: number, species: SpeciesId, withPile: boolean, lively: boolean) => void,
    count = 5,
  ) {
    this.clearFairyRings();
    const ringSpecies: SpeciesId[] = ['chanterelle', 'russula', 'birch', 'porcini'];
    const centerSpecies: SpeciesId[] = ['porcini', 'porcini', 'birch', 'chanterelle', 'golden'];

    let placed = 0;
    let tries = 0;
    while (placed < count && tries++ < 350) {
      const x = (rnd() - 0.5) * (WORLD_HALF * 2 - 44);
      const z = (rnd() - 0.5) * (WORLD_HALF * 2 - 44);
      const td = trailDistance(x, z);
      if (td < 6.5 || td > 46) continue;
      if (Math.hypot(x - HUT_POSE.x, z - HUT_POSE.z) < 18) continue;
      if (this.fairyRings.some((r) => Math.hypot(r.x - x, r.z - z) < 28)) continue;
      if (this.colliders.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + 3.4)) continue;

      const radius = 2.6 + rnd() * 0.75;
      const group = new THREE.Group();

      const segs = 48;
      const positions = new Float32Array((segs + 1) * 2 * 3);
      const indices: number[] = [];
      const halfW = 0.36;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const rIn = radius - halfW;
        const rOut = radius + halfW;
        const ix = x + ca * rIn;
        const iz = z + sa * rIn;
        const ox = x + ca * rOut;
        const oz = z + sa * rOut;
        const vIdx = i * 2;
        positions[vIdx * 3] = ix;
        positions[vIdx * 3 + 1] = groundHeightAt(ix, iz) + 0.045;
        positions[vIdx * 3 + 2] = iz;
        positions[(vIdx + 1) * 3] = ox;
        positions[(vIdx + 1) * 3 + 1] = groundHeightAt(ox, oz) + 0.045;
        positions[(vIdx + 1) * 3 + 2] = oz;
        if (i < segs) {
          indices.push(vIdx, vIdx + 1, vIdx + 2, vIdx + 1, vIdx + 3, vIdx + 2);
        }
      }
      const ringGeo = new THREE.BufferGeometry();
      ringGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      ringGeo.setIndex(indices);
      const ringMat = new THREE.MeshBasicMaterial({
        color: '#d9ff84',
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.renderOrder = 2;
      group.add(ringMesh);

      const motes: THREE.Mesh[] = [];
      const moteAngles: number[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const mote = new THREE.Mesh(this.ringMoteGeo, this.ringMoteMat);
        const mx = x + Math.cos(a) * radius;
        const mz = z + Math.sin(a) * radius;
        mote.position.set(mx, groundHeightAt(mx, mz) + 0.35 + (i % 3) * 0.2, mz);
        mote.scale.setScalar(0.75 + (i % 3) * 0.25);
        group.add(mote);
        motes.push(mote);
        moteAngles.push(a);
      }

      this.ringGroup.add(group);
      this.fairyRings.push({
        x,
        z,
        radius,
        discovered: false,
        group,
        ringMat,
        motes,
        moteAngles,
      });

      const perimCount = 8 + Math.floor(rnd() * 3);
      const ringSp = ringSpecies[placed % ringSpecies.length];
      for (let i = 0; i < perimCount; i++) {
        const a = (i / perimCount) * Math.PI * 2 + (rnd() - 0.5) * 0.18;
        const r = radius + (rnd() - 0.5) * 0.25;
        spawnMushroom(x + Math.cos(a) * r, z + Math.sin(a) * r, ringSp, false, false);
      }

      const cSp = centerSpecies[placed % centerSpecies.length];
      spawnMushroom(x, z, cSp, false, true);

      placed++;
    }
  }

  public clearFairyRings() {
    for (const r of this.fairyRings) {
      this.ringGroup.remove(r.group);
      r.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const m = o as THREE.Mesh;
          if (m.geometry !== this.ringMoteGeo) m.geometry.dispose();
        }
      });
      r.ringMat.dispose();
    }
    this.fairyRings.length = 0;
  }

  public resetAllTimelines(mushrooms: LivelyMushroomRef[]) {
    for (const m of mushrooms) {
      if (m.livelyData?.tl) {
        m.livelyData.tl.kill();
        m.livelyData.tl = null;
      }
    }
    for (const p of this.spores) {
      p.active = false;
      p.mesh.visible = false;
    }
  }

  public setPaused(paused: boolean, mushrooms: LivelyMushroomRef[]) {
    if (this.paused === paused) return;
    this.paused = paused;
    for (const m of mushrooms) {
      const tl = m.livelyData?.tl;
      if (!tl) continue;
      if (paused) tl.pause();
      else if (tl.paused()) tl.resume();
    }
  }

  public dazeMushroom(m: LivelyMushroomRef, duration = 2.6) {
    const data = m.livelyData;
    if (!data) return;
    data.stunTimer = duration;
    data.alertness = 0;
    data.state = 'idle';
    data.tl?.kill();
    const tl = gsap.timeline();
    tl.to(data.anim, { sx: 1.18, sy: 0.84, sz: 1.18, duration: 0.14, ease: 'power2.out' }).to(data.anim, {
      sx: 1,
      sy: 1,
      sz: 1,
      duration: 0.28,
      ease: 'elastic.out(1, 0.5)',
    });
    if (this.paused) tl.pause();
    data.tl = tl;
  }

  /**
   * Pops the lively mushroom out of the soil, unfolds its rootlet legs via GSAP,
   * launches an initial ballistic hop, and sets a 5-10s chase timer before burrowing!
   */
  public startle(
    m: LivelyMushroomRef,
    playerPos: THREE.Vector3,
    onStartledToast?: () => void,
  ): boolean {
    const data = m.livelyData;
    if (!data || !m.alive) return false;
    if (
      data.state === 'fleeing' ||
      data.state === 'seeking_cover' ||
      data.state === 'startled' ||
      data.state === 'burrowing'
    ) {
      return false;
    }

    data.state = 'startled';
    data.alertness = 1;
    data.stunTimer = 0;
    data.fleeTimer = 0;
    data.burrowTargetTime = 5.0 + Math.random() * 5.0; // Exact 5–10 second chase window
    data.coverTarget = null;
    data.hopPause = 0.08;

    const dx = m.x - playerPos.x;
    const dz = m.z - playerPos.z;
    const away = Math.atan2(dx, dz) + (Math.random() - 0.5) * 0.65;
    data.heading = away;

    // Initial ballistic takeoff impulse!
    data.posY = 0.02;
    data.vy = 3.35;
    data.grounded = false;
    data.vx = Math.sin(away) * 4.4;
    data.vz = Math.cos(away) * 4.4;

    this.audio.mushroomSqueak();
    const gy = groundHeightAt(m.x, m.z);
    this.emitSpores(m.x, gy + 0.1, m.z, 16, 1.45, 3.8);
    onStartledToast?.();

    // Expressive GSAP pop-out + rootlet legs spring reveal
    data.tl?.kill();
    const tl = gsap.timeline({
      onComplete: () => {
        if (m.alive && data.state === 'startled') {
          data.state = 'fleeing';
        }
      },
    });
    tl.to(data.anim, {
      sx: 1.32,
      sy: 0.66,
      sz: 1.32,
      duration: 0.06,
      ease: 'power2.in',
    })
      .to(
        data.anim,
        {
          sx: 0.78,
          sy: 1.38,
          sz: 0.78,
          rootScale: 1,
          duration: 0.16,
          ease: 'back.out(2.1)',
        },
        0.06,
      )
      .to(data.anim, {
        sx: 1,
        sy: 1,
        sz: 1,
        duration: 0.14,
        ease: 'power2.out',
      });
    if (this.paused) tl.pause();
    data.tl = tl;
    return true;
  }

  private launchPhysicalHop(
    m: LivelyMushroomRef,
    data: LivelyAgent,
    dirX: number,
    dirZ: number,
    distToPlayer: number,
  ) {
    // Ballistic vertical + forward launch burst
    const hopPower = 2.75 + Math.random() * 0.75;
    const fwdBurst = 4.65 + Math.random() * 0.65;
    data.vy = hopPower;
    data.posY = Math.max(0.01, data.posY);
    data.grounded = false;
    data.vx = dirX * fwdBurst;
    data.vz = dirZ * fwdBurst;
    data.heading = Math.atan2(dirX, dirZ);

    this.audio.mushroomHop(distToPlayer);

    // GSAP coiled takeoff stretch synchronized with the physical launch impulse
    data.tl?.kill();
    const tl = gsap.timeline();
    tl.to(data.anim, {
      sx: 0.8,
      sy: 1.32,
      sz: 0.8,
      duration: 0.11,
      ease: 'power2.out',
    }).to(data.anim, {
      sx: 1,
      sy: 1,
      sz: 1,
      duration: 0.18,
      ease: 'sine.out',
    });
    if (this.paused) tl.pause();
    data.tl = tl;
  }

  private playLandingSquash(
    m: LivelyMushroomRef,
    data: LivelyAgent,
    onLandDust?: (x: number, y: number, z: number) => void,
  ) {
    const gy = groundHeightAt(m.x, m.z);
    this.emitSpores(m.x, gy + 0.05, m.z, 3, 0.75, 4.4);
    onLandDust?.(m.x, gy + 0.06, m.z);

    data.tl?.kill();
    const tl = gsap.timeline();
    tl.to(data.anim, {
      sx: 1.24,
      sy: 0.72,
      sz: 1.24,
      duration: 0.065,
      ease: 'power2.out',
    }).to(data.anim, {
      sx: 1,
      sy: 1,
      sz: 1,
      duration: 0.11,
      ease: 'power2.out',
    });
    if (this.paused) tl.pause();
    data.tl = tl;
  }

  private pickCoverSpot(
    m: LivelyMushroomRef,
    playerPos: THREE.Vector3,
    coverCandidates: CoverSpot[],
  ): CoverSpot | null {
    let best: CoverSpot | null = null;
    let bestScore = -1e9;
    const awayX = m.x - playerPos.x;
    const awayZ = m.z - playerPos.z;
    const awayLen = Math.hypot(awayX, awayZ) || 1;
    const ax = awayX / awayLen;
    const az = awayZ / awayLen;

    for (let i = 0; i < coverCandidates.length; i += 2) {
      const c = coverCandidates[i];
      const dx = c.x - m.x;
      const dz = c.z - m.z;
      const d = Math.hypot(dx, dz);
      if (d < 2.2 || d > 19) continue;
      if (Math.hypot(c.x - HUT_POSE.x, c.z - HUT_POSE.z) < 8) continue;
      if (trailDistance(c.x, c.z) < 2.2) continue;

      // Prefer cover spots ahead in the flee direction (away from player)
      const dot = (dx / d) * ax + (dz / d) * az;
      const dPlayer = Math.hypot(c.x - playerPos.x, c.z - playerPos.z);
      const score = dot * 10 + dPlayer * 0.45 - d * 0.45;
      if (score > bestScore) {
        bestScore = score;
        // Aim right beside the trunk/bush edge so it doesn't clip into the center
        best = { x: c.x - (dx / d) * 0.95, z: c.z - (dz / d) * 0.95 };
      }
    }
    return best;
  }

  /**
   * 0.85-second telegraphed frantic digging choreography!
   * The mushroom remains fully catchable during this window before vanishing under a fresh leaf pile.
   */
  private beginBurrow(
    m: LivelyMushroomRef,
    distToPlayer: number,
    onBurrowStart: (m: LivelyMushroomRef) => void,
    onBurrowComplete: (m: LivelyMushroomRef) => void,
  ) {
    const data = m.livelyData;
    if (!data || data.state === 'burrowing') return;
    data.state = 'burrowing';
    data.vx = 0;
    data.vz = 0;
    data.posY = 0;
    data.vy = 0;
    data.grounded = true;
    data.burrowCount++;
    data.digParticleCooldown = 0;

    this.audio.mushroomBurrow(distToPlayer);
    const gy = groundHeightAt(m.x, m.z);
    this.emitSpores(m.x, gy + 0.1, m.z, 18, 1.5, 5.5);
    onBurrowStart(m);

    data.tl?.kill();
    const tl = gsap.timeline({
      onComplete: () => {
        if (!m.alive || data.state !== 'burrowing') return;
        data.state = 'idle';
        data.alertness = 0;
        data.posY = 0;
        data.vy = 0;
        data.grounded = true;
        data.anim.sx = 1;
        data.anim.sy = 1;
        data.anim.sz = 1;
        data.anim.spinY = 0;
        data.anim.sinkY = 0;
        data.anim.rootScale = 0.001;
        data.anim.wiggle = 0;
        m.group.scale.set(1, 1, 1);
        if (data.rootletsGroup) data.rootletsGroup.scale.setScalar(0.001);
        onBurrowComplete(m);
      },
    });

    // 0.00 -> 0.58s: frantic surface digging wiggle + rapid twists (player's last chance to grab!)
    tl.to(data.anim, {
      sx: 1.24,
      sy: 0.78,
      sz: 1.24,
      spinY: Math.PI * 1.4,
      wiggle: 1,
      duration: 0.19,
      ease: 'sine.inOut',
    })
      .to(data.anim, {
        sx: 0.86,
        sy: 1.16,
        sz: 0.86,
        spinY: Math.PI * 3.0,
        wiggle: -1,
        duration: 0.19,
        ease: 'sine.inOut',
      })
      .to(data.anim, {
        sx: 1.26,
        sy: 0.72,
        sz: 1.26,
        spinY: Math.PI * 4.5,
        wiggle: 1,
        duration: 0.19,
        ease: 'sine.inOut',
      })
      // 0.57 -> 0.85s: dive underground & fold rootlets away as fresh leaves pile up!
      .to(data.anim, {
        sinkY: -0.12,
        sx: 1.22,
        sy: 0.28,
        sz: 1.22,
        rootScale: 0.001,
        spinY: Math.PI * 6.0,
        wiggle: 0,
        duration: 0.28,
        ease: 'power3.in',
      });

    if (this.paused) tl.pause();
    data.tl = tl;
  }

  public update(
    dt: number,
    mushrooms: LivelyMushroomRef[],
    coverCandidates: CoverSpot[],
    playerPos: THREE.Vector3,
    playerSpeed: number,
    playerSprintBlend: number,
    playerCrouch: number,
    surface: SurfaceType,
    nightAmt: number,
    callbacks: {
      onAlert: (m: LivelyMushroomRef) => void;
      onStartled: (m: LivelyMushroomRef) => void;
      onBurrowStart: (m: LivelyMushroomRef) => void;
      onBurrowed: (m: LivelyMushroomRef) => void;
      onDigParticles: (x: number, y: number, z: number) => void;
      onDiscoverFairyRing: (ring: FairyRingRecord) => void;
    },
  ): { chasingAny: boolean } {
    this.elapsed += dt;
    let chasingAny = false;

    // 1. Update Fairy Rings (glow pulsing, orbiting motes, player discovery)
    for (const ring of this.fairyRings) {
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 2.1 + ring.x * 0.3);
      ring.ringMat.opacity = (0.14 + nightAmt * 0.32) * (0.78 + pulse * 0.32);

      const dRing = Math.hypot(playerPos.x - ring.x, playerPos.z - ring.z);
      if (dRing < 48) {
        for (let i = 0; i < ring.motes.length; i++) {
          ring.moteAngles[i] += dt * (0.28 + (i % 3) * 0.08);
          const a = ring.moteAngles[i];
          const mx = ring.x + Math.cos(a) * (ring.radius + Math.sin(this.elapsed * 1.6 + i) * 0.22);
          const mz = ring.z + Math.sin(a) * (ring.radius + Math.cos(this.elapsed * 1.4 + i) * 0.22);
          ring.motes[i].position.set(
            mx,
            groundHeightAt(mx, mz) + 0.28 + Math.sin(this.elapsed * 2.3 + i * 1.3) * 0.18 + (i % 3) * 0.14,
            mz,
          );
          ring.motes[i].rotation.y += dt * 1.8;
        }
      }

      if (!ring.discovered && dRing < 10.5) {
        ring.discovered = true;
        this.audio.fairyChime();
        callbacks.onDiscoverFairyRing(ring);
      }
    }

    // 2. Continuous proximity backup noise (in case player sprints very close between footstep events)
    const surfMult = SURFACE_NOISE_MULT[surface] ?? 1.0;
    const closeSprintRadius = playerCrouch > 0.5 ? 0 : THREE.MathUtils.lerp(1.4, 4.2, playerSprintBlend) * surfMult;

    // 3. Update every lively mushroom
    for (const m of mushrooms) {
      if (!m.alive || !m.lively || !m.livelyData) continue;
      const data = m.livelyData;
      const dx = m.x - playerPos.x;
      const dz = m.z - playerPos.z;
      const dist = Math.hypot(dx, dz);

      if (data.stunTimer > 0) data.stunTimer = Math.max(0, data.stunTimer - dt);
      if (data.alertChirpCooldown > 0) data.alertChirpCooldown = Math.max(0, data.alertChirpCooldown - dt);

      // Update rootlet legs scale & kicking cadence
      if (data.rootletsGroup) {
        data.rootletsGroup.scale.setScalar(Math.max(0.001, data.anim.rootScale));
        if (data.anim.rootScale > 0.05) {
          const kickRate = data.state === 'burrowing' ? 28 : data.grounded ? 14 : 24;
          data.legPhase += dt * kickRate;
          for (let i = 0; i < data.rootletLegs.length; i++) {
            const leg = data.rootletLegs[i];
            const swing = Math.sin(data.legPhase + i * 1.15) * (data.grounded ? 0.35 : 0.65);
            leg.rotation.z = swing;
          }
        }
      }

      // Ambient & chase golden spore trail
      if (!m.pile && dist < 34) {
        data.sporeCooldown -= dt;
        const activeChase =
          data.state === 'fleeing' || data.state === 'seeking_cover' || data.state === 'burrowing';
        if (data.sporeCooldown <= 0) {
          data.sporeCooldown = activeChase ? 0.11 : data.state === 'alert' ? 0.28 : 0.72 + Math.random() * 0.45;
          const gy = groundHeightAt(m.x, m.z);
          this.emitSpores(
            m.x,
            gy + data.posY + (activeChase ? 0.14 : 0.08),
            m.z,
            activeChase ? 2 : 1,
            activeChase ? 0.65 : 0.25,
            activeChase ? 4.6 : 2.3,
          );
        }
      }

      if (data.state === 'idle' || data.state === 'alert') {
        // Gentle decay of alertness when player is quiet / crouched / far
        const decayRate = playerCrouch > 0.5 || playerSpeed < 0.35 ? 0.48 : 0.26;
        data.alertness = Math.max(0, data.alertness - dt * decayRate);

        // Close-range continuous sprint noise build-up
        if (!m.pile && data.stunTimer <= 0 && playerSpeed > 1.2 && closeSprintRadius > 0 && dist < closeSprintRadius) {
          data.alertness += dt * (1.2 + playerSprintBlend * 2.2) * (1 - dist / closeSprintRadius);
          if (data.alertness >= 1.0) {
            this.startle(m, playerPos, () => callbacks.onStartled(m));
            continue;
          } else if (data.alertness >= 0.35 && data.state === 'idle') {
            this.enterAlert(m, playerPos, dist);
            callbacks.onAlert(m);
          }
        }

        if (data.state === 'alert' && data.alertness < 0.16) {
          data.state = 'idle';
        }

        // Visual idle breathing or nervous alert shivering & cap tilt toward player
        if (!m.pile && dist < 24) {
          const alertBoost = data.state === 'alert' ? 0.085 : 0;
          const nerves = alertBoost + (dist < 7 ? (1 - dist / 7) * 0.055 : 0.015);
          const freq = data.state === 'alert' ? 16 : data.stunTimer > 0 ? 18 : 6.2;
          const wiggle = Math.sin(this.elapsed * freq + m.x) * nerves;
          m.group.scale.set(
            data.anim.sx * (1 + wiggle * 0.65),
            data.anim.sy * (1 - wiggle * 0.55),
            data.anim.sz * (1 + wiggle * 0.65),
          );
          if (data.state === 'alert') {
            const lookAngle = Math.atan2(playerPos.x - m.x, playerPos.z - m.z);
            m.group.rotation.y = lookAngle;
            m.group.rotation.z = Math.sin(this.elapsed * 22) * 0.1 + data.anim.wiggle * 0.12;
          }
        }
      } else if (
        data.state === 'startled' ||
        data.state === 'fleeing' ||
        data.state === 'seeking_cover'
      ) {
        chasingAny = true;
        data.fleeTimer += dt;
        data.jukePhase += dt * 3.2;

        // Transition into cover-seeking ~2.2 seconds before the 5–10s burrow timer expires
        if (data.state === 'fleeing' && data.fleeTimer >= Math.max(2.6, data.burrowTargetTime - 2.3)) {
          data.state = 'seeking_cover';
          data.coverTarget = this.pickCoverSpot(m, playerPos, coverCandidates);
        }

        // Compute desired flee / cover-seeking direction
        let desiredX = 0;
        let desiredZ = 0;
        if (data.state === 'seeking_cover' && data.coverTarget) {
          const cx = data.coverTarget.x - m.x;
          const cz = data.coverTarget.z - m.z;
          const cd = Math.hypot(cx, cz) || 1;
          desiredX = cx / cd;
          desiredZ = cz / cd;
          // Still bias slightly away if player is blocking
          if (dist < 4.5 && dist > 0.01) {
            desiredX += (dx / dist) * 0.65;
            desiredZ += (dz / dist) * 0.65;
          }
        } else {
          const awayAngle = Math.atan2(dx, dz);
          const weave = Math.sin(data.jukePhase) * 0.58;
          desiredX = Math.sin(awayAngle + weave);
          desiredZ = Math.cos(awayAngle + weave);
        }

        // Steer inward from world edges and away from hut
        const lim = WORLD_HALF - 16;
        if (Math.abs(m.x) > lim) desiredX -= Math.sign(m.x) * 1.5;
        if (Math.abs(m.z) > lim) desiredZ -= Math.sign(m.z) * 1.5;

        const dhx = m.x - HUT_POSE.x;
        const dhz = m.z - HUT_POSE.z;
        const dh = Math.hypot(dhx, dhz);
        if (dh < 6.5 && dh > 0.01) {
          desiredX += (dhx / dh) * 1.7;
          desiredZ += (dhz / dh) * 1.7;
        }

        // Smooth obstacle avoidance around trees & rocks
        for (const c of this.colliders) {
          const cdx = m.x - c.x;
          const cdz = m.z - c.z;
          const avoidR = (c.r || 1.4) + 1.15;
          const d2 = cdx * cdx + cdz * cdz;
          if (d2 < avoidR * avoidR && d2 > 1e-4) {
            const cd = Math.sqrt(d2);
            const push = (1 - cd / avoidR) * 2.5;
            desiredX += (cdx / cd) * push;
            desiredZ += (cdz / cd) * push;
          }
        }

        const dLen = Math.hypot(desiredX, desiredZ) || 1;
        desiredX /= dLen;
        desiredZ /= dLen;

        // --- True Ballistic Hop Physics Integration ---
        if (!data.grounded) {
          data.vy += HOP_GRAVITY * dt;
          data.posY += data.vy * dt;
          // Gentle mid-air steering + slight drag
          data.vx += (desiredX * 4.5 - data.vx) * Math.min(1, dt * 1.6);
          data.vz += (desiredZ * 4.5 - data.vz) * Math.min(1, dt * 1.6);
        } else {
          // Ground friction deceleration between hops
          const damp = Math.exp(-10.5 * dt);
          data.vx *= damp;
          data.vz *= damp;
          data.hopPause -= dt;
        }

        m.x = THREE.MathUtils.clamp(m.x + data.vx * dt, -WORLD_HALF + 10, WORLD_HALF - 10);
        m.z = THREE.MathUtils.clamp(m.z + data.vz * dt, -WORLD_HALF + 10, WORLD_HALF - 10);

        // Push cleanly outside solid cylinder colliders
        for (const c of this.colliders) {
          if (c.box) continue;
          const cdx = m.x - c.x;
          const cdz = m.z - c.z;
          const rr = c.r + 0.36;
          const d2 = cdx * cdx + cdz * cdz;
          if (d2 < rr * rr && d2 > 1e-5) {
            const cd = Math.sqrt(d2);
            m.x = c.x + (cdx / cd) * rr;
            m.z = c.z + (cdz / cd) * rr;
          }
        }

        // Real terrain contact detection!
        if (!data.grounded && data.posY <= 0) {
          data.posY = 0;
          data.vy = 0;
          data.grounded = true;
          data.vx *= 0.42;
          data.vz *= 0.42;
          data.hopPause = 0.05 + Math.random() * 0.045;
          this.playLandingSquash(m, data, (lx, ly, lz) => callbacks.onDigParticles(lx, ly, lz));
        }

        // Check 5–10s burrow trigger once grounded!
        const reachedCover =
          data.state === 'seeking_cover' &&
          data.coverTarget !== null &&
          data.fleeTimer >= 5.0 &&
          Math.hypot(m.x - data.coverTarget.x, m.z - data.coverTarget.z) < 1.6;
        const timerReached = data.fleeTimer >= data.burrowTargetTime;

        if (data.grounded && (reachedCover || timerReached)) {
          this.beginBurrow(m, dist, callbacks.onBurrowStart, callbacks.onBurrowed);
          continue;
        }

        // Launch next ballistic hop after brief landing coil
        if (data.grounded && data.hopPause <= 0 && data.state !== 'startled') {
          this.launchPhysicalHop(m, data, desiredX, desiredZ, dist);
        }

        // Apply world transform with ballistic pitch arc & GSAP squash/stretch
        const gy = groundHeightAt(m.x, m.z);
        const speedNow = Math.hypot(data.vx, data.vz);
        if (speedNow > 0.25) {
          data.heading = Math.atan2(data.vx, data.vz);
        }
        const airPitch = data.grounded
          ? 0.14
          : THREE.MathUtils.clamp(-data.vy * 0.13 + 0.2, -0.32, 0.52);
        m.group.position.set(m.x, gy - 0.01 + data.posY, m.z);
        m.group.rotation.set(airPitch, data.heading, Math.sin(data.jukePhase * 2.5) * 0.14);
        m.group.scale.set(data.anim.sx, data.anim.sy, data.anim.sz);
      } else if (data.state === 'burrowing') {
        // Still part of active chase for 0.85s so player gets a thrilling last-second catch!
        chasingAny = true;
        const gy = groundHeightAt(m.x, m.z);
        m.group.position.set(m.x, gy - 0.01 + data.anim.sinkY, m.z);
        m.group.rotation.set(
          data.anim.wiggle * 0.22,
          data.heading + data.anim.spinY,
          data.anim.wiggle * 0.18,
        );
        m.group.scale.set(data.anim.sx, data.anim.sy, data.anim.sz);

        data.digParticleCooldown -= dt;
        if (data.digParticleCooldown <= 0) {
          data.digParticleCooldown = 0.14;
          callbacks.onDigParticles(m.x, gy + 0.08, m.z);
        }
      }
    }

    // 4. Update golden spore trail particles
    for (const p of this.spores) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      const u = p.age / p.life;
      p.mesh.position.x += (p.vx + Math.sin(this.elapsed * 2.5 + p.mesh.id) * 0.14) * dt;
      p.mesh.position.y += p.vy * (1 - u * 0.65) * dt;
      p.mesh.position.z += (p.vz + Math.cos(this.elapsed * 2.2 + p.mesh.id) * 0.14) * dt;
      p.mesh.rotation.y += dt * 2.4;
      p.mesh.rotation.x += dt * 1.5;
      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - u) * 0.85;
    }

    return { chasingAny };
  }

  public dispose(mushrooms: LivelyMushroomRef[]) {
    this.resetAllTimelines(mushrooms);
    this.clearFairyRings();
    for (const p of this.spores) {
      (p.mesh.material as THREE.Material).dispose();
    }
    this.sporeGeo.dispose();
    this.sporeMat.dispose();
    this.ringMoteGeo.dispose();
    this.ringMoteMat.dispose();
    this.rootletMat.dispose();
    this.rootletSegGeo.dispose();
    this.scene.remove(this.fxGroup);
    this.scene.remove(this.ringGroup);
  }
}
