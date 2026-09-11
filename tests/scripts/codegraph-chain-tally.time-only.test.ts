import { describe, expect, it } from "vitest";

import {
  formatTimingBlock,
  parseArgs,
  scoredExtensionsFor,
  type ChainTallyTiming,
} from "../../scripts/codegraph-chain-tally.js";

/**
 * The scored set is inverted out of the engine's own extension→language map
 * rather than hand-listed per leg. `.tsx` is the reason: a hand-list that
 * forgets it scores half a TypeScript corpus and still reports a wall as if it
 * had walked all of it (bd E6.0a).
 */
describe("scoredExtensionsFor", () => {
  it("gives TypeScript both grammars", () => {
    expect([...scoredExtensionsFor("typescript")].sort()).toEqual([".ts", ".tsx"]);
  });

  it("gives Ruby and Python their single extension", () => {
    expect(scoredExtensionsFor("ruby")).toEqual([".rb"]);
    expect(scoredExtensionsFor("python")).toEqual([".py"]);
  });

  it("agrees with the hand-written CHAINS entries it replaces", () => {
    expect(scoredExtensionsFor("python")).toEqual([".py"]);
    expect(scoredExtensionsFor("java")).toEqual([".java"]);
  });

  it("keeps the JavaScript grammars out of the TypeScript leg, as the registry does", () => {
    expect([...scoredExtensionsFor("javascript")].sort()).toContain(".jsx");
    expect(scoredExtensionsFor("typescript")).not.toContain(".js");
  });

  it("throws rather than scoring nothing for an unwalked language", () => {
    expect(() => scoredExtensionsFor("cobol")).toThrow(/cobol/);
  });
});

describe("parseArgs timing flags", () => {
  it("makes --time-only imply --timing, since the numbers are its whole point", () => {
    const opts = parseArgs(["--time-only"]);
    expect(opts.timeOnly).toBe(true);
    expect(opts.timing).toBe(true);
  });

  it("keeps --timing usable on its own, so a --defer run can also be timed", () => {
    const opts = parseArgs(["--defer", "globalShortName", "--timing"]);
    expect(opts.timeOnly).toBe(false);
    expect(opts.timing).toBe(true);
  });

  it("leaves both off by default, so the existing python/java runs are unchanged", () => {
    const opts = parseArgs(["--lang", "python"]);
    expect(opts.timeOnly).toBe(false);
    expect(opts.timing).toBe(false);
  });

  it("reads --ts-checker=off as the kill switch and defaults it on", () => {
    expect(parseArgs(["--ts-checker=off"]).tsChecker).toBe(false);
    expect(parseArgs([]).tsChecker).toBe(true);
  });
});

/**
 * The normalized columns are the verdict E6.0b takes, so their arithmetic is
 * gated here rather than eyeballed off a run: a per-1k divisor applied to the
 * wrong unit turns a 2× regression into a pass.
 */
describe("formatTimingBlock", () => {
  const timing: ChainTallyTiming = {
    pass1Ms: 4_000,
    pass2Ms: 6_000,
    totalMs: 10_000,
    peakRssMb: 800,
    loc: 200_000,
  };

  it("normalizes per 1k sites, per 10k LOC and per 1k files off one 10 s run", () => {
    const lines = formatTimingBlock(timing, { files: 2_000, sites: 20_000, timeOnly: false }).join("\n");
    // 10 s / 20k sites = 0.500 s per 1k sites, and its inverse, 2000 sites/s.
    expect(lines).toContain("0.500 s/1k sites");
    expect(lines).toContain("2000 sites/s");
    // 10 s / 200k LOC = 0.500 s per 10k LOC; 800 MB / 2k files = 400 MB per 1k.
    expect(lines).toContain("0.500 s/10k LOC");
    expect(lines).toContain("400 MB/1k files");
  });

  it("reports seconds and MB, not the ms and bytes it is fed", () => {
    const lines = formatTimingBlock(timing, { files: 2_000, sites: 20_000, timeOnly: false }).join("\n");
    expect(lines).toContain("pass1 4.00s · pass2 6.00s · total 10.00s · peak RSS 800 MB");
    expect(lines).toContain("2000 scored files · 20000 sites · 200000 LOC");
  });

  it("says the drift check did not run, so a --time-only block never reads as verified", () => {
    const quiet = formatTimingBlock(timing, { files: 2_000, sites: 20_000, timeOnly: false }).join("\n");
    expect(quiet).not.toContain("--time-only");
    const timed = formatTimingBlock(timing, { files: 2_000, sites: 20_000, timeOnly: true }).join("\n");
    expect(timed).toContain("chain-drift check NOT run");
  });

  it("prints no division by zero for a corpus with no scored file", () => {
    const empty: ChainTallyTiming = { pass1Ms: 12, pass2Ms: 0, totalMs: 12, peakRssMb: 90, loc: 0 };
    const lines = formatTimingBlock(empty, { files: 0, sites: 0, timeOnly: true }).join("\n");
    expect(lines).not.toMatch(/NaN|Infinity/);
  });
});
