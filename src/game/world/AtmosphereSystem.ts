import * as THREE from 'three';
import type { ForestEventId, QualityLevel, WeatherKind } from '../types';
import { groundHeightAt, HUT_POSE, TRAIL } from './terrain';
import type { WorldData } from './WorldBuilder';

function createSoftBeamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(255, 226, 168, 0.0)');
  grad.addColorStop(0.22, 'rgba(255, 224, 160, 0.24)');
  grad.addColorStop(0.65, 'rgba(255, 212, 138, 0.14)');
  grad.addColorStop(1, 'rgba(255, 200, 120, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 256);

  // Horizontal Gaussian fade so edges never look polygonal
  ctx.globalCompositeOperation = 'destination-in';
  const hGrad = ctx.createLinearGradient(0, 0, 64, 0);
  hGrad.addColorStop(0, 'rgba(0,0,0,0)');
  hGrad.addColorStop(0.32, 'rgba(0,0,0,0.85)');
  hGrad.addColorStop(0.5, 'rgba(0,0,0,1)');
  hGrad.addColorStop(0.68, 'rgba(0,0,0,0.85)');
  hGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = hGrad;
  ctx.fillRect(0, 0, 64, 256);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSoftGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255, 250, 224, 1)');
  g.addColorStop(0.35, 'rgba(255, 220, 140, 0.65)');
  g.addColorStop(1, 'rgba(255, 180, 80, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Ember {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
}

interface RainDrop {
  x: number;
  y: number;
  z: number;
  spd: number;
  len: number;
}

interface Mote {
  x: number;
  y: number;
  z: number;
  phase: number;
  drift: number;
}

export class AtmosphereSystem {
  public weather: WeatherKind = 'clear';
  public targetWeather: WeatherKind = 'clear';
  public rainBlend = 0;
  public mistBlend = 0;
  public clearBlend = 1;
  public weatherTimer = 115;

  public readonly campfireGroup = new THREE.Group();
  public readonly campfirePos: THREE.Vector3;
  private readonly fireLight: THREE.PointLight;
  private readonly flameMeshes: THREE.Mesh[] = [];
  private readonly emberPos: Float32Array;
  private readonly emberPoints: THREE.Points;
  private readonly embers: Ember[] = [];
  private readonly smokePos: Float32Array;
  private readonly smokePoints: THREE.Points;
  private readonly smoke: Ember[] = [];

  private readonly sunShafts: Array<{ mesh: THREE.Mesh; baseOpacity: number; phase: number }> = [];
  private readonly sunShaftGroup = new THREE.Group();
  private readonly beamTex: THREE.CanvasTexture;
  private readonly glowTex: THREE.CanvasTexture;

  private readonly rainCount: number;
  private readonly rainDrops: RainDrop[] = [];
  private readonly rainPos: Float32Array;
  private readonly rainLines: THREE.LineSegments;
  private readonly rainMat: THREE.LineBasicMaterial;

  private readonly moteCount: number;
  private readonly motes: Mote[] = [];
  private readonly motePos: Float32Array;
  private readonly moteCol: Float32Array;
  private readonly motePoints: THREE.Points;
  private readonly moteMat: THREE.PointsMaterial;

  private elapsed = 0;
  private readonly _tmpColor = new THREE.Color();
  private readonly _dayMoteCol = new THREE.Color('#ffe5a8');
  private readonly _fireflyCol = new THREE.Color('#d6ff7a');
  private readonly _fairyCol = new THREE.Color('#ffe474');

