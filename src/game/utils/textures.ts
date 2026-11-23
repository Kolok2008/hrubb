import * as THREE from 'three';
import { createSimplex2D, mulberry32, tileableValueNoise } from './noise';

function makeCanvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTex(
  canvas: HTMLCanvasElement,
  repeat = 1,
  srgb = true,
  anisotropy = 8,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = anisotropy;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const LEAF_PALETTE = [
  '#b8541c',
  '#d0782a',
  '#e09a32',
  '#a33b1c',
  '#8a4a22',
  '#c9a13b',
  '#7a3418',
  '#d46a1e',
  '#9c6a2c',
];

function drawLeaf(
  ctx: CanvasRenderingContext2D,
  size: number,
  color: string,
  shape = 0,
) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (shape === 0) {
    ctx.ellipse(0, 0, size * 0.32, size * 0.5, 0, 0, Math.PI * 2);
  } else {
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const r = (i % 2 === 0 ? 0.5 : 0.24) * size;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,25,10,0.45)';
  ctx.lineWidth = Math.max(1, size * 0.04);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.45);
  ctx.lineTo(0, size * 0.62);
  ctx.stroke();
}

export function createForestFloorTexture(size = 1024): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(7);
  const n = tileableValueNoise(size, 4, 3, 5);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = n[y * size + x];
      const idx = (y * size + x) * 4;
      img.data[idx] = 70 + v * 40;
      img.data[idx + 1] = 44 + v * 25;
      img.data[idx + 2] = 26 + v * 12;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const drawWrapped = (fn: () => void, cx: number, cy: number, margin: number) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (cx + ox < -margin || cx + ox > size + margin || cy + oy < -margin || cy + oy > size + margin) {
          continue;
        }
        ctx.save();
        ctx.translate(cx + ox, cy + oy);
        fn();
        ctx.restore();
      }
    }
  };

  for (let i = 0; i < 160; i++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const len = 20 + rnd() * 60;
    const ang = rnd() * Math.PI;
    drawWrapped(
      () => {
        ctx.rotate(ang);
        ctx.strokeStyle = `rgba(${50 + rnd() * 30},${32 + rnd() * 15},18,0.9)`;
        ctx.lineWidth = 2 + rnd() * 3;
        ctx.beginPath();
        ctx.moveTo(-len / 2, 0);
        ctx.lineTo(len / 2, rnd() * 6 - 3);
        ctx.stroke();
      },
      cx,
      cy,
      len,
    );
  }

  for (let layer = 0; layer < 3; layer++) {
    const count = [1400, 1100, 700][layer];
    for (let i = 0; i < count; i++) {
      const cx = rnd() * size;
      const cy = rnd() * size;
      const d = 14 + rnd() * 26;
      const col = new THREE.Color(LEAF_PALETTE[Math.floor(rnd() * LEAF_PALETTE.length)]);
      col.multiplyScalar([0.45, 0.7, 1][layer] * (0.8 + rnd() * 0.3));
      const ang = rnd() * Math.PI * 2;
      const sh = rnd() < 0.55 ? 0 : 1;
      drawWrapped(
        () => {
          ctx.rotate(ang);
          ctx.shadowColor = 'rgba(20,10,4,0.5)';
          ctx.shadowBlur = 4;
          drawLeaf(ctx, d, '#' + col.getHexString(), sh);
        },
        cx,
        cy,
        d,
      );
    }
  }
  return toTex(c, 1);
}

