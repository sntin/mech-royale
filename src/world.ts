// Static map model: terrain heights + rasterized solid prisms on a 1 m grid.
import { readFileSync } from "node:fs"

export const K = 4 // max solid intervals per cell

export class World {
  nx: number
  ny: number
  x0: number
  y0: number
  ter: Float32Array // vertex heights (nx*ny)
  cnt: Uint8Array // intervals per cell
  base: Float32Array // K per cell
  top: Float32Array
  minX: number
  maxX: number
  minY: number
  maxY: number
  trees: { x: number; y: number; z: number; h: number; cr: number; cb: number; tr: number; cx: number; cy: number }[] = []

  constructor(dir: string) {
    const w = JSON.parse(readFileSync(dir + "/v2/world.json", "utf8"))
    const T = w.terrain
    this.nx = T.nx
    this.ny = T.ny
    this.x0 = T.minX
    this.y0 = T.minY
    this.minX = w.bounds.minX
    this.maxX = w.bounds.maxX
    this.minY = w.bounds.minY
    this.maxY = w.bounds.maxY
    const buf = readFileSync(dir + "/v2/terrain.i16")
    const n = this.nx * this.ny
    this.ter = new Float32Array(n)
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    for (let k = 0; k < n; k++) this.ter[k] = dv.getInt16(k * 2, true) * (T.scale ?? 0.01)
    this.cnt = new Uint8Array(n)
    this.base = new Float32Array(n * K)
    this.top = new Float32Array(n * K)
    for (const p of w.prisms) this.raster(p)
    const f: string[] = w.trees.fields
    const d: number[] = w.trees.data
    const L = f.length
    const ix = (s: string) => f.indexOf(s)
    for (let k = 0; k + L <= d.length; k += L)
      this.trees.push({
        x: d[k + ix("x")], y: d[k + ix("y")], z: d[k + ix("z")], h: d[k + ix("height")], cr: d[k + ix("crownR")],
        cb: d[k + ix("crownBase")], tr: d[k + ix("trunkR")], cx: d[k + ix("crownX")], cy: d[k + ix("crownY")],
      })
  }

  // cell (i,j) covers x in [x0+i-0.5, x0+i+0.5): centered on terrain vertices
  private raster(p: { base: number; top: number; ring: number[]; holes: number[][] }) {
    const polys = [p.ring, ...(p.holes ?? [])]
    let ymin = Infinity, ymax = -Infinity
    for (let k = 1; k < p.ring.length; k += 2) {
      ymin = Math.min(ymin, p.ring[k])
      ymax = Math.max(ymax, p.ring[k])
    }
    const j0 = Math.max(0, Math.ceil(ymin - this.y0)), j1 = Math.min(this.ny - 1, Math.floor(ymax - this.y0))
    const xs: number[] = []
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + j
      xs.length = 0
      for (const r of polys) {
        const m = r.length / 2
        for (let a = 0; a < m; a++) {
          const b = (a + 1) % m
          const ax = r[2 * a], ay = r[2 * a + 1], bx = r[2 * b], by = r[2 * b + 1]
          if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
        }
      }
      xs.sort((a, b) => a - b)
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil(xs[q] - this.x0)), i1 = Math.min(this.nx - 1, Math.floor(xs[q + 1] - this.x0))
        for (let i = i0; i <= i1; i++) {
          const c = j * this.nx + i
          const k = this.cnt[c]
          if (k >= K) continue
          // keep sorted by base
          let s = k
          while (s > 0 && this.base[c * K + s - 1] > p.base) {
            this.base[c * K + s] = this.base[c * K + s - 1]
            this.top[c * K + s] = this.top[c * K + s - 1]
            s--
          }
          this.base[c * K + s] = p.base
          this.top[c * K + s] = p.top
          this.cnt[c] = k + 1
        }
      }
    }
  }

  cell(x: number, y: number): number {
    const i = Math.round(x - this.x0), j = Math.round(y - this.y0)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1
    return j * this.nx + i
  }

  terrain(x: number, y: number): number {
    let fx = x - this.x0, fy = y - this.y0
    fx = Math.max(0, Math.min(this.nx - 1.001, fx))
    fy = Math.max(0, Math.min(this.ny - 1.001, fy))
    const i = Math.floor(fx), j = Math.floor(fy)
    const tx = fx - i, ty = fy - j
    const k = j * this.nx + i
    const a = this.ter[k], b = this.ter[k + 1], c = this.ter[k + this.nx], d = this.ter[k + this.nx + 1]
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty
  }

  inBounds(x: number, y: number) {
    return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY
  }

  // Is point inside a solid (prism or under terrain)?
  solid(x: number, y: number, z: number): boolean {
    const c = this.cell(x, y)
    if (c < 0) return true
    if (z < this.terrain(x, y)) return true
    const n = this.cnt[c]
    for (let k = 0; k < n; k++) if (z >= this.base[c * K + k] && z <= this.top[c * K + k]) return true
    return false
  }

  prismSolid(x: number, y: number, z: number): boolean {
    const c = this.cell(x, y)
    if (c < 0) return true
    const n = this.cnt[c]
    for (let k = 0; k < n; k++) if (z >= this.base[c * K + k] && z <= this.top[c * K + k]) return true
    return false
  }

  // Highest support surface at (x,y) at or below z+tol.
  surface(x: number, y: number, z: number, tol = 0.05): number {
    let s = this.terrain(x, y)
    const c = this.cell(x, y)
    if (c < 0) return s
    const n = this.cnt[c]
    for (let k = 0; k < n; k++) {
      const t = this.top[c * K + k]
      if (t <= z + tol && t > s) s = t
    }
    return s
  }

  // Line of sight between two points (buildings + terrain). Step ~0.7 m.
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy, dz)
    const n = Math.ceil(L / 0.7)
    for (let s = 1; s < n; s++) {
      const t = s / n
      if (this.solid(ax + dx * t, ay + dy * t, az + dz * t)) return false
    }
    return true
  }

  // First hit along segment: returns fraction t in [0,1] (1 = no hit)
  raycast(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 0.5): number {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy, dz)
    const n = Math.max(1, Math.ceil(L / step))
    for (let s = 1; s <= n; s++) {
      const t = s / n
      if (this.solid(ax + dx * t, ay + dy * t, az + dz * t)) return (s - 1) / n
    }
    return 1
  }
}

let cached: World | null = null
export function loadWorld(dir: string): World {
  if (!cached) cached = new World(dir)
  return cached
}
