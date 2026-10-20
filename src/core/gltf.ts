// One glTF loader setup for every model in the game: Draco (PLATEAU),
// Meshopt geometry and KTX2/Basis textures (our own optimised assets, see
// scripts/optimize-assets.mjs). Decoders are shared, so each wasm module is
// fetched and compiled once.
import type { WebGLRenderer } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

const base = import.meta.env.BASE_URL
export const dracoLoader = new DRACOLoader().setDecoderPath(`${base}draco/`)
export const ktx2Loader = new KTX2Loader().setTranscoderPath(`${base}basis/`)

/** Call once the renderer exists: KTX2 picks the GPU's native compressed format. */
export function initGltf(renderer: WebGLRenderer): void {
  ktx2Loader.detectSupport(renderer)
}

export function createGltfLoader(): GLTFLoader {
  return new GLTFLoader().setDRACOLoader(dracoLoader).setKTX2Loader(ktx2Loader).setMeshoptDecoder(MeshoptDecoder)
}
