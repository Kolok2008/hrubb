import * as THREE from 'three';
import type { KnifeLook } from '../types';
import { createBladeSteelTexture, createWoodGrainTexture } from '../utils/textures';

export interface KnifeRig {
  group: THREE.Group;
  steelMaterial: THREE.MeshPhysicalMaterial;
  stainMaterial: THREE.MeshStandardMaterial;
  tipMarker: THREE.Object3D;
  heelMarker: THREE.Object3D;
  setStain: (dirt: number, blood: number) => void;
}

/**
 * Applies first-person viewmodel depth compression so hands & knife never clip into
 * nearby trees, hut walls, or mushrooms while keeping full 3D perspective & lighting.
 */
export function applyViewmodelDepth<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       gl_Position.z = gl_Position.z * 0.08 - 0.88 * gl_Position.w;`,
    );
  };
  mat.customProgramCacheKey = () => 'vm-depth-v1';
  return mat;
}

/**
 * Builds a true 3D diamond/hollow-grind blade BufferGeometry:
 * spine has real thickness (~3.4mm) tapering smoothly down to a sharp bevel edge,
 * with realistic profile curves for drop-point, Bowie clip-point, or curved forager hawkbill.
 */
function buildSculptedBladeGeometry(style: KnifeLook['blade']): THREE.BufferGeometry {
  // Define (y along blade, spineX, edgeX, halfThickness) cross-sections from bolster to tip
  const sections: Array<[number, number, number, number]> =
    style === 'clip'
      ? [
          [0.0, -0.0155, 0.0155, 0.0024],
          [0.016, -0.016, 0.0165, 0.0024],
          [0.055, -0.0165, 0.0175, 0.0023],
          [0.105, -0.017, 0.0185, 0.0021],
          [0.135, -0.009, 0.0175, 0.0018],
          [0.165, -0.0035, 0.013, 0.0013],
          [0.192, 0.001, 0.0055, 0.0007],
          [0.206, 0.002, 0.002, 0.00018],
        ]
      : style === 'hook'
        ? [
            [0.0, -0.013, 0.012, 0.002],
            [0.025, -0.015, 0.011, 0.002],
            [0.058, -0.016, 0.009, 0.0018],
            [0.088, -0.014, 0.006, 0.0016],
            [0.114, -0.007, 0.008, 0.0014],
            [0.132, 0.005, 0.013, 0.001],
            [0.142, 0.017, 0.019, 0.0002],
          ]
        : [
            // Classic drop-point bushcraft / Damascus blade
            [0.0, -0.0145, 0.014, 0.0022],
            [0.02, -0.015, 0.015, 0.0022],
            [0.068, -0.0155, 0.016, 0.0021],
            [0.112, -0.014, 0.0155, 0.0018],
            [0.145, -0.0095, 0.012, 0.0013],
            [0.168, -0.003, 0.006, 0.00075],
            [0.182, 0.001, 0.001, 0.00018],
          ];

  const maxY = sections[sections.length - 1][0];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Each cross-section ring has 6 vertices around the blade perimeter:
  // 0: spine back-left, 1: spine back-right,
  // 2: bevel ridge right, 3: sharp cutting edge,
  // 4: bevel ridge left, 5: spine back-left (duplicate for clean UV seam)
  const ringStride = 6;

  for (let i = 0; i < sections.length; i++) {
    const [y, sx, ex, ht] = sections[i];
    const ridgeX = THREE.MathUtils.lerp(sx, ex, 0.48);
    const ridgeZ = ht * 0.92;
    const spineZ = ht * 0.72;
    const v = y / maxY;

    const ring: Array<[number, number, number, number]> = [
      [sx, y, -spineZ, 0.0],
      [sx, y, spineZ, 0.14],
      [ridgeX, y, ridgeZ, 0.56],
      [ex, y, 0, 0.98],
      [ridgeX, y, -ridgeZ, 0.56],
      [sx, y, -spineZ, 0.0],
    ];

    for (const [px, py, pz, u] of ring) {
      positions.push(px, py, pz);
      uvs.push(u, v);
    }
  }

  for (let i = 0; i < sections.length - 1; i++) {
    const a0 = i * ringStride;
    const b0 = (i + 1) * ringStride;
    for (let k = 0; k < ringStride - 1; k++) {
      const p0 = a0 + k;
      const p1 = a0 + k + 1;
      const p2 = b0 + k;
      const p3 = b0 + k + 1;
      indices.push(p0, p1, p3, p0, p3, p2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function buildKnifeModel(
  look: KnifeLook,
  useViewmodelDepth = true,
  envMap: THREE.Texture | null = null,
): KnifeRig {
  const wrap = <T extends THREE.Material>(m: T): T =>
    useViewmodelDepth ? applyViewmodelDepth(m) : m;

  const group = new THREE.Group();

  // --- Materials ---
  const woodMat = wrap(
    new THREE.MeshStandardMaterial({
      map: createWoodGrainTexture(look.handle),
      roughness: 0.44,
      metalness: 0.04,
    }),
  );

  const brassMat = wrap(
    new THREE.MeshPhysicalMaterial({
      color: '#cfa95e',
      metalness: 0.92,
      roughness: 0.24,
      clearcoat: 0.25,
      envMap,
      envMapIntensity: 0.9,
    }),
  );

  const darkSteelMat = wrap(
    new THREE.MeshStandardMaterial({
      color: '#343840',
      metalness: 0.85,
      roughness: 0.38,
      envMap,
      envMapIntensity: 0.75,
    }),
  );

  const steelMaterial = wrap(
    new THREE.MeshPhysicalMaterial({
      map: createBladeSteelTexture(look.steel),
      color: '#f4f7fa',
      metalness: look.steel === 'damascus' ? 0.92 : 0.88,
      roughness: look.steel === 'satin' ? 0.26 : 0.16,
      anisotropy: 0.72,
      anisotropyRotation: Math.PI / 2,
      clearcoat: 0.35,
      clearcoatRoughness: 0.18,
      envMap,
      envMapIntensity: 0.95,
    }),
  );

  // --- 1. Ergonomic Contoured Handle (Lathe + finger swell + grip flat scale) ---
  const handlePts =
    look.blade === 'clip'
      ? [
          [0, 0],
          [0.014, 0.003],
          [0.0175, 0.022],
          [0.0155, 0.056],
          [0.0168, 0.088],
          [0.015, 0.114],
          [0, 0.116],
        ]
      : [
          [0, 0],
          [0.0135, 0.004],
          [0.0168, 0.028],
          [0.0155, 0.068],
          [0.0172, 0.104],
          [0.0142, 0.115],
          [0, 0.116],
        ];
  const handleGeo = new THREE.LatheGeometry(
    handlePts.map(([r, y]) => new THREE.Vector2(r, y)),
    20,
  );
  const handleMesh = new THREE.Mesh(handleGeo, woodMat);
  handleMesh.scale.set(1.06, 1, 0.72);
  group.add(handleMesh);

  // Full-tang steel spine peeking through handle sides
  const tangMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.031, 0.11, 0.0042),
    darkSteelMat,
  );
  tangMesh.position.set(0, 0.058, 0);
  group.add(tangMesh);

  // --- 2. Brass Rivets / Pins & Lanyard Tube ---
  for (const ry of [0.026, 0.062, 0.094]) {
    const rivet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0032, 0.0032, 0.026, 10),
      brassMat,
    );
    rivet.rotation.x = Math.PI / 2;
    rivet.position.set(0, ry, 0);
    group.add(rivet);
  }

  // Brass Pommel Cap & Lanyard Ring
  const pommel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0135, 0.0145, 0.011, 16),
    brassMat,
  );
  pommel.scale.set(1.04, 1, 0.74);
  pommel.position.y = 0.002;
  group.add(pommel);

  if (look.brush) {
    // Boar-bristle mushroom cleaning brush mounted on pommel
    const ferrule = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0095, 0.0105, 0.014, 12),
      brassMat,
    );
    ferrule.position.y = -0.01;
    group.add(ferrule);
    const bristles = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.0085, 0.032, 14),
      wrap(new THREE.MeshStandardMaterial({ color: '#ddd0ae', roughness: 0.96 })),
    );
    bristles.position.y = -0.031;
    group.add(bristles);
  } else {
    // Leather lanyard loop on pommel
    const lanyardRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.008, 0.0018, 8, 16),
      brassMat,
    );
    lanyardRing.position.set(0, -0.008, 0);
    group.add(lanyardRing);
  }

  // --- 3. Bolster / Crossguard / Virobloc Collar ---
  if (look.blade === 'clip') {
    // Heavy S-curved brass hunter crossguard + leather spacer rings
    const guard = new THREE.Mesh(
      new THREE.BoxGeometry(0.064, 0.0085, 0.023),
      brassMat,
    );
    guard.position.set(0.003, 0.118, 0);
    group.add(guard);

    const guardLowerTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 10, 8),
      brassMat,
    );
    guardLowerTip.position.set(0.033, 0.114, 0);
    group.add(guardLowerTip);

    const guardUpperTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.0052, 10, 8),
      brassMat,
    );
    guardUpperTip.position.set(-0.027, 0.121, 0);
    group.add(guardUpperTip);

    for (const sy of [0.104, 0.11]) {
      const spacer = new THREE.Mesh(
        new THREE.CylinderGeometry(0.016, 0.016, 0.003, 16),
        brassMat,
      );
      spacer.scale.set(1.05, 1, 0.72);
      spacer.position.y = sy;
      group.add(spacer);
    }
  } else {
    // Classic brass bolster collar + finger choil guard
    const bolster = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0152, 0.0166, 0.018, 18),
      brassMat,
    );
    bolster.scale.set(1.06, 1, 0.74);
    bolster.position.y = 0.115;
    group.add(bolster);

    const fingerStop = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.006, 0.02),
      brassMat,
    );
    fingerStop.position.set(0.004, 0.123, 0);
    group.add(fingerStop);
  }

  // --- 4. Sculpted 3D Beveled Steel Blade ---
  const bladeGeo = buildSculptedBladeGeometry(look.blade);
  const bladeMesh = new THREE.Mesh(bladeGeo, steelMaterial);
  bladeMesh.position.set(0, 0.123, 0);
  group.add(bladeMesh);

  // Spine thumb jimping notches (craft accent detail)
  for (let i = 0; i < 6; i++) {
    const notch = new THREE.Mesh(
      new THREE.BoxGeometry(0.0022, 0.0022, 0.0046),
      darkSteelMat,
    );
    notch.position.set(-0.0155, 0.13 + i * 0.0048, 0);
    group.add(notch);
  }

  // --- 5. Dynamic Stain Overlay Mesh (mud / sap / wolf blood, wipeable with R) ---
  const stainMaterial = wrap(
    new THREE.MeshStandardMaterial({
      color: '#5a3b20',
      roughness: 0.92,
      metalness: 0.08,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  const stainMesh = new THREE.Mesh(bladeGeo, stainMaterial);
  stainMesh.position.copy(bladeMesh.position);
  stainMesh.scale.set(1.02, 0.98, 1.18);
  group.add(stainMesh);

  // --- 6. Blade Physics Sweep Markers (heel & tip for real 3D swing arc collision) ---
  const bladeLen = look.blade === 'clip' ? 0.206 : look.blade === 'hook' ? 0.142 : 0.182;
  const heelMarker = new THREE.Object3D();
  heelMarker.position.set(0.012, 0.132, 0);
  const tipMarker = new THREE.Object3D();
  tipMarker.position.set(look.blade === 'hook' ? 0.018 : 0.003, 0.123 + bladeLen, 0);
  group.add(heelMarker, tipMarker);

  const baseColor = new THREE.Color('#f4f7fa');
  const mudColor = new THREE.Color('#5a3c22');
  const bloodColor = new THREE.Color('#6b120e');
  const mixColor = new THREE.Color();

  const setStain = (dirt: number, blood: number) => {
    const d = THREE.MathUtils.clamp(dirt / 3, 0, 1);
    const b = THREE.MathUtils.clamp(blood, 0, 1);
    const total = Math.max(d, b);
    stainMaterial.opacity = total * 0.72;
    if (b >= d) {
      stainMaterial.color.copy(bloodColor).lerp(mudColor, d * 0.4);
    } else {
      stainMaterial.color.copy(mudColor).lerp(bloodColor, b * 0.5);
    }
    mixColor.copy(baseColor).lerp(stainMaterial.color, total * 0.35);
    steelMaterial.color.copy(mixColor);
    steelMaterial.roughness = (look.steel === 'satin' ? 0.26 : 0.16) + total * 0.38;
  };

  return {
    group,
    steelMaterial,
    stainMaterial,
    tipMarker,
    heelMarker,
    setStain,
  };
}

/**
 * Velocity-driven 3D steel slash trail ribbon rendered in world space during knife swings.
 */
export class SlashTrailRibbon {
  public readonly mesh: THREE.Mesh;
  private readonly maxSamples = 14;
  private readonly tipHistory: THREE.Vector3[] = [];
  private readonly heelHistory: THREE.Vector3[] = [];
  private readonly positions: Float32Array;
  private readonly alphas: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private active = false;
  private fade = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < this.maxSamples; i++) {
      this.tipHistory.push(new THREE.Vector3());
      this.heelHistory.push(new THREE.Vector3());
    }
    this.positions = new Float32Array(this.maxSamples * 2 * 3);
    this.alphas = new Float32Array(this.maxSamples * 2);

    const indices: number[] = [];
    for (let i = 0; i < this.maxSamples - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geo.setIndex(indices);

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color('#eef6ff') },
        uFade: { value: 0 },
      },
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position.z = gl_Position.z * 0.08 - 0.88 * gl_Position.w;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uFade;
        varying float vAlpha;
        void main() {
          float a = vAlpha * uFade * 0.42;
          if (a < 0.005) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  public begin(tip: THREE.Vector3, heel: THREE.Vector3, heavy = false) {
    this.active = true;
    this.fade = 1;
    this.mat.uniforms.uColor.value.set(heavy ? '#ffe2a8' : '#e6f0ff');
    for (let i = 0; i < this.maxSamples; i++) {
      this.tipHistory[i].copy(tip);
      this.heelHistory[i].copy(heel);
    }
    this.mesh.visible = true;
  }

  public end() {
    this.active = false;
  }

  public update(dt: number, tip?: THREE.Vector3, heel?: THREE.Vector3) {
    if (this.active && tip && heel) {
      for (let i = this.maxSamples - 1; i > 0; i--) {
        this.tipHistory[i].copy(this.tipHistory[i - 1]);
        this.heelHistory[i].copy(this.heelHistory[i - 1]);
      }
      this.tipHistory[0].copy(tip);
      this.heelHistory[0].copy(heel);
      this.fade = 1;
    } else if (this.fade > 0) {
      this.fade = Math.max(0, this.fade - dt * 5.2);
      if (this.fade <= 0) {
        this.mesh.visible = false;
        return;
      }
    } else {
      return;
    }

    for (let i = 0; i < this.maxSamples; i++) {
      const t = 1 - i / (this.maxSamples - 1);
      const edgeFade = t * t;
      const vi = i * 2;
      this.positions[vi * 3] = this.tipHistory[i].x;
      this.positions[vi * 3 + 1] = this.tipHistory[i].y;
      this.positions[vi * 3 + 2] = this.tipHistory[i].z;
      this.alphas[vi] = edgeFade;

      this.positions[(vi + 1) * 3] = this.heelHistory[i].x;
      this.positions[(vi + 1) * 3 + 1] = this.heelHistory[i].y;
      this.positions[(vi + 1) * 3 + 2] = this.heelHistory[i].z;
      this.alphas[vi + 1] = edgeFade * 0.25;
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.mat.uniforms.uFade.value = this.fade;
  }

  public dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
