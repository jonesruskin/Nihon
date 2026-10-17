// Procedural soundscape (WebAudio, no recordings): the hum of the city,
// crowd murmur that scales with the people around you, rain and wind,
// summer cicadas, the birdsong of crossing signals, train rumble with the
// rail-joint "tatan… tatan", an original departure melody, and the small
// beeps and clunks of daily life (IC card ピッ, vending-machine ガコン).

export interface SoundInputs {
  urban: number // 0..1
  people: number // pedestrians nearby
  rain: number // 0..1
  wind: number // m/s
  cicadas: number // 0..1 (summer daytime greenery)
  crossing: boolean // pedestrian green at a crossing nearby
  train: number // m/s of the train you ride, or -1
  underground: boolean
  indoor: number
}

export class Soundscape {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private beds: Record<string, { gain: GainNode; filter?: BiquadFilterNode }> = {}
  private cicada!: { osc: OscillatorNode; am: GainNode; gain: GainNode }
  private birdTimer = 0
  private jointPhase = 0
  muted = false
  volume = 0.7

  /** Audio can only start after a user gesture. */
  start(): void {
    if (this.ctx) return
    const ctx = new AudioContext()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(ctx.destination)
    const noise = this.noiseBuffer()
    const bed = (name: string, type: BiquadFilterType, freq: number, q = 0.7) => {
      const src = ctx.createBufferSource()
      src.buffer = noise
      src.loop = true
      src.playbackRate.value = 0.8 + Math.random() * 0.4
      const f = ctx.createBiquadFilter()
      f.type = type
      f.frequency.value = freq
      f.Q.value = q
      const g = ctx.createGain()
      g.gain.value = 0
      src.connect(f).connect(g).connect(this.master)
      src.start()
      this.beds[name] = { gain: g, filter: f }
    }
    bed('city', 'lowpass', 180)
    bed('crowd', 'bandpass', 650, 0.6)
    bed('rain', 'highpass', 900)
    bed('wind', 'bandpass', 400, 0.9)
    bed('rumble', 'lowpass', 120)
    // Cicada: a 4.3 kHz tone, amplitude-modulated into the min-min-zemi buzz.
    const osc = ctx.createOscillator()
    osc.frequency.value = 4300
    const am = ctx.createGain()
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 38
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.5
    am.gain.value = 0.5
    lfo.connect(lfoGain).connect(am.gain)
    const g = ctx.createGain()
    g.gain.value = 0
    osc.connect(am).connect(g).connect(this.master)
    osc.start()
    lfo.start()
    this.cicada = { osc, am, gain: g }
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.1)
  }

  private noiseBuffer(): AudioBuffer {
    const ctx = this.ctx!
    const b = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate)
    const d = b.getChannelData(0)
    // Pinkish noise (Paul Kellet's filter) — softer than white.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    }
    return b
  }

  private set(name: string, v: number, tc = 0.6): void {
    const b = this.beds[name]
    if (b && this.ctx) b.gain.gain.setTargetAtTime(v, this.ctx.currentTime, tc)
  }

  update(dt: number, s: SoundInputs): void {
    const ctx = this.ctx
    if (!ctx || this.muted) return
    const t = ctx.currentTime
    const shelter = s.underground ? 0.1 : 1
    this.set('city', (0.05 + 0.3 * s.urban) * shelter * (1 - s.indoor * 0.5))
    const crowd = Math.min(1, Math.sqrt(s.people / 120))
    this.set('crowd', 0.35 * crowd * shelter * (0.8 + 0.2 * Math.sin(t * 0.7)))
    this.set('rain', 0.5 * s.rain * shelter * (s.train > 0 ? 0.4 : 1))
    this.set('wind', Math.min(0.4, s.wind / 30) * shelter)
    this.beds.wind?.filter?.frequency.setTargetAtTime(250 + s.wind * 40 + Math.sin(t * 0.3) * 80, t, 0.5)
    this.cicada.gain.gain.setTargetAtTime(0.025 * s.cicadas * shelter, t, 1)
    // Min-min-zemi phrases: swell and fall every few seconds.
    this.cicada.osc.frequency.setTargetAtTime(4200 + 250 * Math.sin(t * 1.9), t, 0.1)

    // Train: rumble scales with speed; rail joints every 25 m (tatan-tatan).
    if (s.train >= 0) {
      this.set('rumble', Math.min(0.6, 0.05 + s.train / 40) * (s.underground ? 1.6 : 1), 0.3)
      this.beds.rumble?.filter?.frequency.setTargetAtTime(90 + s.train * 3, t, 0.3)
      this.jointPhase += (s.train * dt) / 25
      if (this.jointPhase >= 1 && s.train > 2) {
        this.jointPhase -= 1
        this.click(0.18, 0)
        this.click(0.15, 0.09 - Math.min(0.06, s.train / 900))
      }
    } else this.set('rumble', 0, 0.3)

    // Crossing birdsong: ピヨピヨ while pedestrians have green.
    if (s.crossing) {
      this.birdTimer -= dt
      if (this.birdTimer <= 0) {
        this.birdTimer = 0.7
        this.chirp(2900, 2300, 0.07)
        this.chirp(2900, 2300, 0.07, 0.16)
      }
    }
  }

  private click(gain: number, delay: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.value = 70
    const g = ctx.createGain()
    const t = ctx.currentTime + delay
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + 0.15)
  }

  private chirp(f0: number, f1: number, dur: number, delay = 0): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'sine'
    const t = ctx.currentTime + delay
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(f1, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  private tone(freq: number, dur: number, gain: number, delay = 0, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx
    if (!ctx || this.muted) return
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    const g = ctx.createGain()
    const t = ctx.currentTime + delay
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  /** One-shot effects. */
  play(name: 'ic' | 'can' | 'bell' | 'clap' | 'coin' | 'chime' | 'melody' | 'doors'): void {
    if (!this.ctx) return
    switch (name) {
      case 'ic':
        this.tone(2000, 0.09, 0.12, 0, 'square')
        break
      case 'can':
        this.click(0.5, 0)
        this.click(0.3, 0.08)
        break
      case 'coin':
        this.tone(3800, 0.25, 0.05, 0)
        this.tone(5200, 0.2, 0.03, 0.12)
        break
      case 'bell': // suzu bell rattle
        for (let i = 0; i < 6; i++) this.tone(2600 + Math.random() * 600, 0.25, 0.03, i * 0.06)
        break
      case 'clap':
        this.click(0.4, 0)
        break
      case 'chime': // station announcement ピンポーン
        this.tone(1320, 0.6, 0.06, 0)
        this.tone(1047, 0.9, 0.06, 0.35)
        break
      case 'doors':
        this.tone(1568, 0.25, 0.05, 0)
        this.tone(1568, 0.25, 0.05, 0.4)
        break
      case 'melody': {
        // An original pentatonic departure jingle (no real station tune).
        const notes = [784, 880, 1047, 1175, 1047, 880, 1175, 1319, 1568, 1319, 1175, 1047]
        notes.forEach((f, i) => this.tone(f, 0.35, 0.05, i * 0.22, 'triangle'))
        break
      }
    }
  }
}
