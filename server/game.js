import { CONFIG, COLORS, VIRUS_COLOR, BOT_NAMES } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const massToRadius = (mass) => Math.sqrt(mass) * 8;

function randomPos() {
  const m = CONFIG.worldSize * 0.95;
  return { x: rand(-m, m), y: rand(-m, m) };
}

let ID = 1;
const nextId = () => ID++;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
class Cell {
  constructor(ownerId, mass, x, y) {
    this.id = nextId();
    this.ownerId = ownerId;
    this.mass = mass;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.mergeTimer = 0;
  }
  get radius() {
    return massToRadius(this.mass);
  }
}

class Virus {
  constructor() {
    this.id = nextId();
    this.mass = CONFIG.virusMass;
    this.dead = false;
    this.respawnTimer = 0;
    this.respawn();
  }
  get radius() {
    return massToRadius(this.mass);
  }
  respawn() {
    const p = randomPos();
    this.x = p.x;
    this.y = p.y;
    this.dead = false;
  }
}

class Ejected {
  constructor(x, y, vx, vy, color) {
    this.id = nextId();
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.color = color;
    this.mass = CONFIG.ejectMass;
  }
}

// A player or bot, owning a group of cells.
class Player {
  constructor(name, color, isBot) {
    this.id = nextId();
    this.name = (name || "Player").slice(0, 14);
    this.color = color;
    this.isBot = isBot;
    this.cells = [];
    this.dead = true;
    this.respawnTimer = 0;
    // Input / intent
    this.targetX = 0;
    this.targetY = 0;
    this.wantSplit = false;
    this.wantEject = false;
    // Bot state
    this.botTarget = randomPos();
    this.retargetTimer = 0;
    // Cached centroid (for camera / minimap when dead)
    this.cx = 0;
    this.cy = 0;
  }

  spawn(mass) {
    const p = randomPos();
    this.cells = [new Cell(this.id, mass, p.x, p.y)];
    this.dead = false;
    this.targetX = p.x;
    this.targetY = p.y;
    this.cx = p.x;
    this.cy = p.y;
  }

  get totalMass() {
    let m = 0;
    for (const c of this.cells) m += c.mass;
    return m;
  }

  updateCentroid() {
    let x = 0, y = 0, t = 0;
    for (const c of this.cells) {
      x += c.x * c.mass;
      y += c.y * c.mass;
      t += c.mass;
    }
    if (t > 0) {
      this.cx = x / t;
      this.cy = y / t;
    }
  }
}

// ---------------------------------------------------------------------------
// Game world
// ---------------------------------------------------------------------------
export class Game {
  constructor() {
    this.players = new Map(); // id -> Player
    this.food = [];           // { x, y, color }
    this.viruses = [];
    this.ejected = [];

    for (let i = 0; i < CONFIG.foodCount; i++) {
      const p = randomPos();
      this.food.push({ x: p.x, y: p.y, color: pick(COLORS) });
    }
    for (let i = 0; i < CONFIG.virusCount; i++) this.viruses.push(new Virus());
  }

