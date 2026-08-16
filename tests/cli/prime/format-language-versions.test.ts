/**
 * prime — the `## Language versions` section (bd tea-rags-mcp-frwka).
 *
 * Live per-index STATE belongs to prime (`.claude/rules/plugin-guidance-layers.md`),
 * and this is state SchemaDriftMonitor structurally cannot see: it compares
 * payload keys, which do not move when a grammar or a resolver does.
 */

import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { PrimeData } from "../../../src/cli/prime/types.js";

function primeData(overrides: Partial<PrimeData> = {}): PrimeData {
  return {
    path: "/repo",
    projectName: "demo",
    status: { isIndexed: true, status: "indexed", chunksCount: 10, lastUpdated: new Date() },
    metrics: null,
    drift: null,
    update: null,
    ...overrides,
  };
}

describe("formatPrime — language versions", () => {
  it("renders the hint under its own section when a language is behind the code", () => {
    const out = formatPrime(
      primeData({
        languageVersionDrift:
          "Language tooling moved since last indexing.\ntypescript: walker 1→2\n" +
          "Run: tea-rags index-codebase --force-enrichments codegraph --languages typescript",
      }),
    );

    expect(out).toContain("## Language versions");
    expect(out).toContain("typescript: walker 1→2");
    expect(out).toContain("Run: tea-rags index-codebase --force-enrichments codegraph --languages typescript");
  });

  it("omits the section entirely when nothing drifted", () => {
    expect(formatPrime(primeData({ languageVersionDrift: null }))).not.toContain("## Language versions");
  });

  it("omits the section when the caller never supplied the field", () => {
    expect(formatPrime(primeData())).not.toContain("## Language versions");
  });

  it("keeps it separate from the payload-key drift section", () => {
    const out = formatPrime(
      primeData({
        drift: "Payload schema changed since last indexing.",
        languageVersionDrift: "Language tooling moved since last indexing.\nruby: chunking 1→2",
      }),
    );

    expect(out).toContain("## Schema drift");
    expect(out).toContain("## Language versions");
    expect(out.indexOf("## Schema drift")).toBeLessThan(out.indexOf("## Language versions"));
  });
});
