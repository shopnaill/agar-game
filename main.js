import * as THREE from "three";

/* ============================================================
 * Three.js Agar — a top-down agar.io-style game.
 *
 * Mechanics:
 *   - You control a cell; it follows the mouse cursor.
 *   - Eat food pellets and smaller cells to grow your mass.
 *   - Larger cells (bots) can eat you. Avoid them.
 *   - Bigger cells move slower. The camera zooms out as you grow.
 *   - Space splits your cell; W ejects a small mass blob.
 * ========================================================== */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  worldSize: 4000,        // half-extent of the square play area (-W..W)
  foodCount: 700,
  foodMass: 1,
  startMass: 20,
  botCount: 18,
  botRespawnDelay: 3,     // seconds before a dead bot respawns
  eatRatio: 1.15,         // how much bigger you must be to eat another cell
  mergeRatio: 1.33,       // overlap fraction needed to consume
  baseSpeed: 320,         // world units / second at small size
  splitImpulse: 1400,
  splitMinMass: 36,
  maxCells: 16,           // max cells one player/bot can have at once
  mergeCooldown: 12,      // seconds before split cells can re-merge
  ejectMass: 14,
  ejectCost: 18,
  ejectSpeed: 1600,
  decayRate: 0.002,       // passive mass decay per second per mass unit
  // Viruses (green spikes that pop big cells)
  virusCount: 14,
  virusMass: 130,         // a cell must be larger than this to risk popping
  virusEatRatio: 1.15,    // cell.mass > virus.mass * ratio to trigger a pop
  virusPopPieces: 8,      // max fragments a popped cell bursts into
  virusRespawnDelay: 8,   // seconds before a consumed virus respawns
};

const VIRUS_COLOR = 0x33d17a;

const NAMES = [
  "Blobby", "Nibbles", "Mr. Big", "Voracious", "Tiny", "Gulp",
  "Sir Eats", "Pac", "Munch", "Chonk", "Zippy", "Goo", "Splat",
  "Bubbles", "Crumb", "Vortex", "Pixel", "Nom", "Hungry", "Orbit",
];

const COLORS = [
  0x58e08a, 0x4f9dff, 0xff6b6b, 0xffd93d, 0xb16cff,
  0xff9f43, 0x2ee6d6, 0xff6bcb, 0x9be564, 0xff8c69,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const massToRadius = (mass) => Math.sqrt(mass) * 8;

function randomPosition() {
  const m = CONFIG.worldSize * 0.95;
  return new THREE.Vector2(rand(-m, m), rand(-m, m));
}

// ---------------------------------------------------------------------------
// Sound — tiny WebAudio synth (no asset files needed).
// ---------------------------------------------------------------------------
const Sound = {
  ctx: null,
  enabled: true,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) this.ctx = new AC();
  },
  // Play a short tone. type: oscillator wave; freq sweeps from f0 to f1.
  tone(f0, f1, dur, type = "sine", gain = 0.12) {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), now + dur);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(env).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  },
  eat() { this.tone(440, 660, 0.08, "sine", 0.05); },
  eatCell() { this.tone(300, 520, 0.16, "triangle", 0.14); },
  split() { this.tone(520, 240, 0.14, "sawtooth", 0.1); },
  eject() { this.tone(360, 180, 0.1, "square", 0.06); },
  pop() { this.tone(220, 90, 0.3, "sawtooth", 0.18); },
  death() { this.tone(330, 70, 0.6, "sawtooth", 0.2); },
};

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 1800, 4200);

// Camera looks straight down the Y axis onto the XZ plane.
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 12000);
camera.position.set(0, 1200, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.6);
keyLight.position.set(400, 1000, 200);
scene.add(keyLight);

// Floor grid
const grid = new THREE.GridHelper(CONFIG.worldSize * 2, 80, 0x21262d, 0x191f27);
grid.position.y = -5;
scene.add(grid);

