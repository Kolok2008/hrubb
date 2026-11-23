import type { SurfaceSample, SurfaceType } from '../world/SurfaceDetector';

export interface FootstepAudioContext {
  speed: number;
  sprintBlend: number;
  crouch: number;
  exhausted: boolean;
  foot: -1 | 1; // -1 = left, +1 = right
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private verb: ConvolverNode | null = null;
  private windGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private fireGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private whiteNoise: AudioBuffer | null = null;
  private crackleNoise: AudioBuffer | null = null;

  public vol = 0.8;
  public musicVol = 0.5;
  public muted = false;

  private night = 0;
  private birdTimer = 2;
  private musicTimer = 3;
  private owlTimer = 15;
  private peckTimer = 20;
  private gustTimer = 8;
  private howlTimer = 30;
  private chord = 0;

  public start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = (this.ctx = new AudioCtx());
    const master = (this.master = ctx.createGain());
    master.gain.value = this.muted ? 0 : this.vol;
    master.connect(ctx.destination);

    // Pink-ish noise buffer for wind, foliage, footsteps, impacts
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      lp = 0.97 * lp + 0.03 * w;
      data[i] = w * 0.5 + lp * 2;
    }
    this.noise = buf;

    // Crisp white noise buffer for high-frequency grit, dry foliage, and scuffs
    const whiteBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const whiteData = whiteBuf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      whiteData[i] = Math.random() * 2 - 1;
    }
    this.whiteNoise = whiteBuf;

    // Sparse granular crackle buffer for autumn leaf snaps and rolling gravel/pebbles
    const crackleBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const crackleData = crackleBuf.getChannelData(0);
    let grain = 0;
    for (let i = 0; i < len; i++) {
      if (Math.random() < 0.0085) {
        grain = (Math.random() * 2 - 1) * (0.65 + Math.random() * 0.75);
      } else {
        grain *= 0.84;
      }
      crackleData[i] = grain + (Math.random() * 2 - 1) * 0.06;
    }
    this.crackleNoise = crackleBuf;

    // Forest wind bed
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;
    const windF = ctx.createBiquadFilter();
    windF.type = 'lowpass';
    windF.frequency.value = 500;
    const windG = (this.windGain = ctx.createGain());
    windG.gain.value = 0.12;
    const windLfo = ctx.createOscillator();
    windLfo.frequency.value = 0.08;
    const windLfoG = ctx.createGain();
    windLfoG.gain.value = 250;
    windLfo.connect(windLfoG);
    windLfoG.connect(windF.frequency);
    windLfo.start();
    windSrc.connect(windF);
    windF.connect(windG);
    windG.connect(master);
    windSrc.start();

    // Canopy leaf shimmer
    const shSrc = ctx.createBufferSource();
    shSrc.buffer = buf;
    shSrc.loop = true;
    shSrc.playbackRate.value = 1.3;
    const shF = ctx.createBiquadFilter();
    shF.type = 'bandpass';
    shF.frequency.value = 3500;
    shF.Q.value = 0.6;
    const shG = ctx.createGain();
    shG.gain.value = 0.025;
    shSrc.connect(shF);
    shF.connect(shG);
    shG.connect(master);
    shSrc.start();

    // Soft autumn rain bed (modulated dynamically by rainBlend)
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = whiteBuf;
    rainSrc.loop = true;
    const rainF = ctx.createBiquadFilter();
    rainF.type = 'bandpass';
    rainF.frequency.value = 1850;
    rainF.Q.value = 0.55;
    const rainG = (this.rainGain = ctx.createGain());
    rainG.gain.value = 0;
    rainSrc.connect(rainF);
    rainF.connect(rainG);
    rainG.connect(master);
    rainSrc.start();

    // Proximity-attenuated campfire crackle bed
    const fireSrc = ctx.createBufferSource();
    fireSrc.buffer = crackleBuf;
    fireSrc.loop = true;
    fireSrc.playbackRate.value = 0.85;
    const fireF = ctx.createBiquadFilter();
    fireF.type = 'bandpass';
    fireF.frequency.value = 1150;
    fireF.Q.value = 0.7;
    const fireG = (this.fireGain = ctx.createGain());
    fireG.gain.value = 0;
    fireSrc.connect(fireF);
    fireF.connect(fireG);
    fireG.connect(master);
    fireSrc.start();

    // Music bus + impulse reverb
    const music = (this.music = ctx.createGain());
    music.gain.value = this.musicVol * 0.22;
    music.connect(master);

    const ir = ctx.createBuffer(2, ctx.sampleRate * 2.4, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      }
    }
    const verb = (this.verb = ctx.createConvolver());
    verb.buffer = ir;
    const verbG = ctx.createGain();
    verbG.gain.value = 0.45;
    verb.connect(verbG);
    verbG.connect(master);
    music.connect(verb);
  }

  public setVolume(v: number) {
    this.vol = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  public setMusic(v: number) {
    this.musicVol = v;
    if (this.music) this.music.gain.value = v * 0.22;
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.vol;
    return this.muted;
  }

  private env(g: GainNode, t: number, atk: number, peak: number, rel: number) {
    g.gain.setValueAtTime(1e-4, t);
    g.gain.exponentialRampToValueAtTime(Math.max(2e-4, peak), t + atk);
    g.gain.exponentialRampToValueAtTime(1e-4, t + atk + rel);
  }

  private burst(
    freq: number,
    q: number,
    dur: number,
    vol: number,
    type: BiquadFilterType = 'bandpass',
    rate = 1,
  ) {
    if (!this.ctx || !this.noise || !this.master) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    this.env(g, t, 0.008, vol, dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  private createFootstepBus(foot: -1 | 1, crouch: number, reverbSend: number, panJitter = 0): AudioNode | null {
    if (!this.ctx || !this.master) return null;
    const ctx = this.ctx;

    // Dynamic stealth filter: warm & muffled in crouch, fully open when walking/sprinting
    const stealthLp = ctx.createBiquadFilter();
    stealthLp.type = 'lowpass';
    stealthLp.frequency.value = 14500 * Math.pow(0.14, crouch);
    stealthLp.Q.value = 0.7;

    // Subtle alternating L/R stereo placement for left/right boots
    const pan = ctx.createStereoPanner();
    const panAmt = Math.max(-0.55, Math.min(0.55, foot * 0.17 + panJitter));
    pan.pan.value = panAmt;

    stealthLp.connect(pan);
    pan.connect(this.master);

    if (this.verb && reverbSend > 0.01) {
      const send = ctx.createGain();
      send.gain.value = reverbSend * (1 - crouch * 0.55);
      pan.connect(send);
      send.connect(this.verb);
    }
    return stealthLp;
  }

  private footBurst(
    dest: AudioNode,
    buffer: AudioBuffer | null,
    freq: number,
    q: number,
    atk: number,
    dur: number,
    vol: number,
    type: BiquadFilterType = 'bandpass',
    rate = 1,
    freqEnd?: number,
    delay = 0,
  ) {
    if (!this.ctx || !buffer || vol <= 1e-4) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.max(0.35, rate);
    // Random offset into 2-second buffer so consecutive steps never sound identical
    const startOffset = Math.random() * Math.max(0.1, buffer.duration - dur - 0.15);

    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(Math.max(40, freq), t);
    if (freqEnd !== undefined) {
      f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t + atk + dur);
    }
    f.Q.value = q;

    const g = this.ctx.createGain();
    this.env(g, t, Math.max(0.002, atk), vol, Math.max(0.015, dur));

    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, startOffset, atk + dur + 0.06);
  }

  private footTone(
    dest: AudioNode,
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    atk: number,
    dur: number,
    vol: number,
    delay = 0,
  ) {
    if (!this.ctx || vol <= 1e-4) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(25, freqStart), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(25, freqEnd), t + atk + dur);

    const g = this.ctx.createGain();
    this.env(g, t, Math.max(0.002, atk), vol, Math.max(0.015, dur));

    osc.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + atk + dur + 0.04);
  }

  private footGain(fctx: FootstepAudioContext): number {
    const speedFactor = Math.min(1.45, Math.max(0.35, fctx.speed / 2.95));
    const sprintBoost = 1 + fctx.sprintBlend * 0.32;
    const crouchAtten = 1 - fctx.crouch * 0.62;
    const tiredWeight = fctx.exhausted ? 1.12 : 1;
    return speedFactor * sprintBoost * crouchAtten * tiredWeight;
  }

  private synthHeelLayer(
    surface: SurfaceType,
    weight: number,
    dest: AudioNode,
    fctx: FootstepAudioContext,
    leafBoost: number,
  ) {
    const g = this.footGain(fctx) * weight;
    const rndPitch = 0.9 + Math.random() * 0.22;
    const crisp = 1 + fctx.sprintBlend * 0.28 - fctx.crouch * 0.25;

    if (surface === 'moss') {
      // Spongy, muted organic compression thud — soft slow attack
      this.footTone(dest, 'sine', 84 * rndPitch, 42 * rndPitch, 0.016, 0.095, 0.14 * g);
      this.footBurst(dest, this.noise, 340 * rndPitch, 0.75, 0.018, 0.11, 0.1 * g, 'lowpass', 0.72 * rndPitch);
      this.footBurst(dest, this.whiteNoise, 980 * rndPitch, 1.1, 0.02, 0.08, 0.032 * g, 'bandpass', 0.85);
    } else if (surface === 'leaves') {
      // Forest loam cushion + crisp multi-band papery autumn leaf crunch
      const pile = 1 + leafBoost * 0.65;
      this.footTone(dest, 'triangle', 105 * rndPitch, 52, 0.008, 0.075, 0.085 * g);
      this.footBurst(
        dest,
        this.crackleNoise,
        2400 * rndPitch * crisp,
        1.15,
        0.007,
        0.105 * pile,
        0.16 * g * pile,
        'bandpass',
        1.05 * rndPitch,
        1600,
      );
      this.footBurst(
        dest,
        this.whiteNoise,
        4600 * rndPitch,
        1.3,
        0.009,
        0.085 * pile,
        0.065 * g * pile,
        'bandpass',
        1.18 * rndPitch,
      );
      this.footBurst(dest, this.noise, 360 * rndPitch, 0.8, 0.01, 0.08, 0.065 * g, 'lowpass', 0.85);
    } else if (surface === 'stone') {
      // Crisp hard mineral heel click + solid impact thump
      this.footTone(dest, 'triangle', 165 * rndPitch, 74, 0.003, 0.055, 0.13 * g);
      this.footTone(dest, 'sine', 1380 * rndPitch * crisp, 860 * rndPitch, 0.002, 0.028, 0.055 * g);
      this.footBurst(
        dest,
        this.whiteNoise,
        2950 * rndPitch * crisp,
        2.1,
        0.002,
        0.042,
        0.145 * g,
        'bandpass',
        1.25 * rndPitch,
        1750,
      );
      this.footBurst(dest, this.crackleNoise, 4400 * rndPitch, 1.6, 0.003, 0.055, 0.11 * g, 'highpass', 1.2);
    } else if (surface === 'dirt') {
      // Compact packed-earth heel thud + dry grit bite
      this.footTone(dest, 'triangle', 124 * rndPitch, 56, 0.006, 0.072, 0.125 * g);
      this.footBurst(dest, this.noise, 460 * rndPitch, 1.0, 0.007, 0.08, 0.105 * g, 'lowpass', 0.9 * rndPitch);
      this.footBurst(
        dest,
        this.whiteNoise,
        1550 * rndPitch * crisp,
        1.45,
        0.006,
        0.058,
        0.065 * g,
        'bandpass',
        1.1 * rndPitch,
      );
    } else {
      // Wood: hollow cabin floorboards resonance + firm sole tap
      this.footTone(dest, 'triangle', 172 * rndPitch, 92 * rndPitch, 0.004, 0.085, 0.175 * g);
      this.footTone(dest, 'sine', 310 * rndPitch, 195 * rndPitch, 0.003, 0.062, 0.09 * g);
      this.footBurst(dest, this.noise, 920 * rndPitch, 2.2, 0.004, 0.05, 0.115 * g, 'bandpass', 1.08 * rndPitch);
    }
  }

  private synthToeLayer(
    surface: SurfaceType,
    weight: number,
    dest: AudioNode,
    fctx: FootstepAudioContext,
    leafBoost: number,
  ) {
    const dragScale = fctx.exhausted ? 1.45 : 1 + fctx.crouch * 0.25 - fctx.sprintBlend * 0.18;
    const g = this.footGain(fctx) * weight * (fctx.exhausted ? 0.9 : 0.72);
    const rndPitch = 0.92 + Math.random() * 0.2;

    if (surface === 'moss') {
      this.footBurst(
        dest,
        this.noise,
        620 * rndPitch,
        0.9,
        0.015,
        0.085 * dragScale,
        0.068 * g,
        'bandpass',
        0.82,
        420,
      );
    } else if (surface === 'leaves') {
      const pile = 1 + leafBoost * 0.7;
      this.footBurst(
        dest,
        this.crackleNoise,
        3200 * rndPitch,
        1.05,
        0.01,
        0.115 * dragScale * pile,
        0.145 * g * pile,
        'bandpass',
        1.12 * rndPitch,
        2100,
      );
      this.footBurst(
        dest,
        this.whiteNoise,
        5200 * rndPitch,
        0.95,
        0.012,
        0.095 * dragScale * pile,
        0.055 * g * pile,
        'highpass',
        1.05,
      );
    } else if (surface === 'stone') {
      // Gritty toe-off scrape on mineral surface
      this.footBurst(
        dest,
        this.whiteNoise,
        2500 * rndPitch,
        1.85,
        0.005,
        0.062 * dragScale,
        0.095 * g,
        'bandpass',
        1.22,
        3900 * rndPitch,
      );
      this.footBurst(dest, this.crackleNoise, 3600 * rndPitch, 1.4, 0.004, 0.055 * dragScale, 0.085 * g, 'bandpass', 1.3);
    } else if (surface === 'dirt') {
      // Packed trail scuff & sandy slide
      this.footBurst(
        dest,
        this.whiteNoise,
        1180 * rndPitch,
        1.2,
        0.009,
        0.078 * dragScale,
        0.075 * g,
        'bandpass',
        1.02,
        1850 * rndPitch,
      );
      this.footBurst(dest, this.crackleNoise, 2100 * rndPitch, 1.3, 0.008, 0.055 * dragScale, 0.045 * g, 'bandpass', 1.15);
    } else {
      // Wood secondary toe tap + occasional authentic cabin plank creak
      this.footTone(dest, 'triangle', 215 * rndPitch, 130 * rndPitch, 0.004, 0.055, 0.095 * g);
      this.footBurst(dest, this.noise, 1320 * rndPitch, 1.8, 0.006, 0.045 * dragScale, 0.065 * g, 'bandpass', 1.1);
      if (Math.random() < (fctx.crouch > 0.5 ? 0.16 : 0.34)) {
        // Subtle wooden floorboard creak
        const cStart = 390 + Math.random() * 140;
        const cEnd = cStart * (0.82 + Math.random() * 0.45);
        this.footTone(dest, 'sawtooth', cStart, cEnd, 0.025, 0.12, 0.026 * g, 0.012);
      }
    }
  }

  /**
   * Phase 1 (GSAP t = 0.00): Primary heel impact synchronized with camera dip initiation.
   */
  public playFootstepHeel(surface: SurfaceSample, fctx: FootstepAudioContext) {
    const reverbSend =
      surface.primary === 'stone' ? 0.22 : surface.primary === 'wood' ? 0.26 : surface.primary === 'moss' ? 0.08 : 0.14;
    const bus = this.createFootstepBus(fctx.foot, fctx.crouch, reverbSend);
    if (!bus) return;

    const primaryWeight = 1 - surface.secondaryWeight;
    this.synthHeelLayer(surface.primary, primaryWeight, bus, fctx, surface.leafPileBoost);
    if (surface.secondary && surface.secondaryWeight > 0.12) {
      this.synthHeelLayer(surface.secondary, surface.secondaryWeight, bus, fctx, surface.leafPileBoost * 0.5);
    }
  }

  /**
   * Phase 2 (GSAP bottom of camera dip): Weight transfer & toe-off roll/scuff.
   */
  public playFootstepToe(surface: SurfaceSample, fctx: FootstepAudioContext) {
    const reverbSend = surface.primary === 'wood' ? 0.2 : surface.primary === 'stone' ? 0.16 : 0.1;
    const bus = this.createFootstepBus(fctx.foot, fctx.crouch, reverbSend, (Math.random() - 0.5) * 0.06);
    if (!bus) return;

    const primaryWeight = 1 - surface.secondaryWeight;
    this.synthToeLayer(surface.primary, primaryWeight, bus, fctx, surface.leafPileBoost);
    if (surface.secondary && surface.secondaryWeight > 0.16) {
      this.synthToeLayer(surface.secondary, surface.secondaryWeight * 0.85, bus, fctx, surface.leafPileBoost * 0.5);
    }
  }

  /**
   * Phase 3 (GSAP push-off lift): Micro-pebble scatter, dry twig snap, or floorboard settle.
   */
  public playFootstepDebris(surface: SurfaceSample, fctx: FootstepAudioContext) {
    // Keep stealth crouch clean & quiet unless stepping directly into a thick leaf pile
    if (fctx.crouch > 0.65 && surface.leafPileBoost < 0.3) return;
    const g = this.footGain(fctx) * (0.45 + fctx.sprintBlend * 0.55);
    const surf = surface.primary;

    if (surf === 'stone' || surface.secondary === 'stone') {
      const count = fctx.sprintBlend > 0.35 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const bus = this.createFootstepBus(fctx.foot, fctx.crouch, 0.18, (Math.random() - 0.5) * 0.28);
        if (!bus) continue;
        const d = i * (0.032 + Math.random() * 0.025);
        const f0 = 2800 + Math.random() * 2100;
        this.footTone(bus, 'sine', f0, f0 * 0.72, 0.002, 0.022, 0.038 * g, d);
        this.footBurst(bus, this.crackleNoise, f0 * 1.1, 2.2, 0.002, 0.032, 0.065 * g, 'bandpass', 1.35, undefined, d);
      }
    } else if (surf === 'leaves' || surface.leafPileBoost > 0.2) {
      const bus = this.createFootstepBus(fctx.foot, fctx.crouch, 0.1, (Math.random() - 0.5) * 0.22);
      if (!bus) return;
      const boost = 1 + surface.leafPileBoost * 0.8;
      this.footBurst(
        bus,
        this.crackleNoise,
        3900 + Math.random() * 1400,
        1.5,
        0.003,
        0.068,
        0.09 * g * boost,
        'bandpass',
        1.22,
        2400,
      );
      if (Math.random() < 0.28 + surface.leafPileBoost * 0.35) {
        // Tiny dry twig snap
        this.footBurst(bus, this.whiteNoise, 2400 + Math.random() * 900, 3.2, 0.002, 0.022, 0.08 * g * boost, 'bandpass', 1.4, undefined, 0.018);
      }
    } else if (surf === 'dirt' && fctx.sprintBlend > 0.25) {
      const bus = this.createFootstepBus(fctx.foot, fctx.crouch, 0.1, (Math.random() - 0.5) * 0.18);
      if (!bus) return;
      this.footBurst(bus, this.crackleNoise, 2400 + Math.random() * 600, 1.5, 0.003, 0.045, 0.055 * g, 'bandpass', 1.2);
    } else if (surf === 'wood' && fctx.sprintBlend > 0.3) {
      const bus = this.createFootstepBus(fctx.foot, fctx.crouch, 0.22, 0);
      if (!bus) return;
      this.footTone(bus, 'sine', 135 + Math.random() * 35, 82, 0.005, 0.055, 0.05 * g);
    }
  }

  /**
   * Synchronized fatigued exhale triggered by the GSAP stride timeline when exhausted.
   */
  public playFootstepBreath(intensity = 1, foot: -1 | 1 = 1) {
    const bus = this.createFootstepBus(foot, 0, 0.08, -foot * 0.12);
    if (!bus) return;
    this.footBurst(
      bus,
      this.noise,
      780 + Math.random() * 180,
      0.7,
      0.045,
      0.34,
      0.062 * intensity,
      'bandpass',
      0.62,
      460,
    );
  }

  public step(onPath: boolean, speed: number) {
    this.playFootstepHeel(
      { primary: onPath ? 'dirt' : 'leaves', secondary: null, secondaryWeight: 0, leafPileBoost: 0 },
      { speed, sprintBlend: speed > 4.2 ? 1 : 0, crouch: 0, exhausted: false, foot: 1 },
    );
  }

  public whoosh(heavy = false) {
    if (!this.ctx || !this.noise || !this.master) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = heavy ? 0.72 : 1.08 + Math.random() * 0.18;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = heavy ? 1.5 : 2.3;
    f.frequency.setValueAtTime(heavy ? 360 : 620, t);
    f.frequency.exponentialRampToValueAtTime(heavy ? 1850 : 3200, t + (heavy ? 0.18 : 0.12));
    f.frequency.exponentialRampToValueAtTime(380, t + (heavy ? 0.3 : 0.22));
    const g = this.ctx.createGain();
    this.env(g, t, 0.02, heavy ? 0.28 : 0.18, heavy ? 0.26 : 0.16);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.34);
  }

  public hitWood(strength = 1) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1.4, strength);
    // Resonant wooden body thwack
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    const f0 = 155 + Math.random() * 45;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(62, t + 0.11);
    const g = this.ctx.createGain();
    this.env(g, t, 0.004, 0.34 * s, 0.12);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.15);
    // Bark bite crisp transient
    this.burst(1150 + Math.random() * 350, 2.2, 0.08, 0.22 * s, 'bandpass', 1.15);
  }

  public hitRock(strength = 1) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1.4, strength);
    // Metallic blade-on-stone ring harmonics
    for (const ratio of [1, 1.54, 2.38]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime((2400 + Math.random() * 400) * ratio, t);
      osc.frequency.exponentialRampToValueAtTime((1950 + Math.random() * 200) * ratio, t + 0.24);
      const g = this.ctx.createGain();
      this.env(g, t, 0.002, (0.14 / ratio) * s, 0.22 / ratio);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.28);
    }
    this.burst(4200, 1.8, 0.07, 0.26 * s, 'highpass', 1.3);
  }

  public shatterCrate() {
    if (!this.ctx || !this.master) return;
    this.hitWood(1.3);
    this.burst(620, 0.9, 0.28, 0.38, 'bandpass', 0.85);
    setTimeout(() => this.burst(1500, 1.4, 0.16, 0.24, 'bandpass', 1.2), 45);
    setTimeout(() => this.burst(900, 1.2, 0.18, 0.18, 'bandpass', 1.0), 110);
  }

  public sliceFoliage() {
    this.burst(3200 + Math.random() * 900, 1.4, 0.16, 0.19, 'bandpass', 1.25);
    this.burst(1100, 0.8, 0.12, 0.1, 'bandpass', 0.9);
  }

  public hitSoil() {
    this.burst(280, 0.8, 0.15, 0.25, 'lowpass', 0.75);
    this.burst(1300, 1.2, 0.1, 0.12, 'bandpass', 1.0);
  }

  public bounceProp(mat: 'wood' | 'rock' | 'mushroom', intensity = 0.6) {
    if (mat === 'rock') {
      this.burst(900, 1.6, 0.06, 0.12 * intensity, 'bandpass', 1.1);
    } else if (mat === 'wood') {
      this.burst(380, 1.2, 0.09, 0.15 * intensity, 'lowpass', 0.9);
    } else {
      this.burst(650, 0.9, 0.05, 0.06 * intensity, 'lowpass', 1.0);
    }
  }

  public crunch(perfect = false) {
    this.burst(2100, 1.6, 0.12, 0.24, 'bandpass', 1.2);
    this.burst(720, 1.1, 0.09, 0.18, 'lowpass', 0.9);
    if (perfect && this.ctx && this.master) {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.exponentialRampToValueAtTime(990, t + 0.16);
      const g = this.ctx.createGain();
      this.env(g, t, 0.01, 0.09, 0.18);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.22);
    }
  }

  public rustle() {
    this.burst(2800, 1.1, 0.24, 0.22, 'bandpass', 1.15);
    setTimeout(() => this.burst(2200, 1.0, 0.18, 0.14, 'bandpass', 0.95), 75);
  }

  public plop() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(520, t + 0.09);
    const g = this.ctx.createGain();
    this.env(g, t, 0.005, 0.14, 0.1);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  public mushroomAlert(dist: number) {
    if (!this.ctx || !this.master) return;
    const atten = Math.max(0, 1 - dist / 14);
    if (atten <= 0.06) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const f0 = 560 + Math.random() * 90;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 1.38, t + 0.075);
    const g = this.ctx.createGain();
    this.env(g, t, 0.008, 0.075 * atten, 0.07);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.11);
  }

  public mushroomSqueak() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // Playful two-chirp startled forest sprite squeak
    for (let i = 0; i < 2; i++) {
      const st = t + i * 0.075;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      const f0 = i === 0 ? 680 + Math.random() * 110 : 880 + Math.random() * 140;
      osc.frequency.setValueAtTime(f0, st);
      osc.frequency.exponentialRampToValueAtTime(f0 * 1.65, st + 0.045);
      osc.frequency.exponentialRampToValueAtTime(f0 * 1.15, st + 0.085);
      const g = this.ctx.createGain();
      this.env(g, st, 0.006, 0.12, 0.08);
      osc.connect(g);
      g.connect(this.master);
      osc.start(st);
      osc.stop(st + 0.11);
    }
    this.burst(2800, 1.3, 0.12, 0.14, 'bandpass', 1.25);
  }

  public mushroomHop(dist: number) {
    if (!this.ctx || !this.master) return;
    const atten = Math.max(0, 1 - dist / 18);
    if (atten <= 0.05) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(210 + Math.random() * 60, t);
    osc.frequency.exponentialRampToValueAtTime(420 + Math.random() * 90, t + 0.045);
    const g = this.ctx.createGain();
    this.env(g, t, 0.004, 0.055 * atten, 0.05);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.07);
    this.burst(3100 + Math.random() * 700, 1.2, 0.075, 0.07 * atten, 'bandpass', 1.25);
  }

  public mushroomBurrow(dist = 4) {
    const atten = Math.max(0.15, 1 - dist / 22);
    // Multi-beat frantic digging scratches + leaf pile rustle across the 0.8s burrow window
    const offsets = [0, 140, 290, 440, 620];
    offsets.forEach((ms, i) => {
      setTimeout(() => {
        this.burst(360 + i * 35, 0.9, 0.12, 0.15 * atten, 'lowpass', 0.85 + i * 0.05);
        this.burst(2300 + (i % 2) * 700, 1.15, 0.14, 0.17 * atten, 'bandpass', 1.05 + i * 0.06);
      }, ms);
    });
  }

  public catchLively() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const notes = [587.3, 880, 1174.7, 1568];
    notes.forEach((f, idx) => {
      const st = t + idx * 0.055;
      const osc = this.ctx!.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, st);
      const g = this.ctx!.createGain();
      this.env(g, st, 0.006, 0.11, 0.24);
      osc.connect(g);
      g.connect(this.master!);
      if (this.verb) g.connect(this.verb);
      osc.start(st);
      osc.stop(st + 0.3);
    });
  }

  public fairyChime() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const notes = [659.25, 987.77, 1318.5, 1480, 1975.5];
    notes.forEach((f, idx) => {
      const st = t + idx * 0.09;
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, st);
      const g = this.ctx!.createGain();
      this.env(g, st, 0.015, 0.065, 0.55);
      osc.connect(g);
      g.connect(this.verb || this.master!);
      osc.start(st);
      osc.stop(st + 0.65);
    });
  }

  public coins(count = 5) {
    if (!this.ctx || !this.master) return;
    for (let i = 0; i < count; i++) {
      const t = this.ctx.currentTime + i * 0.055;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(2200 + Math.random() * 700, t);
      const g = this.ctx.createGain();
      this.env(g, t, 0.003, 0.11, 0.16);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.2);
    }
  }

  public wipe() {
    this.burst(4800, 1.1, 0.16, 0.12, 'highpass', 0.85);
    setTimeout(() => this.burst(4200, 1.1, 0.14, 0.11, 'highpass', 0.8), 190);
    setTimeout(() => this.burst(4600, 1.2, 0.13, 0.1, 'highpass', 0.9), 410);
  }

  public growl() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(92, t);
    osc.frequency.linearRampToValueAtTime(68, t + 0.55);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 340;
    const g = this.ctx.createGain();
    this.env(g, t, 0.06, 0.2, 0.55);
    osc.connect(f);
    f.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.65);
  }

  public bite() {
    this.burst(280, 1.0, 0.12, 0.34, 'lowpass', 0.9);
    this.burst(1200, 1.4, 0.08, 0.22, 'bandpass', 1.1);
  }

  public yelp() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(210, t + 0.32);
    const g = this.ctx.createGain();
    this.env(g, t, 0.01, 0.22, 0.32);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.36);
    this.burst(320, 1, 0.1, 0.28, 'lowpass');
  }

  public breath() {
    this.burst(900, 0.6, 0.45, 0.06, 'bandpass', 0.6);
  }

  public hurt() {
    this.burst(200, 1, 0.2, 0.38, 'lowpass');
  }

  public ui() {
    this.burst(3000, 3, 0.03, 0.06);
  }

  public flashlightClick(on: boolean) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // Crisp mechanical brass/plastic spring switch click
    const f1 = on ? 1650 : 1220;
    const f2 = on ? 2650 : 940;
    this.burst(on ? 3600 : 2800, 3.2, 0.018, 0.16, 'bandpass', on ? 1.25 : 0.95);
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f1, t);
    osc.frequency.exponentialRampToValueAtTime(f2, t + 0.022);
    const g = this.ctx.createGain();
    this.env(g, t, 0.002, 0.13, 0.028);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.045);

    // Secondary spring latch micro-click 24ms later
    setTimeout(() => {
      this.burst(on ? 4400 : 3200, 3.8, 0.012, 0.09, 'highpass', 1.15);
    }, 24);
  }

  public sleep() {
    if (!this.ctx || !this.music) return;
    [523, 659, 784, 1047].forEach((freq, idx) => {
      const t = this.ctx!.currentTime + idx * 0.25;
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      this.env(g, t, 0.02, 0.12, 1.2);
      osc.connect(g);
      g.connect(this.music!);
      osc.start(t);
      osc.stop(t + 1.4);
    });
  }

  public pickupItem() {
    this.burst(1650, 1.8, 0.055, 0.12, 'bandpass', 1.2);
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(340, t);
    osc.frequency.exponentialRampToValueAtTime(520, t + 0.06);
    const g = this.ctx.createGain();
    this.env(g, t, 0.004, 0.08, 0.06);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  public throwItem() {
    if (!this.ctx || !this.noise || !this.master) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1.25;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.0;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2200, t + 0.11);
    const g = this.ctx.createGain();
    this.env(g, t, 0.015, 0.16, 0.12);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.18);
  }

  public projectileImpact(kind: 'stone' | 'stick', dist: number) {
    const atten = Math.max(0.14, 1 - dist / 28);
    if (kind === 'stone') {
      this.burst(1350, 1.5, 0.085, 0.24 * atten, 'bandpass', 1.15);
      this.burst(340, 1.0, 0.09, 0.22 * atten, 'lowpass', 0.9);
    } else {
      this.burst(1850, 2.2, 0.075, 0.2 * atten, 'bandpass', 1.3);
      this.burst(620, 1.1, 0.08, 0.16 * atten, 'lowpass', 1.0);
    }
  }

  public sipTea() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.burst(980, 1.2, 0.22, 0.1, 'bandpass', 0.85);
    const notes = [392, 523.25, 659.25];
    notes.forEach((f, idx) => {
      const st = t + 0.08 + idx * 0.075;
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, st);
      const g = this.ctx!.createGain();
      this.env(g, st, 0.012, 0.07, 0.28);
      osc.connect(g);
      g.connect(this.verb || this.master!);
      osc.start(st);
      osc.stop(st + 0.35);
    });
  }

  public campRest() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const notes = [293.66, 369.99, 440, 587.33];
    notes.forEach((f, idx) => {
      const st = t + idx * 0.08;
      const osc = this.ctx!.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, st);
      const g = this.ctx!.createGain();
      this.env(g, st, 0.02, 0.075, 0.55);
      osc.connect(g);
      g.connect(this.verb || this.master!);
      osc.start(st);
      osc.stop(st + 0.65);
    });
  }

  public hangMushroom() {
    this.burst(2600, 1.3, 0.11, 0.14, 'bandpass', 1.1);
    this.plop();
  }

  public achievementUnlock() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, idx) => {
      const st = t + idx * 0.07;
      const osc = this.ctx!.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, st);
      const g = this.ctx!.createGain();
      this.env(g, st, 0.008, 0.09, 0.42);
      osc.connect(g);
      g.connect(this.master!);
      if (this.verb) g.connect(this.verb);
      osc.start(st);
      osc.stop(st + 0.52);
    });
  }

  public updateAmbience(rainIntensity: number, campfireDist: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.rainGain) {
      this.rainGain.gain.setTargetAtTime(rainIntensity * 0.16, t, 0.25);
    }
    if (this.fireGain) {
      const prox = Math.max(0, 1 - campfireDist / 16);
      this.fireGain.gain.setTargetAtTime(prox * prox * 0.22, t, 0.18);
    }
  }

  public tick(dt: number, nightAmt: number) {
    if (!this.ctx) return;
    this.night = nightAmt;
    this.birdTimer -= dt;
    this.musicTimer -= dt;
    this.owlTimer -= dt;
    this.peckTimer -= dt;
    this.gustTimer -= dt;
    this.howlTimer -= dt;

    if (this.birdTimer < 0 && nightAmt < 0.5) {
      this.bird();
      this.birdTimer = 2 + Math.random() * 7;
    }
    if (this.owlTimer < 0 && nightAmt > 0.6) {
      this.owl();
      this.owlTimer = 14 + Math.random() * 20;
    }
    if (this.musicTimer < 0) {
      this.phrase();

    }
    if (this.peckTimer < 0 && nightAmt < 0.5) {
      this.woodpecker();
      this.peckTimer = 25 + Math.random() * 40;
    }
    if (this.gustTimer < 0) {
      this.gust();
      this.gustTimer = 12 + Math.random() * 20;
    }
    if (this.howlTimer < 0 && nightAmt > 0.6) {
      this.howl();
      this.howlTimer = 40 + Math.random() * 50;
    }
  }

  private bird() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    pan.connect(this.master);
    const kind = Math.random();
    const notes = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < notes; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      const st = t + i * (0.09 + Math.random() * 0.06);
      const f = kind < 0.5 ? 3200 + Math.random() * 1500 : 2200 + Math.random() * 900;
      osc.frequency.setValueAtTime(f, st);
      osc.frequency.exponentialRampToValueAtTime(f * (kind < 0.5 ? 1.5 : 0.7), st + 0.07);
      this.env(g, st, 0.01, 0.04 + Math.random() * 0.03, 0.08);
      osc.connect(g);
      g.connect(pan);
      osc.start(st);
      osc.stop(st + 0.2);
    }
  }

  private owl() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (const [off, f] of [
      [0, 420],
      [0.5, 400],
      [0.8, 390],
    ]) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t + off);
      osc.frequency.linearRampToValueAtTime(f * 0.92, t + off + 0.35);
      this.env(g, t + off, 0.05, 0.05, 0.4);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t + off);
      osc.stop(t + off + 0.6);
    }
  }

  private woodpecker() {
    const n = 8 + Math.floor(Math.random() * 8);
    for (let i = 0; i < n; i++) {
      setTimeout(() => this.burst(1400, 4, 0.025, 0.12, 'bandpass', 1), i * 55);
    }
  }

  private gust() {
    if (!this.ctx || !this.windGain) return;
    const g = this.windGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.32, t + 2.5);
    g.linearRampToValueAtTime(0.12, t + 6);
  }

  private howl() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(380, t);
    osc.frequency.linearRampToValueAtTime(620, t + 0.8);
    osc.frequency.linearRampToValueAtTime(560, t + 2.4);
    osc.frequency.linearRampToValueAtTime(330, t + 3.2);
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 3;
    g.gain.setValueAtTime(1e-4, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.6);
    g.gain.linearRampToValueAtTime(1e-4, t + 3.3);
    osc.connect(f);
    f.connect(g);
    g.connect(this.verb || this.master);
    osc.start(t);
    osc.stop(t + 3.4);
  }

  private pluck(freq: number, t: number, gain = 0.24) {
    if (!this.ctx || !this.music) return;
    const period = Math.max(2, Math.floor(this.ctx.sampleRate / freq));
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 2.1), this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < period; i++) ch[i] = Math.random() * 2 - 1;
    for (let i = period; i < ch.length; i++) ch[i] = (ch[i - period] + ch[i - period + 1]) * 0.497;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    src.connect(lp);
    lp.connect(g);
    g.connect(this.music);
    src.start(t);
  }

  private pad(notes: number[], t: number, dur: number) {
    if (!this.ctx || !this.music) return;
    for (const f of notes) {
      for (const det of [-4, 4]) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const lp = this.ctx.createBiquadFilter();
        osc.type = 'triangle';
        osc.frequency.value = f;
        osc.detune.value = det;
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        g.gain.setValueAtTime(1e-4, t);
        g.gain.linearRampToValueAtTime(0.032, t + dur * 0.4);
        g.gain.linearRampToValueAtTime(1e-4, t + dur);
        osc.connect(lp);
        lp.connect(g);
        g.connect(this.music);
        osc.start(t);
        osc.stop(t + dur + 0.1);
      }
    }
  }

  private bar = 0;
  private nextBarAt = 0;
  // A gentle folk-waltz-ish piece in A minor, 16 bars, guitar arpeggios + pad + bass + melody.
  private phrase() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const isNight = this.night > 0.5;
    const beat = isNight ? 0.82 : 0.68;
    const barLen = beat * 4;
    const t = Math.max(ctx.currentTime + 0.05, this.nextBarAt);
    this.nextBarAt = t + barLen;
    this.musicTimer = barLen - 0.25;
    const N = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
    // chord roots/triads as MIDI
    const prog: number[][] = [
      [57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62],
      [50, 53, 57], [57, 60, 64], [52, 56, 59], [57, 60, 64],
      [53, 57, 60], [48, 52, 55], [50, 53, 57], [52, 56, 59],
      [57, 60, 64], [55, 59, 62], [53, 57, 60], [52, 56, 59],
    ];
    const mel: (number | null)[][] = [
      [76, null, 74, 72], [72, null, null, 69], [67, 69, 72, null], [74, null, 71, null],
      [69, null, 72, 74], [76, null, 77, 76], [74, null, 71, 68], [69, null, null, null],
      [72, null, 74, 76], [79, null, 76, 72], [74, null, 72, 69], [71, null, 68, 71],
      [72, 71, 69, null], [67, null, 71, 74], [72, null, 69, 72], [71, null, null, null],
    ];
    const i = this.bar % 16;
    this.bar++;
    const ch = prog[i];
    this.pad(ch.map((m) => N(m + 12)), t, barLen + 0.8);
    // bass
    this.pluck(N(ch[0] - 12), t, 0.3);
    if (!isNight) this.pluck(N(ch[0] - 12 + 7), t + beat * 2, 0.18);
    // arpeggio, 8ths
    const pat = [0, 1, 2, 1, 2, 1, 0, 2];
    for (let k = 0; k < 8; k++) {
      if (isNight && k % 2 === 1) continue;
      const m = ch[pat[k]] + (k > 0 ? 12 : 0);
      this.pluck(N(m), t + k * beat * 0.5 + (Math.random() - 0.5) * 0.012, k === 0 ? 0.2 : 0.12);
    }
    // melody (skip every other cycle at night for sparseness)
    const playMel = isNight ? Math.floor(this.bar / 16) % 2 === 0 : Math.floor(this.bar / 16) % 3 !== 2;
    if (playMel) {
      mel[i].forEach((m, k) => {
        if (m == null) return;
        const tt = t + k * beat;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const lp = ctx.createBiquadFilter();
        osc.type = 'triangle';
        osc.frequency.value = N(m);
        const vib = ctx.createOscillator();
        const vg = ctx.createGain();
        vib.frequency.value = 5.2; vg.gain.value = 3;
        vib.connect(vg); vg.connect(osc.detune);
        lp.type = 'lowpass'; lp.frequency.value = 2200;
        const len = beat * 1.6;
        g.gain.setValueAtTime(1e-4, tt);
        g.gain.linearRampToValueAtTime(0.07, tt + 0.06);
        g.gain.exponentialRampToValueAtTime(1e-4, tt + len);
        osc.connect(lp); lp.connect(g); g.connect(this.music!);
        osc.start(tt); vib.start(tt); osc.stop(tt + len + 0.05); vib.stop(tt + len + 0.05);
      });
    }
  }
}
