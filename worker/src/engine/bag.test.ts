import { describe, expect, it } from "vitest";
import { createBag, draw, newShuffledBag, refill, TILE_DISTRIBUTION } from "./bag";

const sortedCounts = (tiles: string[]) => {
  const m: Record<string, number> = {};
  for (const t of tiles) m[t] = (m[t] ?? 0) + 1;
  return m;
};

describe("tile bag", () => {
  it("has exactly 100 tiles in the documented distribution", () => {
    const bag = createBag();
    expect(bag).toHaveLength(100);
    expect(sortedCounts(bag)).toEqual(TILE_DISTRIBUTION);
    expect(Object.values(TILE_DISTRIBUTION).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("includes the combined qu tile and no bare q", () => {
    expect(TILE_DISTRIBUTION.qu).toBe(1);
    expect(createBag()).toContain("qu");
    expect(createBag()).not.toContain("q");
  });

  it("shuffles deterministically by seed and preserves the multiset", () => {
    const a = newShuffledBag(12345);
    const b = newShuffledBag(12345);
    const c = newShuffledBag(99999);
    expect(a).toEqual(b); // same seed → identical order
    expect(a).not.toEqual(c); // different seed → different order
    expect(sortedCounts(a)).toEqual(TILE_DISTRIBUTION); // still a valid bag
  });

  it("draws from the end and shrinks the bag", () => {
    const bag = createBag();
    const { drawn, bag: rest } = draw(bag, 7);
    expect(drawn).toHaveLength(7);
    expect(rest).toHaveLength(93);
    expect(drawn).toEqual(bag.slice(93));
  });

  it("draws only what remains when the bag is short", () => {
    const { drawn, bag } = draw(["a", "b"], 5);
    expect(drawn).toEqual(["a", "b"]);
    expect(bag).toEqual([]);
  });

  it("refills a rack to rackSize, or partially when the bag runs out", () => {
    const full = refill(["a", "b"], createBag(), 7);
    expect(full.rack).toHaveLength(7);
    expect(full.bag).toHaveLength(95);

    const partial = refill(["a", "b"], ["x"], 7);
    expect(partial.rack).toEqual(["a", "b", "x"]);
    expect(partial.bag).toEqual([]);
  });
});
