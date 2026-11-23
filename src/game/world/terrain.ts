import * as THREE from 'three';
import { createSimplex2D, fbm2D, mulberry32 } from '../utils/noise';

export const WORLD_SIZE = 280;
export const WORLD_HALF = WORLD_SIZE / 2;
export const TERRAIN_SEGMENTS = 224;
export const CHUNK_GRID = 8;
export const CHUNK_SIZE = WORLD_SIZE / CHUNK_GRID;

export const terrainNoise = createSimplex2D(42);
export const biomeNoise = createSimplex2D(77);

function buildTrail() {
  const rnd = mulberry32(5);
  const pts: THREE.Vector3[] = [];
  const count = 14;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = 70 + (rnd() - 0.5) * 50;
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r * 0.85));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  const samples = curve.getSpacedPoints(900);
  return { curve, samples };
}

export const TRAIL = buildTrail();

const DIST_RES = 256;
const trailDistGrid = new Float32Array(DIST_RES * DIST_RES);

(function bakeTrailDistance() {
  const samples = TRAIL.samples;
  for (let gz = 0; gz < DIST_RES; gz++) {
    for (let gx = 0; gx < DIST_RES; gx++) {
      const wx = -WORLD_HALF + ((gx + 0.5) / DIST_RES) * WORLD_SIZE;
      const wz = -WORLD_HALF + ((gz + 0.5) / DIST_RES) * WORLD_SIZE;
      let best = 1e9;
      for (let k = 0; k < samples.length; k += 2) {
        const dx = samples[k].x - wx;
        const dz = samples[k].z - wz;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      trailDistGrid[gz * DIST_RES + gx] = Math.sqrt(best);
    }
  }
})();

export function trailDistance(x: number, z: number): number {
  const fx = ((x + WORLD_HALF) / WORLD_SIZE) * DIST_RES - 0.5;
  const fz = ((z + WORLD_HALF) / WORLD_SIZE) * DIST_RES - 0.5;
  const x0 = Math.max(0, Math.min(DIST_RES - 2, Math.floor(fx)));
  const z0 = Math.max(0, Math.min(DIST_RES - 2, Math.floor(fz)));
  const tx = Math.min(1, Math.max(0, fx - x0));
  const tz = Math.min(1, Math.max(0, fz - z0));
  const v00 = trailDistGrid[z0 * DIST_RES + x0];
  const v10 = trailDistGrid[z0 * DIST_RES + x0 + 1];
  const v01 = trailDistGrid[(z0 + 1) * DIST_RES + x0];
  const v11 = trailDistGrid[(z0 + 1) * DIST_RES + x0 + 1];
  return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz;
}

function rawHeight(x: number, z: number): number {
  let h = fbm2D(terrainNoise, x * 0.008, z * 0.008, 4) * 9;
  h += fbm2D(terrainNoise, x * 0.03 + 50, z * 0.03, 3) * 1.6;
  const edge = Math.max(Math.abs(x), Math.abs(z)) / WORLD_HALF;
  h += Math.pow(Math.max(0, edge - 0.78) / 0.22, 2) * 16;
  return h;
}

const trailStart = TRAIL.samples[0];
const trailForward = TRAIL.samples[6].clone().sub(trailStart).normalize();
const trailRight = new THREE.Vector3(-trailForward.z, 0, trailForward.x);

export interface HutTransform {
  x: number;
  y: number;
  z: number;
  rot: number;
  bed: THREE.Vector3 | null;
  bench: THREE.Vector3 | null;
  inner: THREE.Group | null;
}

export const HUT_POSE: HutTransform = {
  x: trailStart.x + trailRight.x * 10 - trailForward.x * 2,
  y: 0,
  z: trailStart.z + trailRight.z * 10 - trailForward.z * 2,
  rot: Math.atan2(-trailRight.x, -trailRight.z),
  bed: null,
  bench: null,
  inner: null,
};
HUT_POSE.y = rawHeight(HUT_POSE.x, HUT_POSE.z);

export function groundHeightAt(x: number, z: number): number {
  let h = rawHeight(x, z);
  const dHut = Math.hypot(x - HUT_POSE.x, z - HUT_POSE.z);
  if (dHut < 10) {
    h = THREE.MathUtils.lerp(HUT_POSE.y, h, THREE.MathUtils.smoothstep(dHut, 4.2, 10));
  }
  const dTrail = trailDistance(x, z);
  const s = THREE.MathUtils.smoothstep(dTrail, 1.5, 5);
  return h * (0.85 + 0.15 * s) - (1 - s) * 0.12;
}

export function groundNormalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const eps = 0.25;
  const hL = groundHeightAt(x - eps, z);
  const hR = groundHeightAt(x + eps, z);
  const hD = groundHeightAt(x, z - eps);
  const hU = groundHeightAt(x, z + eps);
  return out.set(hL - hR, 2 * eps, hD - hU).normalize();
}

export function mossFactorAt(x: number, z: number): number {
  return THREE.MathUtils.smoothstep(fbm2D(biomeNoise, x * 0.04, z * 0.04, 3), 0.05, 0.45);
}
