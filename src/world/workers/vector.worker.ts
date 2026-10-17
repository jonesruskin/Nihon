// Fetches an OpenFreeMap vector tile and builds its streetscape off-thread.
import { buildTile, type BuildRequest, type TileBuild } from '../vector/build'
import { transferables } from '../vector/MeshBuilder'
import { fetchArrayBuffer } from '../../core/net'

export interface WorkerRequest extends Omit<BuildRequest, 'pbf'> {
  job: number
  url: string
  priority: number
}

export type WorkerResponse = { job: number; ok: true; build: TileBuild } | { job: number; ok: false; error: string }

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { job, url, priority, ...req } = e.data
  try {
    const pbf = await fetchArrayBuffer(url, priority)
    const build = buildTile({ ...req, pbf })
    const tr: ArrayBuffer[] = []
    for (const m of [build.buildings, build.roofs, build.roads, build.sidewalks, build.ballast, build.rails, build.structures, build.water]) tr.push(...transferables(m))
    for (const a of Object.values(build.instances)) tr.push(a.buffer as ArrayBuffer)
    tr.push(build.wires.buffer as ArrayBuffer)
    for (const p of build.paths) tr.push(p.pts.buffer as ArrayBuffer)
    ;(self as unknown as Worker).postMessage({ job, ok: true, build } satisfies WorkerResponse, tr)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ job, ok: false, error: String(err) } satisfies WorkerResponse)
  }
}
