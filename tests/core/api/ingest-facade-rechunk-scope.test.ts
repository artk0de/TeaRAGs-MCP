/**
 * Validation of the scoped-force file filters (bd tea-rags-mcp-j4oww):
 * `pathPattern`, `testFile`, `fileExtensions`, `files`. Each only means
 * something on a forced re-chunk, and a malformed one would select nothing —
 * which finishes cleanly and reads as success — so it is refused up front.
 */

import { describe, expect, it } from "vitest";

import { validateRechunkScope } from "../../../src/core/api/internal/facades/ingest-facade.js";
import type { IndexOptions } from "../../../src/core/api/public/dto/ingest.js";

function refusal(options: IndexOptions): string {
  try {
    validateRechunkScope(options);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

describe("validateRechunkScope", () => {
  it("accepts a run with no scope filters", () => {
    expect(refusal({})).toBe("");
    expect(refusal({ forceReindex: true })).toBe("");
  });

  it("accepts every filter alongside forceReindex", () => {
    expect(
      refusal({
        forceReindex: true,
        pathPattern: "spec/**",
        testFile: "only",
        fileExtensions: [".rb"],
        files: ["spec/a_spec.rb"],
      }),
    ).toBe("");
  });

  it("refuses a filter on a plain incremental run", () => {
    expect(refusal({ testFile: "only" })).toMatch(/testFile.*forceReindex/s);
    expect(refusal({ pathPattern: "spec/**" })).toMatch(/pathPattern/);
  });

  it("refuses a filter on an enrichment recompute, which never re-chunks", () => {
    expect(refusal({ forceEnrichments: ["codegraph"], pathPattern: "spec/**" })).toMatch(/forceEnrichments/);
  });

  it("refuses a testFile value that is not only or exclude", () => {
    expect(refusal({ forceReindex: true, testFile: "include" as never })).toMatch(/only.*exclude/);
  });

  it("refuses empty filters rather than reading them as the whole project", () => {
    expect(refusal({ forceReindex: true, pathPattern: "  " })).toMatch(/pathPattern/);
    expect(refusal({ forceReindex: true, fileExtensions: [] })).toMatch(/fileExtensions/);
    expect(refusal({ forceReindex: true, files: [] })).toMatch(/files/);
  });
});
