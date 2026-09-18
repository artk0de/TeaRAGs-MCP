import { describe, expect, it } from "vitest";

import { SHARED_LANGUAGE, type LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
import { CommitDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/commit-drift-monitor.js";
import { EnvDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/env-drift-monitor.js";
import { LanguageVersionDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/language-version-drift-monitor.js";
import type {
  IndexDriftFinding,
  IndexDriftMonitor,
} from "../../../../../src/core/domains/maintenance/drift/monitor.js";
import {
  formatIndexDriftReport,
  IndexDriftReporter,
} from "../../../../../src/core/domains/maintenance/drift/report.js";
import { SchemaDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/schema-drift-monitor.js";
import { resolveCollectionName, validatePath } from "../../../../../src/core/infra/collection-name.js";

const fixed = (findings: IndexDriftFinding[]): IndexDriftMonitor => ({
  axis: findings[0]?.axis ?? "payloadKeys",
  check: () => findings,
});

/** A monitor whose verdict can change between checks — a repo that drifts, or gets repaired. */
const mutable = (state: { findings: IndexDriftFinding[] }): IndexDriftMonitor => ({
  axis: "payloadKeys",
  check: () => state.findings,
});

const keyFinding: IndexDriftFinding = {
  axis: "payloadKeys",
  subject: "git.file.ageDays",
  indexed: "absent",
  current: "declared",
  remedy: { kind: "recompute", trajectories: new Set(["git"]), languages: null },
};

const languageFinding: IndexDriftFinding = {
  axis: "languageVersions",
  subject: "python.walker",
  indexed: "1",
  current: "3",
  remedy: { kind: "recompute", trajectories: new Set(["codegraph"]), languages: new Set(["python"]) },
};

describe("IndexDriftReporter", () => {
  it("returns null when no monitor reports", () => {
    expect(new IndexDriftReporter([fixed([])]).checkByCollectionName("c")).toBeNull();
  });

  it("folds findings from every monitor into one remedy", () => {
    const report = new IndexDriftReporter([fixed([keyFinding]), fixed([languageFinding])]).checkByCollectionName("c");

    expect(report?.findings).toHaveLength(2);
    expect(report?.remedy).toEqual({
      kind: "recompute",
      trajectories: new Set(["codegraph", "git"]),
      languages: null,
    });
  });

  it("renders one block per axis and exactly one Run: line", () => {
    const report = new IndexDriftReporter([fixed([keyFinding]), fixed([languageFinding])]).checkByCollectionName("c");

    const text = formatIndexDriftReport(report!);

    expect(text).toBe(
      [
        "Payload keys:",
        "  git.file.ageDays: absent → declared",
        "Language versions:",
        "  python.walker: 1 → 3",
        "Run: tea-rags index-codebase --force-enrichments codegraph,git",
      ].join("\n"),
    );
    expect(text.match(/^Run:/gm)).toHaveLength(1);
  });

  it("fills --project from the alias resolver", () => {
    const report = new IndexDriftReporter([fixed([keyFinding])], () => "taxdome").checkByCollectionName("c");

    expect(formatIndexDriftReport(report!)).toContain(
      "Run: tea-rags index-codebase --project taxdome --force-enrichments git",
    );
  });

  it("reset makes checkAndConsume report the collection again", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    reporter.reset(resolveCollectionName(await validatePath("/tmp/test-project")));

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
  });

  // Moved from schema-drift-monitor.test.ts — consumption now lives here.
  it("checkAndConsume reports the SAME report once per process", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    expect(await reporter.checkAndConsume("/tmp/test-project")).toBeNull();
  });

  it("checkByPath reports without consuming — a later checkAndConsume still fires", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);

    expect(await reporter.checkByPath("/tmp/test-project")).not.toBeNull();
    expect(await reporter.checkByPath("/tmp/test-project")).not.toBeNull();
    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
  });

  it("checkByPath swallows an invalid path", async () => {
    const invalidPath = null as unknown as string;

    expect(await new IndexDriftReporter([fixed([keyFinding])]).checkByPath(invalidPath)).toBeNull();
  });

  it("checkAndConsume swallows an invalid path", async () => {
    // `validatePath` never throws on a string — a non-existent path falls back
    // to its absolute form — so the only input that reaches the catch is one
    // `path.resolve` itself rejects.
    const invalidPath = null as unknown as string;

    expect(await new IndexDriftReporter([fixed([keyFinding])]).checkAndConsume(invalidPath)).toBeNull();
  });
});

/**
 * Consumption is keyed by (collection, report signature), not by collection
 * alone (spec decision 13, as amended by the whole-branch review).
 *
 * Keying by collection alone spends the warning on the FIRST check, whatever it
 * found — so a clean check silenced the next search that actually had something
 * to say, and a report that grew a new finding after the first warning never
 * reached anyone until an index run reset it.
 */
describe("IndexDriftReporter — consumption keyed by (collection, report signature)", () => {
  const commitFinding: IndexDriftFinding = {
    axis: "commit",
    subject: "main",
    indexed: "abcdef1",
    current: "0123456",
    remedy: { kind: "incremental" },
  };

  it("a clean check consumes nothing — the next search that finds drift still warns", async () => {
    const state = { findings: [] as IndexDriftFinding[] };
    const reporter = new IndexDriftReporter([mutable(state)]);

    expect(await reporter.checkAndConsume("/tmp/test-project")).toBeNull();
    state.findings = [keyFinding];

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
  });

  it("warns again when the report itself changes", async () => {
    const state = { findings: [keyFinding] };
    const reporter = new IndexDriftReporter([mutable(state)]);

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    expect(await reporter.checkAndConsume("/tmp/test-project")).toBeNull();
    // A new commit moved HEAD: same collection, different report.
    state.findings = [keyFinding, commitFinding];

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    expect(await reporter.checkAndConsume("/tmp/test-project")).toBeNull();
  });

  it("reset clears EVERY signature recorded for the collection", async () => {
    const state = { findings: [keyFinding] };
    const reporter = new IndexDriftReporter([mutable(state)]);
    const collectionName = resolveCollectionName(await validatePath("/tmp/test-project"));

    await reporter.checkAndConsume("/tmp/test-project");
    state.findings = [keyFinding, commitFinding];
    await reporter.checkAndConsume("/tmp/test-project");
    reporter.reset(collectionName);

    // Both signatures are re-armed, not just the most recent one.
    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    state.findings = [keyFinding];
    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
  });

  it("keeps one collection's signatures out of another's", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);

    expect(reporter.checkAndConsumeByCollectionName("code_a")).not.toBeNull();
    expect(reporter.checkAndConsumeByCollectionName("code_b")).not.toBeNull();
    expect(reporter.checkAndConsumeByCollectionName("code_a")).toBeNull();
  });

  it("checkAndConsumeByCollectionName consumes the same set the path variant does", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);
    const collectionName = resolveCollectionName(await validatePath("/tmp/test-project"));

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();

    expect(reporter.checkAndConsumeByCollectionName(collectionName)).toBeNull();
  });

  it("checkByCollectionName stays non-consuming", () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);

    expect(reporter.checkByCollectionName("code_a")).not.toBeNull();
    expect(reporter.checkByCollectionName("code_a")).not.toBeNull();
    expect(reporter.checkAndConsumeByCollectionName("code_a")).not.toBeNull();
  });
});

