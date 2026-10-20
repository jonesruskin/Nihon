// Realistic MakeHuman (CC0) characters with CMU motion capture, exported by
// scripts/blender/make_humans.py. Loads archetypes once, clones per person.
import {
  AnimationMixer,
  Group,
  LoopRepeat,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  SkinnedMesh,
  SRGBColorSpace,
  type AnimationAction,
  type AnimationClip,
  type Bone,
  type Material,
  type Object3D,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createGltfLoader } from '../core/gltf'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'

export interface CharacterInfo {
  name: string
  file: string
  gender: 'm' | 'f'
  age: number
  season?: 'summer' | 'winter' | 'any'
  clips: Record<string, number>
}

const BASE = `${import.meta.env.BASE_URL}models/people/`

export class CharacterLibrary {
  manifest: CharacterInfo[] = []
  private cache = new Map<string, Promise<GLTF>>()
  private loader = createGltfLoader()

  async init(): Promise<void> {
    try {
      this.manifest = await (await fetch(`${BASE}manifest.json`)).json()
    } catch {
      this.manifest = []
    }
  }

  load(name: string): Promise<GLTF> {
    let p = this.cache.get(name)
    if (!p) {
      const info = this.manifest.find((m) => m.name === name)
      p = this.loader.loadAsync(BASE + (info?.file ?? `${name}.glb`)).then((g) => {
        prepareMaterials(g.scene)
        return g
      })
      this.cache.set(name, p)
    }
    return p
  }

  async create(name: string): Promise<Person> {
    const g = await this.load(name)
    return new Person(name, skeletonClone(g.scene), g.animations)
  }
}

function prepareMaterials(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = true
    m.frustumCulled = false // skinned bounds are unreliable; people are small anyway
    const fix = (mat: Material): Material => {
      const s = mat as MeshStandardMaterial
      if (s.map) s.map.colorSpace = SRGBColorSpace
      const n = mat.name.toLowerCase()
      // Hair, brows and lashes are alpha cards: alpha-test to keep depth order.
      if (n.includes('hair') || n.includes('brow') || n.includes('lash') || /short0|bob0|long0|ponytail|braid|afro/.test(n)) {
        s.transparent = false
        s.alphaTest = 0.45
        s.depthWrite = true
        s.side = 2
      }
      s.roughness = Math.max(s.roughness, n.includes('shoe') ? 0.45 : 0.75)
      s.metalness = 0
      s.envMapIntensity = 0.7
      return s
    }
    m.material = Array.isArray(m.material) ? m.material.map(fix) : fix(m.material)
  })
}

/** Natural ground speeds of the source mocap clips (m/s). */
const CLIP_SPEED: Record<string, number> = { walk: 1.35, run: 3.4 }

export class Person {
  readonly object = new Group()
  readonly mixer: AnimationMixer
  private actions = new Map<string, AnimationAction>()
  private weights: Record<string, number> = { idle: 1, walk: 0, run: 0 }
  private spine: Bone | null = null
  private time = Math.random() * 10

  constructor(
    readonly archetype: string,
    readonly model: Object3D,
    clips: AnimationClip[],
  ) {
    // MakeHuman faces +Z after glTF export; our convention is facing -Z.
    model.rotation.y = Math.PI
    this.object.add(model)
    this.mixer = new AnimationMixer(model)
    for (const c of clips) {
      const a = this.mixer.clipAction(c)
      a.setLoop(LoopRepeat, Infinity)
      a.enabled = true
      a.setEffectiveWeight(c.name === 'idle' ? 1 : 0)
      a.play()
      // De-phase crowds so they don't march in lockstep.
      a.time = Math.random() * c.duration
      this.actions.set(c.name, a)
    }
    model.traverse((o) => {
      if ((o as Bone).isBone && o.name === 'Spine1') this.spine = o as Bone
      if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).frustumCulled = false
    })
  }

  /**
   * Blend idle/walk/run by actual ground speed and scale playback so feet
   * don't slide.
   */
  update(dt: number, speed: number): void {
    this.time += dt
    const w = this.weights
    const tWalk = speed < 0.15 ? 0 : speed < 2.2 ? 1 : MathUtils.clamp(1 - (speed - 2.2) / 0.8, 0, 1)
    const tRun = speed < 2.2 ? 0 : MathUtils.clamp((speed - 2.2) / 0.8, 0, 1)
    const tIdle = speed < 0.15 ? 1 : MathUtils.clamp(1 - speed / 0.3, 0, 1)
    const k = Math.min(1, dt * 8)
    w.idle += (tIdle - w.idle) * k
    w.walk += (tWalk - w.walk) * k
    w.run += (tRun - w.run) * k
    const sum = w.idle + w.walk + w.run || 1
    for (const [name, a] of this.actions) {
      a.setEffectiveWeight((w[name] ?? 0) / sum)
      const base = CLIP_SPEED[name]
      a.setEffectiveTimeScale(base ? MathUtils.clamp(speed / base, 0.6, 1.8) : 1)
    }
    this.mixer.update(dt)
    // Breathing on top of the idle pose.
    if (this.spine && w.idle > 0.05) {
      this.spine.rotation.x += Math.sin(this.time * 1.6) * 0.012 * w.idle
    }
  }

  setVisible(v: boolean): void {
    this.object.visible = v
  }

  dispose(): void {
    this.mixer.stopAllAction()
  }
}
