/**
 * Layer A — every walker extracts the same thing from both trees.
 *
 * The pipeline walks ONLY materialized trees; walker specs parse NATIVELY. So a
 * walker that reads a field materialization drops (see the probe helper's
 * header, and `src/core/domains/language/CLAUDE.md`) keeps returning values in
 * its own spec file while extracting nothing on a real index — no error, no red
 * test, just a language that "resolves poorly". This is the behavioural
 * invariant that closes that gap: run the PRODUCTION extraction path twice over
 * one parse, once per tree, and require the two results to be identical.
 *
 * Both halves of the production path run, because both read fields and they
 * fail differently: a loss inside `nameOf` moves symbol ids (`collectSymbols`),
 * a loss inside the walk empties a channel (imports, calls, localBindings,
 * classFieldTypes). `CodegraphFileExtractor#extractOneFile` is the shape being
 * mirrored.
 *
 * Layer B (`field-loss-inventory.test.ts`) is the earlier tripwire: it pins the
 * collisions themselves, including the ones no walker reads yet.
 */

import { describe, expect, it } from "vitest";

import {
  bothTreesOf,
  MATERIALIZATION_PARITY_CORPUS,
  runFixtureExtraction,
} from "./__helpers__/materialization-parity-probe.js";

describe("walker extraction parity — native tree vs materialized tree", () => {
  it.each(MATERIALIZATION_PARITY_CORPUS)("$grammarKey extracts identically from both trees", (fixture) => {
    const { native, materialized } = bothTreesOf(fixture);

    const fromNative = runFixtureExtraction(fixture, native);
    const fromMaterialized = runFixtureExtraction(fixture, materialized);

    expect(fromMaterialized.symbols).toEqual(fromNative.symbols);
    expect(fromMaterialized.extraction).toEqual(fromNative.extraction);
  });

  it.each(MATERIALIZATION_PARITY_CORPUS)("$grammarKey fixture extracts enough to compare", (fixture) => {
    // Two empty extractions are trivially equal, so the parity case above is
    // only worth anything while the fixture actually produces symbols and edges.
    const { native } = bothTreesOf(fixture);
    const { symbols, extraction } = runFixtureExtraction(fixture, native);

    expect(symbols.length).toBeGreaterThan(0);
    const calls = extraction.chunks.reduce((total, chunk) => total + chunk.calls.length, 0);
    expect(calls + extraction.imports.length).toBeGreaterThan(0);
  });
});
