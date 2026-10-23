import { describe, expect, it } from "vitest";

import { aggregateIngestIgnoreContributions } from "../../../../../src/core/domains/language/capability/ingest-ignore.js";
import {
  languageIngestIgnoreContribution,
  nativeLanguageCapabilities,
} from "../../../../../src/core/domains/language/capability/native.js";

/**
 * A language declares what of its own build and vendoring output stays out of
 * the index; ingest receives the aggregate by injection and owns no language.
 */
describe("language ingest ignore contributions", () => {
  it("Rust declares Cargo's target directory itself", () => {
    expect(nativeLanguageCapabilities().get("rust")?.ingestIgnore?.patterns).toContain("target/");
  });

  it("Rust declares cargo-vendored crates by their checksum marker, never by a bare vendor/ name", () => {
    const rust = nativeLanguageCapabilities().get("rust")?.ingestIgnore;
    expect(rust?.markedDirectories?.map((marker) => marker.entries)).toContainEqual([".cargo-checksum.json"]);
    expect(rust?.patterns ?? []).not.toContain("vendor/");
  });

  it("aggregates every language's patterns and markers, deduped, into one contribution", () => {
    const aggregate = aggregateIngestIgnoreContributions(
      new Map([
        ["a", { ingestIgnore: { patterns: ["out/", "gen/"], markedDirectories: [{ reason: "x", entries: ["X"] }] } }],
        ["b", { ingestIgnore: { patterns: ["gen/"] } }],
        ["c", {}],
      ]),
    );
    expect(aggregate.patterns).toEqual(["out/", "gen/"]);
    expect(aggregate.markedDirectories).toEqual([{ reason: "x", entries: ["X"] }]);
  });

  it("returns the same aggregate object on every call", () => {
    expect(languageIngestIgnoreContribution()).toBe(languageIngestIgnoreContribution());
  });
});
