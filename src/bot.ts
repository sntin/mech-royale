// Survivor bot: stay in the zone, farm safely, fight one-on-one, break line of sight when outnumbered.
import type { Action, Hello, Observation, ActorObs, Bot } from "./mechfight.ts"
import { draw } from "./mechfight.ts"
import { World, loadWorld } from "./world.ts"
import { Nav } from "./nav.ts"
import { Pilot, wrap, d2, Track } from "./brain.ts"

export type Params = {
  fightHpFrac: number // min hp fraction to keep fighting a lone enemy
  farmUntil: number // seconds of match time we go out of our way for loot
  engageRange: number
  zoneMargin: number
  upgradeOrder: string[]
  weaponPref: Record<string, number>
  lightClose: boolean
  debug: boolean
  passive: boolean
  roof: boolean
  roofMinH: number
  roofMaxH: number
  roofMinE: number
  closeHostile: number
  gunDist: number
  drops: boolean
  farm: boolean
  fightLoot: boolean
  swapR: number
  salt: number
  lat: number
  fightCubeR: number
  fightFetch: number
  pickMemory: boolean
  berserk: boolean
  dodge: boolean
  focus: boolean
  secure: boolean
  finish: number
  reengageHp: number
  retreatPerExtra: number
  farmHp: number
  holdFire: boolean
  lootR: number
  spinScan: boolean
  strafeMin: number
  strafeVar: number
  fightBoost: number
  chase: boolean
  losGate: boolean
  silent: boolean
  exposureW: number
  dropRange: number
}
export const defaultParams: Params = {
  fightHpFrac: 0.4,
  farmUntil: 150,
  engageRange: 130,
  zoneMargin: 18,
  upgradeOrder: ["plating", "armor", "nanites", "gun_damage", "gun_rate", "servos", "laser_damage", "lightning_damage", "capacitor", "reactor", "gyros", "jets", "sensors", "gun_mag", "gun_velocity"],
  weaponPref: { lightning: 3, laser: 2.5, mortar: 1, gun: 0 },
  lightClose: true,
  debug: true,
  passive: true,
  roof: false,
  roofMinH: 10,
  roofMaxH: 40,
  roofMinE: 8,
  closeHostile: 55,
  gunDist: 70,
  drops: true,
  farm: true,
  fightLoot: false,
  swapR: 90,
  salt: 0,
  lat: 0,
  fightCubeR: 30,
  fightFetch: 110,
  pickMemory: false,
  berserk: false,
  dodge: false,
  focus: false,
  secure: false,
  finish: 0,
  reengageHp: 1.0,
  retreatPerExtra: 0,
  farmHp: 0.6,
  holdFire: false,
  lootR: 90,
  spinScan: false,
  strafeMin: 0.5,
  strafeVar: 0.9,
  fightBoost: 0,
  chase: false,
  losGate: false,
  silent: false,
  exposureW: 0.1,
  dropRange: 160,
}

let shared: { w: World; nav: Nav } | null = null
export function getMap(dir: string) {
  if (!shared) {
    const w = loadWorld(dir)
    shared = { w, nav: new Nav(w) }
  }
  return shared
}

type Mode = "travel" | "camp" | "fight" | "retreat" | "loot" | "farm"

export class Survivor implements Bot {
  name = "sntin-mech"
  p: Pilot
  P: Params
  cfg: any
  mode: Mode = "travel"
  camp: number[] | null = null
  campPhaseKey = ""
  strafeDir = 1
  strafeUntil = 0
  lastHurtT = -99
  lastHurtBearing = 0
  lastHurtBy: number | null = null
  scanYaw = 0
  retreatGoal: number[] | null = null
  retreatUntil = 0
  sounds: { t: number; bearing: number; kind: string; dist: string }[] = []
  lootTarget: number | null = null
  lootBan = new Map<number, number>()
  lastShotAt = -99
  myId = -1

  constructor(hello: Hello, params: Partial<Params> = {}, dir?: string) {
    const { w, nav } = getMap(dir ?? hello.map.dir)
    this.P = { ...defaultParams, ...params }
    this.cfg = hello.config
    this.p = new Pilot(hello, w, nav, (((hello.seed as number) || 12345) ^ (this.P.salt | 0)) || 12345)
    this.p.lat = this.P.lat
    this.myId = hello.slot as number
  }

