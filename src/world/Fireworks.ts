// Japanese fireworks (花火): shells climb on a faint trail, then burst into
// chrysanthemums (菊) with coloured pistils, peonies (牡丹), golden willows
// (冠菊) and rapid low star mines (スターマイン); a finale at the end. Stars
// are additive HDR points so the bloom pass gives them their glow; the boom
// reaches you at the speed of sound.
import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Points, ShaderMaterial, Vector3 } from 'three'
import type { Festival } from '../data/festivals'

const MAX = 14000
const _e = new Vector3()
const COLORS: Array<[number, number, number]> = [
  [1, 0.22, 0.12], // red (strontium)
  [1, 0.62, 0.2], // gold (charcoal)
  [0.3, 1, 0.35], // green (barium)
  [0.3, 0.45, 1], // blue (copper)
  [1, 1, 1], // silver (titanium)
  [0.85, 0.35, 1], // purple
  [1, 0.85, 0.3], // yellow (sodium)
]

interface Shell {
  p: Vector3
  v: Vector3
  fuse: number
  kind: 'kiku' | 'botan' | 'kamuro' | 'mine'
  size: number
  c1: number
  c2: number
}

export class Fireworks {
  readonly root = new Group()
  private pos = new Float32Array(MAX * 3)
  private vel = new Float32Array(MAX * 3)
  private col = new Float32Array(MAX * 3)
  private life = new Float32Array(MAX) // seconds left
  private span = new Float32Array(MAX) // initial life
  private size = new Float32Array(MAX)
  private heavy = new Float32Array(MAX) // gravity scale (willows hang)
  private alpha = new Float32Array(MAX)
  private trail = new Uint8Array(MAX) // leaves a tail of embers (菊, 冠)
  private next = 0
  private shells: Shell[] = []
  private timer = 0
  private geo = new BufferGeometry()
  private mat: ShaderMaterial
  /** Called when a shell bursts: distance from the listener (m), and whether it was a big one. */
  onBoom: ((distance: number, big: boolean) => void) | null = null
  active = false

