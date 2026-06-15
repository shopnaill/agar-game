# Three·Agar

A **multiplayer** [agar.io](https://agar.io)-style browser game built with **Three.js**
and an authoritative **Node.js + WebSocket** server. Control a cell, eat food and smaller
players to grow, and avoid getting swallowed by bigger ones — live against other people online.

![status](https://img.shields.io/badge/built%20with-three.js-58e08a)
![server](https://img.shields.io/badge/server-node%20%2B%20ws-4f9dff)

## Features

- 🌐 **Real-time multiplayer** — authoritative server runs one shared world; clients send
  input and render viewport-culled snapshots at 25 Hz with smooth interpolation.
- 🎯 **Mouse / drag movement** — your cell chases the cursor; bigger cells move slower.
- 🍬 **Food & growth** — hundreds of pellets to absorb across a large world.
- 🤖 **AI bots** — fill empty servers and back off as real players join; they hunt smaller
  cells, flee bigger ones, split to chase, and respawn.
- ✂️ **Split (Space)** and 💨 **eject mass (W)**, with a merge cooldown.
- 🦠 **Viruses** — green spikes that burst oversized cells into pieces.
- 🏷️ **Name + mass labels** floating on every cell, and a 🗺️ **minimap**.
- 📱 **Mobile/touch controls** — drag to steer, plus on-screen Split/Eject buttons.
- 🔊 **Sound effects** — synthesized WebAudio cues (no asset files).
- 📷 **Dynamic camera**, 🏆 **live leaderboard**, 💀 **death & respawn** screens.
- 📦 **Offline-ready client** — Three.js is vendored locally in `public/vendor/`.

## Controls

| Action      | Desktop      | Mobile              |
|-------------|--------------|---------------------|
| Move        | Mouse        | Drag anywhere       |
| Split       | `Space`      | **Split** button    |
| Eject mass  | `W`          | **Eject** button    |

## Running locally

Requires **Node.js 18+**. The server hosts both the game simulation and the static client,
so you only run one process:

```bash
npm install
npm start
# then open http://localhost:3000
```

Open the URL in several tabs (or on other devices on your LAN via your machine's IP) to
play against yourself, alongside the AI bots. Use `npm run dev` for auto-restart on changes.

## Architecture

```
server/
  index.js   # HTTP static server + WebSocket layer + 25 Hz simulation/broadcast loop
  game.js    # authoritative world: cells, food, viruses, ejected mass, bots, eating
  config.js  # tunable constants (world, speeds, viruses, bot population)
public/
  index.html              # markup, import map, HUD, overlays, minimap, touch buttons
  styles.css              # HUD, labels, minimap, touch controls, layout
  main.js                 # networked renderer: WebSocket, interpolation, labels, camera
  vendor/three.module.js  # vendored Three.js (r160)
```

**Networking.** Clients connect over WebSocket to the same origin that served the page.
They send `{t:"input",x,y}` (a world target) at ~20 Hz plus `split`/`eject` actions. The
server simulates one world and sends each client a `state` snapshot culled to its viewport,
containing only nearby cells, food, viruses and ejected blobs, plus a global leaderboard.
The client interpolates other entities between snapshots for smooth motion.

**Responsiveness (latency hiding).** Your *own* cells are predicted on the client using the
same movement model as the server, so they react to your input instantly and then gently
reconcile toward the authoritative server position. This keeps controls feeling immediate
even with meaningful ping to a remote host. On the server, food collision uses a spatial
grid so each tick stays cheap on low-powered (e.g. free-tier) hosts.

> **Render free tier note:** free instances sleep after ~15 min idle, so the *first* load
> after inactivity can take 30–60 s to wake (a cold start), and shared CPU adds some jitter.
> A paid instance (or a periodic keep-alive ping) removes the cold start.

**Bots.** The server keeps the world populated up to `targetPopulation`, spawning AI bots
when there are few humans and removing them as real players join (see `config.js`).

## Deploying online

The repo includes ready-to-use config for container or PaaS hosts. The server listens on
`process.env.PORT` (default `3000`).

- **Docker**
  ```bash
  docker build -t three-agar .
  docker run -p 3000:3000 three-agar
  ```
- **Render** — `render.yaml` is a deploy blueprint; create a new Blueprint service pointed
  at this repo and it provisions automatically. (WebSockets work out of the box.)
- **Railway / Fly.io / Heroku-style** — any host that runs `npm install && npm start` and
  injects `PORT` will work. Make sure the host supports WebSocket upgrades (most do).

> When deployed behind HTTPS, the client automatically uses `wss://` for the socket.

## Tuning

Gameplay constants (world size, food/virus/bot counts, speeds, split/eject costs, mass
decay, bot population, view size) live in `server/config.js`. Presentation-only knobs
(interpolation rate, input send rate) are at the top of `public/main.js`.