  constructor(
    private readonly scene: THREE.Scene,
    campfirePos: THREE.Vector3,
    quality: QualityLevel,
    isSoftwareGl: boolean,
  ) {
    this.campfirePos = campfirePos.clone();
    this.beamTex = createSoftBeamTexture();
    this.glowTex = createSoftGlowTexture();

    // --- 1. Composite 3D Homestead Campfire (Stones + Charred Logs + Embers + 3 Flame Cones + Sparks + Smoke) ---
    this.campfireGroup.position.copy(this.campfirePos);

    const stoneMat = new THREE.MeshStandardMaterial({
      color: '#6b655c',
      roughness: 0.92,
      metalness: 0.04,
    });
    const charredMat = new THREE.MeshStandardMaterial({
      color: '#322218',
      roughness: 0.96,
    });
    const emberBedMat = new THREE.MeshStandardMaterial({
      color: '#5a1e08',
      emissive: new THREE.Color('#ff5514'),
      emissiveIntensity: 1.5,
      roughness: 0.9,
    });

    // Ring of 10 mossy hearth stones
    const stoneGeo = new THREE.DodecahedronGeometry(0.16, 1);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + (i % 2) * 0.1;
      const r = 0.56 + (i % 3) * 0.03;
      const st = new THREE.Mesh(stoneGeo, stoneMat);
      st.position.set(Math.cos(a) * r, 0.08, Math.sin(a) * r);
      st.scale.set(1.25, 0.72 + (i % 2) * 0.16, 0.95);
      st.rotation.set(i * 0.4, a, i * 0.25);
      st.castShadow = true;
      st.receiveShadow = true;
      this.campfireGroup.add(st);
    }

