import * as THREE from "three";

/* ============================================================
 * Three·Agar — multiplayer client.
 *
 * The authoritative simulation runs on the server (see /server).
 * This client:
 *   - connects over WebSocket and sends input (target, split, eject),
 *   - receives viewport-culled world snapshots ~25x/second,
 *   - renders them with Three.js, smoothing entities between snapshots,
 *   - draws name/mass labels and a minimap, and plays sound cues.
 * ========================================================== */

// ---------------------------------------------------------------------------
// Tunables (client-side presentation only)
// ---------------------------------------------------------------------------
const LERP_RATE = 14;        // higher = snappier interpolation toward server state
const INPUT_HZ = 20;         // how often we send movement input
const MAX_FOOD = 2200;       // instanced-food capacity
let WORLD_SIZE = 4000;       // updated from the server "welcome" message

const massToRadius = (m) => Math.sqrt(Math.max(m, 1)) * 8;
const lerp = (a, b, t) => a + (b - a) * t;

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
  eat() { this.tone(440, 660, 0.07, "sine", 0.04); },
  split() { this.tone(520, 240, 0.14, "sawtooth", 0.1); },
  eject() { this.tone(360, 180, 0.1, "square", 0.06); },
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
scene.fog = new THREE.Fog(0x0d1117, 1800, 4600);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 14000);
camera.position.set(0, 1200, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.75);
keyLight.position.set(400, 1400, 200);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x88bbff, 0.25);
rimLight.position.set(-600, 600, -400);
scene.add(rimLight);

// World decorations (grid + boundary), rebuilt if the server world differs.
let worldGroup = new THREE.Group();
scene.add(worldGroup);
function buildWorld(size) {
  scene.remove(worldGroup);
  worldGroup = new THREE.Group();

  const grid = new THREE.GridHelper(size * 2, 80, 0x222a33, 0x171c23);
  grid.position.y = -4;
  worldGroup.add(grid);

  const pts = [
    new THREE.Vector3(-size, 0, -size), new THREE.Vector3(size, 0, -size),
    new THREE.Vector3(size, 0, size), new THREE.Vector3(-size, 0, size),
    new THREE.Vector3(-size, 0, -size),
  ];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x3a4250 })
  );
  worldGroup.add(line);
  scene.add(worldGroup);
}
buildWorld(WORLD_SIZE);

// Geometry
const sphereGeo = new THREE.SphereGeometry(1, 24, 18);
const foodGeo = new THREE.SphereGeometry(1, 8, 6);

function makeVirusGeometry() {
  const geo = new THREE.SphereGeometry(1, 22, 16);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(i % 2 === 0 ? 1.32 : 0.92);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}
const virusGeo = makeVirusGeometry();

// Instanced food
const foodMat = new THREE.MeshStandardMaterial({ roughness: 0.6, vertexColors: true });
const foodMesh = new THREE.InstancedMesh(foodGeo, foodMat, MAX_FOOD);
foodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
foodMesh.count = 0;
scene.add(foodMesh);
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

// ---------------------------------------------------------------------------
// Entity pools (interpolated). Keyed by server entity id.
// ---------------------------------------------------------------------------
const cellMeshes = new Map();   // id -> mesh (userData: tx,ty,tr, ownerId, mine)
const virusMeshes = new Map();  // id -> mesh (userData: tr)
const ejectMeshes = new Map();  // id -> mesh
// Client-side prediction for our own cells: id -> { x,y, vx,vy, sx,sy, mass }
// (x,y) is the locally predicted position; (sx,sy) the latest server truth.
const myPred = new Map();

function makeCellMesh(colorHex) {
  const color = new THREE.Color(colorHex);
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.4, metalness: 0.0,
    emissive: color.clone().multiplyScalar(0.18),
  });
  const mesh = new THREE.Mesh(sphereGeo, mat);
  scene.add(mesh);
  return mesh;
}

function makeVirusMesh() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x33d17a, emissive: 0x0c3a22, roughness: 0.5, flatShading: true,
  });
  const mesh = new THREE.Mesh(virusGeo, mat);
  scene.add(mesh);
  return mesh;
}