// World boundary outline
function makeBoundary() {
  const s = CONFIG.worldSize;
  const pts = [
    new THREE.Vector3(-s, 0, -s),
    new THREE.Vector3(s, 0, -s),
    new THREE.Vector3(s, 0, s),
    new THREE.Vector3(-s, 0, s),
    new THREE.Vector3(-s, 0, -s),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0x30363d });
  return new THREE.Line(geo, mat);
}
scene.add(makeBoundary());

// Shared geometry for spheres (reused, scaled per-cell)
const sphereGeo = new THREE.SphereGeometry(1, 24, 18);
const foodGeo = new THREE.SphereGeometry(1, 8, 6);

// Spiky virus geometry: a sphere whose alternating vertices are pushed outward.
function makeVirusGeometry() {
  const geo = new THREE.SphereGeometry(1, 22, 16);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const spike = i % 2 === 0 ? 1.32 : 0.92; // alternate out/in for a spiked look
    v.multiplyScalar(spike);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}
const virusGeo = makeVirusGeometry();

// ---------------------------------------------------------------------------
// Game entities
// ---------------------------------------------------------------------------

// A "Cell" is one circular blob. Players/bots are made of one or more cells.
class Cell {
  constructor(owner, mass, position, color) {
    this.owner = owner;
    this.mass = mass;
    this.pos = position.clone();
    this.vel = new THREE.Vector2(0, 0);
    this.mergeTimer = 0; // time until this cell may merge with siblings

    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.45,
      metalness: 0.0,
      emissive: new THREE.Color(color).multiplyScalar(0.18),
    });
    this.mesh = new THREE.Mesh(sphereGeo, mat);
    this.syncMesh();
    scene.add(this.mesh);
  }

  get radius() {
    return massToRadius(this.mass);
  }

  syncMesh() {
    const r = this.radius;
    this.mesh.scale.setScalar(r);
    this.mesh.position.set(this.pos.x, r, this.pos.y);
  }

  dispose() {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

// A player or AI bot, owning a group of cells.
class Actor {
  constructor(name, color, isBot) {
    this.name = name;
    this.color = color;
    this.isBot = isBot;
    this.cells = [];
    this.dead = false;
    this.respawnTimer = 0;
    // Bot behaviour state
    this.target = randomPosition();
    this.retargetTimer = 0;
  }

  spawn(mass) {
    const p = randomPosition();
    this.cells = [new Cell(this, mass, p, this.color)];
    this.dead = false;
  }

  get totalMass() {
    let m = 0;
    for (const c of this.cells) m += c.mass;
    return m;
  }

  // Mass-weighted center of all owned cells.
  get center() {
    const c = new THREE.Vector2();
    let total = 0;
    for (const cell of this.cells) {
      c.addScaledVector(cell.pos, cell.mass);
      total += cell.mass;
    }
    if (total > 0) c.multiplyScalar(1 / total);
    return c;
  }

  remove() {
    for (const c of this.cells) c.dispose();
    this.cells = [];
    this.dead = true;
  }
}

// Food pellet
class Food {
  constructor() {
    this.pos = randomPosition();
    this.mass = CONFIG.foodMass;
    const color = pick(COLORS);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.4),
      roughness: 0.6,
    });
    this.mesh = new THREE.Mesh(foodGeo, mat);
    const r = 10;
    this.mesh.scale.setScalar(r);
    this.mesh.position.set(this.pos.x, r, this.pos.y);
    scene.add(this.mesh);
  }

  reposition() {
    this.pos = randomPosition();
    this.mesh.position.set(this.pos.x, 10, this.pos.y);
  }
}