    // Glowing coal & ash mound
    const ashBed = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.52, 0.08, 16), emberBedMat);
    ashBed.position.y = 0.04;
    this.campfireGroup.add(ashBed);

    // 5 crossed firewood logs tilted into a pyramid
    const logGeo = new THREE.CylinderGeometry(0.055, 0.068, 0.72, 9);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.25;
      const log = new THREE.Mesh(logGeo, charredMat);
      log.position.set(Math.cos(a) * 0.18, 0.14, Math.sin(a) * 0.18);
      log.rotation.order = 'YXZ';
      log.rotation.y = a;
      log.rotation.x = 1.05;
      log.castShadow = true;
      log.receiveShadow = true;
      this.campfireGroup.add(log);
    }

    // Multi-layered stylized warm flame tongues (outer orange, mid amber, inner pale gold)
    const flameDefs = [
      { r: 0.24, h: 0.68, col: '#ff5d14', op: 0.78, ox: 0, oz: 0 },
      { r: 0.17, h: 0.56, col: '#ffaa2b', op: 0.86, ox: 0.05, oz: -0.04 },
      { r: 0.11, h: 0.42, col: '#fff0a8', op: 0.92, ox: -0.04, oz: 0.04 },
    ];
    for (const fd of flameDefs) {
      const fGeo = new THREE.ConeGeometry(fd.r, fd.h, 7, 1, true);
      fGeo.translate(0, fd.h * 0.48, 0);
      const fMat = new THREE.MeshBasicMaterial({
        color: fd.col,
        transparent: true,
        opacity: fd.op,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(fGeo, fMat);
      mesh.position.set(fd.ox, 0.08, fd.oz);
      this.campfireGroup.add(mesh);
      this.flameMeshes.push(mesh);
    }

    // Warm flickering campfire PointLight
    this.fireLight = new THREE.PointLight('#ff8f3a', 14, 17, 1.55);
    this.fireLight.position.set(0, 0.78, 0);
    this.campfireGroup.add(this.fireLight);

    // Rising glowing sparks (36 embers)
    const emberCount = 36;
    this.emberPos = new Float32Array(emberCount * 3);
    for (let i = 0; i < emberCount; i++) {
      this.embers.push({
        x: 0,
        y: Math.random() * 2.4,
        z: 0,
        vx: (Math.random() - 0.5) * 0.28,
        vy: 0.7 + Math.random() * 0.9,
        vz: (Math.random() - 0.5) * 0.28,
        life: Math.random() * 2.2,
        maxLife: 1.4 + Math.random() * 1.4,
      });
    }
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(this.emberPos, 3));
    this.emberPoints = new THREE.Points(
      eGeo,
      new THREE.PointsMaterial({
        size: 0.09,
        map: this.glowTex,
        color: '#ffba52',
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.emberPoints.frustumCulled = false;
    this.campfireGroup.add(this.emberPoints);

    // Soft rising hearth smoke (18 puffs)
    const smokeCount = 18;
    this.smokePos = new Float32Array(smokeCount * 3);
    for (let i = 0; i < smokeCount; i++) {
      this.smoke.push({
        x: (Math.random() - 0.5) * 0.2,
        y: 0.6 + Math.random() * 4.5,
        z: (Math.random() - 0.5) * 0.2,
        vx: 0.14 + Math.random() * 0.12,
        vy: 0.65 + Math.random() * 0.35,
        vz: (Math.random() - 0.5) * 0.14,
        life: Math.random() * 5,
        maxLife: 4.5 + Math.random() * 2.5,
      });
    }
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(this.smokePos, 3));
    this.smokePoints = new THREE.Points(
      sGeo,
      new THREE.PointsMaterial({
        size: 0.85,
        map: this.glowTex,
        color: '#bfb8ad',
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    this.smokePoints.frustumCulled = false;
    this.campfireGroup.add(this.smokePoints);

    this.scene.add(this.campfireGroup);

    // --- 2. Volumetric Sun Shafts (angled golden rays through tall pines) ---
    const shaftCount = isSoftwareGl ? 8 : quality === 'high' ? 18 : 12;
    const shaftGeo = new THREE.PlaneGeometry(3.6, 24);
    for (let i = 0; i < shaftCount; i++) {
      // Place shafts around homestead clearing & along the forest trail
      let sx: number;
      let sz: number;
      if (i < 4) {
        const a = (i / 4) * Math.PI * 2 + 0.5;
        sx = HUT_POSE.x + Math.cos(a) * (10 + i * 3);
        sz = HUT_POSE.z + Math.sin(a) * (10 + i * 3);
      } else {
        const samp = TRAIL.samples[Math.floor(((i - 4) / Math.max(1, shaftCount - 4)) * (TRAIL.samples.length - 1))];
        const side = i % 2 === 0 ? 1 : -1;
        sx = samp.x + side * (6 + (i % 5) * 4);
        sz = samp.z + (i % 3 - 1) * 7;
      }
      const sy = groundHeightAt(sx, sz);
      const mat = new THREE.MeshBasicMaterial({
        map: this.beamTex,
        color: '#ffe3a8',
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(shaftGeo, mat);
      mesh.position.set(sx, sy + 10.5, sz);
      mesh.rotation.y = (i * 1.13) % Math.PI;
      mesh.scale.set(0.85 + (i % 3) * 0.35, 1, 1);
      this.sunShaftGroup.add(mesh);
      this.sunShafts.push({ mesh, baseOpacity: 0.09 + (i % 3) * 0.03, phase: i * 0.85 });
    }
    this.scene.add(this.sunShaftGroup);

    // --- 3. Dynamic Autumn Rain Streaks ---
    this.rainCount = isSoftwareGl ? 180 : quality === 'high' ? 620 : quality === 'medium' ? 420 : 240;
    this.rainPos = new Float32Array(this.rainCount * 6);
    for (let i = 0; i < this.rainCount; i++) {
      this.rainDrops.push({
        x: (Math.random() - 0.5) * 28,
        y: Math.random() * 16,
        z: (Math.random() - 0.5) * 28,
        spd: 14 + Math.random() * 5,
        len: 0.45 + Math.random() * 0.32,
      });
    }
    const rGeo = new THREE.BufferGeometry();
    rGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rainMat = new THREE.LineBasicMaterial({
      color: '#cbd8e6',
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.rainLines = new THREE.LineSegments(rGeo, this.rainMat);
    this.rainLines.frustumCulled = false;
    this.rainLines.visible = false;
    this.scene.add(this.rainLines);

    // --- 4. Floating Golden Forest Pollen & Dusk Fireflies ---
    this.moteCount = isSoftwareGl ? 70 : quality === 'high' ? 200 : 130;
    this.motePos = new Float32Array(this.moteCount * 3);
    this.moteCol = new Float32Array(this.moteCount * 3);
    for (let i = 0; i < this.moteCount; i++) {
      this.motes.push({
        x: (Math.random() - 0.5) * 32,
        y: 0.5 + Math.random() * 4.5,
        z: (Math.random() - 0.5) * 32,
        phase: Math.random() * Math.PI * 2,
        drift: 0.35 + Math.random() * 0.65,
      });
    }
    const mGeo = new THREE.BufferGeometry();
    mGeo.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3));
    mGeo.setAttribute('color', new THREE.BufferAttribute(this.moteCol, 3));
    this.moteMat = new THREE.PointsMaterial({
      size: 0.12,
      map: this.glowTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.motePoints = new THREE.Points(mGeo, this.moteMat);
    this.motePoints.frustumCulled = false;
    this.scene.add(this.motePoints);
  }

  public setWeatherImmediate(w: WeatherKind) {
    this.weather = w;
    this.targetWeather = w;
    this.clearBlend = w === 'clear' ? 1 : 0;
    this.mistBlend = w === 'mist' ? 1 : 0;
    this.rainBlend = w === 'rain' ? 1 : 0;
    this.weatherTimer = 95 + Math.random() * 90;
  }

  public transitionWeather(w: WeatherKind) {
    this.targetWeather = w;
    this.weather = w;
    this.weatherTimer = 95 + Math.random() * 90;
  }

  public getStealthMultiplier(): number {
    // Rain muffles footsteps by ~30%, mist by ~12%
    return 1 - this.rainBlend * 0.3 - this.mistBlend * 0.12;
  }

  public getRegrowMultiplier(eventId: ForestEventId): number {
    const rainMult = 1 + this.rainBlend * 0.75;
    const evMult = eventId === 'mushroom_rain' ? 1.65 : 1;
    return rainMult * evMult;
  }

  public update(
    dt: number,
    world: WorldData,
    camPos: THREE.Vector3,
    eventId: ForestEventId,
    allowAutoShift: boolean,
    onWeatherAutoShift?: (next: WeatherKind) => void,
  ) {
    this.elapsed += dt;

    // 1. Dynamic weather progression during gameplay
    if (allowAutoShift) {
      this.weatherTimer -= dt;
      if (this.weatherTimer <= 0) {
        const roll = Math.random();
        let next: WeatherKind;
        if (eventId === 'mushroom_rain') {
          next = roll < 0.7 ? 'rain' : 'mist';
        } else {
          next = roll < 0.5 ? 'clear' : roll < 0.78 ? 'mist' : 'rain';
        }
        if (next !== this.targetWeather) {
          this.transitionWeather(next);
          onWeatherAutoShift?.(next);
        } else {
          this.weatherTimer = 85 + Math.random() * 65;
        }
      }
    }

    const blendRate = 1 - Math.exp(-dt * 0.32);
    this.clearBlend += ((this.targetWeather === 'clear' ? 1 : 0) - this.clearBlend) * blendRate;
    this.mistBlend += ((this.targetWeather === 'mist' ? 1 : 0) - this.mistBlend) * blendRate;
    this.rainBlend += ((this.targetWeather === 'rain' ? 1 : 0) - this.rainBlend) * blendRate;

    // Apply atmospheric weather overlay on top of updateDaylight()
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.density += this.mistBlend * 0.017 + this.rainBlend * 0.011;
      if (this.rainBlend > 0.01) {
        fog.color.lerp(this._tmpColor.set('#687482'), this.rainBlend * 0.55 * world.daylight);
      }
      if (this.mistBlend > 0.01) {
        fog.color.lerp(this._tmpColor.set('#d4ccb8'), this.mistBlend * 0.42 * world.daylight);
      }
    }
    world.sun.intensity *= 1 - this.rainBlend * 0.52 - this.mistBlend * 0.28;
    world.hemi.intensity *= 1 - this.rainBlend * 0.16;
    world.windUniform.value += dt * (this.rainBlend * 1.45 + this.mistBlend * 0.2);

    // 2. Living Campfire Animation (flames, light flicker, embers, smoke)
    const flicker =
      0.86 +
      Math.sin(this.elapsed * 11.4) * 0.08 +
      Math.sin(this.elapsed * 23.7) * 0.05 +
      Math.cos(this.elapsed * 5.2) * 0.04;
    const nightBoost = 1 + (1 - world.daylight) * 0.75;
    const rainDamp = 1 - this.rainBlend * 0.18;
    this.fireLight.intensity = 13.5 * flicker * nightBoost * rainDamp;
    this.fireLight.position.x = Math.sin(this.elapsed * 7.3) * 0.04;
    this.fireLight.position.z = Math.cos(this.elapsed * 8.1) * 0.04;

    for (let i = 0; i < this.flameMeshes.length; i++) {
      const fm = this.flameMeshes[i];
      const p = this.elapsed * (8.5 + i * 2.7) + i * 1.9;
      fm.scale.set(
        (0.92 + Math.sin(p) * 0.13) * rainDamp,
        (0.88 + Math.cos(p * 1.15) * 0.22) * rainDamp,
        (0.92 + Math.cos(p * 0.9) * 0.13) * rainDamp,
      );
      fm.rotation.y += dt * (i % 2 === 0 ? 1.4 : -1.8);
      fm.rotation.z = Math.sin(p * 0.6) * 0.09;
    }

    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i];
      e.life += dt;
      if (e.life >= e.maxLife) {
        e.life = 0;
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.22;
        e.x = Math.cos(a) * r;
        e.y = 0.12 + Math.random() * 0.16;
        e.z = Math.sin(a) * r;
        e.vx = (Math.random() - 0.5) * 0.35;
        e.vy = 0.75 + Math.random() * 0.95;
        e.vz = (Math.random() - 0.5) * 0.35;
      } else {
        e.x += (e.vx + Math.sin(this.elapsed * 3.5 + i) * 0.22) * dt;
        e.y += e.vy * dt;
        e.z += (e.vz + Math.cos(this.elapsed * 3.1 + i) * 0.22) * dt;
      }
      this.emberPos[i * 3] = e.x;
      this.emberPos[i * 3 + 1] = e.y;
      this.emberPos[i * 3 + 2] = e.z;
    }
    this.emberPoints.geometry.attributes.position.needsUpdate = true;

    for (let i = 0; i < this.smoke.length; i++) {
      const s = this.smoke[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        s.life = 0;
        s.x = (Math.random() - 0.5) * 0.18;
        s.y = 0.55;
        s.z = (Math.random() - 0.5) * 0.18;
      } else {
        s.x += (s.vx + Math.sin(this.elapsed * 0.8 + i) * 0.12) * dt;
        s.y += s.vy * dt;
        s.z += s.vz * dt;
      }
      this.smokePos[i * 3] = s.x;
      this.smokePos[i * 3 + 1] = s.y;
      this.smokePos[i * 3 + 2] = s.z;
    }
    this.smokePoints.geometry.attributes.position.needsUpdate = true;

    // 3. Volumetric Sun Shafts (soft golden beams angled with sunDir)
    const shaftAlpha = Math.max(0, world.daylight * (1 - this.rainBlend * 0.92 - this.mistBlend * 0.55));
    this.sunShaftGroup.visible = shaftAlpha > 0.03;
    if (this.sunShaftGroup.visible) {
      const tiltX = THREE.MathUtils.clamp(-world.sunDir.z * 0.48, -0.45, 0.45);
      const tiltZ = THREE.MathUtils.clamp(world.sunDir.x * 0.48, -0.45, 0.45);
      for (const sh of this.sunShafts) {
        sh.mesh.rotation.x = tiltX;
        sh.mesh.rotation.z = tiltZ;
        const pulse = 0.84 + Math.sin(this.elapsed * 0.55 + sh.phase) * 0.16;
        (sh.mesh.material as THREE.MeshBasicMaterial).opacity = sh.baseOpacity * shaftAlpha * pulse;
      }
    }

    // 4. Rain Streaks around Camera
    this.rainLines.visible = this.rainBlend > 0.04;
    if (this.rainLines.visible) {
      this.rainMat.opacity = this.rainBlend * 0.42;
      const windX = 1.6 + Math.sin(this.elapsed * 0.7) * 0.6;
      const windZ = 0.8;
      const half = 14;
      for (let i = 0; i < this.rainCount; i++) {
        const d = this.rainDrops[i];
        d.y -= d.spd * dt;
        d.x += windX * dt;
        d.z += windZ * dt;

        // Wrap tightly around camera
        if (d.y < camPos.y - 3) d.y = camPos.y + 11 + Math.random() * 3;
        if (d.x - camPos.x > half) d.x -= half * 2;
        if (d.x - camPos.x < -half) d.x += half * 2;
        if (d.z - camPos.z > half) d.z -= half * 2;
        if (d.z - camPos.z < -half) d.z += half * 2;

        const idx = i * 6;
        this.rainPos[idx] = d.x;
        this.rainPos[idx + 1] = d.y;
        this.rainPos[idx + 2] = d.z;
        this.rainPos[idx + 3] = d.x - windX * 0.045;
        this.rainPos[idx + 4] = d.y + d.len;
        this.rainPos[idx + 5] = d.z - windZ * 0.045;
      }
      this.rainLines.geometry.attributes.position.needsUpdate = true;
    }

    // 5. Floating Forest Dust Motes (Day) -> Glowing Fireflies (Dusk/Night/Fairy Event)
    const night = 1 - world.daylight;
    const isFairy = eventId === 'fairy_glow';
    const baseCol = night > 0.35 ? this._fireflyCol : isFairy ? this._fairyCol : this._dayMoteCol;
    const moteHalf = 16;
    this.moteMat.opacity = (0.35 + night * 0.55 + (isFairy ? 0.25 : 0)) * (1 - this.rainBlend * 0.65);

    for (let i = 0; i < this.moteCount; i++) {
      const m = this.motes[i];
      m.x += Math.sin(this.elapsed * 0.45 * m.drift + m.phase) * 0.24 * dt;
      m.z += Math.cos(this.elapsed * 0.38 * m.drift + m.phase) * 0.24 * dt;
      m.y += Math.sin(this.elapsed * 0.9 + m.phase) * 0.14 * dt;

      if (m.x - camPos.x > moteHalf) m.x -= moteHalf * 2;
      if (m.x - camPos.x < -moteHalf) m.x += moteHalf * 2;
      if (m.z - camPos.z > moteHalf) m.z -= moteHalf * 2;
      if (m.z - camPos.z < -moteHalf) m.z += moteHalf * 2;

      const gy = groundHeightAt(m.x, m.z);
      const wy = gy + 0.4 + (((m.y % 4.5) + 4.5) % 4.5);
      const pulse = 0.55 + 0.45 * Math.sin(this.elapsed * (night > 0.35 ? 2.6 : 1.1) + m.phase);

      this.motePos[i * 3] = m.x;
      this.motePos[i * 3 + 1] = wy;
      this.motePos[i * 3 + 2] = m.z;
      this.moteCol[i * 3] = baseCol.r * pulse;
      this.moteCol[i * 3 + 1] = baseCol.g * pulse;
      this.moteCol[i * 3 + 2] = baseCol.b * pulse;
    }
    this.motePoints.geometry.attributes.position.needsUpdate = true;
    this.motePoints.geometry.attributes.color.needsUpdate = true;
  }

  public dispose() {
    this.beamTex.dispose();
    this.glowTex.dispose();
    this.scene.remove(this.campfireGroup);
    this.scene.remove(this.sunShaftGroup);
    this.scene.remove(this.rainLines);
    this.scene.remove(this.motePoints);
  }
}
