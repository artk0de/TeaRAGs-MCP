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

  it("keeps ugnest's interpreter inside its own checkout", () => {
    const ugnest = loadCodegraphCorpus("ugnest");
    expect(ugnest.venvPython.startsWith(`${ugnest.path}/`)).toBe(true);
  });
});