// Ejected mass blob (also edible like food)
class Ejected {
  constructor(pos, vel, color) {
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.mass = CONFIG.ejectMass;
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.3),
      roughness: 0.5,
    });
    this.mesh = new THREE.Mesh(foodGeo, mat);
    const r = massToRadius(this.mass);
    this.mesh.scale.setScalar(r);
    this.mesh.position.set(pos.x, r, pos.y);
    scene.add(this.mesh);
  }

  dispose() {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

// Virus — a green spiky cell. Bigger cells that touch it get popped apart.
class Virus {
  constructor() {
    this.mass = CONFIG.virusMass;
    this.dead = false;
    this.respawnTimer = 0;
    const mat = new THREE.MeshStandardMaterial({
      color: VIRUS_COLOR,
      emissive: new THREE.Color(VIRUS_COLOR).multiplyScalar(0.25),
      roughness: 0.5,
      flatShading: true,
    });
    this.mesh = new THREE.Mesh(virusGeo, mat);
    scene.add(this.mesh);
    this.respawn();
  }

  get radius() {
    return massToRadius(this.mass);
  }

  respawn() {
    this.pos = randomPosition();
    this.dead = false;
    this.mesh.visible = true;
    const r = this.radius;
    this.mesh.scale.setScalar(r);
    this.mesh.position.set(this.pos.x, r, this.pos.y);
  }

  consume() {
    // Hide and schedule a respawn elsewhere.
    this.dead = true;
    this.mesh.visible = false;
    this.respawnTimer = CONFIG.virusRespawnDelay;
  }

  spin(dt) {
    if (!this.dead) this.mesh.rotation.y += dt * 0.6;
  }
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const state = {
  running: false,
  player: null,
  bots: [],
  food: [],
  ejected: [],
  viruses: [],
  mouse: new THREE.Vector2(0, 0), // world-space target for the player
  cameraScale: 1,
};

function spawnFood() {
  state.food = [];
  for (let i = 0; i < CONFIG.foodCount; i++) state.food.push(new Food());
}

function spawnViruses() {
  state.viruses = [];
  for (let i = 0; i < CONFIG.virusCount; i++) state.viruses.push(new Virus());
}

function spawnBots() {
  state.bots = [];
  for (let i = 0; i < CONFIG.botCount; i++) {
    const bot = new Actor(pick(NAMES), pick(COLORS), true);
    bot.spawn(rand(CONFIG.startMass, CONFIG.startMass * 6));
    state.bots.push(bot);
  }
}

function startGame(playerName) {
  // Clean any prior entities
  if (state.player) state.player.remove();
  for (const b of state.bots) b.remove();
  for (const f of state.food) {
    scene.remove(f.mesh);
    f.mesh.material.dispose();
  }
  for (const e of state.ejected) e.dispose();
  state.ejected = [];
  for (const v of state.viruses) {
    scene.remove(v.mesh);
    v.mesh.material.dispose();
  }
  state.viruses = [];

  spawnFood();
  spawnViruses();
  spawnBots();

  state.player = new Actor(playerName || "You", pick(COLORS), false);
  state.player.spawn(CONFIG.startMass);

  state.running = true;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const pointer = new THREE.Vector2(0, 0); // normalized device coords
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function updateMouseWorld() {
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, hit)) {
    state.mouse.set(hit.x, hit.z);
  }
}

window.addEventListener("mousemove", (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener("keydown", (e) => {
  if (!state.running || !state.player || state.player.dead) return;
  if (e.code === "Space") {
    e.preventDefault();
    splitActor(state.player, state.mouse);
  } else if (e.code === "KeyW") {
    ejectMass(state.player, state.mouse);
  }
});

// --- Touch controls (mobile): drag to steer + on-screen buttons ---
const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
if (isTouch) document.body.classList.add("touch");

function steerFromTouch(e) {
  // Use the first touch that isn't on an action button.
  let t = null;
  for (const touch of e.touches) {
    if (!(touch.target && touch.target.closest && touch.target.closest(".touch-btn"))) {
      t = touch;
      break;
    }
  }
  if (!t) return;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  let dx = t.clientX - cx;
  let dy = t.clientY - cy;
  const len = Math.hypot(dx, dy) || 1;
  // Joystick-style: direction from screen center, with a soft dead-zone.
  const scale = Math.min(1, len / (Math.min(cx, cy) * 0.6));
  pointer.x = (dx / len) * scale;
  pointer.y = -(dy / len) * scale;
}
window.addEventListener("touchstart", steerFromTouch, { passive: true });
window.addEventListener("touchmove", steerFromTouch, { passive: true });

function bindAction(id, action) {
  const el = document.getElementById(id);
  const fire = (ev) => {
    ev.preventDefault();
    if (state.running && state.player && !state.player.dead) action(state.player, state.mouse);
  };
  el.addEventListener("touchstart", fire, { passive: false });
  el.addEventListener("mousedown", fire);
}
bindAction("btn-split", splitActor);
bindAction("btn-eject", ejectMass);

// ---------------------------------------------------------------------------
// Actions: split & eject
// ---------------------------------------------------------------------------
function splitActor(actor, aimWorld) {
  const newCells = [];
  for (const cell of actor.cells) {
    if (actor.cells.length + newCells.length >= CONFIG.maxCells) break;
    if (cell.mass < CONFIG.splitMinMass) continue;

    const half = cell.mass / 2;
    cell.mass = half;
    cell.mergeTimer = CONFIG.mergeCooldown;

    let dir = new THREE.Vector2().subVectors(aimWorld, cell.pos);
    if (dir.lengthSq() < 1e-4) dir.set(1, 0);
    dir.normalize();

    const child = new Cell(actor, half, cell.pos.clone(), actor.color);
    child.mergeTimer = CONFIG.mergeCooldown;
    child.vel.copy(dir).multiplyScalar(CONFIG.splitImpulse);
    newCells.push(child);
  }
  if (newCells.length && actor === state.player) Sound.split();
  actor.cells.push(...newCells);
}

function ejectMass(actor, aimWorld) {
  for (const cell of actor.cells) {
    if (cell.mass < CONFIG.splitMinMass) continue;
    let dir = new THREE.Vector2().subVectors(aimWorld, cell.pos);
    if (dir.lengthSq() < 1e-4) dir.set(1, 0);
    dir.normalize();

    cell.mass -= CONFIG.ejectCost;
    const spawnPos = cell.pos.clone().addScaledVector(dir, cell.radius + 12);
    const vel = dir.clone().multiplyScalar(CONFIG.ejectSpeed);
    state.ejected.push(new Ejected(spawnPos, vel, actor.color));
    if (actor === state.player) Sound.eject();
  }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
function moveActorCells(actor, targetWorld, dt) {
  for (const cell of actor.cells) {
    const toTarget = new THREE.Vector2().subVectors(targetWorld, cell.pos);
    const dist = toTarget.length();

    // Speed falls off with size; large cells crawl.
    const speed = CONFIG.baseSpeed * Math.pow(20 / Math.max(cell.mass, 20), 0.32);

    if (dist > 1) {
      toTarget.multiplyScalar(1 / dist);
      // Approach speed scales down as we get very close to the cursor.
      const approach = Math.min(speed, dist * 6);
      cell.vel.addScaledVector(toTarget, approach * dt * 8);
    }

    // Apply velocity (includes split impulse) with damping.
    cell.pos.addScaledVector(cell.vel, dt);
    cell.vel.multiplyScalar(Math.pow(0.0015, dt)); // strong damping

    // Cap steady-state speed
    const vlen = cell.vel.length();
    if (vlen > speed && vlen > 0) {
      // keep impulse bursts but bleed toward max
      cell.vel.multiplyScalar(clamp(speed / vlen, 0.85, 1));
    }

    // Mass decay (bigger cells shrink faster), keep a floor.
    if (cell.mass > CONFIG.startMass) {
      cell.mass -= cell.mass * CONFIG.decayRate * dt;
    }

    // World bounds
    const s = CONFIG.worldSize;
    cell.pos.x = clamp(cell.pos.x, -s, s);
    cell.pos.y = clamp(cell.pos.y, -s, s);

    if (cell.mergeTimer > 0) cell.mergeTimer -= dt;
  }
}

// Keep sibling cells apart (unless ready to merge), and merge when ready.
function resolveSiblings(actor) {
  const cells = actor.cells;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const delta = new THREE.Vector2().subVectors(b.pos, a.pos);
      let d = delta.length();
      const minD = a.radius + b.radius;
      const canMerge = a.mergeTimer <= 0 && b.mergeTimer <= 0;

      if (canMerge && d < (a.radius + b.radius) * 0.5) {
        // Merge b into a (mass-weighted position).
        const total = a.mass + b.mass;
        a.pos.multiplyScalar(a.mass / total).addScaledVector(b.pos, b.mass / total);
        a.mass = total;
        b.dispose();
        cells.splice(j, 1);
        j--;
        continue;
      }

      if (!canMerge && d < minD && d > 1e-4) {
        // Push apart
        const overlap = (minD - d) * 0.5;
        delta.multiplyScalar(1 / d);
        a.pos.addScaledVector(delta, -overlap);
        b.pos.addScaledVector(delta, overlap);
      }
    }
  }
}

// Eating: actor cells consume food, ejected blobs, and other cells.
function handleEating() {
  const actors = [state.player, ...state.bots].filter((a) => a && !a.dead);

  // --- Cells eat food ---
  for (const actor of actors) {
    for (const cell of actor.cells) {
      const r = cell.radius;
      for (const food of state.food) {
        const dx = food.pos.x - cell.pos.x;
        const dy = food.pos.y - cell.pos.y;
        if (dx * dx + dy * dy < r * r) {
          cell.mass += food.mass;
          food.reposition();
          if (actor === state.player) Sound.eat();
        }
      }
      // --- Cells eat ejected blobs ---
      for (let k = state.ejected.length - 1; k >= 0; k--) {
        const e = state.ejected[k];
        const dx = e.pos.x - cell.pos.x;
        const dy = e.pos.y - cell.pos.y;
        if (dx * dx + dy * dy < r * r) {
          cell.mass += e.mass;
          e.dispose();
          state.ejected.splice(k, 1);
        }
      }
    }
  }

  // --- Cells eat other actors' cells ---
  for (const a of actors) {
    for (const ca of a.cells) {
      for (const b of actors) {
        if (b === a) continue;
        for (let k = b.cells.length - 1; k >= 0; k--) {
          const cb = b.cells[k];
          if (ca.mass < cb.mass * CONFIG.eatRatio) continue;
          const dx = cb.pos.x - ca.pos.x;
          const dy = cb.pos.y - ca.pos.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // Must substantially overlap to swallow.
          if (dist < ca.radius - cb.radius * 0.4) {
            ca.mass += cb.mass;
            cb.dispose();
            b.cells.splice(k, 1);
            if (a === state.player || b === state.player) Sound.eatCell();
          }
        }
      }
    }
  }

  // Mark actors with no cells as dead.
  for (const b of state.bots) {
    if (!b.dead && b.cells.length === 0) {
      b.dead = true;
      b.respawnTimer = CONFIG.botRespawnDelay;
    }
  }
  if (state.player && !state.player.dead && state.player.cells.length === 0) {
    onPlayerDeath();
  }
}

// Burst one cell into many fragments (when it eats a virus).
function popCell(actor, cell) {
  if (actor.cells.indexOf(cell) === -1) return;
  // Fragment count limited by the remaining cell budget.
  const budget = CONFIG.maxCells - actor.cells.length;
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
    const dir = new THREE.Vector2(Math.cos(ang), Math.sin(ang));
    const frag = new Cell(actor, fragMass, cell.pos.clone(), actor.color);
    frag.mergeTimer = CONFIG.mergeCooldown;
    frag.vel.copy(dir).multiplyScalar(CONFIG.splitImpulse * 0.9);
    actor.cells.push(frag);
  }
}

// Viruses pop oversized cells on contact, then respawn on a timer.
function handleViruses(dt) {
  const actors = [state.player, ...state.bots].filter((a) => a && !a.dead);
  for (const virus of state.viruses) {
    virus.spin(dt);
    if (virus.dead) {
      virus.respawnTimer -= dt;
      if (virus.respawnTimer <= 0) virus.respawn();
      continue;
    }
    for (const actor of actors) {
      let popped = false;
      for (const cell of [...actor.cells]) {
        if (cell.mass <= virus.mass * CONFIG.virusEatRatio) continue;
        const dx = virus.pos.x - cell.pos.x;
        const dy = virus.pos.y - cell.pos.y;
        if (dx * dx + dy * dy < cell.radius * cell.radius) {
          cell.mass += virus.mass; // absorb the virus mass, then burst
          popCell(actor, cell);
          virus.consume();
          if (actor === state.player) Sound.pop();
          popped = true;
          break;
        }
      }
      if (popped) break;
    }
  }
}

// ---------------------------------------------------------------------------
// Bot AI
// ---------------------------------------------------------------------------
function updateBot(bot, dt) {
  bot.retargetTimer -= dt;
  const head = bot.cells[0];
  if (!head) return;

  const myMass = bot.totalMass;
  let best = null;
  let bestScore = -Infinity;
  let threat = null;
  let threatDist = Infinity;

  // Scan nearby actors for prey & predators.
  const others = [state.player, ...state.bots];
  for (const other of others) {
    if (!other || other === bot || other.dead) continue;
    for (const oc of other.cells) {
      const dx = oc.pos.x - head.pos.x;
      const dy = oc.pos.y - head.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1200 * 1200) continue;
      const d = Math.sqrt(d2) || 1;

      if (head.mass > oc.mass * CONFIG.eatRatio) {
        // Prey — closer & bigger is better.
        const score = oc.mass / d;
        if (score > bestScore) {
          bestScore = score;
          best = oc.pos;
        }
      } else if (oc.mass > head.mass * CONFIG.eatRatio) {
        // Predator — track nearest.
        if (d < threatDist) {
          threatDist = d;
          threat = oc.pos;
        }
      }
    }
  }

  // Flee from a close predator.
  if (threat && threatDist < 600) {
    const away = new THREE.Vector2().subVectors(head.pos, threat);
    if (away.lengthSq() < 1e-3) away.set(1, 0);
    away.normalize().multiplyScalar(800);
    bot.target = new THREE.Vector2(head.pos.x + away.x, head.pos.y + away.y);
  } else if (best) {
    bot.target = best.clone();
    // Occasionally split to catch prey if much bigger.
    if (myMass > 120 && Math.random() < 0.004) splitActor(bot, best);
  } else {
    // Wander: seek nearest food, or roam.
    if (bot.retargetTimer <= 0) {
      let nearest = null, nd = Infinity;
      for (let i = 0; i < state.food.length; i += 7) {
        const f = state.food[i];
        const dx = f.pos.x - head.pos.x;
        const dy = f.pos.y - head.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nd) { nd = d2; nearest = f.pos; }
      }
      bot.target = nearest ? nearest.clone() : randomPosition();
      bot.retargetTimer = rand(1.5, 4);
    }
  }

  moveActorCells(bot, bot.target, dt);
  resolveSiblings(bot);
}

