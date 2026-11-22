// Play live matches on play.joinbuilders.org with our bot and record every server message.
// usage: node tools/live.mjs <room> <matches> <outdir>   (run from repo root; needs bun on PATH)
// Writes <outdir>/m<N>.jsonl (all server messages) and prints place/kills per match.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
const [room = 'practice', matchesS = '3', outdir = 'live-logs'] = process.argv.slice(2)
const matches = Number(matchesS)
fs.mkdirSync(outdir, { recursive: true })
const sid = crypto.randomBytes(8).toString('hex')
const NAME = 'sntin-mech-test'
let played = 0, bot = null, log = null, ws = null, inMatch = false
function startBot() {
  bot = spawn('bun', ['src/main.ts'], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  bot.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.type === 'ready') continue
      if (ws?.readyState === 1) ws.send(line)
    }
  })
  bot.on('exit', () => { bot = null })
}
function connect() {
  const u = new URL(`wss://play.joinbuilders.org/r/${room}/play`)
  u.searchParams.set('token', ''); u.searchParams.set('sid', sid); u.searchParams.set('name', NAME)
  ws = new WebSocket(u)
  ws.onopen = () => console.error('connected', room)
  ws.onclose = (e) => { console.error('closed', e.code, e.reason); if (played < matches) setTimeout(connect, 3000); else process.exit(0) }
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(String(e.data)) } catch { return }
    if (m.type === 'lobby') { if (!inMatch && !m.you?.ready) ws.send(JSON.stringify({ type: 'ready', name: NAME })); return }
    if (m.type === 'hello') {
      inMatch = true; played++
      if (m.map) m.map.dir = process.env.MAP_DIR || 'arena'
      log = fs.createWriteStream(`${outdir}/m${played}.jsonl`)
      startBot()
      ws.send(JSON.stringify({ type: 'loaded' }))
    }
    log?.write(JSON.stringify(m) + '\n')
    if (bot && ['hello', 'obs', 'end'].includes(m.type)) bot.stdin.write(JSON.stringify(m) + '\n')
    if (m.type === 'end') console.error(`match ${played}: place ${m.place} kills ${m.kills}`)
    if (m.type === 'results') {
      inMatch = false; log?.end(); log = null; try { bot?.stdin.end() } catch {}
      if (played >= matches) { ws.close(); process.exit(0) }
    }
  }
}
connect()
