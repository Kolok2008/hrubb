import * as THREE from 'three';
import type { WorldCollider } from '../types';
import { mulberry32 } from '../utils/noise';
import { createSlashDecalTexture, createWoodGrainTexture } from '../utils/textures';
import type { LoadedModels } from '../world/modelLoader';
import { groundHeightAt, groundNormalAt, TRAIL } from '../world/terrain';

export type ImpactMaterial = 'wood' | 'crate' | 'rock' | 'foliage' | 'soil' | 'mushroom' | 'flesh';

export interface PhysicsBody {
  id: number;
  mesh: THREE.Object3D;
  kind: 'crate' | 'log' | 'barrel' | 'bucket' | 'stone' | 'stick' | 'plank' | 'cap';
  material: 'wood' | 'crate' | 'rock' | 'mushroom';
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  radius: number;
  halfHeight: number;
  mass: number;
  restitution: number;
  friction: number;
  hp: number;
  maxHp: number;
  sleeping: boolean;
  life: number; // -1 = permanent, >0 = temporary debris countdown
  pickable?: boolean;
  isThrown?: boolean;
  onFirstImpact?: (pos: THREE.Vector3, kind: 'stone' | 'stick') => void;
  onBreakSpawnBonus?: boolean;
  lastImpactSound: number;
}

export interface KnifeImpactEvent {
  material: ImpactMaterial;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  strength: number;
  brokeCrate?: boolean;
  crateBonusPos?: THREE.Vector3;
  hitLabel?: string;
}

interface Particle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  life: number;
  maxLife: number;
  gravity: number;
  drag: number;
  bounce: number;
}

export interface BushSpot {
  x: number;
  y: number;
  z: number;
  r: number;
  cooldown: number;
}

export class PhysicsWorld {
  private readonly scene: THREE.Scene;
  private readonly colliders: WorldCollider[];
  private readonly bodies: PhysicsBody[] = [];
  private readonly decals: THREE.Mesh[] = [];
  private readonly maxDecals = 48;
  private readonly decalMat: THREE.MeshStandardMaterial;
  private readonly decalGeo: THREE.PlaneGeometry;
  private readonly plankGeo: THREE.BoxGeometry;
  private readonly plankMat: THREE.MeshStandardMaterial;
  private readonly throwStoneGeo: THREE.DodecahedronGeometry;
  private readonly throwStoneMat: THREE.MeshStandardMaterial;
  private readonly throwStickGeo: THREE.CylinderGeometry;
  private readonly throwStickMat: THREE.MeshStandardMaterial;

  // Pooled 3D particle cloud (sparks, splinters, leaves, dirt, spores, blood)
  private readonly maxParticles = 420;
  private readonly particles: Particle[] = [];
  private readonly pPos: Float32Array;
  private readonly pCol: Float32Array;
  private readonly pPoints: THREE.Points;
  private pCursor = 0;

  private nextId = 1;
  private elapsed = 0;
  private readonly raycaster = new THREE.Raycaster();

  // Static raycast targets (hut, stall, wagon, fences)
  private readonly staticWoodMeshes: THREE.Object3D[] = [];
  private readonly bushSpots: BushSpot[] = [];

  // Scratch math objects (zero GC)
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _v3 = new THREE.Vector3();
  private readonly _norm = new THREE.Vector3();
  private readonly _quat = new THREE.Quaternion();
  private readonly _axis = new THREE.Vector3();

