// A generic Japanese passenger / car ferry, sized for the route: a small
// harbour boat for a 10-minute crossing, a big multi-deck car ferry for an
// overnight voyage. White superstructure, navy boot-top, a coloured stripe
// and funnel - the look of the Seto Inland Sea fleets. Forward is +z.
import { BoxGeometry, CylinderGeometry, ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, Path, Shape, type BufferGeometry } from 'three'
import { assemble, at, colored } from '../world/props/models'

export interface FerryShip {
  group: Group
  length: number
  /** Where a passenger stands on the open deck (local). */
  deck: { x: number; y: number; z: number }
}

const LIVERIES = [0x1d4f9c, 0xc8202b, 0x0f7a6b, 0x1a2f6e]

function hullShape(L: number, W: number, inset = 0): Shape {
  const h = L / 2 - inset
  const w = W / 2 - inset
  const s = new Shape()
  s.moveTo(-w * 0.92, -h)
  s.lineTo(w * 0.92, -h)
  s.quadraticCurveTo(w, -h, w, -h + W * 0.2)
  s.lineTo(w, h - L * 0.28)
  s.quadraticCurveTo(w * 0.95, h - L * 0.06, 0, h)
  s.quadraticCurveTo(-w * 0.95, h - L * 0.06, -w, h - L * 0.28)
  s.lineTo(-w, -h + W * 0.2)
  s.quadraticCurveTo(-w, -h, -w * 0.92, -h)
  return s
}

/** A vertical slab of hull outline from y0 to y1 (a rim if `wall` is set). */
function hullSlab(L: number, W: number, y0: number, y1: number, inset = 0, wall = 0): BufferGeometry {
  const shape = hullShape(L, W, inset)
  if (wall) shape.holes.push(new Path(hullShape(L, W, inset + wall).getPoints(10)))
  const g = new ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 10 })
  // Shape is in x/y (y = bow); extrusion along +z becomes height, the bow -z;
  // turn it round so the bow is +z.
  g.rotateX(-Math.PI / 2)
  g.rotateY(Math.PI)
  g.translate(0, y0, 0)
  return g
}

export function createFerry(routeKm: number, seed = 0): FerryShip {
  const L = routeKm < 4 ? 38 : routeKm < 40 ? 62 : 165
  const W = L < 50 ? 9.5 : L < 100 ? 13 : 26
  const decks = L < 50 ? 1 : L < 100 ? 2 : 5
  const livery = LIVERIES[Math.floor(Math.abs(seed) * 97) % LIVERIES.length]
  const white = 0xf1f2f0
  const parts: BufferGeometry[] = []
  const free = L < 100 ? 1.6 : 4.5 // freeboard above the waterline
  parts.push(colored(hullSlab(L, W, -2.2, -0.2), 0x1b2433)) // boot-top / anti-fouling
  parts.push(colored(hullSlab(L, W, -0.2, 0.35), livery)) // waterline stripe
  parts.push(colored(hullSlab(L, W, 0.35, free), white))
  parts.push(colored(hullSlab(L, W, free, free + 0.06, 0.05), 0x7a8a86)) // deck
  // Bulwark along the deck edge.
  parts.push(colored(hullSlab(L, W, free + 0.06, free + 1.0, 0, 0.25), white))
  // Superstructure: decks of cabins with window bands, set aft of the bow.
  const sL = L * (L < 50 ? 0.45 : 0.62)
  const sZ = L < 100 ? -L * 0.06 : L * 0.05
  const sW = W * 0.86
  const dh = 2.7
  for (let d = 0; d < decks; d++) {
    const y = free + d * dh
    const len = sL * (1 - d * 0.06)
    parts.push(colored(at(new BoxGeometry(sW, dh, len), 0, y + dh / 2, sZ - d * 0.5), white))
    // windows: dark glass bands on both sides and the front
    for (const sx of [-1, 1]) parts.push(colored(at(new BoxGeometry(0.04, 1.0, len * 0.9), (sx * sW) / 2 + sx * 0.02, y + 1.55, sZ - d * 0.5), 0x1e2a33, 1))
    parts.push(colored(at(new BoxGeometry(sW * 0.85, 1.0, 0.04), 0, y + 1.55, sZ - d * 0.5 + len / 2 + 0.02), 0x1e2a33, 1))
  }
  const topY = free + decks * dh
  // Bridge (wheelhouse) with wraparound glass.
  const bz = sZ + sL * 0.32
  parts.push(colored(at(new BoxGeometry(sW * 0.75, 2.4, L * 0.07 + 2), 0, topY + 1.2, bz), white))
  parts.push(colored(at(new BoxGeometry(sW * 0.76, 0.9, L * 0.07 + 2.05), 0, topY + 1.6, bz), 0x14202a, 1))
  // Funnel in the company colour, and a mast.
  const fz = sZ - sL * 0.28
  parts.push(colored(at(new BoxGeometry(W * 0.16, 4.2, L * 0.06 + 1.2), 0, topY + 2.1, fz), white))
  parts.push(colored(at(new BoxGeometry(W * 0.165, 1.2, L * 0.061 + 1.22), 0, topY + 3.3, fz), livery))
  parts.push(colored(at(new CylinderGeometry(0.12, 0.16, 5, 6), 0, topY + 2.4 + 2.5, bz - 1.5), 0xd8d8d8))
  // Stripe along the hull sides.
  parts.push(colored(hullSlab(L, W, free - 0.9, free - 0.55, -0.03), livery))
  const geo = assemble(parts)
  const body = new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 })
  const glass = new MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.6 })
  const mesh = new Mesh(geo, [body, glass])
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = 'ferry'
  const group = new Group()
  group.name = 'ferry'
  group.add(mesh)
  // Passengers watch from the open deck at the stern (or the bow on small boats).
  const deck = L < 50 ? { x: 1.5, y: free + 0.06, z: L * 0.33 } : { x: 2.5, y: topY, z: fz - L * 0.12 }
  return { group, length: L, deck }
}
