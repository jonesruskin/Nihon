// Unified input: keyboard + mouse (pointer lock), gamepad, and touch sticks.

export interface Axes {
  moveX: number // strafe right +
  moveY: number // forward +
  lookX: number // accumulated mouse/stick yaw delta (radians)
  lookY: number
}

export class Input {
  private down = new Set<string>()
  private pressed = new Set<string>()
  lookX = 0
  lookY = 0
  wheel = 0
  sensitivity = 0.0022
  locked = false
  private touchMove = { x: 0, y: 0, id: -1, ox: 0, oy: 0 }
  private touchLook = { id: -1, lx: 0, ly: 0 }
  enabled = true

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (!this.down.has(e.code)) this.pressed.add(e.code)
      this.down.add(e.code)
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault()
    })
    window.addEventListener('keyup', (e) => this.down.delete(e.code))
    window.addEventListener('blur', () => this.down.clear())
    canvas.addEventListener('click', () => {
      if (this.enabled && !this.locked && matchMedia('(pointer: fine)').matches) canvas.requestPointerLock?.()
    })
    document.addEventListener('pointerlockchange', () => (this.locked = document.pointerLockElement === canvas))
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return
      this.lookX += e.movementX * this.sensitivity
      this.lookY += e.movementY * this.sensitivity
    })
    window.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true })
    // Touch: left half = move stick, right half = look.
    canvas.addEventListener('touchstart', (e) => this.onTouch(e, 'start'), { passive: false })
    canvas.addEventListener('touchmove', (e) => this.onTouch(e, 'move'), { passive: false })
    canvas.addEventListener('touchend', (e) => this.onTouch(e, 'end'))
    canvas.addEventListener('touchcancel', (e) => this.onTouch(e, 'end'))
  }

  private onTouch(e: TouchEvent, phase: 'start' | 'move' | 'end'): void {
    e.preventDefault()
    for (const t of Array.from(e.changedTouches)) {
      const left = t.clientX < window.innerWidth / 2
      if (phase === 'start') {
        if (left && this.touchMove.id < 0) Object.assign(this.touchMove, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 })
        else if (!left && this.touchLook.id < 0) Object.assign(this.touchLook, { id: t.identifier, lx: t.clientX, ly: t.clientY })
      } else if (phase === 'move') {
        if (t.identifier === this.touchMove.id) {
          this.touchMove.x = Math.max(-1, Math.min(1, (t.clientX - this.touchMove.ox) / 60))
          this.touchMove.y = Math.max(-1, Math.min(1, -(t.clientY - this.touchMove.oy) / 60))
        } else if (t.identifier === this.touchLook.id) {
          this.lookX += (t.clientX - this.touchLook.lx) * 0.006
          this.lookY += (t.clientY - this.touchLook.ly) * 0.006
          this.touchLook.lx = t.clientX
          this.touchLook.ly = t.clientY
        }
      } else {
        if (t.identifier === this.touchMove.id) Object.assign(this.touchMove, { id: -1, x: 0, y: 0 })
        if (t.identifier === this.touchLook.id) this.touchLook.id = -1
      }
    }
  }

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code)
  }

  /** True once per key press. */
  hit(code: string): boolean {
    if (!this.enabled) return false
    const h = this.pressed.has(code)
    this.pressed.delete(code)
    return h
  }

  /** Simulate a key for tests / UI buttons. */
  press(code: string, hold = false): void {
    this.pressed.add(code)
    if (hold) this.down.add(code)
  }

  release(code: string): void {
    this.down.delete(code)
  }

  endFrame(): void {
    this.pressed.clear()
    this.lookX = 0
    this.lookY = 0
    this.wheel = 0
  }

  axes(): Axes {
    let mx = 0
    let my = 0
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) my += 1
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) my -= 1
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) mx += 1
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) mx -= 1
    mx += this.touchMove.x
    my += this.touchMove.y
    let lx = this.lookX
    let ly = this.lookY
    const pad = navigator.getGamepads?.()[0]
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v)
      mx += dz(pad.axes[0])
      my -= dz(pad.axes[1])
      lx += dz(pad.axes[2]) * 0.05
      ly += dz(pad.axes[3]) * 0.05
    }
    const len = Math.hypot(mx, my)
    if (len > 1) {
      mx /= len
      my /= len
    }
    return { moveX: mx, moveY: my, lookX: lx, lookY: ly }
  }

  gamepadButton(i: number): boolean {
    return !!navigator.getGamepads?.()[0]?.buttons[i]?.pressed
  }
}
