// Approximate mechfight/1 simulator for local testing. Not the real server.
import type { Action, Hello, Observation, Bot, GameEvent, WeaponObs } from "../src/mechfight.ts"
import { World, K } from "../src/world.ts"

export type Rng = () => number
export function mulberry(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const gauss = (r: Rng) => {
  let u = 0, v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

type Weapon = { kind: string; cooldown: number; ammo: number; reload: number; charge: number; charging: boolean; equip: number }
export type Mech = {
  id: number; pos: number[]; vel: number[]; yaw: number; pitch: number; cyaw: number; cpitch: number
  hp: number; energy: number; cubes: number; ups: Record<string, number>; weapons: (Weapon | null)[]
  alive: boolean; grounded: boolean; lastCombat: number; lastSpend: number; deathT: number; place: number; kills: number
  act: Action; lastAnswer: number; events: GameEvent[]; offers: any[]; offer: any; offerId: number
  seen: Map<number, number>; stepT: number; shortUntil: number; house: boolean; team: string; bot: Bot | null
  sounds: any[]; beams: any[]; prevFire: boolean[]; inZone: boolean; dmgTaken: number; dmgDealt: number
  hunter?: boolean
}
type Npc = { id: number; pos: number[]; vel: number[]; home: number[]; hp: number; target: number | null; cd: number; yaw: number; wander: number[]; wt: number }
type Proj = { id: number; kind: string; owner: number; pos: number[]; vel: number[]; dist: number; range: number; dmg: number; ttl: number }

export class Sim {
  w: World
  cfg: any
  r: Rng
  t = 0
  tick = 0
  mechs: Mech[] = []
  npcs: Npc[] = []
  crates: { id: number; pos: number[]; hp: number }[] = []
  cubes: { id: number; pos: number[] }[] = []
  pickups: { id: number; kind: string; pos: number[] }[] = []
  projs: Proj[] = []
  drops: any[] = []
  nextId = { npc: 100, crate: 1000, cube: 5000, pickup: 8000, proj: 1, drop: 20000 }
  zc: number[]
  zr: number
  zone: { center: number[]; radius: number; next_center: number[]; next_radius: number; shrink_start: number; shrink_end: number; dps: number }
  phase = 0
  phaseStart = 0
  log: string[] = []
  ended = false
  hello: (slot: number) => Hello

  constructor(w: World, cfg: any, seed: number) {
    this.w = w
    this.cfg = cfg
    this.r = mulberry(seed)
    const z = cfg.zone
    this.zc = [...z.start_center]
    this.zr = z.start_radius
    this.zone = { center: [...this.zc], radius: this.zr, next_center: [0, 0], next_radius: 0, shrink_start: 0, shrink_end: 0, dps: 0 }
    this.setupPhase(0, 0)
    this.hello = (slot) => ({ type: "hello", protocol: "mechfight/1", slot, seed: 1000 + slot, map: { dir: "arena", files: [] }, config: cfg } as any)
  }

  setupPhase(p: number, start: number) {
    const ph = this.cfg.zone.phases[p]
    this.phase = p
    this.phaseStart = start
    const cur = { c: [...this.zc], r: this.zr }
    let nc = cur.c
    if (ph) {
      const room = Math.max(0, cur.r - ph.radius)
      for (let tries = 0; tries < 50; tries++) {
        const a = this.r() * 2 * Math.PI, d = Math.sqrt(this.r()) * room
        const c = [cur.c[0] + Math.cos(a) * d, cur.c[1] + Math.sin(a) * d]
        const m = Math.min(ph.radius, 60)
        if (c[0] > this.w.minX + m && c[0] < this.w.maxX - m && c[1] > this.w.minY + m && c[1] < this.w.maxY - m) {
          nc = c
          break
        }
      }
      this.zone = { center: cur.c, radius: cur.r, next_center: nc, next_radius: ph.radius, shrink_start: start + ph.hold_s, shrink_end: start + ph.hold_s + ph.shrink_s, dps: ph.dps }
    } else {
      this.zone = { center: cur.c, radius: cur.r, next_center: cur.c, next_radius: cur.r, shrink_start: 1e9, shrink_end: 1e9, dps: this.cfg.zone.phases.at(-1).dps }
    }
  }

  updateZone() {
    const z = this.zone
    if (this.t >= z.shrink_end) {
      this.zc = [...z.next_center]
      this.zr = z.next_radius
      if (this.phase + 1 < this.cfg.zone.phases.length) this.setupPhase(this.phase + 1, z.shrink_end)
      else if (this.phase + 1 === this.cfg.zone.phases.length) {
        this.phase++
        this.zone = { center: this.zc, radius: this.zr, next_center: this.zc, next_radius: this.zr, shrink_start: 1e9, shrink_end: 1e9, dps: z.dps }
      }
    }
  }
  zoneNow(): { c: number[]; r: number } {
    const z = this.zone
    if (this.t <= z.shrink_start) return { c: z.center, r: z.radius }
    const f = Math.min(1, (this.t - z.shrink_start) / (z.shrink_end - z.shrink_start))
    return { c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f], r: z.radius + (z.next_radius - z.radius) * f }
  }

  // ---------- setup ----------
  openGround(x: number, y: number, clear = 3): boolean {
    if (!this.w.inBounds(x, y)) return false
    const g = this.w.terrain(x, y)
    for (let dx = -clear; dx <= clear; dx += clear) for (let dy = -clear; dy <= clear; dy += clear) {
      const c = this.w.cell(x + dx, y + dy)
      if (c < 0) return false
      for (let k = 0; k < this.w.cnt[c]; k++) if (this.w.top[c * K + k] > g + 1.2 && this.w.base[c * K + k] < g + 10) return false
      if (Math.abs(this.w.terrain(x + dx, y + dy) - g) > 2.5) return false
    }
    return true
  }
  roofSpot(): number[] | null {
    for (let tries = 0; tries < 200; tries++) {
      const x = this.w.minX + 30 + this.r() * (this.w.maxX - this.w.minX - 60), y = this.w.minY + 30 + this.r() * (this.w.maxY - this.w.minY - 60)
      const c = this.w.cell(x, y)
      if (c < 0 || this.w.cnt[c] === 0) continue
      const top = this.w.top[c * K + this.w.cnt[c] - 1]
      if (top - this.w.terrain(x, y) < 4) continue
      let ok = true
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) if (Math.abs(this.w.surface(x + dx, y + dy, top + 1) - top) > 0.5) ok = false
      if (ok) return [x, y, top]
    }
    return null
  }
  groundSpot(inZone = true, frac = 0.95): number[] {
    for (let tries = 0; tries < 500; tries++) {
      let x: number, y: number
      if (inZone) {
        const a = this.r() * 2 * Math.PI, d = Math.sqrt(this.r()) * this.zr * frac
        x = this.zc[0] + Math.cos(a) * d
        y = this.zc[1] + Math.sin(a) * d
      } else {
        x = this.w.minX + 30 + this.r() * (this.w.maxX - this.w.minX - 60)
        y = this.w.minY + 30 + this.r() * (this.w.maxY - this.w.minY - 60)
      }
      if (x < this.w.minX + 30 || x > this.w.maxX - 30 || y < this.w.minY + 30 || y > this.w.maxY - 30) continue
      if (this.openGround(x, y)) return [x, y, this.w.terrain(x, y)]
    }
    return [this.zc[0], this.zc[1], this.w.terrain(this.zc[0], this.zc[1])]
  }

  addMech(bot: Bot | null, house: boolean, team: string): Mech {
    const id = this.mechs.length
    const m: Mech = {
      id, pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, cyaw: 0, cpitch: 0, hp: this.cfg.mech.hp, energy: this.cfg.mech.energy, cubes: 0, ups: {},
      weapons: [{ kind: "gun", cooldown: 0, ammo: this.cfg.weapons.gun.mag, reload: 0, charge: 0, charging: false, equip: 0 }, null],
      alive: true, grounded: true, lastCombat: -99, lastSpend: -99, deathT: 0, place: 0, kills: 0, act: { tick: 0 } as Action, lastAnswer: 0,
      events: [], offers: [], offer: null, offerId: 1, seen: new Map(), stepT: 0, shortUntil: -1, house, team, bot, sounds: [], beams: [], prevFire: [false, false],
      inZone: true, dmgTaken: 0, dmgDealt: 0,
    }
    this.mechs.push(m)
    return m
  }

  setup() {
    const cfg = this.cfg
    // spawns
    const sep = cfg.match.spawn_min_separation
    for (const m of this.mechs) {
      let best: number[] | null = null
      for (let tries = 0; tries < 300; tries++) {
        const p = this.groundSpot(true, cfg.match.spawn_zone_fraction)
        let ok = true
        for (const o of this.mechs) if (o !== m && o.pos[0] !== 0 && Math.hypot(o.pos[0] - p[0], o.pos[1] - p[1]) < sep * (tries < 200 ? 1 : 0.6)) ok = false
        if (ok) {
          best = p
          break
        }
      }
      m.pos = best ?? this.groundSpot(true)
      m.yaw = m.cyaw = this.r() * 2 * Math.PI - Math.PI
    }
    for (let k = 0; k < cfg.npc.count; k++) {
      const p = this.groundSpot(true, 0.9)
      this.npcs.push({ id: this.nextId.npc++, pos: p, vel: [0, 0, 0], home: [...p], hp: cfg.npc.hp, target: null, cd: 0, yaw: 0, wander: [...p], wt: 0 })
    }
    for (let k = 0; k < cfg.crates.count; k++) {
      const p = (this.r() < cfg.crates.roof_fraction && this.roofSpot()) || this.groundSpot(false)
      this.crates.push({ id: this.nextId.crate++, pos: p, hp: cfg.crates.hp })
    }
    for (let k = 0; k < cfg.loot.floor_count; k++) {
      const p = (this.r() < cfg.loot.floor_roof_fraction && this.roofSpot()) || this.groundSpot(false)
      this.pickups.push({ id: this.nextId.pickup++, kind: this.randWeapon(), pos: p })
    }
  }
  randWeapon(): string {
    const w = this.cfg.loot.weights
    const ks = Object.keys(w)
    let tot = 0
    for (const k of ks) tot += w[k]
    let x = this.r() * tot
    for (const k of ks) {
      x -= w[k]
      if (x < 0) return k
    }
    return "mortar"
  }

  // ---------- stats ----------
  mstat(m: Mech, key: string): number {
    let v = this.cfg.mech[key]
    for (const u of this.cfg.upgrades) {
      const n = m.ups[u.id] ?? 0
      if (!n) continue
      for (const e of u.effects) if (e.path === "mech." + key) for (let i = 0; i < n; i++) v = e.mul !== undefined ? v * e.mul : v + e.add
    }
    return v
  }
  wstat(m: Mech, kind: string, key: string): number {
    let v = this.cfg.weapons[kind][key]
    for (const u of this.cfg.upgrades) {
      const n = m.ups[u.id] ?? 0
      if (!n) continue
      for (const e of u.effects) if (e.path === `weapons.${kind}.${key}`) for (let i = 0; i < n; i++) v = e.mul !== undefined ? v * e.mul : v + e.add
    }
    return v
  }
  scale(m: Mech) {
    return 1 + this.cfg.cubes.size_per_cube * m.cubes
  }
  maxHp(m: Mech) {
    return this.mstat(m, "hp") * (1 + this.cfg.cubes.hp_per_cube * Math.min(m.cubes, this.cfg.cubes.stat_cap))
  }
  radius(m: Mech) {
    return this.cfg.mech.radius * this.scale(m)
  }
  height(m: Mech) {
    return this.cfg.mech.height * this.scale(m)
  }

  // ---------- vision ----------
  canSee(m: Mech, tx: number, ty: number, tz: number, th: number): boolean {
    const eye = m.pos[2] + this.cfg.mech.eye_height * this.scale(m)
    const dx = tx - m.pos[0], dy = ty - m.pos[1]
    const d = Math.hypot(dx, dy)
    const near = this.cfg.vision.near_range + this.mstat(m, "near_range_bonus")
    const range = this.cfg.vision.range + this.mstat(m, "vision_bonus")
    if (d > near) {
      if (d > range) return false
      if (Math.abs(wrap(Math.atan2(dy, dx) - m.yaw)) > (this.cfg.vision.fov_deg * Math.PI) / 360) return false
    }
    return this.w.los(m.pos[0], m.pos[1], eye, tx, ty, tz + th / 2) || this.w.los(m.pos[0], m.pos[1], eye, tx, ty, tz + th)
  }

  // ---------- damage ----------
  damage(src: Mech | null, victimId: number, amount: number, weapon: string, from: number[] | null, effect?: string) {
    if (victimId < 100) {
      const v = this.mechs[victimId]
      if (!v.alive) return
      let dmg = amount
      let rear = false
      if (from) {
        const b = Math.atan2(from[1] - v.pos[1], from[0] - v.pos[0])
        if (Math.abs(wrap(b - v.yaw)) > (this.cfg.mech.front_arc_deg * Math.PI) / 360) {
          rear = true
          dmg *= this.cfg.mech.rear_mult
        }
      }
      if (weapon !== "zone") dmg *= 1 - Math.min(0.9, this.mstat(v, "armor"))
      if (src && src.id === v.id) dmg *= this.cfg.mech.self_damage_mult
      v.hp -= dmg
      v.dmgTaken += dmg
      ;(v as any).lastW = weapon + ':' + (src ? src.id : 'z')
      if (weapon !== "zone") v.lastCombat = this.t
      const bearing = from ? Math.atan2(from[1] - v.pos[1], from[0] - v.pos[0]) : null
      v.events.push({ type: "damaged", amount: Math.round(dmg), weapon, bearing, by: src ? src.id : null, ...(rear ? { rear } : {}) } as any)
      if (src && src.id !== v.id) {
        src.lastCombat = this.t
        src.dmgDealt += dmg
        src.events.push({ type: "hit", target: v.id, amount: Math.round(dmg), weapon, ...(effect ? { effect } : {}), ...(rear ? { rear } : {}) } as any)
      }
      if (v.hp <= 0) this.kill(v, src)
    } else if (victimId < 1000) {
      const n = this.npcs.find((n) => n.id === victimId)
      if (!n) return
      n.hp -= amount
      if (src) {
        n.target = src.id
        src.lastCombat = this.t
        src.events.push({ type: "hit", target: n.id, amount: Math.round(amount), weapon } as any)
      }
      if (n.hp <= 0) {
        this.npcs = this.npcs.filter((q) => q !== n)
        for (let k = 0; k < this.cfg.npc.cubes; k++) this.spawnCube(n.pos)
      }
    } else if (victimId < 5000) {
      const c = this.crates.find((c) => c.id === victimId)
      if (!c) return
      c.hp -= amount
      if (src) src.events.push({ type: "hit", target: c.id, amount: Math.round(amount), weapon } as any)
      if (c.hp <= 0) {
        this.crates = this.crates.filter((q) => q !== c)
        for (let k = 0; k < this.cfg.crates.cubes; k++) this.spawnCube(c.pos)
        if (this.r() < this.cfg.loot.crate_weapon_chance) this.pickups.push({ id: this.nextId.pickup++, kind: this.randWeapon(), pos: [c.pos[0] + 1, c.pos[1], c.pos[2]] })
      }
    }
  }
  dmgMult(m: Mech) {
    return 1 + this.cfg.cubes.damage_per_cube * Math.min(m.cubes, this.cfg.cubes.stat_cap)
  }
  spawnCube(p: number[]) {
    const a = this.r() * 6.28, d = this.r() * 2
    this.cubes.push({ id: this.nextId.cube++, pos: [p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d, p[2]] })
  }
  pendingDeaths: Mech[] = []
  kill(v: Mech, src: Mech | null) {
    v.alive = false
    v.deathT = this.t
    this.log.push(`${this.t.toFixed(1)} ${v.id}${v.house ? 'h' : ''} died ${(v as any).lastW ?? 'zone'} pos ${v.pos.map((x) => x.toFixed(0))}`)
    this.pendingDeaths.push(v)
    if (src && src.id !== v.id) {
      src.kills++
      src.events.push({ type: "kill", target: v.id } as any)
    }
    for (let k = 0; k < v.cubes + this.cfg.cubes.death_drop_extra; k++) this.spawnCube(v.pos)
    for (const wp of v.weapons) if (wp && wp.kind !== "gun") this.pickups.push({ id: this.nextId.pickup++, kind: wp.kind, pos: [v.pos[0] + this.r() * 2 - 1, v.pos[1] + this.r() * 2 - 1, v.pos[2]] })
    this.sound("death", v.pos)
  }

  sound(kind: string, p: number[], by = -1) {
    const range = this.cfg.sound.range[kind] ?? 100
    for (const m of this.mechs) {
      if (!m.alive || m.id === by) continue
      const d = Math.hypot(p[0] - m.pos[0], p[1] - m.pos[1])
      if (d > range) continue
      const noise = (this.cfg.sound.bearing_noise_deg * Math.PI) / 180 * this.mstat(m, "hearing")
      m.sounds.push({ kind, bearing: wrap(Math.atan2(p[1] - m.pos[1], p[0] - m.pos[0]) + gauss(this.r) * noise), dist: d < this.cfg.sound.near ? "near" : d < this.cfg.sound.mid ? "mid" : "far", age: 0, _t: this.t })
    }
  }

  // ---------- observation ----------
  weaponObs(m: Mech, wp: Weapon | null): WeaponObs | null {
    if (!wp) return null
    const stats: Record<string, number> = {}
    for (const k of Object.keys(this.cfg.weapons[wp.kind])) stats[k] = this.wstat(m, wp.kind, k)
    const o: any = { kind: wp.kind, cooldown: Math.max(0, wp.cooldown, wp.equip), stats }
    if (wp.kind === "gun") {
      o.ammo = wp.ammo
      o.reload = wp.reload
    }
    if (wp.kind === "laser") o.charge = wp.charge
    return o
  }
  observe(m: Mech): Observation {
    const sc = this.scale(m)
    const stats: Record<string, number> = {}
    for (const k of Object.keys(this.cfg.mech)) stats[k] = this.mstat(m, k)
    stats.eye_height = this.cfg.mech.eye_height * sc
    stats.muzzle_height = this.cfg.mech.muzzle_height * sc
    stats.radius = this.cfg.mech.radius * sc
    stats.height = this.cfg.mech.height * sc
    const zn = this.zoneNow()
    const mechs: any[] = []
    for (const o of this.mechs) {
      if (o === m || !o.alive) continue
      let vis = this.canSee(m, o.pos[0], o.pos[1], o.pos[2], this.height(o))
      if (vis) m.seen.set(o.id, this.t)
      else if (this.t - (m.seen.get(o.id) ?? -99) <= this.cfg.vision.memory_s) vis = true
      if (!vis) continue
      mechs.push({ id: o.id, kind: "mech", pos: [...o.pos], vel: [...o.vel], aim: [o.yaw, o.pitch], hp: o.hp, max_hp: this.maxHp(o), cubes: o.cubes, weapons: o.weapons.filter((x) => x).map((x) => x!.kind), charging: !!o.weapons.find((x) => x && x.charging) })
    }
    for (const n of this.npcs) {
      let vis = this.canSee(m, n.pos[0], n.pos[1], n.pos[2], this.cfg.npc.height)
      if (vis) m.seen.set(n.id, this.t)
      else if (this.t - (m.seen.get(n.id) ?? -99) <= this.cfg.vision.memory_s) vis = true
      if (vis) mechs.push({ id: n.id, kind: "npc", pos: [...n.pos], vel: [...n.vel], aim: [n.yaw, 0], hp: n.hp, max_hp: this.cfg.npc.hp })
    }
    const vis = (p: number[], h: number) => this.canSee(m, p[0], p[1], p[2], h)
    const ev = m.events
    m.events = []
    const snd = m.sounds.map((s) => ({ kind: s.kind, bearing: s.bearing, dist: s.dist, age: Math.round((this.t - s._t) * 100) / 100 }))
    m.sounds = []
    const beams = m.beams
    m.beams = []
    return {
      type: "obs", tick: this.tick, t: Math.round(this.t * 100) / 100, alive: this.mechs.filter((x) => x.alive).length,
      self: {
        id: m.id, pos: [...m.pos], vel: [...m.vel], aim: [m.yaw, m.pitch], hp: m.hp, max_hp: this.maxHp(m), energy: m.energy, max_energy: this.mstat(m, "energy"),
        grounded: m.grounded, cubes: m.cubes, upgrades: Object.entries(m.ups).flatMap(([k, n]) => Array(n).fill(k)), in_zone: m.inZone,
        weapons: [this.weaponObs(m, m.weapons[0]), this.weaponObs(m, m.weapons[1])], stats,
      },
      mechs,
      projectiles: this.projs.filter((p) => p.owner !== m.id && vis(p.pos, 0.2)).map((p) => ({ id: p.id, kind: p.kind === "npc" ? "npc" : p.kind, pos: [...p.pos], vel: [...p.vel] })),
      crates: this.crates.filter((c) => vis(c.pos, 2.4)).map((c) => ({ id: c.id, pos: [...c.pos], hp: c.hp })),
      cubes: this.cubes.filter((c) => vis(c.pos, 0.5)).map((c) => ({ id: c.id, pos: [...c.pos] })),
      pickups: this.pickups.filter((c) => vis(c.pos, 0.5)).map((c) => ({ id: c.id, kind: c.kind, pos: [...c.pos] })),
      sounds: snd, beams, events: ev,
      drops: this.drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: [...d.pos], radius: this.cfg.drops.radius, lands_in: Math.max(0, d.landT - this.t), capture_s: this.cfg.drops.capture_s, progress: d.progress, holder: d.holder })),
      zone: { center: [...this.zone.center], radius: this.zone.radius, next_center: [...this.zone.next_center], next_radius: this.zone.next_radius, shrink_start: this.zone.shrink_start, shrink_end: this.zone.shrink_end, dps: this.zone.dps } as any,
      offer: m.offer,
    } as any
  }

  // ---------- step ----------
  decide() {
    for (const m of this.mechs) {
      if (!m.alive || !m.bot) continue
      const obs = this.observe(m)
      let a: any
      try {
        a = m.bot.act(obs) ?? {}
      } catch (e) {
        if (!(globalThis as any).__simErr) {
          ;(globalThis as any).__simErr = 1
          console.error("bot error", e)
        }
        a = { move: m.act.move, aim: m.act.aim, boost: m.act.boost }
      }
      a.tick = this.tick
      this.applyAction(m, a)
    }
  }
  applyAction(m: Mech, a: any) {
    m.act = a
    if (a.aim) {
      m.cyaw = a.aim[0]
      m.cpitch = Math.max(this.cfg.mech.min_pitch, Math.min(this.cfg.mech.max_pitch, a.aim[1]))
    }
    if (a.pick !== undefined && m.offer) {
      const ch = m.offer.choices[a.pick] ?? m.offer.choices[0]
      this.applyUpgrade(m, ch.id)
    }
    if (a.jump && m.grounded) {
      m.vel[2] = this.cfg.mech.jump_speed
      m.grounded = false
    }
    if (a.reload) {
      const g = m.weapons.find((w) => w?.kind === "gun")
      if (g && g.reload <= 0 && g.ammo < this.wstat(m, "gun", "mag")) g.reload = this.wstat(m, "gun", "reload")
    }
    if (a.take !== undefined) this.take(m, a.take, a.drop)
    else if (a.drop !== undefined) {
      const wp = m.weapons[a.drop]
      if (wp && !wp.charging) {
        const id = this.nextId.pickup++
        this.pickups.push({ id, kind: wp.kind, pos: [...m.pos] })
        m.weapons[a.drop] = null
        m.events.push({ type: "dropped", id, kind: wp.kind, slot: a.drop } as any)
      }
    }
  }
  take(m: Mech, id: number, drop?: number) {
    const p = this.pickups.find((p) => p.id === id)
    if (!p) return m.events.push({ type: "take_failed", id, reason: "gone" } as any)
    if (Math.hypot(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) > this.cfg.loot.pickup_radius || Math.abs(p.pos[2] - m.pos[2]) > 4) return m.events.push({ type: "take_failed", id, reason: "range" } as any)
    if (m.weapons.some((w) => w?.kind === p.kind)) return m.events.push({ type: "take_failed", id, reason: "have" } as any)
    let slot = m.weapons[0] === null ? 0 : m.weapons[1] === null ? 1 : -1
    if (slot < 0) {
      if (drop === undefined) return m.events.push({ type: "take_failed", id, reason: "full" } as any)
      const old = m.weapons[drop]!
      if (old.charging) return m.events.push({ type: "take_failed", id, reason: "busy" } as any)
      const nid = this.nextId.pickup++
      this.pickups.push({ id: nid, kind: old.kind, pos: [...m.pos] })
      m.events.push({ type: "dropped", id: nid, kind: old.kind, slot: drop } as any)
      slot = drop
    }
    this.pickups = this.pickups.filter((q) => q !== p)
    const cd = this.cfg.weapons[p.kind].cooldown
    m.weapons[slot] = { kind: p.kind, cooldown: 0, ammo: this.wstat(m, "gun", "mag"), reload: 0, charge: 0, charging: false, equip: Math.max(this.cfg.loot.equip_s, cd) }
    m.events.push({ type: "took", id, kind: p.kind, slot } as any)
  }
  applyUpgrade(m: Mech, id: string) {
    m.ups[id] = (m.ups[id] ?? 0) + 1
    const before = m.hp
    m.offer = null
    m.events.push({ type: "upgrade", id } as any)
    if (id === "plating") m.hp = before * this.cfg.upgrades.find((u: any) => u.id === "plating").effects[0].mul
    if (m.offers.length) this.presentOffer(m)
  }
  presentOffer(m: Mech) {
    const held = m.weapons.filter((w) => w).map((w) => w!.kind)
    const elig = this.cfg.upgrades.filter((u: any) => (m.ups[u.id] ?? 0) < u.max && (!u.requires || held.includes(u.requires)))
    const ch: any[] = []
    while (ch.length < 3 && elig.length) ch.push(elig.splice(Math.floor(this.r() * elig.length), 1)[0])
    m.offers.shift()
    m.offer = { id: m.offerId++, expires: this.t + this.cfg.bot.offer_timeout_s, choices: ch.map((u) => ({ id: u.id, name: u.name, desc: u.desc })) }
  }
  addCube(m: Mech, n = 1) {
    const oldMax = this.maxHp(m)
    const before = m.cubes
    m.cubes += n
    m.hp += this.maxHp(m) - oldMax
    for (const th of this.cfg.cubes.upgrade_thresholds) if (before < th && m.cubes >= th) {
      m.offers.push(1)
      if (!m.offer) this.presentOffer(m)
    }
  }

  stepMech(m: Mech, dt: number) {
    const cfg = this.cfg.mech
    const a: any = m.act
    // aim slew
    const tr = this.mstat(m, "turn_rate") * dt, pr = this.mstat(m, "pitch_rate") * dt
    const dy = wrap(m.cyaw - m.yaw)
    m.yaw = wrap(m.yaw + Math.max(-tr, Math.min(tr, dy)))
    m.pitch += Math.max(-pr, Math.min(pr, m.cpitch - m.pitch))
    // movement
    let mv = a.move ?? [0, 0]
    let L = Math.hypot(mv[0], mv[1])
    if (L > 1) mv = [mv[0] / L, mv[1] / L], (L = 1)
    const charging = m.weapons.some((w) => w?.charging)
    let speed = this.mstat(m, "walk_speed")
    let spending = false
    if (a.boost && m.grounded && L > 0.05 && m.energy > 0) {
      speed = this.mstat(m, "boost_speed")
      m.energy -= this.mstat(m, "boost_drain") * dt
      spending = true
    }
    if (charging) speed *= cfg.charge_move_mult
    const acc = (m.grounded ? cfg.ground_accel : cfg.air_accel) * dt
    for (let k = 0; k < 2; k++) {
      const d = mv[k] * speed - m.vel[k]
      m.vel[k] += Math.max(-acc, Math.min(acc, d))
    }
    if (a.boost && !m.grounded && m.energy > 0) {
      m.vel[2] = Math.min(cfg.max_rise_speed, m.vel[2] + cfg.jet_accel * dt)
      m.energy -= this.mstat(m, "jet_drain") * dt
      spending = true
    }
    if (spending) m.lastSpend = this.t
    else if (this.t - m.lastSpend >= cfg.energy_regen_delay) m.energy = Math.min(this.mstat(m, "energy"), m.energy + this.mstat(m, "energy_regen") * dt)
    m.energy = Math.max(0, m.energy)
    m.vel[2] -= cfg.gravity * dt
    // horizontal collision
    const nx = m.pos[0] + m.vel[0] * dt, ny = m.pos[1] + m.vel[1] * dt
    if (!this.blocked(m, nx, ny)) {
      m.pos[0] = nx
      m.pos[1] = ny
    } else if (!this.blocked(m, nx, m.pos[1])) {
      m.pos[0] = nx
      m.vel[1] = 0
    } else if (!this.blocked(m, m.pos[0], ny)) {
      m.pos[1] = ny
      m.vel[0] = 0
    } else {
      m.vel[0] = 0
      m.vel[1] = 0
    }
    m.pos[0] = Math.max(this.w.minX + 1, Math.min(this.w.maxX - 1, m.pos[0]))
    m.pos[1] = Math.max(this.w.minY + 1, Math.min(this.w.maxY - 1, m.pos[1]))
    // vertical
    const tol = m.grounded ? this.cfg.mech.step_up : 0.05
    const sup = this.support(m, m.pos[0], m.pos[1], m.pos[2] + tol)
    let nz = m.pos[2] + m.vel[2] * dt
    if (m.vel[2] > 0 && this.w.prismSolid(m.pos[0], m.pos[1], nz + this.height(m))) {
      m.vel[2] = 0
      nz = m.pos[2]
    }
    if (nz <= sup) {
      nz = sup
      if (m.vel[2] < 0) m.vel[2] = 0
      m.grounded = true
    } else if (m.grounded && nz - sup < 0.3 && m.vel[2] <= 0) {
      nz = sup
      m.vel[2] = 0
    } else m.grounded = false
    m.pos[2] = nz
    // steps sound
    const hs = Math.hypot(m.vel[0], m.vel[1])
    if (m.grounded && hs > this.cfg.sound.step_speed) {
      m.stepT += dt
      if (m.stepT >= this.cfg.sound.step_every) {
        m.stepT = 0
        this.sound(spending ? "boost" : "step", m.pos, m.id)
      }
    }
  }
  support(m: Mech, x: number, y: number, z: number): number {
    // highest surface under the center (and a small footprint) at or below z
    let s = this.w.surface(x, y, z)
    return s
  }
  blocked(m: Mech, x: number, y: number): boolean {
    const r = this.radius(m) * 0.9
    const z = m.pos[2]
    const stepz = z + this.cfg.mech.step_up
    const head = z + this.height(m)
    for (let dx = -r; dx <= r + 0.01; dx += r / 2) for (let dy = -r; dy <= r + 0.01; dy += r / 2) {
      if (dx * dx + dy * dy > r * r + 0.01) continue
      const px = x + dx, py = y + dy
      const c = this.w.cell(px, py)
      if (c < 0) return true
      if (this.w.terrain(px, py) > stepz) return true
      for (let k = 0; k < this.w.cnt[c]; k++) {
        const b = this.w.base[c * K + k], t = this.w.top[c * K + k]
        if (t > stepz && b < head) return true
      }
    }
    return false
  }

  fireWeapons(m: Mech, dt: number) {
    const fire = m.act.fire ?? [false, false]
    for (let s = 0; s < 2; s++) {
      const wp = m.weapons[s]
      if (!wp) continue
      wp.cooldown = Math.max(0, wp.cooldown - dt)
      wp.equip = Math.max(0, wp.equip - dt)
      if (wp.kind === "gun" && wp.reload > 0) {
        wp.reload -= dt
        if (wp.reload <= 0) {
          wp.reload = 0
          wp.ammo = this.wstat(m, "gun", "mag")
        }
      }
      const held = !!fire[s]
      if (wp.kind === "laser") {
        const full = this.wstat(m, "laser", "charge")
        if (wp.charging) {
          wp.charge += dt
          const minc = this.wstat(m, "laser", "min_charge")
          const release = (!held && wp.charge >= minc) || wp.charge >= full + this.wstat(m, "laser", "hold_s")
          if (release) this.fireLaser(m, wp)
        } else if (held && wp.cooldown <= 0 && wp.equip <= 0 && this.t >= m.shortUntil) {
          wp.charging = true
          wp.charge = 0
          this.sound("laser_charge", m.pos, m.id)
        }
        continue
      }
      if (!held || wp.cooldown > 0 || wp.equip > 0) continue
      const dir = [Math.cos(m.pitch) * Math.cos(m.yaw), Math.cos(m.pitch) * Math.sin(m.yaw), Math.sin(m.pitch)]
      const mz = m.pos[2] + this.cfg.mech.muzzle_height * this.scale(m)
      const off = this.radius(m) + 0.5
      const o = [m.pos[0] + dir[0] * off, m.pos[1] + dir[1] * off, mz + dir[2] * off]
      if (wp.kind === "gun") {
        if (wp.reload > 0) continue
        if (wp.ammo <= 0) {
          wp.reload = this.wstat(m, "gun", "reload")
          this.sound("reload", m.pos, m.id)
          continue
        }
        const sp = (this.wstat(m, "gun", "spread_deg") * Math.PI) / 180
        const yy = m.yaw + gauss(this.r) * sp, pp = m.pitch + gauss(this.r) * sp
        const v = this.wstat(m, "gun", "speed")
        this.projs.push({ id: this.nextId.proj++, kind: "gun", owner: m.id, pos: o, vel: [Math.cos(pp) * Math.cos(yy) * v, Math.cos(pp) * Math.sin(yy) * v, Math.sin(pp) * v], dist: 0, range: this.wstat(m, "gun", "range"), dmg: this.wstat(m, "gun", "damage") * this.dmgMult(m), ttl: 5 })
        wp.ammo--
        wp.cooldown = this.wstat(m, "gun", "cooldown")
        if (wp.ammo <= 0) wp.reload = this.wstat(m, "gun", "reload")
        this.sound("gun", m.pos, m.id)
      } else if (wp.kind === "mortar") {
        const v = this.wstat(m, "mortar", "speed")
        const o2 = [o[0], o[1], m.pos[2] + this.height(m) + 0.5]
        this.projs.push({ id: this.nextId.proj++, kind: "mortar", owner: m.id, pos: o2, vel: [dir[0] * v, dir[1] * v, dir[2] * v], dist: 0, range: 1e9, dmg: this.wstat(m, "mortar", "damage") * this.dmgMult(m), ttl: this.wstat(m, "mortar", "ttl") })
        wp.cooldown = this.wstat(m, "mortar", "cooldown")
        this.sound("mortar", m.pos, m.id)
      } else if (wp.kind === "lightning") {
        const en = this.wstat(m, "lightning", "energy")
        if (m.energy < en) continue
        m.energy -= en
        m.lastSpend = this.t
        wp.cooldown = this.wstat(m, "lightning", "cooldown")
        this.fireLightning(m, mz)
        this.sound("lightning", m.pos, m.id)
      }
    }
  }
  targetsList(): { id: number; pos: number[]; r: number; h: number }[] {
    const out: { id: number; pos: number[]; r: number; h: number }[] = []
    for (const o of this.mechs) if (o.alive) out.push({ id: o.id, pos: o.pos, r: this.radius(o), h: this.height(o) })
    for (const n of this.npcs) out.push({ id: n.id, pos: n.pos, r: this.cfg.npc.radius, h: this.cfg.npc.height })
    for (const c of this.crates) out.push({ id: c.id, pos: c.pos, r: this.cfg.crates.radius, h: this.cfg.crates.height })
    return out
  }
  fireLaser(m: Mech, wp: Weapon) {
    const full = this.wstat(m, "laser", "charge")
    const frac = Math.min(1, wp.charge / full)
    const mf = this.wstat(m, "laser", "min_frac")
    let dmg = this.wstat(m, "laser", "damage") * (mf + (1 - mf) * frac) * this.dmgMult(m)
    wp.charging = false
    wp.charge = 0
    wp.cooldown = this.wstat(m, "laser", "cooldown")
    const dir = [Math.cos(m.pitch) * Math.cos(m.yaw), Math.cos(m.pitch) * Math.sin(m.yaw), Math.sin(m.pitch)]
    const mz = m.pos[2] + this.cfg.mech.muzzle_height * this.scale(m)
    const o = [m.pos[0], m.pos[1], mz]
    const range = this.wstat(m, "laser", "range")
    const tw = this.w.raycast(o[0], o[1], o[2], o[0] + dir[0] * range, o[1] + dir[1] * range, o[2] + dir[2] * range, 1) * range
    let best: any = null, bt = tw
    for (const tg of this.targetsList()) {
      if (tg.id === m.id) continue
      const t = rayCyl(o, dir, tg.pos, tg.r, tg.h)
      if (t !== null && t > 0 && t < bt) {
        bt = t
        best = tg
      }
    }
    const end = [o[0] + dir[0] * bt, o[1] + dir[1] * bt, o[2] + dir[2] * bt]
    this.sound("laser", m.pos, m.id)
    this.beam(m, "laser", [o, end])
    if (best) {
      let eff: string | undefined
      if (best.id < 100 && this.mechs[best.id].weapons.some((w) => w?.kind === "mortar")) {
        dmg *= 1 + this.wstat(m, "laser", "cookoff")
        eff = "cookoff"
        this.mechs[best.id].events.push({ type: "effect", effect: "cookoff", by: m.id } as any)
      }
      this.damage(m, best.id, dmg, "laser", m.pos, eff)
    }
  }
  fireLightning(m: Mech, mz: number) {
    const range = this.wstat(m, "lightning", "range"), cone = (this.wstat(m, "lightning", "cone_deg") * Math.PI) / 180
    const tl = this.targetsList()
    let best: any = null, bd = 1e9
    for (const tg of tl) {
      if (tg.id === m.id) continue
      const d = Math.hypot(tg.pos[0] - m.pos[0], tg.pos[1] - m.pos[1])
      if (d > range || d >= bd) continue
      if (Math.abs(wrap(Math.atan2(tg.pos[1] - m.pos[1], tg.pos[0] - m.pos[0]) - m.yaw)) > cone) continue
      if (!this.w.los(m.pos[0], m.pos[1], mz, tg.pos[0], tg.pos[1], tg.pos[2] + tg.h / 2)) continue
      best = tg
      bd = d
    }
    const path: number[][] = [[m.pos[0], m.pos[1], mz]]
    if (!best) {
      this.beam(m, "lightning", [path[0], [m.pos[0] + Math.cos(m.yaw) * range, m.pos[1] + Math.sin(m.yaw) * range, mz]])
      return
    }
    let dmg = this.wstat(m, "lightning", "damage") * this.dmgMult(m)
    const hit = new Set<number>([m.id])
    let cur = best
    let from = m.pos
    for (let j = 0; j <= this.wstat(m, "lightning", "chain") && cur; j++) {
      hit.add(cur.id)
      path.push([cur.pos[0], cur.pos[1], cur.pos[2] + cur.h / 2])
      let eff: string | undefined
      if (cur.id < 100) {
        const v = this.mechs[cur.id]
        if (v.weapons.some((w) => w?.kind === "laser")) {
          eff = "short"
          v.shortUntil = this.t + this.wstat(m, "lightning", "short_s")
          for (const w of v.weapons) if (w?.charging) (w.charging = false), (w.charge = 0)
          v.events.push({ type: "effect", effect: "short", by: m.id } as any)
        }
      }
      this.damage(m, cur.id, dmg, "lightning", from, eff)
      dmg *= this.wstat(m, "lightning", "chain_falloff")
      from = cur.pos
      let nb: any = null, nd = this.wstat(m, "lightning", "chain_range")
      for (const tg of tl) {
        if (hit.has(tg.id)) continue
        const d = Math.hypot(tg.pos[0] - cur.pos[0], tg.pos[1] - cur.pos[1], tg.pos[2] - cur.pos[2])
        if (d < nd) (nd = d), (nb = tg)
      }
      cur = nb
    }
    this.beam(m, "lightning", path)
  }
  beam(m: Mech, kind: string, path: number[][]) {
    for (const o of this.mechs) {
      if (!o.alive || o === m) continue
      const mid = path[Math.floor(path.length / 2)]
      if (this.canSee(o, path[0][0], path[0][1], path[0][2] - 4, 4) || this.canSee(o, path.at(-1)![0], path.at(-1)![1], path.at(-1)![2], 1) || this.canSee(o, mid[0], mid[1], mid[2], 1))
        o.beams.push({ by: m.id, kind, path, age: 0 })
    }
  }

  stepProjs(dt: number) {
    const tl = this.targetsList()
    const keep: Proj[] = []
    for (const p of this.projs) {
      const g = p.kind === "mortar" ? this.cfg.weapons.mortar.gravity : 0
      const o = [...p.pos]
      p.vel[2] -= g * dt
      const d = [p.vel[0] * dt, p.vel[1] * dt, p.vel[2] * dt]
      const L = Math.hypot(d[0], d[1], d[2])
      const dir = [d[0] / L, d[1] / L, d[2] / L]
      let tw = this.w.raycast(o[0], o[1], o[2], o[0] + d[0], o[1] + d[1], o[2] + d[2], 0.7) * L
      let hit: any = null
      for (const tg of tl) {
        if (tg.id === p.owner) continue
        if (p.kind === "npc" && tg.id >= 100) continue
        const t = rayCyl(o, dir, tg.pos, tg.r + 0.3, tg.h)
        if (t !== null && t >= 0 && t < tw) {
          tw = t
          hit = tg
        }
      }
      const end = [o[0] + dir[0] * Math.min(tw, L), o[1] + dir[1] * Math.min(tw, L), o[2] + dir[2] * Math.min(tw, L)]
      p.dist += L
      p.ttl -= dt
      const owner = p.owner < 100 ? this.mechs[p.owner] : null
      if (tw < L || hit) {
        if (p.kind === "mortar") this.explode(owner, end, hit ? hit.id : null, p.dmg)
        else if (hit) this.damage(owner, hit.id, p.dmg, p.kind === "npc" ? "npc" : "gun", o)
        continue
      }
      if (p.dist > p.range || p.ttl <= 0) {
        if (p.kind === "mortar") this.explode(owner, end, null, p.dmg)
        continue
      }
      p.pos = end
      keep.push(p)
    }
    this.projs = keep
  }
  explode(owner: Mech | null, at: number[], direct: number | null, dmg: number) {
    const mc = this.cfg.weapons.mortar
    const mult = owner ? this.dmgMult(owner) : 1
    this.sound("explosion", at)
    if (direct !== null) this.damage(owner, direct, dmg, "mortar", at)
    for (const tg of this.targetsList()) {
      if (tg.id === direct) continue
      const c = [tg.pos[0], tg.pos[1], Math.max(tg.pos[2], Math.min(tg.pos[2] + tg.h, at[2]))]
      const d = Math.max(0, Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]) - tg.r)
      if (d > mc.splash_radius) continue
      if (!this.w.los(at[0], at[1], at[2] + 0.3, c[0], c[1], c[2] + 0.3)) continue
      const f = 1 - (1 - mc.splash_edge) * (d / mc.splash_radius)
      this.damage(owner, tg.id, mc.splash * mult * f, "mortar", at, tg.id < 100 ? "concuss" : undefined)
      if (tg.id < 100) {
        const v = this.mechs[tg.id]
        const a = Math.atan2(v.pos[1] - at[1], v.pos[0] - at[0])
        v.vel[0] += Math.cos(a) * mc.knock * f
        v.vel[1] += Math.sin(a) * mc.knock * f
        v.vel[2] += mc.knock_up * f
        v.grounded = false
        v.energy = Math.max(0, v.energy - mc.drain * f)
        v.events.push({ type: "effect", effect: "concuss", by: owner ? owner.id : null } as any)
      }
    }
  }

  stepNpcs(dt: number) {
    const c = this.cfg.npc
    for (const n of this.npcs) {
      n.cd -= dt
      const homeD = Math.hypot(n.pos[0] - n.home[0], n.pos[1] - n.home[1])
      let tgt = n.target !== null ? this.mechs[n.target] : null
      if (tgt && (!tgt.alive || Math.hypot(tgt.pos[0] - n.pos[0], tgt.pos[1] - n.pos[1]) > c.deaggro_range || homeD > c.chase_leash)) {
        n.target = null
        tgt = null
      }
      if (!tgt && homeD < c.leash) {
        let bd = c.aggro_range
        for (const m of this.mechs) {
          if (!m.alive) continue
          const d = Math.hypot(m.pos[0] - n.pos[0], m.pos[1] - n.pos[1])
          if (d < bd && this.w.los(n.pos[0], n.pos[1], n.pos[2] + 3, m.pos[0], m.pos[1], m.pos[2] + 4.5)) {
            bd = d
            tgt = m
          }
        }
        if (tgt) n.target = tgt.id
      }
      let goal: number[]
      if (tgt) {
        goal = tgt.pos
        const dx = tgt.pos[0] - n.pos[0], dy = tgt.pos[1] - n.pos[1], dz = tgt.pos[2] + 4.5 - n.pos[2] - 3
        n.yaw = Math.atan2(dy, dx)
        if (n.cd <= 0 && this.w.los(n.pos[0], n.pos[1], n.pos[2] + 3, tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5)) {
          const L = Math.hypot(dx, dy, dz)
          const sp = (c.spread_deg * Math.PI) / 180
          const yaw = Math.atan2(dy, dx) + gauss(this.r) * sp, pit = Math.asin(dz / L) + gauss(this.r) * sp
          const o = [n.pos[0] + Math.cos(yaw) * 2.2, n.pos[1] + Math.sin(yaw) * 2.2, n.pos[2] + 3]
          this.projs.push({ id: this.nextId.proj++, kind: "npc", owner: n.id, pos: o, vel: [Math.cos(pit) * Math.cos(yaw) * c.projectile_speed, Math.cos(pit) * Math.sin(yaw) * c.projectile_speed, Math.sin(pit) * c.projectile_speed], dist: 0, range: 200, dmg: c.damage, ttl: 3 })
          n.cd = c.cooldown
          this.sound("npc_gun", n.pos)
        }
        if (Math.hypot(dx, dy) < 25) goal = n.pos
      } else {
        n.wt -= dt
        if (n.wt <= 0) {
          const a = this.r() * 6.28, d = this.r() * c.leash
          n.wander = [n.home[0] + Math.cos(a) * d, n.home[1] + Math.sin(a) * d]
          n.wt = 3 + this.r() * 5
        }
        goal = n.wander
      }
      const dx = goal[0] - n.pos[0], dy = goal[1] - n.pos[1]
      const L = Math.hypot(dx, dy)
      if (L > 1) {
        const nx = n.pos[0] + (dx / L) * c.speed * dt, ny = n.pos[1] + (dy / L) * c.speed * dt
        const g = this.w.terrain(nx, ny)
        if (!this.w.prismSolid(nx, ny, g + 1.5) && !this.w.prismSolid(nx, ny, g + 3)) {
          n.vel = [(nx - n.pos[0]) / dt, (ny - n.pos[1]) / dt, 0]
          n.pos = [nx, ny, this.w.surface(nx, ny, n.pos[2] + 1.2)]
        } else n.vel = [0, 0, 0]
      } else n.vel = [0, 0, 0]
    }
  }

  stepLoot() {
    // cubes
    const pr = this.cfg.cubes.pickup_radius
    this.cubes = this.cubes.filter((c) => {
      let best: Mech | null = null, bd = pr
      for (const m of this.mechs) {
        if (!m.alive) continue
        const d = Math.hypot(c.pos[0] - m.pos[0], c.pos[1] - m.pos[1])
        if (d <= bd && Math.abs(c.pos[2] - m.pos[2]) < 4) (bd = d), (best = m)
      }
      if (best) {
        this.addCube(best)
        best.events.push({ type: "pickup", cubes: best.cubes } as any)
        return false
      }
      return true
    })
  }
  stepDrops(dt: number) {
    const dc = this.cfg.drops
    if (!dc) return
    for (const tm of dc.times) {
      if (this.t >= tm && this.t - dt < tm) {
        const z = this.zone
        let p: number[] = [z.next_center[0], z.next_center[1]]
        for (let k = 0; k < 100; k++) {
          const a = this.r() * 6.28, d = Math.sqrt(this.r()) * z.next_radius * dc.spread
          const q = [z.next_center[0] + Math.cos(a) * d, z.next_center[1] + Math.sin(a) * d]
          if (this.openGround(q[0], q[1], 8)) {
            p = q
            break
          }
        }
        this.drops.push({ id: this.nextId.drop++, pos: [p[0], p[1], this.w.terrain(p[0], p[1])], landT: this.t + dc.fall_s, progress: 0, holder: null, taken: false })
      }
    }
    for (const d of this.drops) {
      if (d.taken || this.t < d.landT) continue
      const inside = this.mechs.filter((m) => m.alive && Math.hypot(m.pos[0] - d.pos[0], m.pos[1] - d.pos[1]) <= dc.radius && Math.abs(m.pos[2] - d.pos[2]) < 6)
      if (inside.length === 1) {
        if (d.holder !== inside[0].id) {
          d.holder = inside[0].id
          d.progress = 0
        }
        d.progress += dt
        if (d.progress >= dc.capture_s) {
          const m = inside[0]
          d.taken = true
          this.addCube(m, dc.cubes)
          m.hp = this.maxHp(m)
          m.energy = this.mstat(m, "energy")
          m.events.push({ type: "drop", id: d.id, cubes: m.cubes } as any)
        }
      } else if (inside.length === 0) {
        d.holder = null
        d.progress = 0
      }
    }
  }

  step() {
    const dt = 1 / this.cfg.match.tick_hz
    if (this.tick % this.cfg.match.decide_every === 0) this.decide()
    for (const m of this.mechs) if (m.alive) {
      if (m.offer && this.t >= m.offer.expires) this.applyUpgrade(m, m.offer.choices[0].id)
      this.stepMech(m, dt)
    }
    // separation
    const al = this.mechs.filter((m) => m.alive)
    for (let i = 0; i < al.length; i++) for (let j = i + 1; j < al.length; j++) {
      const a = al[i], b = al[j]
      const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], d = Math.hypot(dx, dy)
      const R = this.radius(a) + this.radius(b)
      if (d < R && d > 1e-6 && Math.abs(a.pos[2] - b.pos[2]) < 9) {
        const push = (R - d) / 2
        const ux = dx / d, uy = dy / d
        if (!this.blocked(a, a.pos[0] - ux * push, a.pos[1] - uy * push)) (a.pos[0] -= ux * push), (a.pos[1] -= uy * push)
        if (!this.blocked(b, b.pos[0] + ux * push, b.pos[1] + uy * push)) (b.pos[0] += ux * push), (b.pos[1] += uy * push)
      }
    }
    for (const m of this.mechs) if (m.alive) this.fireWeapons(m, dt)
    this.stepProjs(dt)
    this.stepNpcs(dt)
    this.stepLoot()
    this.stepDrops(dt)
    // zone + regen
    this.updateZone()
    const zn = this.zoneNow()
    for (const m of this.mechs) {
      if (!m.alive) continue
      m.inZone = Math.hypot(m.pos[0] - zn.c[0], m.pos[1] - zn.c[1]) <= zn.r
      if (!m.inZone) {
        m.hp -= this.zone.dps * dt
        m.dmgTaken += this.zone.dps * dt
        m.lastCombat = Math.max(m.lastCombat, this.t)
        if (this.tick % 10 === 0) m.events.push({ type: "damaged", amount: Math.round(this.zone.dps * dt), weapon: "zone", bearing: null, by: null } as any)
        if (m.hp <= 0) this.kill(m, null)
      } else if (this.t - m.lastCombat >= this.mstat(m, "regen_delay")) m.hp = Math.min(this.maxHp(m), m.hp + this.mstat(m, "regen_per_s") * dt)
    }
    // placements
    if (this.pendingDeaths.length) {
      const alive = this.mechs.filter((m) => m.alive).length
      for (const v of this.pendingDeaths) v.place = alive + 1
      this.pendingDeaths = []
    }
    this.tick++
    this.t = this.tick * dt
    const alive = this.mechs.filter((m) => m.alive)
    if (alive.length <= 1 || this.t >= this.cfg.match.duration_s) {
      if (alive.length === 1) alive[0].place = 1
      else {
        alive.sort((a, b) => b.hp - a.hp)
        alive.forEach((m, i) => (m.place = i + 1))
      }
      this.ended = true
    }
  }
}