/**
 * A relocated project — `register_project` re-pointed the existing entry at the
 * new path, so the indexed data still lives under the ORIGINAL collection name
 * while the path now hashes to something else (bd tea-rags-mcp-waj6k).
 *
 * Both path-addressed checks must land where a SEARCH lands, which is the
 * registry's collection. Addressed by the hash instead, the report describes a
 * collection nobody queries and the consumption is spent on a key no index run
 * ever resets.
 */
describe("IndexDriftReporter — path resolution", () => {
  const RELOCATED = "code_relocated";
  const PROJECT_PATH = "/tmp/test-project";

  /** Records which collection each monitor was asked about. */
  const recording = (seen: string[]): IndexDriftMonitor => ({
    axis: "payloadKeys",
    check: (collectionName) => {
      seen.push(collectionName);
      return [keyFinding];
    },
  });

  const relocated = (monitors: IndexDriftMonitor[]): IndexDriftReporter =>
    new IndexDriftReporter(
      monitors,
      () => undefined,
      async () => RELOCATED,
    );

  it("checkByPath asks the injected resolver's collection, not the path hash", async () => {
    const seen: string[] = [];

    await relocated([recording(seen)]).checkByPath(PROJECT_PATH);

    expect(seen).toEqual([RELOCATED]);
    expect(seen).not.toContain(resolveCollectionName(await validatePath(PROJECT_PATH)));
  });

  it("checkAndConsume consumes under the injected resolver's collection", async () => {
    const reporter = relocated([fixed([keyFinding])]);

    expect(await reporter.checkAndConsume(PROJECT_PATH)).not.toBeNull();

    // Consumption landed on the registry's collection: the collection-addressed
    // search sees it spent, and the index run's reset of that same name re-arms it.
    expect(reporter.checkAndConsumeByCollectionName(RELOCATED)).toBeNull();
    reporter.reset(RELOCATED);
    expect(await reporter.checkAndConsume(PROJECT_PATH)).not.toBeNull();
  });

  it("keeps resolving by path hash when no resolver is injected", async () => {
    const seen: string[] = [];

    await new IndexDriftReporter([recording(seen)]).checkByPath(PROJECT_PATH);

    expect(seen).toEqual([resolveCollectionName(await validatePath(PROJECT_PATH))]);
  });
});

