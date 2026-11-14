import { Terminal } from '@xterm/xterm'

/**
 * Cursor trail animation, ported from kitty's `cursor_trail` feature
 * (kitty/cursor_trail.c). A translucent quad is stretched between the
 * previous and the current cursor rectangle; each of its four corners moves
 * towards the matching cursor corner with an exponential ease-out whose
 * speed depends on how far "ahead" the corner is in the movement direction,
 * which gives the characteristic stretch-and-snap look.
 */
export interface CursorTrailOptions {
    enabled: boolean
    /** Decay time (s) for the corners leading the movement */
    decayFast: number
    /** Decay time (s) for the corners trailing the movement */
    decaySlow: number
    /** Minimum horizontal distance (cells) before a trail starts */
    thresholdX: number
    /** Minimum vertical distance (cells) before a trail starts */
    thresholdY: number
    /** Cursor must stay still this long (ms) before the trail follows it */
    delay: number
}

export const DEFAULT_CURSOR_TRAIL_OPTIONS: CursorTrailOptions = {
    enabled: false,
    decayFast: 0.1,
    decaySlow: 0.4,
    thresholdX: 2,
    thresholdY: 2,
    delay: 0,
}

interface Edge {
    left: number
    right: number
    top: number
    bottom: number
}

// Corner order: top-right, bottom-right, bottom-left, top-left
const CORNER_X: ('left'|'right')[] = ['right', 'right', 'left', 'left']
const CORNER_Y: ('top'|'bottom')[] = ['top', 'bottom', 'bottom', 'top']

export class CursorTrail {
    private options: CursorTrailOptions = { ...DEFAULT_CURSOR_TRAIL_OPTIONS }
    private color = '#ffffff'
    private canvas?: HTMLCanvasElement
    private ctx?: CanvasRenderingContext2D
    private screenElement?: HTMLElement
    private disposables: { dispose: () => void }[] = []

    private edge: Edge = { left: 0, right: 0, top: 0, bottom: 0 }
    private edgeValid = false
    private cornerX = [0, 0, 0, 0]
    private cornerY = [0, 0, 0, 0]
    private opacity = 1
    private needsRender = false
    private updatedAt = 0
    private cursorMovedAt = 0
    private lastCursorKey = ''
    private rafId?: number
    private disposed = false

    constructor (
        private xterm: Terminal,
        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        private xtermCore: any,
    ) { }

    attach (): void {
        if (this.disposed || this.canvas) {
            return
        }
        const screen = this.xterm.element?.querySelector('.xterm-screen') as HTMLElement | null
        if (!screen) {
            return
        }
        this.screenElement = screen
        this.canvas = document.createElement('canvas')
        this.canvas.className = 'xterm-cursor-trail-layer'
        Object.assign(this.canvas.style, {
            position: 'absolute',
            left: '0',
            top: '0',
            pointerEvents: 'none',
            // above the renderer canvases and decorations, below the IME helpers
            zIndex: '4',
        })
        screen.appendChild(this.canvas)
        this.ctx = this.canvas.getContext('2d') ?? undefined

        this.disposables.push(this.xterm.onCursorMove(() => this.onCursorMoved()))
        this.disposables.push(this.xterm.onScroll(() => this.schedule()))
        this.disposables.push(this.xterm.onRender(() => this.schedule()))
        this.disposables.push(this.xterm.onResize(() => {
            this.syncCanvasSize()
            this.schedule()
        }))
        const renderService = this.xtermCore._renderService
        if (renderService?.onDimensionsChange) {
            this.disposables.push(renderService.onDimensionsChange(() => {
                this.syncCanvasSize()
                this.schedule()
            }))
        }
        this.syncCanvasSize()
    }

    setOptions (options: Partial<CursorTrailOptions>): void {
        const wasEnabled = this.options.enabled
        this.options = { ...this.options, ...options }
        this.options.decayFast = Math.max(0.01, this.options.decayFast)
        this.options.decaySlow = Math.max(this.options.decayFast, this.options.decaySlow)
        if (!this.options.enabled && wasEnabled) {
            this.clear()
            this.cancel()
        }
        if (this.options.enabled) {
            // Snap to the current cursor so enabling does not fire a stray trail
            this.edgeValid = false
            this.schedule()
        }
    }

    setColor (color: string): void {
        this.color = color
    }

