export type Language = 'ru' | 'uk' | 'en';
export type QualityLevel = 'low' | 'medium' | 'high';
export type GameMode = 'loading' | 'menu' | 'play' | 'pause' | 'sleep';
export type PanelType =
  | null
  | 'shop'
  | 'workshop'
  | 'atlas'
  | 'map'
  | 'settings'
  | 'howto'
  | 'dryer'
  | 'dayReport';

export type WeatherKind = 'clear' | 'mist' | 'rain';
export type ForestEventId = 'calm' | 'mushroom_rain' | 'porcini_boom' | 'fairy_glow' | 'wolf_hunt';

export type AchievementId =
  | 'first_porcini'
  | 'perfect_streak'
  | 'catch_runaway'
  | 'fairy_ring'
  | 'wolf_hunter'
  | 'gourmet_dryer'
  | 'golden_legend'
  | 'rain_forager'
  | 'stone_trickster'
  | 'master_collector';

export const ACHIEVEMENT_ORDER: AchievementId[] = [
  'first_porcini',
  'perfect_streak',
  'catch_runaway',
  'fairy_ring',
  'wolf_hunter',
  'gourmet_dryer',
  'golden_legend',
  'rain_forager',
  'stone_trickster',
  'master_collector',
];

export type SpeciesId =
  | 'golden'
  | 'porcini'
  | 'birch'
  | 'chanterelle'
  | 'honey'
  | 'russula'
  | 'puffball'
  | 'flyagaric'
  | 'deathcap';

export type KnifeId = 'folding' | 'hunter' | 'forager' | 'damascus';
export type UpgradeId = 'basket' | 'guide' | 'compass' | 'lamp' | 'boots' | 'dryer' | 'flask';

export interface MushroomSpec {
  id: SpeciesId;
  name: string;
  price: number;
  poison: number; // 0 safe, 1 toxic, 2 deadly
  rarity: number;
  size: number;
  cluster?: [number, number];
  desc: string;
}

export interface KnifeLook {
  blade: 'drop' | 'clip' | 'hook';
  handle: string;
  steel: 'plain' | 'satin' | 'damascus';
  brush?: boolean;
}

export interface KnifeSpec {
  id: KnifeId;
  name: string;
  cost: number;
  tol: number;
  dmg: number;
  speed: number;
  reach: number;
  force: number;
  desc: string;
  look: KnifeLook;
}

export interface UpgradeLevel {
  cost: number;
  cap?: number;
  on?: number;
  charges?: number;
}

export interface UpgradeSpec {
  id: UpgradeId;
  name: string;
  levels: UpgradeLevel[];
  desc: string;
}

export interface OrderItem {
  species: SpeciesId;
  n: number;
  reward: number;
  done: boolean;
  livelyOnly?: boolean;
  label?: string;
}

export interface DriedMushroomSlot {
  id: number;
  species: SpeciesId;
  quality: number;
  count: number;
  lively?: boolean;
  progress: number; // 0..1
}

export interface DaySummary {
  day: number;
  rank: 'S' | 'A' | 'B' | 'C';
  score: number;
  picked: number;
  perfect: number;
  runawaysCaught: number;
  driedCollected: number;
  wolvesSlain: number;
  earned: number;
  nextWeather: WeatherKind;
  nextEvent: ForestEventId;
  note: string | null;
  survived: boolean;
}

export interface SaveData {
  v: number;
  day: number;
  money: number;
  orders: { day: number; list: OrderItem[] } | null;
  knives: KnifeId[];
  knife: KnifeId;
  up: {
    basket: number;
    knife: number;
    guide: number;
    compass: number;
    lamp: number;
    boots: number;
    dryer: number;
    flask: number;
  };
  atlas: Partial<Record<SpeciesId, number>>;
  driedRack: DriedMushroomSlot[];
  achievements: AchievementId[];
  stats: {
    picked: number;
    earned: number;
    perfect: number;
    runaways: number;
    dried: number;
    wolves: number;
    rainPicked: number;
    throws: number;
  };
}

export interface GameSettings {
  lang: Language;
  quality: QualityLevel;
  sens: number;
  vol: number;
  music: number;
}

export interface BasketItem {
  species: SpeciesId;
  quality: number;
  slots: number;
  count: number;
  lively?: boolean;
  dried?: boolean;
}

export interface SellLine {
  species: string;
  name: string;
  n: number | '';
  sum: number;
  poison?: number;
}

