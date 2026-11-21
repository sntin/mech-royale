// bun sim/duel.ts level n [paramsJSON]  -> win rate of Survivor vs one house bot hunter
import { readFileSync } from "node:fs"
import { Sim } from "./engine.ts"
import { HouseBot, Squad } from "./house.ts"
import { Survivor, getMap } from "../src/bot.ts"
const [level = "expert", n = "20", pj = "{}", opp = "house"] = process.argv.slice(2)
const cfg = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
cfg.npc.count = 0
cfg.match.duration_s = 120
const { w } = getMap("arena")
let wins = 0, hpLeft = 0, time = 0, dealt = 0, taken = 0
for (let k = 0; k < +n; k++) {
  const sim = new Sim(w, cfg, k * 31 + 7)
  const squad = new Squad(sim, true)
  const h0 = sim.hello(0), h1 = sim.hello(1)
  ;(h0 as any).seed = k * 3 + 1
  ;(h1 as any).seed = k * 5 + 2
  const us = sim.addMech(new Survivor(h0, { ...JSON.parse(pj), debug: false }, "arena"), false, "us")
  const th = sim.addMech(null, true, "house")
  if (opp === "house") {
    squad.members.add(1)
    squad.order.push(1)
    th.bot = new HouseBot(h1, level, squad)
  } else th.bot = new Survivor(h1, { debug: false }, "arena")
  cfg.match.spawn_min_separation = 130
  sim.setup()
  // place them ~140 m apart
  while (!sim.ended && sim.t < 120) sim.step()
  if (us.alive && !th.alive) wins++
  else if (us.alive && th.alive && us.hp / sim.maxHp(us) > th.hp / sim.maxHp(th)) wins += 0.5
  hpLeft += us.alive ? us.hp : 0
  time += sim.t
  dealt += us.dmgDealt
  taken += us.dmgTaken
}
console.log(`${level} win=${(wins / +n).toFixed(2)} hpLeft=${(hpLeft / +n).toFixed(0)} t=${(time / +n).toFixed(0)} dealt=${(dealt / +n).toFixed(0)} taken=${(taken / +n).toFixed(0)}`)
