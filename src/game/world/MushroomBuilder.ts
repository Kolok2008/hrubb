import * as THREE from 'three';
import { MUSHROOM_SPECS, type SpeciesId } from '../types';
import { mulberry32 } from '../utils/noise';
import {
  createMushroomCapTexture,
  createMushroomStemTexture,
  createMushroomUnderTexture,
} from '../utils/textures';

const matCache: Record<string, THREE.MeshStandardMaterial> = {};

function cachedMat(key: string, factory: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  if (!matCache[key]) matCache[key] = factory();
  return matCache[key];
}

function stdMat(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, ...params });
}

function makeLathe(pts: Array<[number, number]>, segs = 28): THREE.LatheGeometry {
  const ordered = pts[0][1] > pts[pts.length - 1][1] ? [...pts].reverse() : pts;
  const g = new THREE.LatheGeometry(
    ordered.map(([r, y]) => new THREE.Vector2(r, y)),
    segs,
  );
  g.computeVertexNormals();
  return g;
}

function organicWobble(geo: THREE.BufferGeometry, amp: number, seed: number) {
  const rnd = mulberry32(seed);
  const pos = geo.attributes.position;
  const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const k =
      1 +
      (Math.sin(a * 3 + ph[0]) * 0.5 +
        Math.sin(a * 5 + ph[1]) * 0.3 +
        Math.sin(a * 9 + ph[2]) * 0.2) *
        amp;
    pos.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
}

function buildPorcini(rnd: () => number, size: number): THREE.Group {
  const root = new THREE.Group();
  const capHex = ['#7a4a24', '#8c5a2c', '#6a3c1e'][Math.floor(rnd() * 3)];
  const r = 0.085 * size;
  const h = 0.11 * size;

  const stem = new THREE.Mesh(
    makeLathe(
      [
        [0, 0],
        [r * 0.55, 0],
        [r * 0.72, h * 0.25],
        [r * 0.6, h * 0.7],
        [r * 0.45, h],
        [0, h],
      ],
      18,
    ),
    cachedMat('porciniStem', () => stdMat({ map: createMushroomStemTexture('#e6dcc4', 'net') })),
  );

  const cap = new THREE.Mesh(
    makeLathe(
      [
        [0, r * 0.62],
        [r * 0.5, r * 0.58],
        [r * 0.85, r * 0.42],
        [r * 1.02, r * 0.2],
        [r * 1, r * 0.05],
        [r * 0.9, 0],
      ],
      28,
    ),
    cachedMat('porciniCap' + capHex, () =>
      stdMat({ map: createMushroomCapTexture(capHex, false, 4), roughness: 0.55 }),
    ),
  );
  organicWobble(cap.geometry, 0.04, Math.floor(rnd() * 1e6));
  cap.position.y = h;

  const under = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.92, 24).rotateX(Math.PI / 2),
    cachedMat('porciniUnder', () =>
      stdMat({ map: createMushroomUnderTexture('pores', '#d8d098'), side: THREE.DoubleSide }),
    ),
  );
  under.position.y = h + 0.002;

  const cut = new THREE.Group();
  const capGroup = new THREE.Group();
  capGroup.add(cap, under);
  cut.add(stem, capGroup);
  root.add(cut);
  root.userData.cut = cut;
  root.userData.capGroup = capGroup;
  root.userData.stemMesh = stem;
  root.userData.height = h + r * 0.62;
  return root;
}

function buildBirch(rnd: () => number, size: number): THREE.Group {
  const root = new THREE.Group();
  const r = 0.07 * size;
  const h = 0.15 * size;
  const stem = new THREE.Mesh(
    makeLathe(
      [
        [0, 0],
        [r * 0.38, 0],
        [r * 0.34, h * 0.5],
        [r * 0.28, h],
        [0, h],
      ],
      14,
    ),
    cachedMat('birchStem', () => stdMat({ map: createMushroomStemTexture('#e8e2d6', 'scales') })),
  );
  const cap = new THREE.Mesh(
    makeLathe(
      [
        [0, r * 0.66],
        [r * 0.6, r * 0.6],
        [r * 0.95, r * 0.35],
        [r * 1, r * 0.1],
        [r * 0.85, 0],
      ],
      26,
    ),
    cachedMat('birchCap', () =>
      stdMat({ map: createMushroomCapTexture('#8a6a48', false, 9), roughness: 0.6 }),
    ),
  );
  organicWobble(cap.geometry, 0.05, Math.floor(rnd() * 1e6));
  cap.position.y = h;

  const under = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.86, 22).rotateX(Math.PI / 2),
    cachedMat('birchUnder', () => stdMat({ map: createMushroomUnderTexture('pores', '#d6ccb8') })),
  );
  under.position.y = h + 0.002;

  const cut = new THREE.Group();
  const capGroup = new THREE.Group();
  capGroup.add(cap, under);
  cut.add(stem, capGroup);
  root.add(cut);
  root.userData.cut = cut;
  root.userData.capGroup = capGroup;
  root.userData.stemMesh = stem;
  root.userData.height = h + r * 0.66;
  return root;
}

