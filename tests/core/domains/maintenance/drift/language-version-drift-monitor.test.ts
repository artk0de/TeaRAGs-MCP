/**
 * LanguageVersionDriftMonitor (bd tea-rags-mcp-frwka).
 *
 * Complements SchemaDriftMonitor: that one compares payload signal-descriptor
 * KEYS, so a grammar or resolver bump produces zero drift signal while every
 * chunk boundary and every edge for that language may have moved. This one
 * compares the per-language code versions stamped at index time against the
 * versions the current build declares, and routes the remedy by which axis
 * moved.
 */

import { describe, expect, it } from "vitest";

import type { LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
import { LanguageVersionDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/language-version-drift-monitor.js";

const current = new Map<string, LanguageCodeVersions>([
  ["typescript", { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 }],
  ["ruby", { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 }],
]);

const indexedAtCurrent = {
  typescript: { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 },
  ruby: { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 },
};

describe("LanguageVersionDriftMonitor.detectDrift — per-axis", () => {
  it("reports nothing when every stamped axis matches the current build", () => {
    expect(LanguageVersionDriftMonitor.detectDrift(indexedAtCurrent, current, ["typescript", "ruby"])).toEqual([]);
  });

  it("detects a walker bump on its own", () => {
    const indexed = { ...indexedAtCurrent, typescript: { ...indexedAtCurrent.typescript, walker: 1 } };

    expect(LanguageVersionDriftMonitor.detectDrift(indexed, current, ["typescript", "ruby"])).toEqual([
      { language: "typescript", axes: [{ axis: "walker", indexed: 1, current: 2 }] },
    ]);
  });

  it("detects a codegraph-schema bump on its own", () => {
    const indexed = { ...indexedAtCurrent, ruby: { ...indexedAtCurrent.ruby, codegraphSchema: 0 } };

    expect(LanguageVersionDriftMonitor.detectDrift(indexed, current, ["ruby"])).toEqual([
      { language: "ruby", axes: [{ axis: "codegraphSchema", indexed: 0, current: 1 }] },
    ]);
  });

  it("detects a grammar bump on its own", () => {
    const indexed = { ...indexedAtCurrent, ruby: { ...indexedAtCurrent.ruby, grammar: "0.22.0" } };

    expect(LanguageVersionDriftMonitor.detectDrift(indexed, current, ["ruby"])).toEqual([
      { language: "ruby", axes: [{ axis: "grammar", indexed: "0.22.0", current: "0.23.1" }] },
    ]);
  });

  it("detects a chunking bump on its own", () => {
    const indexed = { ...indexedAtCurrent, ruby: { ...indexedAtCurrent.ruby, chunking: 0 } };

    expect(LanguageVersionDriftMonitor.detectDrift(indexed, current, ["ruby"])).toEqual([
      { language: "ruby", axes: [{ axis: "chunking", indexed: 0, current: 1 }] },
    ]);
  });

  it("reports every moved axis of one language in declaration order", () => {
    const indexed = { ...indexedAtCurrent, ruby: { grammar: "0.22.0", chunking: 0, walker: 0, codegraphSchema: 0 } };

    expect(LanguageVersionDriftMonitor.detectDrift(indexed, current, ["ruby"])?.[0]?.axes.map((a) => a.axis)).toEqual([
      "grammar",
      "chunking",
      "walker",
      "codegraphSchema",
    ]);
  });
});

describe("LanguageVersionDriftMonitor.detectDrift — what it refuses to claim", () => {
  it("treats a missing stamp as the seeded version, so a bump fires on a pre-versioning index", () => {
    expect(LanguageVersionDriftMonitor.detectDrift(undefined, current, ["typescript"])).toEqual([
      { language: "typescript", axes: [{ axis: "walker", indexed: 1, current: 2 }] },
    ]);
  });

  it("never claims grammar drift it cannot prove — an unstamped grammar is unknown, not seeded", () => {
    const indexed = { ruby: { chunking: 1, walker: 1, codegraphSchema: 1 } };

    expect(LanguageVersionDriftMonitor.detectDrift(indexed, current, ["ruby"])).toEqual([]);
  });

  it("ignores languages the index does not contain", () => {
    const indexed = { ...indexedAtCurrent, ruby: { ...indexedAtCurrent.ruby, walker: 0 } };

    expect(LanguageVersionDriftMonitor.detectDrift(indexed, current, ["typescript"])).toEqual([]);
  });

  it("ignores a stamped language the current build no longer declares", () => {
    const indexed = { ...indexedAtCurrent, cobol: { chunking: 1, walker: 1, codegraphSchema: 1 } };

    expect(LanguageVersionDriftMonitor.detectDrift(indexed, current, ["cobol"])).toEqual([]);
  });
});

describe("LanguageVersionDriftMonitor.formatWarning — the routed command", () => {
  it("routes an edges-only bump to the narrowed enrichment recompute", () => {
    const warning = LanguageVersionDriftMonitor.formatWarning([
      { language: "typescript", axes: [{ axis: "walker", indexed: 1, current: 2 }] },
    ]);

    expect(warning).toContain("typescript: walker 1→2");
    expect(warning).toContain("Run: tea-rags index-codebase --force-enrichments codegraph --languages typescript");
  });

  it("routes a codegraph-schema bump the same way", () => {
    const warning = LanguageVersionDriftMonitor.formatWarning([
      { language: "ruby", axes: [{ axis: "codegraphSchema", indexed: 1, current: 2 }] },
    ]);

    expect(warning).toContain("Run: tea-rags index-codebase --force-enrichments codegraph --languages ruby");
  });

  it("comma-separates the languages of one recompute rather than emitting two commands", () => {
    const warning = LanguageVersionDriftMonitor.formatWarning([
      { language: "typescript", axes: [{ axis: "walker", indexed: 1, current: 2 }] },
      { language: "ruby", axes: [{ axis: "walker", indexed: 1, current: 2 }] },
    ]);

    expect(warning).toContain("--force-enrichments codegraph --languages typescript,ruby");
    expect(warning.match(/Run: /g)).toHaveLength(1);
  });

  it("routes a grammar bump to a full reindex — the chunk set moves", () => {
    const warning = LanguageVersionDriftMonitor.formatWarning([
      { language: "ruby", axes: [{ axis: "grammar", indexed: "0.22.0", current: "0.23.1" }] },
    ]);

    expect(warning).toContain("ruby: grammar 0.22.0→0.23.1");
    expect(warning).toContain("Run: tea-rags index-codebase --force");
  });

  it("routes a chunking bump to a full reindex", () => {
    const warning = LanguageVersionDriftMonitor.formatWarning([
      { language: "ruby", axes: [{ axis: "chunking", indexed: 1, current: 2 }] },
    ]);

    expect(warning).toContain("Run: tea-rags index-codebase --force");
  });

  it("never narrows the full reindex by language — that would drop every other language from the index", () => {
    const warning = LanguageVersionDriftMonitor.formatWarning([
      { language: "ruby", axes: [{ axis: "chunking", indexed: 1, current: 2 }] },
    ]);

    expect(warning).not.toContain("--languages");
  });

  it("escalates a mixed drift to the single command that subsumes the other", () => {
    const warning = LanguageVersionDriftMonitor.formatWarning([
      { language: "ruby", axes: [{ axis: "grammar", indexed: "0.22.0", current: "0.23.1" }] },
      { language: "typescript", axes: [{ axis: "walker", indexed: 1, current: 2 }] },
    ]);

    expect(warning.match(/Run: /g)).toHaveLength(1);
    expect(warning).toContain("Run: tea-rags index-codebase --force");
    expect(warning).not.toContain("--force-enrichments");
  });
});

describe("LanguageVersionDriftMonitor.checkByCollectionName", () => {
  function makeMonitor(input: {
    languageVersions?: Record<string, Partial<LanguageCodeVersions>>;
    languages?: Record<string, number>;
    entry?: unknown;
    stats?: unknown;
  }) {
    const registry = {
      get: () =>
        (input.entry === undefined
          ? input.languageVersions === undefined
            ? {}
            : { languageVersions: input.languageVersions }
          : input.entry) as never,
    };
    const statsCache = {
      load: () =>
        (input.stats === undefined
          ? { distributions: { language: input.languages ?? { typescript: 10 } } }
          : input.stats) as never,
    };
    return new LanguageVersionDriftMonitor(registry, statsCache, current);
  }

  it("returns the routed hint when a stamped axis is behind", () => {
    const monitor = makeMonitor({
      languageVersions: { typescript: { grammar: "0.23.2", chunking: 1, walker: 1, codegraphSchema: 1 } },
    });

    expect(monitor.checkByCollectionName("code_x")).toContain("--force-enrichments codegraph --languages typescript");
  });

  it("returns null when no axis moved", () => {
    const monitor = makeMonitor({ languageVersions: indexedAtCurrent });

    expect(monitor.checkByCollectionName("code_x")).toBeNull();
  });

  it("returns null when the collection has no registry entry", () => {
    const monitor = makeMonitor({ entry: null });

    expect(monitor.checkByCollectionName("code_x")).toBeNull();
  });

  it("returns null when the collection has no stats cache — the present-language set is unknown", () => {
    const monitor = makeMonitor({ stats: null });

    expect(monitor.checkByCollectionName("code_x")).toBeNull();
  });

  it("stays silent about a language the index does not contain", () => {
    const monitor = makeMonitor({
      languageVersions: { typescript: { grammar: "0.23.2", chunking: 1, walker: 1, codegraphSchema: 1 } },
      languages: { ruby: 10 },
    });

    expect(monitor.checkByCollectionName("code_x")).toBeNull();
  });
});