/**
 * All four monitors, one collection, one report — the composition `factory.ts`
 * wires, driven end to end (whole-branch review item 5).
 *
 * Each monitor has its own unit tests, and none of them can see what breaks
 * when they are combined. The fold happens ACROSS axes, so an escalation that
 * stops subsuming, a note that stops rendering, or a second `Run:` line shows
 * up only here.
 */
describe("IndexDriftReporter — every axis at once", () => {
  const COLLECTION = "code_all_axes";

  /** One registry entry, serving all three registry-reading monitors. */
  const registry = {
    get: () => ({
      path: "/repo",
      env: { CODEGRAPH_ENABLED: "true" },
      languageVersions: { ruby: { chunking: 1, walker: 3, codegraphSchema: 1 } },
      git: { indexedBranch: "main", indexedCommit: "abcdef1234567", indexedDirty: false },
    }),
  };

  /** One stats entry, serving the payload-key axis and the language distribution. */
  const statsCache = {
    load: () => ({ payloadFieldKeys: ["language"], distributions: { language: { ruby: 12 } } }),
  };

  const currentVersions = new Map<string, LanguageCodeVersions>([
    // The ruby vertical's resolver moved: edges only, narrowable to ruby.
    ["ruby", { chunking: 1, walker: 4, codegraphSchema: 1 }],
    // The shared kernel moved too, and its sources ran under every language.
    // The stamp has no `*` entry, so it reads as the seeded 1.
    [SHARED_LANGUAGE, { chunking: 1, walker: 2, codegraphSchema: 1 }],
  ]);

  const reporter = (): IndexDriftReporter =>
    new IndexDriftReporter(
      [
        // `navigation` is chunker-owned and unattributed — the one finding that
        // escalates the whole report to the full reindex.
        new SchemaDriftMonitor(statsCache as never, ["language", "navigation"]),
        new LanguageVersionDriftMonitor(registry, statsCache, currentVersions),
        new EnvDriftMonitor(registry as never, () => ({ CODEGRAPH_ENABLED: "true" }), {
          CODEGRAPH_ENABLED: "false",
        }),
        new CommitDriftMonitor(registry as never, () => ({ commit: "0123456789abc", branch: "main" }) as never),
      ],
      () => "demo",
    );

  it("carries every finding and exactly ONE Run: line, the command that subsumes the rest", () => {
    const text = formatIndexDriftReport(reporter().checkByCollectionName(COLLECTION)!);

    expect(text).toContain("  navigation: absent → declared");
    expect(text).toContain("  ruby.walker: 3 → 4");
    expect(text).toContain("  *.walker: 1 → 2");
    expect(text).toContain("  main: abcdef1 → 0123456");
    // The flag's note is what tells the reader the codegraph.* keys are a
    // missing env var and not a schema change. Lose it and the report reads as
    // "rebuild" advice for something no rebuild repairs.
    expect(text).toContain(
      "  CODEGRAPH_ENABLED: true → false (explains any codegraph.* payload-key drift — restore the flag instead of rebuilding)",
    );

    // `incremental` and the two `recompute`s are all subsumed by the chunk-set
    // finding's `force`; the flag's `none` never competes.
    expect(text.match(/^Run:/gm)).toHaveLength(1);
    expect(text).toContain("Run: tea-rags index-codebase --project demo --force");
    expect(text).not.toContain("--force-enrichments");
  });

  it("groups the findings under one heading per axis", () => {
    const report = reporter().checkByCollectionName(COLLECTION)!;

    expect(new Set(report.findings.map((f) => f.axis))).toEqual(
      new Set(["payloadKeys", "languageVersions", "env", "commit"]),
    );
    expect(formatIndexDriftReport(report).match(/^\S.*:$/gm)).toEqual([
      "Payload keys:",
      "Language versions:",
      "Indexing env:",
      "Working tree:",
    ]);
  });
});
