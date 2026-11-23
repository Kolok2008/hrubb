import * as THREE from 'three';
import { groundNormalAt, HUT_POSE, mossFactorAt, trailDistance } from './terrain';

export type SurfaceType = 'moss' | 'leaves' | 'stone' | 'dirt' | 'wood';

export interface StoneZone {
  x: number;
  z: number;
  r: number;
  kind: 'rock' | 'pebble';
}

export interface SurfaceSample {
  primary: SurfaceType;
  secondary: SurfaceType | null;
  /** 0..0.48 weight for smooth organic cross-fade near surface borders */
  secondaryWeight: number;
  /** 0..1 extra dry foliage density when walking over intact mushroom leaf piles */
  leafPileBoost: number;
}

const CELL_SIZE = 8;

/**
 * Spatial surface classifier matching Mushroom Hollow's terrain shader,
 * scattered rocks/pebbles, wooden hut floor/porch, stall area, and mushroom leaf piles.
 */
export class SurfaceDetector {
  private readonly stoneGrid = new Map<string, StoneZone[]>();
  private readonly normalScratch = new THREE.Vector3();

  constructor(
    stoneZones: StoneZone[],
    private readonly stallPos: THREE.Vector3,
    private readonly sampleLeafPileBoost: (x: number, z: number) => number,
  ) {
    for (const z of stoneZones) {
      const reach = z.r + 1.25;
      const minX = Math.floor((z.x - reach) / CELL_SIZE);
      const maxX = Math.floor((z.x + reach) / CELL_SIZE);
      const minZ = Math.floor((z.z - reach) / CELL_SIZE);
      const maxZ = Math.floor((z.z + reach) / CELL_SIZE);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = `${cx},${cz}`;
          let bucket = this.stoneGrid.get(key);
          if (!bucket) {
            bucket = [];
            this.stoneGrid.set(key, bucket);
          }
          bucket.push(z);
        }
      }
    }
  }

  public sample(x: number, z: number): SurfaceSample {
    const weights: Record<SurfaceType, number> = {
      moss: 0,
      leaves: 0,
      stone: 0,
      dirt: 0,
      wood: 0,
    };

    // 1. Wood: Hut interior floor, doorway threshold & front porch
    const dxHut = x - HUT_POSE.x;
    const dzHut = z - HUT_POSE.z;
    if (dxHut * dxHut + dzHut * dzHut < 4.5 * 4.5) {
      const cos = Math.cos(HUT_POSE.rot);
      const sin = Math.sin(HUT_POSE.rot);
      const lx = dxHut * cos - dzHut * sin;
      const lz = dxHut * sin + dzHut * cos;
      if (Math.abs(lx) <= 2.15 && lz >= -2.15 && lz <= 2.35) {
        weights.wood = 1.0;
      } else if (Math.abs(lx) <= 2.55 && lz >= -2.45 && lz <= 2.95) {
        // Porch steps & wooden threshold apron
        weights.wood = 0.72;
      }
    }

    // Wooden buyer stall deck / front step
    const dStall = Math.hypot(x - this.stallPos.x, z - this.stallPos.z);
    if (dStall < 1.85) {
      const stallWood = (1 - THREE.MathUtils.smoothstep(dStall, 1.05, 1.85)) * 0.68;
      weights.wood = Math.max(weights.wood, stallWood);
    }

    // If firmly inside the wooden hut, return pure wood immediately
    if (weights.wood >= 0.98) {
      return { primary: 'wood', secondary: null, secondaryWeight: 0, leafPileBoost: 0 };
    }

    // 2. Stone: Nearby rocks, scattered pebbles, and steep rocky scree slopes
    let stoneWeight = 0;
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    const bucket = this.stoneGrid.get(`${cx},${cz}`);
    if (bucket) {
      for (const s of bucket) {
        const d = Math.hypot(x - s.x, z - s.z);
        const outer = s.kind === 'rock' ? s.r + 1.15 : s.r + 0.95;
        if (d < outer) {
          const t = 1 - THREE.MathUtils.smoothstep(d, s.r * 0.45, outer);
          const contrib = s.kind === 'rock' ? t * 0.95 : t * 0.78;
          if (contrib > stoneWeight) stoneWeight = contrib;
        }
      }
    }

    const normal = groundNormalAt(x, z, this.normalScratch);
    if (normal.y < 0.89) {
      const slopeStone = THREE.MathUtils.smoothstep(0.89 - normal.y, 0.0, 0.14) * 0.82;
      stoneWeight = Math.max(stoneWeight, slopeStone);
    }
    weights.stone = stoneWeight * (1 - weights.wood * 0.7);

    // 3. Packed Dirt Trail (exact match to terrain fragment shader blend)
    const td = trailDistance(x, z);
    const dirtFactor = 1 - THREE.MathUtils.smoothstep(td, 0.9, 2.35);
    weights.dirt = dirtFactor * (1 - weights.wood * 0.75) * (1 - weights.stone * 0.45);

    // 4. Moss & 5. Dry Autumn Leaves off-trail
    const offTrail = Math.max(0, 1 - dirtFactor);
    const mossRaw = mossFactorAt(x, z);
    const leafPileBoost = this.sampleLeafPileBoost(x, z);

    const mossWeight = offTrail * mossRaw * (1 - weights.wood * 0.8) * (1 - weights.stone * 0.55) * (1 - leafPileBoost * 0.75);
    const leavesBase = offTrail * (1 - mossRaw * 0.78) * (1 - weights.wood * 0.8) * (1 - weights.stone * 0.5);
    const leavesWeight = Math.min(1, leavesBase + leafPileBoost * 0.92);

    weights.moss = mossWeight;
    weights.leaves = leavesWeight;

    // Pick primary and optional blended secondary surface
    const ordered = (Object.keys(weights) as SurfaceType[]).sort((a, b) => weights[b] - weights[a]);
    const primary = ordered[0];
    const second = ordered[1];
    const pVal = weights[primary];
    const sVal = weights[second];

    let secondary: SurfaceType | null = null;
    let secondaryWeight = 0;
    if (sVal > 0.14 && pVal > 0.01) {
      const ratio = sVal / (pVal + sVal);
      if (ratio >= 0.2) {
        secondary = second;
        secondaryWeight = Math.min(0.46, ratio);
      }
    }

    return {
      primary,
      secondary,
      secondaryWeight,
      leafPileBoost,
    };
  }
}
