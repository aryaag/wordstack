import { describe, expect, it } from "vitest";
import { avatarLabel } from "./lib";

describe("avatarLabel", () => {
  it("uses a single letter when first letters don't collide", () => {
    const roster = ["Alice", "Bob"];
    expect(avatarLabel("Alice", roster)).toBe("A");
    expect(avatarLabel("Bob", roster)).toBe("B");
  });

  it("disambiguates a shared first letter at the first differing char (Gary/George → GA/GE)", () => {
    const roster = ["Gary", "George"];
    expect(avatarLabel("Gary", roster)).toBe("GA");
    expect(avatarLabel("George", roster)).toBe("GE");
  });

  it("skips common leading chars (Hank/Hal → HN/HL)", () => {
    const roster = ["Hank", "Hal"];
    expect(avatarLabel("Hank", roster)).toBe("HN");
    expect(avatarLabel("Hal", roster)).toBe("HL");
  });

  it("keeps non-colliding names at one letter even when others collide", () => {
    const roster = ["Gary", "George", "Bob"];
    expect(avatarLabel("Bob", roster)).toBe("B");
    expect(avatarLabel("Gary", roster)).toBe("GA");
  });

  it("uses first letters of the first two words for multi-word names", () => {
    expect(avatarLabel("Red Two", ["Red Two", "Blue One"])).toBe("RT");
  });

  it("falls back gracefully for empty names and prefixes", () => {
    expect(avatarLabel("", ["", "Bob"])).toBe("?");
    // "Al" is a prefix of "Alex": no differing char within Al's length → first letter.
    expect(avatarLabel("Al", ["Al", "Alex"])).toBe("A");
    expect(avatarLabel("Alex", ["Al", "Alex"])).toBe("AE");
  });
});
