// Loads optimised third-party models (CC BY / CC0, see public/models/objs/
// CREDITS) once and hands out clones.
import { Box3, BufferAttribute, Matrix4, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, SRGBColorSpace, Vector3, type BufferGeometry, type Material, type Object3D } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { createGltfLoader } from '../../core/gltf'

const BASE = `${import.meta.env.BASE_URL}models/objs/`

export class ModelLibrary {
  private loader = createGltfLoader()
  private cache = new Map<string, Promise<Object3D>>()
  private ready = new Map<string, Object3D>()

  load(id: string): Promise<Object3D> {
    let p = this.cache.get(id)
    if (!p) {
      // A dropped request shouldn't leave a prop missing for the whole visit.
      const attempt = async (n: number): Promise<Object3D> => {
        try {
          return (await this.loader.loadAsync(`${BASE}${id}.glb`)).scene
        } catch (e) {
          if (n >= 3) throw e
          await new Promise((r) => setTimeout(r, 800 * n))
          return attempt(n + 1)
        }
      }
      p = attempt(1).then((scene) => {
        prepare(scene)
        this.ready.set(id, scene)
        return scene
      })
      p.catch(() => this.cache.delete(id))
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

/**
 * Scanned models arrive as dozens of small meshes (a sedan is ~40 draw calls,
 * twice with shadows). Merge everything that doesn't move into one mesh per
 * material; wheels (wheel_*) stay separate so they can spin.
 */
function mergeStatic(root: Object3D): void {
  // Each wheel is merged on its own (it spins as one); everything else together.
  const wheelOf = (o: Object3D | null): Object3D | null => (!o ? null : /^wheel_/i.test(o.name) ? o : wheelOf(o.parent))
  const wheels: Object3D[] = []
  root.traverse((o) => /^wheel_/i.test(o.name) && wheels.push(o))
  for (const w of wheels) if (!mergeColoured(w)) mergeInto(w)
  mergeInto(root, (m) => wheelOf(m) === null)
}

/**
 * A wheel is tyre, rim, hub and brake as separate untextured materials (four
 * or five draw calls). Bake each part's colour into vertex colours and draw it
 * as one mesh. Returns false (nothing changed) if any part is textured or
 * see-through.
 */
function mergeColoured(root: Object3D): boolean {
  root.updateMatrixWorld(true)
  const inv = new Matrix4().copy(root.matrixWorld).invert()
  const parts: Mesh[] = []
  let ok = true
  root.traverse((o) => {
    const m = o as Mesh
    if (o === root || !m.isMesh) return
    const mat = m.material as MeshStandardMaterial
    if (Array.isArray(m.material) || !mat.isMeshStandardMaterial || mat.map || mat.transparent) ok = false
    parts.push(m)
  })
  if (!ok || parts.length < 2) return false
  let rough = 0
  let metal = 0
  const geos = parts.map((m) => {
    const mat = m.material as MeshStandardMaterial
    rough += mat.roughness
    metal += mat.metalness
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld))
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k)
    if (!g.attributes.normal) g.computeVertexNormals()
    const n = g.attributes.position.count
    const col = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) col.set([mat.color.r, mat.color.g, mat.color.b], i * 3)
    g.setAttribute('color', new BufferAttribute(col, 3))
    g.morphAttributes = {}
    return g
  })
  const merged = mergeGeometries(geos)
  if (!merged) return false
  for (const m of parts) m.removeFromParent()
  const mesh = new Mesh(merged, new MeshStandardMaterial({ vertexColors: true, roughness: rough / parts.length, metalness: metal / parts.length }))
  mesh.name = 'merged:wheel'
  root.add(mesh)
  return true
}

export function mergeInto(root: Object3D, accept: (m: Mesh) => boolean = () => true): void {
  root.updateMatrixWorld(true)
  const inv = new Matrix4().copy(root.matrixWorld).invert()
  const groups = new Map<Material, { geos: BufferGeometry[]; meshes: Mesh[] }>()
  root.traverse((o) => {
    const m = o as Mesh
    if (o === root || !m.isMesh || Array.isArray(m.material) || !accept(m)) return
    const g = m.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld))
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k)
    if (!g.attributes.normal) g.computeVertexNormals()
    if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
    g.morphAttributes = {}
    const e = groups.get(m.material) ?? { geos: [], meshes: [] }
    e.geos.push(g)
    e.meshes.push(m)
    groups.set(m.material, e)
  })
  for (const [mat, { geos, meshes }] of groups) {
    if (meshes.length < 2) continue
    const indexed = geos.every((g) => g.index)
    const merged = mergeGeometries(indexed ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g)))
    if (!merged) continue
    for (const m of meshes) m.removeFromParent()
    const mesh = new Mesh(merged, mat)
    mesh.name = `merged:${mat.name}`
    root.add(mesh)
  }
}

function prepare(root: Object3D): void {
  mergeStatic(root)
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
