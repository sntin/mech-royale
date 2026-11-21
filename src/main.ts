import { run, log } from "./mechfight.ts"
import { Survivor, getMap } from "./bot.ts"
import { existsSync } from "node:fs"

run((hello) => {
  let dir = hello.map?.dir ?? "/arena"
  if (!existsSync(dir + "/v2/world.json")) dir = existsSync("/arena/v2/world.json") ? "/arena" : new URL("../arena", import.meta.url).pathname
  const t0 = performance.now()
  const { nav } = getMap(dir)
  // warm up the JIT on pathfinding
  for (let k = 0; k < 6; k++) nav.path(-300 + k * 100, -200, 300 - k * 80, 250)
  const bot = new Survivor(hello, { debug: false }, dir)
  log(`ready in ${Math.round(performance.now() - t0)} ms`)
  return bot
})