  constructor(scene: THREE.Scene, colliders: WorldCollider[]) {
    this.scene = scene;
    this.colliders = colliders;

    this.decalGeo = new THREE.PlaneGeometry(0.28, 0.085);
    this.decalMat = new THREE.MeshStandardMaterial({
      map: createSlashDecalTexture(),
      transparent: true,
      roughness: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.plankGeo = new THREE.BoxGeometry(0.46, 0.055, 0.12);
    this.plankMat = new THREE.MeshStandardMaterial({
      map: createWoodGrainTexture('#8c5d36'),
      roughness: 0.84,
      metalness: 0.02,
    });
    this.throwStoneGeo = new THREE.DodecahedronGeometry(0.085, 1);
    this.throwStoneMat = new THREE.MeshStandardMaterial({
      color: '#9c9487',
      roughness: 0.88,
      metalness: 0.06,
    });
    this.throwStickGeo = new THREE.CylinderGeometry(0.022, 0.028, 0.44, 7);
    this.throwStickGeo.rotateZ(Math.PI / 2);
    this.throwStickMat = new THREE.MeshStandardMaterial({
      color: '#6e4a2b',
      roughness: 0.92,
    });

    // Particle pool
    this.pPos = new Float32Array(this.maxParticles * 3);
    this.pCol = new Float32Array(this.maxParticles * 3);
    for (let i = 0; i < this.maxParticles; i++) {
      this.pPos[i * 3 + 1] = -999;
      this.particles.push({
        active: false,
        pos: new THREE.Vector3(0, -999, 0),
        vel: new THREE.Vector3(),
        color: new THREE.Color('#ffffff'),
        life: 0,
        maxLife: 1,
        gravity: 9.8,
        drag: 0.98,
        bounce: 0.35,
      });
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const pMat = new THREE.PointsMaterial({
      size: 0.055,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.pPoints = new THREE.Points(pGeo, pMat);
    this.pPoints.frustumCulled = false;
    this.scene.add(this.pPoints);
  }

  public registerStaticWood(obj: THREE.Object3D) {
    this.staticWoodMeshes.push(obj);
  }

  public registerBush(x: number, y: number, z: number, r: number) {
    this.bushSpots.push({ x, y, z, r, cooldown: 0 });
  }

  /**
   * Spawns tactile, physically simulated props around the starting clearing, hut, stall, and trail
   * so the player can slash, knock, roll, and shatter crates, logs, barrels, buckets, and stones.
   */
  public populateInteractiveProps(
    models: LoadedModels,
    startPos: THREE.Vector3,
    startDir: THREE.Vector3,
    hutPos: THREE.Vector3,
  ) {
    const right = new THREE.Vector3(-startDir.z, 0, startDir.x).normalize();
    const rnd = mulberry32(808);

    const placeAt = (
      offsetRight: number,
      offsetFwd: number,
      base: THREE.Vector3 = startPos,
    ): THREE.Vector3 => {
      const x = base.x + right.x * offsetRight + startDir.x * offsetFwd;
      const z = base.z + right.z * offsetRight + startDir.z * offsetFwd;
      return new THREE.Vector3(x, groundHeightAt(x, z), z);
    };

    // 1. Destructible wooden crates neatly stacked beside the buyer stall, wagon, and hut corner
    const crateSpots: Array<{ pos: THREE.Vector3; scale: number; bonus?: boolean }> = [
      { pos: placeAt(-5.2, 3.0), scale: 0.86, bonus: true },
      { pos: placeAt(-6.0, 2.3), scale: 0.74 },
      { pos: placeAt(-4.3, -0.35), scale: 0.82, bonus: true },
      { pos: placeAt(-6.2, 0.7), scale: 0.9 },
      { pos: placeAt(4.9, 5.1), scale: 0.78 },
      {
        pos: new THREE.Vector3(
          hutPos.x - right.x * 2.6,
          groundHeightAt(hutPos.x - right.x * 2.6, hutPos.z - startDir.z * 2.5),
          hutPos.z - startDir.z * 2.5,
        ),
        scale: 0.84,
        bonus: true,
      },
    ];

    for (const cs of crateSpots) {
      const crateMesh = models.Prop_Crate.scene.clone(true);
      crateMesh.scale.setScalar(cs.scale);
      const box = new THREE.Box3().setFromObject(crateMesh);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const holder = new THREE.Group();
      crateMesh.position.sub(center);
      holder.add(crateMesh);
      holder.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });

      const hh = Math.max(0.28, size.y * 0.5);
      const spawnPos = cs.pos.clone();
      spawnPos.y += hh + 0.02;
      holder.position.copy(spawnPos);
      holder.rotation.y = rnd() * Math.PI * 2;
      this.scene.add(holder);

      this.bodies.push({
        id: this.nextId++,
        mesh: holder,
        kind: 'crate',
        material: 'crate',
        pos: spawnPos,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        radius: Math.max(0.32, Math.max(size.x, size.z) * 0.48),
        halfHeight: hh,
        mass: 3.4 * cs.scale,
        restitution: 0.28,
        friction: 4.5,
        hp: 3,
        maxHp: 3,
        sleeping: true,
        life: -1,
        onBreakSpawnBonus: cs.bonus,
        lastImpactSound: 0,
      });
    }

    // 2. Chopped firewood logs neatly stacked beside the chopping block near the campfire
    const logMat = new THREE.MeshStandardMaterial({
      map: createWoodGrainTexture('#684226'),
      roughness: 0.88,
    });
    const endGrainMat = new THREE.MeshStandardMaterial({
      color: '#cfa878',
      roughness: 0.82,
    });
    const ironMat = new THREE.MeshStandardMaterial({
      color: '#34383e',
      metalness: 0.82,
      roughness: 0.42,
    });

    const logOffsets: Array<[number, number, number]> = [
      [3.4, 0.75, 0.12],
      [3.65, 1.0, -0.08],
      [3.5, 0.88, 0.05],
      [3.35, 1.55, 0.45],
      [3.65, 1.75, -0.25],
    ];
    logOffsets.forEach(([rx, fx, rotY], idx) => {
      const p = placeAt(rx, fx);
      const g = new THREE.Group();
      const len = 0.62 + (idx % 2) * 0.12;
      const rad = 0.09 + (idx % 3) * 0.012;
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(rad, rad * 1.06, len, 12),
        [logMat, endGrainMat, endGrainMat],
      );
      cyl.rotation.z = Math.PI / 2;
      cyl.castShadow = true;
      cyl.receiveShadow = true;
      g.add(cyl);
      p.y += rad + (idx === 2 ? rad * 1.85 : 0.02);
      g.position.copy(p);
      g.rotation.y = rotY;
      this.scene.add(g);

      this.bodies.push({
        id: this.nextId++,
        mesh: g,
        kind: 'log',
        material: 'wood',
        pos: p,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        radius: 0.22,
        halfHeight: rad,
        mass: 1.6,
        restitution: 0.34,
        friction: 3.1,
        hp: 99,
        maxHp: 99,
        sleeping: true,
        life: -1,
        lastImpactSound: 0,
      });
    });

    // 3. Wooden coopered barrels with iron hoops beside the buyer stall and fence corner
    for (const [rx, fx] of [
      [-3.55, 2.35],
      [4.95, 3.65],
    ]) {
      const p = placeAt(rx, fx);
      const barrel = new THREE.Group();
      const pts = [
        [0, -0.34],
        [0.21, -0.34],
        [0.26, -0.15],
        [0.27, 0],
        [0.26, 0.15],
        [0.21, 0.34],
        [0, 0.34],
      ].map(([r, y]) => new THREE.Vector2(r, y));
      const stave = new THREE.Mesh(new THREE.LatheGeometry(pts, 18), logMat);
      barrel.add(stave);
      for (const hy of [-0.22, 0.22]) {
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.245, 0.011, 8, 22), ironMat);
        hoop.rotation.x = Math.PI / 2;
        hoop.position.y = hy;
        barrel.add(hoop);
      }
      barrel.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
      p.y += 0.35;
      barrel.position.copy(p);
      this.scene.add(barrel);

      this.bodies.push({
        id: this.nextId++,
        mesh: barrel,
        kind: 'barrel',
        material: 'wood',
        pos: p,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        radius: 0.28,
        halfHeight: 0.34,
        mass: 4.2,
        restitution: 0.26,
        friction: 3.4,
        hp: 99,
        maxHp: 99,
        sleeping: true,
        life: -1,
        lastImpactSound: 0,
      });
    }

    // 4. Pickable & throwable stones and dry sticks scattered naturally near the camp & along trail edges!
    const spawnPickable = (kind: 'stone' | 'stick', x: number, z: number) => {
      const gy = groundHeightAt(x, z);
      const mesh =
        kind === 'stone'
          ? new THREE.Mesh(this.throwStoneGeo, this.throwStoneMat)
          : new THREE.Mesh(this.throwStickGeo, this.throwStickMat);
      if (kind === 'stone') {
        const sc = 0.85 + rnd() * 0.45;
        mesh.scale.set(sc * 1.15, sc * 0.78, sc);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const hh = kind === 'stone' ? 0.075 : 0.032;
      const p = new THREE.Vector3(x, gy + hh + 0.01, z);
      mesh.position.copy(p);
      mesh.rotation.y = rnd() * Math.PI * 2;
      this.scene.add(mesh);

      this.bodies.push({
        id: this.nextId++,
        mesh,
        kind,
        material: kind === 'stone' ? 'rock' : 'wood',
        pos: p,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        radius: kind === 'stone' ? 0.12 : 0.18,
        halfHeight: hh,
        mass: kind === 'stone' ? 0.85 : 0.45,
        restitution: kind === 'stone' ? 0.45 : 0.36,
        friction: 4.5,
        hp: 99,
        maxHp: 99,
        sleeping: true,
        life: -1,
        pickable: true,
        lastImpactSound: 0,
      });
    };

    // Handy stones & sticks near the clearing edge
    for (const [rx, fx, kind] of [
      [-1.1, 4.9, 'stone'],
      [1.9, 5.4, 'stick'],
      [-1.5, 7.2, 'stone'],
      [2.1, 7.8, 'stone'],
      [-0.6, 3.1, 'stick'],
      [2.6, 3.4, 'stone'],
    ] as const) {
      const p = placeAt(rx, fx);
      spawnPickable(kind, p.x, p.z);
    }

    // 26 additional stones & sticks along the winding forest trail & clearings
    for (let i = 0; i < 26; i++) {
      const samp = TRAIL.samples[Math.floor(rnd() * TRAIL.samples.length)];
      const angle = rnd() * Math.PI * 2;
      const dist = 1.6 + rnd() * 14;
      const px = samp.x + Math.cos(angle) * dist;
      const pz = samp.z + Math.sin(angle) * dist;
      spawnPickable(i % 2 === 0 ? 'stone' : 'stick', px, pz);
    }
  }

  public findPickableItem(
    origin: THREE.Vector3,
    rayDir: THREE.Vector3,
    maxDist = 2.85,
  ): { id: number; kind: 'stone' | 'stick'; dist: number } | null {
    let best: { id: number; kind: 'stone' | 'stick'; dist: number } | null = null;
    let bestScore = 1e9;
    for (const b of this.bodies) {
      if (!b.pickable || b.isThrown) continue;
      if (b.kind !== 'stone' && b.kind !== 'stick') continue;
      this._v1.subVectors(b.pos, origin);
      const dist = this._v1.length();
      if (dist > maxDist || dist < 0.25) continue;
      this._v1.divideScalar(dist);
      const dot = this._v1.dot(rayDir);
      if (dot < 0.88) continue;
      const score = dist * (1.4 - dot);
      if (score < bestScore) {
        bestScore = score;
        best = { id: b.id, kind: b.kind, dist };
      }
    }
    return best;
  }

  public pickupBody(id: number): 'stone' | 'stick' | null {
    const idx = this.bodies.findIndex((b) => b.id === id && b.pickable);
    if (idx < 0) return null;
    const b = this.bodies[idx];
    const kind = b.kind === 'stick' ? 'stick' : 'stone';
    this.scene.remove(b.mesh);
    this.bodies.splice(idx, 1);
    return kind;
  }

  public throwProjectile(
    kind: 'stone' | 'stick',
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    speed: number,
    onFirstImpact: (pos: THREE.Vector3, kind: 'stone' | 'stick') => void,
  ) {
    const mesh =
      kind === 'stone'
        ? new THREE.Mesh(this.throwStoneGeo, this.throwStoneMat)
        : new THREE.Mesh(this.throwStickGeo, this.throwStickMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const startPos = origin.clone().addScaledVector(dir, 0.55);
    mesh.position.copy(startPos);
    this.scene.add(mesh);

    const vel = dir.clone().multiplyScalar(speed);
    vel.y += 2.6;

    this.bodies.push({
      id: this.nextId++,
      mesh,
      kind,
      material: kind === 'stone' ? 'rock' : 'wood',
      pos: startPos,
      vel,
      angVel: new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 14,
      ),
      radius: kind === 'stone' ? 0.11 : 0.16,
      halfHeight: kind === 'stone' ? 0.075 : 0.032,
      mass: kind === 'stone' ? 0.85 : 0.45,
      restitution: kind === 'stone' ? 0.44 : 0.36,
      friction: 4.2,
      hp: 99,
      maxHp: 99,
      sleeping: false,
      life: -1,
      pickable: true,
      isThrown: true,
      onFirstImpact,
      lastImpactSound: 0,
    });
  }

  /**
   * Launches a physically simulated sliced mushroom cap across the forest floor!
   */
  public spawnSlicedCap(
    capObject: THREE.Object3D,
    worldPos: THREE.Vector3,
    slashDir: THREE.Vector3,
    speed = 4.5,
  ) {
    const holder = new THREE.Group();
    holder.position.copy(worldPos);
    capObject.position.set(0, 0, 0);
    holder.add(capObject);
    this.scene.add(holder);

    const vel = slashDir
      .clone()
      .multiplyScalar(speed)
      .add(new THREE.Vector3((Math.random() - 0.5) * 1.1, 2.2 + Math.random() * 1.1, (Math.random() - 0.5) * 1.1));

    const angVel = new THREE.Vector3(
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 14,
    );

    this.bodies.push({
      id: this.nextId++,
      mesh: holder,
      kind: 'cap',
      material: 'mushroom',
      pos: worldPos.clone(),
      vel,
      angVel,
      radius: 0.08,
      halfHeight: 0.045,
      mass: 0.22,
      restitution: 0.35,
      friction: 5.5,
      hp: 1,
      maxHp: 1,
      sleeping: false,
      life: 16,
      lastImpactSound: 0,
    });
  }

  private shatterCrate(body: PhysicsBody, slashDir: THREE.Vector3, hitPoint: THREE.Vector3) {
    this.scene.remove(body.mesh);
    const idx = this.bodies.indexOf(body);
    if (idx >= 0) this.bodies.splice(idx, 1);

    // Spawn 6 tumbling wooden plank rigid bodies exploding outward
    for (let i = 0; i < 6; i++) {
      const plank = new THREE.Mesh(this.plankGeo, this.plankMat);
      plank.castShadow = true;
      plank.receiveShadow = true;
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.4;
      const p = body.pos
        .clone()
        .add(new THREE.Vector3(Math.cos(a) * 0.18, (Math.random() - 0.3) * 0.25, Math.sin(a) * 0.18));
      plank.position.copy(p);
      plank.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.scene.add(plank);

      const outDir = new THREE.Vector3(Math.cos(a), 0.7 + Math.random() * 0.8, Math.sin(a)).normalize();
      const vel = outDir
        .multiplyScalar(2.2 + Math.random() * 2.4)
        .addScaledVector(slashDir, 2.2);

      this.bodies.push({
        id: this.nextId++,
        mesh: plank,
        kind: 'plank',
        material: 'wood',
        pos: p,
        vel,
        angVel: new THREE.Vector3(
          (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 16,
        ),
        radius: 0.16,
        halfHeight: 0.045,
        mass: 0.45,
        restitution: 0.38,
        friction: 4.5,
        hp: 10,
        maxHp: 10,
        sleeping: false,
        life: 14,
        lastImpactSound: 0,
      });
    }

    this.emitBurst(hitPoint, 36, '#b8834d', 3.6, 3.2, 8.5);
    this.emitBurst(hitPoint, 18, '#6e4522', 2.4, 2.2, 7.0);
  }

  public spawnSlashDecal(point: THREE.Vector3, normal: THREE.Vector3, slashDir: THREE.Vector3) {
    const mesh = new THREE.Mesh(this.decalGeo, this.decalMat);
    mesh.position.copy(point).addScaledVector(normal, 0.016);
    mesh.lookAt(this._v1.copy(mesh.position).add(normal));
    // Align slash mark angle with the blade's slash direction projected onto surface plane
    const tangent = this._v2
      .copy(slashDir)
      .addScaledVector(normal, -slashDir.dot(normal));
    if (tangent.lengthSq() > 1e-4) {
      tangent.normalize();
      const localRight = this._v3.set(1, 0, 0).applyQuaternion(mesh.quaternion);
      const localUp = this._axis.set(0, 1, 0).applyQuaternion(mesh.quaternion);
      const angle = Math.atan2(tangent.dot(localUp), tangent.dot(localRight));
      mesh.rotateZ(angle);
    }
    this.scene.add(mesh);
    this.decals.push(mesh);
    if (this.decals.length > this.maxDecals) {
      const old = this.decals.shift();
      if (old) this.scene.remove(old);
    }
  }

  public emitBurst(
    origin: THREE.Vector3,
    count: number,
    hex: string,
    spread = 2.0,
    upBoost = 2.0,
    gravity = 9.0,
    bounce = 0.32,
  ) {
    const base = new THREE.Color(hex);
    for (let i = 0; i < count; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.maxParticles;
      const p = this.particles[idx];
      p.active = true;
      p.pos.copy(origin).addScaledVector(this._v1.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5), 0.06);
      p.vel.set(
        (Math.random() - 0.5) * spread * 2,
        Math.random() * upBoost + 0.4,
        (Math.random() - 0.5) * spread * 2,
      );
      const shade = 0.72 + Math.random() * 0.48;
      p.color.copy(base).multiplyScalar(shade);
      p.maxLife = 0.38 + Math.random() * 0.55;
      p.life = p.maxLife;
      p.gravity = gravity;
      p.drag = gravity < 3 ? 0.94 : 0.985;
      p.bounce = bounce;
    }
  }

  public emitDirectionalBurst(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    count: number,
    hex: string,
    speed = 3.2,
    gravity = 9.5,
  ) {
    const base = new THREE.Color(hex);
    for (let i = 0; i < count; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.maxParticles;
      const p = this.particles[idx];
      p.active = true;
      p.pos.copy(origin);
      p.vel
        .copy(dir)
        .multiplyScalar(speed * (0.55 + Math.random() * 0.9))
        .add(
          this._v1.set(
            (Math.random() - 0.5) * speed * 0.75,
            Math.random() * speed * 0.65,
            (Math.random() - 0.5) * speed * 0.75,
          ),
        );
      p.color.copy(base).multiplyScalar(0.75 + Math.random() * 0.45);
      p.maxLife = 0.32 + Math.random() * 0.5;
      p.life = p.maxLife;
      p.gravity = gravity;
      p.drag = 0.97;
      p.bounce = 0.42;
    }
  }

  /**
   * Performs swept knife collision against dynamic rigid bodies, trees, rocks, bushes,
   * hut/stall/wagon wood, and terrain soil! Returns the closest physical impact event.
   */
  public testKnifeImpact(
    origin: THREE.Vector3,
    rayDir: THREE.Vector3,
    slashDir: THREE.Vector3,
    reach: number,
    force: number,
    damage: number,
  ): KnifeImpactEvent | null {
    let bestDist = reach + 0.01;
    let bestHit: KnifeImpactEvent | null = null;
    let bestBody: PhysicsBody | null = null;

    // 1. Check dynamic physics bodies (sphere/capsule intersection along ray)
    for (const body of this.bodies) {
      if (body.kind === 'plank' || body.kind === 'cap') {
        // Still allow batting planks & caps mid-air!
      }
      const toBody = this._v1.subVectors(body.pos, origin);
      const proj = toBody.dot(rayDir);
      if (proj < 0.15 || proj > bestDist) continue;
      const closestPt = this._v2.copy(origin).addScaledVector(rayDir, proj);
      const perpSq = closestPt.distanceToSquared(body.pos);
      const hitRad = body.radius + 0.16;
      if (perpSq <= hitRad * hitRad) {
        const hitDist = Math.max(0.2, proj - body.radius * 0.5);
        if (hitDist < bestDist) {
          bestDist = hitDist;
          bestBody = body;
          const pt = origin.clone().addScaledVector(rayDir, hitDist);
          const nrm = pt.clone().sub(body.pos).normalize();
          bestHit = {
            material: body.material,
            point: pt,
            normal: nrm,
            strength: Math.min(1.5, force / 7),
          };
        }
      }
    }

    if (bestBody && bestHit) {
      // Apply real linear impulse + angular torque (r × F) to the hit rigid body!
      const impulseDir = this._v1
        .copy(slashDir)
        .multiplyScalar(0.68)
        .addScaledVector(rayDir, 0.55)
        .add(new THREE.Vector3(0, 0.34, 0))
        .normalize();

      const dv = (force * 1.15) / bestBody.mass;
      bestBody.vel.addScaledVector(impulseDir, dv);
      bestBody.sleeping = false;

      // Torque = (hitPoint - centerOfMass) × impulseDir
      const lever = this._v2.subVectors(bestHit.point, bestBody.pos);
      const torque = this._v3.crossVectors(lever, impulseDir);
      bestBody.angVel.addScaledVector(torque, (force * 3.8) / bestBody.mass);
      // Add subtle slash spin twist
      bestBody.angVel.y += (slashDir.x * 2.5) / bestBody.mass;

      if (bestBody.kind === 'crate') {
        bestBody.hp -= damage;
        if (bestBody.hp <= 0) {
          const bonusPos = bestBody.onBreakSpawnBonus ? bestBody.pos.clone() : undefined;
          this.shatterCrate(bestBody, slashDir, bestHit.point);
          bestHit.brokeCrate = true;
          bestHit.crateBonusPos = bonusPos;
          return bestHit;
        }
        this.emitDirectionalBurst(bestHit.point, bestHit.normal, 18, '#c28c54', 3.0, 9.2);
      } else if (bestBody.material === 'rock') {
        // Metallic spark burst off stone!
        this.emitDirectionalBurst(bestHit.point, bestHit.normal, 26, '#ffd27a', 4.6, 11.5);
        this.emitDirectionalBurst(bestHit.point, bestHit.normal, 10, '#ffffff', 3.4, 10.0);
      } else if (bestBody.material === 'wood') {
        this.emitDirectionalBurst(bestHit.point, bestHit.normal, 16, '#b57c45', 2.8, 9.0);
      } else {
        this.emitBurst(bestHit.point, 14, '#e6d8b4', 1.4, 1.8, 6.0);
      }
      return bestHit;
    }

    // 2. Check static trees & rocks colliders (cylinder intersection)
    for (const col of this.colliders) {
      if (col.box) continue;
      const dx = col.x - origin.x;
      const dz = col.z - origin.z;
      const d2 = dx * dx + dz * dz;
      const maxCheck = reach + col.r + 0.5;
      if (d2 > maxCheck * maxCheck) continue;

      // 2D ray-circle intersection in XZ
      const rx = rayDir.x;
      const rz = rayDir.z;
      const lenXZ = Math.hypot(rx, rz);
      if (lenXZ < 0.05) continue;
      const ux = rx / lenXZ;
      const uz = rz / lenXZ;
      const proj = dx * ux + dz * uz;
      if (proj < 0) continue;
      const perpSq = d2 - proj * proj;
      const rEff = col.r + 0.08;
      if (perpSq > rEff * rEff) continue;

      const hitXZ = proj - Math.sqrt(Math.max(0, rEff * rEff - perpSq));
      const t3d = hitXZ / lenXZ;
      if (t3d < 0.2 || t3d > bestDist) continue;

      const hitPt = origin.clone().addScaledVector(rayDir, t3d);
      const gy = groundHeightAt(col.x, col.z);
      const colHeight = col.kind === 'rock' ? col.r * 1.45 : col.kind === 'stall' ? 2.4 : 8.0;
      if (hitPt.y < gy - 0.1 || hitPt.y > gy + colHeight) continue;

      bestDist = t3d;
      const normal = new THREE.Vector3(hitPt.x - col.x, 0.05, hitPt.z - col.z).normalize();
      const mat: ImpactMaterial = col.kind === 'rock' ? 'rock' : 'wood';
      bestHit = {
        material: mat,
        point: hitPt,
        normal,
        strength: Math.min(1.5, force / 7),
      };
    }

    // 3. Check static architectural wood meshes (Hut, Stall, Wagon, Fence) via Raycaster
    if (this.staticWoodMeshes.length > 0) {
      this.raycaster.set(origin, rayDir);
      this.raycaster.near = 0.18;
      this.raycaster.far = bestDist;
      const hits = this.raycaster.intersectObjects(this.staticWoodMeshes, true);
      if (hits.length > 0 && hits[0].distance < bestDist) {
        const h = hits[0];
        bestDist = h.distance;
        const nrm = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
          : rayDir.clone().negate();
        bestHit = {
          material: 'wood',
          point: h.point.clone(),
          normal: nrm,
          strength: Math.min(1.4, force / 7),
        };
      }
    }

    if (bestHit) {
      if (bestHit.material === 'rock') {
        this.emitDirectionalBurst(bestHit.point, bestHit.normal, 30, '#ffcf6e', 5.0, 12.0);
        this.emitDirectionalBurst(bestHit.point, bestHit.normal, 12, '#ffffff', 3.6, 10.5);
      } else if (bestHit.material === 'wood') {
        this.spawnSlashDecal(bestHit.point, bestHit.normal, slashDir);
        this.emitDirectionalBurst(bestHit.point, bestHit.normal, 22, '#b87d44', 3.1, 9.5);
        this.emitDirectionalBurst(bestHit.point, bestHit.normal, 10, '#5a361a', 2.2, 8.0);
      }
      return bestHit;
    }

    // 4. Check bushes & dense ferns for tactile foliage slicing
    for (const bush of this.bushSpots) {
      if (bush.cooldown > 0) continue;
      const toB = this._v1.set(bush.x - origin.x, bush.y + 0.55 - origin.y, bush.z - origin.z);
      const proj = toB.dot(rayDir);
      if (proj < 0.2 || proj > reach + 0.2) continue;
      const closest = this._v2.copy(origin).addScaledVector(rayDir, proj);
      const distSq = closest.distanceToSquared(this._v3.set(bush.x, bush.y + 0.55, bush.z));
      if (distSq <= (bush.r + 0.25) * (bush.r + 0.25)) {
        bush.cooldown = 0.45;
        this.emitDirectionalBurst(closest, slashDir, 26, '#c86a24', 2.6, 2.2);
        this.emitDirectionalBurst(closest, slashDir, 14, '#889438', 2.1, 2.0);
        return {
          material: 'foliage',
          point: closest.clone(),
          normal: rayDir.clone().negate(),
          strength: 0.45,
        };
      }
    }

    // 5. Check terrain ground strike when slashing downward
    if (rayDir.y < -0.25) {
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const d = (reach * i) / steps;
        const p = this._v1.copy(origin).addScaledVector(rayDir, d);
        const gy = groundHeightAt(p.x, p.z);
        if (p.y <= gy + 0.05) {
          const hitPt = new THREE.Vector3(p.x, gy + 0.03, p.z);
          const nrm = groundNormalAt(p.x, p.z, new THREE.Vector3());
          this.emitDirectionalBurst(hitPt, nrm, 24, '#6b4728', 2.6, 8.8);
          this.emitDirectionalBurst(hitPt, slashDir, 12, '#c8722a', 2.2, 3.0);
          return {
            material: 'soil',
            point: hitPt,
            normal: nrm,
            strength: 0.7,
          };
        }
      }
    }

    return null;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3,
    onBodyBounce?: (mat: 'wood' | 'rock' | 'mushroom', intensity: number) => void,
  ) {
    this.elapsed += dt;

    for (const b of this.bushSpots) {
      if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - dt);
    }