function makeEjectMesh(colorHex) {
  const color = new THREE.Color(colorHex);
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color.clone().multiplyScalar(0.3), roughness: 0.5,
  });
  const mesh = new THREE.Mesh(foodGeo, mat);
  scene.add(mesh);
  return mesh;
}

function disposeMesh(mesh) {
  scene.remove(mesh);
  if (mesh.material.dispose) mesh.material.dispose();
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
let ws = null;
let myId = null;
let latest = null;         // most recent state snapshot
let myName = "";
let lastMyMass = 0;
const connectionEl = document.getElementById("connection");

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}

function connect(onReady) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    if (ws.readyState === WebSocket.OPEN) onReady();
    else ws.addEventListener("open", onReady, { once: true });
    return;
  }
  setConnection("Connecting…");
  ws = new WebSocket(wsUrl());
  ws.addEventListener("open", () => {
    setConnection(null);
    onReady();
  });
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", () => {
    setConnection("Disconnected — refresh to reconnect");
    running = false;
  });
  ws.addEventListener("error", () => setConnection("Connection error"));
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function onMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  if (msg.t === "welcome") {
    myId = msg.id;
    if (msg.worldSize && msg.worldSize !== WORLD_SIZE) {
      WORLD_SIZE = msg.worldSize;
      buildWorld(WORLD_SIZE);
    }
  } else if (msg.t === "state") {
    latest = msg;
    // Subtle "eat" blip when our mass ticks up.
    if (msg.me && msg.me.alive) {
      if (msg.me.m > lastMyMass + 0.5) Sound.eat();
      lastMyMass = msg.me.m;
    }
  } else if (msg.t === "dead") {
    onDeath(msg.mass);
  }
}

function setConnection(text) {
  if (!text) { connectionEl.classList.add("hidden"); return; }
  connectionEl.textContent = text;
  connectionEl.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let running = false;
const pointer = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const worldTarget = new THREE.Vector2(0, 0);

function updateWorldTarget() {
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, hit)) worldTarget.set(hit.x, hit.z);
}