declare module "./engine.ts" {}
// ray (origin o, unit dir) vs vertical cylinder at feet p, radius r, height h. returns distance or null
export function rayCyl(o: number[], d: number[], p: number[], r: number, h: number): number | null {
  const ox = o[0] - p[0], oy = o[1] - p[1]
  const a = d[0] * d[0] + d[1] * d[1]
  let t0 = -Infinity, t1 = Infinity
  if (a < 1e-9) {
    if (ox * ox + oy * oy > r * r) return null
  } else {
    const b = 2 * (ox * d[0] + oy * d[1]), c = ox * ox + oy * oy - r * r
    const disc = b * b - 4 * a * c
    if (disc < 0) return null
    const s = Math.sqrt(disc)
    t0 = (-b - s) / (2 * a)
    t1 = (-b + s) / (2 * a)
  }
  // z slab
  const oz = o[2] - p[2]
  if (Math.abs(d[2]) < 1e-9) {
    if (oz < 0 || oz > h) return null
  } else {
    let z0 = (0 - oz) / d[2], z1 = (h - oz) / d[2]
    if (z0 > z1) [z0, z1] = [z1, z0]
    t0 = Math.max(t0, z0)
    t1 = Math.min(t1, z1)
  }
  if (t0 > t1 || t1 < 0) return null
  return Math.max(0, t0)
}