function buildChanterelle(rnd: () => number, size: number, count: number): THREE.Group {
  const root = new THREE.Group();
  const cut = new THREE.Group();
  const mat = cachedMat('chantCap', () =>
    stdMat({
      color: '#e49a2a',
      roughness: 0.6,
      side: THREE.DoubleSide,
      emissive: '#5a2a00',
      emissiveIntensity: 0.15,
    }),
  );
  for (let i = 0; i < count; i++) {
    const s = size * (0.6 + rnd() * 0.6);
    const r = 0.04 * s;
    const h = 0.05 * s;
    const m = new THREE.Mesh(
      makeLathe(
        [
          [0, 0],
          [r * 0.25, 0],
          [r * 0.3, h * 0.5],
          [r * 0.6, h * 0.9],
          [r, h * 1.12],
          [r * 1.12, h * 1.05],
          [r * 0.9, h],
          [r * 0.5, h * 0.98],
          [0, h * 0.85],
        ],
        20,
      ),
      mat,
    );
    organicWobble(m.geometry, 0.14, Math.floor(rnd() * 1e6));
    const a = rnd() * Math.PI * 2;
    const d = i === 0 ? 0 : 0.03 + rnd() * 0.06;
    m.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    m.rotation.set((rnd() - 0.5) * 0.4, rnd() * 6, (rnd() - 0.5) * 0.4);
    cut.add(m);
  }
  root.add(cut);
  root.userData.cut = cut;
  root.userData.height = 0.07 * size;
  return root;
}

function buildHoney(rnd: () => number, size: number, count: number): THREE.Group {
  const root = new THREE.Group();
  const cut = new THREE.Group();
  const capMat = cachedMat('honeyCap', () =>
    stdMat({ map: createMushroomCapTexture('#b07a3a', false, 21), roughness: 0.55 }),
  );
  const stemMat = cachedMat('honeyStem', () =>
    stdMat({ map: createMushroomStemTexture('#d8c4a0', 'fibre') }),
  );
  for (let i = 0; i < count; i++) {
    const s = size * (0.55 + rnd() * 0.6);
    const r = 0.03 * s;
    const h = (0.06 + rnd() * 0.05) * s * 1.4;
    const g = new THREE.Group();
    const stem = new THREE.Mesh(
      makeLathe(
        [
          [0, 0],
          [r * 0.22, 0],
          [r * 0.18, h],
          [0, h],
        ],
        8,
      ),
      stemMat,
    );
    const cap = new THREE.Mesh(
      makeLathe(
        [
          [0, r * 0.7],
          [r * 0.6, r * 0.55],
          [r, r * 0.15],
          [r * 0.85, 0],
        ],
        16,
      ),
      capMat,
    );
    cap.position.y = h;
    g.add(stem, cap);
    const a = rnd() * Math.PI * 2;
    const d = 0.01 + rnd() * 0.05;
    g.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    g.rotation.set(Math.sin(a) * 0.35 * rnd(), 0, -Math.cos(a) * 0.35 * rnd());
    cut.add(g);
  }
  root.add(cut);
  root.userData.cut = cut;
  root.userData.height = 0.1 * size;
  return root;
}