export function createDirtTexture(size = 512): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(12);
  const n = tileableValueNoise(size, 6, 11, 6);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = n[y * size + x];
      const idx = (y * size + x) * 4;
      img.data[idx] = 120 + v * 70;
      img.data[idx + 1] = 92 + v * 52;
      img.data[idx + 2] = 64 + v * 34;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 1 + rnd() * 3.5;
    const g = 90 + rnd() * 70;
    ctx.fillStyle = `rgba(${g},${g * 0.85},${g * 0.7},0.8)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 60; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const d = 8 + rnd() * 12;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd() * 6.3);
    drawLeaf(ctx, d, LEAF_PALETTE[Math.floor(rnd() * LEAF_PALETTE.length)], rnd() < 0.5 ? 0 : 1);
    ctx.restore();
  }
  return toTex(c, 1);
}

export function createMossTexture(size = 512): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(size);
  const n = tileableValueNoise(size, 8, 21, 6);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = n[y * size + x];
      const idx = (y * size + x) * 4;
      img.data[idx] = 62 + v * 40;
      img.data[idx + 1] = 78 + v * 50;
      img.data[idx + 2] = 30 + v * 16;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTex(c, 1);
}

export function createLeafAtlasTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256);
  const cols = ['#d0782a', '#b8541c', '#e0a838', '#9a3a1a'];
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.translate((i % 2) * 128 + 64, Math.floor(i / 2) * 128 + 64);
    drawLeaf(ctx, 110, cols[i], i % 2);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function recolorFoliageTexture(
  src: THREE.Texture,
  palette: string[],
): THREE.CanvasTexture {
  const img = src.image as HTMLImageElement | HTMLCanvasElement;
  const w = img.width;
  const h = img.height;
  const [c, ctx] = makeCanvas(w, h);
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const cols = palette.map((p) => new THREE.Color(p));
  const noise = createSimplex2D(palette.length * 13 + 5);
  const tmp = new THREE.Color();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data.data[i + 3] === 0) continue;
      const lum =
        0.3 * (data.data[i] / 255) +
        0.59 * (data.data[i + 1] / 255) +
        0.11 * (data.data[i + 2] / 255);
      const t = 0.5 + 0.5 * noise(x / 90, y / 90);
      const pos = Math.min(cols.length - 1.001, t * (cols.length - 1));
      const idx = Math.floor(pos);
      tmp.copy(cols[idx]).lerp(cols[idx + 1], pos - idx);
      const shade = 0.35 + lum * 1.5;
      data.data[i] = Math.min(255, tmp.r * shade * 255);
      data.data[i + 1] = Math.min(255, tmp.g * shade * 255);
      data.data[i + 2] = Math.min(255, tmp.b * shade * 255);
    }
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = src.flipY;
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.anisotropy = 4;
  return tex;
}

// --- Viewmodel & Craft Textures ---

export function createSkinTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256);
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#dca987');
  grad.addColorStop(0.55, '#d49d79');
  grad.addColorStop(1, '#c48966');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  const rnd = mulberry32(404);
  // Subtle warm subsurface mottling & pores
  for (let i = 0; i < 2400; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const r = 1 + rnd() * 3;
    ctx.fillStyle =
      rnd() < 0.5
        ? `rgba(165, 92, 68, ${0.03 + rnd() * 0.05})`
        : `rgba(255, 224, 198, ${0.03 + rnd() * 0.04})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Fine skin creases
  ctx.strokeStyle = 'rgba(130, 72, 48, 0.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 38; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 12, y + (rnd() - 0.5) * 6, x + 26, y + (rnd() - 0.5) * 4);
    ctx.stroke();
  }
  return toTex(c, 1, true, 8);
}

export function createWornLeatherTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256);
  ctx.fillStyle = '#5c3822';
  ctx.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(19);
  for (let i = 0; i < 3200; i++) {
    ctx.fillStyle =
      rnd() < 0.5
        ? `rgba(28, 14, 6, ${rnd() * 0.18})`
        : `rgba(190, 140, 96, ${rnd() * 0.11})`;
    ctx.fillRect(rnd() * 256, rnd() * 256, 2, 2);
  }
  // Worn scuff marks
  for (let i = 0; i < 42; i++) {
    ctx.strokeStyle = `rgba(180, 130, 88, ${0.08 + rnd() * 0.12})`;
    ctx.lineWidth = 1 + rnd() * 1.5;
    const x = rnd() * 256;
    const y = rnd() * 256;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 34, y + (rnd() - 0.5) * 34);
    ctx.stroke();
  }
  // Saddle stitching lines
  ctx.strokeStyle = 'rgba(232, 204, 158, 0.72)';
  ctx.lineWidth = 2.2;
  ctx.setLineDash([7, 5]);
  for (const y of [28, 228]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  return toTex(c, 1, true, 8);
}

