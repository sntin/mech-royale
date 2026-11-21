// Shared pilot primitives: memory, navigation following, aiming with lead, dodging.
import type { Hello, Observation, ActorObs } from "./mechfight.ts"
import { World } from "./world.ts"
import { Nav } from "./nav.ts"

export const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}
export const d2 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])

export type Track = { id: number; pos: number[]; vel: number[]; t: number; hp: number; maxHp: number; weapons: string[]; aim: number[]; charging: boolean; kind: string; cubes: number }

export class Pilot {
  w: World
  nav: Nav
  cfg: any
  rnd: () => number
  // nav state
  path: [number, number][] | null = null
  pathGoal: number[] | null = null
  pathT = -99
  pi = 0
  hist: { t: number; p: number[] }[] = []
  unstickUntil = -1
  unstickDir = [0, 0]
  // memory
  tracks = new Map<number, Track>()
  t = 0
  obs!: Observation

  constructor(hello: Hello, w: World, nav: Nav, seed: number) {
    this.w = w
    this.nav = nav
    this.cfg = hello.config
    let s = seed >>> 0 || 1
    this.rnd = () => {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      return (s >>> 0) / 4294967296
    }
  }

  update(obs: Observation) {
    this.obs = obs
    this.t = obs.t
    for (const m of obs.mechs) {
      this.tracks.set(m.id, { id: m.id, pos: m.pos, vel: m.vel, t: obs.t, hp: m.hp ?? 1400, maxHp: m.max_hp ?? 1400, weapons: m.weapons ?? [], aim: m.aim, charging: !!m.charging, kind: m.kind, cubes: m.cubes ?? 0 })
    }
    for (const [id, tr] of this.tracks) if (obs.t - tr.t > 30) this.tracks.delete(id)
    this.hist.push({ t: obs.t, p: obs.self.pos })
    while (this.hist.length && obs.t - this.hist[0].t > 2) this.hist.shift()
  }

  // ---- navigation ----
  // returns unit-ish move vector toward goal following A* path
  steer(goal: number[], extra?: (c: number) => number, replanEvery = 1.5): number[] {
    const me = this.obs.self.pos
    const need = !this.path || !this.pathGoal || d2(goal, this.pathGoal) > 6 || this.t - this.pathT > replanEvery
    if (need) {
      this.path = this.nav.path(me[0], me[1], goal[0], goal[1], extra)
      this.pathGoal = goal
      this.pathT = this.t
      this.pi = 0
    }
    const p = this.path
    let target = goal
    if (p && p.length) {
      // advance index to closest point
      let best = this.pi, bd = 1e9
      for (let k = this.pi; k < Math.min(p.length, this.pi + 20); k++) {
        const d = d2(me, p[k])
        if (d < bd) (bd = d), (best = k)
      }
      this.pi = best
      const onGrid = this.nav.isFree(me[0], me[1])
      let la = Math.min(p.length - 1, this.pi + 1)
      if (onGrid) for (let k = Math.min(p.length - 1, this.pi + 14); k > this.pi; k--) {
        if (this.nav.lineFree(me[0], me[1], p[k][0], p[k][1])) {
          la = k
          break
        }
      }
      target = p[la]
    }
    let dx = target[0] - me[0], dy = target[1] - me[1]
    const L = Math.hypot(dx, dy)
    if (L < 0.5) return [0, 0]
    return [dx / L, dy / L]
  }

  // stuck detection: returns true if we have been trying to move but not moving
  stuck(wantMove: boolean): boolean {
    if (!wantMove || this.hist.length < 10) return false
    const a = this.hist[0], b = this.hist[this.hist.length - 1]
    return b.t - a.t > 1.5 && d2(a.p, b.p) < 2.0
  }

  // ---- aiming ----
  // aim [yaw,pitch] from muzzle to hit target at (pos feet, vel), projectile speed v (Infinity=hitscan)
  leadAim(tpos: number[], tvel: number[], v: number, zOff = 4.5): { aim: number[]; tof: number; dist: number } {
    const me = this.obs.self
    const mz = me.pos[2] + (me.stats.muzzle_height ?? 7)
    const o = [me.pos[0], me.pos[1], mz]
    let p = [tpos[0], tpos[1], tpos[2] + zOff]
    let tof = 0
    if (isFinite(v)) {
      for (let it = 0; it < 3; it++) {
        const d = Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2])
        tof = Math.max(0, d - 3) / v
        const vz = Math.abs(tvel[2]) > 0.5 ? tvel[2] : 0
        p = [tpos[0] + tvel[0] * tof, tpos[1] + tvel[1] * tof, tpos[2] + zOff + vz * tof * 0.5]
      }
    }
    const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2]
    const h = Math.hypot(dx, dy)
    return { aim: [Math.atan2(dy, dx), Math.atan2(dz, h)], tof, dist: Math.hypot(dx, dy, dz) }
  }

  // mortar ballistic pitch to hit horizontal distance h with height diff dz (low arc if possible)
  mortarPitch(h: number, dz: number, high = false): number | null {
    const v = this.cfg.weapons.mortar.speed, g = this.cfg.weapons.mortar.gravity
    const v2 = v * v
    const disc = v2 * v2 - g * (g * h * h + 2 * dz * v2)
    if (disc < 0) return null
    const s = Math.sqrt(disc)
    return Math.atan((v2 + (high ? s : -s)) / (g * h))
  }

  aimError(aim: number[]): number {
    const a = this.obs.self.aim
    return Math.hypot(wrap(aim[0] - a[0]), aim[1] - a[1])
  }

  canSeeFrom(from: number[], fromEyeZ: number, to: number[], toZ: number) {
    return this.w.los(from[0], from[1], fromEyeZ, to[0], to[1], toZ)
  }
}
