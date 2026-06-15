import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { Game } from "./game.js";
import { CONFIG } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Static file server (serves the client from /public)
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  // Resolve safely inside PUBLIC_DIR (no path traversal).
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Game + WebSocket layer
// ---------------------------------------------------------------------------
const game = new Game();

// Pre-seed bots so a fresh server already feels populated.
while (game.botCount < Math.min(CONFIG.targetPopulation, CONFIG.maxBots)) {
  game.addPlayer(undefined, true);
}

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  ws.playerId = null;
  ws.wasAlive = false;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.t) {
      case "join": {
        const existing = ws.playerId && game.players.get(ws.playerId);
        if (existing) {
          // Respawn after death.
          if (msg.name) existing.name = String(msg.name).slice(0, 14);
          existing.spawn(CONFIG.startMass);
        } else {
          const p = game.addPlayer(msg.name, false);
          ws.playerId = p.id;
        }
        ws.wasAlive = true;
        send(ws, { t: "welcome", id: ws.playerId, worldSize: CONFIG.worldSize });
        break;
      }
      case "input":
        if (ws.playerId) game.setTarget(ws.playerId, msg.x, msg.y);
        break;
      case "split":
        if (ws.playerId) game.requestSplit(ws.playerId);
        break;
      case "eject":
        if (ws.playerId) game.requestEject(ws.playerId);
        break;
    }
  });

  ws.on("close", () => {
    if (ws.playerId) game.removePlayer(ws.playerId);
  });
});

// ---------------------------------------------------------------------------
// Simulation + broadcast loop
// ---------------------------------------------------------------------------
const stepMs = 1000 / CONFIG.tickRate;
let last = Date.now();
let botTimer = 0;

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  game.tick(dt);

  botTimer += dt;
  if (botTimer >= 1) {
    botTimer = 0;
    game.manageBots();
  }

  for (const ws of wss.clients) {
    if (!ws.playerId) continue;
    const player = game.players.get(ws.playerId);
    if (!player) continue;

    if (ws.wasAlive && player.dead) {
      send(ws, { t: "dead", mass: Math.round(player.totalMass) || 0 });
    }
    ws.wasAlive = !player.dead;
    send(ws, game.snapshotFor(player));
  }
}, stepMs);

server.listen(PORT, () => {
  console.log(`Three·Agar server running at http://localhost:${PORT}`);
  console.log(`Tick rate ${CONFIG.tickRate}Hz · world ${CONFIG.worldSize * 2}×${CONFIG.worldSize * 2}`);
});
