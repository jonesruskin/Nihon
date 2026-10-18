// Phones and tablets: the left thumb drives a move stick wherever it lands
// (Input already reads it), the right thumb looks around, and a small set of
// buttons stands in for the keys. Shown only on touch screens (or ?touch).
import type { Input } from '../player/Input'

interface Btn {
  code: string
  label: string
  sub: string
  hold?: boolean
  toggle?: boolean
}

const MAIN: Btn[] = [
  { code: 'KeyE', label: 'E', sub: 'use' },
  { code: 'Space', label: '⤒', sub: 'jump' },
  { code: 'ShiftLeft', label: '»', sub: 'run', toggle: true },
  { code: 'KeyV', label: 'V', sub: 'view' },
]
const TOP: Btn[] = [
  { code: 'KeyT', label: 'T', sub: 'skip' },
  { code: 'KeyH', label: '🚕', sub: 'taxi' },
  { code: 'KeyM', label: '地図', sub: 'map' },
  { code: 'Tab', label: '📱', sub: 'phone' },
]

export class TouchControls {
  readonly el: HTMLDivElement
  private ring: HTMLDivElement
  private knob: HTMLDivElement

  constructor(parent: HTMLElement, private input: Input) {
    this.el = document.createElement('div')
    this.el.className = 'touch'
    const btn = (b: Btn) => `<button data-code="${b.code}" class="${b.toggle ? 'toggle' : ''}"><b>${b.label}</b><span>${b.sub}</span></button>`
    this.el.innerHTML = `
      <div class="touch-ring"><div class="touch-knob"></div></div>
      <div class="touch-main">${MAIN.map(btn).join('')}</div>
      <div class="touch-top">${TOP.map(btn).join('')}</div>`
    parent.appendChild(this.el)
    this.ring = this.el.querySelector('.touch-ring') as HTMLDivElement
    this.knob = this.el.querySelector('.touch-knob') as HTMLDivElement
    const all = [...MAIN, ...TOP]
    this.el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      const def = all.find((x) => x.code === b.dataset.code)!
      b.addEventListener('touchstart', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (def.toggle) {
          const on = !b.classList.contains('on')
          b.classList.toggle('on', on)
          if (on) this.input.press(def.code, true)
          else this.input.release(def.code)
        } else {
          this.input.press(def.code, def.hold)
          b.classList.add('down')
        }
      })
      b.addEventListener('touchend', (e) => {
        e.preventDefault()
        if (!def.toggle) {
          if (def.hold) this.input.release(def.code)
          b.classList.remove('down')
        }
      })
      // Desktop testing with ?touch: clicks work too.
      b.addEventListener('click', () => {
        if (!def.toggle) this.input.press(def.code)
      })
    })
    const want = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch')
    this.el.style.display = want ? 'block' : 'none'
    if (want) document.body.classList.add('is-touch')
  }

  /** Draw the move stick where the thumb is. Call once per frame. */
  update(): void {
    const s = this.input.stick
    if (!s) {
      this.ring.style.opacity = '0'
      return
    }
    this.ring.style.opacity = '1'
    this.ring.style.transform = `translate(${s.ox - 60}px, ${s.oy - 60}px)`
    this.knob.style.transform = `translate(${s.x * 42}px, ${-s.y * 42}px)`
  }
}
