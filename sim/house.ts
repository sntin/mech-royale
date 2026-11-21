// Guessed house-bot squad: shared vision, hunts the non-house mechs (weakest first).
import type { Hello, Observation, ActorObs, Bot } from "../src/mechfight.ts"
import { Pilot, wrap, d2 } from "../src/brain.ts"
import { getMap } from "../src/bot.ts"
import type { Sim } from "./engine.ts"

export const LEVELS: Record<string, { noise: number; react: number; strafe: boolean; useSpecial: boolean; range: number }> = {
  easy: { noise: 0.06, react: 0.6, strafe: false, useSpecial: false, range: 110 },
  medium: { noise: 0.035, react: 0.4, strafe: true, useSpecial: true, range: 140 },
  hard: { noise: 0.02, react: 0.25, strafe: true, useSpecial: true, range: 170 },
  expert: { noise: 0.01, react: 0.15, strafe: true, useSpecial: true, range: 200 },
}

export class Squad {
  sim: Sim
  members = new Set<number>()
  know = new Map<number, { pos: number[]; vel: number[]; t: number; hp: number }>()
  cheat: boolean
  passiveRange = 60
  constructor(sim: Sim, cheat: boolean) {
    this.sim = sim
    this.cheat = cheat
  }
  houseDeaths() {
    let n = 0
    for (const id of this.members) if (!this.sim.mechs[id].alive) n++
    return n
  }
  // which member ids are hunters and the target
  order: number[] = [] // members weakest first
  lateT = 300
  plan(): { hunters: Set<number>; target: number | null } {
    const sim = this.sim
    const foes = sim.mechs.filter((m) => m.alive && !this.members.has(m.id))
    if (!foes.length) return { hunters: new Set(), target: null }
    foes.sort((a, b) => a.hp - b.hp)
    const target = foes[0].id
    const alive = this.order.filter((id) => sim.mechs[id].alive)
    let H = 1 + this.houseDeathsByFoes()
    if (sim.t > this.lateT) H = alive.length
    return { hunters: new Set(alive.slice(0, H)), target }
  }
  houseDeathsByFoes() {
    let n = 0
    for (const id of this.members) {
      const m = this.sim.mechs[id]
      if (!m.alive && String((m as any).lastW ?? "").match(/:(\d+)$/) && !this.members.has(+(m as any).lastW.split(":")[1])) n++
    }
    return n
  }
  lastPlanT = -1
  cached: { hunters: Set<number>; target: number | null } = { hunters: new Set(), target: null }
  getPlan() {
    if (this.sim.t - this.lastPlanT > 2) {
      this.cached = this.plan()
      this.lastPlanT = this.sim.t
    }
    return this.cached
  }
}

