import gsap from 'gsap';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AudioEngine } from './audio/AudioEngine';
import { LivelyMushroomSystem, type CoverSpot, type LivelyAgent } from './entities/LivelyMushroomSystem';
import { PlayerController } from './entities/PlayerController';
import { WolfManager } from './entities/WolfManager';
import {
  getEventLoc,
  getKnifeLoc,
  getSpeciesLoc,
  getUpgradeLoc,
  getWeatherLoc,
  t,
} from './i18n';
import { PhysicsWorld } from './physics/PhysicsWorld';
import {
  KNIVES,
  MUSHROOM_SPECS,
  SPECIES_ORDER,
  UPGRADES,
  type AchievementId,
  type BasketItem,
  type DaySummary,
  type ForestEventId,
  type GameMode,
  type GameSettings,
  type HudSnapshot,
  type KnifeId,
  type KnifeSpec,
  type Language,
  type PanelType,
  type SaveData,
  type SellLine,
  type SellResult,
  type SpeciesId,
  type ToastMessage,
  type UpgradeId,
  type WeatherKind,
} from './types';
import { mulberry32 } from './utils/noise';
import { buildKnifeModel } from './viewmodel/KnifeBuilder';
import { ViewModelController } from './viewmodel/ViewModelController';
import { AtmosphereSystem } from './world/AtmosphereSystem';
import { loadAllModels } from './world/modelLoader';
import { createLeafPile, createMushroomModel } from './world/MushroomBuilder';
import { groundHeightAt, HUT_POSE, mossFactorAt, TRAIL, trailDistance, WORLD_SIZE } from './world/terrain';
import { SurfaceDetector, type SurfaceSample } from './world/SurfaceDetector';
import { buildForestWorld, updateDaylight, type WorldData } from './world/WorldBuilder';

/**
 * Original Mushroom Hollow warm autumn color grading + vignette + subtle film grain + fly-agaric dizzy blur.
 */
