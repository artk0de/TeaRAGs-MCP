import { describe, expect, it } from "vitest";

import { matchesProviderSelector, selectProviderKeys } from "../../../src/core/contracts/provider-selector.js";

const AVAILABLE = ["git", "codegraph.symbols", "codegraph.complexity"];

describe("matchesProviderSelector", () => {
  it("matches a provider key exactly", () => {
    expect(matchesProviderSelector("git", "git")).toBe(true);
  });

  it("matches every provider under a dotted namespace", () => {
    expect(matchesProviderSelector("codegraph.symbols", "codegraph")).toBe(true);
    expect(matchesProviderSelector("codegraph.complexity", "codegraph")).toBe(true);
  });

  it("does not match a different provider", () => {
    expect(matchesProviderSelector("git", "codegraph")).toBe(false);
  });

  it("does not treat a shared string prefix as a namespace", () => {
    // "codegraph" must not swallow "codegraphx" — the separator is load-bearing.
    expect(matchesProviderSelector("codegraphx", "codegraph")).toBe(false);
  });

  it("does not match a namespace against a more specific selector", () => {
    expect(matchesProviderSelector("codegraph", "codegraph.symbols")).toBe(false);
  });
});

describe("selectProviderKeys", () => {
  it("expands a namespace selector to every provider under it", () => {
    const result = selectProviderKeys(AVAILABLE, ["codegraph"]);

    expect(result.matched).toEqual(["codegraph.symbols", "codegraph.complexity"]);
    expect(result.unknown).toEqual([]);
  });

  it("selects a single provider by exact key", () => {
    const result = selectProviderKeys(AVAILABLE, ["git"]);

    expect(result.matched).toEqual(["git"]);
  });

  it("unions several selectors without duplicating a provider", () => {
    const result = selectProviderKeys(AVAILABLE, ["codegraph", "codegraph.symbols"]);

    expect(result.matched).toEqual(["codegraph.symbols", "codegraph.complexity"]);
  });

  it("selects everything for the `all` selector", () => {
    const result = selectProviderKeys(AVAILABLE, ["all"]);

    expect(result.matched).toEqual(AVAILABLE);
    expect(result.unknown).toEqual([]);
  });

  it("reports selectors that match no registered provider", () => {
    const result = selectProviderKeys(AVAILABLE, ["git", "nonsense"]);

    expect(result.matched).toEqual(["git"]);
    expect(result.unknown).toEqual(["nonsense"]);
  });

  it("reports an unknown selector even when others matched", () => {
    // Partial success must not silently drop the typo — recomputing the wrong
    // subset looks identical to recomputing the right one from the outside.
    const result = selectProviderKeys(AVAILABLE, ["codegrap"]);

    expect(result.matched).toEqual([]);
    expect(result.unknown).toEqual(["codegrap"]);
  });
});