  // ---------- helpers ----------
  zoneNow(obs: Observation) {
    const z = obs.zone
    if (obs.t <= z.shrink_start) return { c: z.center, r: z.radius }
    const f = Math.min(1, (obs.t - z.shrink_start) / Math.max(0.01, z.shrink_end - z.shrink_start))
    return { c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f], r: z.radius + (z.next_radius - z.radius) * f }
  }
  // the circle we should be inside
  safeCircle(obs: Observation) {
    const z = obs.zone
    return { c: z.next_center, r: z.next_radius }
  }
  enemies(obs: Observation): ActorObs[] {
    return obs.mechs.filter((m) => m.kind === "mech" && m.id !== obs.self.id)
  }
  weaponSlot(obs: Observation, kind: string): number {
    return obs.self.weapons.findIndex((w) => w?.kind === kind)
  }

  pickCamp(obs: Observation): number[] {
    const me = obs.self.pos
    const sc = this.safeCircle(obs)
    const R = Math.max(5, sc.r - this.P.zoneMargin)
    const nav = this.p.nav
    let best: number[] = sc.c, bs = -1e9
    const late = obs.t > 250
    const cands: { x: number; y: number; s: number }[] = []
    for (let k = 0; k < 160; k++) {
      const a = this.p.rnd() * Math.PI * 2, d = Math.sqrt(this.p.rnd()) * R * (late ? 0.5 : 0.8)
      const x = sc.c[0] + Math.cos(a) * d, y = sc.c[1] + Math.sin(a) * d
      const c = nav.idx(x, y)
      if (c < 0 || !nav.free[c]) continue
      let s = 0
      const cov = nav.cover[c]
      s += cov < 9 ? 12 - Math.abs(cov - 5) : -cov * 0.3 // hug tall buildings
      s -= d2([x, y], me) * 0.04 // travel cost
      s -= (d / Math.max(30, R)) * 6 // prefer toward center
      for (const tr of this.p.tracks.values()) if (tr.kind === "mech" && obs.t - tr.t < 20) s -= Math.max(0, 120 - d2(tr.pos, [x, y])) * 0.15
      cands.push({ x, y, s })
    }
    cands.sort((a, b) => b.s - a.s)
    for (const c of cands.slice(0, this.P.exposureW > 0 ? 30 : 1)) {
      const s = c.s - (this.P.exposureW > 0 ? this.exposure(c.x, c.y) * this.P.exposureW : 0)
      if (s > bs) (bs = s), (best = [c.x, c.y])
    }
    return best
  }

  // mean open sightline length (m) from a ground spot at eye height, 12 directions, capped at 150
  exposure(x: number, y: number): number {
    const w = this.p.w
    const z = w.terrain(x, y) + 8
    let tot = 0
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2
      const cx = Math.cos(a), cy = Math.sin(a)
      let d = 4
      for (; d < 150; d += 2.5) if (w.solid(x + cx * d, y + cy * d, z)) break
      tot += d
    }
    return tot / 12
  }

  findCover(obs: Observation, threats: Track[]): number[] | null {
    const me = obs.self.pos
    const nav = this.p.nav
    const zn = this.zoneNow(obs)
    let best: number[] | null = null, bs = -1e9
    for (let k = 0; k < 70; k++) {
      const a = this.p.rnd() * Math.PI * 2, d = 12 + this.p.rnd() * 55
      const x = me[0] + Math.cos(a) * d, y = me[1] + Math.sin(a) * d
      const c = nav.idx(x, y)
      if (c < 0 || !nav.free[c]) continue
      if (d2([x, y], zn.c) > zn.r - 8) continue
      const gz = nav.gh[c]
      let hidden = 0, minD = 1e9
      for (const t of threats) {
        const dd = d2(t.pos, [x, y])
        minD = Math.min(minD, dd)
        if (!this.p.w.los(t.pos[0], t.pos[1], t.pos[2] + 8, x, y, gz + 6)) hidden++
      }
      let s = hidden * 30 + Math.min(minD, 120) * 0.3 - d * 0.25
      // moving toward threat is bad
      for (const t of threats) {
        const ta = Math.atan2(t.pos[1] - me[1], t.pos[0] - me[0])
        if (Math.abs(wrap(a - ta)) < 0.8) s -= 25
      }
      if (s > bs) (bs = s), (best = [x, y])
    }
    return best
  }

  hurtBy = new Map<number, number>()
  aimedAt = new Map<number, number>()
  isHostile(obs: Observation, e: ActorObs): boolean {
    const pos = obs.self.pos
    const d = d2(e.pos, pos)
    if (!this.P.passive) return true
    if (d < this.P.closeHostile) return true
    if (obs.t - (this.hurtBy.get(e.id) ?? -99) < 12) return true
    const bearing = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
    if (Math.abs(wrap(e.aim[0] - bearing)) < 0.12) {
      if (!this.aimedAt.has(e.id)) this.aimedAt.set(e.id, obs.t)
      if (obs.t - this.aimedAt.get(e.id)! > 0.4) return true
    } else this.aimedAt.delete(e.id)
    // finishing weak targets
    if ((e.hp ?? 1400) < 350 && d < 120) return true
    return false
  }

  roof: { x: number; y: number; z: number; e: number; h: number } | null = null
  roofKey = ""
  roofBan = new Map<string, number>()
  climbStart = -1
  chooseRoof(obs: Observation) {
    const sc = this.safeCircle(obs)
    const pos = obs.self.pos
    let best: any = null, bs = -1e9
    for (const r of this.p.nav.roofs) {
      if (r.h < this.P.roofMinH || r.h > this.P.roofMaxH || r.e < this.P.roofMinE) continue
      const dc = d2([r.x, r.y], sc.c)
      if (dc > sc.r - 12) continue
      if ((this.roofBan.get(`${r.x},${r.y}`) ?? 0) > obs.t) continue
      let s = Math.min(r.e, 20) * 1.5 + Math.min(r.h, 30) * 0.4 - d2([r.x, r.y], pos) * 0.06 - (dc / Math.max(sc.r, 30)) * 8
      for (const tr of this.p.tracks.values()) if (tr.kind === "mech" && obs.t - tr.t < 15) s -= Math.max(0, 80 - d2(tr.pos, [r.x, r.y])) * 0.2
      if (s > bs) (bs = s), (best = r)
    }
    return best
  }
  roofMove(obs: Observation, mode: Mode): { move: number[]; jump: boolean; boost: boolean; mode?: Mode } | null {
    const me = obs.self, pos = me.pos
    const sc = this.safeCircle(obs)
    const key = `${obs.zone.next_center[0].toFixed(0)},${obs.zone.next_radius}`
    if (!this.roof || (this.roofKey !== key && d2([this.roof.x, this.roof.y], sc.c) > sc.r - 12)) {
      this.roof = this.chooseRoof(obs)
      this.roofKey = key
      this.climbStart = -1
    }
    const r = this.roof
    if (!r) return null
    const onRoof = pos[2] > r.z - 1.0 && d2(pos, [r.x, r.y]) < r.e + 6
    if (onRoof) {
      this.climbStart = -1
      const d = d2(pos, [r.x, r.y])
      if (d > 1.5) {
        const a = Math.atan2(r.y - pos[1], r.x - pos[0])
        const sp = Math.min(1, d / 6) * (d > 6 ? 1 : 0.4)
        return { move: [Math.cos(a) * sp, Math.sin(a) * sp], jump: false, boost: false, mode: "camp" }
      }
      return { move: [0, 0], jump: false, boost: false, mode: mode === "fight" ? "fight" : "camp" }
    }
    // don't start a climb mid-fight unless close to the building
    const appr = this.p.nav.nearestFree(r.x, r.y, 40)
    if (appr < 0) {
      this.roofBan.set(`${r.x},${r.y}`, obs.t + 60)
      this.roof = null
      return null
    }
    const ap = this.p.nav.center(appr)
    const dA = d2(pos, ap)
    if (mode === "fight" || mode === "retreat") {
      if (dA > 25) return null
    }
    const need = 1.6 * (r.z - pos[2]) + 8
    if (dA > 4 && this.climbStart < 0) {
      const mv = this.p.steer(ap)
      return { move: mv, jump: false, boost: dA > 80 && me.energy > need + 20, mode: "travel" }
    }
    if (me.energy < need && me.grounded) return { move: [0, 0], jump: false, boost: false, mode: "travel" }
    if (this.climbStart < 0) this.climbStart = obs.t
    if (obs.t - this.climbStart > 9) {
      // failed: ban this roof for a while
      this.roofBan.set(`${r.x},${r.y}`, obs.t + 90)
      this.roof = null
      this.climbStart = -1
      return null
    }
    const a = Math.atan2(r.y - pos[1], r.x - pos[0])
    return { move: [Math.cos(a), Math.sin(a)], jump: me.grounded, boost: !me.grounded || pos[2] < r.z, mode: "travel" }
  }

  losTo(obs: Observation, t: ActorObs): boolean {
    const me = obs.self
    const mz = me.pos[2] + (me.stats.muzzle_height ?? 7)
    const h = t.kind === "mech" ? 9 * (1 + 0.05 * (t.cubes ?? 0)) : 3.5
    return this.p.w.los(me.pos[0], me.pos[1], mz, t.pos[0], t.pos[1], t.pos[2] + h * 0.5) || this.p.w.los(me.pos[0], me.pos[1], mz, t.pos[0], t.pos[1], t.pos[2] + h * 0.9)
  }

  stuckN = 0
  pickMem = new Map<number, { id: number; kind: string; pos: number[]; t: number }>()
  curTarget = -1
  curTargetT = -1e9
  healing = false

  // sidestep vector for bullets that would pass close in the next 0.8 s, or away from mortar impacts
  dodgeVec(obs: Observation): number[] | null {
    const me = obs.self
    const c = [me.pos[0], me.pos[1], me.pos[2] + 4.5]
    let dx = 0, dy = 0, any = false
    const g = this.cfg.weapons.mortar.gravity
    for (const pr of obs.projectiles) {
      const v = pr.vel
      if (pr.kind === "mortar") {
        // predict impact: step until below ground near us
        let p = [...pr.pos], vv = [...v]
        for (let k = 0; k < 60; k++) {
          const dt = 0.1
          p = [p[0] + vv[0] * dt, p[1] + vv[1] * dt, p[2] + vv[2] * dt]
          vv[2] -= g * dt
          if (vv[2] < 0 && p[2] <= this.p.w.surface(p[0], p[1], p[2] + 1) + 0.5) break
        }
        const d = d2(p, c)
        if (d < 10) {
          const a = Math.atan2(c[1] - p[1], c[0] - p[0])
          dx += Math.cos(a) * 1.5
          dy += Math.sin(a) * 1.5
          any = true
        }
        continue
      }
      const rel = [c[0] - pr.pos[0], c[1] - pr.pos[1], c[2] - pr.pos[2]]
      const vv2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
      if (vv2 < 1) continue
      const t = (rel[0] * v[0] + rel[1] * v[1] + rel[2] * v[2]) / vv2
      if (t < 0 || t > 0.8) continue
      const cx = pr.pos[0] + v[0] * t - c[0], cy = pr.pos[1] + v[1] * t - c[1], cz = pr.pos[2] + v[2] * t - c[2]
      const miss = Math.hypot(cx, cy, cz)
      if (miss > 4.5) continue
      // move perpendicular to bullet heading, away from the closest-approach side
      const h = Math.hypot(v[0], v[1]) || 1
      let px = -v[1] / h, py = v[0] / h
      if (px * cx + py * cy > 0) (px = -px), (py = -py)
      dx += px
      dy += py
      any = true
    }
    if (!any) return null
    const L = Math.hypot(dx, dy) || 1
    return [dx / L, dy / L]
  }

  pickUpgrade(obs: Observation): number {
    const ch = obs.offer!.choices
    let bi = 0, br = 1e9
    ch.forEach((c, i) => {
      const r = this.P.upgradeOrder.indexOf(c.id)
      const rr = r < 0 ? 100 : r
      if (rr < br) (br = rr), (bi = i)
    })
    return bi
  }

  // ---------- main ----------
  act(obs: Observation): Omit<Action, "tick"> {
    const p = this.p
    p.update(obs)
    const me = obs.self
    const pos = me.pos
    const act: any = {}
    if (obs.offer) act.pick = this.pickUpgrade(obs)

    for (const s of obs.sounds) if (["gun", "laser", "lightning", "mortar", "step", "boost", "laser_charge", "jet"].includes(s.kind)) this.sounds.push({ t: obs.t - s.age, bearing: s.bearing, kind: s.kind, dist: s.dist })
    this.sounds = this.sounds.filter((s) => obs.t - s.t < 4)
    for (const e of obs.events) {
      if (e.type === "damaged" && e.weapon !== "zone") {
        this.lastHurtT = obs.t
        if (e.bearing !== null) this.lastHurtBearing = e.bearing
        this.lastHurtBy = e.by
        if (e.by !== null) this.hurtBy.set(e.by, obs.t)
      }
      if (e.type === "take_failed") this.lootBan.set(e.id, obs.t + 10)
    }

    const zn = this.zoneNow(obs)
    const sc = this.safeCircle(obs)
    const distC = d2(pos, zn.c)
    const hpFrac = me.hp / me.max_hp

    // threats: enemy mechs seen recently
    const enemies = this.enemies(obs)
    const threats: Track[] = []
    for (const tr of p.tracks.values()) if (tr.kind === "mech" && tr.id !== me.id && obs.t - tr.t < 6 && d2(tr.pos, pos) < 220) threats.push(tr)
    const visible = enemies.filter((e) => d2(e.pos, pos) < 230)
    visible.sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))

    // --------- choose target to shoot ---------
    let target: ActorObs | null = null
    const hostile = visible.filter((e) => this.isHostile(obs, e))
    if (hostile.length) {
      // prefer weakest among close ones
      let bs = 1e9
      for (const e of hostile) {
        let s = d2(e.pos, pos) + (e.hp ?? 1400) * (this.P.secure ? 0.1 : 0.05)
        if (this.P.secure) {
          if ((e.hp ?? 1400) <= 0.3 * (e.max_hp ?? 1400)) s -= 200
          if (e.id === this.curTarget && obs.t - this.curTargetT < 2) s -= 200
        }
        if (this.P.focus) {
          if (e.id === this.curTarget) s -= 40
          if (!this.losTo(obs, e)) s += 60
          s += ((e.hp ?? 1400) / (e.max_hp ?? 1400)) * 40
        }
        if (s < bs) (bs = s), (target = e)
      }
      if (target) (this.curTarget = target.id), (this.curTargetT = obs.t)
    }
    const npcs = obs.mechs.filter((m) => m.kind === "npc")
    // npcs attacking us (close)
    const hostileNpc = npcs.filter((n) => d2(n.pos, pos) < 50).sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))[0]

    // --------- mode selection ---------
    const zoneUrgent = distC > zn.r - 6 || (obs.t > obs.zone.shrink_start - 25 && d2(pos, sc.c) > sc.r - 8)
    const nThreat = visible.filter((e) => d2(e.pos, pos) < this.P.engageRange).length
    const enemyStrength = visible.reduce((s, e) => s + (e.hp ?? 1400), 0)
    let mode: Mode = "travel"
    let goal: number[] = this.camp ?? sc.c
    const phaseKey = `${obs.zone.next_center[0].toFixed(0)},${obs.zone.next_radius}`
    if (this.campPhaseKey !== phaseKey || !this.camp || d2(this.camp, sc.c) > sc.r - 5) {
      this.camp = this.pickCamp(obs)
      this.campPhaseKey = phaseKey
    }

    const outnumbered = nThreat >= 2 && enemyStrength > me.hp * 1.3
    // regen state: once we bailed out, avoid new fights until healed (unless attacked up close)
    if (hpFrac < this.P.fightHpFrac) this.healing = true
    if (hpFrac >= this.P.reengageHp) this.healing = false
    const extra = Math.max(0, nThreat - 1) * this.P.retreatPerExtra
    const weak = (hpFrac < this.P.fightHpFrac + extra || (this.P.reengageHp < 1 && this.healing && !(target && d2(target.pos, pos) < 30))) && (target ? (target.hp ?? 1400) > me.hp * 0.7 : true)
    const recentlyHurt = obs.t - this.lastHurtT < 1.5
    if (!this.P.berserk && nThreat > 0 && (outnumbered || weak)) mode = "retreat"
    else if (target && d2(target.pos, pos) < this.P.engageRange) mode = "fight"
    else if (!this.P.berserk && recentlyHurt && !target) mode = "retreat"
    else mode = "travel"

    // loot opportunities (only when no fight)
    let lootGoal: number[] | null = null
    let lootTake: number | null = null
    // remember weapon pickups we have seen
    for (const pk of obs.pickups) this.pickMem.set(pk.id, { id: pk.id, kind: pk.kind, pos: pk.pos, t: obs.t })
    const visIds = new Set(obs.pickups.map((q) => q.id))
    for (const [id, q] of this.pickMem) if (!visIds.has(id) && (d2(q.pos, pos) < 25 || obs.t - q.t > 120)) this.pickMem.delete(id)
    const fighting = this.P.fightLoot && mode === "fight"
    if ((mode === "travel" || fighting) && !zoneUrgent) {
      const w = me.weapons
      const want = (kind: string) => {
        if (w.some((x) => x?.kind === kind)) return 0
        if (!w[1]) return this.P.weaponPref[kind] ?? 0
        const cur = Math.min(...w.filter((x) => x && x.kind !== "gun").map((x) => this.P.weaponPref[x!.kind] ?? 0))
        return (this.P.weaponPref[kind] ?? 0) - cur - 0.5
      }
      let bs = 0
      for (const pk of this.P.pickMemory ? [...this.pickMem.values()] : obs.pickups) {
        if ((this.lootBan.get(pk.id) ?? 0) > obs.t) continue
        const v = want(pk.kind)
        if (v <= 0) continue
        const d = d2(pk.pos, pos)
        if (d > (fighting ? this.P.fightFetch : w[1] ? this.P.swapR : this.P.lootR) || Math.abs(pk.pos[2] - pos[2]) > 6) continue
        if (d2(pk.pos, zn.c) > zn.r - 10) continue
        const s = v * 100 - d
        if (s > bs) (bs = s), (lootGoal = pk.pos), (lootTake = pk.id)
      }
      if (!lootGoal) {
        let bd = fighting ? this.P.fightCubeR : obs.t < this.P.farmUntil ? 60 : 30
        for (const cu of obs.cubes) {
          const d = d2(cu.pos, pos)
          if (d < bd && Math.abs(cu.pos[2] - pos[2]) < 4 && d2(cu.pos, zn.c) < zn.r - 10) (bd = d), (lootGoal = cu.pos)
        }
      }
      if (!lootGoal && this.P.drops && !fighting) {
        for (const dr of obs.drops) {
          const d = d2(dr.pos, pos)
          const eta = d / 12
          if (d > this.P.dropRange || dr.lands_in > eta + 6) continue
          if (d2(dr.pos, zn.c) > zn.r - 10) continue
          if (dr.holder !== null && dr.holder !== me.id) continue
          let crowded = false
          for (const tr of threats) if (d2(tr.pos, dr.pos) < 70) crowded = true
          if (crowded) continue
          lootGoal = dr.pos
          break
        }
      }
      if (lootGoal) mode = "loot"
    }

    // --------- movement ---------
    let move = [0, 0]
    let boost = false
    let jump = false
    let aim: number[] | null = null
    const tooFarFromZone = distC > zn.r - 4
    if (mode === "retreat") {
      const th = threats.length ? threats : this.lastHurtBy !== null && p.tracks.get(this.lastHurtBy) ? [p.tracks.get(this.lastHurtBy)!] : []
      if (!this.retreatGoal || obs.t > this.retreatUntil || (this.retreatGoal && d2(this.retreatGoal, pos) < 4)) {
        if (th.length) this.retreatGoal = this.findCover(obs, th)
        else {
          // hurt by unseen: move away from bearing
          const a = this.lastHurtBearing + Math.PI
          this.retreatGoal = [pos[0] + Math.cos(a) * 40, pos[1] + Math.sin(a) * 40]
        }
        this.retreatUntil = obs.t + 3
      }
      goal = this.retreatGoal ?? goal
      move = p.steer(goal)
      boost = me.energy > 25
    } else if (mode === "fight" && target && this.P.chase && !this.losTo(obs, target)) {
      // no line of fire: close in to regain it
      move = p.steer(target.pos)
      boost = me.energy > 40 && d2(target.pos, pos) > 40
    } else if (mode === "fight" && target) {
      const d = d2(target.pos, pos)
      const has = (k: string) => this.weaponSlot(obs, k) >= 0 && (me.weapons[this.weaponSlot(obs, k)]!.cooldown < 0.5 || k === "gun")
      let want = this.P.gunDist
      if (has("lightning") && me.energy > 20 && this.P.lightClose) want = 25
      else if (has("laser")) want = Math.max(110, this.P.gunDist)
      else if (has("mortar")) want = 90
      if (this.P.finish > 0 && (target.hp ?? 1400) < 0.38 * (target.max_hp ?? 1400) && hpFrac > 0.42 && nThreat <= 2) want = Math.min(want, this.P.finish)
      const toT = Math.atan2(target.pos[1] - pos[1], target.pos[0] - pos[0])
      if (obs.t > this.strafeUntil) {
        this.strafeDir = p.rnd() < 0.5 ? -1 : 1
        this.strafeUntil = obs.t + this.P.strafeMin + p.rnd() * this.P.strafeVar
      }
      const perp = toT + (this.strafeDir * Math.PI) / 2
      let radial = d > want + 15 ? 1 : d < want - 15 ? -1 : 0
      let mx = Math.cos(perp) + radial * Math.cos(toT) * 0.8
      let my = Math.sin(perp) + radial * Math.sin(toT) * 0.8
      const L = Math.hypot(mx, my)
      move = [mx / L, my / L]
      // avoid walking into walls: test a short probe
      const px = pos[0] + move[0] * 6, py = pos[1] + move[1] * 6
      if (!p.nav.isFree(px, py) && p.nav.isFree(pos[0], pos[1])) {
        this.strafeDir *= -1
        const perp2 = toT + (this.strafeDir * Math.PI) / 2
        move = [Math.cos(perp2), Math.sin(perp2)]
        if (!p.nav.isFree(pos[0] + move[0] * 6, pos[1] + move[1] * 6)) move = p.steer(radial >= 0 ? target.pos : this.camp ?? sc.c)
      }
      if (this.P.fightBoost && me.energy > this.P.fightBoost) boost = true
      // laser dodge
      if (target.charging) {
        const ang = Math.atan2(pos[1] - target.pos[1], pos[0] - target.pos[0])
        if (Math.abs(wrap(target.aim[0] - ang)) < 0.15) boost = me.energy > 10
      }
      if (tooFarFromZone) move = p.steer(this.camp ?? sc.c)
    } else if (mode === "loot" && lootGoal) {
      move = p.steer(lootGoal)
      if (lootTake !== null && d2(lootGoal, pos) < this.cfg.loot.pickup_radius - 0.3) {
        act.take = lootTake
        if (me.weapons[0] && me.weapons[1]) {
          // swap out the worst non-gun weapon
          const s = me.weapons[0]!.kind === "gun" ? 1 : me.weapons[1]!.kind === "gun" ? 0 : (this.P.weaponPref[me.weapons[0]!.kind] ?? 0) < (this.P.weaponPref[me.weapons[1]!.kind] ?? 0) ? 0 : 1
          act.drop = s
        }
        this.lootBan.set(lootTake, obs.t + 3)
      }
    } else {
      goal = this.camp ?? sc.c
      const dg = d2(goal, pos)
      if (dg > 4) move = p.steer(goal)
      const zoneT = obs.zone.shrink_start - obs.t
      // walk silently near camp; hurry if zone pressing
      const urgent = zoneUrgent || dg > 150
      boost = urgent && me.energy > 30 && (tooFarFromZone || dg > 60)
      if (!urgent && (dg < 25 || this.P.silent)) move = [move[0] * 0.4, move[1] * 0.4]
      mode = dg > 4 ? "travel" : "camp"
    }
    if (zoneUrgent && mode !== "fight") boost = me.energy > 15 || boost

    // rooftop holding
    if (this.P.roof && mode !== "loot") {
      const r = this.roofMove(obs, mode)
      if (r) {
        move = r.move
        jump = r.jump
        boost = r.boost
        if (r.mode) mode = r.mode
      }
    }

    // dodge incoming projectiles
    if (this.P.dodge && this.climbStart < 0) {
      const dv = this.dodgeVec(obs)
      if (dv) {
        const mx = move[0] * 0.4 + dv[0], my = move[1] * 0.4 + dv[1]
        const L = Math.hypot(mx, my) || 1
        const cand = [mx / L, my / L]
        if (p.nav.isFree(pos[0] + cand[0] * 4, pos[1] + cand[1] * 4) || !p.nav.isFree(pos[0], pos[1])) {
          move = cand
          if (me.grounded && me.energy > 15) boost = true
        }
      }
    }
    // unstick
    const wantMove = Math.hypot(move[0], move[1]) > 0.3
    if (obs.t < p.unstickUntil) {
      move = p.unstickDir
      jump = me.grounded
      boost = true
    } else if (this.climbStart < 0 && p.stuck(wantMove)) {
      p.unstickUntil = obs.t + 0.9
      this.stuckN = (this.stuckN ?? 0) + 1
      const a = Math.atan2(move[1], move[0]) + (p.rnd() - 0.5) * 2.5
      p.unstickDir = [Math.cos(a), Math.sin(a)]
      p.hist.length = 0
      p.path = null
      jump = me.grounded
    }

    // --------- aiming & firing ---------
    const fire = [false, false]
    let shootAt: ActorObs | null = target && d2(target.pos, pos) < 230 ? target : null
    if (!shootAt && hostileNpc) shootAt = hostileNpc
    // farm crates/npcs when calm
    let farm: any = null
    if (this.P.farm && !shootAt && !zoneUrgent && mode !== "retreat") {
      const farmR = obs.t < this.P.farmUntil ? 90 : 45
      let bd = farmR
      for (const n of npcs) {
        const d = d2(n.pos, pos)
        if (d < bd && me.hp > me.max_hp * this.P.farmHp) (bd = d), (farm = n)
      }
      if (me.hp > me.max_hp * this.P.farmHp * 0.8) for (const c of obs.crates) {
        const d = d2(c.pos, pos)
        if (d < bd * 0.8) (bd = d / 0.8), (farm = { id: c.id, pos: c.pos, vel: [0, 0, 0], kind: "crate" })
      }
      if (farm && farm.kind !== "crate" && farm.kind !== "npc") farm = null
    }
    const tgt: any = shootAt && (!this.P.losGate || this.losTo(obs, shootAt)) ? shootAt : shootAt && this.P.losGate ? null : farm
    if (tgt) {
      const zOff = tgt.kind === "mech" ? 4.5 * (1 + 0.05 * (tgt.cubes ?? 0)) : tgt.kind === "npc" ? 1.75 : 1.2
      const d = d2(tgt.pos, pos)
      for (let s = 0; s < 2; s++) {
        const wp = me.weapons[s]
        if (!wp) continue
        if (wp.kind === "gun") {
          const L = p.leadAim(tgt.pos, tgt.vel, wp.stats.speed, zOff)
          if (!aim) aim = L.aim
          const tol = Math.atan2(tgt.kind === "mech" ? 2.2 : 1.4, L.dist) + 0.01
          if (L.dist < wp.stats.range && p.aimError(L.aim) < tol && (wp.ammo ?? 1) > 0) fire[s] = true
        } else if (wp.kind === "laser" && tgt.kind !== "crate") {
          const L = p.leadAim(tgt.pos, tgt.vel, Infinity, zOff)
          // lead a bit for 0.1 s latency
          const L2 = p.leadAim([tgt.pos[0] + tgt.vel[0] * 0.1, tgt.pos[1] + tgt.vel[1] * 0.1, tgt.pos[2]], tgt.vel, Infinity, zOff)
          if (L.dist < wp.stats.range) {
            aim = L2.aim
            const charge = wp.charge ?? 0
            const full = wp.stats.charge
            if (wp.cooldown <= 0.05 || charge > 0) {
              const tol = Math.atan2(1.8, L.dist)
              const ready = charge >= full - 0.02
              fire[s] = !(ready && p.aimError(L2.aim) < tol)
              if (charge > full + 1.5) fire[s] = false
            }
          }
        } else if (wp.kind === "lightning") {
          const yawTo = Math.atan2(tgt.pos[1] - pos[1], tgt.pos[0] - pos[0])
          if (d < wp.stats.range - 2 && Math.abs(wrap(yawTo - me.aim[0])) < ((wp.stats.cone_deg * Math.PI) / 180) * 0.8 && me.energy > 8 && wp.cooldown <= 0) fire[s] = true
        } else if (wp.kind === "mortar" && tgt.kind !== "crate") {
          if (d > 25 && d < 220) {
            const tof0 = d / 60
            const tp = [tgt.pos[0] + tgt.vel[0] * tof0, tgt.pos[1] + tgt.vel[1] * tof0, tgt.pos[2]]
            const h = d2(tp, pos)
            const muzzleZ = pos[2] + 9.5
            const pitch = p.mortarPitch(h, tp[2] - muzzleZ, false)
            if (pitch !== null && wp.cooldown <= 0) {
              const ma = [Math.atan2(tp[1] - pos[1], tp[0] - pos[0]), pitch]
              // only aim mortar if gun is not aiming
              if (!fire[0] && !fire[1] && (!me.weapons.some((x) => x?.kind === "gun") || d > 120)) aim = ma
              if (p.aimError(ma) < 0.04) fire[s] = true
            }
          }
        }
      }
    }
    // gun reload when idle
    // hold fire (keep the aim) when the target is behind a wall
    if (this.P.holdFire && tgt && tgt === shootAt && !this.losTo(obs, tgt)) {
      for (let k = 0; k < 2; k++) if (me.weapons[k]?.kind !== "laser") fire[k] = false
    }
    const g = me.weapons.find((w) => w?.kind === "gun")
    if (g && !tgt && (g.ammo ?? 12) < (g.stats.mag ?? 12) * 0.6 && (g.reload ?? 0) <= 0) act.reload = true

    if (!aim) {
      // look toward threats / sounds / hurt bearing, else scan
      let look: number | null = null
      if (obs.t - this.lastHurtT < 2) look = this.lastHurtBearing
      else if (threats.length) {
        const t0 = threats.sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))[0]
        look = Math.atan2(t0.pos[1] - pos[1], t0.pos[0] - pos[0])
      } else {
        const s = this.sounds.filter((s) => s.kind !== "step" || s.dist === "near").sort((a, b) => b.t - a.t)[0]
        if (s && obs.t - s.t < 2.5) look = s.bearing
      }
      if (look === null) {
        if (this.P.spinScan && !me.weapons[1] && obs.t < 90) this.scanYaw = wrap(this.scanYaw + 0.5)
        else if (mode === "travel" && Math.hypot(move[0], move[1]) > 0.3) {
          const mv = Math.atan2(move[1], move[0])
          this.scanYaw = mv + Math.sin(obs.t * 1.3) * 0.9
        } else this.scanYaw = wrap(this.scanYaw + 0.35)
        look = this.scanYaw
      } else this.scanYaw = look
      aim = [look, 0]
    }

    // retreat: face threat while backing off (front armor)
    if (mode === "retreat" && !tgt && threats.length) {
      const t0 = threats[0]
      aim = [Math.atan2(t0.pos[1] - pos[1], t0.pos[0] - pos[0]), 0]
    }

    act.move = move
    // boost in the air means jetting upward: only when climbing or unsticking
    if (!me.grounded && this.climbStart < 0 && obs.t >= p.unstickUntil) boost = false
    act.boost = boost
    act.jump = jump
    act.aim = aim
    act.fire = fire
    if (this.P.debug) {
      draw.label(`${mode} hp${Math.round(me.hp)} e${Math.round(me.energy)}`)
    }
    ;(this as any).lastMode = mode
    return act
  }
}
