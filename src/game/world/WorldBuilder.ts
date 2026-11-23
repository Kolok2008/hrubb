import * as THREE from 'three';
import type { DriedMushroomSlot, Language, QualityLevel, WorldCollider } from '../types';
import { fbm2D, mulberry32 } from '../utils/noise';
import {
  createCheckClothTexture,
  createDirtTexture,
  createForestFloorTexture,
  createFramedMapTexture,
  createLeafAtlasTexture,
  createMossTexture,
  createQuiltBlanketTexture,
  createSignTexture,
  createWickerTexture,
  createWoodGrainTexture,
  createWovenRugTexture,
  recolorFoliageTexture,
} from '../utils/textures';
import type { LoadedModels } from './modelLoader';
import { createMushroomModel } from './MushroomBuilder';
import {
  biomeNoise,
  CHUNK_GRID,
  CHUNK_SIZE,
  groundHeightAt,
  HUT_POSE,
  mossFactorAt,
  TERRAIN_SEGMENTS,
  TRAIL,
  trailDistance,
  WORLD_HALF,
  WORLD_SIZE,
} from './terrain';
import type { StoneZone } from './SurfaceDetector';

export interface TreeRecord {
  x: number;
  z: number;
  kind: 'pine' | 'decid' | 'dead';
  s: number;
}

export interface WorldData {
  terrain: THREE.Mesh;
  sky: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  hutLamp: THREE.PointLight;
  stallPos: THREE.Vector3;
  stallLantern: THREE.PointLight;
  campfirePos: THREE.Vector3;
  dryerPos: THREE.Vector3;
  menuCamPos: THREE.Vector3;
  menuCamLook: THREE.Vector3;
  syncDryingRackVisuals: (slots: DriedMushroomSlot[]) => void;
  updateSignLanguage: (lang: Language) => void;
  chunkGroups: THREE.Group[];
  colliders: WorldCollider[];
  trees: TreeRecord[];
  bushes: Array<{ x: number; y: number; z: number; r: number }>;
  stoneZones: StoneZone[];
  staticWoodObjects: THREE.Object3D[];
  fallingUpdate: (elapsed: number, dt: number, cam: THREE.Camera) => void;
  windUniform: { value: number };
  start: THREE.Vector3;
  startDir: THREE.Vector3;
  sunDir: THREE.Vector3;
  daylight: number;
  leafTex: THREE.CanvasTexture;
  updateCulling: (cam: THREE.Camera) => void;
}

interface MeshPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

function softenFoliageNormals(geo: THREE.BufferGeometry) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const midY = (bb.min.y + bb.max.y) * 0.5;
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(
      pos.getX(i),
      (pos.getY(i) - midY) * 0.8 + (bb.max.y - bb.min.y) * 0.35,
      pos.getZ(i),
    ).normalize();
    v.y = v.y * 0.6 + 0.4;
    v.normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  nrm.needsUpdate = true;
}

function extractParts(root: THREE.Object3D): MeshPart[] {
  const parts: MeshPart[] = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (/Leaves|Leaf|Grass/i.test(mat.name)) {
        softenFoliageNormals(geo);
      }
      parts.push({ geometry: geo, material: mat });
    }
  });
  return parts;
}

class ChunkInstancer {
  private readonly buckets = new Map<number, THREE.Matrix4[]>();
  constructor(
    private readonly parts: MeshPart[],
    private readonly opts: { castShadow?: boolean; receiveShadow?: boolean } = {},
  ) {}

  public add(mat4: THREE.Matrix4, x: number, z: number) {
    const cx = Math.min(CHUNK_GRID - 1, Math.max(0, Math.floor((x + WORLD_HALF) / CHUNK_SIZE)));
    const cz = Math.min(CHUNK_GRID - 1, Math.max(0, Math.floor((z + WORLD_HALF) / CHUNK_SIZE)));
    const key = cz * CHUNK_GRID + cx;
    let list = this.buckets.get(key);
    if (!list) {
      list = [];
      this.buckets.set(key, list);
    }
    list.push(mat4.clone());
  }

  public build(chunkGroups: THREE.Group[]) {
    for (const [key, matrices] of this.buckets) {
      for (const part of this.parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
        matrices.forEach((m, i) => inst.setMatrixAt(i, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = !!this.opts.castShadow;
        inst.receiveShadow = this.opts.receiveShadow !== false;
        inst.computeBoundingSphere();
        chunkGroups[key].add(inst);
      }
    }
  }
}

function buildTerrainMesh(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const blend = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, groundHeightAt(x, z));
    const td = trailDistance(x, z);
    const dirtFactor = 1 - THREE.MathUtils.smoothstep(td, 0.9, 2.3);
    blend[i * 2] = dirtFactor;
    blend[i * 2 + 1] = mossFactorAt(x, z) * (1 - dirtFactor);
  }
  geo.setAttribute('blend', new THREE.BufferAttribute(blend, 2));
  geo.computeVertexNormals();

  const floorTex = createForestFloorTexture(1024);
  const dirtTex = createDirtTexture(512);
  const mossTex = createMossTexture(512);