  // --- Player lifecycle ---
  addPlayer(name, isBot = false) {
    if (isBot && !name) name = pick(BOT_NAMES);
    const player = new Player(name, pick(COLORS), isBot);
    player.spawn(isBot ? rand(CONFIG.startMass, CONFIG.startMass * 5) : CONFIG.startMass);
    this.players.set(player.id, player);
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  setTarget(id, x, y) {
    const p = this.players.get(id);
    if (!p) return;
    p.targetX = clamp(x, -CONFIG.worldSize, CONFIG.worldSize);
    p.targetY = clamp(y, -CONFIG.worldSize, CONFIG.worldSize);
  }

  requestSplit(id) {
    const p = this.players.get(id);
    if (p) p.wantSplit = true;
  }

  requestEject(id) {
    const p = this.players.get(id);
    if (p) p.wantEject = true;
  }

  get humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  get botCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.isBot) n++;
    return n;
  }

  // --- Actions ---
  splitPlayer(p, aimX, aimY) {
    const fresh = [];
    for (const cell of p.cells) {
      if (p.cells.length + fresh.length >= CONFIG.maxCells) break;
      if (cell.mass < CONFIG.splitMinMass) continue;
      const half = cell.mass / 2;
      cell.mass = half;
      cell.mergeTimer = CONFIG.mergeCooldown;

      let dx = aimX - cell.x, dy = aimY - cell.y;
      let len = Math.hypot(dx, dy);
      if (len < 1e-4) { dx = 1; dy = 0; len = 1; }
      dx /= len; dy /= len;

      const child = new Cell(p.id, half, cell.x, cell.y);
      child.mergeTimer = CONFIG.mergeCooldown;
      child.vx = dx * CONFIG.splitImpulse;
      child.vy = dy * CONFIG.splitImpulse;
      fresh.push(child);
    }
    p.cells.push(...fresh);
  }

  ejectPlayer(p, aimX, aimY) {
    for (const cell of p.cells) {
      if (cell.mass < CONFIG.splitMinMass) continue;
      let dx = aimX - cell.x, dy = aimY - cell.y;
      let len = Math.hypot(dx, dy);
      if (len < 1e-4) { dx = 1; dy = 0; len = 1; }
      dx /= len; dy /= len;
      cell.mass -= CONFIG.ejectCost;
      const sx = cell.x + dx * (cell.radius + 12);
      const sy = cell.y + dy * (cell.radius + 12);
      this.ejected.push(new Ejected(sx, sy, dx * CONFIG.ejectSpeed, dy * CONFIG.ejectSpeed, p.color));
    }
  }

  // Burst a cell into fragments (eats a virus).
  popCell(p, cell) {
    const budget = CONFIG.maxCells - p.cells.length;
    const pieces = Math.min(CONFIG.virusPopPieces, budget + 1);
    if (pieces <= 1) {
      cell.mergeTimer = CONFIG.mergeCooldown;
      return;
    }
    const fragMass = cell.mass / pieces;
    cell.mass = fragMass;
    cell.mergeTimer = CONFIG.mergeCooldown;
    for (let i = 1; i < pieces; i++) {
      const ang = (i / pieces) * Math.PI * 2 + Math.random() * 0.6;
      const frag = new Cell(p.id, fragMass, cell.x, cell.y);
      frag.mergeTimer = CONFIG.mergeCooldown;
      frag.vx = Math.cos(ang) * CONFIG.splitImpulse * 0.9;
      frag.vy = Math.sin(ang) * CONFIG.splitImpulse * 0.9;
      p.cells.push(frag);
    }
  }

  // --- Movement ---
  moveCells(p, targetX, targetY, dt) {
    for (const cell of p.cells) {
      const dx = targetX - cell.x, dy = targetY - cell.y;
      const dist = Math.hypot(dx, dy);
      const speed = CONFIG.baseSpeed * Math.pow(20 / Math.max(cell.mass, 20), 0.32);

      if (dist > 1) {
        const nx = dx / dist, ny = dy / dist;
        const approach = Math.min(speed, dist * 6);
        cell.vx += nx * approach * dt * 8;
        cell.vy += ny * approach * dt * 8;
      }

      cell.x += cell.vx * dt;
      cell.y += cell.vy * dt;
      const damp = Math.pow(0.0015, dt);
      cell.vx *= damp;
      cell.vy *= damp;

      const vlen = Math.hypot(cell.vx, cell.vy);
      if (vlen > speed && vlen > 0) {
        const k = clamp(speed / vlen, 0.85, 1);
        cell.vx *= k;
        cell.vy *= k;
      }

      if (cell.mass > CONFIG.startMass) cell.mass -= cell.mass * CONFIG.decayRate * dt;

      const s = CONFIG.worldSize;
      cell.x = clamp(cell.x, -s, s);
      cell.y = clamp(cell.y, -s, s);
      if (cell.mergeTimer > 0) cell.mergeTimer -= dt;
    }
  }

  resolveSiblings(p) {
    const cells = p.cells;
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const minD = a.radius + b.radius;
        const canMerge = a.mergeTimer <= 0 && b.mergeTimer <= 0;

        if (canMerge && d < minD * 0.5) {
          const total = a.mass + b.mass;
          a.x = (a.x * a.mass + b.x * b.mass) / total;
          a.y = (a.y * a.mass + b.y * b.mass) / total;
          a.mass = total;
          cells.splice(j, 1);
          j--;
          continue;
        }
        if (!canMerge && d < minD && d > 1e-4) {
          const overlap = (minD - d) * 0.5;
          dx /= d; dy /= d;
          a.x -= dx * overlap; a.y -= dy * overlap;
          b.x += dx * overlap; b.y += dy * overlap;
        }
      }
    }
  }

  // --- Bot AI ---
  updateBot(bot, dt) {
    bot.retargetTimer -= dt;
    const head = bot.cells[0];
    if (!head) return;

    let best = null, bestScore = -Infinity;
    let threat = null, threatDist = Infinity;

    for (const other of this.players.values()) {
      if (other === bot || other.dead) continue;
      for (const oc of other.cells) {
        const dx = oc.x - head.x, dy = oc.y - head.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1200 * 1200) continue;
        const d = Math.sqrt(d2) || 1;
        if (head.mass > oc.mass * CONFIG.eatRatio) {
          const score = oc.mass / d;
          if (score > bestScore) { bestScore = score; best = oc; }
        } else if (oc.mass > head.mass * CONFIG.eatRatio) {
          if (d < threatDist) { threatDist = d; threat = oc; }
        }
      }
    }

    if (threat && threatDist < 600) {
      let ax = head.x - threat.x, ay = head.y - threat.y;
      const l = Math.hypot(ax, ay) || 1;
      bot.botTarget = { x: head.x + (ax / l) * 800, y: head.y + (ay / l) * 800 };
    } else if (best) {
      bot.botTarget = { x: best.x, y: best.y };
      if (bot.totalMass > 120 && Math.random() < 0.004) this.splitPlayer(bot, best.x, best.y);
    } else if (bot.retargetTimer <= 0) {
      let nearest = null, nd = Infinity;
      for (let i = 0; i < this.food.length; i += 7) {
        const f = this.food[i];
        const dx = f.x - head.x, dy = f.y - head.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nd) { nd = d2; nearest = f; }
      }
      bot.botTarget = nearest ? { x: nearest.x, y: nearest.y } : randomPos();
      bot.retargetTimer = rand(1.5, 4);
    }

    this.moveCells(bot, bot.botTarget.x, bot.botTarget.y, dt);
    this.resolveSiblings(bot);
  }

  // --- Eating ---
  handleEating() {
    const actors = [...this.players.values()].filter((a) => !a.dead);

    // Spatial grid over food so each cell only tests nearby pellets
    // (keeps the hot loop cheap on low-powered hosts).
    const GS = 300;
    const gridKey = (gx, gy) => gx * 100000 + gy;
    const foodGrid = new Map();
    for (let i = 0; i < this.food.length; i++) {
      const f = this.food[i];
      const k = gridKey(Math.floor(f.x / GS), Math.floor(f.y / GS));
      let bucket = foodGrid.get(k);
      if (!bucket) { bucket = []; foodGrid.set(k, bucket); }
      bucket.push(i);
    }

    // Food + ejected blobs
    for (const a of actors) {
      for (const cell of a.cells) {
        const r = cell.radius, r2 = r * r;
        const minGx = Math.floor((cell.x - r) / GS), maxGx = Math.floor((cell.x + r) / GS);
        const minGy = Math.floor((cell.y - r) / GS), maxGy = Math.floor((cell.y + r) / GS);
        for (let gx = minGx; gx <= maxGx; gx++) {
          for (let gy = minGy; gy <= maxGy; gy++) {
            const bucket = foodGrid.get(gridKey(gx, gy));
            if (!bucket) continue;
            for (const idx of bucket) {
              const food = this.food[idx];
              const dx = food.x - cell.x, dy = food.y - cell.y;
              if (dx * dx + dy * dy < r2) {
                cell.mass += CONFIG.foodMass;
                const p = randomPos();
                food.x = p.x; food.y = p.y;
              }
            }
          }
        }
        for (let k = this.ejected.length - 1; k >= 0; k--) {
          const e = this.ejected[k];
          const dx = e.x - cell.x, dy = e.y - cell.y;
          if (dx * dx + dy * dy < r2) {
            cell.mass += e.mass;
            this.ejected.splice(k, 1);
          }
        }
      }
    }

    // Cells eat other actors' cells
    for (const a of actors) {
      for (const ca of a.cells) {
        for (const b of actors) {
          if (b === a) continue;
          for (let k = b.cells.length - 1; k >= 0; k--) {
            const cb = b.cells[k];
            if (ca.mass < cb.mass * CONFIG.eatRatio) continue;
            const dx = cb.x - ca.x, dy = cb.y - ca.y;
            const dist = Math.hypot(dx, dy);
            if (dist < ca.radius - cb.radius * 0.4) {
              ca.mass += cb.mass;
              b.cells.splice(k, 1);
            }
          }
        }
      }
    }
  }

  handleViruses(dt) {
    const actors = [...this.players.values()].filter((a) => !a.dead);
    for (const virus of this.viruses) {
      if (virus.dead) {
        virus.respawnTimer -= dt;
        if (virus.respawnTimer <= 0) virus.respawn();
        continue;
      }
      for (const a of actors) {
        let popped = false;
        for (const cell of [...a.cells]) {
          if (cell.mass <= virus.mass * CONFIG.virusEatRatio) continue;
          const dx = virus.x - cell.x, dy = virus.y - cell.y;
          if (dx * dx + dy * dy < cell.radius * cell.radius) {
            cell.mass += virus.mass;
            this.popCell(a, cell);
            virus.dead = true;
            virus.respawnTimer = CONFIG.virusRespawnDelay;
            popped = true;
            break;
          }
        }
        if (popped) break;
      }
    }
  }

  updateEjected(dt) {
    const s = CONFIG.worldSize;
    for (const e of this.ejected) {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      const damp = Math.pow(0.01, dt);
      e.vx *= damp;
      e.vy *= damp;
      e.x = clamp(e.x, -s, s);
      e.y = clamp(e.y, -s, s);
    }
  }

  // Keep the world populated with bots; back off as humans join.
  manageBots() {
    const desired = clamp(CONFIG.targetPopulation - this.humanCount, CONFIG.minBots, CONFIG.maxBots);
    let bots = this.botCount;
    // Add gradually (one per call) so populations ease in/out.
    if (bots < desired) {
      this.addPlayer(pick(BOT_NAMES), true);
    } else if (bots > desired) {
      for (const p of this.players.values()) {
        if (p.isBot) { this.removePlayer(p.id); break; }
      }
    }
  }

  // --- Main tick ---
  tick(dt) {
    for (const p of this.players.values()) {
      if (p.dead) {
        if (p.isBot) {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) {
            p.color = pick(COLORS);
            p.name = pick(BOT_NAMES);
            p.spawn(rand(CONFIG.startMass, CONFIG.startMass * 4));
          }
        }
        continue;
      }

      // Apply queued actions.
      if (p.wantSplit) { this.splitPlayer(p, p.isBot ? p.botTarget.x : p.targetX, p.isBot ? p.botTarget.y : p.targetY); p.wantSplit = false; }
      if (p.wantEject) { this.ejectPlayer(p, p.targetX, p.targetY); p.wantEject = false; }

      if (p.isBot) {
        this.updateBot(p, dt);
      } else {
        this.moveCells(p, p.targetX, p.targetY, dt);
        this.resolveSiblings(p);
      }
    }

    this.updateEjected(dt);
    this.handleEating();
    this.handleViruses(dt);

    // Update centroids + death detection.
    for (const p of this.players.values()) {
      if (p.dead) continue;
      if (p.cells.length === 0) {
        p.dead = true;
        p.respawnTimer = CONFIG.botRespawnDelay;
      } else {
        p.updateCentroid();
      }
    }
  }

  // --- Snapshot for one player (viewport-culled) ---
  snapshotFor(player) {
    const mass = player.totalMass;
    const view = CONFIG.viewBase + Math.pow(Math.max(mass, 1), 0.55) * CONFIG.viewMassScale + 400;
    const cx = player.cx, cy = player.cy;
    const inView = (x, y, pad = 0) =>
      Math.abs(x - cx) < view + pad && Math.abs(y - cy) < view + pad;

    const cells = [];
    const names = {};
    for (const p of this.players.values()) {
      for (const c of p.cells) {
        if (!inView(c.x, c.y, c.radius)) continue;
        cells.push({ i: c.id, o: p.id, x: Math.round(c.x), y: Math.round(c.y), m: Math.round(c.mass), c: p.color });
        names[p.id] = p.name;
      }
    }

    const food = [];
    for (const f of this.food) {
      if (inView(f.x, f.y)) food.push({ x: Math.round(f.x), y: Math.round(f.y), c: f.color });
    }

    const viruses = [];
    for (const v of this.viruses) {
      if (!v.dead && inView(v.x, v.y, v.radius)) {
        viruses.push({ i: v.id, x: Math.round(v.x), y: Math.round(v.y), r: Math.round(v.radius) });
      }
    }

    const ejected = [];
    for (const e of this.ejected) {
      if (inView(e.x, e.y)) ejected.push({ i: e.id, x: Math.round(e.x), y: Math.round(e.y), c: e.color });
    }

    // Global leaderboard (top 10 by mass).
    const board = [...this.players.values()]
      .filter((p) => !p.dead)
      .map((p) => ({ n: p.name, m: Math.round(p.totalMass), me: p.id === player.id }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 10);

    return {
      t: "state",
      me: { alive: !player.dead, x: Math.round(cx), y: Math.round(cy), m: Math.round(mass) },
      cells, food, viruses, ejected, names,
      leaderboard: board,
    };
  }
}