  constructor() {
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3))
    this.geo.setAttribute('color', new BufferAttribute(this.col, 3))
    this.geo.setAttribute('aSize', new BufferAttribute(this.size, 1))
    this.geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1))
    this.geo.boundingSphere = null
    const mat = new ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 color;
        uniform float uScale;
        varying vec3 vCol;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float px = aSize * uScale / max(1.0, -mv.z);
          // Far stars stay a couple of pixels wide but keep their energy.
          float k = px < 2.0 ? (px * px) / 4.0 : 1.0;
          gl_PointSize = max(px, 2.0);
          vCol = color;
          vA = aAlpha * k;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <logdepthbuf_pars_fragment>
        varying vec3 vCol;
        varying float vA;
        void main() {
          #include <logdepthbuf_fragment>
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          float core = exp(-r * 4.0);
          // Only lit pixels may write depth (dark ones would punch holes in the sky).
          if (vA * core < 0.02) discard;
          gl_FragColor = vec4(vCol * vA * core * 9.0 + vec3(vA * core * core * 4.0), 1.0);
        }`,
      transparent: true,
      // Written to depth so the sky/atmosphere pass (which paints wherever
      // depth is still 'far') leaves the stars alone.
      depthWrite: true,
      blending: AdditiveBlending,
    })
    this.mat = mat
    const pts = new Points(this.geo, mat)
    pts.frustumCulled = false
    pts.renderOrder = 5
    this.root.add(pts)
    this.root.name = 'fireworks'
    this.root.visible = false
  }

  /** Pixels per metre at one metre distance (viewport height / 2·tan(fov/2)). */
  setScale(px: number): void {
    this.mat.uniforms.uScale.value = px
  }

  private star(p: Vector3, vx: number, vy: number, vz: number, c: [number, number, number], life: number, size: number, heavy = 1, trail = false): void {
    const i = this.next
    this.trail[i] = trail ? 1 : 0
    this.next = (this.next + 1) % MAX
    this.pos.set([p.x, p.y, p.z], i * 3)
    this.vel.set([vx, vy, vz], i * 3)
    this.col.set(c, i * 3)
    this.life[i] = life
    this.span[i] = life
    this.size[i] = size
    this.heavy[i] = heavy
  }

  private launch(f: Festival, finale: boolean): void {
    const r = Math.random()
    const kind: Shell['kind'] = r < 0.42 ? 'kiku' : r < 0.66 ? 'botan' : r < 0.82 ? 'kamuro' : 'mine'
    const big = kind !== 'mine' && Math.random() < 0.18
    const size = kind === 'mine' ? 25 + Math.random() * 25 : (0.45 + Math.random() * 0.4) * f.size * (big ? 1.6 : 1)
    // Burst height grows with the shell (a 10-inch shell opens ~330 m up).
    const h = kind === 'mine' ? 60 + Math.random() * 60 : 120 + size * 1.3
    const g = 9.8
    const vy = Math.sqrt(2 * g * h)
    const p = new Vector3((Math.random() - 0.5) * 300, 0, (Math.random() - 0.5) * 120)
    const c1 = Math.floor(Math.random() * COLORS.length)
    const c2 = Math.random() < 0.5 ? c1 : Math.floor(Math.random() * COLORS.length)
    this.shells.push({ p, v: new Vector3((Math.random() - 0.5) * 4, vy, (Math.random() - 0.5) * 4), fuse: vy / g, kind, size, c1, c2 })
    if (finale && kind === 'mine') for (let k = 0; k < 4; k++) this.launch(f, false)
  }

  private burst(s: Shell, cam: Vector3): void {
    const n = s.kind === 'mine' ? 40 : s.kind === 'kamuro' ? 140 : 110 + Math.floor(s.size * 0.6)
    const life = s.kind === 'kamuro' ? 3.8 : s.kind === 'botan' ? 1.5 : s.kind === 'mine' ? 1.1 : 2.4
    // Speed so the sphere reaches ~`size` radius against the air drag.
    const sp = s.size * 1.35
    for (let i = 0; i < Math.min(n, 400); i++) {
      // Even directions on a sphere (Fibonacci), slightly jittered.
      const y = 1 - ((i + 0.5) / n) * 2
      const rr = Math.sqrt(1 - y * y)
      const a = i * 2.39996 + Math.random() * 0.05
      const k = sp * (0.92 + Math.random() * 0.12)
      const inner = s.kind === 'kiku' && i % 3 === 0
      const c = s.kind === 'kamuro' ? COLORS[1] : COLORS[inner ? s.c2 : s.c1]
      const tails = (s.kind === 'kiku' && !inner) || s.kind === 'kamuro'
      this.star(s.p, Math.cos(a) * rr * k * (inner ? 0.55 : 1), y * k * (inner ? 0.55 : 1), Math.sin(a) * rr * k * (inner ? 0.55 : 1), c, life * (0.85 + Math.random() * 0.3), s.kind === 'mine' ? 2.2 : 3.4, s.kind === 'kamuro' ? 2.6 : 1, tails)
    }
    const w = new Vector3().copy(s.p).applyMatrix4(this.root.matrixWorld)
    this.onBoom?.(w.distanceTo(cam), s.size > 150)
  }

  /**
   * @param fest the festival firing now (null: none in range)
   * @param origin launch site in world space
   * @param hoursLeft until the show ends (the last minutes are the finale)
   */
  update(dt: number, fest: Festival | null, origin: Vector3 | null, hoursLeft: number, cam: Vector3): void {
    this.active = !!fest
    if (!fest && this.shells.length === 0 && !this.root.visible) return
    if (origin) this.root.position.copy(origin)
    this.root.updateMatrixWorld()
    this.root.visible = true
    if (fest) {
      const finale = hoursLeft < 0.08
      const rate = (fest.rate / 60) * (finale ? 3 : 0.6 + 0.8 * Math.random())
      this.timer -= dt * rate
      while (this.timer <= 0) {
        this.timer += -Math.log(1 - Math.random()) // Poisson
        this.launch(fest, finale)
      }
    }
    // Rising shells leave a faint spark trail; burst at the apex.
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i]
      s.v.y -= 9.8 * dt
      s.p.addScaledVector(s.v, dt)
      s.fuse -= dt
      if (Math.random() < dt * 30) this.star(s.p, (Math.random() - 0.5) * 2, -2, (Math.random() - 0.5) * 2, COLORS[1], 0.5, 1.2)
      if (s.fuse <= 0) {
        this.burst(s, cam)
        this.shells.splice(i, 1)
      }
    }
    let alive = 0
    const drag = Math.exp(-1.6 * dt)
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0
        continue
      }
      alive++
      this.life[i] -= dt
      const j = i * 3
      this.vel[j] *= drag
      this.vel[j + 1] = this.vel[j + 1] * drag - 9.8 * 0.25 * this.heavy[i] * dt
      this.vel[j + 2] *= drag
      this.pos[j] += this.vel[j] * dt
      this.pos[j + 1] += this.vel[j + 1] * dt
      this.pos[j + 2] += this.vel[j + 2] * dt
      const t = Math.max(0, this.life[i] / this.span[i])
      // Tails: embers shed along the path, glowing orange as they cool.
      if (this.trail[i] && t > 0.15 && Math.random() < dt * 14) {
        _e.set(this.pos[j], this.pos[j + 1], this.pos[j + 2])
        this.star(_e, 0, -1, 0, [Math.min(1, this.col[j] * 0.6 + 0.5), this.col[j + 1] * 0.45 + 0.2, this.col[j + 2] * 0.25], 0.55, 2.2)
      }
      // Fade with a little crackle (錦冠 glitter) near the end.
      this.alpha[i] = t * t * (t < 0.3 && this.heavy[i] > 1 ? 0.5 + Math.random() : 1)
    }
    for (const k of ['position', 'aAlpha'] as const) (this.geo.getAttribute(k) as BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('color') as BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('aSize') as BufferAttribute).needsUpdate = true
    if (!fest && alive === 0 && this.shells.length === 0) this.root.visible = false
  }
}