    // --- Simulate Rigid Bodies ---
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (b.life > 0) {
        b.life -= dt;
        if (b.life < 1.5) {
          b.mesh.scale.setScalar(Math.max(0.01, b.life / 1.5));
        }
        if (b.life <= 0) {
          this.scene.remove(b.mesh);
          this.bodies.splice(i, 1);
          continue;
        }
      }

      // Player foot nudge interaction with physical objects
      const pdx = b.pos.x - playerPos.x;
      const pdz = b.pos.z - playerPos.z;
      const minDist = b.radius + 0.38;
      const dSq = pdx * pdx + pdz * pdz;
      if (dSq < minDist * minDist && dSq > 1e-5 && Math.abs(b.pos.y - (playerPos.y + 0.45)) < 0.9) {
        const d = Math.sqrt(dSq);
        const nx = pdx / d;
        const nz = pdz / d;
        const overlap = minDist - d;
        b.pos.x += nx * overlap * 0.7;
        b.pos.z += nz * overlap * 0.7;
        const pSpeed = Math.hypot(playerVel.x, playerVel.z);
        const push = (1.6 + pSpeed * 0.95) / Math.max(0.6, b.mass * 0.45);
        b.vel.x += nx * push * dt * 12;
        b.vel.z += nz * push * dt * 12;
        b.angVel.z -= nx * push * dt * 8;
        b.angVel.x += nz * push * dt * 8;
        b.sleeping = false;
      }

