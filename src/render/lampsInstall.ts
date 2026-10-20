// Side-effect import: must run before any module creates a material, so it is
// the first import in main.ts.
import { installLamps } from './lamps'

installLamps()
