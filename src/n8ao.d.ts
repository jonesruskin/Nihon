// Minimal types for n8ao (ships without declarations): the parts we use.
declare module 'n8ao' {
  import type { Camera, Scene } from 'three'
  import { Pass } from 'postprocessing'
  export const DepthType: { Default: number; Log: number; Reverse: number }
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number)
    configuration: {
      aoSamples: number
      aoRadius: number
      denoiseSamples: number
      denoiseRadius: number
      distanceFalloff: number
      intensity: number
      halfRes: boolean
      depthAwareUpsampling: boolean
      gammaCorrection: boolean
      screenSpaceRadius: boolean
      depthBufferType: number
      colorMultiply: boolean
    }
  }
}