export function createFlannelSleeveTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256);
  ctx.fillStyle = '#5c2820';
  ctx.fillRect(0, 0, 256, 256);
  const bar = (x: number, y: number, w: number, h: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w, h);
  };
  for (let i = 0; i < 256; i += 64) {
    bar(i, 0, 22, 256, 'rgba(24, 22, 26, 0.58)');
    bar(0, i, 256, 22, 'rgba(24, 22, 26, 0.58)');
    bar(i + 34, 0, 6, 256, 'rgba(218, 174, 96, 0.42)');
    bar(0, i + 34, 256, 6, 'rgba(218, 174, 96, 0.42)');
    bar(i + 44, 0, 2, 256, 'rgba(130, 62, 38, 0.35)');
    bar(0, i + 44, 256, 2, 'rgba(130, 62, 38, 0.35)');
  }
  const rnd = mulberry32(3);
  for (let i = 0; i < 5500; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.055})`;
    ctx.fillRect(rnd() * 256, rnd() * 256, 1, 2);
  }
  return toTex(c, 1, true, 8);
}

export function createWoodGrainTexture(baseColor = '#7a4a28'): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(128, 256);
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, 128, 256);
  const rnd = mulberry32(baseColor.length * 31 + 8);
  for (let i = 0; i < 65; i++) {
    ctx.strokeStyle =
      rnd() < 0.72
        ? `rgba(28, 12, 4, ${0.12 + rnd() * 0.24})`
        : `rgba(255, 220, 175, ${0.06 + rnd() * 0.09})`;
    ctx.lineWidth = 1 + rnd() * 2.2;
    const x = rnd() * 128;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + (rnd() - 0.5) * 14, 84, x - (rnd() - 0.5) * 14, 172, x + (rnd() - 0.5) * 8, 256);
    ctx.stroke();
  }
  return toTex(c, 1, true, 8);
}

const steelCache: Record<string, THREE.CanvasTexture> = {};

export function createBladeSteelTexture(
  style: 'plain' | 'satin' | 'damascus' = 'plain',
): THREE.CanvasTexture {
  if (steelCache[style]) return steelCache[style];
  const [c, ctx] = makeCanvas(256, 512);
  const grad = ctx.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, '#727982');
  grad.addColorStop(0.28, '#9fa6b0');
  grad.addColorStop(0.62, '#ced4dc');
  grad.addColorStop(0.82, '#eef2f7');
  grad.addColorStop(0.92, '#ffffff');
  grad.addColorStop(1, '#bcc3cc');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 512);

  const rnd = mulberry32(style === 'damascus' ? 91 : style === 'satin' ? 52 : 17);

  if (style === 'damascus') {
    for (let y = 0; y < 512; y += 3) {
      ctx.strokeStyle = y % 6 === 0 ? 'rgba(26, 30, 38, 0.44)' : 'rgba(255, 255, 255, 0.24)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let x = 0; x <= 256; x += 4) {
        const wy =
          y +
          Math.sin(x * 0.055 + y * 0.045) * 11 +
          Math.cos(x * 0.12 - y * 0.025) * 5;
        if (x === 0) ctx.moveTo(x, wy);
        else ctx.lineTo(x, wy);
      }
      ctx.stroke();
    }
  } else {
    // Horizontal satin grind striations across blade width
    for (let i = 0; i < 900; i++) {
      const a = rnd() * (style === 'satin' ? 0.08 : 0.14);
      ctx.fillStyle = rnd() < 0.55 ? `rgba(255,255,255,${a})` : `rgba(30,36,44,${a * 0.8})`;
      ctx.fillRect(rnd() * 256, rnd() * 512, 16 + rnd() * 44, 1);
    }
  }

  // Fuller shadow line near spine
  if (style !== 'plain') {
    ctx.fillStyle = 'rgba(24, 28, 34, 0.34)';
    ctx.fillRect(46, 48, 18, 330);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.38)';
    ctx.fillRect(64, 48, 4, 330);
  }

  // Honed bright bevel highlight along cutting edge
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.fillRect(218, 0, 12, 512);

  const tex = toTex(c, 1, true, 8);
  steelCache[style] = tex;
  return tex;
}

export function createWickerTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256);
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(0, 0, 256, 256);
  const rows = 12;
  const cols = 16;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = (col * 256) / cols;
      const y = (r * 256) / rows;
      const w = 256 / cols;
      const h = 256 / rows;
      const alt = (r + col) % 2 === 0;
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, alt ? '#c8955a' : '#9a6a38');
      g.addColorStop(0.5, alt ? '#e2b47a' : '#b07c44');
      g.addColorStop(1, alt ? '#a8763e' : '#7a5028');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w * 0.56, h * 0.44, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let col = 0; col <= cols; col++) {
    ctx.fillStyle = 'rgba(60,36,14,0.8)';
    ctx.fillRect((col * 256) / cols - 1.5, 0, 3, 256);
  }
  const tex = toTex(c, 1, true, 8);
  tex.repeat.set(2, 1);
  return tex;
}

export function createCheckClothTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(128);
  ctx.fillStyle = '#f6eedc';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 128; i += 32) {
    ctx.fillStyle = 'rgba(176, 62, 46, 0.78)';
    ctx.fillRect(i, 0, 14, 128);
    ctx.fillRect(0, i, 128, 14);
  }
  const tex = toTex(c, 3, true, 8);
  return tex;
}

export function createSignTexture(text = 'MUSHROOM BUYER'): THREE.CanvasTexture {
  const W = 1024, H = 320;
  const [c, ctx] = makeCanvas(W, H);
  // planks
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#3e2412'); g.addColorStop(1, '#2a170b');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 1; i < 4; i++) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, i * (H / 4), W, 3); }
  for (let i = 0; i < 90; i++) {
    ctx.strokeStyle = `rgba(255,220,170,${0.03 + Math.random() * 0.04})`;
    ctx.beginPath(); const y = Math.random() * H; ctx.moveTo(0, y);
    ctx.bezierCurveTo(W * 0.3, y + 6, W * 0.6, y - 6, W, y + 2); ctx.stroke();
  }
  // frame
  ctx.strokeStyle = '#c99a4a'; ctx.lineWidth = 10; ctx.strokeRect(14, 14, W - 28, H - 28);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3; ctx.strokeRect(24, 24, W - 48, H - 48);
  // auto-fit text
  let size = 150;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  do { ctx.font = `900 ${size}px Georgia, 'Times New Roman', serif`; size -= 4; } while (ctx.measureText(text).width > W - 110 && size > 40);
  ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillText(text, W / 2 + 5, H / 2 + 9);
  ctx.fillStyle = '#ffe7a8'; ctx.fillText(text, W / 2, H / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

export function createSlashDecalTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(128, 64);
  ctx.clearRect(0, 0, 128, 64);
  // Outer splinter rim
  const outer = ctx.createRadialGradient(64, 32, 4, 64, 32, 58);
  outer.addColorStop(0, 'rgba(182, 134, 82, 0.85)');
  outer.addColorStop(0.7, 'rgba(130, 88, 48, 0.45)');
  outer.addColorStop(1, 'rgba(90, 55, 25, 0)');
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.ellipse(64, 32, 56, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  // Deep dark carved core
  ctx.fillStyle = 'rgba(26, 14, 7, 0.94)';
  ctx.beginPath();
  ctx.moveTo(8, 32);
  ctx.quadraticCurveTo(64, 22, 120, 32);
  ctx.quadraticCurveTo(64, 42, 8, 32);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createMushroomCapTexture(
  hex: string,
  streaks: boolean,
  seed: number,
): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256);
  const rnd = mulberry32(seed);
  const col = new THREE.Color(hex);
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#' + col.clone().multiplyScalar(0.78).getHexString());
  grad.addColorStop(0.6, '#' + col.getHexString());
  grad.addColorStop(1, '#' + col.clone().lerp(new THREE.Color('#f0e0c0'), 0.25).getHexString());
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1200; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const r = 1 + rnd() * 5;
    const a = 0.05 + rnd() * 0.08;
    ctx.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,240,220,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (streaks) {
    for (let i = 0; i < 85; i++) {
      const x = rnd() * 256;
      ctx.strokeStyle = `rgba(60,30,10,${0.05 + rnd() * 0.08})`;
      ctx.lineWidth = 1 + rnd() * 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (rnd() - 0.5) * 10, 256);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export function createMushroomUnderTexture(
  kind: 'gills' | 'pores',
  hex: string,
): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256);
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, 256, 256);
  if (kind === 'gills') {
    for (let i = 0; i < 140; i++) {
      const a = (i / 140) * Math.PI * 2;
      ctx.strokeStyle = 'rgba(80,60,40,0.28)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(128 + Math.cos(a) * 18, 128 + Math.sin(a) * 18);
      ctx.lineTo(128 + Math.cos(a) * 128, 128 + Math.sin(a) * 128);
      ctx.stroke();
    }
  } else {
    for (let y = 0; y < 256; y += 5) {
      for (let x = 0; x < 256; x += 5) {
        ctx.fillStyle = 'rgba(90,80,20,0.22)';
        ctx.beginPath();
        ctx.arc(x + (y % 10 ? 2.5 : 0), y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.arc(128, 128, 18, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createMushroomStemTexture(
  hex: string,
  pattern: 'net' | 'scales' | 'fibre',
): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(128, 256);
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, 128, 256);
  const rnd = mulberry32(pattern.length * 7 + 3);
  if (pattern === 'scales') {
    for (let i = 0; i < 240; i++) {
      ctx.fillStyle = `rgba(30,25,20,${0.4 + rnd() * 0.4})`;
      ctx.fillRect(rnd() * 128, rnd() * 256, 2 + rnd() * 3, 1 + rnd() * 2);
    }
  } else if (pattern === 'net') {
    ctx.strokeStyle = 'rgba(150,120,80,0.35)';
    for (let y = 0; y < 120; y += 7) {
      for (let x = 0; x < 128; x += 9) {
        ctx.strokeRect(x + (y % 14 ? 4 : 0), y, 8, 6);
      }
    }
  } else if (pattern === 'fibre') {
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = 'rgba(120,90,60,0.12)';
      const x = rnd() * 128;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
    }
  }
  for (let i = 0; i < 360; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.05})`;
    ctx.fillRect(rnd() * 128, rnd() * 256, 2, 2);
  }
  const dirtGrad = ctx.createLinearGradient(0, 256, 0, 200);
  dirtGrad.addColorStop(0, 'rgba(70,50,30,0.7)');
  dirtGrad.addColorStop(1, 'rgba(70,50,30,0)');
  ctx.fillStyle = dirtGrad;
  ctx.fillRect(0, 200, 128, 56);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export function createQuiltBlanketTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256);
  // Warm rustic autumn plaid quilt base
  ctx.fillStyle = '#7e2f24';
  ctx.fillRect(0, 0, 256, 256);

  // Tartan weave bands
  for (let i = 0; i < 256; i += 64) {
    ctx.fillStyle = 'rgba(42, 62, 40, 0.56)';
    ctx.fillRect(i, 0, 22, 256);
    ctx.fillRect(0, i, 256, 22);

    ctx.fillStyle = 'rgba(224, 168, 76, 0.52)';
    ctx.fillRect(i + 28, 0, 7, 256);
    ctx.fillRect(0, i + 28, 256, 7);

    ctx.fillStyle = 'rgba(244, 228, 198, 0.36)';
    ctx.fillRect(i + 42, 0, 3, 256);
    ctx.fillRect(0, i + 42, 256, 3);
  }

  // Diagonal quilted diamond stitching
  ctx.strokeStyle = 'rgba(255, 236, 206, 0.28)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([5, 4]);
  for (let o = -256; o < 512; o += 32) {
    ctx.beginPath();
    ctx.moveTo(o, 0);
    ctx.lineTo(o + 256, 256);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(o, 256);
    ctx.lineTo(o + 256, 0);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Subtle woven wool grain
  const rnd = mulberry32(77);
  for (let i = 0; i < 4200; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,245,230,0.045)' : 'rgba(20,8,4,0.055)';
    ctx.fillRect(rnd() * 256, rnd() * 256, 2, 1);
  }

  return toTex(c, 1, true, 8);
}