  const mat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.95,
    metalness: 0,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tDirt = { value: dirtTex };
    shader.uniforms.tMoss = { value: mossTex };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec2 blend;
         varying vec2 vBlend;
         varying vec2 vWorldXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vBlend = blend;
         vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D tDirt;
         uniform sampler2D tMoss;
         varying vec2 vBlend;
         varying vec2 vWorldXZ;`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 uvL = vWorldXZ / 5.5;
         vec4 cL = texture2D(map, uvL);
         vec4 cL2 = texture2D(map, vWorldXZ / 13.0 + 0.37);
         cL = mix(cL, cL2, 0.35);
         vec4 cD = texture2D(tDirt, vWorldXZ / 3.0);
         vec4 cM = texture2D(tMoss, vWorldXZ / 4.0);
         vec4 col = mix(cL, cM, vBlend.y * 0.5);
         float edge = smoothstep(0.15, 0.75, vBlend.x + (cL.r - 0.3) * 0.6);
         col = mix(col, cD, edge);
         diffuseColor *= col;`,
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildSkyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(400, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color('#7fa6c9') },
      horizon: { value: new THREE.Color('#e8c9a0') },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunCol: { value: new THREE.Color('#ffd9a0') },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 sunDir;
      uniform vec3 sunCol;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 c = mix(horizon, top, pow(max(h, 0.0), 0.55));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        c += sunCol * (pow(s, 600.0) * 6.0 + pow(s, 12.0) * 0.35);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

function buildFallingLeaves(leafTex: THREE.Texture) {
  const count = 380;
  const geo = new THREE.PlaneGeometry(0.16, 0.16);
  const mat = new THREE.MeshStandardMaterial({
    map: leafTex,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  const atlasArr = new Float32Array(count);
  const rnd = mulberry32(99);
  const state: Array<{ p: THREE.Vector3; ph: number; sp: number; spin: THREE.Vector3 }> = [];
  for (let i = 0; i < count; i++) {
    atlasArr[i] = Math.floor(rnd() * 4);
    state.push({
      p: new THREE.Vector3((rnd() - 0.5) * 50, rnd() * 14, (rnd() - 0.5) * 50),
      ph: rnd() * 10,
      sp: 0.4 + rnd() * 0.5,
      spin: new THREE.Vector3(rnd() * 3, rnd() * 3, rnd() * 3),
    });
  }
  geo.setAttribute('atlas', new THREE.InstancedBufferAttribute(atlasArr, 1));
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float atlas;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
         #ifdef USE_MAP
         vMapUv = uv * 0.5 + vec2(mod(atlas, 2.0) * 0.5, step(1.5, atlas) * 0.5);
         #endif`,
      );
  };

  const inst = new THREE.InstancedMesh(geo, mat, count);
  inst.frustumCulled = false;
  const dummy = new THREE.Object3D();

  const update = (elapsed: number, dt: number, cam: THREE.Camera) => {
    for (let i = 0; i < count; i++) {
      const f = state[i];
      f.p.y -= f.sp * dt;
      f.p.x += Math.sin(elapsed * 0.9 + f.ph) * 0.4 * dt + 0.25 * dt;
      f.p.z += Math.cos(elapsed * 0.7 + f.ph) * 0.3 * dt;
      const wx = cam.position.x + f.p.x;
      const wz = cam.position.z + f.p.z;
      const gy = groundHeightAt(wx, wz);
      if (cam.position.y - 1.6 + f.p.y < gy + 0.02 || f.p.x > 25) {
        f.p.set((Math.random() - 0.5) * 50, 10 + Math.random() * 5, (Math.random() - 0.5) * 50);
      }
      dummy.position.set(cam.position.x + f.p.x, cam.position.y - 1.6 + f.p.y, cam.position.z + f.p.z);
      dummy.rotation.set(elapsed * f.spin.x + f.ph, elapsed * f.spin.y, elapsed * f.spin.z);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
  };

  return { mesh: inst, update };
}

export function buildForestWorld(
  scene: THREE.Scene,
  models: LoadedModels,
  quality: QualityLevel,
  isSoftwareGl: boolean,
): WorldData {
  const root = new THREE.Group();
  scene.add(root);

  const chunkGroups: THREE.Group[] = [];
  for (let i = 0; i < CHUNK_GRID * CHUNK_GRID; i++) {
    const g = new THREE.Group();
    const cx = i % CHUNK_GRID;
    const cz = Math.floor(i / CHUNK_GRID);
    g.userData.center = new THREE.Vector3(
      -WORLD_HALF + (cx + 0.5) * CHUNK_SIZE,
      0,
      -WORLD_HALF + (cz + 0.5) * CHUNK_SIZE,
    );
    chunkGroups.push(g);
    root.add(g);
  }

  const terrain = buildTerrainMesh();
  root.add(terrain);

  const sky = buildSkyDome();
  scene.add(sky);

  const palettes = [
    ['#7a2c10', '#c4521a', '#e88a2a', '#f2b640'],
    ['#8c6a12', '#c99a22', '#e9c443', '#f5dc70'],
    ['#5c1a10', '#9c2e18', '#c94a20', '#e07a30'],
    ['#6a3a14', '#a8642a', '#c98a3c', '#d9a650'],
    ['#4a5a22', '#6e7a30', '#9a9040', '#b8a050'],
    ['#8a7440', '#b89a58', '#d6bc78', '#e8d496'],
  ];
  const recolorCache = new Map<string, THREE.CanvasTexture>();

  const tintFoliage = (parts: MeshPart[], palIdx: number): MeshPart[] =>
    parts.map((p) => {
      const m = p.material as THREE.MeshStandardMaterial;
      if (/Leaves|Leaf|Grass/i.test(m.name) && !/Pine/i.test(m.name) && m.map) {
        const key = m.map.uuid + '_' + palIdx;
        if (!recolorCache.has(key)) {
          recolorCache.set(key, recolorFoliageTexture(m.map, palettes[palIdx]));
        }
        const clone = m.clone();
        clone.map = recolorCache.get(key)!;
        clone.roughness = 0.85;
        if (/Grass|^Leaves$/i.test(m.name)) {
          clone.emissiveMap = clone.map;
          clone.emissive = new THREE.Color(0.32, 0.3, 0.28);
        }
        return { geometry: p.geometry, material: clone };
      }
      const clone = m.clone();
      clone.roughness = 0.9;
      clone.metalness = 0;
      return { geometry: p.geometry, material: clone };
    });

  const tintSolid = (parts: MeshPart[], hex: string): MeshPart[] =>
    parts.map((p) => {
      const m = (p.material as THREE.MeshStandardMaterial).clone();
      m.color = new THREE.Color(hex);
      m.roughness = 0.9;
      return { geometry: p.geometry, material: m };
    });

  const getParts = (name: string) => extractParts(models[name].scene);

  const treeSets = {
    pine: [1, 2, 3, 4, 5].map((i) => ({ parts: getParts('Pine_' + i), r: 0.45 })),
    decid: [] as Array<{ parts: MeshPart[]; r: number }>,
    dead: [{ parts: getParts('DeadTree_1'), r: 0.4 }],
  };
  for (const name of ['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'TwistedTree_1', 'TwistedTree_2']) {
    for (let pal = 0; pal < 3; pal++) {
      treeSets.decid.push({ parts: tintFoliage(getParts(name), pal), r: 0.4 });
    }
  }

  const colliders: WorldCollider[] = [];
  const trees: TreeRecord[] = [];
  const bushes: Array<{ x: number; y: number; z: number; r: number }> = [];
  const stoneZones: StoneZone[] = [];
  const rnd = mulberry32(2024);

  // Precompute homestead clearing anchors BEFORE scattering trees, rocks, bushes, and leaves
  // so no boulder, bush, or weed ever clips into the campfire, drying rack, stall, hut, or menu camera.
  const start = TRAIL.samples[0].clone();
  const startDir = TRAIL.samples[6].clone().sub(start).normalize();
  const right = new THREE.Vector3(-startDir.z, 0, startDir.x);

  const cfX = start.x + right.x * 1.45 + startDir.x * 2.7;
  const cfZ = start.z + right.z * 1.45 + startDir.z * 2.7;
  const benchX = start.x + right.x * 0.25 + startDir.x * 4.35;
  const benchZ = start.z + right.z * 0.25 + startDir.z * 4.35;
  const drX = start.x + right.x * 3.85 + startDir.x * 4.25;
  const drZ = start.z + right.z * 3.85 + startDir.z * 4.25;
  const cbX = start.x + right.x * 2.95 + startDir.x * 1.15;
  const cbZ = start.z + right.z * 2.95 + startDir.z * 1.15;
  const sx = start.x - right.x * 4.5 + startDir.x * 1.5;
  const sz = start.z - right.z * 4.5 + startDir.z * 1.5;
  const wagonX = start.x - right.x * 5.5 - startDir.x * 1.0;
  const wagonZ = start.z - right.z * 5.5 - startDir.z * 1.0;
  const menuCamX = start.x - right.x * 1.95 + startDir.x * 6.55;
  const menuCamZ = start.z - right.z * 1.95 + startDir.z * 6.55;

  const isPropBlockedByCamp = (x: number, z: number, isRock: boolean, isGrass: boolean): boolean => {
    if (isGrass) {
      if (Math.hypot(x - HUT_POSE.x, z - HUT_POSE.z) < 3.6) return true;
      if (Math.hypot(x - cfX, z - cfZ) < 2.2) return true;
      if (Math.hypot(x - sx, z - sz) < 2.1) return true;
      if (Math.hypot(x - drX, z - drZ) < 1.7) return true;
      if (Math.hypot(x - benchX, z - benchZ) < 1.35) return true;
      if (Math.hypot(x - cbX, z - cbZ) < 1.1) return true;
      return false;
    }
    // Rocks, bushes, ferns, and pebbles stay cleanly outside the homestead clearing & campfire yard
    if (Math.hypot(x - HUT_POSE.x, z - HUT_POSE.z) < (isRock ? 7.2 : 6.0)) return true;
    if (Math.hypot(x - start.x, z - start.z) < (isRock ? 9.8 : 7.4)) return true;
    if (Math.hypot(x - cfX, z - cfZ) < (isRock ? 4.8 : 3.4)) return true;
    if (Math.hypot(x - drX, z - drZ) < (isRock ? 3.5 : 2.5)) return true;
    if (Math.hypot(x - benchX, z - benchZ) < (isRock ? 2.8 : 2.1)) return true;
    if (Math.hypot(x - sx, z - sz) < (isRock ? 3.8 : 2.8)) return true;
    if (Math.hypot(x - wagonX, z - wagonZ) < (isRock ? 3.4 : 2.6)) return true;
    if (Math.hypot(x - cbX, z - cbZ) < 2.2) return true;
    if (Math.hypot(x - menuCamX, z - menuCamZ) < (isRock ? 3.2 : 2.4)) return true;
    return false;
  };

  const treeTarget = { low: 520, medium: 760, high: 980 }[quality];
  const treeInstancers = new Map<object, ChunkInstancer>();
  const getInst = (entry: { parts: MeshPart[] }) => {
    let inst = treeInstancers.get(entry);
    if (!inst) {
      inst = new ChunkInstancer(entry.parts, { castShadow: true });
      treeInstancers.set(entry, inst);
    }
    return inst;
  };

  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const upAxis = new THREE.Vector3(0, 1, 0);

  let placed = 0;
  let attempts = 0;
  while (placed < treeTarget && attempts++ < treeTarget * 20) {
    const x = (rnd() - 0.5) * (WORLD_SIZE - 8);
    const z = (rnd() - 0.5) * (WORLD_SIZE - 8);
    if (
      trailDistance(x, z) < 3.2 ||
      Math.hypot(x - HUT_POSE.x, z - HUT_POSE.z) < 9 ||
      Math.hypot(x - TRAIL.samples[0].x, z - TRAIL.samples[0].z) < 14
    ) {
      continue;
    }
    let ok = true;
    for (const c of colliders) {
      if ((c.x - x) ** 2 + (c.z - z) ** 2 < 9) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const bVal = fbm2D(biomeNoise, x * 0.012 + 9, z * 0.012, 2);
    const pick = rnd();
    let entry: { parts: MeshPart[]; r: number };
    let kind: 'pine' | 'decid' | 'dead';
    if (pick < 0.03) {
      entry = treeSets.dead[0];
      kind = 'dead';
    } else if (bVal > 0.1 ? pick < 0.65 : pick < 0.25) {
      entry = treeSets.pine[Math.floor(rnd() * 5)];
      kind = 'pine';
    } else {
      entry = treeSets.decid[Math.floor(rnd() * treeSets.decid.length)];
      kind = 'decid';
    }

    const s = (kind === 'pine' ? 1 : 1.15) * (0.8 + rnd() * 0.55);
    const y = groundHeightAt(x, z) - 0.1;
    quat.setFromAxisAngle(upAxis, rnd() * Math.PI * 2);
    mat4.compose(pos.set(x, y, z), quat, scl.set(s, s * (0.9 + rnd() * 0.2), s));
    getInst(entry).add(mat4, x, z);
    colliders.push({ x, z, r: entry.r * s + 0.15, kind: 'tree', y });
    trees.push({ x, z, kind, s });
    placed++;
  }

  // Scatter bushes, ferns, grass, rocks, pebbles, clover
  const propDefs = [
    { parts: tintFoliage(getParts('Fern_1'), 3), n: 820, s: [0.6, 1.1], shadow: false, bush: true },
    { parts: tintFoliage(getParts('Fern_1'), 4), n: 460, s: [0.6, 1.0], shadow: false, bush: true },
    { parts: tintFoliage(getParts('Bush_Common'), 0), n: 240, s: [0.7, 1.2], shadow: true, bush: true },
    { parts: tintFoliage(getParts('Bush_Common'), 2), n: 190, s: [0.7, 1.2], shadow: true, bush: true },
    { parts: tintFoliage(getParts('Grass_Wispy_Tall'), 5), n: 3600, s: [0.35, 0.6], shadow: false, wind: true },
    { parts: tintFoliage(getParts('Grass_Wispy_Short'), 5), n: 3600, s: [0.4, 0.7], shadow: false, wind: true },
    { parts: tintFoliage(getParts('Grass_Common_Short'), 4), n: 1400, s: [0.4, 0.7], shadow: false, wind: true },
    { parts: tintSolid(getParts('Rock_Medium_1'), '#b8aa98'), n: 70, s: [0.5, 1.4], shadow: true, rock: true },
    { parts: tintSolid(getParts('Rock_Medium_2'), '#a89c8c'), n: 70, s: [0.5, 1.4], shadow: true, rock: true },
    { parts: tintSolid(getParts('Rock_Medium_3'), '#b0a490'), n: 60, s: [0.5, 1.2], shadow: true, rock: true },
    { parts: tintSolid(getParts('Pebble_Round_1'), '#c8b8a0'), n: 240, s: [0.5, 1], shadow: false, path: true },
    { parts: tintSolid(getParts('Pebble_Round_2'), '#bfae96'), n: 240, s: [0.5, 1], shadow: false, path: true },
    { parts: getParts('Clover_1'), n: 360, s: [0.6, 1], shadow: false },
  ];

  const densityScale = { low: 0.55, medium: 0.95, high: 1.35 }[quality];
  const windMats = new Set<THREE.Material>();

  for (const def of propDefs) {
    if (def.wind) def.parts.forEach((p) => windMats.add(p.material));
    const inst = new ChunkInstancer(def.parts, { castShadow: def.shadow });
    const count = Math.round(def.n * (def.rock ? 1 : densityScale));
    for (let i = 0; i < count; i++) {
      let x = 0;
      let z = 0;
      let td = 0;
      let tries = 0;
      do {
        x = (rnd() - 0.5) * (WORLD_SIZE - 10);
        z = (rnd() - 0.5) * (WORLD_SIZE - 10);
        td = trailDistance(x, z);
        tries++;
      } while (tries < 20 && (def.path ? td > 2 || td < 0.6 : td < 1.8));

      const s = def.s[0] + rnd() * (def.s[1] - def.s[0]);
      if (isPropBlockedByCamp(x, z, Boolean(def.rock), Boolean(def.wind))) continue;
      const y = groundHeightAt(x, z) - (def.rock ? 0.25 * s : 0.02);
      quat.setFromAxisAngle(upAxis, rnd() * Math.PI * 2);
      mat4.compose(pos.set(x, y, z), quat, scl.set(s, s, s));
      inst.add(mat4, x, z);

      if (def.rock) {
        stoneZones.push({ x, z, r: 0.9 * s, kind: 'rock' });
        if (s > 0.75) {
          colliders.push({ x, z, r: 0.9 * s, kind: 'rock', y });
        }
      }
      if (def.path) {
        stoneZones.push({ x, z, r: 0.45 * s, kind: 'pebble' });
      }
      if (def.bush && Math.random() < 0.75) {
        bushes.push({ x, y, z, r: 0.55 * s });
      }
    }
    inst.build(chunkGroups);
  }

  for (const inst of treeInstancers.values()) inst.build(chunkGroups);

  // Wind sway shader injection for grass
  const windUniform = { value: 0 };
  for (const m of windMats) {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uWind = windUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uWind;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vec4 wp = instanceMatrix * vec4(position, 1.0);
           float sway = sin(uWind * 1.7 + wp.x * 0.35 + wp.z * 0.27) * 0.5 + sin(uWind * 3.1 + wp.x * 0.9) * 0.2;
           transformed.x += sway * position.y * 0.18;
           transformed.z += sway * position.y * 0.10;`,
        );
    };
  }

  // Scattered ground autumn leaves
  const leafTex = createLeafAtlasTexture();
  {
    const leafCount = Math.round(7500 * densityScale);
    const leafGeo = new THREE.PlaneGeometry(0.22, 0.22);
    leafGeo.rotateX(-Math.PI / 2);
    const leafMat = new THREE.MeshStandardMaterial({
      map: leafTex,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.95,
    });
    leafMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float atlas;')
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
           #ifdef USE_MAP
           vMapUv = uv * 0.5 + vec2(mod(atlas, 2.0) * 0.5, step(1.5, atlas) * 0.5);
           #endif`,
        );
    };
    const buckets = new Map<number, Array<[THREE.Matrix4, number]>>();
    const eul = new THREE.Euler();
    for (let i = 0; i < leafCount; i++) {
      let x: number;
      let z: number;
      if (i % 3 === 0) {
        const samp = TRAIL.samples[Math.floor(rnd() * TRAIL.samples.length)];
        x = samp.x + (rnd() - 0.5) * 6;
        z = samp.z + (rnd() - 0.5) * 6;
      } else {
        x = (rnd() - 0.5) * WORLD_SIZE;
        z = (rnd() - 0.5) * WORLD_SIZE;
      }
      if (Math.hypot(x - HUT_POSE.x, z - HUT_POSE.z) < 2.65 || Math.hypot(x - cfX, z - cfZ) < 1.35) {
        continue;
      }
      const y = groundHeightAt(x, z) + 0.03;
      eul.set((rnd() - 0.5) * 0.5, rnd() * 6.28, (rnd() - 0.5) * 0.5);
      quat.setFromEuler(eul);
      const s = 0.7 + rnd() * 0.8;
      mat4.compose(pos.set(x, y, z), quat, scl.set(s, s, s));
      const cx = Math.min(CHUNK_GRID - 1, Math.max(0, Math.floor((x + WORLD_HALF) / CHUNK_SIZE)));
      const cz = Math.min(CHUNK_GRID - 1, Math.max(0, Math.floor((z + WORLD_HALF) / CHUNK_SIZE)));
      const key = cz * CHUNK_GRID + cx;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push([mat4.clone(), Math.floor(rnd() * 4)]);
    }
    for (const [key, list] of buckets) {
      const g = leafGeo.clone();
      g.setAttribute('atlas', new THREE.InstancedBufferAttribute(new Float32Array(list.map((it) => it[1])), 1));
      const inst = new THREE.InstancedMesh(g, leafMat, list.length);
      list.forEach((it, idx) => inst.setMatrixAt(idx, it[0]));
      inst.instanceMatrix.needsUpdate = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      chunkGroups[key].add(inst);
    }
  }

  const falling = buildFallingLeaves(leafTex);
  scene.add(falling.mesh);

  // --- Village Clearing: Hut, Wagon, Wooden Fence, Buyer Stall ---
  const staticWoodObjects: THREE.Object3D[] = [];

  const placeProp = (
    name: string,
    offR: number,
    offF: number,
    rotOff: number,
    scale = 1,
    cast = true,
  ) => {
    const obj = models[name].scene.clone(true);
    const x = start.x + right.x * offR + startDir.x * offF;
    const z = start.z + right.z * offR + startDir.z * offF;
    obj.position.set(x, groundHeightAt(x, z) - 0.05, z);
    obj.rotation.y = Math.atan2(startDir.x, startDir.z) + rotOff;
    obj.scale.setScalar(scale);
    obj.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        c.castShadow = cast;
        c.receiveShadow = true;
      }
    });
    root.add(obj);
    staticWoodObjects.push(obj);
    return obj;
  };

  // Hut
  const hut = models.Hut.scene.clone(true);
  hut.position.set(HUT_POSE.x, HUT_POSE.y, HUT_POSE.z);
  hut.rotation.y = HUT_POSE.rot;
  hut.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  root.add(hut);
  staticWoodObjects.push(hut);
  hut.updateMatrixWorld(true);
  const door = hut.getObjectByName('Door_1_Flat');
  if (door) door.rotation.y = 1.35;

  for (const [cx, cz, hw, hd] of [
    [0, -2, 2.1, 0.2],
    [-2, 0, 0.2, 2.1],
    [2, 0, 0.2, 2.1],
    [0.8, 2, 1.3, 0.2],
    [-1.85, 2, 0.25, 0.2],
  ]) {
    colliders.push({ box: true, x: HUT_POSE.x, z: HUT_POSE.z, rot: HUT_POSE.rot, cx, cz, hw, hd, r: 0, kind: 'hut' });
  }

  const hutLocalToWorld = (lx: number, lz: number) =>
    new THREE.Vector3(lx, 0, lz)
      .applyAxisAngle(upAxis, HUT_POSE.rot)
      .add(new THREE.Vector3(HUT_POSE.x, HUT_POSE.y, HUT_POSE.z));

  // --- Cozy Furnished Forester's Cabin Interior ---
  const inner = new THREE.Group();
  inner.position.set(HUT_POSE.x, HUT_POSE.y, HUT_POSE.z);
  inner.rotation.y = HUT_POSE.rot;
  root.add(inner);

  const darkOakTex = createWoodGrainTexture('#4e2e19');
  const warmTimberTex = createWoodGrainTexture('#784c2a');
  const bedFrameMat = new THREE.MeshStandardMaterial({ map: darkOakTex, roughness: 0.82 });
  const woodFurnMat = new THREE.MeshStandardMaterial({ map: warmTimberTex, roughness: 0.84 });
  const woodLightMat = new THREE.MeshStandardMaterial({ color: '#9c6c40', roughness: 0.8 });
  const linenMat = new THREE.MeshStandardMaterial({ color: '#eee6d4', roughness: 0.94 });
  const sheetCuffMat = new THREE.MeshStandardMaterial({ color: '#f6f0e2', roughness: 0.92 });
  const quiltMat = new THREE.MeshStandardMaterial({ map: createQuiltBlanketTexture(), roughness: 0.95 });
  const checkMat = new THREE.MeshStandardMaterial({ map: createCheckClothTexture(), roughness: 0.92 });
  const rugMat = new THREE.MeshStandardMaterial({ map: createWovenRugTexture(), roughness: 0.96 });
  const mapArtMat = new THREE.MeshStandardMaterial({ map: createFramedMapTexture(), roughness: 0.88 });
  const wickerCabMat = new THREE.MeshStandardMaterial({ map: createWickerTexture(), roughness: 0.9 });
  const brassMat = new THREE.MeshStandardMaterial({ color: '#c89b44', metalness: 0.78, roughness: 0.3 });
  const ironCabMat = new THREE.MeshStandardMaterial({ color: '#2b2d32', metalness: 0.72, roughness: 0.45 });
  const ceramicMat = new THREE.MeshStandardMaterial({ color: '#b55c38', roughness: 0.55 });
  const creamCeramicMat = new THREE.MeshStandardMaterial({ color: '#dfd3bc', roughness: 0.5 });
  const glassJarMat = new THREE.MeshStandardMaterial({
    color: '#d9ece5',
    transparent: true,
    opacity: 0.42,
    roughness: 0.14,
    metalness: 0.08,
  });
  const lanternGlowMat = new THREE.MeshStandardMaterial({
    color: '#fff1c4',
    emissive: '#ffb248',
    emissiveIntensity: 2.2,
    roughness: 0.25,
  });
  const candleWaxMat = new THREE.MeshStandardMaterial({ color: '#f2e4c2', roughness: 0.7 });
  const candleFlameMat = new THREE.MeshBasicMaterial({ color: '#ffd978' });
  const leatherBookMat = new THREE.MeshStandardMaterial({ color: '#4d2318', roughness: 0.85 });
  const paperPageMat = new THREE.MeshStandardMaterial({ color: '#f2e6ca', roughness: 0.92 });
  const whetstoneMat = new THREE.MeshStandardMaterial({ color: '#6b6d70', roughness: 0.88 });

  const addCabMesh = (mesh: THREE.Mesh, x: number, y: number, z: number, cast = true) => {
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    inner.add(mesh);
    return mesh;
  };
  const addBox = (
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    cast = true,
  ) => addCabMesh(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), x, y, z, cast);

  // 1. Handcrafted Rustic Wooden Bed (x = 1.32, z = -0.75)
  const bedX = 1.32;
  const bedZ = -0.75;
  const bedW = 0.96;
  const bedL = 1.94;
  // Four turned wooden posts with finial spheres (taller headboard posts at z = -1.72, lower footboard at z = +0.22)
  const postCorners: Array<[number, number, number]> = [
    [bedX - bedW / 2, bedZ - bedL / 2, 1.18],
    [bedX + bedW / 2, bedZ - bedL / 2, 1.18],
    [bedX - bedW / 2, bedZ + bedL / 2, 0.72],
    [bedX + bedW / 2, bedZ + bedL / 2, 0.72],
  ];
  for (const [px, pz, ph] of postCorners) {
    addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.044, ph, 12), bedFrameMat), px, ph / 2, pz);
    // Decorative brass collar + turned wooden finial knob
    addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.025, 12), brassMat), px, ph + 0.005, pz, false);
    addCabMesh(new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 10), bedFrameMat), px, ph + 0.055, pz);
  }
  // Carved headboard (top sculpted cap rail, lower cross rail, decorative vertical spindle slats)
  addBox(bedW, 0.09, 0.055, bedFrameMat, bedX, 1.08, bedZ - bedL / 2);
  addBox(bedW + 0.06, 0.045, 0.075, woodLightMat, bedX, 1.14, bedZ - bedL / 2);
  addBox(bedW, 0.07, 0.045, bedFrameMat, bedX, 0.56, bedZ - bedL / 2);
  for (let i = -3; i <= 3; i++) {
    addCabMesh(
      new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.5, 8), woodLightMat),
      bedX + i * 0.115,
      0.82,
      bedZ - bedL / 2,
    );
  }
  // Matching footboard with rails and slats
  addBox(bedW, 0.07, 0.05, bedFrameMat, bedX, 0.65, bedZ + bedL / 2);
  addBox(bedW, 0.06, 0.045, bedFrameMat, bedX, 0.32, bedZ + bedL / 2);
  for (let i = -3; i <= 3; i++) {
    addBox(0.04, 0.3, 0.024, woodLightMat, bedX + i * 0.12, 0.48, bedZ + bedL / 2);
  }
  // Side timber rails + recessed under-bed storage drawer with brass handles
  addBox(0.055, 0.14, bedL, bedFrameMat, bedX - bedW / 2, 0.29, bedZ);
  addBox(0.055, 0.14, bedL, bedFrameMat, bedX + bedW / 2, 0.29, bedZ);
  addBox(bedW - 0.06, 0.04, bedL - 0.06, bedFrameMat, bedX, 0.26, bedZ);
  addBox(0.88, 0.18, 1.25, woodFurnMat, bedX - 0.02, 0.12, bedZ + 0.05);
  for (const dz of [bedZ - 0.25, bedZ + 0.35]) {
    addCabMesh(new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), brassMat), bedX - 0.47, 0.13, dz, false);
  }
  // Plump rounded linen mattress
  addBox(0.88, 0.15, 1.84, linenMat, bedX, 0.37, bedZ);
  const edgeCylGeo = new THREE.CylinderGeometry(0.074, 0.074, 1.82, 10);
  const leftEdge = addCabMesh(new THREE.Mesh(edgeCylGeo, linenMat), bedX - 0.44, 0.37, bedZ);
  leftEdge.rotation.x = Math.PI / 2;
  const rightEdge = addCabMesh(new THREE.Mesh(edgeCylGeo, linenMat), bedX + 0.44, 0.37, bedZ);
  rightEdge.rotation.x = Math.PI / 2;

  // Quilted autumn plaid blanket covering lower 68% of mattress + folded crisp cream sheet cuff + side drape
  addBox(0.94, 0.085, 1.26, quiltMat, bedX, 0.465, bedZ + 0.26);
  // Softly draped blanket overhang on the visible left side & foot end
  addBox(0.045, 0.24, 1.26, quiltMat, bedX - 0.475, 0.375, bedZ + 0.26);
  addBox(0.94, 0.19, 0.045, quiltMat, bedX, 0.385, bedZ + 0.89);
  // Folded-back top cotton sheet cuff along the upper edge of the quilt
  const cuff = addCabMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.94, 12), sheetCuffMat),
    bedX,
    0.475,
    bedZ - 0.37,
  );
  cuff.rotation.z = Math.PI / 2;
  addBox(0.94, 0.045, 0.16, sheetCuffMat, bedX, 0.478, bedZ - 0.41);

  // Two plush sculpted pillows angled warmly against the headboard
  const pillowGeo = new THREE.SphereGeometry(0.24, 16, 12);
  const mainPillow = addCabMesh(new THREE.Mesh(pillowGeo, sheetCuffMat), bedX + 0.03, 0.56, bedZ - 0.72);
  mainPillow.scale.set(1.58, 0.48, 0.88);
  mainPillow.rotation.x = 0.32;
  const accentPillow = addCabMesh(new THREE.Mesh(pillowGeo, checkMat), bedX - 0.06, 0.54, bedZ - 0.52);
  accentPillow.scale.set(1.22, 0.42, 0.68);
  accentPillow.rotation.set(0.55, 0.14, 0.06);

  // 2. Woven Folk Rug centered on the cabin floor
  addBox(1.48, 0.016, 2.1, rugMat, -0.04, 0.012, 0.12, false);

  // 3. Bedside Nightstand between bed & workbench with glowing beeswax candle & brass watch
  const nsX = 0.42;
  const nsZ = -1.6;
  addBox(0.52, 0.045, 0.46, bedFrameMat, nsX, 0.58, nsZ);
  addBox(0.46, 0.46, 0.4, woodFurnMat, nsX, 0.33, nsZ);
  addBox(0.38, 0.15, 0.025, woodLightMat, nsX, 0.44, nsZ + 0.2);
  addCabMesh(new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), brassMat), nsX, 0.44, nsZ + 0.225, false);
  // Brass saucer + glowing beeswax candle
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.016, 12), brassMat), nsX + 0.08, 0.61, nsZ + 0.04, false);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.12, 10), candleWaxMat), nsX + 0.08, 0.675, nsZ + 0.04, false);
  const flame = addCabMesh(new THREE.Mesh(new THREE.ConeGeometry(0.015, 0.042, 8), candleFlameMat), nsX + 0.08, 0.755, nsZ + 0.04, false);
  flame.rotation.z = 0.06;
  // Small vintage brass pocket clock beside candle
  const clockBody = addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.025, 14), brassMat), nsX - 0.11, 0.64, nsZ + 0.06, false);
  clockBody.rotation.x = Math.PI / 2 - 0.22;
  const clockFace = addCabMesh(new THREE.Mesh(new THREE.CircleGeometry(0.036, 12), paperPageMat), nsX - 0.11, 0.643, nsZ + 0.075, false);
  clockFace.rotation.x = -0.22;

  // 4. Forester's Crafted Workbench (-1.2, -1.5) with open atlas book, brass table lantern, whetstone & mushrooms
  addBox(1.44, 0.075, 0.74, bedFrameMat, -1.2, 0.85, -1.5);
  addBox(1.26, 0.045, 0.56, woodFurnMat, -1.2, 0.28, -1.5); // lower storage shelf
  for (const [lx, lz] of [
    [-1.82, -1.78],
    [-0.58, -1.78],
    [-1.82, -1.22],
    [-0.58, -1.22],
  ]) {
    addBox(0.075, 0.84, 0.075, bedFrameMat, lx, 0.42, lz);
  }
  // Open Mushroom Atlas ledger on the left side of the workbench
  addBox(0.42, 0.022, 0.3, leatherBookMat, -1.52, 0.898, -1.46);
  const leftPage = addBox(0.19, 0.018, 0.27, paperPageMat, -1.62, 0.912, -1.46, false);
  leftPage.rotation.z = 0.06;
  const rightPage = addBox(0.19, 0.018, 0.27, paperPageMat, -1.42, 0.912, -1.46, false);
  rightPage.rotation.z = -0.06;
  // Glowing Brass Oil Lantern on the right side of the workbench
  const tlX = -0.72;
  const tlZ = -1.62;
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.055, 12), brassMat), tlX, 0.915, tlZ);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.15, 12), lanternGlowMat), tlX, 1.01, tlZ, false);
  addCabMesh(new THREE.Mesh(new THREE.ConeGeometry(0.088, 0.065, 12), brassMat), tlX, 1.115, tlZ);
  // Wooden cutting board + specimen mushrooms + whetstone + terracotta mug on the workbench
  addBox(0.32, 0.022, 0.24, woodLightMat, -1.08, 0.898, -1.42);
  const benchPorcini = createMushroomModel('porcini', 21);
  benchPorcini.position.set(-1.14, 0.91, -1.42);
  benchPorcini.scale.setScalar(1.05);
  benchPorcini.rotation.z = 0.35;
  inner.add(benchPorcini);
  const benchChant = createMushroomModel('chanterelle', 22);
  benchChant.position.set(-0.99, 0.91, -1.39);
  benchChant.scale.setScalar(1.1);
  inner.add(benchChant);
  addBox(0.16, 0.036, 0.065, whetstoneMat, -1.2, 0.905, -1.7);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.036, 0.095, 12), ceramicMat), -0.68, 0.935, -1.32);
  // Woven wicker basket resting on lower workbench shelf
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.16, 0.22, 14), wickerCabMat), -1.42, 0.41, -1.5);
  addBox(0.32, 0.14, 0.28, checkMat, -0.92, 0.37, -1.5); // folded spare cloth bundle

  // 5. Three-legged Wooden Stool tucked beside the workbench
  const stX = -0.35;
  const stZ = -1.32;
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.175, 0.045, 14), woodLightMat), stX, 0.46, stZ);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.35;
    const leg = addCabMesh(
      new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.46, 8), bedFrameMat),
      stX + Math.cos(a) * 0.11,
      0.23,
      stZ + Math.sin(a) * 0.11,
    );
    leg.rotation.z = -Math.cos(a) * 0.14;
    leg.rotation.x = Math.sin(a) * 0.14;
  }

  // 6. Wall-Mounted Timber Shelves stocked with pickled mushroom jars, mugs & teapot
  const addWallShelf = (x: number, y: number, z: number, w: number, d: number, alongZ = false) => {
    addBox(alongZ ? d : w, 0.038, alongZ ? w : d, woodFurnMat, x, y, z);
    for (const off of [-w * 0.35, w * 0.35]) {
      const bx = alongZ ? x : x + off;
      const bz = alongZ ? z + off : z;
      addBox(alongZ ? d * 0.7 : 0.04, 0.12, alongZ ? 0.04 : d * 0.7, bedFrameMat, bx, y - 0.07, bz);
    }
  };
  // Back-wall shelves above workbench
  addWallShelf(-1.2, 1.46, -1.84, 1.24, 0.24, false);
  addWallShelf(-1.2, 1.88, -1.84, 1.05, 0.22, false);
  // Pickled & dried mushroom glass jars on lower back shelf
  for (const [jx, sp, jh] of [
    [-1.62, 'chanterelle', 0.2],
    [-1.38, 'porcini', 0.24],
    [-1.12, 'flyagaric', 0.21],
  ] as const) {
    addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, jh, 12), glassJarMat), jx, 1.48 + jh / 2, -1.83, false);
    addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.064, 0.028, 12), woodLightMat), jx, 1.49 + jh, -1.83, false);
    const jarMush = createMushroomModel(sp, 70 + Math.round(jx * -10));
    jarMush.position.set(jx, 1.49, -1.83);
    jarMush.scale.setScalar(0.68);
    inner.add(jarMush);
  }
  // Iron teapot & ceramic mugs on shelves
  addCabMesh(new THREE.Mesh(new THREE.SphereGeometry(0.088, 12, 10), ironCabMat), -0.78, 1.56, -1.82);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.048, 0.03, 10), brassMat), -0.78, 1.65, -1.82, false);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.036, 0.09, 10), creamCeramicMat), -1.52, 1.945, -1.83, false);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.036, 0.09, 10), ceramicMat), -1.36, 1.945, -1.83, false);
  addBox(0.32, 0.08, 0.16, checkMat, -0.96, 1.94, -1.83);

  // Left-wall shelf (x = -1.84, z = 0.35) with stacked bowls & mushroom jars
  addWallShelf(-1.84, 1.42, 0.38, 0.92, 0.24, true);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.06, 0.065, 14), creamCeramicMat), -1.83, 1.47, 0.14);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.052, 0.06, 14), ceramicMat), -1.83, 1.53, 0.14);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.22, 12), glassJarMat), -1.83, 1.55, 0.45, false);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.028, 12), woodLightMat), -1.83, 1.67, 0.45, false);
  const sideJarM = createMushroomModel('birch', 88);
  sideJarM.position.set(-1.83, 1.45, 0.45);
  sideJarM.scale.setScalar(0.66);
  inner.add(sideJarM);

  // 7. Framed Vintage Forest Trail Map on Left Wall (-1.91, 1.55, -0.68)
  addBox(0.045, 0.62, 0.8, bedFrameMat, -1.92, 1.56, -0.68);
  const mapPlane = addCabMesh(new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.52), mapArtMat), -1.894, 1.56, -0.68, false);
  mapPlane.rotation.y = Math.PI / 2;

  // 8. Coat/Gear Peg Rack on Left Wall near door (-1.91, 1.52, 1.25) with hanging wicker basket
  addBox(0.04, 0.1, 0.65, bedFrameMat, -1.92, 1.55, 1.25);
  for (const pz of [1.04, 1.25, 1.46]) {
    const peg = addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.09, 8), woodLightMat), -1.86, 1.55, pz, false);
    peg.rotation.z = Math.PI / 2;
  }
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.11, 0.18, 12), wickerCabMat), -1.78, 1.32, 1.25);

  // 9. Corner Firewood Stack & Spare Harvest Basket (front-right corner, clear of bed approach)
  const fwX = 1.48;
  const fwZ = 1.48;
  const endGrainCabMat = new THREE.MeshStandardMaterial({ color: '#d4b082', roughness: 0.85 });
  const fwLogGeo = new THREE.CylinderGeometry(0.068, 0.074, 0.5, 10);
  const fwOffsets: Array<[number, number, number]> = [
    [0, 0.07, 0],
    [0.15, 0.07, 0.02],
    [-0.15, 0.07, -0.02],
    [0.08, 0.19, 0.01],
    [-0.08, 0.19, -0.01],
    [0, 0.3, 0],
  ];
  for (const [ox, oy, oz] of fwOffsets) {
    const log = addCabMesh(
      new THREE.Mesh(fwLogGeo, [bedFrameMat, endGrainCabMat, endGrainCabMat]),
      fwX + ox,
      oy,
      fwZ + oz,
    );
    log.rotation.x = Math.PI / 2;
  }
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.26, 14), wickerCabMat), 1.52, 0.13, 0.92);

  // 10. Hanging Wrought-Iron & Warm-Glass Ceiling Lantern around hutLamp
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.42, 6), ironCabMat), 0, 2.52, 0, false);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.04, 10), ironCabMat), 0, 2.34, 0, false);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.09, 0.22, 10), lanternGlowMat), 0, 2.21, 0, false);
  addCabMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.095, 0.035, 10), ironCabMat), 0, 2.09, 0, false);

  const hutLamp = new THREE.PointLight('#ffc478', 6.8, 8.8, 1.5);
  hutLamp.position.set(0, 2.15, 0);
  inner.add(hutLamp);

  colliders.push({ box: true, x: HUT_POSE.x, z: HUT_POSE.z, rot: HUT_POSE.rot, cx: 1.32, cz: -0.75, hw: 0.52, hd: 1.0, r: 0, kind: 'furniture' });
  colliders.push({ box: true, x: HUT_POSE.x, z: HUT_POSE.z, rot: HUT_POSE.rot, cx: -1.2, cz: -1.5, hw: 0.72, hd: 0.38, r: 0, kind: 'furniture' });
  colliders.push({ box: true, x: HUT_POSE.x, z: HUT_POSE.z, rot: HUT_POSE.rot, cx: 0.42, cz: -1.6, hw: 0.28, hd: 0.25, r: 0, kind: 'furniture' });
  colliders.push({ box: true, x: HUT_POSE.x, z: HUT_POSE.z, rot: HUT_POSE.rot, cx: 1.48, cz: 1.45, hw: 0.34, hd: 0.34, r: 0, kind: 'furniture' });
  HUT_POSE.bed = hutLocalToWorld(1.32, 0.42);
  HUT_POSE.bench = hutLocalToWorld(-1.2, -0.88);
  HUT_POSE.inner = inner;

  // Wagon & fence posts
  placeProp('Prop_Wagon', -5.5, -1, 0.4);
  colliders.push({
    x: start.x - right.x * 5.5 - startDir.x * 1.0,
    z: start.z - right.z * 5.5 - startDir.z * 1.0,
    r: 1.8,
    kind: 'wagon',
  });
  placeProp('Prop_WoodenFence_Single', 5.6, 4.5, 0.15, 1.0);
  placeProp('Prop_WoodenFence_Single', 5.8, 6.8, -0.05, 1.0);

  // Buyer Stall ("СКУПКА ГРИБІВ")
  const sy = groundHeightAt(sx, sz);
  const stall = new THREE.Group();
  stall.position.set(sx, sy, sz);
  stall.rotation.y = Math.atan2(right.x, right.z);

  const postMat = new THREE.MeshStandardMaterial({ color: '#7a5030', roughness: 0.9 });
  for (const px of [-0.9, 0.9]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.3, 0.1), postMat);
    post.position.set(px, 1.15, 0);
    stall.add(post);
  }
  const signMat = new THREE.MeshStandardMaterial({ map: createSignTexture('СКУПКА ГРИБІВ'), roughness: 0.8 });
  const sign = new THREE.Mesh(new THREE.BoxGeometry(2, 0.62, 0.06), [
    postMat,
    postMat,
    postMat,
    postMat,
    signMat,
    postMat,
  ]);
  sign.position.set(0, 2.05, 0.04);
  stall.add(sign);

  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.9, 0.55),
    new THREE.MeshStandardMaterial({ color: '#8a5a34', roughness: 0.85 }),
  );
  counter.position.set(0, 0.45, 0.1);
  stall.add(counter);

  const scalePan = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 0.03, 20),
    new THREE.MeshStandardMaterial({ color: '#b8a070', metalness: 0.72, roughness: 0.34 }),
  );
  scalePan.position.set(-0.5, 0.95, 0.1);
  stall.add(scalePan);

  for (const [mx, sp] of [
    [0.1, 'chanterelle'],
    [0.55, 'porcini'],
  ] as const) {
    const m = createMushroomModel(sp, 5);
    m.position.set(mx, 0.9, 0.1);
    m.scale.setScalar(1.6);
    stall.add(m);
  }

  stall.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  scene.add(stall);
  staticWoodObjects.push(stall);
  colliders.push({ x: sx, z: sz, r: 1.1, kind: 'stall', y: sy });

  const stallLantern = new THREE.PointLight('#ffb060', 0, 9);
  stallLantern.position.set(0.9, 1.9, 0.4);
  stall.add(stallLantern);

  // --- Cozy Homestead Additions: Campfire Anchor, Log Bench, Mushroom Drying Rack, Chopping Block, Trail Signposts ---
  const campWoodTex = createWoodGrainTexture('#6e4628');
  const campBarkMat = new THREE.MeshStandardMaterial({ map: campWoodTex, roughness: 0.9 });
  const campTimberMat = new THREE.MeshStandardMaterial({ color: '#845834', roughness: 0.84 });
  const campRopeMat = new THREE.MeshStandardMaterial({ color: '#cbb48a', roughness: 0.95 });

  // 1. Campfire Clearing Position (between hut porch and trail, hero centerpiece for menu & camp rest)
  const campfirePos = new THREE.Vector3(cfX, groundHeightAt(cfX, cfZ), cfZ);
  colliders.push({ x: cfX, z: cfZ, r: 0.78, kind: 'campfire', y: campfirePos.y });

  // 2. Hand-hewn Wooden Log Bench facing the campfire
  const benchY = groundHeightAt(benchX, benchZ);
  const benchGroup = new THREE.Group();
  benchGroup.position.set(benchX, benchY, benchZ);
  benchGroup.lookAt(campfirePos.x, benchY, campfirePos.z);
  const seatPlank = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.11, 0.38), campTimberMat);
  seatPlank.position.set(0, 0.44, 0);
  benchGroup.add(seatPlank);
  for (const lx of [-0.62, 0.62]) {
    const legStump = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.42, 9), campBarkMat);
    legStump.position.set(lx, 0.21, 0);
    benchGroup.add(legStump);
  }
  benchGroup.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  root.add(benchGroup);
  staticWoodObjects.push(benchGroup);
  colliders.push({ x: benchX, z: benchZ, r: 0.55, kind: 'fence', y: benchY });

  // 3. Composite Timber Mushroom Drying Rack (A-frame + shingle canopy + 2 hanging cords + live 3D hanging mushrooms)
  const drY = groundHeightAt(drX, drZ);
  const dryerPos = new THREE.Vector3(drX, drY, drZ);
  const dryerGroup = new THREE.Group();
  dryerGroup.position.copy(dryerPos);
  dryerGroup.lookAt(campfirePos.x, drY, campfirePos.z);

  const postGeo = new THREE.CylinderGeometry(0.048, 0.058, 1.95, 8);
  for (const sxOff of [-0.95, 0.95]) {
    for (const szOff of [-0.26, 0.26]) {
      const p = new THREE.Mesh(postGeo, campBarkMat);
      p.position.set(sxOff, 0.92, szOff);
      p.rotation.x = szOff > 0 ? -0.14 : 0.14;
      dryerGroup.add(p);
    }
  }
  const topBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.25, 8), campTimberMat);
  topBeam.rotation.z = Math.PI / 2;
  topBeam.position.set(0, 1.84, 0);
  dryerGroup.add(topBeam);

  // Slanted wooden rain-cover shingles on top of the drying rack
  for (const side of [-1, 1]) {
    const eaves = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.055, 0.52), campBarkMat);
    eaves.position.set(0, 1.96, side * 0.21);
    eaves.rotation.x = side * 0.42;
    dryerGroup.add(eaves);
  }
  // Two taut hemp drying cords at upper & middle height
  for (const cy of [1.56, 1.18]) {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.92, 6), campRopeMat);
    cord.rotation.z = Math.PI / 2;
    cord.position.set(0, cy, 0);
    dryerGroup.add(cord);
  }
  dryerGroup.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  const dryerSlotsGroup = new THREE.Group();
  dryerGroup.add(dryerSlotsGroup);
  root.add(dryerGroup);
  staticWoodObjects.push(dryerGroup);
  colliders.push({ x: drX, z: drZ, r: 0.85, kind: 'dryer', y: drY });

  const syncDryingRackVisuals = (slots: DriedMushroomSlot[]) => {
    while (dryerSlotsGroup.children.length > 0) {
      dryerSlotsGroup.remove(dryerSlotsGroup.children[0]);
    }
    const maxVis = Math.min(14, slots.length);
    for (let i = 0; i < maxVis; i++) {
      const sl = slots[i];
      const row = i < 7 ? 0 : 1;
      const col = i % 7;
      const countInRow = row === 0 ? Math.min(7, maxVis) : maxVis - 7;
      const u = countInRow > 1 ? col / (countInRow - 1) - 0.5 : 0;
      const x = u * 1.56;
      const y = row === 0 ? 1.53 : 1.15;

      const m = createMushroomModel(sl.species, 100 + sl.id);
      m.scale.setScalar(1.05);
      // Hang upside-down slightly tilted like real dried forest mushrooms on string
      m.position.set(x, y - 0.14, (i % 2 === 0 ? 1 : -1) * 0.02);
      m.rotation.set(0.15, i * 0.9, Math.PI * 0.92);
      if (sl.progress >= 1) {
        m.traverse((c) => {
          const mesh = c as THREE.Mesh;
          if (mesh.isMesh && mesh.material && (mesh.material as THREE.MeshStandardMaterial).emissive) {
            const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
            mat.emissive = new THREE.Color('#c88228');
            mat.emissiveIntensity = 0.25;
            mesh.material = mat;
          }
        });
      }
      dryerSlotsGroup.add(m);
    }
  };

  // 4. Firewood Chopping Block beside the hut porch
  const cbY = groundHeightAt(cbX, cbZ);
  const blockGroup = new THREE.Group();
  blockGroup.position.set(cbX, cbY, cbZ);
  const stumpEndMat = new THREE.MeshStandardMaterial({ color: '#d4b080', roughness: 0.85 });
  const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.58, 12), [
    campBarkMat,
    stumpEndMat,
    stumpEndMat,
  ]);
  stump.position.y = 0.28;
  stump.castShadow = true;
  stump.receiveShadow = true;
  blockGroup.add(stump);
  root.add(blockGroup);
  staticWoodObjects.push(blockGroup);
  colliders.push({ x: cbX, z: cbZ, r: 0.42, kind: 'fence', y: cbY });

  // 5. Wooden Trail Signposts along the forest path pointing back to the homestead
  const signSampleIndices = [16, 36, 58, 82];
  const trailSignMats: THREE.MeshStandardMaterial[] = [];
  for (const sIdx of signSampleIndices) {
    if (sIdx >= TRAIL.samples.length - 2) continue;
    const sp = TRAIL.samples[sIdx];
    const spNext = TRAIL.samples[Math.min(TRAIL.samples.length - 1, sIdx + 2)];
    const dir = spNext.clone().sub(sp).normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    const sxp = sp.x + perp.x * 2.35;
    const szp = sp.z + perp.z * 2.35;
    const syp = groundHeightAt(sxp, szp);

    const postG = new THREE.Group();
    postG.position.set(sxp, syp, szp);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.08, 1.85, 8), campBarkMat);
    pole.position.y = 0.9;
    pole.castShadow = true;
    pole.receiveShadow = true;
    postG.add(pole);

    const boardMat = new THREE.MeshStandardMaterial({ map: createSignTexture('← ИЗБУШКА'), roughness: 0.85 });
    trailSignMats.push(boardMat);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.24, 0.045), [
      postMat,
      postMat,
      postMat,
      postMat,
      boardMat,
      boardMat,
    ]);
    board.position.y = 1.56;
    // Point arrow broadly toward the homestead clearing
    const toCampAngle = Math.atan2(campfirePos.x - sxp, campfirePos.z - szp);
    board.rotation.y = toCampAngle - Math.PI / 2;
    board.castShadow = true;
    postG.add(board);

    root.add(postG);
    staticWoodObjects.push(postG);
    colliders.push({ x: sxp, z: szp, r: 0.25, kind: 'fence', y: syp });
  }

  // Bilingual sign text updater
  const updateSignLanguage = (lang: Language) => {
    const stallLabel = lang === 'ru' ? 'СКУПКА ГРИБОВ' : 'СКУПКА ГРИБІВ';
    const nextTex = createSignTexture(stallLabel);
    if (signMat.map) signMat.map.dispose();
    signMat.map = nextTex;
    signMat.needsUpdate = true;

    const arrowLabel = lang === 'ru' ? '← ИЗБУШКА' : '← ХАТИНКА';
    for (const bm of trailSignMats) {
      const tTex = createSignTexture(arrowLabel);
      if (bm.map) bm.map.dispose();
      bm.map = tTex;
      bm.needsUpdate = true;
    }
  };

  // Cinematic Main Menu Camera Framing: cozy hearth foreground + drying rack + hut porch + golden pines
  const menuCamPos = new THREE.Vector3(menuCamX, groundHeightAt(menuCamX, menuCamZ) + 1.58, menuCamZ);
  const menuCamLook = new THREE.Vector3(
    campfirePos.x + right.x * 0.9,
    campfirePos.y + 0.95,
    campfirePos.z - startDir.z * 0.65,
  );

  // --- Balanced Warm/Cool Lighting Rig & Horizon Fog (Original Mushroom Hollow Mood + Upgraded Shadows) ---
  const hemi = new THREE.HemisphereLight('#cfe0f2', '#5a4026', 0.9);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#ffe2b8', 2.6);
  sun.castShadow = !isSoftwareGl;
  const shadowRes = { low: 1024, medium: 2048, high: 4096 }[quality];
  sun.shadow.mapSize.set(shadowRes, shadowRes);
  sun.shadow.camera.left = -42;
  sun.shadow.camera.right = 42;
  sun.shadow.camera.top = 42;
  sun.shadow.camera.bottom = -42;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 2.5;
  scene.add(sun);
  scene.add(sun.target);

  scene.fog = new THREE.FogExp2('#c9b79a', 0.016);

  return {
    terrain,
    sky,
    sun,
    hemi,
    hutLamp,
    stallPos: stall.position.clone(),
    stallLantern,
    campfirePos,
    dryerPos,
    menuCamPos,
    menuCamLook,
    syncDryingRackVisuals,
    updateSignLanguage,
    chunkGroups,
    colliders,
    trees,
    bushes,
    stoneZones,
    staticWoodObjects,
    fallingUpdate: falling.update,
    windUniform,
    start,
    startDir,
    sunDir: new THREE.Vector3(0.4, 0.8, 0.4).normalize(),
    daylight: 1,
    leafTex,
    updateCulling(cam: THREE.Camera) {
      for (const ch of chunkGroups) {
        const center = ch.userData.center as THREE.Vector3;
        const dx = Math.max(0, Math.abs(cam.position.x - center.x) - CHUNK_SIZE / 2);
        const dz = Math.max(0, Math.abs(cam.position.z - center.z) - CHUNK_SIZE / 2);
        ch.visible = dx * dx + dz * dz < 125 * 125;
      }
    },
  };
}

