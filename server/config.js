// Authoritative game configuration (server-side source of truth).
// A subset of these values is sent to clients in the "welcome" message.
export const CONFIG = {
  // World
  worldSize: 4000,          // half-extent of the square play area (-W..W)
  tickRate: 25,             // simulation + broadcast frequency (Hz)

  // Food
  foodCount: 800,
  foodMass: 1,

  // Players / cells
  startMass: 20,
  eatRatio: 1.15,           // how much bigger to eat another cell
  baseSpeed: 320,           // world units / second at small size
  splitImpulse: 1400,
  splitMinMass: 36,
  maxCells: 16,
  mergeCooldown: 12,        // seconds before split cells may re-merge
  ejectMass: 14,
  ejectCost: 18,
  ejectSpeed: 1600,
  decayRate: 0.002,         // passive mass decay per second per mass unit

  // Viruses
  virusCount: 16,
  virusMass: 130,
  virusEatRatio: 1.15,
  virusPopPieces: 8,
  virusRespawnDelay: 8,

  // Bots — fill empty servers, back off as humans join.
  targetPopulation: 16,     // desired total of (humans + bots)
  minBots: 3,
  maxBots: 16,
  botRespawnDelay: 3,

  // Networking
  viewBase: 1200,           // base half-width of a client's visible area
  viewMassScale: 70,        // how much the view grows with sqrt(mass)
};

export const COLORS = [
  0x58e08a, 0x4f9dff, 0xff6b6b, 0xffd93d, 0xb16cff,
  0xff9f43, 0x2ee6d6, 0xff6bcb, 0x9be564, 0xff8c69,
];

export const VIRUS_COLOR = 0x33d17a;

export const BOT_NAMES = [
  "Blobby", "Nibbles", "Mr. Big", "Voracious", "Tiny", "Gulp",
  "Sir Eats", "Pac", "Munch", "Chonk", "Zippy", "Goo", "Splat",
  "Bubbles", "Crumb", "Vortex", "Pixel", "Nom", "Hungry", "Orbit",
];