const AUTUMN_GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uWarm: { value: 1 },
    uVignette: { value: 0.32 },
    uBlur: { value: 0 },
    uDark: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uWarm;
    uniform float uVignette;
    uniform float uBlur;
    uniform float uDark;
    varying vec2 vUv;

    float rand(vec2 c) {
      return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      if (uBlur > 0.0) {
        uv += vec2(sin(uv.y * 18.0 + uTime * 2.0), cos(uv.x * 14.0 + uTime * 1.7)) * 0.006 * uBlur;
      }
      vec4 c = texture2D(tDiffuse, uv);
      if (uBlur > 0.0) {
        vec4 acc = c;
        for (int i = 1; i <= 4; i++) {
          float o = float(i) * 0.004 * uBlur;
          acc += texture2D(tDiffuse, uv + vec2(o, 0.0));
          acc += texture2D(tDiffuse, uv - vec2(0.0, o));
        }
        c = acc / 9.0;
      }
      // Warm autumn grade: cool blue-violet shadows, warm amber mids & highlights
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      vec3 shadowTint = vec3(0.92, 0.95, 1.06);
      vec3 highTint = vec3(1.06, 1.0, 0.9);
      c.rgb *= mix(shadowTint, highTint, smoothstep(0.1, 0.8, l) * uWarm);
      c.rgb = mix(vec3(l), c.rgb, 1.08);
      // Soft vignette
      vec2 d = vUv - 0.5;
      float v = 1.0 - dot(d, d) * uVignette * 2.6;
      c.rgb *= clamp(v, 0.0, 1.0);
      c.rgb *= 1.0 - uDark;
      // Subtle film grain
      c.rgb += (rand(vUv * 731.0 + uTime) - 0.5) * 0.022;
      gl_FragColor = c;
    }
  `,
};

const SAVE_KEY = 'hrybnyk-save-v2';
const SETTINGS_KEY = 'hrybnyk-settings-v2';
const DAY_START = 7 / 24;
const DAY_END = 21 / 24;
const DAY_RATE = (DAY_END - DAY_START) / (18 * 60);

interface MushroomEntity {
  group: THREE.Group;
  species: SpeciesId;
  x: number;
  z: number;
  pile: THREE.Group | null;
  alive: boolean;
  lively?: boolean;
  livelyData?: LivelyAgent;
}

interface CutState {
  m: MushroomEntity;
  phase: 'closeup' | 'falling' | 'leave';
  t: number;
  blend: number;
  base: THREE.Vector3;
  toP: THREE.Vector3;
  side: THREE.Vector3;
  stemR: number;
  ideal: number;
  ideal0: number;
  tol: number;
  kx: number;
  ky: number;
  down: boolean;
  startSide: number;
  maxPush: number;
  quality: number;
  label: string;
  fallAxis: THREE.Vector3;
  fallSign: number;
}

interface FlyingAnim {
  obj: THREE.Object3D;
  kind: 'leaf' | 'sink' | 'mushroom';
  t: number;
  v?: THREE.Vector3;
  spin?: number;
  from?: THREE.Vector3;
  rot0?: THREE.Euler;
  m?: MushroomEntity;
}

function detectSoftwareGl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function createFreshSave(): SaveData {
  return {
    v: 1,
    day: 1,
    money: 0,
    orders: null,
    knives: ['folding'],
    knife: 'folding',
    up: { basket: 0, knife: 0, guide: 0, compass: 0, lamp: 0, boots: 0, dryer: 0, flask: 0 },
    atlas: {},
    driedRack: [],
    achievements: [],
    stats: {
      picked: 0,
      earned: 0,
      perfect: 0,
      runaways: 0,
      dried: 0,
      wolves: 0,
      rainPicked: 0,
      throws: 0,
    },
  };
}

function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    if (parsed && parsed.v === 1) {
      const base = createFreshSave();
      return {
        ...base,
        ...parsed,
        up: { ...base.up, ...(parsed.up || {}) },
        atlas: { ...(parsed.atlas || {}) },
        driedRack: Array.isArray(parsed.driedRack) ? parsed.driedRack : [],
        achievements: Array.isArray(parsed.achievements) ? parsed.achievements : [],
        stats: { ...base.stats, ...(parsed.stats || {}) },
      };
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function persistSave(data: SaveData) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function loadSettings(): GameSettings {
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  const nav = (navigator.language || 'en').toLowerCase();
  const def: GameSettings = {
    lang: nav.startsWith('uk') ? 'uk' : nav.startsWith('ru') ? 'ru' : 'en',
    quality: isTouch ? 'low' : 'medium',
    sens: 1,
    vol: 0.8,
    music: 0.5,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      Object.assign(def, parsed);
      if (def.lang !== 'ru' && def.lang !== 'uk' && def.lang !== 'en') def.lang = 'en';
    }
  } catch {
    // ignore
  }
  return def;
}

export function persistSettings(s: GameSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export interface EngineCallbacks {
  onHud: (hud: HudSnapshot) => void;
  onToast: (msg: ToastMessage) => void;
  onAtlasImages: (imgs: Record<SpeciesId, string>) => void;
}

export class GameEngine {
  private readonly mount: HTMLElement;
  private readonly callbacks: EngineCallbacks;
  private readonly isSoftwareGl: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly knifeEnvMap: THREE.Texture;
  private readonly composer: EffectComposer | null;
  private readonly bloomPass: UnrealBloomPass | null;
  private readonly gradePass: ShaderPass | null;
  private readonly audio = new AudioEngine();

  private world!: WorldData;
  private atmosphere!: AtmosphereSystem;
  private surfaceDetector!: SurfaceDetector;
  private lastStepSurface: SurfaceSample = {
    primary: 'dirt',
    secondary: null,
    secondaryWeight: 0,
    leafPileBoost: 0,
  };
  private physics!: PhysicsWorld;
  private player!: PlayerController;
  private vm!: ViewModelController;
  private wolves!: WolfManager;
  private livelySystem!: LivelyMushroomSystem;
  private coverCandidates: CoverSpot[] = [];
  private headLamp!: THREE.SpotLight;
  private headLampFill!: THREE.PointLight;
  private flashlightOn = false;
  private chasingLively = false;
  private lastStartleToastAt = -10;
  private lastAlertToastAt = -10;
  private lastBurrowToastAt = -10;

  private mushrooms: MushroomEntity[] = [];
  private mushroomGroup = new THREE.Group();
  private flying: FlyingAnim[] = [];
  private cutState: CutState | null = null;
  private cutRig: THREE.Group | null = null;
  private cutGuide: THREE.Mesh | null = null;
  private targetMushroom: MushroomEntity | null = null;
  private targetPickable: { id: number; kind: 'stone' | 'stick'; dist: number } | null = null;

  public save: SaveData;
  public settings: GameSettings;
  public basket: BasketItem[] = [];
  public fangs = 0;

  private throwables: Array<'stone' | 'stick'> = ['stone', 'stone'];
  private flaskCharges = 0;
  private nextDryId = 1;
  private eventId: ForestEventId = 'calm';
  private daySummary: DaySummary | null = null;
  private dayStats = {
    picked: 0,
    perfect: 0,
    runawaysCaught: 0,
    driedCollected: 0,
    wolvesSlain: 0,
    earned: 0,
  };
  private achievementBanner: AchievementId | null = null;
  private achievementTimer: number | null = null;

  private mode: GameMode = 'loading';
  private panel: PanelType = null;
  private loadProgress = 4;
  private loadMessage = 'Загружаем осенний лес…';
  private timeOfDay = DAY_START;
  private warned = 0;
  private hp = 100;
  private combo = 0;
  private hitstopTimer = 0;
  private hurtTick = 0;
  private fadeText: string | null = null;
  private debuffs = { dirty: 0, bitten: 0, dizzy: 0 };
  private stallDist = 99;
  private menuMouseX = 0;
  private menuMouseY = 0;
  private menuSmoothX = 0;
  private menuSmoothY = 0;
  private introTween: gsap.core.Tween | null = null;
  private regrowTimer = 0;
  private rnd: () => number;
  private toastSeq = 1;
  private hudEmitAccum = 0;

  private destroyed = false;
  private frameId = 0;
  private readonly clock = new THREE.Clock();
  private readonly _tmpA = new THREE.Vector3();
  private readonly _tmpB = new THREE.Vector3();
  private readonly _menuCamTmp = new THREE.Vector3();
  private readonly _menuLookTmp = new THREE.Vector3();
  private readonly _lookMat = new THREE.Matrix4();
  private readonly _targetQ = new THREE.Quaternion();
  private readonly _upVec = new THREE.Vector3(0, 1, 0);

  // Event cleanup
  private cleanupListeners: Array<() => void> = [];

  constructor(mount: HTMLElement, callbacks: EngineCallbacks) {
    this.mount = mount;
    this.callbacks = callbacks;
    this.settings = loadSettings();
    this.save = loadSave() || createFreshSave();
    this.loadMessage = t(this.settings.lang, 'loadingWorld');
    this.nextDryId = Math.max(1, ...this.save.driedRack.map((d) => d.id + 1));
    this.rnd = mulberry32(this.save.day * 977 + 13);

    this.isSoftwareGl = detectSoftwareGl();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl && this.settings.quality !== 'low',
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(
      this.isSoftwareGl
        ? 1
        : Math.min(window.devicePixelRatio, this.settings.quality === 'high' ? 2 : this.settings.quality === 'medium' ? 1.5 : 1),
    );
    const initW = mount.clientWidth || window.innerWidth;
    const initH = Math.max(1, mount.clientHeight || window.innerHeight);
    this.renderer.setSize(initW, initH);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, initW / initH, 0.04, 420);
    this.scene.add(this.camera);

    // Build metallic reflection envMap ONLY for forged knife blades/brass (NOT scene.environment!)
    // so the autumn forest retains deep, moody, unwashed shadows and natural directional lighting.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.knifeEnvMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // Original Mushroom Hollow post-processing pipeline on GPU (direct render fallback on software WebGL)
    if (!this.isSoftwareGl) {
      const composer = new EffectComposer(this.renderer);
      composer.setSize(initW, initH);
      composer.addPass(new RenderPass(this.scene, this.camera));

      const bloom = new UnrealBloomPass(new THREE.Vector2(initW / 2, initH / 2), 0.28, 0.6, 0.86);
      bloom.enabled = this.settings.quality !== 'low';
      composer.addPass(bloom);

      composer.addPass(new OutputPass());

      const grade = new ShaderPass(AUTUMN_GRADE_SHADER);
      composer.addPass(grade);

      this.composer = composer;
      this.bloomPass = bloom;
      this.gradePass = grade;
    } else {
      this.composer = null;
      this.bloomPass = null;
      this.gradePass = null;
    }

    this.scene.add(this.mushroomGroup);
    this.emitHud();

    void this.initAsync();
  }

  private async initAsync() {
    try {
      const models = await loadAllModels((pct) => {
        this.loadProgress = pct;
        this.emitHud();
      });
      if (this.destroyed) return;

      this.loadMessage = t(this.lang, 'loadingCamp');
      this.loadProgress = 90;
      this.emitHud();

      await new Promise((r) => setTimeout(r, 20));
      if (this.destroyed) return;

      this.world = buildForestWorld(this.scene, models, this.settings.quality, this.isSoftwareGl);
      this.world.updateSignLanguage(this.lang);
      this.world.syncDryingRackVisuals(this.save.driedRack);

      this.atmosphere = new AtmosphereSystem(
        this.scene,
        this.world.campfirePos,
        this.settings.quality,
        this.isSoftwareGl,
      );

      this.physics = new PhysicsWorld(this.scene, this.world.colliders);
      for (const woodObj of this.world.staticWoodObjects) {
        this.physics.registerStaticWood(woodObj);
      }
      this.coverCandidates = [];
      for (const b of this.world.bushes) {
        this.physics.registerBush(b.x, b.y, b.z, b.r);
        this.coverCandidates.push({ x: b.x, z: b.z });
      }
      for (const tr of this.world.trees) {
        this.coverCandidates.push({ x: tr.x, z: tr.z });
      }
      this.physics.populateInteractiveProps(
        models,
        this.world.start,
        this.world.startDir,
        new THREE.Vector3(HUT_POSE.x, HUT_POSE.y, HUT_POSE.z),
      );

      this.audio.vol = this.settings.vol;
      this.audio.musicVol = this.settings.music;

      this.surfaceDetector = new SurfaceDetector(
        this.world.stoneZones,
        this.world.stallPos,
        (x, z) => {
          let best = 0;
          for (const m of this.mushrooms) {
            if (!m.alive || !m.pile) continue;
            const d2 = (m.x - x) * (m.x - x) + (m.z - z) * (m.z - z);
            if (d2 < 1.15 * 1.15) {
              const boost = 1 - Math.sqrt(d2) / 1.15;
              if (boost > best) best = boost;
            }
          }
          return best;
        },
      );

      this.player = new PlayerController(this.camera, this.renderer.domElement, this.world.colliders);
      this.player.sens = 0.0022 * this.settings.sens;
      this.player.bootsLevel = this.save.up.boots;
      this.flaskCharges = this.flaskMax;
      this.player.onStepPhase = (phase, ev) => {
        if (this.mode !== 'play' || this.panel || this.cutState) return;
        if (phase === 'heel') {
          this.lastStepSurface = this.surfaceDetector.sample(this.player.pos.x, this.player.pos.z);
          this.audio.playFootstepHeel(this.lastStepSurface, ev);
          if (this.livelySystem) {
            const now = this.clock.elapsedTime;
            const noiseMult = this.player.getNoiseMultiplier() * this.atmosphere.getStealthMultiplier();
            this.livelySystem.onFootstepNoise(
              this.player.pos.x,
              this.player.pos.z,
              ev.speed,
              ev.sprintBlend,
              ev.crouch,
              this.lastStepSurface.primary,
              this.mushrooms,
              this.player.pos,
              {
                onAlert: () => {
                  if (now - this.lastAlertToastAt > 4.5) {
                    this.lastAlertToastAt = now;
                    this.toast(t(this.lang, 'toastAlert'), 'warn');
                  }
                },
                onStartled: () => {
                  if (now - this.lastStartleToastAt > 3.5) {
                    this.lastStartleToastAt = now;
                    this.toast(t(this.lang, 'toastStartledNoise'), 'warn');
                  }
                },
              },
              noiseMult,
            );
          }
        } else if (phase === 'toe') {
          this.audio.playFootstepToe(this.lastStepSurface, ev);
        } else if (phase === 'debris') {
          this.audio.playFootstepDebris(this.lastStepSurface, ev);
        } else if (phase === 'breath') {
          this.audio.playFootstepBreath(0.85 + ev.sprintBlend * 0.25, ev.foot);
        }
      };

      this.vm = new ViewModelController(this.camera, this.scene, this.currentKnife, this.knifeEnvMap);
      this.player.onLook = (dx, dy) => this.vm.onLookDelta(dx, dy);
      this.player.onBasketDip = (intensity, foot) => this.vm.onFootstepDip(intensity, foot);

      this.wolves = new WolfManager(this.scene, models.Wolf, this.world.colliders, this.audio);
      this.livelySystem = new LivelyMushroomSystem(this.scene, this.world.colliders, this.audio);

      this.headLamp = new THREE.SpotLight('#ffe4b5', 0, 26, 0.48, 0.56, 1.35);
      this.headLamp.position.set(0.14, -0.08, -0.05);
      this.camera.add(this.headLamp);
      this.headLamp.target.position.set(0, -0.35, -6);
      this.camera.add(this.headLamp.target);

      this.headLampFill = new THREE.PointLight('#ffdca4', 0, 6, 1.6);
      this.headLampFill.position.set(0.1, -0.05, -0.2);
      this.camera.add(this.headLampFill);

      this.applyDayConditions(this.save.day);
      if (!this.save.orders || this.save.orders.day !== this.save.day) {
        this.makeOrders();
      } else if (!this.save.orders.list.some((o) => o.livelyOnly)) {
        this.save.orders.list.push({
          species: 'porcini',
          n: 2,
          reward: 115,
          done: false,
          livelyOnly: true,
        });
      }
      this.spawnAllMushrooms();
      this.resetPlayerToTrailStart();

      // Render mushroom 3D preview cards for the field atlas
      this.renderAtlasThumbnails();

      if (!this.isSoftwareGl) {
        this.renderer.compile(this.scene, this.camera);
      }

      this.bindEvents();

      this.loadProgress = 100;
      this.mode = 'menu';
      this.emitHud();

      this.clock.start();
      this.scheduleNextFrame();
    } catch (err) {
      console.error(err);
      this.loadMessage = t(this.lang, 'loadingFail') + (err instanceof Error ? err.message : String(err));
      this.emitHud();
    }
  }

  public get lang(): Language {
    return this.settings.lang;
  }

  public get currentKnife(): KnifeSpec {
    if (!this.save.knives) {
      this.save.knives = ['folding'];
      this.save.knife = 'folding';
    }
    return KNIVES.find((k) => k.id === this.save.knife) || KNIVES[0];
  }

  public get basketCap(): number {
    return UPGRADES.find((u) => u.id === 'basket')?.levels[this.save.up.basket]?.cap ?? 12;
  }

  public get dryerCap(): number {
    return UPGRADES.find((u) => u.id === 'dryer')?.levels[this.save.up.dryer]?.cap ?? 4;
  }

  public get flaskMax(): number {
    return UPGRADES.find((u) => u.id === 'flask')?.levels[this.save.up.flask]?.charges ?? 0;
  }

  public get dryerReadyCount(): number {
    return this.save.driedRack.filter((d) => d.progress >= 1).length;
  }

  public get dryerMultiplier(): number {
    return this.save.up.dryer >= 2 ? 1.75 : 1.6;
  }

  public get fangValue(): number {
    return this.eventId === 'wolf_hunt' ? 55 : 35;
  }

  private get dryDurationSec(): number {
    return this.save.up.dryer >= 2 ? 48 : this.save.up.dryer === 1 ? 62 : 75;
  }

  public basketUsed(): number {
    return this.basket.reduce((acc, it) => acc + it.slots, 0);
  }

  private rollDayConditions(day: number): { weather: WeatherKind; eventId: ForestEventId } {
    const r = mulberry32(day * 4391 + 71);
    if (day === 1) {
      return { weather: 'clear', eventId: 'calm' };
    }
    const evRoll = r();
    let eventId: ForestEventId = 'calm';
    if (evRoll < 0.24) eventId = 'mushroom_rain';
    else if (evRoll < 0.48) eventId = 'porcini_boom';
    else if (evRoll < 0.7) eventId = 'fairy_glow';
    else if (evRoll < 0.88) eventId = 'wolf_hunt';

    const wRoll = r();
    let weather: WeatherKind = wRoll < 0.5 ? 'clear' : wRoll < 0.78 ? 'mist' : 'rain';
    if (eventId === 'mushroom_rain') weather = 'rain';
    if (eventId === 'fairy_glow' && wRoll < 0.65) weather = 'mist';
    return { weather, eventId };
  }

  private applyDayConditions(day: number) {
    const { weather, eventId } = this.rollDayConditions(day);
    this.eventId = eventId;
    this.atmosphere?.setWeatherImmediate(weather);
  }

  private unlockAchievement(id: AchievementId) {
    if (this.save.achievements.includes(id)) return;
    this.save.achievements.push(id);
    persistSave(this.save);
    this.achievementBanner = id;
    this.audio.achievementUnlock();
    if (this.achievementTimer) clearTimeout(this.achievementTimer);
    this.achievementTimer = window.setTimeout(() => {
      this.achievementBanner = null;
      this.emitHud();
    }, 4200);
    this.emitHud();
  }

  private checkMasterAtlasAchievement() {
    if (SPECIES_ORDER.every((sp) => (this.save.atlas[sp] || 0) > 0)) {
      this.unlockAchievement('master_collector');
    }
  }

  private renderAtlasThumbnails() {
    try {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      r.setSize(220, 140);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.outputColorSpace = THREE.SRGBColorSpace;
      const sc = new THREE.Scene();
      sc.add(new THREE.HemisphereLight('#fff6e6', '#806040', 1.5));
      const dl = new THREE.DirectionalLight('#ffffff', 2.2);
      dl.position.set(1, 2, 1.5);
      sc.add(dl);
      const cam = new THREE.PerspectiveCamera(30, 220 / 140, 0.01, 10);
      const urls = {} as Record<SpeciesId, string>;

      for (const sp of SPECIES_ORDER) {
        const m = createMushroomModel(sp, 12345);
        sc.add(m);
        const bb = new THREE.Box3().setFromObject(m);
        const c = bb.getCenter(new THREE.Vector3());
        const sz = bb.getSize(new THREE.Vector3());
        const d = Math.max(sz.x, sz.y * 1.4, sz.z) * 1.85;
        cam.position.set(c.x + d * 0.55, c.y + d * 0.35, c.z + d * 0.8);
        cam.lookAt(c);
        r.render(sc, cam);
        urls[sp] = r.domElement.toDataURL();
        sc.remove(m);
      }
      r.dispose();
      this.callbacks.onAtlasImages(urls);
    } catch {
      // thumbnail generation is optional
    }
  }

  private resetPlayerToTrailStart() {
    const p = TRAIL.samples[1];
    const pAhead = TRAIL.samples[10];
    const yaw = Math.atan2(-(pAhead.x - p.x), -(pAhead.z - p.z));
    this.player.setPose(p.x, p.z, yaw, -0.06);
  }

  private bindEvents() {
    const dom = this.renderer.domElement;

    const onResize = () => {
      const w = this.mount.clientWidth || window.innerWidth;
      const h = Math.max(1, this.mount.clientHeight || window.innerHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      if (this.composer) {
        this.composer.setSize(w, h);
      }
      if (this.bloomPass) {
        this.bloomPass.resolution.set(w / 2, h / 2);
      }
    };
    window.addEventListener('resize', onResize);

    const onPointerLock = () => {
      const locked = document.pointerLockElement === dom;
      if (this.mode === 'play') {
        this.player.enabled = locked && !this.cutState;
        if (!locked && !this.panel && !window.matchMedia('(pointer: coarse)').matches) {
          this.setMode('pause');
        }
      }
    };
    document.addEventListener('pointerlockchange', onPointerLock);

    const onContextLost = (e: Event) => {
      e.preventDefault();
      this.toast(t(this.lang, 'toastContextLost'), 'warn');
    };
    const onContextRestored = () => {
      if (!this.isSoftwareGl) this.renderer.compile(this.scene, this.camera);
    };
    dom.addEventListener('webglcontextlost', onContextLost);
    dom.addEventListener('webglcontextrestored', onContextRestored);

    const onMouseMove = (e: MouseEvent) => {
      if (this.mode === 'menu') {
        this.menuMouseX = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
        this.menuMouseY = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
        return;
      }
      if (this.cutState && document.pointerLockElement === dom) {
        this.moveCloseupKnife(e.movementX, e.movementY);
      }
    };
    document.addEventListener('mousemove', onMouseMove);

    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    dom.addEventListener('contextmenu', onContextMenu);

    const onMouseDown = (e: MouseEvent) => {
      if (this.mode !== 'play' || this.player.externalCameraControl) return;
      if (document.pointerLockElement !== dom) {
        this.requestLock();
        return;
      }
      if (e.button === 2) {
        if (this.cutState) {
          this.cancelCut();
        } else {
          this.vm.beginCharge();
        }
        return;
      }
      if (e.button === 0) {
        if (this.cutState) {
          this.pressInteract();
        } else if (this.targetMushroom) {
          this.pressInteract();
        } else {
          // Free-roam LMB performs snappy combo knife slash!
          this.fireSwing(false);
        }
      }
    };
    dom.addEventListener('mousedown', onMouseDown);

    const onMouseUp = (e: MouseEvent) => {
      if (this.mode !== 'play') return;
      if (e.button === 0) this.releaseInteract();
      if (e.button === 2 && !this.cutState) {
        this.fireSwing(false);
      }
    };
    window.addEventListener('mouseup', onMouseUp);

    const onKeyDown = (e: KeyboardEvent) => {
      if (this.mode === 'menu' && !this.panel && (e.code === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        if (loadSave()) this.continueGame();
        else this.startNewGame();
        return;
      }
      if (this.mode !== 'play') {
        if (e.code === 'Escape' && this.panel && this.panel !== 'dayReport') {
          this.closePanel();
        } else if (e.code === 'Escape' && this.mode === 'pause') {
          this.resumeGame();
        }
        return;
      }

      if (this.panel) {
        if (e.code === 'Escape' && this.panel !== 'dayReport') {
          this.closePanel();
        }
        return;
      }

      if (this.player.externalCameraControl) return;

      if (e.code === 'KeyE') {
        const nearby = this.getNearbyStation();
        if (nearby === 'sell') this.openPanel('shop');
        else if (nearby === 'workshop') this.openPanel('workshop');
        else if (nearby === 'dryer') this.openPanel('dryer');
        else if (nearby === 'campfire') this.restAtCampfire();
        else if (nearby === 'bed') this.trySleepFromBed();
        else if (!e.repeat) this.pressInteract();
      } else if (e.code === 'KeyG' && !e.repeat && !this.cutState) {
        this.tryPickupThrowable();
      } else if (e.code === 'KeyQ' && !e.repeat && !this.cutState) {
        this.throwDistraction();
      } else if (e.code === 'KeyH' && !e.repeat && !this.cutState) {
        this.drinkTea();
      } else if (e.code === 'KeyL' && !e.repeat) {
        this.toggleFlashlight();
      } else if (e.code === 'KeyM') {
        this.openPanel('map');
      } else if (e.code === 'Tab') {
        e.preventDefault();
        this.openPanel('atlas');
      } else if (e.code === 'KeyR' && !this.cutState) {
        this.wipeKnife();
      } else if (e.code === 'KeyF' && !e.repeat && !this.cutState) {
        this.vm.beginCharge();
      } else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3' || e.code === 'Digit4') {
        const idx = Number(e.code.replace('Digit', '')) - 1;
        const spec = KNIVES[idx];
        if (spec && this.save.knives.includes(spec.id) && this.save.knife !== spec.id) {
          this.equipOrBuyKnife(spec.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);

    const onKeyUp = (e: KeyboardEvent) => {
      if (this.mode !== 'play') return;
      if (e.code === 'KeyE') this.releaseInteract();
      if (e.code === 'KeyF' && !this.cutState) {
        this.fireSwing(false);
      }
    };
    window.addEventListener('keyup', onKeyUp);

    this.cleanupListeners.push(
      () => window.removeEventListener('resize', onResize),
      () => document.removeEventListener('pointerlockchange', onPointerLock),
      () => dom.removeEventListener('webglcontextlost', onContextLost),
      () => dom.removeEventListener('webglcontextrestored', onContextRestored),
      () => document.removeEventListener('mousemove', onMouseMove),
      () => dom.removeEventListener('contextmenu', onContextMenu),
      () => dom.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
    );
  }

  private fireSwing(forceHeavy: boolean) {
    if (this.cutState || this.mode !== 'play') return;
    const res = this.vm.releaseSwing(forceHeavy);
    if (res.started) {
      this.audio.whoosh(res.heavy);
      // Small stamina cost for heavy charged swings
      if (res.heavy) {
        this.player.stamina = Math.max(0, this.player.stamina - 8);
      }
    }
  }

  public requestLock() {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    try {
      const p = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      // ignore
    }
  }

  public setMode(m: GameMode) {
    this.mode = m;
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (this.player) {
      this.player.enabled = m === 'play' && !this.cutState && (isTouch || document.pointerLockElement === this.renderer.domElement);
    }
    this.vm?.setPaused(m !== 'play' || this.panel !== null);
    if (m !== 'play' && document.pointerLockElement) {
      document.exitPointerLock();
    }
    this.emitHud();
  }

  private flyIntoGameplay() {
    this.introTween?.kill();
    const startPos = this.camera.position.clone();
    const startLook = this._menuLookTmp.clone();
    const endPos = new THREE.Vector3(this.player.pos.x, this.player.pos.y + this.player.eye, this.player.pos.z);
    const fx = -Math.sin(this.player.yaw) * Math.cos(this.player.pitch);
    const fy = Math.sin(this.player.pitch);
    const fz = -Math.cos(this.player.yaw) * Math.cos(this.player.pitch);
    const endLook = endPos.clone().add(new THREE.Vector3(fx * 6, fy * 6, fz * 6));

    this.player.externalCameraControl = true;
    this.player.enabled = false;
    this.vm.root.visible = false;

    const proxy = { t: 0 };
    this.introTween = gsap.to(proxy, {
      t: 1,
      duration: 1.05,
      ease: 'power3.inOut',
      onUpdate: () => {
        if (this.destroyed || this.mode !== 'play') return;
        this.camera.position.lerpVectors(startPos, endPos, proxy.t);
        this._tmpA.lerpVectors(startLook, endLook, proxy.t);
        this.camera.lookAt(this._tmpA);
      },
      onComplete: () => {
        this.introTween = null;
        if (this.destroyed) return;
        this.player.externalCameraControl = false;
        this.vm.root.visible = !this.cutState;
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        this.player.enabled =
          this.mode === 'play' &&
          !this.panel &&
          !this.cutState &&
          (isTouch || document.pointerLockElement === this.renderer.domElement);
      },
    });
  }

  public continueGame() {
    this.audio.start();
    this.audio.ui();
    this.audio.setVolume(this.settings.vol);
    this.audio.setMusic(this.settings.music);
    this.panel = null;
    this.player.bootsLevel = this.save.up.boots;
    this.world.syncDryingRackVisuals(this.save.driedRack);
    const fromMenu = this.mode === 'menu';
    this.setMode('play');
    if (fromMenu) this.flyIntoGameplay();
    this.requestLock();
  }

  public startNewGame() {
    this.audio.start();
    this.audio.ui();
    this.audio.setVolume(this.settings.vol);
    this.audio.setMusic(this.settings.music);
    this.save = createFreshSave();
    persistSave(this.save);
    this.basket = [];
    this.fangs = 0;
    this.hp = 100;
    this.combo = 0;
    this.flashlightOn = false;
    this.throwables = ['stone', 'stone'];
    this.flaskCharges = this.flaskMax;
    this.player.bootsLevel = 0;
    this.daySummary = null;
    this.dayStats = { picked: 0, perfect: 0, runawaysCaught: 0, driedCollected: 0, wolvesSlain: 0, earned: 0 };
    this.debuffs = { dirty: 0, bitten: 0, dizzy: 0 };
    this.vm.clearBasket();
    this.vm.setKnife(this.currentKnife, false);
    this.vm.setStain(0, 0);
    this.world.syncDryingRackVisuals([]);
    this.rnd = mulberry32(this.save.day * 977 + 13);
    this.applyDayConditions(this.save.day);
    this.makeOrders();
    this.spawnAllMushrooms();
    this.timeOfDay = DAY_START;
    this.warned = 0;
    this.resetPlayerToTrailStart();
    this.panel = null;
    const fromMenu = this.mode === 'menu';
    this.setMode('play');
    if (fromMenu) this.flyIntoGameplay();
    this.requestLock();
    const evLoc = getEventLoc(this.lang, this.eventId);
    const wLoc = getWeatherLoc(this.lang, this.atmosphere.weather);
    this.toast(`${t(this.lang, 'day')} 1 · ${wLoc.name} · ${evLoc.name}`, 'good');
  }

  public resumeGame() {
    this.panel = null;
    this.audio.start();
    this.setMode('play');
    this.requestLock();
  }

  public returnToMenu() {
    this.introTween?.kill();
    this.introTween = null;
    if (this.player) this.player.externalCameraControl = false;
    persistSave(this.save);
    this.panel = null;
    this.cancelCut();
    this.setMode('menu');
  }

  public openPanel(p: PanelType) {
    this.audio.ui();
    this.panel = p;
    if (this.player) this.player.enabled = false;
    this.vm?.setPaused(true);
    if (document.pointerLockElement) document.exitPointerLock();
    this.emitHud();
  }

  public closePanel() {
    if (this.panel === 'dayReport') return;
    this.audio.ui();
    const wasPause = this.mode === 'pause';
    this.panel = null;
    if (!wasPause && this.mode === 'play') {
      this.requestLock();
      this.player.enabled = true;
      this.vm?.setPaused(false);
    }
    this.emitHud();
  }

  public toggleMute(): boolean {
    const m = this.audio.toggleMute();
    this.emitHud();
    return m;
  }

  public setLanguage(lang: Language) {
    if (this.settings.lang === lang) return;
    this.settings = { ...this.settings, lang };
    persistSettings(this.settings);
    this.world?.updateSignLanguage(lang);
    this.audio.ui();
    this.emitHud();
  }

  public updateSettings(next: GameSettings) {
    const qualityChanged = next.quality !== this.settings.quality;
    const langChanged = next.lang !== this.settings.lang;
    this.settings = { ...next };
    persistSettings(this.settings);
    if (langChanged) {
      this.world?.updateSignLanguage(next.lang);
    }
    if (this.player) this.player.sens = 0.0022 * this.settings.sens;
    this.audio.setVolume(this.settings.vol);
    this.audio.setMusic(this.settings.music);
    if (qualityChanged && !this.isSoftwareGl) {
      const dpr = Math.min(
        window.devicePixelRatio,
        next.quality === 'high' ? 2 : next.quality === 'medium' ? 1.5 : 1,
      );
      this.renderer.setPixelRatio(dpr);
      const w = this.mount.clientWidth || window.innerWidth;
      const h = Math.max(1, this.mount.clientHeight || window.innerHeight);
      this.renderer.setSize(w, h);
      if (this.composer) {
        this.composer.setPixelRatio(dpr);
        this.composer.setSize(w, h);
      }
      if (this.bloomPass) {
        this.bloomPass.enabled = next.quality !== 'low';
      }
      if (this.world?.sun) {
        const res = { low: 1024, medium: 2048, high: 4096 }[next.quality];
        this.world.sun.shadow.mapSize.set(res, res);
        this.world.sun.shadow.map?.dispose();
        this.world.sun.shadow.map = null;
      }
    }
    this.emitHud();
  }

  public equipOrBuyKnife(id: KnifeId): boolean {
    const spec = KNIVES.find((k) => k.id === id);
    if (!spec) return false;
    if (!this.save.knives.includes(id)) {
      if (this.save.money < spec.cost) return false;
      this.save.money -= spec.cost;
      this.save.knives.push(id);
      this.audio.coins(5);
    }
    this.save.knife = id;
    persistSave(this.save);
    this.vm.setKnife(spec);
    if (this.cutRig) {
      this.scene.remove(this.cutRig);
      this.cutRig = null;
    }
    this.toast(`${t(this.lang, 'toastEquipped')}: ${getKnifeLoc(this.lang, id).name}`, 'good');
    this.emitHud();
    return true;
  }

  public buyUpgrade(id: UpgradeId): boolean {
    const up = UPGRADES.find((u) => u.id === id);
    if (!up) return false;
    const lvl = this.save.up[id];
    const next = up.levels[lvl + 1];
    if (!next || this.save.money < next.cost) return false;
    this.save.money -= next.cost;
    this.save.up[id] = lvl + 1;
    if (id === 'boots' && this.player) {
      this.player.bootsLevel = this.save.up.boots;
    }
    if (id === 'flask') {
      this.flaskCharges = this.flaskMax;
    }
    persistSave(this.save);
    this.audio.coins(4);
    this.toast(`${t(this.lang, 'toastBought')}: ${getUpgradeLoc(this.lang, id).name}`, 'good');
    this.emitHud();
    return true;
  }

  // --- Campfire, Herbal Tea & Mushroom Drying Rack ---
  private restAtCampfire() {
    this.hp = 100;
    if (this.player) {
      this.player.stamina = 100;
      this.player.exhausted = false;
    }
    this.debuffs.dizzy = 0;
    this.debuffs.bitten = 0;
    this.flaskCharges = this.flaskMax;
    this.audio.campRest();
    this.physics.emitBurst(
      this.world.campfirePos.clone().add(new THREE.Vector3(0, 0.55, 0)),
      26,
      '#ffaa38',
      1.2,
      2.2,
      -1.2,
    );
    this.toast(t(this.lang, 'toastCampRest'), 'good');
    this.emitHud();
  }

  public drinkTea() {
    if (this.flaskMax <= 0) {
      this.toast(t(this.lang, 'toastTeaLocked'), 'warn');
      return;
    }
    if (this.flaskCharges <= 0) {
      this.toast(t(this.lang, 'toastTeaEmpty'), 'warn');
      return;
    }
    this.flaskCharges--;
    this.hp = Math.min(100, this.hp + 40);
    if (this.player) {
      this.player.stamina = Math.min(100, this.player.stamina + 65);
      this.player.exhausted = false;
    }
    this.debuffs.dizzy = 0;
    this.audio.sipTea();
    this.toast(t(this.lang, 'toastTeaSip'), 'good');
    this.emitHud();
  }

  private rebuildBasketMeshes() {
    this.vm.clearBasket();
    for (const b of this.basket) {
      this.vm.addToBasket(createMushroomModel(b.species, Math.floor(Math.random() * 1e6)));
    }
  }

  public hangMushroomOnDryer(basketIndex: number): boolean {
    if (this.save.driedRack.length >= this.dryerCap) {
      this.toast(t(this.lang, 'toastDryerFull'), 'warn');
      return false;
    }
    const item = this.basket[basketIndex];
    if (!item || item.dried || MUSHROOM_SPECS[item.species].poison > 0) return false;
    this.basket.splice(basketIndex, 1);
    this.save.driedRack.push({
      id: this.nextDryId++,
      species: item.species,
      quality: item.quality,
      count: item.count,
      lively: item.lively,
      progress: 0,
    });
    this.rebuildBasketMeshes();
    this.world.syncDryingRackVisuals(this.save.driedRack);
    persistSave(this.save);
    this.audio.hangMushroom();
    this.emitHud();
    return true;
  }

  public hangAllEdibleOnDryer(): number {
    let hung = 0;
    for (let i = this.basket.length - 1; i >= 0; i--) {
      if (this.save.driedRack.length >= this.dryerCap) break;
      const item = this.basket[i];
      if (item.dried || MUSHROOM_SPECS[item.species].poison > 0) continue;
      this.basket.splice(i, 1);
      this.save.driedRack.push({
        id: this.nextDryId++,
        species: item.species,
        quality: item.quality,
        count: item.count,
        lively: item.lively,
        progress: 0,
      });
      hung++;
    }
    if (hung > 0) {
      this.rebuildBasketMeshes();
      this.world.syncDryingRackVisuals(this.save.driedRack);
      persistSave(this.save);
      this.audio.hangMushroom();
      this.toast(t(this.lang, 'toastDryerHung'), 'good');
      this.emitHud();
    } else if (this.save.driedRack.length >= this.dryerCap) {
      this.toast(t(this.lang, 'toastDryerFull'), 'warn');
    }
    return hung;
  }

  public collectReadyDried(): number {
    let collected = 0;
    const remaining: SaveData['driedRack'] = [];
    for (const slot of this.save.driedRack) {
      if (slot.progress < 1) {
        remaining.push(slot);
        continue;
      }
      const slotsCost = slot.species === 'porcini' || slot.species === 'golden' ? 2 : 1;
      if (this.basketUsed() + slotsCost > this.basketCap) {
        remaining.push(slot);
        continue;
      }
      this.basket.push({
        species: slot.species,
        quality: slot.quality,
        slots: slotsCost,
        count: slot.count,
        lively: slot.lively,
        dried: true,
      });
      collected++;
      this.save.stats.dried++;
      this.dayStats.driedCollected++;
    }
    this.save.driedRack = remaining;
    if (collected > 0) {
      this.rebuildBasketMeshes();
      this.world.syncDryingRackVisuals(this.save.driedRack);
      persistSave(this.save);
      this.audio.plop();
      this.toast(t(this.lang, 'toastDryerCollected'), 'good');
      if (this.save.stats.dried >= 5) {
        this.unlockAchievement('gourmet_dryer');
      }
      this.emitHud();
    } else if (this.dryerReadyCount > 0) {
      this.toast(t(this.lang, 'toastBasketFull'), 'warn');
    }
    return collected;
  }

  // --- Pick & Throw Physics Distractions (G / Q) ---
  private tryPickupThrowable() {
    if (!this.targetPickable) return;
    if (this.throwables.length >= 3) {
      this.toast(t(this.lang, 'toastPocketFull'), 'warn');
      return;
    }
    const kind = this.physics.pickupBody(this.targetPickable.id);
    if (!kind) return;
    this.throwables.push(kind);
    this.targetPickable = null;
    this.audio.pickupItem();
    this.toast(t(this.lang, 'toastPickup'), 'good');
    this.emitHud();
  }

  public throwDistraction() {
    if (this.mode !== 'play' || this.panel || this.cutState) return;
    const kind = this.throwables.pop();
    if (!kind) {
      this.toast(t(this.lang, 'toastNoThrowable'), 'warn');
      return;
    }
    this.camera.updateMatrixWorld();
    const origin = this.camera.position.clone();
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.audio.throwItem();
    this.save.stats.throws++;

    this.physics.throwProjectile(kind, origin, dir, 15.5, (impactPos, k) => {
      const dist = impactPos.distanceTo(this.player.pos);
      this.audio.projectileImpact(k, dist);
      this.physics.emitBurst(
        impactPos.clone().add(new THREE.Vector3(0, 0.08, 0)),
        14,
        k === 'stone' ? '#8c8376' : '#7a5230',
        1.1,
        1.5,
        6.0,
      );
      const wolfHit = this.wolves.distract(impactPos.x, impactPos.z, 28);
      if (wolfHit) {
        this.toast(t(this.lang, 'toastWolfDistracted'), 'good');
      }
      const flushed = this.livelySystem.onProjectileNoise(impactPos.x, impactPos.z, this.mushrooms, {
        onFlushPile: (m) => {
          this.clearLeafPile(m as MushroomEntity);
        },
        onStartled: () => {
          this.toast(t(this.lang, 'toastFlushPile'), 'warn');
        },
      });
      if (wolfHit || flushed) {
        this.unlockAchievement('stone_trickster');
      }
    });
    this.emitHud();
  }

  public sellBasket(): SellResult {
    let total = 0;
    let rejected = 0;
    const lines: SellLine[] = [];
    const grouped: Partial<Record<SpeciesId, { n: number; sum: number }>> = {};

    let livelySold = 0;
    let livelySum = 0;
    let driedSold = 0;
    let driedSum = 0;

    for (const item of this.basket) {
      const spec = MUSHROOM_SPECS[item.species];
      this.save.atlas[item.species] = (this.save.atlas[item.species] || 0) + item.count;
      if (spec.poison) {
        rejected += item.count;
        const g = (grouped[item.species] = grouped[item.species] || { n: 0, sum: 0 });
        g.n += item.count;
        continue;
      }
      const baseVal =
        spec.price *
        item.quality *
        item.count *
        (item.species === 'chanterelle' || item.species === 'honey' ? 0.6 : 1);
      const val = Math.round(
        baseVal * (item.lively ? 2.5 : 1) * (item.dried ? this.dryerMultiplier : 1),
      );
      total += val;
      if (item.lively) {
        livelySold++;
        livelySum += val;
      } else if (item.dried) {
        driedSold += item.count;
        driedSum += val;
      } else {
        const g = (grouped[item.species] = grouped[item.species] || { n: 0, sum: 0 });
        g.n += item.count;
        g.sum += val;
      }
    }

    if (livelySold > 0) {
      lines.push({
        species: 'lively',
        name: `✨ ${t(this.lang, 'livelyOrder')} (×2.5)`,
        n: livelySold,
        sum: livelySum,
      });
    }

    if (driedSold > 0) {
      lines.push({
        species: 'dried',
        name: `${t(this.lang, 'dryerTitle')} (×${this.dryerMultiplier.toFixed(1)})`,
        n: driedSold,
        sum: driedSum,
      });
    }

    if (this.fangs > 0) {
      const sum = this.fangs * this.fangValue;
      total += sum;
      lines.push({ species: 'fang', name: t(this.lang, 'wolfFangs'), n: this.fangs, sum });
      this.fangs = 0;
    }

    for (const ord of this.save.orders?.list || []) {
      if (ord.done) continue;
      const count = ord.livelyOnly
        ? this.basket.filter((b) => b.lively).length
        : this.basket.filter((b) => b.species === ord.species).reduce((a, b) => a + b.count, 0);
      if (count >= ord.n) {
        ord.done = true;
        total += ord.reward;
        lines.push({
          species: 'order',
          name: ord.livelyOnly
            ? `✨ ${t(this.lang, 'livelyOrder')} ×${ord.n}`
            : `${getSpeciesLoc(this.lang, ord.species).name} ×${ord.n}`,
          n: '',
          sum: ord.reward,
        });
      }
    }

    for (const sp of SPECIES_ORDER) {
      const g = grouped[sp];
      if (g) {
        lines.push({
          species: sp,
          name: getSpeciesLoc(this.lang, sp).name,
          n: g.n,
          sum: g.sum,
          poison: MUSHROOM_SPECS[sp].poison,
        });
      }
    }

    this.save.money += total;
    this.save.stats.earned += total;
    this.dayStats.earned += total;
    this.basket = [];
    this.vm.clearBasket();
    this.checkMasterAtlasAchievement();
    persistSave(this.save);
    if (total > 0) this.audio.coins(Math.min(12, 3 + Math.floor(total / 20)));
    this.emitHud();
    return { total, rejected, lines };
  }

  public sleepToMorning() {
    this.panel = null;
    this.audio.sleep();
    void this.endDay(true);
  }

  private trySleepFromBed() {
    this.sleepToMorning();
  }

  private async endDay(safe: boolean, customMsg?: string) {
    if (this.mode === 'sleep') return;
    this.mode = 'sleep';
    this.panel = null;
    this.cancelCut();
    this.player.enabled = false;
    if (document.pointerLockElement) document.exitPointerLock();

    let note: string | null = null;
    if (!safe) {
      const lost = Math.ceil(this.basket.length / 2);
      this.basket.splice(0, lost);
      this.rebuildBasketMeshes();
      note = customMsg || t(this.lang, 'toastDayFailed');
      this.fadeText = note;
      this.emitHud();
      await new Promise((r) => setTimeout(r, 1450));
      if (this.destroyed) return;
      this.fadeText = null;
    }

    // Complete overnight mushroom drying on the rack
    for (const slot of this.save.driedRack) {
      slot.progress = 1;
    }
    this.world.syncDryingRackVisuals(this.save.driedRack);

    const score =
      this.dayStats.earned +
      this.dayStats.picked * 14 +
      this.dayStats.perfect * 22 +
      this.dayStats.runawaysCaught * 80 +
      this.dayStats.driedCollected * 30 +
      this.dayStats.wolvesSlain * 45 +
      (safe ? 30 : 0);
    const rank: DaySummary['rank'] = score >= 520 ? 'S' : score >= 300 ? 'A' : score >= 140 ? 'B' : 'C';
    const nextCond = this.rollDayConditions(this.save.day + 1);

    this.daySummary = {
      day: this.save.day,
      rank,
      score,
      picked: this.dayStats.picked,
      perfect: this.dayStats.perfect,
      runawaysCaught: this.dayStats.runawaysCaught,
      driedCollected: this.dayStats.driedCollected,
      wolvesSlain: this.dayStats.wolvesSlain,
      earned: this.dayStats.earned,
      nextWeather: nextCond.weather,
      nextEvent: nextCond.eventId,
      note,
      survived: safe,
    };

    persistSave(this.save);
    this.panel = 'dayReport';
    this.emitHud();
  }

  public startNextDayFromReport() {
    this.audio.ui();
    this.save.day++;
    persistSave(this.save);
    this.daySummary = null;
    this.dayStats = {
      picked: 0,
      perfect: 0,
      runawaysCaught: 0,
      driedCollected: 0,
      wolvesSlain: 0,
      earned: 0,
    };
    this.timeOfDay = DAY_START;
    this.warned = 0;
    this.hp = 100;
    this.flashlightOn = false;
    if (this.player) {
      this.player.stamina = 100;
      this.player.exhausted = false;
    }
    this.flaskCharges = this.flaskMax;
    this.debuffs = { dirty: 0, bitten: 0, dizzy: 0 };
    this.vm.setStain(0, 0);
    this.rnd = mulberry32(this.save.day * 977 + 13);
    this.applyDayConditions(this.save.day);
    this.makeOrders();
    this.spawnAllMushrooms();
    this.resetPlayerToTrailStart();
    this.panel = null;
    this.setMode('play');
    this.requestLock();
    const wLoc = getWeatherLoc(this.lang, this.atmosphere.weather);
    const evLoc = getEventLoc(this.lang, this.eventId);
    this.toast(`${t(this.lang, 'day')} ${this.save.day} · ${wLoc.name} · ${evLoc.name}`, 'good');
  }

  private wipeKnife() {
    this.vm.triggerWipe();
    this.audio.wipe();
    this.debuffs.dirty = 0;
    this.toast(t(this.lang, 'toastWipeDone'), 'good');
    this.emitHud();
  }

  public renderMapToCanvas(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !this.world) return;
    const W = canvas.width;
    const H = canvas.height;
    const toPx = (x: number, z: number): [number, number] => [
      ((x + WORLD_SIZE / 2) / WORLD_SIZE) * W,
      ((z + WORLD_SIZE / 2) / WORLD_SIZE) * H,
    ];

    ctx.fillStyle = '#e6d6b5';
    ctx.fillRect(0, 0, W, H);

    // Trees
    for (const tr of this.world.trees) {
      const [px, py] = toPx(tr.x, tr.z);
      ctx.fillStyle =
        tr.kind === 'pine'
          ? 'rgba(52, 82, 46, 0.55)'
          : tr.kind === 'dead'
            ? 'rgba(110, 88, 66, 0.5)'
            : 'rgba(168, 96, 40, 0.45)';
      ctx.beginPath();
      ctx.arc(px, py, tr.s * 2.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Trail loop
    ctx.strokeStyle = '#9c7848';
    ctx.lineWidth = 4;
    ctx.beginPath();
    TRAIL.samples.forEach((s, idx) => {
      const [px, py] = toPx(s.x, s.z);
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();

    // Hut, Campfire & Stall markers
    const [hx, hy] = toPx(HUT_POSE.x, HUT_POSE.z);
    ctx.fillStyle = '#7a3418';
    ctx.fillRect(hx - 6, hy - 6, 12, 12);
    ctx.fillStyle = '#2b1d12';
    ctx.font = 'bold 12px Manrope, sans-serif';
    ctx.fillText(this.lang === 'ru' ? 'Избушка' : this.lang === 'en' ? 'Cabin' : 'Хатина', hx + 9, hy + 4);

    const [cx, cy] = toPx(this.world.campfirePos.x, this.world.campfirePos.z);
    ctx.fillStyle = '#e78b24';
    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.fill();

    const [sx, sy] = toPx(this.world.stallPos.x, this.world.stallPos.z);
    ctx.fillStyle = '#b4521e';
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2b1d12';
    ctx.fillText(this.lang === 'en' ? 'Buyer' : 'Скупка', sx + 9, sy + 4);

    // Discovered Fairy Rings on map
    for (const ring of this.livelySystem?.fairyRings || []) {
      if (!ring.discovered) continue;
      const [rx, ry] = toPx(ring.x, ring.z);
      ctx.save();
      ctx.strokeStyle = '#c48a18';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(rx, ry, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(231, 171, 63, 0.28)';
      ctx.fill();
      ctx.restore();
    }

    // Player arrow
    const [px, py] = toPx(this.player.pos.x, this.player.pos.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-this.player.yaw);
    ctx.fillStyle = '#a3261b';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // --- Touch helpers ---
  public setTouchMove(x: number, y: number) {
    if (this.player) this.player.moveInput.set(x, y);
  }
  public addTouchLook(dx: number, dy: number) {
    if (!this.player) return;
    if (this.cutState) this.moveCloseupKnife(dx * 1.4, dy * 1.4);
    else this.player.look(dx * 1.5, dy * 1.5);
  }
  public toggleTouchSprint(): boolean {
    if (!this.player) return false;
    this.player.sprint = !this.player.sprint;
    return this.player.sprint;
  }
  public touchAction() {
    const st = this.getNearbyStation();
    if (st === 'sell') this.openPanel('shop');
    else if (st === 'workshop') this.openPanel('workshop');
    else if (st === 'dryer') this.openPanel('dryer');
    else if (st === 'campfire') this.restAtCampfire();
    else if (st === 'bed') this.trySleepFromBed();
    else if (this.targetMushroom || this.cutState) this.pressInteract();
    else if (this.targetPickable) this.tryPickupThrowable();
    else this.fireSwing(false);
  }
  public touchActionUp() {
    this.releaseInteract();
  }
  public touchSlash() {
    if (this.cutState) this.cancelCut();
    else this.fireSwing(false);
  }
  public touchThrow() {
    this.throwDistraction();
  }
  public touchTea() {
    this.drinkTea();
  }
  public toggleFlashlight() {
    if (this.mode !== 'play') return;
    this.flashlightOn = !this.flashlightOn;
    this.audio.flashlightClick(this.flashlightOn);
    this.toast(
      t(this.lang, this.flashlightOn ? 'toastFlashlightOn' : 'toastFlashlightOff'),
      this.flashlightOn ? 'good' : '',
    );
    this.emitHud();
  }
  public touchFlashlight() {
    this.toggleFlashlight();
  }

  // --- Orders & Mushroom Spawning ---
  private makeOrders() {
    const pool: SpeciesId[] = ['porcini', 'birch', 'chanterelle', 'honey', 'russula', 'puffball'];
    const pick = () => pool[Math.floor(this.rnd() * pool.length)];
    const a = pick();
    let b = pick();
    while (b === a) b = pick();
    const specMap: Record<string, [number, number]> = {
      porcini: [2, 90],
      birch: [3, 70],
      chanterelle: [8, 60],
      honey: [12, 55],
      russula: [5, 40],
      puffball: [4, 35],
    };
    this.save.orders = {
      day: this.save.day,
      list: [
        ...[a, b].map((sp) => ({
          species: sp,
          n: specMap[sp][0],
          reward: specMap[sp][1],
          done: false,
        })),
        {
          species: 'porcini' as SpeciesId,
          n: 2,
          reward: 115,
          done: false,
          livelyOnly: true,
        },
      ],
    };
  }

  private pickSpecies(x: number, z: number): SpeciesId {
    let pine = 0;
    let decid = 0;
    let dead = 0;
    for (const tr of this.world.trees) {
      if ((tr.x - x) ** 2 + (tr.z - z) ** 2 < 64) {
        if (tr.kind === 'pine') pine++;
        else if (tr.kind === 'dead') dead++;
        else decid++;
      }
    }
    const moss = mossFactorAt(x, z);
    const porciniBoost = this.eventId === 'porcini_boom' ? 2.15 : 1.0;
    const weights: Record<SpeciesId, number> = {
      golden: 0,
      porcini: (0.6 + pine * 0.9) * porciniBoost,
      birch: 0.5 + decid * 0.8,
      chanterelle: 0.4 + moss * 3,
      honey: 0.3 + dead * 6,
      russula: 1.6,
      puffball: 0.6,
      flyagaric: 0.5 + pine * 0.3 + decid * 0.2,
      deathcap: 0.25 + decid * 0.15,
    };
    let sum = 0;
    for (const k in weights) sum += weights[k as SpeciesId];
    let r = this.rnd() * sum;
    for (const k in weights) {
      r -= weights[k as SpeciesId];
      if (r <= 0) return k as SpeciesId;
    }
    return 'russula';
  }

  private spawnMushroomAt(
    x: number,
    z: number,
    species: SpeciesId,
    withPile = false,
    lively = false,
  ) {
    const group = createMushroomModel(species, Math.floor(this.rnd() * 1e9));
    const y = groundHeightAt(x, z);
    group.position.set(x, y - 0.01, z);
    group.rotation.y = this.rnd() * 6.28;
    const gx = groundHeightAt(x + 0.3, z) - groundHeightAt(x - 0.3, z);
    const gz = groundHeightAt(x, z + 0.3) - groundHeightAt(x, z - 0.3);
    group.rotation.x = gz * 0.6;
    group.rotation.z = -gx * 0.6;
    this.mushroomGroup.add(group);

    let pile: THREE.Group | null = null;
    if (withPile) {
      pile = createLeafPile(this.world.leafTex, this.rnd);
      pile.position.set(x, y - 0.02, z);
      pile.rotation.y = this.rnd() * 6.28;
      this.mushroomGroup.add(pile);
      group.visible = false;
    }
    const entity: MushroomEntity = { group, species, x, z, pile, alive: true };
    if (lively) {
      this.livelySystem.attachLivelyAura(entity);
    }
    this.mushrooms.push(entity);
  }

  private spawnOneMushroom(farFromPlayer = false, forceLively = false) {
    for (let tries = 0; tries < 40; tries++) {
      let x: number;
      let z: number;
      if (farFromPlayer) {
        const a = this.rnd() * Math.PI * 2;
        const dist = 45 + this.rnd() * 40;
        x = this.player.pos.x + Math.cos(a) * dist;
        z = this.player.pos.z + Math.sin(a) * dist;
      } else if (this.rnd() < 0.32) {
        const s = TRAIL.samples[Math.floor(this.rnd() * TRAIL.samples.length)];
        x = s.x + (this.rnd() - 0.5) * 22;
        z = s.z + (this.rnd() - 0.5) * 22;
      } else {
        x = (this.rnd() - 0.5) * (WORLD_SIZE - 30);
        z = (this.rnd() - 0.5) * (WORLD_SIZE - 30);
      }
      if (Math.abs(x) > WORLD_SIZE / 2 - 15 || Math.abs(z) > WORLD_SIZE / 2 - 15) continue;
      const td = trailDistance(x, z);
      if (td < 1.6 || Math.hypot(x - HUT_POSE.x, z - HUT_POSE.z) < 7) continue;
      if (this.world.colliders.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < (c.r + 0.25) ** 2)) continue;
      if (this.mushrooms.some((m) => m.alive && (m.x - x) ** 2 + (m.z - z) ** 2 < 4)) continue;

      let species: SpeciesId = td > 30 && this.rnd() < 0.025 ? 'golden' : this.pickSpecies(x, z);
      if (td < 6 && species === 'porcini' && this.rnd() < 0.6) species = 'russula';
      if (forceLively && MUSHROOM_SPECS[species].poison) {
        species = this.rnd() < 0.55 ? 'porcini' : 'birch';
      }
      const isLively =
        forceLively ||
        (!MUSHROOM_SPECS[species].poison &&
          species !== 'honey' &&
          species !== 'puffball' &&
          td > 5 &&
          this.rnd() < 0.055);
      const pile = !isLively && this.rnd() < 0.22 && species !== 'honey' && species !== 'golden';
      this.spawnMushroomAt(x, z, species, pile, isLively);
      return;
    }
  }

  private spawnAllMushrooms() {
    this.livelySystem?.resetAllTimelines(this.mushrooms);
    for (const m of this.mushrooms) {
      this.mushroomGroup.remove(m.group);
      if (m.pile) this.mushroomGroup.remove(m.pile);
    }
    this.mushrooms = [];

    // 1. Mystical Fairy Rings (5-6 scenic clearings, each with ring mushrooms + 1 central lively trophy)
    const ringCount = this.eventId === 'fairy_glow' ? 6 : 5;
    this.livelySystem.spawnFairyRings(
      this.rnd,
      (x, z, sp, withPile, lively) => this.spawnMushroomAt(x, z, sp, withPile, lively),
      ringCount,
    );

    // 2. Wild forest mushrooms (with sparse wild lively mushrooms mixed in)
    const livelyBonus = this.eventId === 'fairy_glow' ? 14 : 8;
    const totalWild = this.eventId === 'mushroom_rain' ? 230 : 205;
    for (let i = 0; i < totalWild; i++) this.spawnOneMushroom(false, i < livelyBonus);

    // 3. Guarantee inviting mushrooms, a leaf pile, and 1 playful lively mushroom near the trailhead
    const samp = TRAIL.samples[4];
    for (const [ox, oz, sp, pile, lively] of [
      [3.2, 1.5, 'russula', false, false],
      [-3.5, 2.5, 'chanterelle', false, false],
      [4.5, -2.0, 'flyagaric', false, false],
      [-2.2, 5.5, 'porcini', true, false],
      [6.2, 4.4, 'porcini', false, true],
    ] as const) {
      this.spawnMushroomAt(samp.x + ox, samp.z + oz, sp, pile, lively);
    }
  }

  private findTargetMushroom(): MushroomEntity | null {
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(this._tmpA);
    let best: MushroomEntity | null = null;
    let bestScore = 1e9;
    for (const m of this.mushrooms) {
      if (!m.alive) continue;
      const isFleeing = this.livelySystem.isCatchableFleeing(m);
      const hopY = m.livelyData?.posY ?? 0;
      const y = groundHeightAt(m.x, m.z) + hopY + (isFleeing ? 0.14 : 0.06);
      this._tmpB.set(m.x - this.camera.position.x, y - this.camera.position.y, m.z - this.camera.position.z);
      const dist = this._tmpB.length();
      const maxDist = isFleeing ? 2.75 : 2.6;
      if (dist > maxDist) continue;
      this._tmpB.divideScalar(dist);
      const dot = this._tmpB.dot(this._tmpA);
      const minDot = isFleeing ? 0.72 : 0.9;
      if (dot < minDot) continue;
      const score = dist * (1.6 - dot) * (isFleeing ? 0.62 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  // --- Closeup Precision Cutting Rig (Pure Forged Knife, No Hands) ---
  private ensureCutRig() {
    if (this.cutRig) return;
    const root = new THREE.Group();
    const knife = buildKnifeModel(this.currentKnife.look, false, this.knifeEnvMap);
    // cutRig +X is camera-right, +Z is toward camera; point blade (-X) toward the stem with flat edge horizontal
    knife.group.rotation.order = 'XYZ';
    knife.group.rotation.set(-Math.PI / 2 + 0.22, 0, Math.PI / 2);
    knife.group.position.set(0.23, 0.004, 0.015);
    knife.group.scale.setScalar(1.16);
    root.add(knife.group);

    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
      }
    });

    const guide = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.06, 6, 40),
      new THREE.MeshBasicMaterial({
        color: '#9bd24f',
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      }),
    );
    guide.rotation.x = Math.PI / 2;
    guide.renderOrder = 20;

    this.cutRig = root;
    this.cutGuide = guide;
    this.scene.add(root, guide);
    root.visible = guide.visible = false;
  }

  private pressInteract() {
    if (this.cutState && this.cutState.phase === 'closeup') {
      this.cutState.down = true;
      this.cutState.startSide = Math.sign(this.cutState.kx) || -1;
      return;
    }
    if (this.cutState || !this.targetMushroom) return;
    const m = this.targetMushroom;
    if (m.pile) {
      this.clearLeafPile(m);
      return;
    }
    if (m.lively && m.livelyData) {
      if (this.livelySystem.isCatchableFleeing(m)) {
        this.catchLivelyMushroom(m);
        return;
      }
      // Standing loudly without crouching startles the lively mushroom into a chase!
      if (this.player.crouch <= 0.45 && m.livelyData.stunTimer <= 0) {
        this.livelySystem.startle(m, this.player.pos, () => {
          this.toast(t(this.lang, 'toastStartledStand'), 'warn');
        });
        return;
      }
    }
    this.ensureCutRig();
    const base = new THREE.Vector3(m.x, groundHeightAt(m.x, m.z), m.z);
    const toP = new THREE.Vector3(this.player.pos.x - m.x, 0, this.player.pos.z - m.z).normalize();
    const side = new THREE.Vector3(-toP.z, 0, toP.x);
    const sz = (m.group.userData.size as number) || 1;
    const stemR = ((m.group.userData.count as number) > 1 ? 0.05 : 0.026) * sz + 0.01;
    const ideal = 0.008 + this.rnd() * 0.022;

    this.cutState = {
      m,
      phase: 'closeup',
      t: 0,
      blend: 0,
      base,
      toP,
      side,
      stemR,
      ideal,
      ideal0: ideal,
      tol: this.currentKnife.tol,
      kx: -0.16,
      ky: 0.09,
      down: false,
      startSide: -1,
      maxPush: 0,
      quality: 1,
      label: '',
      fallAxis: side.clone(),
      fallSign: 1,
    };

    this.player.enabled = false;
    this.vm.root.visible = false;
    if (this.cutRig) this.cutRig.visible = true;
    if (this.cutGuide) {
      this.cutGuide.visible = true;
      this.cutGuide.scale.setScalar(stemR + 0.012);
    }
    this.emitHud();
  }

  private releaseInteract() {
    if (this.cutState && this.cutState.phase === 'closeup') {
      this.cutState.down = false;
    }
  }

  private moveCloseupKnife(dx: number, dy: number) {
    const cs = this.cutState;
    if (!cs || cs.phase !== 'closeup') return;
    cs.kx = THREE.MathUtils.clamp(cs.kx + dx * 0.00045, -0.2, 0.2);
    cs.ky = THREE.MathUtils.clamp(cs.ky - dy * 0.00035, -0.004, 0.16);
    if (cs.down && Math.abs(cs.kx) < cs.stemR) {
      cs.maxPush = Math.max(cs.maxPush, Math.abs(dx));
    }
    if (cs.down && Math.sign(cs.kx) !== cs.startSide && Math.abs(cs.kx) > cs.stemR) {
      this.executeCloseupSlice(cs);
    }
  }

  private cancelCut() {
    if (this.cutState && this.cutState.phase === 'closeup') {
      this.cutState.phase = 'leave';
      this.cutState.t = 0;
      this.emitHud();
    }
  }

  private executeCloseupSlice(cs: CutState) {
    const diff = cs.ky - cs.ideal;
    let quality = 1;
    let label = '';

    if (Math.abs(diff) <= cs.tol) {
      this.combo++;
      const mult = 1 + 0.1 * Math.min(this.combo - 1, 10);
      quality = 1.25 * mult;
      label =
        this.combo > 1
          ? `${t(this.lang, 'toastPerfectStreak')} ×${mult.toFixed(1)}`
          : t(this.lang, 'toastPerfect');
      if (this.combo >= 5) {
        this.unlockAchievement('perfect_streak');
      }
    } else if (diff > 0) {
      this.combo = 0;
      quality = diff > 0.05 ? 0.7 : 0.95;
      label = diff > 0.05 ? t(this.lang, 'toastHighCut') : t(this.lang, 'toastStumpCut');
    } else {
      this.combo = 0;
      quality = 0.8;
      label = t(this.lang, 'toastDirtCut');
      this.physics.emitBurst(cs.base.clone().setY(cs.base.y + 0.02), 28, '#4a3018', 1.1, 1.4, 8.5);
    }

    if (cs.maxPush > 38) {
      this.combo = 0;
      quality *= 0.75;
      label = t(this.lang, 'toastRipCut');
    }
    if (diff < -cs.tol) {
      if (this.currentKnife.look.brush) {
        this.debuffs.dirty = 0;
      } else {
        this.debuffs.dirty = Math.min(3, this.debuffs.dirty + 1);
        this.vm.setStain(this.debuffs.dirty);
        setTimeout(() => {
          this.toast(t(this.lang, 'toastDirtyKnife'), 'warn');
        }, 500);
      }
    }
    if (this.debuffs.dirty > 0 && diff >= -cs.tol) {
      quality *= 1 - 0.1 * this.debuffs.dirty;
      label += ` · ${t(this.lang, 'toastDirtyTag')}`;
    }
    if (this.debuffs.dizzy > 0) quality *= 0.9;

    cs.phase = 'falling';
    cs.t = 0;
    cs.quality = quality;
    cs.label = label;
    cs.fallAxis = cs.side.clone();
    cs.fallSign = -cs.startSide;

    this.audio.crunch(quality > 1.1);
    this.physics.emitBurst(
      cs.base.clone().setY(cs.base.y + Math.max(0.01, cs.ky)),
      22,
      '#e8dcc0',
      0.7,
      1.0,
      6.0,
    );
    this.emitHud();
  }

  private clearLeafPile(m: MushroomEntity, dirBias?: THREE.Vector3) {
    const pile = m.pile;
    if (!pile) return;
    m.pile = null;
    const leaves = (pile.userData.leaves as THREE.Mesh[]) || [];
    for (const lf of leaves) {
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 2.2,
        1.1 + Math.random() * 1.5,
        (Math.random() - 0.5) * 2.2,
      );
      if (dirBias) v.addScaledVector(dirBias, 2.8);
      this.flying.push({ obj: lf, kind: 'leaf', v, spin: 5 + Math.random() * 9, t: 0 });
    }
    if (pile.userData.base) {
      this.flying.push({ obj: pile.userData.base as THREE.Object3D, kind: 'sink', t: 0 });
    }
    m.group.visible = true;
    this.audio.rustle();
    this.physics.emitBurst(
      new THREE.Vector3(m.x, groundHeightAt(m.x, m.z) + 0.1, m.z),
      28,
      '#9a5a28',
      1.8,
      1.9,
      4.5,
    );
    setTimeout(() => this.mushroomGroup.remove(pile), 1600);

    // If a lively mushroom was hiding under this pile, crouch stealth dazes it while standing startles it!
    if (m.lively && m.livelyData && m.alive) {
      if (this.player.crouch > 0.45) {
        this.livelySystem.dazeMushroom(m, 2.6);
        this.toast(t(this.lang, 'toastQuietPile'), 'good');
      } else {
        this.livelySystem.startle(m, this.player.pos, () => {
          this.toast(t(this.lang, 'toastLoudPile'), 'warn');
        });
      }
    }
  }

  private recordPickedAchievements(species: SpeciesId, lively: boolean) {
    if (species === 'porcini') this.unlockAchievement('first_porcini');
    if (species === 'golden') this.unlockAchievement('golden_legend');
    if (lively) {
      this.save.stats.runaways++;
      this.dayStats.runawaysCaught++;
      this.unlockAchievement('catch_runaway');
    }
    if (this.atmosphere && this.atmosphere.rainBlend > 0.35) {
      this.save.stats.rainPicked++;
      if (this.save.stats.rainPicked >= 5) {
        this.unlockAchievement('rain_forager');
      }
    }
  }

  private catchLivelyMushroom(m: MushroomEntity) {
    if (!m.alive) return;
    const slots = m.species === 'porcini' || m.species === 'flyagaric' || m.species === 'golden' ? 2 : 1;
    if (this.basketUsed() + slots > this.basketCap) {
      this.toast(t(this.lang, 'toastBasketFull'), 'warn');
      return;
    }

    m.livelyData?.tl?.kill();
    if (m.livelyData) {
      m.livelyData.tl = null;
      m.livelyData.state = 'idle';
      m.livelyData.posY = 0;
      m.livelyData.vy = 0;
    }
    m.group.scale.setScalar(1);
    const roots = m.group.getObjectByName('livelyRootlets');
    if (roots) roots.visible = false;

    m.alive = false;
    this.flying.push({
      obj: m.group,
      kind: 'mushroom',
      t: 0,
      from: m.group.position.clone(),
      rot0: m.group.rotation.clone(),
      m,
    });

    const count = (m.group.userData.count as number) || 1;
    this.basket.push({ species: m.species, quality: 1.15, slots, count, lively: true });
    this.save.stats.picked++;
    this.dayStats.picked++;
    this.combo++;
    this.recordPickedAchievements(m.species, true);

    this.audio.catchLively();
    this.livelySystem.emitSpores(m.x, groundHeightAt(m.x, m.z) + 0.16, m.z, 22, 1.8, 2.6);
    const known = this.save.up.guide || this.save.atlas[m.species];
    const title = known ? getSpeciesLoc(this.lang, m.species).name : t(this.lang, 'livelyOrder');
    this.toast(`✨ ${t(this.lang, 'toastCaught')} ${title} (×2.5)`, 'good');
    this.emitHud();
  }

  private finishCut(m: MushroomEntity, quality: number, label: string) {
    const spec = MUSHROOM_SPECS[m.species];
    const slots = m.species === 'porcini' || m.species === 'flyagaric' || m.species === 'golden' ? 2 : 1;
    if (this.basketUsed() + slots > this.basketCap) {
      this.toast(t(this.lang, 'toastBasketFull'), 'warn');
      return;
    }
    m.livelyData?.tl?.kill();
    if (m.livelyData) {
      m.livelyData.tl = null;
      m.livelyData.posY = 0;
      m.livelyData.vy = 0;
    }
    const roots = m.group.getObjectByName('livelyRootlets');
    if (roots) roots.visible = false;
    m.group.scale.setScalar(1);

    m.alive = false;
    this.flying.push({
      obj: m.group,
      kind: 'mushroom',
      t: 0,
      from: m.group.position.clone(),
      rot0: m.group.rotation.clone(),
      m,
    });
    const count = (m.group.userData.count as number) || 1;
    const isLively = Boolean(m.lively);
    this.basket.push({ species: m.species, quality, slots, count, lively: isLively });
    this.save.stats.picked++;
    this.dayStats.picked++;
    if (quality > 1.1) {
      this.save.stats.perfect++;
      this.dayStats.perfect++;
    }
    this.recordPickedAchievements(m.species, isLively);
    if (isLively) {
      this.audio.catchLively();
      this.livelySystem.emitSpores(m.x, groundHeightAt(m.x, m.z) + 0.14, m.z, 18, 1.5, 2.2);
    }

    const known = this.save.up.guide || this.save.atlas[m.species];
    const title = known ? getSpeciesLoc(this.lang, m.species).name : t(this.lang, 'unknownMushroom');
    this.toast(
      isLively
        ? `✨ ${t(this.lang, 'toastQuietCatch')} ${label} · ${title} (×2.5)`
        : `${label} · ${title}${count > 1 ? ' ×' + count : ''}`,
      isLively || quality > 1.1 ? 'good' : quality < 0.9 ? 'warn' : '',
    );

    if (m.species === 'flyagaric') {
      this.debuffs.dizzy = 14;
      setTimeout(() => this.toast(t(this.lang, 'toastFlyagaric'), 'warn'), 900);
    }
    if (this.save.up.guide && spec.poison) {
      setTimeout(() => this.toast(t(this.lang, 'toastPoisonWarn'), 'bad'), 1200);
    }
    this.emitHud();
  }

  /**
   * Resolves physical knife sweep collision during active swing frames against:
   * 1. Wolves (combat hitstop, knockback, blood stain)
   * 2. Leaf piles (directional blade scatter)
   * 3. Mushrooms (slices cap cleanly off with rigid-body tumble!)
   * 4. Dynamic props, trees, rocks, hut, bushes, soil (PhysicsWorld)
   */
  private resolveActiveBladeSweep(swing: NonNullable<ReturnType<ViewModelController['update']>>) {
    if (!swing.active || this.vm.hasHitCurrentSwing()) return;

    const knife = this.currentKnife;
    const reach = knife.reach + (swing.heavy ? 0.25 : 0);
    const dmg = knife.dmg * swing.damageMultiplier;
    const force = knife.force * swing.forceMultiplier;

    // 1. Wolves first
    const wolfHit = this.wolves.hit(
      swing.rayOrigin,
      swing.rayDir,
      swing.slashDirWorld,
      reach,
      dmg,
      force,
    );
    if (wolfHit) {
      this.vm.markSwingHit();
      this.vm.triggerImpactRecoil('flesh', swing.heavy ? 1.35 : 1.0);
      this.vm.addBlood(0.42);
      this.hitstopTimer = swing.heavy ? 0.068 : 0.048;
      this.player.addShake(swing.heavy ? 0.032 : 0.02);
      this.physics.emitDirectionalBurst(wolfHit.point, swing.slashDirWorld, 28, '#8c1814', 3.4, 8.5);
      if (wolfHit.status === 'kill') {
        this.fangs++;
        this.save.stats.wolves++;
        this.dayStats.wolvesSlain++;
        this.unlockAchievement('wolf_hunter');
        this.toast(`${t(this.lang, 'toastWolfKill')} (${this.fangValue} ₴)`, 'good');
      } else {
        this.toast(t(this.lang, swing.heavy ? 'toastWolfHeavy' : 'toastWolfHit'), '');
      }
      this.emitHud();
      return;
    }

    // 2. Check mushrooms & leaf piles along the blade sweep!
    for (const m of this.mushrooms) {
      if (!m.alive) continue;
      const my = groundHeightAt(m.x, m.z) + (m.livelyData?.posY ?? 0) + 0.1;
      this._tmpA.set(m.x - swing.rayOrigin.x, my - swing.rayOrigin.y, m.z - swing.rayOrigin.z);
      const proj = this._tmpA.dot(swing.rayDir);
      if (proj < 0.15 || proj > reach + 0.15) continue;
      this._tmpB.copy(swing.rayOrigin).addScaledVector(swing.rayDir, proj);
      const perpSq = this._tmpB.distanceToSquared(new THREE.Vector3(m.x, my, m.z));
      if (perpSq > 0.34 * 0.34) continue;

      if (m.pile) {
        // Physically sweep leaf pile in the direction of the blade swing!
        this.vm.markSwingHit();
        this.vm.triggerImpactRecoil('soft', 0.6);
        this.clearLeafPile(m, swing.slashDirWorld);
        return;
      } else if (m.lively && m.livelyData) {
        // Catch fleeing, cover-seeking, or burrowing lively mushroom cleanly on blade intercept!
        this.vm.markSwingHit();
        this.vm.triggerImpactRecoil('soft', 0.55);
        if (this.livelySystem.isCatchableFleeing(m)) {
          this.catchLivelyMushroom(m);
        } else {
          this.livelySystem.startle(m, this.player.pos, () => {
            this.toast(t(this.lang, 'toastStartledBlade'), 'warn');
          });
        }
        return;
      } else {
        // Free-roam slash cleanly chops the mushroom cap off into physics flight!
        this.vm.markSwingHit();
        this.vm.triggerImpactRecoil('soft', 0.75);
        this.audio.crunch(false);
        this.hitstopTimer = 0.028;
        m.alive = false;

        const capGroup = m.group.userData.capGroup as THREE.Object3D | undefined;
        const worldPos = new THREE.Vector3(m.x, my + 0.06, m.z);
        if (capGroup && capGroup.parent) {
          capGroup.parent.remove(capGroup);
          // Leave sliced stump behind briefly
          setTimeout(() => this.mushroomGroup.remove(m.group), 14000);
          this.physics.spawnSlicedCap(capGroup, worldPos, swing.slashDirWorld, 4.4 * swing.swingSpeed);
        } else {
          this.mushroomGroup.remove(m.group);
          this.physics.spawnSlicedCap(m.group, worldPos, swing.slashDirWorld, 4.0 * swing.swingSpeed);
        }
        this.physics.emitBurst(worldPos, 24, '#efe4c8', 1.4, 1.8, 5.5);
        this.toast(t(this.lang, 'toastSliceCap'), 'warn');
        return;
      }
    }

    // 3. Rigid-body props (crates, logs, barrels, stones), trees, rocks, hut, bushes, soil
    const hit = this.physics.testKnifeImpact(
      swing.rayOrigin,
      swing.rayDir,
      swing.slashDirWorld,
      reach,
      force,
      dmg,
    );
    if (!hit) return;

    this.vm.markSwingHit();

    if (hit.material === 'rock') {
      this.vm.triggerImpactRecoil('hard', hit.strength);
      this.audio.hitRock(hit.strength);
      this.hitstopTimer = swing.heavy ? 0.06 : 0.042;
      this.player.addShake(0.024 * hit.strength);
    } else if (hit.material === 'crate') {
      this.vm.triggerImpactRecoil('wood', hit.strength);
      if (hit.brokeCrate) {
        this.audio.shatterCrate();
        this.hitstopTimer = 0.055;
        this.player.addShake(0.028);
        if (hit.crateBonusPos) {
          const sp: SpeciesId = Math.random() < 0.5 ? 'porcini' : 'chanterelle';
          this.spawnMushroomAt(hit.crateBonusPos.x, hit.crateBonusPos.z, sp, false);
          this.toast(t(this.lang, 'toastCrateBonus'), 'good');
        } else {
          this.toast(t(this.lang, 'toastCrateBreak'), '');
        }
      } else {
        this.audio.hitWood(hit.strength);
        this.hitstopTimer = 0.036;
        this.player.addShake(0.015 * hit.strength);
      }
    } else if (hit.material === 'wood') {
      this.vm.triggerImpactRecoil('wood', hit.strength);
      this.audio.hitWood(hit.strength);
      this.hitstopTimer = 0.036;
      this.player.addShake(0.014 * hit.strength);
    } else if (hit.material === 'foliage') {
      this.vm.triggerImpactRecoil('soft', 0.45);
      this.audio.sliceFoliage();
    } else if (hit.material === 'soil') {
      this.vm.triggerImpactRecoil('wood', 0.65);
      this.audio.hitSoil();
      if (!this.currentKnife.look.brush) {
        this.debuffs.dirty = Math.min(3, this.debuffs.dirty + 1);
        this.vm.setStain(this.debuffs.dirty);
      }
    }
  }

  private getNearbyStation(): 'sell' | 'workshop' | 'bed' | 'campfire' | 'dryer' | null {
    if (this.stallDist < 4.5) return 'sell';
    if (
      HUT_POSE.bench &&
      Math.hypot(this.player.pos.x - HUT_POSE.bench.x, this.player.pos.z - HUT_POSE.bench.z) < 1.7
    ) {
      return 'workshop';
    }
    if (
      HUT_POSE.bed &&
      Math.hypot(this.player.pos.x - HUT_POSE.bed.x, this.player.pos.z - HUT_POSE.bed.z) < 1.85
    ) {
      return 'bed';
    }
    if (
      this.world?.dryerPos &&
      Math.hypot(this.player.pos.x - this.world.dryerPos.x, this.player.pos.z - this.world.dryerPos.z) < 2.65
    ) {
      return 'dryer';
    }
    if (
      this.world?.campfirePos &&
      Math.hypot(this.player.pos.x - this.world.campfirePos.x, this.player.pos.z - this.world.campfirePos.z) < 3.1
    ) {
      return 'campfire';
    }
    return null;
  }

  private updateForaging(dt: number, elapsed: number) {
    if (!this.cutState) {
      this.targetMushroom = this.findTargetMushroom();
      if (!this.targetMushroom) {
        this.camera.updateMatrixWorld();
        this.camera.getWorldDirection(this._tmpA);
        this.targetPickable = this.physics.findPickableItem(this.camera.position, this._tmpA, 2.85);
      } else {
        this.targetPickable = null;
      }
    }

    // Advance mushroom drying rack progress
    if (this.save.driedRack.length > 0) {
      const rate = dt / this.dryDurationSec;
      let anyJustFinished = false;
      for (const slot of this.save.driedRack) {
        if (slot.progress < 1) {
          slot.progress = Math.min(1, slot.progress + rate);
          if (slot.progress >= 1) anyJustFinished = true;
        }
      }
      if (anyJustFinished) {
        this.world.syncDryingRackVisuals(this.save.driedRack);
        persistSave(this.save);
      }
    }

    const cs = this.cutState;
    if (cs) {
      cs.t += dt;
      const desiredPos = cs.base.clone().addScaledVector(cs.toP, 0.36).add(new THREE.Vector3(0, 0.2, 0));
      const lookAtPos = cs.base.clone().add(new THREE.Vector3(0, 0.04, 0));
      this._lookMat.lookAt(desiredPos, lookAtPos, this._upVec);
      this._targetQ.setFromRotationMatrix(this._lookMat);

      if (cs.phase === 'closeup' || cs.phase === 'falling') {
        cs.blend = Math.min(1, cs.blend + dt * 3.5);
      } else {
        cs.blend = Math.max(0, cs.blend - dt * 3.5);
      }
      const ease = cs.blend * cs.blend * (3 - 2 * cs.blend);
      this.camera.position.lerp(desiredPos, ease);
      this.camera.quaternion.slerp(this._targetQ, ease);

      if (this.cutRig && this.cutGuide) {
        const rigPos = cs.base
          .clone()
          .addScaledVector(cs.side, cs.kx)
          .add(new THREE.Vector3(0, cs.ky, 0))
          .addScaledVector(cs.toP, 0.025);
        this.cutRig.position.copy(rigPos);
        this._lookMat.lookAt(new THREE.Vector3(), cs.toP.clone().negate(), this._upVec);
        this.cutRig.quaternion.setFromRotationMatrix(this._lookMat);
        this.cutGuide.position.set(cs.base.x, cs.base.y + cs.ideal, cs.base.z);
        const onTarget = Math.abs(cs.ky - cs.ideal) <= cs.tol;
        const gMat = this.cutGuide.material as THREE.MeshBasicMaterial;
        gMat.color.set(onTarget ? '#d8ff7a' : '#9bd24f');
        gMat.opacity = 0.5 + Math.sin(elapsed * 8) * 0.3;
      }

      if (cs.phase === 'closeup') {
        const sway = Math.sin(elapsed * 1.7) * 0.004 + Math.sin(elapsed * 3.1) * 0.002;
        cs.ideal = Math.max(0.006, cs.ideal0 + sway);
        if (this.player.stamina < 30 || this.player.exhausted) {
          cs.ky += (Math.random() - 0.5) * 0.004;
          cs.kx += (Math.random() - 0.5) * 0.004;
        }
        if (this.debuffs.dizzy > 0) cs.ky += Math.sin(elapsed * 5) * 0.0015;
        cs.m.group.rotation.z = Math.sin(elapsed * 1.7) * 0.05;
      } else if (cs.phase === 'falling') {
        if (this.cutGuide) this.cutGuide.visible = false;
        const u = Math.min(1, cs.t / 0.45);
        cs.m.group.rotateOnWorldAxis(cs.fallAxis, cs.fallSign * dt * 2.6 * (1 - u * 0.5));
        cs.m.group.position.y = cs.base.y + cs.ky * (1 - u) + Math.sin(u * Math.PI) * 0.03;
        if (cs.t > 0.5) {
          this.finishCut(cs.m, cs.quality, cs.label);
          cs.phase = 'leave';
          cs.t = 0;
        }
      } else if (cs.phase === 'leave') {
        if (this.cutRig) this.cutRig.visible = false;
        if (this.cutGuide) this.cutGuide.visible = false;
        if (cs.blend <= 0) {
          this.cutState = null;
          this.player.enabled = true;
          this.vm.root.visible = true;
          this.emitHud();
        }
      }
    }

    // Animate flying leaves & harvested mushrooms leaping into basket
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.t += dt;
      if (f.kind === 'leaf' && f.v) {
        f.v.y -= 4.2 * dt;
        f.obj.position.addScaledVector(f.v, dt);
        f.obj.rotation.x += (f.spin || 6) * dt;
        f.obj.rotation.z += (f.spin || 6) * 0.7 * dt;
        if (f.t > 1.5) this.flying.splice(i, 1);
      } else if (f.kind === 'sink') {
        f.obj.scale.y = Math.max(0.01, 1 - f.t * 1.5);
        if (f.t > 0.7) {
          f.obj.visible = false;
          this.flying.splice(i, 1);
        }
      } else if (f.kind === 'mushroom' && f.from && f.rot0) {
        const u = Math.min(1, f.t / 0.55);
        const dest = this.vm.basket.getWorldPosition(this._tmpA);
        const e = u * u * (3 - 2 * u);
        f.obj.position.lerpVectors(f.from, dest, e);
        f.obj.position.y += Math.sin(u * Math.PI) * 0.45;
        f.obj.rotation.x = f.rot0.x + u * 5;
        f.obj.rotation.z = f.rot0.z + u * 3;
        f.obj.scale.setScalar(1 - u * 0.6);
        if (u >= 1) {
          this.mushroomGroup.remove(f.obj);
          f.obj.scale.setScalar(1);
          f.obj.position.set(0, 0, 0);
          f.obj.rotation.set(0, 0, 0);
          this.vm.addToBasket(f.obj);
          this.audio.plop();
          this.flying.splice(i, 1);
        }
      }
    }

    // Visibility culling & gentle highlight pulse for targeted mushroom
    for (const m of this.mushrooms) {
      if (!m.alive) continue;
      const d2 = (m.x - this.player.pos.x) ** 2 + (m.z - this.player.pos.z) ** 2;
      m.group.visible = !m.pile && d2 < 70 * 70;
      if (m.pile) m.pile.visible = d2 < 70 * 70;
      if (!m.lively) {
        if (m === this.targetMushroom && !m.pile) {
          m.group.scale.setScalar(1 + Math.sin(elapsed * 8) * 0.03);
        } else {
          m.group.scale.setScalar(1);
        }
      }
    }

    const regrowMult = this.atmosphere ? this.atmosphere.getRegrowMultiplier(this.eventId) : 1;
    this.regrowTimer += dt * regrowMult;
    if (this.regrowTimer > 6) {
      this.regrowTimer = 0;
      if (this.mushrooms.filter((m) => m.alive).length < 235) {
        this.spawnOneMushroom(true);
      }
    }
    this.mushrooms = this.mushrooms.filter((m) => m.alive || this.flying.some((f) => f.m === m));

    this.debuffs.dizzy = Math.max(0, this.debuffs.dizzy - dt);
    this.debuffs.bitten = Math.max(0, this.debuffs.bitten - dt);
    this.player.slow = this.debuffs.bitten > 0 ? 0.7 : 1;
  }

  private toast(text: string, tone: '' | 'good' | 'warn' | 'bad' = '') {
    this.callbacks.onToast({ id: this.toastSeq++, text, tone });
  }

  private emitHud() {
    const lang = this.lang;
    const hours = Math.floor(this.timeOfDay * 24);
    const mins = Math.floor((this.timeOfDay * 24 - hours) * 60);
    const timeStr = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    const keyLmb = t(lang, 'keyLmb');

    let prompt: HudSnapshot['prompt'] = null;
    if (this.mode === 'play' && !this.cutState && !this.panel && !this.player?.externalCameraControl) {
      if (this.targetMushroom) {
        const m = this.targetMushroom;
        const spec = MUSHROOM_SPECS[m.species];
        const spLoc = getSpeciesLoc(lang, m.species);
        const known = Boolean(this.save.up.guide || this.save.atlas[m.species]);
        if (m.pile) {
          prompt = {
            title: m.lively ? t(lang, 'promptFreshLeafPile') : t(lang, 'promptLeafPile'),
            hint:
              m.lively && this.player.crouch > 0.45
                ? t(lang, 'promptClearLeavesQuiet')
                : t(lang, 'promptClearLeaves'),
            key: keyLmb,
            danger: false,
          };
        } else if (m.lively && m.livelyData?.state === 'burrowing') {
          prompt = {
            title: `✨ ${t(lang, 'promptBurrowing')}`,
            hint: t(lang, 'promptCatchNow'),
            key: `${keyLmb} / E`,
            danger: false,
          };
        } else if (this.livelySystem.isCatchableFleeing(m)) {
          prompt = {
            title: `✨ ${t(lang, 'promptRunaway')}`,
            hint: t(lang, 'promptCatchRun'),
            key: `${keyLmb} / E`,
            danger: false,
          };
        } else if (m.lively && m.livelyData?.state === 'alert') {
          prompt = {
            title: `✨ ${t(lang, 'promptAlert')}`,
            hint: t(lang, 'promptAlertHint'),
            key: `C + ${keyLmb}`,
            danger: false,
          };
        } else if (m.lively) {
          const safeApproach = this.player.crouch > 0.45 || (m.livelyData?.stunTimer ?? 0) > 0;
          prompt = {
            title: `✨ ${known ? spLoc.name : t(lang, 'livelyOrder')}`,
            hint: safeApproach ? t(lang, 'promptLivelyCut') : t(lang, 'promptLivelyWarn'),
            key: safeApproach ? keyLmb : `C + ${keyLmb}`,
            danger: false,
          };
        } else {
          prompt = {
            title: known ? spLoc.name : t(lang, 'unknownMushroom'),
            hint: t(lang, 'promptCut'),
            key: keyLmb,
            danger: Boolean(known && spec.poison && this.save.up.guide),
          };
        }
      } else if (this.targetPickable) {
        prompt = {
          title:
            this.targetPickable.kind === 'stone'
              ? t(lang, 'promptPickupStone')
              : t(lang, 'promptPickupStick'),
          hint: t(lang, 'promptPickupHint'),
          key: 'G',
          danger: false,
        };
      } else {
        const st = this.getNearbyStation();
        if (st === 'sell') {
          prompt = { title: t(lang, 'promptSell'), hint: t(lang, 'promptSellHint'), key: 'E', danger: false };
        } else if (st === 'workshop') {
          prompt = {
            title: t(lang, 'promptWorkshop'),
            hint: t(lang, 'promptWorkshopHint'),
            key: 'E',
            danger: false,
          };
        } else if (st === 'dryer') {
          prompt = {
            title: t(lang, 'promptDryer'),
            hint: t(lang, 'promptDryerHint'),
            key: 'E',
            danger: false,
          };
        } else if (st === 'campfire') {
          prompt = {
            title: t(lang, 'promptCampfire'),
            hint: t(lang, 'promptCampfireHint'),
            key: 'E',
            danger: false,
          };
        } else if (st === 'bed') {
          prompt = { title: t(lang, 'promptBed'), hint: t(lang, 'promptBedHint'), key: 'E', danger: false };
        }
      }
    }

    const debuffList: HudSnapshot['debuffs'] = [];
    if (this.debuffs.dirty > 0) {
      debuffList.push({
        label: `${t(lang, 'debuffDirty')} (${this.debuffs.dirty}) · ${t(lang, 'debuffWipe')}`,
        tone: 'warn',
      });
    }
    if (this.debuffs.bitten > 0) {
      debuffList.push({
        label: `${t(lang, 'debuffBitten')} (${Math.ceil(this.debuffs.bitten)}${lang === 'en' ? 's' : 'с'})`,
        tone: 'bad',
      });
    }
    if (this.debuffs.dizzy > 0) {
      debuffList.push({
        label: `${t(lang, 'debuffDizzy')} (${Math.ceil(this.debuffs.dizzy)}${lang === 'en' ? 's' : 'с'})`,
        tone: 'warn',
      });
    }
    if (this.player?.exhausted) {
      debuffList.push({ label: t(lang, 'debuffExhausted'), tone: 'warn' });
    }

    let compassAngle = 0;
    if (this.world && this.player) {
      const dx = this.world.stallPos.x - this.player.pos.x;
      const dz = this.world.stallPos.z - this.player.pos.z;
      const fx = -Math.sin(this.player.yaw);
      const fz = -Math.cos(this.player.yaw);
      const rx = Math.cos(this.player.yaw);
      const rz = -Math.sin(this.player.yaw);
      compassAngle = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
    }

    const saved = loadSave();

    this.callbacks.onHud({
      lang,
      mode: this.mode,
      panel: this.panel,
      loadProgress: this.loadProgress,
      loadMessage: this.loadMessage,
      day: this.save.day,
      timeStr,
      weather: this.atmosphere ? this.atmosphere.weather : 'clear',
      eventId: this.eventId,
      basketUsed: this.basketUsed(),
      basketCap: this.basketCap,
      money: this.save.money,
      hp: Math.round(this.hp),
      stamina: Math.round(this.player?.stamina ?? 100),
      exhausted: Boolean(this.player?.exhausted),
      combo: this.combo,
      knifeId: this.currentKnife.id,
      knifeName: getKnifeLoc(lang, this.currentKnife.id).name,
      knifeDirty: this.debuffs.dirty,
      chargeRatio: this.vm ? this.vm.getChargeRatio() : 0,
      swingComboIndex: this.vm ? this.vm.getComboStep() : 0,
      compassEnabled: Boolean(this.save.up.compass),
      compassAngle,
      throwableCount: this.throwables.length,
      throwableMax: 3,
      nextThrowableKind: this.throwables.length > 0 ? this.throwables[this.throwables.length - 1] : null,
      flaskCharges: this.flaskCharges,
      flaskMax: this.flaskMax,
      dryerUsed: this.save.driedRack.length,
      dryerReady: this.dryerReadyCount,
      dryerCap: this.dryerCap,
      flashlightOn: this.flashlightOn,
      flashlightUpgraded: Boolean(this.save.up.lamp),
      prompt,
      closeup: {
        active: Boolean(this.cutState && this.cutState.phase === 'closeup'),
        ky: this.cutState?.ky ?? 0.05,
        ideal: this.cutState?.ideal ?? 0.02,
        tol: this.cutState?.tol ?? 0.005,
      },
      debuffs: debuffList,
      orders: this.save.orders?.list || [],
      hurtTick: this.hurtTick,
      fadeText: this.fadeText,
      hasSave: Boolean(saved),
      saveSummary: saved ? `${t(lang, 'day').toLowerCase()} ${saved.day}, ${saved.money} ₴` : '',
      muted: this.audio.muted,
      chasingLively: this.chasingLively,
      daySummary: this.daySummary,
      achievementBanner: this.achievementBanner,
    });
  }

  // --- Frame loop with Software-WebGL afterDraw pacing ---
  private afterDraw(cb: () => void) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.destroyed) return;
      const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private scheduleNextFrame() {
    if (this.destroyed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(() => this.tick());
    } else {
      this.frameId = requestAnimationFrame(() => this.tick());
    }
  }

  private tick() {
    if (this.destroyed) return;
    const rawDt = Math.min(0.05, this.clock.getDelta());
    const elapsed = this.clock.elapsedTime;

    // Brief tactile hitstop freeze on heavy steel impacts
    if (this.hitstopTimer > 0) {
      this.hitstopTimer = Math.max(0, this.hitstopTimer - rawDt);
      this.vm?.setPaused(true);
      this.player?.setPaused(true);
      this.livelySystem?.setPaused(true, this.mushrooms);
      this.renderFrame(rawDt, elapsed);
      this.scheduleNextFrame();
      return;
    } else {
      const isPaused =
        this.mode !== 'play' ||
        Boolean(this.panel) ||
        Boolean(this.cutState) ||
        Boolean(this.player?.externalCameraControl);
      this.vm?.setPaused(isPaused);
      this.player?.setPaused(isPaused);
      this.livelySystem?.setPaused(isPaused, this.mushrooms);
    }

    const dt = rawDt;

    if (this.mode === 'play' && !this.panel && !this.player.externalCameraControl) {
      this.timeOfDay += dt * DAY_RATE;
    }
    // Golden late-afternoon hour in campfire title screen so sun rays + firelight glow together
    const effectiveTod = this.mode === 'menu' ? 0.7 : this.timeOfDay;
    updateDaylight(this.world, this.scene, effectiveTod);

    if (this.mode === 'menu') {
      const lerpK = 1 - Math.exp(-dt * 2.8);
      this.menuSmoothX += (this.menuMouseX - this.menuSmoothX) * lerpK;
      this.menuSmoothY += (this.menuMouseY - this.menuSmoothY) * lerpK;

      const swayX = Math.sin(elapsed * 0.35) * 0.22 + this.menuSmoothX * 0.42;
      const swayY = Math.cos(elapsed * 0.28) * 0.07 - this.menuSmoothY * 0.16;
      const swayZ = Math.cos(elapsed * 0.24) * 0.16;

      this._menuCamTmp.copy(this.world.menuCamPos).add(new THREE.Vector3(swayX, swayY, swayZ));
      this._menuLookTmp.copy(this.world.menuCamLook).add(
        new THREE.Vector3(this.menuSmoothX * 0.28, -this.menuSmoothY * 0.12, 0),
      );
      this.camera.position.copy(this._menuCamTmp);
      this.camera.lookAt(this._menuLookTmp);
      this.vm.root.visible = false;
    } else {
      if (!this.cutState && !this.player.externalCameraControl) this.vm.root.visible = true;
      this.player.update(dt);

      const activeSwing = this.vm.update(
        dt,
        this.camera,
        this.player.speed,
        this.player.crouch,
        this.player.stepPhase,
        this.player.running,
        this.player.exhausted,
        this.player.strafeInput,
      );

      if (this.mode === 'play' && !this.panel && !this.player.externalCameraControl) {
        if (activeSwing) {
          this.resolveActiveBladeSweep(activeSwing);
        }
        this.updateForaging(dt, elapsed);
        this.physics.update(dt, this.player.pos, this.player.vel, (mat, intensity) => {
          this.audio.bounceProp(mat, intensity);
        });

        const nightAmt = 1 - this.world.daylight;
        const glowBoost = Math.min(1, nightAmt + this.atmosphere.mistBlend * 0.55 + (this.eventId === 'fairy_glow' ? 0.45 : 0));
        const livelyRes = this.livelySystem.update(
          dt,
          this.mushrooms,
          this.coverCandidates,
          this.player.pos,
          this.player.speed,
          this.player.sprintBlend,
          this.player.crouch,
          this.lastStepSurface.primary,
          glowBoost,
          {
            onAlert: () => {
              if (elapsed - this.lastAlertToastAt > 4.5) {
                this.lastAlertToastAt = elapsed;
                this.toast(t(this.lang, 'toastAlert'), 'warn');
              }
            },
            onStartled: () => {
              if (elapsed - this.lastStartleToastAt > 3.5) {
                this.lastStartleToastAt = elapsed;
                this.toast(t(this.lang, 'toastStartledNoise'), 'warn');
              }
            },
            onBurrowStart: () => {
              if (elapsed - this.lastBurrowToastAt > 3.0) {
                this.lastBurrowToastAt = elapsed;
                this.toast(t(this.lang, 'toastBurrowStart'), 'warn');
              }
            },
            onBurrowed: (m) => {
              if (!m.alive || m.pile) return;
              const py = groundHeightAt(m.x, m.z);
              const freshPile = createLeafPile(this.world.leafTex, this.rnd);
              freshPile.position.set(m.x, py - 0.02, m.z);
              freshPile.rotation.y = this.rnd() * 6.28;
              this.mushroomGroup.add(freshPile);
              m.pile = freshPile;
              m.group.visible = false;
              this.physics.emitBurst(new THREE.Vector3(m.x, py + 0.12, m.z), 24, '#a66228', 1.6, 1.7, 4.8);
              this.toast(t(this.lang, 'toastBurrowed'), 'warn');
            },
            onDigParticles: (x, y, z) => {
              this.physics.emitBurst(new THREE.Vector3(x, y, z), 10, '#8d5524', 1.2, 1.3, 5.5);
            },
            onDiscoverFairyRing: () => {
              this.unlockAchievement('fairy_ring');
              this.toast(`✨ ${t(this.lang, 'toastFairyRing')}`, 'good');
            },
          },
        );
        this.chasingLively = livelyRes.chasingAny;

        const onPath = trailDistance(this.player.pos.x, this.player.pos.z) < 2.5;
        const wolfDmg = this.wolves.update(
          dt,
          this.player.pos,
          nightAmt,
          onPath,
          this.eventId === 'wolf_hunt',
          this.atmosphere.mistBlend,
        );
        if (wolfDmg > 0) {
          this.hp -= wolfDmg;
          this.hurtTick++;
          this.audio.hurt();
          this.player.addShake(0.032);
          this.debuffs.bitten = 15;
          if (this.cutState) this.cancelCut();
          if (this.hp <= 0) {
            this.hp = 100;
            void this.endDay(false, t(this.lang, 'toastWolfDefeat'));
          }
        }
        this.hp = Math.min(100, this.hp + dt * 1.2);
        // Idle fatigued breathing when standing still (moving breath is synchronized by GSAP steps)
        if (this.player.exhausted && this.player.speed < 0.45 && Math.random() < dt * 0.9) {
          this.audio.breath();
        }

        // Day warnings
        const hrs = this.timeOfDay * 24;
        if (hrs > 19 && this.warned < 1) {
          this.warned = 1;
          this.toast(t(this.lang, 'toastSunset'), 'warn');
        }
        if (hrs > 20.3 && this.warned < 2) {
          this.warned = 2;
          this.toast(t(this.lang, 'toastNightWarn'), 'bad');
        }
        if (this.timeOfDay >= DAY_END) {
          void this.endDay(this.stallDist < 18);
        }
      }
    }

    // Atmosphere: dynamic weather, campfire flame/sparks/smoke, volumetric sun shafts, rain & fireflies
    this.atmosphere.update(
      dt,
      this.world,
      this.camera.position,
      this.eventId,
      this.mode === 'play' && !this.panel,
      (nextW) => {
        const wLoc = getWeatherLoc(this.lang, nextW);
        this.toast(`${t(this.lang, 'weatherChanged')}: ${wLoc.name} — ${wLoc.hint}`, '');
      },
    );

    this.stallDist = Math.hypot(
      this.player.pos.x - this.world.stallPos.x,
      this.player.pos.z - this.world.stallPos.z,
    );
    const campDist = this.camera.position.distanceTo(this.world.campfirePos);
    const night = 1 - this.world.daylight;
    this.world.stallLantern.intensity = Math.max(night * 6, this.mode === 'menu' ? 4.2 : 0);
    const activeLight = this.flashlightOn && this.mode !== 'menu';
    if (activeLight) {
      const upgraded = Boolean(this.save.up.lamp);
      this.headLamp.color.set(upgraded ? '#fff0cc' : '#ffdfb0');
      this.headLamp.intensity = upgraded ? 30 : 15;
      this.headLamp.distance = upgraded ? 44 : 24;
      this.headLamp.angle = upgraded ? 0.62 : 0.46;
      this.headLamp.penumbra = upgraded ? 0.52 : 0.58;
      this.headLampFill.intensity = upgraded ? 1.55 : 0.72;
      this.headLampFill.distance = upgraded ? 7.5 : 4.8;
    } else {
      this.headLamp.intensity = 0;
      this.headLampFill.intensity = 0;
    }

    // Shadow frustum snap around camera (84m span = -42..42)
    const texel = 84 / this.world.sun.shadow.mapSize.x;
    const sx = Math.round(this.camera.position.x / texel) * texel;
    const sz = Math.round(this.camera.position.z / texel) * texel;
    this.world.sun.target.position.set(sx, this.camera.position.y, sz);
    this.world.sun.position.set(
      sx + this.world.sunDir.x * 90,
      this.camera.position.y + this.world.sunDir.y * 90,
      sz + this.world.sunDir.z * 90,
    );
    this.world.sky.position.copy(this.camera.position);
    this.world.windUniform.value = elapsed;
    this.world.fallingUpdate(elapsed, dt, this.camera);
    this.world.updateCulling(this.camera);
    this.audio.updateAmbience(this.atmosphere.rainBlend, campDist);
    this.audio.tick(dt, night);

    this.renderFrame(dt, elapsed);

    // Throttled HUD updates (~20Hz) so React stays lightweight
    this.hudEmitAccum += dt;
    if (this.hudEmitAccum >= 0.05) {
      this.hudEmitAccum = 0;
      this.emitHud();
    }

    this.scheduleNextFrame();
  }

  private renderFrame(dt: number, elapsed: number) {
    if (this.composer && this.gradePass) {
      this.gradePass.uniforms.uTime.value = elapsed;
      this.gradePass.uniforms.uBlur.value = Math.min(1, this.debuffs.dizzy / 4);
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  public dispose() {
    this.destroyed = true;
    this.introTween?.kill();
    if (this.achievementTimer) clearTimeout(this.achievementTimer);
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    for (const fn of this.cleanupListeners) fn();
    this.atmosphere?.dispose();
    this.player?.dispose();
    this.vm?.dispose();
    this.wolves?.dispose();
    this.livelySystem?.dispose(this.mushrooms);
    this.composer?.dispose();
    this.knifeEnvMap.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.mount) {
      this.mount.removeChild(this.renderer.domElement);
    }
  }
}
