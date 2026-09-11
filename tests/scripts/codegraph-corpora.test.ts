/**
 * The corpora manifest is the E0 harness's single source of truth for WHERE a
 * corpus lives, WHICH interpreter jedi resolves against, and WHAT the chain
 * emitted before any of this landed. It is versioned in this repo and not in
 * `~/Dev/Tools/tea-rags-bench` because that directory is not a git repository:
 * a baseline recorded there has no history and no diff, and the whole point of
 * these numbers is that a later run can be compared against them.
 */
import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import { expandHome, loadCodegraphCorpora, loadCodegraphCorpus } from "../../scripts/lib/codegraph-corpora.js";

const EXPECTED_NAMES = ["flask", "httpx", "netbox", "polar", "ugnest"];

describe("expandHome", () => {
  it("expands a leading ~/ to the home directory", () => {
    expect(isAbsolute(expandHome("~/Dev/x"))).toBe(true);
    expect(expandHome("~/Dev/x").endsWith("/Dev/x")).toBe(true);
  });

  it("leaves an already-absolute path untouched", () => {
    expect(expandHome("/tmp/corpus")).toBe("/tmp/corpus");
  });

  it("does not expand a ~ that is not the leading segment", () => {
    expect(expandHome("/tmp/~notahome")).toBe("/tmp/~notahome");
  });
});

describe("loadCodegraphCorpora", () => {
  it("carries exactly the five E0 corpora", () => {
    expect(Object.keys(loadCodegraphCorpora()).sort()).toEqual(EXPECTED_NAMES);
  });

  it("expands every corpus path and venv interpreter to an absolute path", () => {
    for (const corpus of Object.values(loadCodegraphCorpora())) {
      expect(isAbsolute(corpus.path)).toBe(true);
      expect(isAbsolute(corpus.venvPython)).toBe(true);
      expect(corpus.venvPython.endsWith("/bin/python")).toBe(true);
    }
  });

  it("names each corpus with its own manifest key", () => {
    for (const [key, corpus] of Object.entries(loadCodegraphCorpora())) {
      expect(corpus.name).toBe(key);
    }
  });

  it("declares at least one relative import root per corpus", () => {
    for (const corpus of Object.values(loadCodegraphCorpora())) {
      expect(corpus.roots.length).toBeGreaterThan(0);
      for (const root of corpus.roots) expect(isAbsolute(root)).toBe(false);
    }
  });
});

describe("loadCodegraphCorpus — recorded chain-tally baseline (2026-09-02)", () => {
  it.each([
    ["ugnest", 1432, 315, 5899],
    ["flask", 770, 148, 1402],
    ["netbox", 21971, 8190, 38760],
    ["polar", 21336, 3976, 61218],
    ["httpx", 1011, 193, 1632],
  ])("%s emitted %i edges (%i file-only) and declined %i", (name, edges, fileOnly, unresolved) => {
    const { baseline } = loadCodegraphCorpus(String(name));
    expect(baseline.edges).toBe(edges);
    expect(baseline.fileOnly).toBe(fileOnly);
    expect(baseline.unresolved).toBe(unresolved);
  });

  it.each([
    ["httpx", 260, 1.7],
    ["flask", 275, 1.1],
    ["ugnest", 352, 2.4],
    ["polar", 959, 14.5],
    ["netbox", 1293, 16.2],
  ])("%s cost %i MB peak RSS and %f s wall", (name, peakRssMb, wallSeconds) => {
    const { baseline } = loadCodegraphCorpus(String(name));
    expect(baseline.peakRssMb).toBe(peakRssMb);
    expect(baseline.wallSeconds).toBe(wallSeconds);
  });

  it("throws naming the unknown corpus and the known set", () => {
    expect(() => loadCodegraphCorpus("django")).toThrow(/unknown corpus 'django'/);
  });
});

describe("loadCodegraphCorpus — provisioned interpreters", () => {
  it("runs polar on the 3.14 interpreter its PEP 758 files need", () => {
    const polar = loadCodegraphCorpus("polar");
    expect(polar.requiresPython).toBe(">=3.14");
    expect(polar.venvPythonVersion.startsWith("3.14")).toBe(true);
  });

  /**
   * `oraclePython` is the interpreter jedi runs ON; `requiresPython` is what the
   * corpus needs to run ITSELF. They are not the same number and httpx proves
   * it: `>=3.9` is below jedi 0.20.0's own floor of 3.10, and using it as the
   * launcher killed the host during the handshake (bd tea-rags-mcp-3yxmy).
   */
  it.each([
    ["ugnest", "3.13"],
    ["flask", "3.13"],
    ["netbox", "3.13"],
    ["polar", "3.14"],
    ["httpx", "3.13"],
  ])("launches the %s oracle on python %s", (name, oraclePython) => {
    expect(loadCodegraphCorpus(String(name)).oraclePython).toBe(oraclePython);
  });

  it("keeps every oracle interpreter at or above jedi 0.20.0's 3.10 floor", () => {
    for (const corpus of Object.values(loadCodegraphCorpora())) {
      const [major, minor] = corpus.oraclePython.split(".").map(Number);
      expect(major).toBe(3);
      expect(minor).toBeGreaterThanOrEqual(10);
    }
  });

  it("keeps ugnest's interpreter inside its own checkout", () => {
    const ugnest = loadCodegraphCorpus("ugnest");
    expect(ugnest.venvPython.startsWith(`${ugnest.path}/`)).toBe(true);
  });
});

/**
 * E6.0b's offline matrix, min of three timed runs after a discarded warm-up,
 * `codegraph-chain-tally.ts --time-only`. Recorded BESIDE `baseline` and never
 * over it: E0's figures are the 2026-09-02 anchor, and the RSS moved 959 ->
 * 2,247 MB on polar between the two, which is exactly the movement a second
 * block preserves and an overwrite erases.
 */
describe("loadCodegraphCorpus — recorded E6 offline matrix (2026-09-11)", () => {
  it.each([
    ["polar", 14.89, 2247, 56710, 306460, 1339],
    ["netbox", 10.93, 2208, 44126, 278182, 1038],
  ])("%s built in %f s at %i MB peak RSS over %i sites, %i LOC, %i files", (name, wall, rss, sites, loc, files) => {
    const { e6 } = loadCodegraphCorpus(String(name));
    expect(e6).toBeDefined();
    expect(e6?.wallSeconds).toBe(wall);
    expect(e6?.peakRssMb).toBe(rss);
    expect(e6?.sites).toBe(sites);
    expect(e6?.loc).toBe(loc);
    expect(e6?.files).toBe(files);
  });

  it("leaves the E0 baseline of both timed corpora untouched", () => {
    expect(loadCodegraphCorpus("polar").baseline.wallSeconds).toBe(14.5);
    expect(loadCodegraphCorpus("polar").baseline.peakRssMb).toBe(959);
    expect(loadCodegraphCorpus("netbox").baseline.wallSeconds).toBe(16.2);
    expect(loadCodegraphCorpus("netbox").baseline.peakRssMb).toBe(1293);
  });

  it("carries no e6 block for the corpora the matrix did not run", () => {
    for (const name of ["flask", "httpx", "ugnest"]) {
      expect(loadCodegraphCorpus(name).e6).toBeUndefined();
    }
  });
});