function buildRussula(rnd: () => number, size: number): THREE.Group {
  const root = new THREE.Group();
  const hex = ['#c0302a', '#c0302a', '#6f8a3a', '#d6a83a', '#9a3a5a'][Math.floor(rnd() * 5)];
  const r = 0.07 * size;
  const h = 0.07 * size;
  const stem = new THREE.Mesh(
    makeLathe(
      [
        [0, 0],
        [r * 0.36, 0],
        [r * 0.34, h],
        [0, h],
      ],
      14,
    ),
    cachedMat('russStem', () => stdMat({ color: '#f2eee6' })),
  );
  const cap = new THREE.Mesh(
    makeLathe(
      [
        [0, r * 0.32],
        [r * 0.6, r * 0.34],
        [r * 0.95, r * 0.22],
        [r * 1.02, r * 0.08],
        [r * 0.95, 0],
      ],
      26,
    ),
    cachedMat('russCap' + hex, () =>
      stdMat({ map: createMushroomCapTexture(hex, false, 31), roughness: 0.4 }),
    ),
  );
  organicWobble(cap.geometry, 0.05, Math.floor(rnd() * 1e6));
  cap.position.y = h;
  const under = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.93, 24).rotateX(Math.PI / 2),
    cachedMat('russUnder', () => stdMat({ map: createMushroomUnderTexture('gills', '#f2ecdc') })),
  );
  under.position.y = h + 0.002;
  const cut = new THREE.Group();
  const capGroup = new THREE.Group();
  capGroup.add(cap, under);
  cut.add(stem, capGroup);
  root.add(cut);
  root.userData.cut = cut;
  root.userData.capGroup = capGroup;
  root.userData.stemMesh = stem;
  root.userData.height = h + r * 0.34;
  return root;
}

function buildPuffball(rnd: () => number, size: number, count: number): THREE.Group {
  const root = new THREE.Group();
  const cut = new THREE.Group();
  const mat = cachedMat('puff', () =>
    stdMat({ map: createMushroomCapTexture('#f2ece0', false, 41), roughness: 0.85 }),
  );
  for (let i = 0; i < count; i++) {
    const s = size * (0.6 + rnd() * 0.5);
    const r = 0.045 * s;
    const m = new THREE.Mesh(
      makeLathe(
        [
          [0, 0],
          [r * 0.5, 0],
          [r * 0.95, r * 0.5],
          [r, r],
          [r * 0.7, r * 1.5],
          [0, r * 1.62],
        ],
        20,
      ),
      mat,
    );
    const a = rnd() * 6.28;
    const d = i ? 0.06 + rnd() * 0.04 : 0;
    m.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    cut.add(m);
  }
  root.add(cut);
  root.userData.cut = cut;
  root.userData.height = 0.07 * size;
  return root;
}

function buildAmanita(rnd: () => number, size: number, isDeathcap: boolean): THREE.Group {
  const root = new THREE.Group();
  const r = (isDeathcap ? 0.075 : 0.09) * size;
  const h = (isDeathcap ? 0.13 : 0.15) * size;
  const stemMat = cachedMat('amaStem', () => stdMat({ color: '#f3efe2', roughness: 0.7 }));
  const stem = new THREE.Mesh(
    makeLathe(
      [
        [0, 0],
        [r * 0.5, 0],
        [r * 0.55, r * 0.15],
        [r * 0.38, r * 0.3],
        [r * 0.3, h],
        [0, h],
      ],
      16,
    ),
    stemMat,
  );
  const skirt = new THREE.Mesh(
    makeLathe(
      [
        [r * 0.3, h * 0.82],
        [r * 0.6, h * 0.72],
        [r * 0.55, h * 0.7],
        [r * 0.3, h * 0.78],
      ],
      16,
    ),
    stemMat,
  );
  const capHex = isDeathcap ? '#c8c89a' : '#d0281c';
  const cap = new THREE.Mesh(
    makeLathe(
      [
        [0, r * 0.55],
        [r * 0.55, r * 0.5],
        [r * 0.9, r * 0.3],
        [r * 1.02, r * 0.1],
        [r * 0.95, 0],
      ],
      28,
    ),
    cachedMat('amaCap' + capHex, () =>
      stdMat({
        map: createMushroomCapTexture(capHex, isDeathcap, isDeathcap ? 51 : 52),
        roughness: isDeathcap ? 0.6 : 0.35,
      }),
    ),
  );
  organicWobble(cap.geometry, 0.03, Math.floor(rnd() * 1e6));
  cap.position.y = h;
  const under = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.93, 24).rotateX(Math.PI / 2),
    cachedMat('amaUnder', () => stdMat({ map: createMushroomUnderTexture('gills', '#f6f2e6') })),
  );
  under.position.y = h + 0.002;

  const cut = new THREE.Group();
  const capGroup = new THREE.Group();
  capGroup.add(cap, under);
  if (!isDeathcap) {
    const wartMat = cachedMat('wart', () => stdMat({ color: '#f6f0e2', roughness: 0.9 }));
    const wartGeo = new THREE.DodecahedronGeometry(r * 0.07, 0);
    for (let i = 0; i < 24; i++) {
      const a = rnd() * Math.PI * 2;
      const dist = Math.sqrt(rnd()) * 0.92;
      const w = new THREE.Mesh(wartGeo, wartMat);
      const y = h + r * 0.55 * (1 - dist * dist * 0.95);
      w.position.set(Math.cos(a) * r * dist, y, Math.sin(a) * r * dist);
      w.scale.setScalar(0.6 + rnd() * 0.8);
      capGroup.add(w);
    }
  }
  cut.add(stem, skirt, capGroup);
  root.add(cut);
  root.userData.cut = cut;
  root.userData.capGroup = capGroup;
  root.userData.stemMesh = stem;
  root.userData.height = h + r * 0.55;
  return root;
}