window.addEventListener("mousemove", (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener("keydown", (e) => {
  if (!running) return;
  if (e.code === "Space") { e.preventDefault(); send({ t: "split" }); Sound.split(); }
  else if (e.code === "KeyW") { send({ t: "eject" }); Sound.eject(); }
});

// Touch controls: drag to steer + on-screen buttons.
const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
if (isTouch) document.body.classList.add("touch");

function steerFromTouch(e) {
  let t = null;
  for (const touch of e.touches) {
    if (!(touch.target && touch.target.closest && touch.target.closest(".touch-btn"))) { t = touch; break; }
  }
  if (!t) return;
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  let dx = t.clientX - cx, dy = t.clientY - cy;
  const len = Math.hypot(dx, dy) || 1;
  const scale = Math.min(1, len / (Math.min(cx, cy) * 0.6));
  pointer.x = (dx / len) * scale;
  pointer.y = -(dy / len) * scale;
}
window.addEventListener("touchstart", steerFromTouch, { passive: true });
window.addEventListener("touchmove", steerFromTouch, { passive: true });

function bindAction(id, action, sfx) {
  const el = document.getElementById(id);
  const fire = (ev) => {
    ev.preventDefault();
    if (running) { send({ t: action }); sfx(); }
  };
  el.addEventListener("touchstart", fire, { passive: false });
  el.addEventListener("mousedown", fire);
}
bindAction("btn-split", "split", () => Sound.split());
bindAction("btn-eject", "eject", () => Sound.eject());

// ---------------------------------------------------------------------------
// Rendering helpers: labels + minimap
// ---------------------------------------------------------------------------
const labelLayer = document.getElementById("labels");
const labelPool = [];
const _proj = new THREE.Vector3();

function getLabel(i) {
  if (labelPool[i]) return labelPool[i];
  const el = document.createElement("div");
  el.className = "cell-label";
  el.innerHTML = '<span class="lname"></span><span class="lmass"></span>';
  labelLayer.appendChild(el);
  labelPool[i] = { el, name: el.querySelector(".lname"), mass: el.querySelector(".lmass") };
  return labelPool[i];
}

const minimap = document.getElementById("minimap");
const mmCtx = minimap.getContext("2d");

function drawMinimap(state) {
  const W = minimap.width, H = minimap.height;
  mmCtx.clearRect(0, 0, W, H);
  const toMap = (x, y) => [
    ((x + WORLD_SIZE) / (WORLD_SIZE * 2)) * W,
    ((y + WORLD_SIZE) / (WORLD_SIZE * 2)) * H,
  ];

  // Faint grid lines
  mmCtx.strokeStyle = "rgba(255,255,255,0.06)";
  mmCtx.lineWidth = 1;
  for (let k = 1; k < 5; k++) {
    const p = (k / 5) * W;
    mmCtx.beginPath(); mmCtx.moveTo(p, 0); mmCtx.lineTo(p, H); mmCtx.stroke();
    mmCtx.beginPath(); mmCtx.moveTo(0, p); mmCtx.lineTo(W, p); mmCtx.stroke();
  }

  // Visible cells as dots (mine highlighted)
  for (const c of state.cells) {
    const [mx, my] = toMap(c.x, c.y);
    mmCtx.fillStyle = c.o === myId ? "#58e08a" : "rgba(200,210,220,0.5)";
    const r = Math.max(1.5, Math.min(5, massToRadius(c.m) / 90));
    mmCtx.beginPath(); mmCtx.arc(mx, my, r, 0, Math.PI * 2); mmCtx.fill();
  }

  // My position marker
  if (state.me && state.me.alive) {
    const [mx, my] = toMap(state.me.x, state.me.y);
    mmCtx.strokeStyle = "#58e08a";
    mmCtx.lineWidth = 1.5;
    mmCtx.beginPath(); mmCtx.arc(mx, my, 6, 0, Math.PI * 2); mmCtx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Apply a snapshot to the interpolated entity pools.
// ---------------------------------------------------------------------------
function syncEntities(state) {
  // --- Cells ---
  const seenCells = new Set();
  for (const c of state.cells) {
    seenCells.add(c.i);
    let mesh = cellMeshes.get(c.i);
    const r = massToRadius(c.m);
    const mine = c.o === myId;
    if (!mesh) {
      mesh = makeCellMesh(c.c);
      mesh.position.set(c.x, r, c.y);
      mesh.scale.setScalar(r);
      mesh.userData = { ownerId: c.o };
      cellMeshes.set(c.i, mesh);
    }
    mesh.userData.tx = c.x;
    mesh.userData.ty = c.y;
    mesh.userData.tr = r;
    mesh.userData.ownerId = c.o;
    mesh.userData.mass = c.m;
    mesh.userData.mine = mine;
    if (mine) {
      let p = myPred.get(c.i);
      if (!p) { p = { x: c.x, y: c.y, vx: 0, vy: 0, sx: c.x, sy: c.y, mass: c.m }; myPred.set(c.i, p); }
      p.sx = c.x; p.sy = c.y; p.mass = c.m;
    }
  }
  for (const [id, mesh] of cellMeshes) {
    if (!seenCells.has(id)) { disposeMesh(mesh); cellMeshes.delete(id); myPred.delete(id); }
  }

  // --- Viruses ---
  const seenV = new Set();
  for (const v of state.viruses) {
    seenV.add(v.i);
    let mesh = virusMeshes.get(v.i);
    if (!mesh) {
      mesh = makeVirusMesh();
      mesh.position.set(v.x, v.r, v.y);
      mesh.scale.setScalar(v.r);
      virusMeshes.set(v.i, mesh);
    }
    mesh.userData.tx = v.x; mesh.userData.ty = v.y; mesh.userData.tr = v.r;
  }
  for (const [id, mesh] of virusMeshes) {
    if (!seenV.has(id)) { disposeMesh(mesh); virusMeshes.delete(id); }
  }

  // --- Ejected ---
  const seenE = new Set();
  const er = massToRadius(14);
  for (const e of state.ejected) {
    seenE.add(e.i);
    let mesh = ejectMeshes.get(e.i);
    if (!mesh) {
      mesh = makeEjectMesh(e.c);
      mesh.position.set(e.x, er, e.y);
      mesh.scale.setScalar(er);
      ejectMeshes.set(e.i, mesh);
    }
    mesh.userData.tx = e.x; mesh.userData.ty = e.y;
  }
  for (const [id, mesh] of ejectMeshes) {
    if (!seenE.has(id)) { disposeMesh(mesh); ejectMeshes.delete(id); }
  }

  // --- Food (instanced, no interpolation needed) ---
  const n = Math.min(state.food.length, MAX_FOOD);
  for (let i = 0; i < n; i++) {
    const f = state.food[i];
    _m.makeScale(10, 10, 10);
    _m.setPosition(f.x, 10, f.y);
    foodMesh.setMatrixAt(i, _m);
    _c.setHex(f.c);
    foodMesh.setColorAt(i, _c);
  }
  foodMesh.count = n;
  foodMesh.instanceMatrix.needsUpdate = true;
  if (foodMesh.instanceColor) foodMesh.instanceColor.needsUpdate = true;
}

// Smoothly move meshes toward their server targets each frame.
function interpolate(dt) {
  const t = 1 - Math.exp(-LERP_RATE * dt);
  for (const mesh of cellMeshes.values()) {
    const u = mesh.userData;
    if (u.tx === undefined || u.mine) continue; // own cells are predicted, not lerped
    const r = lerp(mesh.scale.x, u.tr, t);
    mesh.scale.setScalar(r);
    mesh.position.x = lerp(mesh.position.x, u.tx, t);
    mesh.position.z = lerp(mesh.position.z, u.ty, t);
    mesh.position.y = r;
  }
  for (const mesh of virusMeshes.values()) {
    const u = mesh.userData;
    mesh.position.x = lerp(mesh.position.x, u.tx, t);
    mesh.position.z = lerp(mesh.position.z, u.ty, t);
    mesh.position.y = u.tr;
    mesh.rotation.y += dt * 0.6;
  }
  for (const mesh of ejectMeshes.values()) {
    const u = mesh.userData;
    mesh.position.x = lerp(mesh.position.x, u.tx, t);
    mesh.position.z = lerp(mesh.position.z, u.ty, t);
  }
}

// Predict our own cells locally so movement responds instantly to input,
// then gently reconcile toward the authoritative server position. Uses the
// same movement model as the server (see server/game.js moveCells).
const RECONCILE_RATE = 4;
function stepMyCells(dt) {
  const rc = 1 - Math.exp(-RECONCILE_RATE * dt);
  for (const [id, p] of myPred) {
    const dx = worldTarget.x - p.x, dy = worldTarget.y - p.y;
    const dist = Math.hypot(dx, dy);
    const speed = 320 * Math.pow(20 / Math.max(p.mass, 20), 0.32);
    if (running && dist > 1) {
      const nx = dx / dist, ny = dy / dist;
      const approach = Math.min(speed, dist * 6);
      p.vx += nx * approach * dt * 8;
      p.vy += ny * approach * dt * 8;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const damp = Math.pow(0.0015, dt);
    p.vx *= damp; p.vy *= damp;
    const vlen = Math.hypot(p.vx, p.vy);
    if (vlen > speed && vlen > 0) {
      const k = Math.max(0.85, Math.min(1, speed / vlen));
      p.vx *= k; p.vy *= k;
    }
    // Reconcile toward server truth.
    p.x += (p.sx - p.x) * rc;
    p.y += (p.sy - p.y) * rc;
    p.x = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, p.x));
    p.y = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, p.y));

    const mesh = cellMeshes.get(id);
    if (mesh) {
      const r = massToRadius(p.mass);
      mesh.scale.setScalar(r);
      mesh.position.set(p.x, r, p.y);
    }
  }
}

// Mass-weighted centroid of our predicted cells (for the camera).
function myCentroid() {
  let x = 0, y = 0, t = 0;
  for (const p of myPred.values()) { x += p.x * p.mass; y += p.y * p.mass; t += p.mass; }
  if (t > 0) return { x: x / t, y: y / t, m: t };
  return null;
}

// Project visible cells to screen-space name/mass labels.
function updateLabels(state) {
  let n = 0;
  const names = state.names || {};
  for (const c of state.cells) {
    const mesh = cellMeshes.get(c.i);
    if (!mesh) continue;
    if (c.m < 24) continue; // skip labelling tiny fragments
    _proj.set(mesh.position.x, mesh.position.y + mesh.scale.x, mesh.position.z);
    _proj.project(camera);
    if (_proj.z > 1) continue; // behind camera
    const sx = (_proj.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-_proj.y * 0.5 + 0.5) * window.innerHeight;

    const lbl = getLabel(n++);
    const fontPx = THREE.MathUtils.clamp(massToRadius(c.m) * 0.16, 11, 46);
    lbl.el.style.display = "block";
    lbl.el.style.left = `${sx}px`;
    lbl.el.style.top = `${sy}px`;
    lbl.el.style.fontSize = `${fontPx}px`;
    const nm = names[c.o] || "";
    if (lbl.name.textContent !== nm) lbl.name.textContent = nm;
    lbl.mass.textContent = c.m;
  }
  for (let i = n; i < labelPool.length; i++) labelPool[i].el.style.display = "none";
}

// ---------------------------------------------------------------------------
// Camera + HUD
// ---------------------------------------------------------------------------
const scoreEl = document.getElementById("score");
const leaderboardList = document.getElementById("leaderboard-list");

function updateCamera(center, dt) {
  if (!center) return;
  const targetHeight = 700 + Math.pow(Math.max(center.m, 1), 0.55) * 70;
  const k = Math.min(1, dt * 6);
  camera.position.x = lerp(camera.position.x, center.x, k);
  camera.position.z = lerp(camera.position.z, center.y, k);
  camera.position.y = lerp(camera.position.y, targetHeight, Math.min(1, dt * 3));
  camera.lookAt(center.x, 0, center.y);
}

function updateHUD(state) {
  scoreEl.textContent = `Mass: ${state.me ? state.me.m : 0}`;
  leaderboardList.innerHTML = "";
  for (const e of state.leaderboard || []) {
    const li = document.createElement("li");
    if (e.me) li.classList.add("me");
    li.innerHTML = `<span class="name">${escapeHtml(e.n)}</span><span class="mass">${e.m}</span>`;
    leaderboardList.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------------
// Start / death flow
// ---------------------------------------------------------------------------
const startScreen = document.getElementById("start-screen");
const deathScreen = document.getElementById("death-screen");
const deathStats = document.getElementById("death-stats");
const nameInput = document.getElementById("name-input");

function beginGame() {
  Sound.init();
  if (Sound.ctx && Sound.ctx.state === "suspended") Sound.ctx.resume();
  myName = nameInput.value.trim();
  connect(() => {
    send({ t: "join", name: myName });
    lastMyMass = 0;
    running = true;
  });
}

function onDeath(mass) {
  running = false;
  Sound.death();
  deathStats.textContent = `Final mass: ${mass}`;
  deathScreen.classList.remove("hidden");
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
let inputAccum = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // Refresh the cursor world target every frame so prediction stays responsive.
  updateWorldTarget();

  if (latest) {
    syncEntities(latest);
    stepMyCells(dt);
    interpolate(dt);
    updateCamera(myCentroid() || latest.me, dt);
    updateLabels(latest);
    updateHUD(latest);
    drawMinimap(latest);
  }

  // Send movement input at a fixed rate.
  if (running) {
    inputAccum += dt;
    if (inputAccum >= 1 / INPUT_HZ) {
      inputAccum = 0;
      send({ t: "input", x: Math.round(worldTarget.x), y: Math.round(worldTarget.y) });
    }
  }

  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