      if (b.sleeping) continue;

      // Gravity
      b.vel.y -= 13.5 * dt;

      // Integrate position
      b.pos.addScaledVector(b.vel, dt);

      // Integrate rotation via angular velocity quaternion step
      const angSpeed = b.angVel.length();
      if (angSpeed > 1e-4) {
        this._axis.copy(b.angVel).divideScalar(angSpeed);
        this._quat.setFromAxisAngle(this._axis, angSpeed * dt);
        b.mesh.quaternion.premultiply(this._quat).normalize();
      }

      // Terrain collision & slope-aware bounce
      const gy = groundHeightAt(b.pos.x, b.pos.z);
      const minY = gy + b.halfHeight;
      if (b.pos.y <= minY) {
        b.pos.y = minY;
        groundNormalAt(b.pos.x, b.pos.z, this._norm);

        const vn = b.vel.dot(this._norm);
        if (vn < -0.85) {
          // Real bounce!
          b.vel.addScaledVector(this._norm, -(1 + b.restitution) * vn);
          if (b.isThrown && b.onFirstImpact) {
            const cb = b.onFirstImpact;
            const kind = b.kind === 'stick' ? 'stick' : 'stone';
            b.onFirstImpact = undefined;
            b.isThrown = false;
            this.emitBurst(b.pos, 16, kind === 'stone' ? '#b8a88e' : '#8a5d32', 1.8, 1.5, 7.2);
            cb(b.pos.clone(), kind);
          } else if (this.elapsed - b.lastImpactSound > 0.14) {
            b.lastImpactSound = this.elapsed;
            const matKey = b.material === 'crate' ? 'wood' : b.material;
            onBodyBounce?.(matKey, Math.min(1, Math.abs(vn) / 6));
          }
        } else if (vn < 0) {
          b.vel.addScaledVector(this._norm, -vn);
        }

        // Slope rolling gravity component + ground friction
        const slopeX = this._norm.x * 8.5;
        const slopeZ = this._norm.z * 8.5;
        b.vel.x += slopeX * dt;
        b.vel.z += slopeZ * dt;

        const damp = Math.exp(-b.friction * dt);
        b.vel.x *= damp;
        b.vel.z *= damp;
        b.angVel.multiplyScalar(Math.exp(-(b.friction * 0.85) * dt));

        // Gently settle crates/barrels upright when almost stopped
        if (b.kind === 'crate' || b.kind === 'barrel') {
          if (b.vel.lengthSq() < 0.04 && b.angVel.lengthSq() < 0.08) {
            b.vel.set(0, 0, 0);
            b.angVel.set(0, 0, 0);
            b.sleeping = true;
          }
        } else if (b.vel.lengthSq() < 0.015 && b.angVel.lengthSq() < 0.04) {
          b.vel.set(0, 0, 0);
          b.angVel.set(0, 0, 0);
          b.sleeping = true;
        }
      } else {
        // Air drag
        b.vel.multiplyScalar(Math.exp(-0.25 * dt));
        b.angVel.multiplyScalar(Math.exp(-0.35 * dt));
      }

