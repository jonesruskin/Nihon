// The few pedestrians closest to the camera are drawn with the full skinned
// MakeHuman models (textured faces, cloth, real mocap blending) instead of
// the crowd LOD, wearing the same clothing colours so the swap is seamless.
import { Group, type Material, type Mesh, type MeshStandardMaterial, Vector3 } from 'three'
import type { CharacterLibrary, Person } from './CharacterLibrary'
import type { CrowdPed } from './Crowd'

interface Slot {
  person: Person
  archetype: string
  ped: CrowdPed | null
  tint: { top: Vector3; bottom: Vector3; shoe: Vector3; amount: { value: number }; feet: { value: number } }
}

const SKIN = /body|eye|brow|lash|teeth|tongue|hair|short0|bob0|long0|ponytail|braid|afro|low-poly/i

export class NearPeople {
  readonly root = new Group()
  private slots: Slot[] = []
  private loading = new Set<string>()
  max = 6
  radius = 9

  constructor(private lib: CharacterLibrary) {}

  private async make(archetype: string): Promise<void> {
    if (this.loading.has(archetype)) return
    this.loading.add(archetype)
    try {
      const person = await this.lib.create(archetype)
      const tint = { top: new Vector3(), bottom: new Vector3(), shoe: new Vector3(0.05, 0.05, 0.05), amount: { value: 0 }, feet: { value: 0 } }
      // Clothes get their own material copies with the crowd's re-tint.
      person.object.traverse((o) => {
        const m = o as Mesh
        if (!m.isMesh) return
        const fix = (mat: Material): Material => {
          if (SKIN.test(mat.name)) return mat
          const c = (mat as MeshStandardMaterial).clone()
          c.onBeforeCompile = (s) => {
            s.uniforms.uTop = { value: tint.top }
            s.uniforms.uBottom = { value: tint.bottom }
            s.uniforms.uShoe = { value: tint.shoe }
            s.uniforms.uAmt = tint.amount
            s.uniforms.uFeet = tint.feet
            s.vertexShader = s.vertexShader
              .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
              .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;')
            s.fragmentShader = s.fragmentShader
              .replace('#include <common>', '#include <common>\nuniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uShoe; uniform float uAmt; uniform float uFeet; varying float vWorldY;')
              .replace(
                '#include <map_fragment>',
                `#include <map_fragment>
                float hy = vWorldY - uFeet;
                float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
                vec3 tc = hy > 0.97 ? uTop : (hy > 0.11 ? uBottom : uShoe);
                diffuseColor.rgb = mix(diffuseColor.rgb, tc * (0.35 + 1.6 * lum), uAmt);`,
              )
          }
          c.customProgramCacheKey = () => 'nihon-person-tint'
          return c
        }
        m.material = Array.isArray(m.material) ? m.material.map(fix) : fix(m.material)
        m.castShadow = true
      })
      person.object.visible = false
      this.root.add(person.object)
      this.slots.push({ person, archetype, ped: null, tint })
    } catch (e) {
      console.warn('near person failed', archetype, e)
    } finally {
      this.loading.delete(archetype)
    }
  }

  /**
   * @param candidates crowd pedestrians sorted by distance (nearest first)
   */
  update(dt: number, cam: Vector3, candidates: CrowdPed[]): void {
    const want = candidates.filter((p) => p.pos.distanceTo(cam) < this.radius).slice(0, this.max)
    const wantSet = new Set(want)
    // Release slots whose pedestrian walked off.
    for (const s of this.slots) {
      if (s.ped && !wantSet.has(s.ped)) {
        s.ped.near = false
        s.ped = null
        s.person.object.visible = false
      }
    }
    for (const p of want) {
      if (p.near) continue
      const free = this.slots.find((s) => !s.ped && s.archetype === p.archetypeName)
      if (!free) {
        if (this.slots.length < this.max * 2) void this.make(p.archetypeName)
        continue
      }
      free.ped = p
      p.near = true
      free.tint.top.set(p.tint[0], p.tint[1], p.tint[2])
      free.tint.bottom.set(p.tint2[0], p.tint2[1], p.tint2[2])
      free.tint.shoe.setScalar(p.tint2[3])
      free.tint.amount.value = p.tint[3]
      free.person.object.visible = true
    }
    for (const s of this.slots) {
      if (!s.ped) continue
      const o = s.person.object
      o.position.copy(s.ped.pos)
      // Person faces -Z; crowd yaw points +Z along travel.
      o.rotation.set(0, s.ped.yaw + Math.PI, 0)
      s.tint.feet.value = s.ped.pos.y
      s.person.update(dt, s.ped.speed)
    }
  }
}
