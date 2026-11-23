import { useEffect, useRef, useState } from 'react';
import {
  Award,
  CloudFog,
  CloudRain,
  Coffee,
  Flame,
  Flashlight,
  FlashlightOff,
  Sparkles,
  Sun,
  Target,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { GameEngine, loadSettings } from './game/GameEngine';
import {
  getAchievementLoc,
  getEventLoc,
  getKnifeLoc,
  getSpeciesLoc,
  getUpgradeLoc,
  getWeatherLoc,
  t,
} from './game/i18n';
import {
  ACHIEVEMENT_ORDER,
  KNIVES,
  MUSHROOM_SPECS,
  SPECIES_ORDER,
  UPGRADES,
  type GameSettings,
  type HudSnapshot,
  type Language,
  type QualityLevel,
  type SellResult,
  type SpeciesId,
  type ToastMessage,
  type WeatherKind,
} from './game/types';

const INITIAL_SETTINGS = loadSettings();

const INITIAL_HUD: HudSnapshot = {
  lang: INITIAL_SETTINGS.lang,
  mode: 'loading',
  panel: null,
  loadProgress: 4,
  loadMessage: t(INITIAL_SETTINGS.lang, 'loadingWorld'),
  day: 1,
  timeStr: '07:00',
  weather: 'clear',
  eventId: 'calm',
  basketUsed: 0,
  basketCap: 12,
  money: 0,
  hp: 100,
  stamina: 100,
  exhausted: false,
  combo: 0,
  knifeId: 'folding',
  knifeName: getKnifeLoc(INITIAL_SETTINGS.lang, 'folding').name,
  knifeDirty: 0,
  chargeRatio: 0,
  swingComboIndex: 0,
  compassEnabled: false,
  compassAngle: 0,
  throwableCount: 2,
  throwableMax: 3,
  nextThrowableKind: 'stone',
  flaskCharges: 0,
  flaskMax: 0,
  dryerUsed: 0,
  dryerReady: 0,
  dryerCap: 4,
  flashlightOn: false,
  flashlightUpgraded: false,
  prompt: null,
  closeup: { active: false, ky: 0.05, ideal: 0.02, tol: 0.005 },
  debuffs: [],
  orders: [],
  hurtTick: 0,
  fadeText: null,
  hasSave: false,
  saveSummary: '',
  muted: false,
  chasingLively: false,
  daySummary: null,
  achievementBanner: null,
};

function WeatherIcon({ weather, className = 'w-3.5 h-3.5' }: { weather: WeatherKind; className?: string }) {
  if (weather === 'rain') return <CloudRain className={`${className} text-[#8cc4ff]`} />;
  if (weather === 'mist') return <CloudFog className={`${className} text-[#d6cdb8]`} />;
  return <Sun className={`${className} text-[#f3bf55]`} />;
}

function TitleEmblem() {
  return (
    <div className="mb-3 select-none">
      <svg
        viewBox="0 0 420 132"
        className="w-[min(420px,84vw)] h-auto drop-shadow-[0_6px_28px_rgba(0,0,0,0.65)]"
        aria-label="Mushroom Hollow"
      >
        <defs>
          <linearGradient id="mhGold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f8cf70" />
            <stop offset="100%" stopColor="#cf8c2e" />
          </linearGradient>
          <linearGradient id="mhSteel" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#a6b0bc" />
            <stop offset="65%" stopColor="#eef3f8" />
            <stop offset="100%" stopColor="#8d96a1" />
          </linearGradient>
        </defs>
        <g transform="translate(22, 16)">
          <path
            d="M28 42 C28 18, 66 18, 66 42 Z"
            fill="#b4521e"
            stroke="#f1e6cc"
            strokeWidth="1.8"
          />
          <path
            d="M41 42 L39 68 C39 73, 55 73, 55 68 L53 42 Z"
            fill="#e8dcc0"
            stroke="#2b1d12"
            strokeWidth="1.4"
          />
          <circle cx="40" cy="30" r="2.6" fill="#f6eedc" />
          <circle cx="53" cy="28" r="2.2" fill="#f6eedc" />
          <circle cx="47" cy="36" r="1.9" fill="#f6eedc" />
          <path
            d="M8 76 L26 58 L32 64 L14 82 Z"
            fill="#7a4a28"
            stroke="#e7ab3f"
            strokeWidth="1.4"
          />
          <path
            d="M29 61 L64 26 C70 21, 75 23, 73 29 L35 67 Z"
            fill="url(#mhSteel)"
            stroke="#2b1d12"
            strokeWidth="1.2"
          />
        </g>
        <text
          x="108"
          y="64"
          fill="url(#mhGold)"
          fontFamily="Alegreya, Georgia, serif"
          fontWeight="800"
          fontSize="52"
          letterSpacing="0.5"
        >
          Mushroom
        </text>
        <text
          x="108"
          y="112"
          fill="url(#mhGold)"
          fontFamily="Alegreya, Georgia, serif"
          fontWeight="800"
          fontSize="52"
          letterSpacing="0.5"
        >
          Hollow
        </text>
      </svg>
    </div>
  );
}

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [atlasImgs, setAtlasImgs] = useState<Partial<Record<SpeciesId, string>>>({});
  const [sellResult, setSellResult] = useState<SellResult | null>(null);
  const [journalTab, setJournalTab] = useState<'atlas' | 'achievements'>('atlas');
  const [settingsForm, setSettingsForm] = useState<GameSettings>(() => loadSettings());
  const [isTouch, setIsTouch] = useState(false);
  const [touchSprint, setTouchSprint] = useState(false);

  useEffect(() => {
    setIsTouch(window.matchMedia('(pointer: coarse)').matches);
    const mount = mountRef.current;
    if (!mount) return;

    const engine = new GameEngine(mount, {
      onHud: (snap) => setHud(snap),
      onToast: (msg) => {
        setToasts((prev) => [...prev.slice(-3), msg]);
        setTimeout(() => {
          setToasts((prev) => prev.filter((item) => item.id !== msg.id));
        }, 3200);
      },
      onAtlasImages: (imgs) => setAtlasImgs(imgs),
    });
    engineRef.current = engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (hud.panel === 'map' && mapCanvasRef.current && engineRef.current) {
      engineRef.current.renderMapToCanvas(mapCanvasRef.current);
    }
    if (hud.panel !== 'shop') {
      setSellResult(null);
    }
  }, [hud.panel, hud.lang]);

  const eng = engineRef.current;
  const lang = hud.lang;

  const meterTop = (v: number) => `${100 - Math.max(0, Math.min(1, (v + 0.004) / 0.164)) * 100}%`;
  const zoneHeight = `${((2 * hud.closeup.tol) / 0.164) * 100}%`;
  const cutAligned = Math.abs(hud.closeup.ky - hud.closeup.ideal) <= hud.closeup.tol;

  const weatherLoc = getWeatherLoc(lang, hud.weather);
  const eventLoc = getEventLoc(lang, hud.eventId);

  const handleLangSwitch = (nextLang: Language) => {
    eng?.setLanguage(nextLang);
    setSettingsForm((s) => ({ ...s, lang: nextLang }));
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#1b140e]">
      {/* Isolated WebGL canvas mount — React HUD state updates never re-create canvas */}
      <div ref={mountRef} className="fixed inset-0 w-full h-full" />

      {/* LOADING SCREEN */}
      {hud.mode === 'loading' && (
        <div
          className="fixed inset-0 z-50 grid place-items-center"
          style={{ background: 'radial-gradient(ellipse at 50% 40%, #3a2616, #140d08)' }}
        >
          <div className="text-center px-6">
            <h1 className="font-display font-extrabold text-[clamp(44px,8vw,86px)] text-[#e7ab3f] m-0 leading-none">
              Mushroom Hollow
            </h1>
            <div className="w-[min(320px,72vw)] h-1.5 bg-[#3a2a1c] rounded overflow-hidden mx-auto my-5">
              <div
                className="h-full bg-[#e7ab3f] transition-[width] duration-200"
                style={{ width: `${hud.loadProgress}%` }}
              />
            </div>
            <p className="text-xs uppercase tracking-[0.14em] opacity-75">{hud.loadMessage}</p>
          </div>
        </div>
      )}

      {/* CINEMATIC CAMPFIRE MAIN TITLE SCREEN */}
      {hud.mode === 'menu' && (
        <div
          className="fixed inset-0 z-30 flex items-center pl-[max(6vw,24px)] pr-6"
          style={{
            background:
              'linear-gradient(90deg, rgba(16,10,6,0.88) 0%, rgba(16,10,6,0.52) 40%, rgba(16,10,6,0) 74%)',
          }}
        >
          {/* Top-right compact RU / UA switcher & Audio toggle */}
          <div className="fixed top-5 right-6 z-40 flex items-center gap-2">
            <div className="flex rounded-md overflow-hidden border border-[#f1e6cc]/25 bg-[rgba(22,14,9,0.82)] text-xs font-bold">
              <button
                type="button"
                onClick={() => handleLangSwitch('ru')}
                className={`px-2.5 py-1.5 cursor-pointer transition-colors ${
                  lang === 'ru' ? 'bg-[#b4521e] text-[#fff4e4]' : 'text-[#f1e6cc]/75 hover:text-[#f1e6cc]'
                }`}
              >
                RU
              </button>
              <button
                type="button"
                onClick={() => handleLangSwitch('uk')}
                className={`px-2.5 py-1.5 cursor-pointer transition-colors ${
                  lang === 'uk' ? 'bg-[#b4521e] text-[#fff4e4]' : 'text-[#f1e6cc]/75 hover:text-[#f1e6cc]'
                }`}
              >
                UA
              </button>
              <button
                type="button"
                onClick={() => handleLangSwitch('en')}
                className={`px-2.5 py-1.5 cursor-pointer transition-colors ${
                  lang === 'en' ? 'bg-[#b4521e] text-[#fff4e4]' : 'text-[#f1e6cc]/75 hover:text-[#f1e6cc]'
                }`}
              >
                EN
              </button>
            </div>
            <button
              type="button"
              onClick={() => eng?.toggleMute()}
              className="bg-[rgba(22,14,9,0.82)] border border-[#f1e6cc]/25 rounded-md p-2 text-[#f1e6cc] hover:text-[#e7ab3f] cursor-pointer"
              title={hud.muted ? t(lang, 'muteOn') : t(lang, 'muteOff')}
            >
              {hud.muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </div>

          <div className="max-w-[460px]">
            <TitleEmblem />
            <p className="font-display italic text-[22px] text-[#dcc69c] mb-7 mt-0">
              {t(lang, 'subtitle')}
            </p>

            <div className="flex flex-col gap-1">
              {hud.hasSave && (
                <button
                  onClick={() => eng?.continueGame()}
                  className="text-left font-display font-bold text-[30px] text-[#f1e6cc] hover:text-[#e7ab3f] hover:translate-x-2 transition-transform py-1.5 cursor-pointer"
                >
                  {t(lang, 'continue')}{' '}
                  <small className="font-sans text-[13px] font-semibold opacity-65 ml-2">
                    {hud.saveSummary}
                  </small>
                </button>
              )}
              <button
                onClick={() => eng?.startNewGame()}
                className="text-left font-display font-bold text-[30px] text-[#e7ab3f] hover:text-[#ffe08a] hover:translate-x-2 transition-transform py-1.5 cursor-pointer"
              >
                {hud.hasSave ? t(lang, 'newGame') : t(lang, 'startHunt')}
              </button>
              <button
                onClick={() => {
                  setJournalTab('atlas');
                  eng?.openPanel('atlas');
                }}
                className="text-left font-display font-bold text-[25px] text-[#f1e6cc]/85 hover:text-[#e7ab3f] hover:translate-x-2 transition-transform py-1 cursor-pointer"
              >
                {t(lang, 'journal')}
              </button>
              <button
                onClick={() => eng?.openPanel('howto')}
                className="text-left font-display font-bold text-[25px] text-[#f1e6cc]/85 hover:text-[#e7ab3f] hover:translate-x-2 transition-transform py-1 cursor-pointer"
              >
                {t(lang, 'howto')}
              </button>
              <button
                onClick={() => {
                  setSettingsForm(loadSettings());
                  eng?.openPanel('settings');
                }}
                className="text-left font-display font-bold text-[25px] text-[#f1e6cc]/85 hover:text-[#e7ab3f] hover:translate-x-2 transition-transform py-1 cursor-pointer"
              >
                {t(lang, 'settings')}
              </button>
              {(window as any).desktop && (
                <button
                  onClick={() => (window as any).desktop.quit()}
                  className="text-left font-display font-bold text-[25px] text-[#f1e6cc]/70 hover:text-[#e7ab3f] hover:translate-x-2 transition-transform py-1 cursor-pointer"
                >
                  {t(lang, 'quitGame')}
                </button>
              )}
            </div>

            <p className="mt-8 text-[12px] text-[#f1e6cc]/65 leading-relaxed max-w-[410px]">
              {t(lang, 'menuHint')}
            </p>
          </div>
          <div className="fixed bottom-4 right-6 text-[12px] text-[#f1e6cc]/75 bg-[rgba(24,16,10,0.55)] px-2.5 py-1 rounded text-right leading-relaxed">
            Mushroom Hollow v1.1.0 · {t(lang, 'credits')}
          </div>
        </div>
      )}

      {/* ACTIVE GAMEPLAY HUD (solid translucent dark-ink strips, zero backdrop-blur) */}
      {hud.mode === 'play' && !hud.panel && (
        <div className="fixed inset-0 z-10 pointer-events-none">
          {/* Top Perimeter Bar */}
          <div className="absolute top-4 left-4 right-4 flex justify-between items-start gap-3">
            <div className="bg-[rgba(24,16,10,0.78)] border border-[#f1e6cc]/20 rounded-md px-3.5 py-2 text-[13.5px] font-bold flex items-center gap-2.5 tabular-nums">
              <span className="text-[#e7ab3f]">
                {t(lang, 'day')} {hud.day}
              </span>
              <span className="opacity-35">·</span>
              <span>{hud.timeStr}</span>
              <span className="opacity-35">·</span>
              <span className="inline-flex items-center gap-1.5 text-[#ece0c8] font-semibold">
                <WeatherIcon weather={hud.weather} />
                {weatherLoc.name}
              </span>
              <span className="opacity-35 hidden sm:inline">·</span>
              <span className="text-[#dcc69c] font-semibold hidden sm:inline">{hud.knifeName}</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="bg-[rgba(24,16,10,0.78)] border border-[#f1e6cc]/20 rounded-md px-3.5 py-2 text-[13.5px] font-bold flex items-center gap-2.5 tabular-nums">
                <span>
                  {t(lang, 'basket')} {hud.basketUsed}/{hud.basketCap}
                </span>
                <span className="opacity-35">·</span>
                <span className="text-[#e7ab3f]">{hud.money} ₴</span>
              </div>

              <button
                type="button"
                onClick={() => eng?.toggleMute()}
                className="pointer-events-auto bg-[rgba(24,16,10,0.78)] border border-[#f1e6cc]/20 rounded-md p-2 text-[#f1e6cc] hover:text-[#e7ab3f] cursor-pointer"
                title={hud.muted ? t(lang, 'muteOn') : t(lang, 'muteOff')}
              >
                {hud.muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Compass (when unlocked) */}
          {hud.compassEnabled && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full bg-[rgba(24,16,10,0.78)] border border-[#f1e6cc]/25 grid place-items-center">
              <div
                className="w-1 h-5 rounded-full bg-gradient-to-b from-[#e7ab3f] via-[#e7ab3f] to-[#f1e6cc]/30"
                style={{ transform: `rotate(${hud.compassAngle}rad)` }}
              />
            </div>
          )}

          {/* Achievement Unlocked Banner */}
          {hud.achievementBanner && (
            <div className="toast-in absolute top-16 left-1/2 -translate-x-1/2 bg-[rgba(24,16,10,0.9)] border border-[#e7ab3f]/75 rounded-md px-4 py-2.5 flex items-center gap-3 shadow-xl">
              <Award className="w-5 h-5 text-[#f6c85f] shrink-0" />
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#e7ab3f] font-bold">
                  {t(lang, 'achievementUnlocked')}
                </div>
                <div className="font-display font-bold text-[18px] leading-tight text-[#fff4dc]">
                  {getAchievementLoc(lang, hud.achievementBanner).name}
                </div>
              </div>
            </div>
          )}

          {/* Daily Event & Daily Orders */}
          <div className="absolute top-16 right-4 flex flex-col items-end gap-2">
            {hud.eventId !== 'calm' && (
              <div className="bg-[rgba(24,16,10,0.76)] border border-[#e7ab3f]/35 rounded-md px-3 py-1.5 text-right text-[12px]">
                <span className="inline-flex items-center gap-1.5 font-bold text-[#f6c85f]">
                  <Sparkles className="w-3.5 h-3.5" />
                  {eventLoc.name}
                </span>
              </div>
            )}

            {hud.orders.length > 0 && (
              <div className="bg-[rgba(24,16,10,0.74)] border border-[#f1e6cc]/15 rounded-md px-3 py-2 text-right text-[12px] leading-relaxed">
                <div className="font-display font-bold text-[15px] text-[#e7ab3f]">{t(lang, 'orders')}</div>
                {hud.orders.map((o, idx) => (
                  <div
                    key={idx}
                    className={`${o.done ? 'line-through opacity-45' : ''} ${
                      o.livelyOnly ? 'text-[#ffd972] font-semibold mt-0.5 pt-0.5 border-t border-[#f1e6cc]/12' : ''
                    }`}
                  >
                    {o.livelyOnly ? `✨ ${t(lang, 'livelyOrder')}` : getSpeciesLoc(lang, o.species).name} ×{o.n}{' '}
                    <span className="text-[#dcc69c] tabular-nums">+{o.reward} ₴</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Center Crosshair + Heavy Thrust Charge Arc */}
          {!hud.closeup.active && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              <div className="w-1.5 h-1.5 rounded-full bg-[#fff5e1]/85 shadow-[0_0_4px_rgba(0,0,0,0.85)]" />
              {hud.chargeRatio > 0.02 && (
                <svg
                  viewBox="0 0 44 44"
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-11 h-11"
                >
                  <circle
                    cx="22"
                    cy="22"
                    r="16"
                    fill="none"
                    stroke="rgba(255,245,225,0.22)"
                    strokeWidth="2.5"
                  />
                  <circle
                    cx="22"
                    cy="22"
                    r="16"
                    fill="none"
                    stroke={hud.chargeRatio >= 0.85 ? '#ffca58' : '#f1e6cc'}
                    strokeWidth="3"
                    strokeDasharray={`${hud.chargeRatio * 100.5} 100.5`}
                    transform="rotate(-90 22 22)"
                  />
                </svg>
              )}
            </div>
          )}

          {/* Contextual Interaction Prompt */}
          {hud.prompt && (
            <div className="absolute left-1/2 top-[calc(50%+46px)] -translate-x-1/2 text-center drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
              <div
                className={`font-display font-bold text-[24px] leading-tight ${
                  hud.prompt.danger ? 'text-[#ff8a70]' : 'text-[#f1e6cc]'
                }`}
              >
                {hud.prompt.title}
              </div>
              <div className="text-[13px] mt-0.5 text-[#f1e6cc]/90 flex items-center justify-center gap-1.5">
                <kbd className="text-[10px] font-bold border border-[#f1e6cc]/55 rounded px-1.5 py-0.5 bg-[rgba(24,16,10,0.72)]">
                  {hud.prompt.key}
                </kbd>
                <span>{hud.prompt.hint}</span>
              </div>
            </div>
          )}

          {/* Cut Precision Combo Readout */}
          {hud.combo >= 2 && (
            <div className="absolute left-1/2 top-[24%] -translate-x-1/2 font-display font-extrabold text-[22px] text-[#d8ff7a] drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)] tabular-nums">
              {t(lang, 'combo')} ×{(1 + 0.1 * Math.min(hud.combo - 1, 10)).toFixed(1)}
            </div>
          )}

          {/* Toasts */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 w-[min(560px,90vw)] ${
              hud.achievementBanner ? 'top-[132px]' : 'top-[68px]'
            }`}
          >
            {toasts.map((item) => (
              <div
                key={item.id}
                className={`toast-in bg-[rgba(24,16,10,0.84)] border border-[#f1e6cc]/15 rounded-md px-4 py-2 text-[13.5px] font-semibold text-center ${
                  item.tone === 'good'
                    ? 'text-[#d8ff7a]'
                    : item.tone === 'warn'
                      ? 'text-[#e7ab3f]'
                      : item.tone === 'bad'
                        ? 'text-[#ff8a70]'
                        : 'text-[#f1e6cc]'
                }`}
              >
                {item.text}
              </div>
            ))}
          </div>

          {/* Close-Up Precision Cutting Meter */}
          {hud.closeup.active && (
            <>
              <div className="absolute right-10 top-1/4 h-1/2 w-3.5 rounded-full bg-[rgba(24,16,10,0.72)] border border-white/25">
                <div
                  className="absolute -left-1 -right-1 bg-[#9bd24f] rounded"
                  style={{
                    top: meterTop(hud.closeup.ideal + hud.closeup.tol),
                    height: zoneHeight,
                  }}
                />
                <div
                  className={`absolute -left-2.5 -right-2.5 h-1 -mt-0.5 rounded shadow ${
                    cutAligned ? 'bg-[#d8ff7a]' : 'bg-[#f1e6cc]'
                  }`}
                  style={{ top: meterTop(hud.closeup.ky) }}
                />
              </div>
              <div className="absolute bottom-16 left-1/2 -translate-x-1/2 w-[min(640px,90vw)] text-center bg-[rgba(24,16,10,0.84)] border border-[#f1e6cc]/20 px-4 py-2.5 rounded-md text-[13.5px]">
                {t(lang, 'closeupHintPrefix')}{' '}
                <b className="text-[#9bd24f]">{t(lang, 'closeupHintGreen')}</b>{' '}
                {t(lang, 'closeupHintMid')}{' '}
                <kbd className="border border-[#f1e6cc]/45 rounded px-1 text-[11px]">
                  {t(lang, 'keyLmb')}
                </kbd>{' '}
                {t(lang, 'closeupHintEnd')} ·{' '}
                <kbd className="border border-[#f1e6cc]/45 rounded px-1 text-[11px]">
                  {t(lang, 'keyRmb')}
                </kbd>{' '}
                {t(lang, 'closeupCancel')}
              </div>
            </>
          )}

          {/* Debuffs */}
          {hud.debuffs.length > 0 && (
            <div className="absolute bottom-[68px] left-1/2 -translate-x-1/2 flex gap-2 flex-wrap justify-center">
              {hud.debuffs.map((d, idx) => (
                <span
                  key={idx}
                  className={`bg-[rgba(24,16,10,0.82)] border border-[#f1e6cc]/15 rounded px-2.5 py-1 text-[12px] font-bold ${
                    d.tone === 'bad' ? 'text-[#ff9a80]' : 'text-[#e7ab3f]'
                  }`}
                >
                  {d.label}
                </span>
              ))}
            </div>
          )}

          {/* Bottom-Center Vitals + Quick Field Slots (Throwables, Herbal Tea, Dryer Ready) */}
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-end gap-3">
            {/* Throwable pocket slot (Q) */}
            <div className="bg-[rgba(24,16,10,0.78)] border border-[#f1e6cc]/20 rounded-md px-2.5 py-1.5 flex items-center gap-1.5 text-[12px] font-bold tabular-nums">
              <Target className="w-3.5 h-3.5 text-[#dcc69c]" />
              <span>
                {hud.throwableCount}/{hud.throwableMax}
              </span>
              <kbd className="text-[10px] opacity-65 border border-[#f1e6cc]/35 rounded px-1">Q</kbd>
            </div>

            {/* HP & Stamina bars */}
            <div className="w-[min(220px,42vw)] flex flex-col gap-1.5 pb-0.5">
              <div className="h-1.5 rounded bg-black/60 overflow-hidden">
                <div
                  className="h-full bg-[#c8442c] transition-[width] duration-150"
                  style={{ width: `${hud.hp}%` }}
                />
              </div>
              <div className="h-1.5 rounded bg-black/60 overflow-hidden">
                <div
                  className="h-full bg-[#e2c77a] transition-[width] duration-150"
                  style={{ width: `${hud.stamina}%` }}
                />
              </div>
            </div>

            {/* Herbal Tea Flask slot (H) if unlocked */}
            {hud.flaskMax > 0 && (
              <div className="bg-[rgba(24,16,10,0.78)] border border-[#f1e6cc]/20 rounded-md px-2.5 py-1.5 flex items-center gap-1.5 text-[12px] font-bold tabular-nums">
                <Coffee className={`w-3.5 h-3.5 ${hud.flaskCharges > 0 ? 'text-[#9bd24f]' : 'opacity-40'}`} />
                <span>
                  {hud.flaskCharges}/{hud.flaskMax}
                </span>
                <kbd className="text-[10px] opacity-65 border border-[#f1e6cc]/35 rounded px-1">H</kbd>
              </div>
            )}

            {/* Flashlight toggle slot (L) */}
            <button
              type="button"
              onClick={() => eng?.toggleFlashlight()}
              className={`pointer-events-auto rounded-md px-2.5 py-1.5 flex items-center gap-1.5 text-[12px] font-bold border cursor-pointer transition-colors ${
                hud.flashlightOn
                  ? 'bg-[rgba(54,36,16,0.88)] border-[#f3c356]/70 text-[#ffe08a]'
                  : 'bg-[rgba(24,16,10,0.78)] border-[#f1e6cc]/20 text-[#f1e6cc]/70 hover:text-[#f1e6cc]'
              }`}
              title={t(lang, 'slotLight')}
            >
              {hud.flashlightOn ? (
                <Flashlight className="w-3.5 h-3.5 text-[#ffd86b]" />
              ) : (
                <FlashlightOff className="w-3.5 h-3.5 opacity-65" />
              )}
              <kbd className="text-[10px] opacity-80 border border-current/40 rounded px-1">L</kbd>
            </button>

            {/* Ready dried mushrooms alert */}
            {hud.dryerReady > 0 && (
              <div className="bg-[rgba(24,16,10,0.78)] border border-[#e7ab3f]/45 rounded-md px-2.5 py-1.5 flex items-center gap-1.5 text-[12px] font-bold text-[#f6c85f] tabular-nums">
                <Flame className="w-3.5 h-3.5" />
                <span>+{hud.dryerReady}</span>
              </div>
            )}
          </div>

          {/* Subtle Bottom-Right Control Hint */}
          {!isTouch && !hud.closeup.active && (
            <div className="absolute bottom-4 right-4 text-[11px] text-[#f1e6cc]/62 text-right leading-relaxed max-w-[36vw] hidden lg:block">
              <div>
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">WASD</kbd> ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">Shift</kbd> ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">C</kbd> ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">G</kbd>/
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">Q</kbd> {t(lang, 'slotThrow')}
              </div>
              <div>
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">{t(lang, 'keyLmb')}</kbd> ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">{t(lang, 'keyRmb')}</kbd>/
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">F</kbd> ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">R</kbd> ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">L</kbd> {t(lang, 'slotLight')} ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">E</kbd> ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">M</kbd> ·{' '}
                <kbd className="border border-[#f1e6cc]/35 rounded px-1 text-[10px]">Tab</kbd>
              </div>
            </div>
          )}

          {/* Touch Controls on Coarse Pointer Devices */}
          {isTouch && (
            <div className="fixed inset-0 pointer-events-none">
              <button
                type="button"
                onPointerDown={() => eng?.touchAction()}
                onPointerUp={() => eng?.touchActionUp()}
                className="pointer-events-auto absolute right-5 bottom-24 w-16 h-16 rounded-full bg-[#b4521e]/85 border border-[#f1e6cc]/35 font-bold text-xs text-[#fff4e4]"
              >
                {t(lang, 'touchAct')}
              </button>
              <button
                type="button"
                onPointerDown={() => eng?.touchSlash()}
                className="pointer-events-auto absolute right-24 bottom-12 w-16 h-16 rounded-full bg-[rgba(24,16,10,0.84)] border border-[#e7ab3f]/60 font-bold text-xs text-[#e7ab3f]"
              >
                {t(lang, 'touchSlash')}
              </button>
              <button
                type="button"
                onPointerDown={() => eng?.touchThrow()}
                className="pointer-events-auto absolute right-24 bottom-32 w-14 h-14 rounded-full bg-[rgba(24,16,10,0.82)] border border-[#f1e6cc]/30 font-bold text-[11px] text-[#f1e6cc]"
              >
                {t(lang, 'touchThrow')}
              </button>
              {hud.flaskMax > 0 && (
                <button
                  type="button"
                  onPointerDown={() => eng?.touchTea()}
                  className="pointer-events-auto absolute right-5 bottom-44 w-14 h-14 rounded-full bg-[rgba(24,16,10,0.82)] border border-[#9bd24f]/55 font-bold text-[11px] text-[#d8ff7a]"
                >
                  {t(lang, 'touchTea')}
                </button>
              )}
              <button
                type="button"
                onPointerDown={() => eng?.touchFlashlight()}
                className={`pointer-events-auto absolute right-24 bottom-48 w-14 h-14 rounded-full border font-bold text-[11px] ${
                  hud.flashlightOn
                    ? 'bg-[#b4741e]/90 border-[#ffe08a] text-[#fff8e0]'
                    : 'bg-[rgba(24,16,10,0.82)] border-[#f1e6cc]/30 text-[#f1e6cc]'
                }`}
              >
                {t(lang, 'touchLight')}
              </button>
              <button
                type="button"
                onPointerDown={() => setTouchSprint(Boolean(eng?.toggleTouchSprint()))}
                className={`pointer-events-auto absolute right-5 bottom-6 w-14 h-14 rounded-full border border-[#f1e6cc]/30 font-bold text-xs ${
                  touchSprint ? 'bg-[#b4521e]/85' : 'bg-[rgba(24,16,10,0.78)]'
                }`}
              >
                {t(lang, 'touchRun')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* DAMAGE VIGNETTE */}
      {hud.hurtTick > 0 && (
        <div
          key={hud.hurtTick}
          className="hurt-flash fixed inset-0 z-20 pointer-events-none"
          style={{ boxShadow: 'inset 0 0 150px rgba(200, 22, 12, 0.85)' }}
        />
      )}

      {/* DAY/NIGHT FADE OVERLAY */}
      {hud.fadeText && (
        <div className="fixed inset-0 z-40 bg-[#0c0806] grid place-items-center px-6">
          <div className="font-display text-[32px] text-[#dcc69c] text-center max-w-xl">
            {hud.fadeText}
          </div>
        </div>
      )}

      {/* PAUSE MODAL */}
      {hud.mode === 'pause' && !hud.panel && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(14,9,5,0.68)] p-4">
          <div className="paper-sheet rounded-md p-7 w-[min(380px,100%)] shadow-2xl">
            <h2 className="font-display font-extrabold text-[34px] m-0 mb-3 text-[#2b1d12]">
              {t(lang, 'pause')}
            </h2>
            <div className="flex flex-col gap-1">
              <button
                onClick={() => eng?.resumeGame()}
                className="text-left font-display font-bold text-[24px] py-1.5 text-[#2b1d12] hover:text-[#b4521e] cursor-pointer"
              >
                {t(lang, 'resume')}
              </button>
              <button
                onClick={() => eng?.openPanel('atlas')}
                className="text-left font-display font-bold text-[24px] py-1.5 text-[#2b1d12] hover:text-[#b4521e] cursor-pointer"
              >
                {t(lang, 'journal')}
              </button>
              <button
                onClick={() => {
                  setSettingsForm(loadSettings());
                  eng?.openPanel('settings');
                }}
                className="text-left font-display font-bold text-[24px] py-1.5 text-[#2b1d12] hover:text-[#b4521e] cursor-pointer"
              >
                {t(lang, 'settings')}
              </button>
              <button
                onClick={() => eng?.returnToMenu()}
                className="text-left font-display font-bold text-[24px] py-1.5 text-[#2b1d12] hover:text-[#b4521e] cursor-pointer"
              >
                {t(lang, 'mainMenu')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MUSHROOM DRYING RACK MODAL */}
      {hud.panel === 'dryer' && eng && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(14,9,5,0.68)] p-4">
          <div className="paper-sheet rounded-md w-[min(860px,100%)] max-h-[88vh] overflow-auto shadow-2xl relative">
            <button
              onClick={() => eng.closePanel()}
              aria-label={t(lang, 'close')}
              className="absolute top-3 right-4 text-[28px] leading-none text-[#2b1d12]/65 hover:text-[#2b1d12] cursor-pointer"
            >
              ×
            </button>
            <div className="flex justify-between items-baseline px-7 pt-5 pb-2 border-b-2 border-dashed border-[#2b1d12]/20 pr-12">
              <h2 className="font-display font-extrabold text-[34px] m-0">{t(lang, 'dryerTitle')}</h2>
              <span className="font-bold text-[15px] tabular-nums opacity-75">
                {t(lang, 'dryerSlots')}: {hud.dryerUsed}/{hud.dryerCap}
              </span>
            </div>

            <div className="grid md:grid-cols-2 gap-7 p-6">
              {/* Left: Hanging Slots */}
              <section>
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-display font-bold text-[22px] m-0">{t(lang, 'dryerTitle')}</h3>
                  {hud.dryerReady > 0 && (
                    <button
                      onClick={() => eng.collectReadyDried()}
                      className="px-3.5 py-1.5 rounded-md bg-[#5d6b2f] text-[#fff8ea] text-xs font-bold hover:bg-[#4e5b25] cursor-pointer"
                    >
                      {t(lang, 'dryerCollectAll')} ({hud.dryerReady})
                    </button>
                  )}
                </div>

                {eng.save.driedRack.length === 0 ? (
                  <p className="text-sm opacity-75 leading-relaxed">{t(lang, 'dryerEmpty')}</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {eng.save.driedRack.map((slot) => {
                      const ready = slot.progress >= 1;
                      const pct = Math.min(100, Math.round(slot.progress * 100));
                      return (
                        <div
                          key={slot.id}
                          className={`p-2.5 rounded-md border ${
                            ready
                              ? 'border-[#5d6b2f]/60 bg-[#5d6b2f]/10'
                              : 'border-[#2b1d12]/15 bg-white/40'
                          }`}
                        >
                          <div className="flex justify-between text-sm font-bold">
                            <span>
                              {getSpeciesLoc(lang, slot.species).name}
                              {slot.count > 1 ? ` ×${slot.count}` : ''}
                            </span>
                            <span className={`tabular-nums text-xs ${ready ? 'text-[#5d6b2f]' : 'opacity-70'}`}>
                              {ready ? t(lang, 'dryerReady') : `${t(lang, 'dryerDrying')} ${pct}%`}
                            </span>
                          </div>
                          <div className="h-1.5 mt-1.5 rounded bg-[#2b1d12]/12 overflow-hidden">
                            <div
                              className={`h-full transition-[width] duration-200 ${
                                ready ? 'bg-[#5d6b2f]' : 'bg-[#b4521e]'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Right: Fresh Edible Basket Items */}
              <section>
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-display font-bold text-[22px] m-0">{t(lang, 'inBasket')}</h3>
                  {eng.basket.some((b) => !b.dried && MUSHROOM_SPECS[b.species].poison === 0) && (
                    <button
                      onClick={() => eng.hangAllEdibleOnDryer()}
                      disabled={hud.dryerUsed >= hud.dryerCap}
                      className="px-3.5 py-1.5 rounded-md bg-[#b4521e] text-[#fff4e4] text-xs font-bold hover:bg-[#9c4215] disabled:opacity-40 cursor-pointer"
                    >
                      {t(lang, 'dryerHangAll')}
                    </button>
                  )}
                </div>

                {eng.basket.filter((b) => !b.dried && MUSHROOM_SPECS[b.species].poison === 0).length === 0 ? (
                  <p className="text-sm opacity-75 leading-relaxed">{t(lang, 'dryerNoEdible')}</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {eng.basket.map((item, idx) => {
                      if (item.dried || MUSHROOM_SPECS[item.species].poison > 0) return null;
                      return (
                        <div
                          key={idx}
                          className="flex justify-between items-center gap-2 p-2.5 rounded-md border border-[#2b1d12]/15 bg-white/40 text-sm"
                        >
                          <div>
                            <span className="font-bold">
                              {getSpeciesLoc(lang, item.species).name}
                              {item.count > 1 ? ` ×${item.count}` : ''}
                            </span>
                            <span className="ml-2 text-xs opacity-65 tabular-nums">
                              {Math.round(item.quality * 100)}%
                            </span>
                          </div>
                          <button
                            disabled={hud.dryerUsed >= hud.dryerCap}
                            onClick={() => eng.hangMushroomOnDryer(idx)}
                            className="px-3 py-1 rounded bg-[#dcc69c] border border-[#2b1d12]/30 text-xs font-bold hover:bg-[#d1b480] disabled:opacity-40 cursor-pointer"
                          >
                            {t(lang, 'dryerHangOne')}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}

      {/* END-OF-DAY SUMMARY REPORT MODAL */}
      {hud.panel === 'dayReport' && hud.daySummary && eng && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(12,8,5,0.82)] p-4">
          <div className="paper-sheet rounded-md w-[min(560px,100%)] p-7 shadow-2xl">
            <div className="flex justify-between items-center pb-4 border-b-2 border-dashed border-[#2b1d12]/20">
              <div>
                <div className="text-xs uppercase tracking-[0.14em] font-bold opacity-65">
                  {t(lang, 'day')} {hud.daySummary.day}
                </div>
                <h2 className="font-display font-extrabold text-[36px] leading-none m-0 mt-1">
                  {t(lang, 'dayReportTitle')}
                </h2>
              </div>
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-[0.12em] font-bold opacity-65 mb-1">
                  {t(lang, 'dayRankLabel')}
                </div>
                <div
                  className={`w-16 h-16 rounded-full border-4 grid place-items-center font-display font-extrabold text-[38px] leading-none ${
                    hud.daySummary.rank === 'S'
                      ? 'border-[#b4521e] text-[#b4521e] bg-[#e7ab3f]/25'
                      : hud.daySummary.rank === 'A'
                        ? 'border-[#5d6b2f] text-[#5d6b2f] bg-[#5d6b2f]/12'
                        : 'border-[#2b1d12]/55 text-[#2b1d12]'
                  }`}
                >
                  {hud.daySummary.rank}
                </div>
              </div>
            </div>

            {hud.daySummary.note && (
              <p className="mt-4 mb-0 p-3 rounded bg-[#a3261b]/12 border border-[#a3261b]/30 text-sm text-[#7a1b12] font-semibold">
                {hud.daySummary.note}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 my-5 text-sm">
              <div className="p-3 rounded bg-white/40 border border-[#2b1d12]/15">
                <div className="text-xs opacity-70">{t(lang, 'statPicked')}</div>
                <div className="font-display font-extrabold text-[24px] tabular-nums">
                  {hud.daySummary.picked}
                </div>
              </div>
              <div className="p-3 rounded bg-white/40 border border-[#2b1d12]/15">
                <div className="text-xs opacity-70">{t(lang, 'statPerfect')}</div>
                <div className="font-display font-extrabold text-[24px] tabular-nums">
                  {hud.daySummary.perfect}
                </div>
              </div>
              <div className="p-3 rounded bg-white/40 border border-[#2b1d12]/15">
                <div className="text-xs opacity-70">{t(lang, 'statRunaways')}</div>
                <div className="font-display font-extrabold text-[24px] tabular-nums text-[#b4521e]">
                  {hud.daySummary.runawaysCaught}
                </div>
              </div>
              <div className="p-3 rounded bg-white/40 border border-[#2b1d12]/15">
                <div className="text-xs opacity-70">{t(lang, 'statDried')}</div>
                <div className="font-display font-extrabold text-[24px] tabular-nums">
                  {hud.daySummary.driedCollected}
                </div>
              </div>
              <div className="p-3 rounded bg-white/40 border border-[#2b1d12]/15">
                <div className="text-xs opacity-70">{t(lang, 'statWolves')}</div>
                <div className="font-display font-extrabold text-[24px] tabular-nums">
                  {hud.daySummary.wolvesSlain}
                </div>
              </div>
              <div className="p-3 rounded bg-[#5d6b2f]/12 border border-[#5d6b2f]/30">
                <div className="text-xs opacity-75">{t(lang, 'statEarned')}</div>
                <div className="font-display font-extrabold text-[24px] tabular-nums text-[#47571d]">
                  +{hud.daySummary.earned} ₴
                </div>
              </div>
            </div>

            <div className="p-3.5 rounded-md bg-[#2b1d12]/8 border border-[#2b1d12]/15 mb-5 text-sm">
              <div className="text-xs uppercase tracking-[0.12em] font-bold opacity-65 mb-1">
                {t(lang, 'tomorrowForecast')}
              </div>
              <div className="font-bold flex items-center gap-2">
                <WeatherIcon weather={hud.daySummary.nextWeather} className="w-4 h-4" />
                <span>{getWeatherLoc(lang, hud.daySummary.nextWeather).name}</span>
                <span className="opacity-40">·</span>
                <span className="text-[#8f3f14]">{getEventLoc(lang, hud.daySummary.nextEvent).name}</span>
              </div>
              <div className="text-xs opacity-75 mt-1">
                {getEventLoc(lang, hud.daySummary.nextEvent).desc}
              </div>
            </div>

            <button
              onClick={() => eng.startNextDayFromReport()}
              className="w-full py-3 rounded-md bg-[#b4521e] text-[#fff4e4] font-bold text-[16px] hover:bg-[#9c4215] cursor-pointer"
            >
              {t(lang, 'wakeUpNextDay')} → {t(lang, 'day')} {hud.daySummary.day + 1}
            </button>
          </div>
        </div>
      )}

      {/* SHOP & WORKSHOP PANEL */}
      {(hud.panel === 'shop' || hud.panel === 'workshop') && eng && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(14,9,5,0.68)] p-4">
          <div className="paper-sheet rounded-md w-[min(900px,100%)] max-h-[88vh] overflow-auto shadow-2xl relative">
            <button
              onClick={() => eng.closePanel()}
              aria-label={t(lang, 'close')}
              className="absolute top-3 right-4 text-[28px] leading-none text-[#2b1d12]/65 hover:text-[#2b1d12] cursor-pointer"
            >
              ×
            </button>
            <div className="flex justify-between items-baseline px-7 pt-5 pb-2 border-b-2 border-dashed border-[#2b1d12]/20 pr-12">
              <h2 className="font-display font-extrabold text-[34px] m-0">
                {hud.panel === 'shop' ? t(lang, 'shopTitle') : t(lang, 'workshopTitle')}
              </h2>
              <span className="font-bold text-[17px] tabular-nums">{hud.money} ₴</span>
            </div>

            {hud.panel === 'shop' ? (
              <div className="grid md:grid-cols-[1fr_1.15fr] gap-7 p-6">
                <section>
                  <h3 className="font-display font-bold text-[22px] mb-2.5">{t(lang, 'inBasket')}</h3>
                  {eng.basket.length > 0 || eng.fangs > 0 ? (
                    <>
                      <ul className="list-none p-0 m-0 mb-4 text-sm">
                        {eng.basket.map((item, idx) => (
                          <li
                            key={idx}
                            className="flex justify-between py-1.5 border-b border-[#2b1d12]/15"
                          >
                            <span>
                              {getSpeciesLoc(lang, item.species).name}
                              {item.count > 1 ? ` ×${item.count}` : ''}
                              {item.dried && (
                                <span className="ml-1.5 text-[11px] font-bold text-[#8f3f14]">
                                  ({t(lang, 'driedTag')})
                                </span>
                              )}
                              {item.lively && (
                                <span className="ml-1.5 text-[11px] font-bold text-[#a86a12]">
                                  ✨ {t(lang, 'livelyTag')}
                                </span>
                              )}
                            </span>
                            <span className="opacity-70 tabular-nums">
                              {Math.round(item.quality * 100)}%
                            </span>
                          </li>
                        ))}
                        {eng.fangs > 0 && (
                          <li className="flex justify-between py-1.5 border-b border-[#2b1d12]/15">
                            <span>
                              {t(lang, 'wolfFangs')} ×{eng.fangs}
                            </span>
                            <span className="font-bold tabular-nums">{eng.fangs * eng.fangValue} ₴</span>
                          </li>
                        )}
                      </ul>
                      <button
                        onClick={() => setSellResult(eng.sellBasket())}
                        className="w-full py-3 rounded-md bg-[#b4521e] text-[#fff4e4] font-bold hover:bg-[#9c4215] cursor-pointer"
                      >
                        {t(lang, 'sellAll')}
                      </button>
                    </>
                  ) : (
                    <p className="text-sm opacity-75 leading-relaxed">{t(lang, 'emptyBasket')}</p>
                  )}

                  {sellResult && (
                    <div className="mt-4 bg-[#5d6b2f]/15 rounded-md p-3.5">
                      <div className="font-display font-extrabold text-[30px] text-[#5d6b2f] tabular-nums">
                        +{sellResult.total} ₴
                      </div>
                      {sellResult.lines.map((ln, idx) => (
                        <div
                          key={idx}
                          className={`flex justify-between text-sm py-0.5 ${
                            ln.poison ? 'text-[#a3261b]' : ''
                          }`}
                        >
                          <span>
                            {ln.name}
                            {ln.n !== '' ? ` ×${ln.n}` : ''}
                          </span>
                          <span className="tabular-nums">
                            {ln.poison ? t(lang, 'poisonLabel') : `+${ln.sum} ₴`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section>
                  <h3 className="font-display font-bold text-[22px] mb-2.5">{t(lang, 'buyerTipTitle')}</h3>
                  <p className="text-sm opacity-80 leading-relaxed mb-4">{t(lang, 'buyerTip1')}</p>
                  <p className="text-sm opacity-80 leading-relaxed">{t(lang, 'buyerTip2')}</p>
                </section>
              </div>
            ) : (
              <div className="grid md:grid-cols-[1.05fr_1.15fr] gap-7 p-6">
                <section>
                  <h3 className="font-display font-bold text-[22px] mb-2.5">{t(lang, 'knives')}</h3>
                  <div className="flex flex-col gap-2.5">
                    {KNIVES.map((k) => {
                      const owned = eng.save.knives.includes(k.id);
                      const equipped = eng.save.knife === k.id;
                      const kLoc = getKnifeLoc(lang, k.id);
                      return (
                        <div
                          key={k.id}
                          className={`flex justify-between items-center gap-3 p-3 rounded-md border ${
                            equipped
                              ? 'border-[#b4521e] bg-[#b4521e]/10'
                              : 'border-[#2b1d12]/15 bg-white/35'
                          }`}
                        >
                          <div>
                            <div className="font-bold text-[15px]">
                              {kLoc.name}{' '}
                              <span className="text-xs font-normal opacity-65 ml-1">
                                {t(lang, 'precision')} {'●'.repeat(Math.round(k.tol / 0.002))} ·{' '}
                                {t(lang, 'power')} {k.dmg}
                              </span>
                            </div>
                            <p className="text-xs opacity-75 m-0 mt-1 leading-snug">{kLoc.desc}</p>
                          </div>
                          {equipped ? (
                            <span className="font-bold text-sm text-[#5d6b2f] shrink-0">
                              {t(lang, 'equipped')}
                            </span>
                          ) : (
                            <button
                              disabled={!owned && hud.money < k.cost}
                              onClick={() => eng.equipOrBuyKnife(k.id)}
                              className="px-3.5 py-2 rounded-md bg-[#dcc69c] border border-[#2b1d12]/30 font-bold text-sm shrink-0 disabled:opacity-40 hover:bg-[#d1b480] cursor-pointer disabled:cursor-default tabular-nums"
                            >
                              {owned ? t(lang, 'take') : `${k.cost} ₴`}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <h3 className="font-display font-bold text-[22px] mb-2.5">{t(lang, 'equipment')}</h3>
                  <div className="flex flex-col gap-2">
                    {UPGRADES.map((u) => {
                      const lvl = eng.save.up[u.id];
                      const next = u.levels[lvl + 1];
                      const uLoc = getUpgradeLoc(lang, u.id);
                      return (
                        <div
                          key={u.id}
                          className="flex justify-between items-center gap-3 p-2.5 rounded-md border border-[#2b1d12]/15 bg-white/35"
                        >
                          <div>
                            <div className="font-bold text-[14.5px]">
                              {uLoc.name}
                              {u.levels.length > 2 && (
                                <span className="text-xs opacity-60 ml-1.5 tabular-nums">
                                  {lvl}/{u.levels.length - 1}
                                </span>
                              )}
                            </div>
                            <p className="text-xs opacity-75 m-0 mt-0.5 leading-snug">{uLoc.desc}</p>
                          </div>
                          {!next ? (
                            <span className="font-bold text-sm text-[#5d6b2f] shrink-0">
                              {t(lang, 'owned')}
                            </span>
                          ) : (
                            <button
                              disabled={hud.money < next.cost}
                              onClick={() => eng.buyUpgrade(u.id)}
                              className="px-3 py-1.5 rounded-md bg-[#dcc69c] border border-[#2b1d12]/30 font-bold text-sm shrink-0 disabled:opacity-40 hover:bg-[#d1b480] cursor-pointer disabled:cursor-default tabular-nums"
                            >
                              {next.cost} ₴
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => eng.sleepToMorning()}
                    className="w-full mt-4 py-2.5 rounded-md bg-[#dcc69c] border border-[#2b1d12]/30 font-bold text-sm hover:bg-[#d1b480] cursor-pointer"
                  >
                    {t(lang, 'sleepUntilMorning')}
                  </button>
                </section>
              </div>
            )}
          </div>
        </div>
      )}

      {/* FIELD JOURNAL: MUSHROOM ATLAS + ACHIEVEMENTS */}
      {hud.panel === 'atlas' && eng && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(14,9,5,0.68)] p-4">
          <div className="paper-sheet rounded-md w-[min(900px,100%)] max-h-[88vh] overflow-auto shadow-2xl relative">
            <button
              onClick={() => eng.closePanel()}
              aria-label={t(lang, 'close')}
              className="absolute top-3 right-4 text-[28px] leading-none text-[#2b1d12]/65 hover:text-[#2b1d12] cursor-pointer"
            >
              ×
            </button>
            <div className="flex flex-wrap justify-between items-end gap-3 px-7 pt-5 pb-3 border-b-2 border-dashed border-[#2b1d12]/20 pr-12">
              <div>
                <h2 className="font-display font-extrabold text-[34px] leading-none m-0">
                  {t(lang, 'journal')}
                </h2>
                <span className="text-xs font-semibold opacity-65">{t(lang, 'journalSubtitle')}</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setJournalTab('atlas')}
                  className={`px-3.5 py-1.5 rounded text-sm font-bold cursor-pointer ${
                    journalTab === 'atlas'
                      ? 'bg-[#b4521e] text-[#fff4e4]'
                      : 'bg-[#2b1d12]/10 text-[#2b1d12] hover:bg-[#2b1d12]/18'
                  }`}
                >
                  {t(lang, 'atlasTab')}
                </button>
                <button
                  onClick={() => setJournalTab('achievements')}
                  className={`px-3.5 py-1.5 rounded text-sm font-bold cursor-pointer tabular-nums ${
                    journalTab === 'achievements'
                      ? 'bg-[#b4521e] text-[#fff4e4]'
                      : 'bg-[#2b1d12]/10 text-[#2b1d12] hover:bg-[#2b1d12]/18'
                  }`}
                >
                  {t(lang, 'achievementsTab')} ({eng.save.achievements.length}/{ACHIEVEMENT_ORDER.length})
                </button>
              </div>
            </div>

            {journalTab === 'atlas' ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(185px,1fr))] gap-3.5 p-6">
                {SPECIES_ORDER.map((sp) => {
                  const spec = MUSHROOM_SPECS[sp];
                  const spLoc = getSpeciesLoc(lang, sp);
                  const found = eng.save.atlas[sp] || 0;
                  const known = found > 0 || Boolean(eng.save.up.guide);
                  const img = atlasImgs[sp];
                  return (
                    <div
                      key={sp}
                      className={`rounded-md border p-3 bg-white/40 ${
                        known && spec.poison ? 'border-[#a3261b]/55' : 'border-[#2b1d12]/20'
                      }`}
                    >
                      <div
                        className="h-28 rounded bg-[#e4d5b4] bg-center bg-contain bg-no-repeat"
                        style={{
                          backgroundImage: img ? `url(${img})` : undefined,
                          filter: known ? undefined : 'brightness(0) opacity(0.26)',
                        }}
                      />
                      <h4 className="font-display font-bold text-[20px] mt-2 mb-1">
                        {known ? spLoc.name : '???'}
                      </h4>
                      <p className="text-xs leading-snug opacity-80 m-0 mb-2">
                        {known ? spLoc.desc : t(lang, 'unknownDesc')}
                      </p>
                      {known && (
                        <div className="flex flex-wrap gap-1.5 text-[11px] font-bold">
                          {spec.poison ? (
                            <span className="px-2 py-0.5 rounded bg-[#a3261b] text-white">
                              {t(lang, 'poisonBadge')}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded bg-[#2b1d12]/10 tabular-nums">
                              {spec.price} ₴
                            </span>
                          )}
                          <span className="px-2 py-0.5 rounded bg-[#2b1d12]/10 tabular-nums">
                            {t(lang, 'collected')}: {found}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-3 p-6">
                {ACHIEVEMENT_ORDER.map((id) => {
                  const unlocked = eng.save.achievements.includes(id);
                  const loc = getAchievementLoc(lang, id);
                  return (
                    <div
                      key={id}
                      className={`flex items-start gap-3 p-3.5 rounded-md border ${
                        unlocked
                          ? 'border-[#b4521e]/55 bg-[#e7ab3f]/15'
                          : 'border-[#2b1d12]/15 bg-white/25 opacity-60'
                      }`}
                    >
                      <div
                        className={`w-9 h-9 rounded-full grid place-items-center shrink-0 ${
                          unlocked ? 'bg-[#b4521e] text-[#fff4e4]' : 'bg-[#2b1d12]/12 text-[#2b1d12]/50'
                        }`}
                      >
                        <Award className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="font-display font-bold text-[19px] leading-tight">
                          {loc.name}
                        </div>
                        <p className="text-xs opacity-80 m-0 mt-1 leading-snug">{loc.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* FOREST MAP PANEL */}
      {hud.panel === 'map' && eng && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(14,9,5,0.68)] p-4">
          <div className="paper-sheet rounded-md w-[min(620px,100%)] shadow-2xl relative">
            <button
              onClick={() => eng.closePanel()}
              aria-label={t(lang, 'close')}
              className="absolute top-3 right-4 text-[28px] leading-none text-[#2b1d12]/65 hover:text-[#2b1d12] cursor-pointer"
            >
              ×
            </button>
            <div className="flex justify-between items-baseline px-7 pt-5 pb-2 border-b-2 border-dashed border-[#2b1d12]/20 pr-12">
              <h2 className="font-display font-extrabold text-[34px] m-0">{t(lang, 'mapTitle')}</h2>
              <span className="text-xs font-semibold opacity-70">{t(lang, 'mapLegend')}</span>
            </div>
            <div className="p-5">
              <canvas
                ref={mapCanvasRef}
                width={560}
                height={560}
                className="w-full rounded border border-[#2b1d12]/20 block"
              />
            </div>
          </div>
        </div>
      )}

      {/* SETTINGS PANEL */}
      {hud.panel === 'settings' && eng && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(14,9,5,0.68)] p-4">
          <div className="paper-sheet rounded-md p-7 w-[min(420px,100%)] shadow-2xl">
            <h2 className="font-display font-extrabold text-[32px] m-0 mb-4">
              {t(lang, 'settingsTitle')}
            </h2>
            <div className="space-y-4 text-sm">
              <div className="flex justify-between items-center">
                <label className="font-semibold">{t(lang, 'languageLabel')}</label>
                <div className="flex rounded overflow-hidden border border-[#2b1d12]/30 text-xs font-bold">
                  <button
                    type="button"
                    onClick={() => handleLangSwitch('ru')}
                    className={`px-3 py-1.5 cursor-pointer ${
                      settingsForm.lang === 'ru' ? 'bg-[#b4521e] text-[#fff4e4]' : 'bg-[#fff8ea] text-[#2b1d12]'
                    }`}
                  >
                    Русский
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLangSwitch('uk')}
                    className={`px-3 py-1.5 cursor-pointer ${
                      settingsForm.lang === 'uk' ? 'bg-[#b4521e] text-[#fff4e4]' : 'bg-[#fff8ea] text-[#2b1d12]'
                    }`}
                  >
                    Українська
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLangSwitch('en')}
                    className={`px-3 py-1.5 cursor-pointer ${
                      settingsForm.lang === 'en' ? 'bg-[#b4521e] text-[#fff4e4]' : 'bg-[#fff8ea] text-[#2b1d12]'
                    }`}
                  >
                    English
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <label className="font-semibold">{t(lang, 'graphicsLabel')}</label>
                <select
                  value={settingsForm.quality}
                  onChange={(e) =>
                    setSettingsForm((s) => ({ ...s, quality: e.target.value as QualityLevel }))
                  }
                  className="px-2.5 py-1 rounded border border-[#2b1d12]/30 bg-[#fff8ea] text-[#2b1d12]"
                >
                  <option value="low">{t(lang, 'qualLow')}</option>
                  <option value="medium">{t(lang, 'qualMed')}</option>
                  <option value="high">{t(lang, 'qualHigh')}</option>
                </select>
              </div>
              <div>
                <div className="flex justify-between font-semibold mb-1">
                  <span>{t(lang, 'sensLabel')}</span>
                  <span className="tabular-nums">{settingsForm.sens.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min={0.6}
                  max={2.2}
                  step={0.1}
                  value={settingsForm.sens}
                  onChange={(e) => setSettingsForm((s) => ({ ...s, sens: +e.target.value }))}
                  className="w-full accent-[#b4521e]"
                />
              </div>
              <div>
                <div className="flex justify-between font-semibold mb-1">
                  <span>{t(lang, 'volLabel')}</span>
                  <span className="tabular-nums">{Math.round(settingsForm.vol * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settingsForm.vol}
                  onChange={(e) => setSettingsForm((s) => ({ ...s, vol: +e.target.value }))}
                  className="w-full accent-[#b4521e]"
                />
              </div>
              <div>
                <div className="flex justify-between font-semibold mb-1">
                  <span>{t(lang, 'musicLabel')}</span>
                  <span className="tabular-nums">{Math.round(settingsForm.music * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settingsForm.music}
                  onChange={(e) => setSettingsForm((s) => ({ ...s, music: +e.target.value }))}
                  className="w-full accent-[#b4521e]"
                />
              </div>
            </div>
            <button
              onClick={() => {
                eng.updateSettings(settingsForm);
                eng.closePanel();
              }}
              className="w-full mt-6 py-3 rounded-md bg-[#b4521e] text-[#fff4e4] font-bold hover:bg-[#9c4215] cursor-pointer"
            >
              {t(lang, 'done')}
            </button>
          </div>
        </div>
      )}

      {/* HOW TO PLAY PANEL */}
      {hud.panel === 'howto' && eng && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(14,9,5,0.68)] p-4">
          <div className="paper-sheet rounded-md p-7 w-[min(500px,100%)] shadow-2xl space-y-3 text-sm leading-relaxed">
            <h2 className="font-display font-extrabold text-[32px] m-0">{t(lang, 'howtoTitle')}</h2>
            <p className="opacity-85 m-0">
              <b>{t(lang, 'howto1Title')}</b> {t(lang, 'howto1')}
            </p>
            <p className="opacity-85 m-0">
              <b>{t(lang, 'howto2Title')}</b> {t(lang, 'howto2')}
            </p>
            <p className="opacity-85 m-0">
              <b>{t(lang, 'howto3Title')}</b> {t(lang, 'howto3')}
            </p>
            <p className="opacity-85 m-0">
              <b>{t(lang, 'howto4Title')}</b> {t(lang, 'howto4')}
            </p>
            <button
              onClick={() => eng.closePanel()}
              className="w-full mt-2 py-3 rounded-md bg-[#b4521e] text-[#fff4e4] font-bold hover:bg-[#9c4215] cursor-pointer"
            >
              {t(lang, 'understood')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
