# Three·Agar

An [agar.io](https://agar.io)-style browser game built with **Three.js**. Control a
cell, eat food and smaller players to grow, and avoid getting swallowed by bigger ones.

![status](https://img.shields.io/badge/built%20with-three.js-58e08a)

## Features

- 🎯 **Mouse-follow movement** — your cell chases the cursor; bigger cells move slower.
- 🍬 **Food & growth** — hundreds of pellets to absorb across a large world.
- 🤖 **AI bots** — opponents that hunt smaller cells, flee bigger ones, and respawn.
- ✂️ **Split (Space)** — launch a copy of your cell to chase prey or escape.
- 💨 **Eject mass (W)** — spit out a small blob.
- 📷 **Dynamic camera** — zooms out as you grow.
- 🏆 **Live leaderboard** and mass counter.
- 💀 **Death & respawn** screens.

## Controls

| Action      | Input        |
|-------------|--------------|
| Move        | Mouse        |
| Split       | `Space`      |
| Eject mass  | `W`          |

## Running it

The game uses native ES modules and loads Three.js from a CDN, so it must be served
over HTTP (opening `index.html` directly via `file://` won't work because of module
CORS rules). Any static server works:

```bash
# Python 3
python3 -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000> in your browser.

## Project structure

```
index.html   # markup, import map, HUD & overlays
styles.css   # HUD, overlays, and layout styling
main.js      # game logic: scene, entities, physics, AI, camera
```

## Tuning

Gameplay constants (world size, food count, bot count, speeds, split/eject costs,
mass decay, etc.) live in the `CONFIG` object at the top of `main.js`. Tweak and reload.
