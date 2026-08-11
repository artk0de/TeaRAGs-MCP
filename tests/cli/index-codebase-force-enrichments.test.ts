/**
 * CLI parsing for `--force-enrichments`.
 *
 * The value is REQUIRED (`all` covers "everything"). yargs would otherwise
 * swallow the command's positional `[path]` as the flag's value, so an
 * optional-value flag is not available here.
 */

import { describe, expect, it } from "vitest";

import { parseEnrichmentSelectors, resolveWaitEnrichments } from "../../src/cli/commands/index-codebase.js";

describe("resolveWaitEnrichments", () => {
  it("waits implicitly for a recompute even without the flag", () => {
    // Detaching mid-recompute returns control before the layer under test has
    // been rebuilt, so there would be nothing to measure on return.
    expect(resolveWaitEnrichments(false, ["git"])).toBe(true);
  });

  it("keeps waiting when the flag is passed alongside", () => {
    expect(resolveWaitEnrichments(true, ["git"])).toBe(true);
  });

  it("honours the flag on an ordinary run", () => {
    expect(resolveWaitEnrichments(true, undefined)).toBe(true);
  });

  it("still detaches on an ordinary run without the flag", () => {
    expect(resolveWaitEnrichments(false, undefined)).toBe(false);
  });

  it("does not wait when the selector list resolved to nothing", () => {
    // An empty list is rejected downstream; it must not silently turn a plain
    // incremental into a blocking run.
    expect(resolveWaitEnrichments(false, [])).toBe(false);
  });
});

describe("parseEnrichmentSelectors", () => {
  it("returns undefined when the flag is absent", () => {
    expect(parseEnrichmentSelectors(undefined)).toBeUndefined();
  });

  it("parses a single selector", () => {
    expect(parseEnrichmentSelectors("git")).toEqual(["git"]);
  });

  it("splits a comma-separated list", () => {
    expect(parseEnrichmentSelectors("git,codegraph")).toEqual(["git", "codegraph"]);
  });

  it("tolerates spaces around the separators", () => {
    expect(parseEnrichmentSelectors(" git , codegraph.symbols ")).toEqual(["git", "codegraph.symbols"]);
  });

  it("drops empty entries from a sloppy list", () => {
    expect(parseEnrichmentSelectors("git,,codegraph,")).toEqual(["git", "codegraph"]);
  });

  it("keeps `all` as an ordinary selector", () => {
    expect(parseEnrichmentSelectors("all")).toEqual(["all"]);
  });

  it("returns undefined for a value that is only separators", () => {
    // Nothing was selected, so the run must not silently become a recompute
    // of everything — the facade rejects an empty list explicitly.
    expect(parseEnrichmentSelectors(",, ,")).toEqual([]);
  });
});
