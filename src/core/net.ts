// Network layer for open-data tiles: a priority-ordered fetch queue with a
// persistent Cache Storage layer, so revisited places load instantly and
// work offline.

const CACHE_NAME = 'nihon-tiles-v1'
const MAX_CONCURRENT = 16

interface Job {
  url: string
  priority: number
  resolve: (r: Response) => void
  reject: (e: unknown) => void
}

const queue: Job[] = []
let active = 0
let cachePromise: Promise<Cache | null> | null = null

function openCache(): Promise<Cache | null> {
  if (!cachePromise) {
    cachePromise =
      typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(CACHE_NAME).catch(() => null)
  }
  return cachePromise
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} ${url}`)
  }
}

async function run(job: Job): Promise<void> {
  active++
  try {
    const cache = await openCache()
    const hit = cache ? await cache.match(job.url) : undefined
    if (hit) {
      job.resolve(hit)
      return
    }
    const res = await fetch(job.url, { mode: 'cors' })
    if (!res.ok) throw new HttpError(res.status, job.url)
    if (cache) cache.put(job.url, res.clone()).catch(() => {})
    job.resolve(res)
  } catch (e) {
    job.reject(e)
  } finally {
    active--
    pump()
  }
}

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length) {
    let best = 0
    for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[best].priority) best = i
    const [job] = queue.splice(best, 1)
    void run(job)
  }
}

export function queuedFetch(url: string, priority = 0): Promise<Response> {
  return new Promise((resolve, reject) => {
    queue.push({ url, priority, resolve, reject })
    pump()
  })
}

export async function fetchArrayBuffer(url: string, priority = 0): Promise<ArrayBuffer> {
  return (await queuedFetch(url, priority)).arrayBuffer()
}

export async function fetchImageBitmap(url: string, priority = 0, flipY = false): Promise<ImageBitmap> {
  const blob = await (await queuedFetch(url, priority)).blob()
  return createImageBitmap(blob, { imageOrientation: flipY ? 'flipY' : 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

export async function fetchImageData(url: string, priority = 0): Promise<ImageData> {
  const bmp = await fetchImageBitmap(url, priority)
  if (!canvas || canvas.width !== bmp.width || canvas.height !== bmp.height) {
    canvas = new OffscreenCanvas(bmp.width, bmp.height)
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  }
  ctx!.clearRect(0, 0, bmp.width, bmp.height)
  ctx!.drawImage(bmp, 0, 0)
  bmp.close()
  return ctx!.getImageData(0, 0, canvas.width, canvas.height)
}

export function pendingRequests(): number {
  return queue.length + active
}
