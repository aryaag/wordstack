import type { Tile } from "./types";

/** Tile bag from the physical edition (CLAUDE.md). "qu" is a single combined tile. Sums to 100. */
export const TILE_DISTRIBUTION: Record<Tile, number> = {
  e: 8,
  a: 7,
  i: 7,
  o: 7,
  s: 6,
  d: 5,
  l: 5,
  m: 5,
  n: 5,
  r: 5,
  t: 5,
  u: 5,
  c: 4,
  b: 3,
  f: 3,
  g: 3,
  h: 3,
  p: 3,
  k: 2,
  w: 2,
  y: 2,
  j: 1,
  qu: 1,
  v: 1,
  x: 1,
  z: 1,
};

/** A fresh, ordered 100-tile bag (before shuffling). */
export function createBag(): Tile[] {
  const bag: Tile[] = [];
  for (const [tile, count] of Object.entries(TILE_DISTRIBUTION)) {
    for (let i = 0; i < count; i++) bag.push(tile);
  }
  return bag;
}

/** Deterministic PRNG (mulberry32) — same seed → same sequence (for reproducible games/tests). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle into a new array using the given RNG. */
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function newShuffledBag(seed: number): Tile[] {
  return shuffle(createBag(), mulberry32(seed));
}

/** Draw `n` tiles from the END of the bag. Returns the drawn tiles + the remaining bag. */
export function draw(bag: Tile[], n: number): { drawn: Tile[]; bag: Tile[] } {
  const take = Math.max(0, Math.min(n, bag.length));
  return { drawn: bag.slice(bag.length - take), bag: bag.slice(0, bag.length - take) };
}

/** Refill a rack up to `rackSize` (draws fewer if the bag runs short). */
export function refill(
  rack: Tile[],
  bag: Tile[],
  rackSize: number,
): { rack: Tile[]; bag: Tile[] } {
  const { drawn, bag: rest } = draw(bag, rackSize - rack.length);
  return { rack: [...rack, ...drawn], bag: rest };
}
