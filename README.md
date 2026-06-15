# Three·Agar

An [agar.io](https://agar.io)-style browser game built with **Three.js**. Control a
cell, eat food and smaller players to grow, and avoid getting swallowed by bigger ones.

![status](https://img.shields.io/badge/built%20with-three.js-58e08a)

## Features

- 🎯 **Mouse / drag movement** — your cell chases the cursor; bigger cells move slower.
- 🍬 **Food & growth** — hundreds of pellets to absorb across a large world.
- 🤖 **AI bots** — opponents that hunt smaller cells, flee bigger ones, and respawn.
- ✂️ **Split (Space)** — launch a copy of your cell to chase prey or escape.
- 💨 **Eject mass (W)** — spit out a small blob.
- 🦠 **Viruses** — green spikes that burst oversized cells into pieces.
- 📱 **Mobile/touch controls** — drag to steer, plus on-screen Split/Eject buttons.
- 🔊 **Sound effects** — synthesized WebAudio cues (no asset files).
- 📷 **Dynamic camera** — zooms out as you grow.
- 🏆 **Live leaderboard** and mass counter.
- 💀 **Death & respawn** screens.
- 📦 **Offline-ready** — Three.js is vendored locally in `vendor/`.

## Controls

| Action      | Desktop      | Mobile              |
|-------------|--------------|---------------------|
| Move        | Mouse        | Drag anywhere       |
| Split       | `Space`      | **Split** button    |
| Eject mass  | `W`          | **Eject** button    |

## Running it

The game uses native ES modules (Three.js is vendored in `vendor/`, so no internet is
required at runtime). It still must be served over HTTP — opening `index.html` directly
via `file://` won't work because of module CORS rules. Any static server works:

```bash
# Python 3
python3 -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000> in your browser.

## Project structure

```
index.html              # markup, import map, HUD, overlays & touch buttons
styles.css              # HUD, overlays, touch controls, and layout styling
main.js                 # game logic: scene, entities, physics, AI, viruses, sound, camera
vendor/three.module.js  # vendored Three.js (r160) for offline use
```

## Tuning

Gameplay constants (world size, food count, bot count, speeds, split/eject costs,
mass decay, etc.) live in the `CONFIG` object at the top of `main.js`. Tweak and reload.
