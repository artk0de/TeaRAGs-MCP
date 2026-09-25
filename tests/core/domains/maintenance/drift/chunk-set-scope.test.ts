/**
 * Scoped chunk-set bumps (bd tea-rags-mcp-j4oww).
 *
 * A chunking or grammar bump may declare which files it changed the chunks of.
 * The drift report's `Run:` line then names the minimal scoped `--force`
 * instead of a whole-project rebuild; several pending scoped bumps collapse into
 * one combined filter; an unscoped bump keeps routing to the plain `--force`.
 * And a finished scoped run advances exactly the stamps whose pending bumps its
 * selection covered.
 */

import { describe, expect, it } from "vitest";

import { SHARED_LANGUAGE, type LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
import type { ChunkSetBumpScopes } from "../../../../../src/core/contracts/types/rechunk.js";
import {
  advanceChunkSetStamp,
  combineRechunkSelectors,
} from "../../../../../src/core/domains/maintenance/drift/chunk-set-scope.js";
import { LanguageVersionDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/language-version-drift-monitor.js";
import {
  foldIndexDriftRemedies,
  renderIndexDriftRemedy,
} from "../../../../../src/core/domains/maintenance/drift/remedy.js";
import {
  formatIndexDriftReport,
  IndexDriftReporter,
} from "../../../../../src/core/domains/maintenance/drift/report.js";

const current = new Map<string, LanguageCodeVersions>([
  ["typescript", { grammar: "0.23.2", chunking: 3, walker: 2, codegraphSchema: 1 }],
  ["ruby", { grammar: "0.23.1", chunking: 2, walker: 1, codegraphSchema: 1 }],
  [SHARED_LANGUAGE, { chunking: 1, walker: 5, codegraphSchema: 2 }],
]);

const atCurrent = {
  typescript: { grammar: "0.23.2", chunking: 3, walker: 2, codegraphSchema: 1 },
  ruby: { grammar: "0.23.1", chunking: 2, walker: 1, codegraphSchema: 1 },
  [SHARED_LANGUAGE]: { chunking: 1, walker: 5, codegraphSchema: 2 },
};

const TESTS_ONLY = { testFile: "only" } as const;

function warningFor(
  languageVersions: Record<string, Partial<LanguageCodeVersions>>,
  scopes: ReadonlyMap<string, ChunkSetBumpScopes>,
  languages: Record<string, number> = { typescript: 5, ruby: 5 },
): string | null {
  const monitor = new LanguageVersionDriftMonitor(
    { get: () => ({ languageVersions }) },
    { load: () => ({ distributions: { language: languages } }) },
    current,
    scopes,
  );
  const report = new IndexDriftReporter([monitor], () => "app").checkByCollectionName("code_x");
  return report && formatIndexDriftReport(report);
}

describe("drift Run: line for scoped chunk-set bumps", () => {
  it("names the minimal scoped force for one scoped chunking bump", () => {
    const warning = warningFor(
      { ...atCurrent, ruby: { ...atCurrent.ruby, chunking: 1 } },
      new Map([["ruby", { chunking: { 2: TESTS_ONLY } }]]),
    );

    expect(warning).toContain("ruby.chunking: 1 → 2");
    expect(warning).toContain("Run: tea-rags index-codebase --project app --force --test-file only --languages ruby");
  });

  it("collapses scoped bumps of several languages into one combined filter", () => {
    const warning = warningFor(
      {
        ...atCurrent,
        ruby: { ...atCurrent.ruby, chunking: 1 },
        typescript: { ...atCurrent.typescript, chunking: 1 },
      },
      new Map([
        ["ruby", { chunking: { 2: TESTS_ONLY } }],
        ["typescript", { chunking: { 2: TESTS_ONLY, 3: TESTS_ONLY } }],
      ]),
    );

    expect(warning).toContain(
      "Run: tea-rags index-codebase --project app --force --test-file only --languages ruby,typescript",
    );
  });

  it("keeps routing to the plain --force when any pending revision is unscoped", () => {
    const warning = warningFor(
      { ...atCurrent, typescript: { ...atCurrent.typescript, chunking: 1 } },
      new Map([["typescript", { chunking: { 2: TESTS_ONLY } }]]),
    );

    expect(warning).toContain("Run: tea-rags index-codebase --project app --force");
    expect(warning).not.toContain("--test-file");
    expect(warning).not.toContain("--languages");
  });

  it("routes a scoped grammar upgrade to the scoped force for that grammar version", () => {
    const warning = warningFor(
      { ...atCurrent, ruby: { ...atCurrent.ruby, grammar: "0.22.0" } },
      new Map([["ruby", { grammar: { "0.23.1": { pathPattern: "spec/**" } } }]]),
    );

    expect(warning).toContain("--force --path-pattern 'spec/**' --languages ruby");
  });

  it("a shared scoped bump narrows the files but not the languages", () => {
    const warning = warningFor(
      { ...atCurrent, [SHARED_LANGUAGE]: { chunking: 0, walker: 5, codegraphSchema: 2 } },
      new Map([[SHARED_LANGUAGE, { chunking: { 1: TESTS_ONLY } }]]),
    );

    expect(warning).toContain("Run: tea-rags index-codebase --project app --force --test-file only");
    expect(warning).not.toContain("--languages");
  });

  it("names the recompute as a second step when a scoped force cannot subsume it", () => {
    const warning = warningFor(
      { ...atCurrent, ruby: { ...atCurrent.ruby, chunking: 1 }, typescript: { ...atCurrent.typescript, walker: 1 } },
      new Map([["ruby", { chunking: { 2: TESTS_ONLY } }]]),
    );

    expect(warning).toContain("Run: tea-rags index-codebase --project app --force --test-file only --languages ruby");
    expect(warning).toContain(
      "Then: tea-rags index-codebase --project app --force-enrichments codegraph --languages typescript",
    );
  });
});

describe("foldIndexDriftRemedies — scoped force", () => {
  it("an unscoped force subsumes a scoped one", () => {
    const folded = foldIndexDriftRemedies([
      { kind: "force", selector: { testFile: "only", languages: ["ruby"] } },
      { kind: "force" },
    ]);
    expect(folded).toEqual({ kind: "force" });
  });

  it("a scoped force subsumes an incremental", () => {
    const folded = foldIndexDriftRemedies([
      { kind: "incremental" },
      { kind: "force", selector: { testFile: "only", languages: ["ruby"] } },
    ]);
    expect(renderIndexDriftRemedy(folded, "app")).toBe(
      "Run: tea-rags index-codebase --project app --force --test-file only --languages ruby",
    );
  });
});

describe("combineRechunkSelectors", () => {
  it("keeps a dimension both agree on and unions the languages", () => {
    expect(
      combineRechunkSelectors({ testFile: "only", languages: ["ruby"] }, { testFile: "only", languages: ["go"] }),
    ).toEqual({ testFile: "only", languages: ["go", "ruby"] });
  });

  it("widens a dimension they disagree on — a superset re-chunks extra files, never too few", () => {
    expect(
      combineRechunkSelectors({ testFile: "only", languages: ["ruby"] }, { pathPattern: "lib/**", languages: ["go"] }),
    ).toEqual({ languages: ["go", "ruby"] });
  });

  it("is unrestricted once nothing is left to narrow by", () => {
    expect(combineRechunkSelectors({ testFile: "only" }, { testFile: "exclude" })).toBeUndefined();
  });
});

describe("advanceChunkSetStamp — what a finished scoped run may claim", () => {
  const ruby = current.get("ruby")!;
  const scopes: ChunkSetBumpScopes = { chunking: { 2: TESTS_ONLY } };

  it("advances chunking when the selection covers every pending scoped revision", () => {
    expect(
      advanceChunkSetStamp("ruby", { ...atCurrent.ruby, chunking: 1 }, ruby, scopes, {
        testFile: "only",
        languages: ["ruby"],
      }),
    ).toEqual({ chunking: 2 });
  });

  it("advances nothing when the selection is narrower than the bump", () => {
    expect(
      advanceChunkSetStamp("ruby", { ...atCurrent.ruby, chunking: 1 }, ruby, scopes, {
        testFile: "only",
        pathPattern: "spec/models/**",
      }),
    ).toEqual({});
  });

  it("advances nothing for a language the selection leaves out", () => {
    expect(
      advanceChunkSetStamp("ruby", { ...atCurrent.ruby, chunking: 1 }, ruby, scopes, {
        testFile: "only",
        languages: ["typescript"],
      }),
    ).toEqual({});
  });

  it("an unscoped bump is covered by re-chunking every file of the language", () => {
    expect(advanceChunkSetStamp("ruby", { ...atCurrent.ruby, chunking: 1 }, ruby, {}, { languages: ["ruby"] })).toEqual(
      { chunking: 2 },
    );
    expect(
      advanceChunkSetStamp(
        "ruby",
        { ...atCurrent.ruby, chunking: 1 },
        ruby,
        {},
        { languages: ["ruby"], testFile: "only" },
      ),
    ).toEqual({});
  });

  it("advances to the highest contiguously covered revision and stops at the first uncovered one", () => {
    const typescript = current.get("typescript")!;
    expect(
      advanceChunkSetStamp(
        "typescript",
        { ...atCurrent.typescript, chunking: 1 },
        typescript,
        { chunking: { 2: TESTS_ONLY } },
        { testFile: "only" },
      ),
    ).toEqual({ chunking: 2 });
  });

  it("an explicit file list never proves coverage", () => {
    expect(
      advanceChunkSetStamp("ruby", { ...atCurrent.ruby, chunking: 1 }, ruby, scopes, {
        testFile: "only",
        files: ["spec/a_spec.rb"],
      }),
    ).toEqual({});
  });

  it("advances a scoped grammar upgrade the selection covers", () => {
    expect(
      advanceChunkSetStamp(
        "ruby",
        { ...atCurrent.ruby, grammar: "0.22.0" },
        ruby,
        { grammar: { "0.23.1": TESTS_ONLY } },
        { testFile: "only" },
      ),
    ).toEqual({ grammar: "0.23.1" });
  });

  it("* is covered only by a selection that does not narrow languages", () => {
    const shared = current.get(SHARED_LANGUAGE)!;
    const sharedScopes: ChunkSetBumpScopes = { chunking: { 1: TESTS_ONLY } };
    expect(advanceChunkSetStamp(SHARED_LANGUAGE, { chunking: 0 }, shared, sharedScopes, { testFile: "only" })).toEqual({
      chunking: 1,
    });
    expect(
      advanceChunkSetStamp(SHARED_LANGUAGE, { chunking: 0 }, shared, sharedScopes, {
        testFile: "only",
        languages: ["ruby"],
      }),
    ).toEqual({});
  });
});
