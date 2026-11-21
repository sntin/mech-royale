# Mech Royale bot

TypeScript bot for the Builders Buildathon "Mech Royale" track (mechfight/1 protocol), run with Bun.

- `src/main.ts`: entrypoint (stdin/stdout loop from the kit's wrapper)
- `src/bot.ts`: decision logic (zone, loot, fights, retreats, rooftop holding)
- `src/nav.ts`, `src/world.ts`: map rasterization, clearance grid, A* pathfinding
- `sim/`: an approximate local simulator with a guessed house-bot squad (`bun sim/run.ts practice 1 8`)

Check: `python3 check/check.py -- bun src/main.ts`