export interface SellResult {
  total: number;
  rejected: number;
  lines: SellLine[];
}

export interface ToastMessage {
  id: number;
  text: string;
  tone: '' | 'good' | 'warn' | 'bad';
}

export interface HudSnapshot {
  lang: Language;
  mode: GameMode;
  panel: PanelType;
  loadProgress: number;
  loadMessage: string;
  day: number;
  timeStr: string;
  weather: WeatherKind;
  eventId: ForestEventId;
  basketUsed: number;
  basketCap: number;
  money: number;
  hp: number;
  stamina: number;
  exhausted: boolean;
  combo: number;
  knifeId: KnifeId;
  knifeName: string;
  knifeDirty: number;
  chargeRatio: number;
  swingComboIndex: number;
  compassEnabled: boolean;
  compassAngle: number;
  throwableCount: number;
  throwableMax: number;
  nextThrowableKind: 'stone' | 'stick' | null;
  flaskCharges: number;
  flaskMax: number;
  dryerUsed: number;
  dryerReady: number;
  dryerCap: number;
  flashlightOn: boolean;
  flashlightUpgraded: boolean;
  prompt: { title: string; hint: string; key: string; danger: boolean } | null;
  closeup: {
    active: boolean;
    ky: number;
    ideal: number;
    tol: number;
  };
  debuffs: Array<{ label: string; tone: 'bad' | 'warn' }>;
  orders: OrderItem[];
  hurtTick: number;
  fadeText: string | null;
  hasSave: boolean;
  saveSummary: string;
  muted: boolean;
  chasingLively: boolean;
  daySummary: DaySummary | null;
  achievementBanner: AchievementId | null;
}

export const MUSHROOM_SPECS: Record<SpeciesId, MushroomSpec> = {
  porcini: {
    id: 'porcini',
    name: 'Білий гриб',
    price: 42,
    poison: 0,
    rarity: 0.1,
    size: 1,
    desc: 'Король лісу. Бура щільна шапка, товста світла ніжка з сіточкою, знизу трубочки замість пластинок. Росте під соснами й смереками.',
  },
  birch: {
    id: 'birch',
    name: 'Підберезник',
    price: 18,
    poison: 0,
    rarity: 0.14,
    size: 0.95,
    desc: 'Сіро-бура шапка, висока тонка ніжка з темними лусочками. Шукай під листяними деревами.',
  },
  chanterelle: {
    id: 'chanterelle',
    name: 'Лисичка',
    price: 7,
    poison: 0,
    rarity: 0.2,
    size: 0.55,
    cluster: [3, 7],
    desc: 'Яскраво-жовтогаряча, у формі лійки з хвилястим краєм. Росте гуртом у моху.',
  },
  honey: {
    id: 'honey',
    name: 'Опеньки',
    price: 4,
    poison: 0,
    rarity: 0.16,
    size: 0.45,
    cluster: [5, 11],
    desc: 'Медово-бурі маленькі шапки на тонких ніжках. Ростуть родинами на сухих деревах і біля коріння.',
  },
  russula: {
    id: 'russula',
    name: 'Сироїжка',
    price: 5,
    poison: 0,
    rarity: 0.2,
    size: 0.7,
    desc: 'Плоска яскрава шапка: червона, зелена чи жовта. Біла крихка ніжка. Найчастіший гриб у лісі.',
  },
  puffball: {
    id: 'puffball',
    name: 'Дощовик',
    price: 3,
    poison: 0,
    rarity: 0.08,
    size: 0.6,
    cluster: [1, 3],
    desc: 'Білий круглий гриб без ніжки. Старий випускає хмару спор.',
  },
  flyagaric: {
    id: 'flyagaric',
    name: 'Мухомор червоний',
    price: 0,
    poison: 1,
    rarity: 0.08,
    size: 1,
    desc: 'Червона шапка з білими цятками, кільце на ніжці. Отруйний! Скупник його не візьме.',
  },
  golden: {
    id: 'golden',
    name: 'Золотий гриб',
    price: 260,
    poison: 0,
    rarity: 0.005,
    size: 1.1,
    desc: 'Легендарний гриб, що світиться. Трапляється дуже рідко й лише глибоко в хащах, далеко від стежки.',
  },
  deathcap: {
    id: 'deathcap',
    name: 'Бліда поганка',
    price: 0,
    poison: 2,
    rarity: 0.04,
    size: 0.9,
    desc: 'Блідо-зеленкувата шапка, білі пластинки, кільце й «мішечок» біля основи. Смертельно отруйна! У житті ніколи не їж грибів, яких не знаєш.',
  },
};

