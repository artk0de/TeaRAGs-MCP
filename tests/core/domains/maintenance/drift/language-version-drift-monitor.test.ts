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

import { SHARED_LANGUAGE, type LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
import { LanguageVersionDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/language-version-drift-monitor.js";
import {
  formatIndexDriftReport,
  IndexDriftReporter,
} from "../../../../../src/core/domains/maintenance/drift/report.js";

/**
 * What a reader of a search response sees for this one axis: the monitor's
 * findings rendered by the reporter that owns rendering. The cases below assert
 * on that text, so they run the monitor through a one-axis reporter rather than
 * through a per-monitor convenience method.
 */
function renderWarning(monitor: LanguageVersionDriftMonitor, collectionName: string): string | null {
  const report = new IndexDriftReporter([monitor]).checkByCollectionName(collectionName);
  return report && formatIndexDriftReport(report);
}

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

describe("LanguageVersionDriftMonitor — the remedy each moved axis renders", () => {
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

    const warning = renderWarning(monitor, "code_x");

    expect(warning).toContain("typescript.walker: 1 → 2");
    expect(warning).toContain("--force-enrichments codegraph --languages typescript");
  });

  // Which axis is chunk-set-moving and which is edges-only is a property of the
  // MONITOR (CHUNK_SET_AXES), not of a remedy literal — these cases are what
  // fails if the routing is deleted.
  it("routes a grammar bump to a full reindex — the chunk set moves", () => {
    const monitor = makeMonitor({
      languageVersions: { typescript: { grammar: "0.22.0", chunking: 1, walker: 2, codegraphSchema: 1 } },
    });

    const warning = renderWarning(monitor, "code_x");

    expect(warning).toContain("typescript.grammar: 0.22.0 → 0.23.2");
    expect(warning).toContain("Run: tea-rags index-codebase --force");
    expect(warning).not.toContain("--force-enrichments");
    // Narrowing a full reindex by language would drop every other language
    // from the rebuilt collection.
    expect(warning).not.toContain("--languages");
  });

  it("routes a chunking bump to a full reindex", () => {
    const monitor = makeMonitor({
      languageVersions: { typescript: { grammar: "0.23.2", chunking: 0, walker: 2, codegraphSchema: 1 } },
    });

    const warning = renderWarning(monitor, "code_x");

    expect(warning).toContain("typescript.chunking: 0 → 1");
    expect(warning).toContain("Run: tea-rags index-codebase --force");
    expect(warning).not.toContain("--force-enrichments");
  });

  it("routes a codegraph-schema bump to the narrowed enrichment recompute", () => {
    const monitor = makeMonitor({
      languageVersions: { ruby: { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 0 } },
      languages: { ruby: 10 },
    });

    const warning = renderWarning(monitor, "code_x");

    expect(warning).toContain("ruby.codegraphSchema: 0 → 1");
    expect(warning).toContain("Run: tea-rags index-codebase --force-enrichments codegraph --languages ruby");
  });

  it("escalates a mixed walker + grammar drift to the single command that subsumes the other", () => {
    const monitor = makeMonitor({
      languageVersions: { typescript: { grammar: "0.22.0", chunking: 1, walker: 1, codegraphSchema: 1 } },
    });

    const warning = renderWarning(monitor, "code_x");

    expect(warning).toContain("typescript.grammar: 0.22.0 → 0.23.2");
    expect(warning).toContain("typescript.walker: 1 → 2");
    expect(warning?.match(/Run: /g)).toHaveLength(1);
    expect(warning).toContain("Run: tea-rags index-codebase --force");
    expect(warning).not.toContain("--force-enrichments");
  });

  it("returns null when no axis moved", () => {
    const monitor = makeMonitor({ languageVersions: indexedAtCurrent });

    expect(renderWarning(monitor, "code_x")).toBeNull();
  });

  it("returns null when the collection has no registry entry", () => {
    const monitor = makeMonitor({ entry: null });

    expect(renderWarning(monitor, "code_x")).toBeNull();
  });

  it("returns null when the collection has no stats cache — the present-language set is unknown", () => {
    const monitor = makeMonitor({ stats: null });

    expect(renderWarning(monitor, "code_x")).toBeNull();
  });

  it("stays silent about a language the index does not contain", () => {
    const monitor = makeMonitor({
      languageVersions: { typescript: { grammar: "0.23.2", chunking: 1, walker: 1, codegraphSchema: 1 } },
      languages: { ruby: 10 },
    });

    expect(renderWarning(monitor, "code_x")).toBeNull();
  });
});