    dispose (): void {
        if (this.disposed) {
            return
        }
        this.disposed = true
        this.cancel()
        for (const d of this.disposables) {
            d.dispose()
        }
        this.disposables = []
        this.canvas?.remove()
        this.canvas = undefined
        this.ctx = undefined
        this.screenElement = undefined
    }

    private onCursorMoved (): void {
        const buffer = this.xterm.buffer.active
        const key = `${buffer.cursorX},${buffer.cursorY + buffer.baseY}`
        if (key !== this.lastCursorKey) {
            this.lastCursorKey = key
            this.cursorMovedAt = performance.now()
        }
        this.schedule()
    }

    private schedule (): void {
        if (!this.options.enabled || this.disposed || !this.canvas || this.rafId !== undefined) {
            return
        }
        this.rafId = requestAnimationFrame(now => {
            this.rafId = undefined
            this.tick(now)
        })
    }

    private cancel (): void {
        if (this.rafId !== undefined) {
            cancelAnimationFrame(this.rafId)
            this.rafId = undefined
        }
    }

    private getCellSize (): { width: number, height: number } | null {
        const dims = this.xtermCore._renderService?.dimensions
        if (!dims?.css?.cell?.width || !dims.css.cell.height) {
            return null
        }
        return { width: dims.css.cell.width, height: dims.css.cell.height }
    }

