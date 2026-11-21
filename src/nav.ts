// Ground navigation: clearance grid + A* on a 2 m grid.
import { World, K } from "./world.ts"

export class Nav {
  w: World
  S = 2 // coarse cell size (m)
  cx: number
  cy: number
  ox: number
  oy: number
  free: Uint8Array // coarse navigable
  clear: Float32Array // coarse clearance (m) to nearest blocked fine cell
  gh: Float32Array // ground height at coarse cell
  cover: Float32Array // coarse: distance to nearest tall wall (for hiding)
  roofs: { x: number; y: number; z: number; e: number; h: number }[] = []

  constructor(w: World) {
    this.w = w
    const nx = w.nx, ny = w.ny
    const blocked = new Uint8Array(nx * ny)
    const tall = new Uint8Array(nx * ny)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i
      const g = w.ter[c]
      let b = 0
      for (let k = 0; k < w.cnt[c]; k++) {
        const t = w.top[c * K + k], bs = w.base[c * K + k]
        if (t > g + 1.2 && bs < g + 9.5) {
          b = 1
          if (t > g + 6) tall[c] = 1
        }
      }
      if (!b && i + 1 < nx && Math.abs(w.ter[c + 1] - g) > 1.0) b = 1
      if (!b && j + 1 < ny && Math.abs(w.ter[c + nx] - g) > 1.0) b = 1
      const x = w.x0 + i, y = w.y0 + j
      if (x < w.minX + 2 || x > w.maxX - 2 || y < w.minY + 2 || y > w.maxY - 2) b = 1
      blocked[c] = b
    }
    // roofs: highest solid top per cell, well above ground
    const roofTop = new Float32Array(nx * ny)
    const notRoof = new Uint8Array(nx * ny)
    for (let c = 0; c < nx * ny; c++) {
      const n = w.cnt[c]
      if (!n) {
        notRoof[c] = 1
        continue
      }
      let t = -1e9
      for (let k = 0; k < n; k++) t = Math.max(t, w.top[c * K + k])
      roofTop[c] = t
      if (t - w.ter[c] < 3.5) notRoof[c] = 1
    }
    const edist = edt(notRoof, nx, ny)
    for (let j = 4; j < ny - 4; j += 3) for (let i = 4; i < nx - 4; i += 3) {
      const c = j * nx + i
      if (notRoof[c] || edist[c] < 6) continue
      const z = roofTop[c]
      let flat = true
      for (let dj = -3; dj <= 3 && flat; dj += 3) for (let di = -3; di <= 3; di += 3) if (Math.abs(roofTop[c + dj * nx + di] - z) > 1.0) flat = false
      if (!flat) continue
      this.roofs.push({ x: w.x0 + i, y: w.y0 + j, z, e: edist[c], h: z - w.ter[c] })
    }
    const dist = edt(blocked, nx, ny)
    const tdist = edt(tall, nx, ny)
    this.ox = w.x0
    this.oy = w.y0
    this.cx = Math.floor(nx / this.S)
    this.cy = Math.floor(ny / this.S)
    const n = this.cx * this.cy
    this.free = new Uint8Array(n)
    this.clear = new Float32Array(n)
    this.gh = new Float32Array(n)
    this.cover = new Float32Array(n)
    for (let j = 0; j < this.cy; j++) for (let i = 0; i < this.cx; i++) {
      const fi = i * this.S + 1, fj = j * this.S + 1
      const fc = Math.min(ny - 1, fj) * nx + Math.min(nx - 1, fi)
      const c = j * this.cx + i
      this.clear[c] = dist[fc]
      this.free[c] = dist[fc] >= 3.2 ? 1 : 0
      this.gh[c] = w.ter[fc]
      this.cover[c] = tdist[fc]
    }
  }
  idx(x: number, y: number): number {
    const i = Math.floor((x - this.ox) / this.S), j = Math.floor((y - this.oy) / this.S)
    if (i < 0 || j < 0 || i >= this.cx || j >= this.cy) return -1
    return j * this.cx + i
  }
  center(c: number): [number, number] {
    return [this.ox + ((c % this.cx) + 0.5) * this.S, this.oy + (Math.floor(c / this.cx) + 0.5) * this.S]
  }
  isFree(x: number, y: number) {
    const c = this.idx(x, y)
    return c >= 0 && this.free[c] === 1
  }
  nearestFree(x: number, y: number, maxR = 40): number {
    const c0 = this.idx(x, y)
    if (c0 >= 0 && this.free[c0]) return c0
    const i0 = Math.floor((x - this.ox) / this.S), j0 = Math.floor((y - this.oy) / this.S)
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = 1e9
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
        const i = i0 + di, j = j0 + dj
        if (i < 0 || j < 0 || i >= this.cx || j >= this.cy) continue
        const c = j * this.cx + i
        if (this.free[c] && di * di + dj * dj < bd) (bd = di * di + dj * dj), (best = c)
      }
      if (best >= 0) return best
    }
    return -1
  }
  // straight walkable segment on coarse grid
  lineFree(ax: number, ay: number, bx: number, by: number): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.ceil(L / 1)
    for (let s = 1; s <= n; s++) {
      const t = s / n
      if (!this.isFree(ax + (bx - ax) * t, ay + (by - ay) * t)) return false
    }
    return true
  }

  // A* from (sx,sy) to (gx,gy). cost(c) optional extra cost per cell. Returns world waypoints.
  heap = new Int32Array(0)
  gArr = new Float32Array(0)
  par = new Int32Array(0)
  stamp = new Uint32Array(0)
  closed = new Uint32Array(0)
  cur = 1
  path(sx: number, sy: number, gx: number, gy: number, extra?: (c: number) => number, maxExp = 60000): [number, number][] | null {
    const n = this.cx * this.cy
    if (this.gArr.length !== n) {
      this.gArr = new Float32Array(n)
      this.par = new Int32Array(n)
      this.stamp = new Uint32Array(n)
      this.closed = new Uint32Array(n)
    }
    const s = this.nearestFree(sx, sy, 15), g = this.nearestFree(gx, gy, 30)
    if (s < 0 || g < 0) return null
    const st = ++this.cur
    const cx = this.cx
    const gi = g % cx, gj = Math.floor(g / cx)
    const h = (c: number) => {
      const di = Math.abs((c % cx) - gi), dj = Math.abs(Math.floor(c / cx) - gj)
      return (Math.max(di, dj) + 0.4142 * Math.min(di, dj)) * this.S
    }
    // binary heap of (f, c)
    const hf: number[] = [], hc: number[] = []
    const push = (f: number, c: number) => {
      let i = hf.length
      hf.push(f)
      hc.push(c)
      while (i > 0) {
        const p = (i - 1) >> 1
        if (hf[p] <= f) break
        hf[i] = hf[p]
        hc[i] = hc[p]
        i = p
      }
      hf[i] = f
      hc[i] = c
    }
    const pop = (): number => {
      const top = hc[0]
      const lf = hf.pop()!, lc = hc.pop()!
      if (hf.length) {
        let i = 0
        const L = hf.length
        while (true) {
          let l = 2 * i + 1
          if (l >= L) break
          if (l + 1 < L && hf[l + 1] < hf[l]) l++
          if (hf[l] >= lf) break
          hf[i] = hf[l]
          hc[i] = hc[l]
          i = l
        }
        hf[i] = lf
        hc[i] = lc
      }
      return top
    }
    this.gArr[s] = 0
    this.stamp[s] = st
    this.par[s] = -1
    push(h(s), s)
    const D = [1, -1, cx, -cx, cx + 1, cx - 1, -cx + 1, -cx - 1]
    const DC = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142]
    let exp = 0
    let bestC = s, bestH = h(s)
    while (hf.length) {
      const c = pop()
      if (this.closed[c] === st) continue
      this.closed[c] = st
      if (c === g) break
      const hc_ = h(c)
      if (hc_ < bestH) (bestH = hc_), (bestC = c)
      if (++exp > maxExp) break
      const ci = c % cx
      for (let k = 0; k < 8; k++) {
        const nb = c + D[k]
        const ni = nb % cx
        if (nb < 0 || nb >= n || Math.abs(ni - ci) > 1 || !this.free[nb]) continue
        if (k >= 4 && (!this.free[c + (ni - ci)] || !this.free[c + D[k] - (ni - ci)])) continue
        let cost = DC[k] * this.S
        // prefer wider corridors slightly
        if (this.clear[nb] < 5) cost *= 1.3
        if (extra) cost += extra(nb)
        const ng = this.gArr[c] + cost
        if (this.stamp[nb] === st && ng >= this.gArr[nb]) continue
        this.stamp[nb] = st
        this.gArr[nb] = ng
        this.par[nb] = c
        push(ng + h(nb), nb)
      }
    }
    let end = this.closed[g] === st ? g : bestC
    const out: [number, number][] = []
    let c = end
    let guard = 0
    while (c !== -1 && guard++ < 100000) {
      out.push(this.center(c))
      if (c === s) break
      c = this.par[c]
    }
    out.reverse()
    if (end === g) out.push([gx, gy])
    return out
  }
}

// Euclidean distance transform (meters, 1m cells) via two-pass chamfer 3-4 approximation
function edt(blocked: Uint8Array, nx: number, ny: number): Float32Array {
  const d = new Float32Array(nx * ny)
  const INF = 1e6
  for (let k = 0; k < d.length; k++) d[k] = blocked[k] ? 0 : INF
  const a = 1, b = Math.SQRT2
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i
    let v = d[c]
    if (v === 0) continue
    if (i > 0) v = Math.min(v, d[c - 1] + a)
    if (j > 0) {
      v = Math.min(v, d[c - nx] + a)
      if (i > 0) v = Math.min(v, d[c - nx - 1] + b)
      if (i < nx - 1) v = Math.min(v, d[c - nx + 1] + b)
    }
    d[c] = v
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const c = j * nx + i
    let v = d[c]
    if (v === 0) continue
    if (i < nx - 1) v = Math.min(v, d[c + 1] + a)
    if (j < ny - 1) {
      v = Math.min(v, d[c + nx] + a)
      if (i < nx - 1) v = Math.min(v, d[c + nx + 1] + b)
      if (i > 0) v = Math.min(v, d[c + nx - 1] + b)
    }
    d[c] = v
  }
  return d
}