export function createMushroomModel(species: SpeciesId, seed: number): THREE.Group {
  const rnd = mulberry32(seed);
  const spec = MUSHROOM_SPECS[species];
  const size = spec.size * (0.8 + rnd() * 0.5);
  const count = spec.cluster
    ? spec.cluster[0] + Math.floor(rnd() * (spec.cluster[1] - spec.cluster[0] + 1))
    : 1;

  let group: THREE.Group;
  switch (species) {
    case 'porcini':
      group = buildPorcini(rnd, size);
      break;
    case 'golden': {
      group = buildPorcini(rnd, size);
      group.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          (c as THREE.Mesh).material = new THREE.MeshStandardMaterial({
            color: '#f2c040',
            emissive: '#c88a10',
            emissiveIntensity: 0.85,
            metalness: 0.65,
            roughness: 0.28,
          });
        }
      });
      const glow = new THREE.PointLight('#ffcc55', 1.2, 4);
      glow.position.y = 0.25;
      group.add(glow);
      break;
    }
    case 'birch':
      group = buildBirch(rnd, size);
      break;
    case 'chanterelle':
      group = buildChanterelle(rnd, size, count);
      break;
    case 'honey':
      group = buildHoney(rnd, size, count);
      break;
    case 'russula':
      group = buildRussula(rnd, size);
      break;
    case 'puffball':
      group = buildPuffball(rnd, size, count);
      break;
    case 'flyagaric':
      group = buildAmanita(rnd, size, false);
      break;
    case 'deathcap':
      group = buildAmanita(rnd, size, true);
      break;
  }

  group.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  group.userData.species = species;
  group.userData.count = count;
  group.userData.size = size;
  return group;
}

let sharedPileGeo: THREE.SphereGeometry | null = null;
let sharedPileMat: THREE.MeshStandardMaterial | null = null;

export function createLeafPile(
  leafTex: THREE.Texture,
  rnd: () => number,
): THREE.Group {
  if (!sharedPileGeo) {
    sharedPileGeo = new THREE.SphereGeometry(0.32, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const pos = sharedPileGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, pos.getY(i) * 0.45);
    }
    sharedPileGeo.computeVertexNormals();
    sharedPileMat = new THREE.MeshStandardMaterial({ color: '#7a4a24', roughness: 1 });
  }

  const pile = new THREE.Group();
  const base = new THREE.Mesh(sharedPileGeo, sharedPileMat!);
  base.receiveShadow = true;
  base.castShadow = true;
  pile.add(base);

  const leafGeo = new THREE.PlaneGeometry(0.14, 0.14);
  const leafMat = new THREE.MeshStandardMaterial({
    map: leafTex,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.95,
  });

  const leaves: THREE.Mesh[] = [];
  for (let i = 0; i < 42; i++) {
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    const a = rnd() * Math.PI * 2;
    const rad = Math.sqrt(rnd());
    const x = Math.cos(a) * rad * 0.33;
    const z = Math.sin(a) * rad * 0.33;
    const y = 0.145 * (1 - rad * rad) + 0.01;
    leaf.position.set(x, y, z);
    leaf.rotation.set(-Math.PI / 2 + (rnd() - 0.5) * 0.9, 0, rnd() * 6.28);
    pile.add(leaf);
    leaves.push(leaf);
  }
  pile.userData.leaves = leaves;
  pile.userData.base = base;
  return pile;
}
