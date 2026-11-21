// Usage: bun sim/run.ts <mode> <seedStart> <n> [paramsJSON] [cheat]
import { readFileSync } from "node:fs"
import { Sim } from "./engine.ts"
import { HouseBot, Squad } from "./house.ts"
import { Survivor, getMap } from "../src/bot.ts"

const [mode = "practice", s0 = "1", n = "4", pj = "{}", cheat = "1"] = process.argv.slice(2)
const cfg = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
const { w } = getMap("arena")
const params = JSON.parse(pj)
const out: any[] = []
for (let k = 0; k < +n; k++) {
  const times: number[] = []
  const seed = +s0 + k
  const sim = new Sim(w, cfg, seed * 7777 + 13)
  const squad = new Squad(sim, cheat === "1")
  const levels = ["easy", "easy", "easy", "easy", "medium", "medium", "medium", "medium", "hard", "hard", "hard", "hard", "expert", "expert", "expert"]
  const ourSlot = seed % 16
  let li = 0
  for (let i = 0; i < 16; i++) {
    const hello = sim.hello(i)
    ;(hello as any).seed = seed * 100 + i
    if (mode === "practice") {
      if (i === ourSlot) {
        const b = new Survivor(hello, { ...params, debug: false }, "arena")
        const orig = b.act.bind(b)
        b.act = (o: any) => {
          const t = performance.now()
          const r = orig(o)
          const dt = performance.now() - t
          times.push(dt)
          return r
        }
        sim.addMech(b, false, "us")
      }
      else {
        const m = sim.addMech(null, true, "house")
        squad.members.add(i)
        squad.order.push(i)
        m.bot = new HouseBot(hello, levels[li++], squad)
      }
    } else {
      // ffa: all survivors
      sim.addMech(new Survivor(hello, { ...params, debug: false }, "arena"), false, "s" + i)
    }
  }
  sim.setup()
  const t0 = performance.now()
  while (!sim.ended) {
    sim.step()
    const u = sim.mechs[ourSlot]
    if (u.alive) (u as any).w2 = u.weapons[1]?.kind ?? '-'
    if (process.env.TRACE && u.alive && sim.tick % 10 === 0) {
      const near = sim.mechs.filter((m) => m !== u && m.alive).map((m) => [m.id, Math.round(Math.hypot(m.pos[0] - u.pos[0], m.pos[1] - u.pos[1]))]).filter((x) => x[1] < 150)
      console.log(sim.t.toFixed(1), (u.bot as any).lastMode, Math.round(u.hp), u.pos.map((x) => x.toFixed(0)).join(","), 'e' + Math.round(u.energy), 'w' + u.weapons.map((w) => w?.kind).join('/'), 'near', JSON.stringify(near), 'hunters', JSON.stringify([...squad.cached.hunters]))
    }
  }
  const us = sim.mechs[ourSlot]
  const houseDead = sim.mechs.filter((m) => m.house && !m.alive).length
  out.push({ seed, place: us.place, score: 16 - us.place, deathT: us.alive ? sim.t : +us.deathT.toFixed(1), kills: us.kills, cubes: us.cubes, taken: Math.round(us.dmgTaken), dealt: Math.round(us.dmgDealt), houseDead, ms: Math.round(performance.now() - t0), w2: (us as any).w2, maxAct: +Math.max(0, ...times).toFixed(1), over20: times.filter((x) => x > 20).length })
  console.log(JSON.stringify(out.at(-1)))
  if (process.env.LOG) console.log(sim.log.join('\n'))
}
