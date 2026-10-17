// Loads optimised third-party models (CC BY / CC0, see public/models/objs/
// CREDITS) once and hands out clones.
import { Box3, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, SRGBColorSpace, Vector3, type Object3D } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'

const BASE = `${import.meta.env.BASE_URL}models/objs/`

export class ModelLibrary {
  private loader = new GLTFLoader()
  private cache = new Map<string, Promise<Object3D>>()
  private ready = new Map<string, Object3D>()

  constructor() {
    const draco = new DRACOLoader()
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`)
    this.loader.setDRACOLoader(draco)
  }

  load(id: string): Promise<Object3D> {
    let p = this.cache.get(id)
    if (!p) {
      p = this.loader.loadAsync(`${BASE}${id}.glb`).then((g) => {
        prepare(g.scene)
        this.ready.set(id, g.scene)
        return g.scene
      })
      this.cache.set(id, p)
    }
    return p
  }

  /** Synchronous clone if already loaded. */
  get(id: string): Object3D | null {
    const s = this.ready.get(id)
    return s ? s.clone(true) : null
  }

  async clone(id: string): Promise<Object3D> {
    return (await this.load(id)).clone(true)
  }

  size(id: string): Vector3 | null {
    const s = this.ready.get(id)
    return s ? new Box3().setFromObject(s).getSize(new Vector3()) : null
  }
}

function prepare(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = true
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (const mat of mats) {
      const s = mat as MeshStandardMaterial
      if (s.map) s.map.colorSpace = SRGBColorSpace
      if (s.emissiveMap) s.emissiveMap.colorSpace = SRGBColorSpace
      const n = mat.name.toLowerCase()
      if (n.includes('glass')) {
        s.transparent = true
        s.depthWrite = false
        s.roughness = 0.05
        s.metalness = 0.2
      } else if (s.transparent && s.alphaTest === 0 && s.map) {
        // Foliage / decals: alpha-test keeps sorting and shadows correct.
        s.transparent = false
        s.alphaTest = 0.4
      }
      s.envMapIntensity = 0.9
      if (/body|paint|bodycolor/.test(n) && (s as MeshPhysicalMaterial).isMeshPhysicalMaterial !== true) {
        s.roughness = Math.min(s.roughness, 0.35)
        s.metalness = Math.max(s.metalness, 0.3)
      }
    }
  })
}

export const modelLibrary = new ModelLibrary()
