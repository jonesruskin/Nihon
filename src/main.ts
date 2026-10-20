import './render/lampsInstall'
import './ui/style.css'
import { Game } from './game/Game'

const canvas = document.getElementById('view') as HTMLCanvasElement
const ui = document.getElementById('ui') as HTMLDivElement
const game = new Game(canvas, ui)
;(window as unknown as { nihon: Game }).nihon = game
void game.start()