export function createWovenRugTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256, 512);
  ctx.fillStyle = '#8b3a24';
  ctx.fillRect(0, 0, 256, 512);

  // Outer woven border
  ctx.strokeStyle = '#d8b472';
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 18, 228, 476);
  ctx.strokeStyle = '#3b4a34';
  ctx.lineWidth = 6;
  ctx.strokeRect(26, 30, 204, 452);

  // Horizontal folk-weave stripes & diamond motifs
  const bands: Array<[number, number, string]> = [
    [52, 24, '#e6d3ad'],
    [82, 14, '#c46a2c'],
    [110, 18, '#3d4f36'],
    [224, 64, '#5a2219'],
    [384, 18, '#3d4f36'],
    [416, 14, '#c46a2c'],
    [436, 24, '#e6d3ad'],
  ];
  for (const [y, h, col] of bands) {
    ctx.fillStyle = col;
    ctx.fillRect(32, y, 192, h);
  }

  // Center folk diamond medallions
  const drawDiamond = (cx: number, cy: number, rx: number, ry: number, col: string) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(cx, cy - ry);
    ctx.lineTo(cx + rx, cy);
    ctx.lineTo(cx, cy + ry);
    ctx.lineTo(cx - rx, cy);
    ctx.closePath();
    ctx.fill();
  };
  for (const cy of [175, 256, 337]) {
    drawDiamond(128, cy, 48, 30, '#e3c07a');
    drawDiamond(128, cy, 32, 19, '#943522');
    drawDiamond(128, cy, 14, 9, '#f2e4c4');
  }

  // Loom thread weave texture
  const rnd = mulberry32(131);
  for (let y = 0; y < 512; y += 3) {
    ctx.fillStyle = y % 6 === 0 ? 'rgba(255,244,220,0.06)' : 'rgba(18,10,6,0.08)';
    ctx.fillRect(0, y, 256, 1);
  }
  for (let i = 0; i < 3600; i++) {
    ctx.fillStyle = `rgba(255,240,210,${rnd() * 0.05})`;
    ctx.fillRect(rnd() * 256, rnd() * 512, 3, 1);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createFramedMapTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256, 192);
  // Aged parchment paper
  const grad = ctx.createRadialGradient(128, 96, 20, 128, 96, 145);
  grad.addColorStop(0, '#efe1be');
  grad.addColorStop(1, '#c9ae7e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 192);

  // Decorative ink frame
  ctx.strokeStyle = '#5a3b20';
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, 236, 172);
  ctx.lineWidth = 1;
  ctx.strokeRect(15, 15, 226, 162);

  // Winding forest trail loop
  ctx.strokeStyle = '#8b4e24';
  ctx.lineWidth = 3.5;
  ctx.setLineDash([7, 4]);
  ctx.beginPath();
  ctx.moveTo(52, 138);
  ctx.bezierCurveTo(64, 62, 142, 42, 188, 76);
  ctx.bezierCurveTo(216, 104, 186, 156, 122, 146);
  ctx.bezierCurveTo(86, 140, 62, 152, 52, 138);
  ctx.stroke();
  ctx.setLineDash([]);

  // Tiny hand-drawn pine icons
  const rnd = mulberry32(41);
  ctx.fillStyle = '#3d5830';
  for (let i = 0; i < 26; i++) {
    const x = 28 + rnd() * 200;
    const y = 28 + rnd() * 136;
    ctx.beginPath();
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x + 5, y + 3);
    ctx.lineTo(x - 5, y + 3);
    ctx.closePath();
    ctx.fill();
  }

  // Red X marking Mushroom Hollow camp
  ctx.strokeStyle = '#a82c1c';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(48, 132);
  ctx.lineTo(58, 142);
  ctx.moveTo(58, 132);
  ctx.lineTo(48, 142);
  ctx.stroke();

  // Simple compass rose in top-right
  ctx.strokeStyle = '#4a3018';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(214, 42, 14, 0, Math.PI * 2);
  ctx.moveTo(214, 24);
  ctx.lineTo(214, 60);
  ctx.moveTo(196, 42);
  ctx.lineTo(232, 42);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

