// Car interiors for the train you ride: long bench seats, grab poles,
// hanging straps, luggage racks and light panels for commuter and subway
// cars; 2+3 reclining rows for the Shinkansen. Built in car-local space
// (+z forward, y up from the rail head).
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, TorusGeometry } from 'three'
import { assemble, at, colored } from '../world/props/models'
import type { TrainStyle } from './trainModels'

export function buildInterior(s: TrainStyle, length: number): Group {
  const g = new Group()
  const W = s.width - 0.24
  const F = s.floor
  const ceil = s.height - 0.38
  const parts = []
  const L = length - 1.2
  const shinkansen = s.kind === 'shinkansen'
  // Floor, ceiling, inner walls below/above the windows.
  parts.push(colored(at(new BoxGeometry(W, 0.06, L), 0, F - 0.03, 0), shinkansen ? 0x4b5568 : 0x8b8478))
  parts.push(colored(at(new BoxGeometry(W, 0.04, L), 0, ceil, 0), 0xf1efe8))
  for (const side of [-1, 1]) {
    parts.push(colored(at(new BoxGeometry(0.04, 0.8, L), side * (W / 2), F + 0.4, 0), 0xe9e6dc))
    parts.push(colored(at(new BoxGeometry(0.04, ceil - (F + 2.0), L), side * (W / 2), (ceil + F + 2.0) / 2, 0), 0xeeebe2))
  }
  // End walls with gangway doors.
  for (const end of [-1, 1]) parts.push(colored(at(new BoxGeometry(W, ceil - F, 0.05), 0, (F + ceil) / 2, end * (L / 2)), 0xe2ded3))

  if (shinkansen) {
    // 2+3 seating facing forward, 1.04 m pitch.
    const seat = 0x2d4a7c
    const rows = Math.floor((L - 2) / 1.04)
    const xs = [-1.33, -0.88, -0.43, 0.62, 1.07] // A B C | aisle | D E
    for (let r = 0; r < rows; r++) {
      const z = -L / 2 + 1.2 + r * 1.04
      for (const x of xs) {
        parts.push(colored(at(new BoxGeometry(0.43, 0.12, 0.46), x, F + 0.45, z), seat))
        parts.push(colored(at(new BoxGeometry(0.43, 0.68, 0.1), x, F + 0.82, z - 0.24, -0.18, 0, 0), seat))
        parts.push(colored(at(new BoxGeometry(0.3, 0.16, 0.02), x, F + 1.12, z - 0.31, -0.18, 0, 0), 0xf4f4f0))
      }
      // armrests
      for (const x of [-1.56, -0.2, 0.39, 1.3]) parts.push(colored(at(new BoxGeometry(0.05, 0.06, 0.4), x, F + 0.65, z), 0x3a3d42))
    }
    for (const side of [-1, 1]) parts.push(colored(at(new BoxGeometry(0.42, 0.04, L - 1), side * (W / 2 - 0.25), F + 1.88, 0), 0xcfd2d4))
  } else {
    // Longitudinal benches between the doors.
    const doors = Math.max(1, s.doors)
    const pitch = s.carLen / doors
    const seat = s.kind === 'metro' ? 0x4c5f8a : s.kind === 'tram' ? 0x7a3b38 : 0x3e6b8c
    for (let i = 0; i <= doors; i++) {
      const z0 = -s.carLen / 2 + (i - 0.5) * pitch
      const z1 = z0 + pitch
      const a = Math.max(-L / 2 + 0.3, z0 + 0.7)
      const b = Math.min(L / 2 - 0.3, z1 - 0.7)
      if (b - a < 0.8) continue
      const len = b - a
      const zc = (a + b) / 2
      const priority = i === 0 || i === doors
      for (const side of [-1, 1]) {
        const x = side * (W / 2 - 0.27)
        parts.push(colored(at(new BoxGeometry(0.5, 0.11, len), x, F + 0.43, zc), priority ? 0x8d6a3a : seat))
        parts.push(colored(at(new BoxGeometry(0.1, 0.45, len), side * (W / 2 - 0.05), F + 0.75, zc), priority ? 0x8d6a3a : seat))
        parts.push(colored(at(new BoxGeometry(0.46, 0.38, len), x, F + 0.19, zc), 0x9a9a96)) // seat base
        // grab poles at the bench ends
        for (const zz of [a, b]) parts.push(colored(at(new CylinderGeometry(0.018, 0.018, ceil - F, 8), side * (W / 2 - 0.55), (F + ceil) / 2, zz), 0xc9ccce))
        // luggage rack
        parts.push(colored(at(new BoxGeometry(0.34, 0.03, len), side * (W / 2 - 0.2), F + 1.78, zc), 0xb8bbbe))
        // straps along the rail
        for (let z = a + 0.2; z < b; z += 0.42) {
          parts.push(colored(at(new BoxGeometry(0.025, 0.28, 0.025), side * (W / 2 - 0.68), ceil - 0.33, z), 0xf2f2ee))
          parts.push(colored(at(new TorusGeometry(0.075, 0.012, 6, 14), side * (W / 2 - 0.68), ceil - 0.55, z, 0, Math.PI / 2, 0), priority ? 0xf2c230 : 0xf4f4f0))
        }
        parts.push(colored(at(new CylinderGeometry(0.014, 0.014, len, 6), side * (W / 2 - 0.68), ceil - 0.17, zc, Math.PI / 2, 0, 0), 0xc9ccce))
      }
    }
  }
  const mesh = new Mesh(assemble(parts), new MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }))
  mesh.receiveShadow = true
  g.add(mesh)
  // Light panels and lamps.
  const panelMat = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f7ff, emissiveIntensity: 2.2 })
  for (const x of shinkansen ? [-0.6, 0.6] : [-0.55, 0.55]) {
    const p = new Mesh(new BoxGeometry(0.22, 0.02, L - 0.8), panelMat)
    p.position.set(x, ceil - 0.03, 0)
    g.add(p)
  }
  // Anchors for the cabin lights (real lights live permanently in the scene so
  // the light count, and with it every shader, never changes).
  g.userData.lamps = [-L / 3, 0, L / 3].map((z) => [0, ceil - 0.2, z])
  return g
}