function updateEjected(dt) {
  for (let i = state.ejected.length - 1; i >= 0; i--) {
    const e = state.ejected[i];
    e.pos.addScaledVector(e.vel, dt);
    e.vel.multiplyScalar(Math.pow(0.01, dt));
    const s = CONFIG.worldSize;
    e.pos.x = clamp(e.pos.x, -s, s);
    e.pos.y = clamp(e.pos.y, -s, s);
    const r = massToRadius(e.mass);
    e.mesh.position.set(e.pos.x, r, e.pos.y);
  }
}

function respawnDeadBots(dt) {
  for (const bot of state.bots) {
    if (bot.dead) {
      bot.respawnTimer -= dt;
      if (bot.respawnTimer <= 0) {
        bot.color = pick(COLORS);
        bot.name = pick(NAMES);
        bot.spawn(rand(CONFIG.startMass, CONFIG.startMass * 4));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Camera & rendering of meshes
// ---------------------------------------------------------------------------
function updateCamera(dt) {
  if (!state.player || state.player.dead) return;
  const c = state.player.center;
  const mass = state.player.totalMass;

  // Zoom out as the player grows.
  const targetHeight = 700 + Math.pow(mass, 0.55) * 70;
  camera.position.x += (c.x - camera.position.x) * Math.min(1, dt * 6);
  camera.position.z += (c.y - camera.position.z) * Math.min(1, dt * 6);
  camera.position.y += (targetHeight - camera.position.y) * Math.min(1, dt * 3);
  camera.lookAt(c.x, 0, c.y);
}

function syncAllMeshes() {
  const actors = [state.player, ...state.bots];
  for (const a of actors) {
    if (!a) continue;
    for (const cell of a.cells) cell.syncMesh();
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const scoreEl = document.getElementById("score");
const leaderboardList = document.getElementById("leaderboard-list");

function updateHUD() {
  if (!state.player) return;
  const mass = Math.floor(state.player.totalMass);
  scoreEl.textContent = `Mass: ${mass}`;

  // Build leaderboard
  const entries = [];
  if (!state.player.dead) {
    entries.push({ name: state.player.name, mass: state.player.totalMass, me: true });
  }
  for (const b of state.bots) {
    if (!b.dead) entries.push({ name: b.name, mass: b.totalMass, me: false });
  }
  entries.sort((a, b) => b.mass - a.mass);

  leaderboardList.innerHTML = "";
  for (const e of entries.slice(0, 10)) {
    const li = document.createElement("li");
    if (e.me) li.classList.add("me");
    li.innerHTML = `<span class="name">${escapeHtml(e.name)}</span><span class="mass">${Math.floor(e.mass)}</span>`;
    leaderboardList.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------------
// Death / restart flow
// ---------------------------------------------------------------------------
const startScreen = document.getElementById("start-screen");
const deathScreen = document.getElementById("death-screen");
const deathStats = document.getElementById("death-stats");
const nameInput = document.getElementById("name-input");

function onPlayerDeath() {
  const finalMass = Math.floor(state.player.totalMass) || 0;
  Sound.death();
  state.player.remove();
  deathStats.textContent = `Final mass: ${finalMass}`;
  deathScreen.classList.remove("hidden");
}

function beginGame() {
  // Audio can only start from a user gesture.
  Sound.init();
  if (Sound.ctx && Sound.ctx.state === "suspended") Sound.ctx.resume();
  startGame(nameInput.value.trim());
}

document.getElementById("play-button").addEventListener("click", () => {
  startScreen.classList.add("hidden");
  beginGame();
});

document.getElementById("respawn-button").addEventListener("click", () => {
  deathScreen.classList.add("hidden");
  beginGame();
});

nameInput.addEventListener("keydown", (e) => {
  if (e.code === "Enter") document.getElementById("play-button").click();
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp to avoid huge steps

  if (state.running) {
    updateMouseWorld();

    if (state.player && !state.player.dead) {
      moveActorCells(state.player, state.mouse, dt);
      resolveSiblings(state.player);
    }

    for (const bot of state.bots) {
      if (!bot.dead) updateBot(bot, dt);
    }

    updateEjected(dt);
    handleEating();
    handleViruses(dt);
    respawnDeadBots(dt);

    syncAllMeshes();
    updateCamera(dt);
    updateHUD();
  }

  renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