export const SPECIES_ORDER: SpeciesId[] = [
  'golden',
  'porcini',
  'birch',
  'chanterelle',
  'honey',
  'russula',
  'puffball',
  'flyagaric',
  'deathcap',
];

export const KNIVES: KnifeSpec[] = [
  {
    id: 'folding',
    name: 'Складаний ніж',
    cost: 0,
    tol: 0.0048,
    dmg: 1,
    speed: 1.05,
    reach: 2.35,
    force: 6.2,
    desc: 'Простий старий ніж із латунним замком. Швидкий взмах, але без запасу точності.',
    look: { blade: 'drop', handle: '#7a4a28', steel: 'plain' },
  },
  {
    id: 'hunter',
    name: 'Мисливський ніж',
    cost: 150,
    tol: 0.0062,
    dmg: 2,
    speed: 0.94,
    reach: 2.65,
    force: 9.8,
    desc: 'Важкий і гострий ніж із гардою. Потужно розбиває ящики й відганяє вовків.',
    look: { blade: 'clip', handle: '#3a2418', steel: 'satin' },
  },
  {
    id: 'forager',
    name: 'Ніж грибника з щіточкою',
    cost: 240,
    tol: 0.0088,
    dmg: 1,
    speed: 1.15,
    reach: 2.3,
    force: 5.5,
    desc: 'Вигнуте серпоподібне лезо для точного зрізу ніжки та щіточка, щоб ніж не бруднився.',
    look: { blade: 'hook', handle: '#c8a060', steel: 'satin', brush: true },
  },
  {
    id: 'damascus',
    name: 'Дамаський ніж',
    cost: 520,
    tol: 0.0098,
    dmg: 3,
    speed: 1.08,
    reach: 2.75,
    force: 11.5,
    desc: 'Кована багатошарова сталь із візерунком. Найточніший зріз і максимальна сила удару.',
    look: { blade: 'drop', handle: '#5a1e14', steel: 'damascus' },
  },
];

export const UPGRADES: UpgradeSpec[] = [
  {
    id: 'basket',
    name: 'Великий кошик',
    levels: [
      { cap: 12, cost: 0 },
      { cap: 20, cost: 120 },
      { cap: 32, cost: 320 },
    ],
    desc: 'Більше місця для грибів.',
  },
  {
    id: 'boots',
    name: 'Чоботи лісника',
    levels: [
      { on: 0, cost: 0 },
      { on: 1, cost: 130 },
      { on: 2, cost: 290 },
    ],
    desc: 'Тихіші кроки й вища витривалість.',
  },
  {
    id: 'dryer',
    name: 'Велика сушарка',
    levels: [
      { cap: 4, cost: 0 },
      { cap: 8, cost: 110 },
      { cap: 14, cost: 260 },
    ],
    desc: 'Більше місць на сушарці біля хатини.',
  },
  {
    id: 'flask',
    name: 'Трав’яний термос',
    levels: [
      { charges: 0, cost: 0 },
      { charges: 2, cost: 95 },
      { charges: 4, cost: 220 },
    ],
    desc: 'Гарячий чай на H, поповнюється біля багаття.',
  },
  {
    id: 'guide',
    name: 'Атлас-визначник',
    levels: [
      { on: 0, cost: 0 },
      { on: 1, cost: 60 },
    ],
    desc: 'Показує назву гриба й попереджає про отруйні.',
  },
  {
    id: 'compass',
    name: 'Компас',
    levels: [
      { on: 0, cost: 0 },
      { on: 1, cost: 80 },
    ],
    desc: 'Стрілка завжди вказує на хатинку скупника.',
  },
  {
    id: 'lamp',
    name: 'Ліхтарик',
    levels: [
      { on: 0, cost: 0 },
      { on: 1, cost: 140 },
    ],
    desc: 'Світло в сутінках і вночі.',
  },
];

export interface CylinderCollider {
  box?: false;
  x: number;
  z: number;
  r: number;
  kind?: 'tree' | 'rock' | 'stall' | 'wagon' | 'fence' | 'campfire' | 'dryer';
  y?: number;
  height?: number;
}

export interface BoxCollider {
  box: true;
  x: number;
  z: number;
  rot: number;
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  r: number;
  kind?: 'hut' | 'furniture';
}

export type WorldCollider = CylinderCollider | BoxCollider;