    private syncCanvasSize (): void {
        if (!this.canvas || !this.screenElement) {
            return
        }
        const dims = this.xtermCore._renderService?.dimensions
        const cssWidth = dims?.css?.canvas?.width || this.screenElement.clientWidth
        const cssHeight = dims?.css?.canvas?.height || this.screenElement.clientHeight
        const dpr = window.devicePixelRatio || 1
        const w = Math.round(cssWidth * dpr)
        const h = Math.round(cssHeight * dpr)
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w
            this.canvas.height = h
            this.canvas.style.width = `${cssWidth}px`
            this.canvas.style.height = `${cssHeight}px`
        }
    }

    /** Current cursor rectangle in CSS px relative to the screen element, or null if offscreen */
    private computeCursorEdge (cell: { width: number, height: number }): Edge | null {
        const buffer = this.xterm.buffer.active
        const row = buffer.cursorY + buffer.baseY - buffer.viewportY
        if (row < 0 || row >= this.xterm.rows) {
            return null
        }
        const col = Math.min(buffer.cursorX, Math.max(0, this.xterm.cols - 1))
        const left = col * cell.width
        let top = row * cell.height
        const style = this.xterm.options.cursorStyle ?? 'block'
        let right = left + cell.width
        const bottom = top + cell.height
        if (style === 'bar') {
            right = left + Math.max(1, this.xterm.options.cursorWidth ?? 1)
        } else if (style === 'underline') {
            top = bottom - 1
        }
        return { left, right, top, bottom }
    }

    private isCursorVisible (): boolean {
        const coreService = this.xtermCore.coreService
        if (coreService?.isCursorHidden) {
            return false
        }
        return true
    }

    private snapCorners (): void {
        for (let i = 0; i < 4; i++) {
            this.cornerX[i] = this.edge[CORNER_X[i]]
            this.cornerY[i] = this.edge[CORNER_Y[i]]
        }
    }

    private tick (now: number): void {
        if (!this.options.enabled || this.disposed || !this.ctx || !this.canvas) {
            return
        }
        const cell = this.getCellSize()
        if (!cell) {
            this.schedule()
            return
        }
        // Frame delta. While idle no frames are produced, so the first frame of a
        // new trail must not integrate the whole idle period - otherwise the
        // corners snap straight to the target and nothing is visible. Start a
        // fresh trail with dt = 0 (draws the fully stretched quad) and cap the
        // per-frame step so a stalled renderer cannot skip the animation.
        const wasAnimating = this.needsRender
        const elapsed = this.updatedAt ? Math.min(1 / 30, (now - this.updatedAt) / 1000) : 0
        const dt = wasAnimating ? elapsed : 0
        this.updatedAt = now

        const cursorVisible = this.isCursorVisible()
        const newEdge = cursorVisible ? this.computeCursorEdge(cell) : null

        // --- update target (kitty: update_cursor_trail_target) ---
        let targetUpdated = false
        if (newEdge && now - this.cursorMovedAt >= this.options.delay) {
            if (!this.edgeValid) {
                this.edge = newEdge
                this.edgeValid = true
                this.snapCorners()
            } else if (
                newEdge.left !== this.edge.left || newEdge.right !== this.edge.right ||
                newEdge.top !== this.edge.top || newEdge.bottom !== this.edge.bottom
            ) {
                this.edge = newEdge
                targetUpdated = true
            }
        }

        // --- start threshold (kitty: should_skip_cursor_trail_update) ---
        if (targetUpdated && !this.needsRender) {
            const dx = Math.round((this.cornerX[0] - this.edge.right) / cell.width)
            const dy = Math.round((this.cornerY[0] - this.edge.top) / cell.height)
            if (Math.abs(dx) <= this.options.thresholdX && Math.abs(dy) <= this.options.thresholdY) {
                this.snapCorners()
            }
        }

        // --- move corners (kitty: update_cursor_trail_corners) ---
        if (dt > 0 && this.edgeValid) {
            const cx = (this.edge.left + this.edge.right) / 2
            const cy = (this.edge.top + this.edge.bottom) / 2
            const diag2 = Math.hypot(this.edge.right - this.edge.left, this.edge.bottom - this.edge.top) / 2 || 1
            const dx = [0, 0, 0, 0]
            const dy = [0, 0, 0, 0]
            const dot = [0, 0, 0, 0]
            let minDot = Infinity
            let maxDot = -Infinity
            for (let i = 0; i < 4; i++) {
                const tx = this.edge[CORNER_X[i]]
                const ty = this.edge[CORNER_Y[i]]
                dx[i] = tx - this.cornerX[i]
                dy[i] = ty - this.cornerY[i]
                if (Math.abs(dx[i]) < 1e-6 && Math.abs(dy[i]) < 1e-6) {
                    dx[i] = dy[i] = 0
                    dot[i] = 0
                } else {
                    dot[i] = (dx[i] * (tx - cx) + dy[i] * (ty - cy)) / diag2 / Math.hypot(dx[i], dy[i])
                }
                minDot = Math.min(minDot, dot[i])
                maxDot = Math.max(maxDot, dot[i])
            }
            for (let i = 0; i < 4; i++) {
                if (dx[i] === 0 && dy[i] === 0) {
                    continue
                }
                const { decayFast, decaySlow } = this.options
                const decay = minDot === maxDot
                    ? decaySlow
                    : decaySlow + (decayFast - decaySlow) * (dot[i] - minDot) / (maxDot - minDot)
                const step = 1 - Math.pow(2, -10 * dt / decay)
                this.cornerX[i] += dx[i] * step
                this.cornerY[i] += dy[i] * step
            }
        }

        // --- opacity (kitty: update_cursor_trail_opacity) ---
        if (cursorVisible && newEdge) {
            this.opacity = Math.min(1, this.opacity + elapsed / this.options.decaySlow)
        } else {
            this.opacity = Math.max(0, this.opacity - elapsed / this.options.decaySlow)
        }

        // --- needs render (kitty: update_cursor_trail_needs_render) ---
        const prevNeedsRender = this.needsRender
        this.needsRender = false
        for (let i = 0; i < 4; i++) {
            if (
                Math.abs(this.edge[CORNER_X[i]] - this.cornerX[i]) >= 0.5 ||
                Math.abs(this.edge[CORNER_Y[i]] - this.cornerY[i]) >= 0.5
            ) {
                this.needsRender = true
                break
            }
        }

        if (this.needsRender) {
            this.draw()
            this.schedule()
        } else if (prevNeedsRender) {
            this.snapCorners()
            this.clear()
        } else if (this.opacity > 0 && this.opacity < 1) {
            this.schedule()
        }
    }

    private clear (): void {
        if (this.ctx && this.canvas) {
            this.ctx.setTransform(1, 0, 0, 1, 0, 0)
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
    }

    private draw (): void {
        if (!this.ctx || !this.canvas) {
            return
        }
        const ctx = this.ctx
        const dpr = window.devicePixelRatio || 1
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        if (this.opacity <= 0) {
            return
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.globalAlpha = this.opacity
        ctx.fillStyle = this.color
        ctx.beginPath()
        ctx.moveTo(this.cornerX[0], this.cornerY[0])
        for (let i = 1; i < 4; i++) {
            ctx.lineTo(this.cornerX[i], this.cornerY[i])
        }
        ctx.closePath()
        ctx.fill()

        // Mask out the real cursor rectangle so xterm's own cursor stays crisp
        ctx.globalAlpha = 1
        ctx.clearRect(
            this.edge.left, this.edge.top,
            this.edge.right - this.edge.left, this.edge.bottom - this.edge.top,
        )
    }
}