      // World collider bounce (trees, rocks, stall)
      for (const col of this.colliders) {
        if (col.box) continue;
        const dx = b.pos.x - col.x;
        const dz = b.pos.z - col.z;
        const rr = b.radius + col.r;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const nz = dz / d;
          b.pos.x = col.x + nx * rr;
          b.pos.z = col.z + nz * rr;
          const vDot = b.vel.x * nx + b.vel.z * nz;
          if (vDot < 0) {
            b.vel.x -= (1 + b.restitution) * vDot * nx;
            b.vel.z -= (1 + b.restitution) * vDot * nz;
            if (b.isThrown && b.onFirstImpact) {
              const cb = b.onFirstImpact;
              const kind = b.kind === 'stick' ? 'stick' : 'stone';
              b.onFirstImpact = undefined;
              b.isThrown = false;
              this.emitBurst(b.pos, 16, kind === 'stone' ? '#ffd280' : '#a87442', 1.9, 1.6, 7.5);
              cb(b.pos.clone(), kind);
            }
          }
        }
      }

      b.mesh.position.copy(b.pos);
    }

    // Dynamic body-to-body collisions
    for (let i = 0; i < this.bodies.length; i++) {
      const a = this.bodies[i];
      for (let j = i + 1; j < this.bodies.length; j++) {
        const b = this.bodies[j];
        if (a.sleeping && b.sleeping) continue;
        this._v1.subVectors(b.pos, a.pos);
        const minR = a.radius + b.radius;
        const distSq = this._v1.lengthSq();
        if (distSq < minR * minR && distSq > 1e-6) {
          const dist = Math.sqrt(distSq);
          this._v1.divideScalar(dist); // normal from a -> b
          const overlap = minR - dist;
          const invA = 1 / a.mass;
          const invB = 1 / b.mass;
          const invSum = invA + invB;

          a.pos.addScaledVector(this._v1, -overlap * (invA / invSum));
          b.pos.addScaledVector(this._v1, overlap * (invB / invSum));

          const relVel = this._v2.subVectors(b.vel, a.vel);
          const sepVel = relVel.dot(this._v1);
          if (sepVel < 0) {
            const e = Math.min(a.restitution, b.restitution);
            const jImp = (-(1 + e) * sepVel) / invSum;
            a.vel.addScaledVector(this._v1, -jImp * invA);
            b.vel.addScaledVector(this._v1, jImp * invB);
            a.sleeping = false;
            b.sleeping = false;
          }
          a.mesh.position.copy(a.pos);
          b.mesh.position.copy(b.pos);
        }
      }
    }

    // --- Update Particle Pool ---
    let anyDirty = false;
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      anyDirty = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.pPos[i * 3 + 1] = -999;
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(Math.pow(p.drag, dt * 60));
      p.pos.addScaledVector(p.vel, dt);

      const gy = groundHeightAt(p.pos.x, p.pos.z) + 0.02;
      if (p.pos.y < gy) {
        p.pos.y = gy;
        p.vel.y = Math.abs(p.vel.y) * p.bounce;
        p.vel.x *= 0.65;
        p.vel.z *= 0.65;
      }

      const fade = THREE.MathUtils.clamp(p.life / p.maxLife, 0, 1);
      this.pPos[i * 3] = p.pos.x;
      this.pPos[i * 3 + 1] = p.pos.y;
      this.pPos[i * 3 + 2] = p.pos.z;
      this.pCol[i * 3] = p.color.r * fade;
      this.pCol[i * 3 + 1] = p.color.g * fade;
      this.pCol[i * 3 + 2] = p.color.b * fade;
    }

    if (anyDirty) {
      this.pPoints.geometry.attributes.position.needsUpdate = true;
      this.pPoints.geometry.attributes.color.needsUpdate = true;
    }
  }
}