export class HouseBot implements Bot {
  name: string
  p: Pilot
  lv: (typeof LEVELS)[string]
  squad: Squad
  id: number
  camp: number[] | null = null
  campKey = ""
  strafeDir = 1
  strafeUntil = 0
  seenT = new Map<number, number>()
  noiseYaw = 0
  noisePitch = 0
  noiseT = 0
  angryUntil = -1
  constructor(hello: Hello, level: string, squad: Squad) {
    const { w, nav } = getMap("arena")
    this.p = new Pilot(hello, w, nav, ((hello.seed as number) * 7919) | 1)
    this.lv = LEVELS[level]
    this.name = "house-" + level
    this.squad = squad
    this.id = hello.slot as number
  }
  act(obs: Observation) {
    const p = this.p
    p.update(obs)
    const me = obs.self, pos = me.pos
    const sq = this.squad
    for (const m of obs.mechs) if (m.kind === "mech" && !sq.members.has(m.id)) {
      sq.know.set(m.id, { pos: m.pos, vel: m.vel, t: obs.t, hp: m.hp ?? 1400 })
      if (!this.seenT.has(m.id)) this.seenT.set(m.id, obs.t)
    }
    for (const id of [...this.seenT.keys()]) if (!obs.mechs.some((m) => m.id === id)) this.seenT.delete(id)
    const plan = sq.getPlan()
    const act: any = {}
    if (obs.offer) act.pick = 0
    const sim = sq.sim
    const z = obs.zone
    const key = `${z.next_center[0]}`
    if (this.campKey !== key || !this.camp) {
      for (let k = 0; k < 30; k++) {
        const a = p.rnd() * 6.283, d = Math.sqrt(p.rnd()) * z.next_radius * 0.7
        const c = [z.next_center[0] + Math.cos(a) * d, z.next_center[1] + Math.sin(a) * d]
        if (p.nav.isFree(c[0], c[1])) {
          this.camp = c
          break
        }
      }
      this.camp ??= z.next_center
      this.campKey = key
    }
    // visible foes (own obs) + squad knowledge
    const foes = obs.mechs.filter((m) => m.kind === "mech" && !sq.members.has(m.id))
    let target: ActorObs | null = null
    const tgtId = plan.target
    if (foes.length) {
      foes.sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))
      target = foes.find((f) => f.id === tgtId) ?? foes[0]
      if (d2(target.pos, pos) > this.lv.range) target = null
    }
    const hunterNow = sq.getPlan().hunters.has(this.id)
    if (obs.events.some((e: any) => e.type === "damaged" && e.by !== null && !sq.members.has(e.by))) this.angryUntil = obs.t + 8
    if (target && !hunterNow && obs.t > this.angryUntil && d2(target.pos, pos) > sq.passiveRange) target = null
    // reaction delay
    if (target && obs.t - (this.seenT.get(target.id) ?? obs.t) < this.lv.react) target = null
    let goal = this.camp!
    const hunter = plan.hunters.has(this.id)
    if (hunter && tgtId !== null) {
      const k = sq.know.get(tgtId)
      if (sq.cheat) goal = sim.mechs[tgtId].pos
      else if (k && obs.t - k.t < 30) goal = k.pos
    }
    // squad-visible target nearby: engage
    if (!target && tgtId !== null && hunter) {
      const k = sq.know.get(tgtId)
      if (k && obs.t - k.t < 1 && d2(k.pos, pos) < this.lv.range) goal = k.pos
    }
    // zone safety overrides
    const zn = { c: z.center, r: z.radius }
    if (d2(pos, z.next_center) > z.next_radius - 5 && obs.t > z.shrink_start - 15) goal = this.camp!
    let move = [0, 0]
    let boost = false
    if (target) {
      const d = d2(target.pos, pos)
      const toT = Math.atan2(target.pos[1] - pos[1], target.pos[0] - pos[0])
      if (obs.t > this.strafeUntil) {
        this.strafeDir = p.rnd() < 0.5 ? -1 : 1
        this.strafeUntil = obs.t + 0.6 + p.rnd() * 1.2
      }
      const hasL = me.weapons.some((w) => w?.kind === "lightning")
      const want = hasL ? 25 : 60
      const radial = d > want + 10 ? 1 : d < want - 10 ? -0.6 : 0
      const perp = this.lv.strafe ? 1 : 0
      const mx = Math.cos(toT + (this.strafeDir * Math.PI) / 2) * perp + Math.cos(toT) * radial
      const my = Math.sin(toT + (this.strafeDir * Math.PI) / 2) * perp + Math.sin(toT) * radial
      const L = Math.hypot(mx, my) || 1
      move = [mx / L, my / L]
      if (!p.nav.isFree(pos[0] + move[0] * 5, pos[1] + move[1] * 5)) move = p.steer(target.pos)
    } else {
      if (d2(goal, pos) > 5) move = p.steer(goal)
      boost = hunter && me.energy > 50 && d2(goal, pos) > 60
    }
    if (p.stuck(Math.hypot(move[0], move[1]) > 0.3)) {
      act.jump = true
      boost = true
      p.path = null
    }
    // aim & fire
    const fire = [false, false]
    let aim: number[] = [Math.atan2(move[1], move[0]) || me.aim[0], 0]
    if (Math.hypot(move[0], move[1]) < 0.1) aim = [me.aim[0] + 0.3, 0]
    if (obs.t - this.noiseT > 0.5) {
      this.noiseT = obs.t
      this.noiseYaw = (p.rnd() * 2 - 1) * this.lv.noise
      this.noisePitch = (p.rnd() * 2 - 1) * this.lv.noise * 0.5
    }
    const npc = !target ? obs.mechs.find((m) => m.kind === "npc" && d2(m.pos, pos) < 40) : null
    const tg: any = target ?? npc
    if (tg) {
      const zOff = tg.kind === "npc" ? 1.75 : 4.5
      for (let s = 0; s < 2; s++) {
        const wp = me.weapons[s]
        if (!wp) continue
        if (wp.kind === "gun") {
          const L = p.leadAim(tg.pos, tg.vel, wp.stats.speed, zOff)
          aim = [L.aim[0] + this.noiseYaw, L.aim[1] + this.noisePitch]
          if (p.aimError(aim) < 0.05 && L.dist < wp.stats.range) fire[s] = true
        } else if (!this.lv.useSpecial) continue
        else if (wp.kind === "lightning") {
          const d = d2(tg.pos, pos)
          if (d < 43 && me.energy > 5) fire[s] = true
        } else if (wp.kind === "laser") {
          const L = p.leadAim(tg.pos, tg.vel, Infinity, zOff)
          aim = [L.aim[0] + this.noiseYaw * 0.7, L.aim[1]]
          const ch = wp.charge ?? 0
          fire[s] = !(ch >= wp.stats.charge && p.aimError(aim) < 0.03)
          if (wp.cooldown > 0.05 && ch === 0) fire[s] = false
        } else if (wp.kind === "mortar") {
          const d = d2(tg.pos, pos)
          if (d > 30 && d < 200 && !fire[0]) {
            const pit = p.mortarPitch(d, tg.pos[2] - pos[2] - 9.5)
            if (pit !== null && wp.cooldown <= 0 && !me.weapons.some((x) => x?.kind === "gun" && (x.ammo ?? 0) > 0 && d < 120)) {
              aim = [Math.atan2(tg.pos[1] - pos[1], tg.pos[0] - pos[0]) + this.noiseYaw, pit]
              if (p.aimError(aim) < 0.05) fire[s] = true
            }
          }
        }
      }
    } else {
      // pick up weapons nearby
      const pk = obs.pickups.find((q) => d2(q.pos, pos) < 30 && !me.weapons.some((w) => w?.kind === q.kind))
      if (pk && !me.weapons[1]) {
        move = p.steer(pk.pos)
        if (d2(pk.pos, pos) < 3.5) act.take = pk.id
      }
    }
    act.move = move
    act.boost = boost || d2(pos, zn.c) > zn.r - 3
    act.aim = aim
    act.fire = fire
    return act
  }
}
