import { describe, expect, it } from "vitest";
import { parseMW } from "./define";

describe("parseMW", () => {
  it("treats a string array as not-found suggestions", () => {
    const res = parseMW(["broo", "brio", "bro"], "broa");
    expect(res).toEqual({ word: "broa", found: false, suggestions: ["broo", "brio", "bro"] });
  });

  it("returns not-found for empty / non-array payloads", () => {
    expect(parseMW([], "x")).toEqual({ word: "x", found: false });
    expect(parseMW(null, "x")).toEqual({ word: "x", found: false });
  });

  it("extracts fl + shortdef and gathers sense-level status labels (sls)", () => {
    // Shape mirrors MW Collegiate JSON: status labels live in def → sseq → sense,
    // never in shortdef.
    const mw = [
      {
        fl: "noun",
        def: [
          {
            sseq: [
              [["sense", { sn: "1", sls: ["informal"], dt: [["text", "{bc}{sx|brother||}"]] }]],
              [["sense", { sn: "2 a", sls: ["US slang"], dt: [["text", "{bc}a male friend"]] }]],
            ],
          },
        ],
        shortdef: ["brother", "a male friend"],
      },
    ];
    const res = parseMW(mw, "bro");
    expect(res).toEqual({
      word: "bro",
      found: true,
      entries: [{ fl: "noun", labels: ["informal", "US slang"], defs: ["brother", "a male friend"] }],
    });
  });

  it("gathers entry-level lbs and dedupes labels", () => {
    const mw = [
      {
        fl: "abbreviation",
        lbs: ["informal"],
        def: [{ sseq: [[["sense", { sls: ["informal"], dt: [["text", "{bc}what the ..."]] }]]] }],
        shortdef: ["what the ..."],
      },
    ];
    const res = parseMW(mw, "wtf");
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.entries[0].fl).toBe("abbreviation");
      expect(res.entries[0].labels).toEqual(["informal"]); // deduped across lbs + sls
    }
  });

  it("yields an empty label list when there are no labels", () => {
    const mw = [{ fl: "noun", def: [{ sseq: [[["sense", { dt: [["text", "{bc}a thing"]] }]]] }], shortdef: ["a thing"] }];
    const res = parseMW(mw, "thing");
    expect(res.found && res.entries[0].labels).toEqual([]);
  });
});