export function updateDaylight(world: WorldData, scene: THREE.Scene, timeNorm: number) {
  const angle = (timeNorm - 0.25) * Math.PI;
  const sinA = Math.sin(angle);
  const dir = world.sunDir.set(Math.cos(angle) * 0.8, Math.max(0.04, sinA), 0.45).normalize();

  const skyMat = world.sky.material as THREE.ShaderMaterial;
  skyMat.uniforms.sunDir.value.copy(dir);

  const day = THREE.MathUtils.smoothstep(sinA, -0.08, 0.35);
  const sunset = 1 - THREE.MathUtils.smoothstep(sinA, 0.05, 0.5);

  skyMat.uniforms.top.value.set('#141a30').lerp(new THREE.Color('#7fa6c9'), day);
  skyMat.uniforms.horizon.value
    .set('#20202e')
    .lerp(new THREE.Color('#e9c79c').lerp(new THREE.Color('#f09a58'), sunset * 0.65), day);

  world.sun.color.set('#ffe9c8').lerp(new THREE.Color('#ff9a50'), sunset * 0.7);
  world.sun.intensity = 2.8 * day;
  world.hemi.intensity = 0.22 + 0.82 * day;
  world.hemi.color.set('#cfe0f2').lerp(new THREE.Color('#4a5a8a'), 1 - day);

  const fog = scene.fog as THREE.FogExp2;
  fog.color
    .set('#c9b79a')
    .lerp(new THREE.Color('#e0a070'), sunset * 0.35)
    .lerp(new THREE.Color('#141824'), 1 - day);
  fog.density = 0.011 + (1 - day) * 0.014;
  world.daylight = day;
}