/**
 * The `*` pseudo-language (bd tea-rags-mcp-y6igo).
 *
 * The shared kernel, resolver chain and chunker sources run under EVERY
 * language, so a change there moves every language's output at once and no
 * `<lang>/capability.ts` number can say so. `*` carries that stamp — and it is
 * never in an index's language distribution, so the present-language gate that
 * keeps a TS-only project from being told to rebuild Ruby must not reach it.
 */
describe("LanguageVersionDriftMonitor — the shared * pseudo-language", () => {
  const currentWithShared = new Map<string, LanguageCodeVersions>([
    ...current,
    [SHARED_LANGUAGE, { chunking: 1, walker: 2, codegraphSchema: 1 }],
  ]);

  function makeSharedMonitor(input: {
    languageVersions?: Record<string, Partial<LanguageCodeVersions>>;
    languages?: Record<string, number>;
    stats?: unknown;
  }) {
    const registry = { get: () => ({ languageVersions: input.languageVersions }) as never };
    const statsCache = {
      load: () =>
        (input.stats === undefined
          ? { distributions: { language: input.languages ?? { ruby: 10 } } }
          : input.stats) as never,
    };
    return new LanguageVersionDriftMonitor(registry, statsCache, currentWithShared);
  }

  it("compares * regardless of which languages the index holds", () => {
    const drifts = LanguageVersionDriftMonitor.detectDrift({ "*": { walker: 1 } }, currentWithShared, ["ruby"]);

    expect(drifts).toEqual([{ language: "*", axes: [{ axis: "walker", indexed: 1, current: 2 }] }]);
  });

  it("compares * exactly once when the caller already listed it", () => {
    const drifts = LanguageVersionDriftMonitor.detectDrift({ "*": { walker: 1 } }, currentWithShared, ["*", "ruby"]);

    expect(drifts).toEqual([{ language: "*", axes: [{ axis: "walker", indexed: 1, current: 2 }] }]);
  });

  // An index written before `*` existed carries no stamp for it, and that is
  // exactly why sharedVersions.walker starts at 2: the seeded read makes such
  // an index report `*.walker: 1 → 2` once, on the upgrade that introduced it.
  it("reads a missing * stamp as the seeded version, so a pre-* index reports the shared walker once", () => {
    const drifts = LanguageVersionDriftMonitor.detectDrift({ ruby: { walker: 1 } }, currentWithShared, ["ruby"]);

    expect(drifts).toEqual([{ language: "*", axes: [{ axis: "walker", indexed: 1, current: 2 }] }]);
  });

  it("stays silent about * once the stamp caught up", () => {
    const drifts = LanguageVersionDriftMonitor.detectDrift(
      { "*": { chunking: 1, walker: 2, codegraphSchema: 1 } },
      currentWithShared,
      ["ruby"],
    );

    expect(drifts).toEqual([]);
  });

  it("a * finding recomputes codegraph for the whole collection", () => {
    const monitor = makeSharedMonitor({
      languageVersions: {
        "*": { chunking: 1, walker: 1, codegraphSchema: 1 },
        ruby: { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 },
      },
    });

    const finding = monitor.check("code_abc123")[0];

    expect(finding?.subject).toBe("*.walker");
    expect(finding?.remedy).toEqual({
      kind: "recompute",
      trajectories: new Set(["codegraph"]),
      languages: null,
    });
  });

  it("renders the shared recompute without a --languages narrowing", () => {
    const monitor = makeSharedMonitor({
      languageVersions: {
        "*": { chunking: 1, walker: 1, codegraphSchema: 1 },
        ruby: { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 },
      },
    });

    const warning = renderWarning(monitor, "code_abc123");

    expect(warning).toContain("*.walker: 1 → 2");
    expect(warning).toContain("Run: tea-rags index-codebase --force-enrichments codegraph");
    expect(warning).not.toContain("--languages");
  });

  // The present-language gate is there so a TS-only project is never told to
  // rebuild Ruby. `*` is in no distribution, so that gate must not silence it —
  // not even when the stats cache is missing entirely.
  it("still compares * when the stats cache is missing", () => {
    const monitor = makeSharedMonitor({
      languageVersions: { "*": { chunking: 1, walker: 1, codegraphSchema: 1 } },
      stats: null,
    });

    expect(monitor.check("code_abc123").map((finding) => finding.subject)).toEqual(["*.walker"]);
  });

  it("routes a shared chunking bump to the full reindex, like any chunk-set axis", () => {
    const monitor = makeSharedMonitor({
      languageVersions: { "*": { chunking: 0, walker: 2, codegraphSchema: 1 } },
    });

    const finding = monitor.check("code_abc123")[0];

    expect(finding?.subject).toBe("*.chunking");
    expect(finding?.remedy).toEqual({ kind: "force" });
  });
});
