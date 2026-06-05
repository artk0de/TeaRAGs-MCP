# Per-File Enrichment Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip expensive/meaningless git enrichment (blame + chunk-churn walk) on generated and documentation files while keeping them searchable, with file classification as a single source of truth and per-provider policy.

**Architecture:** A FACT layer — `infra/file-classification/classify()` — owns the consolidated generated/test patterns + content markers (absorbing codegraph's duplicates). A POLICY layer — optional `EnrichmentProvider.shouldEnrich()` returning `"full" | "file-only" | "none"` — lets each provider decide per file. Ingest wires the two via a stateless `enrichmentScope()` helper consulted in file-phase (skip `"none"` file work) and chunk-phase (skip non-`"full"` chunk-churn). git: generated→none, docs→file-only. codegraph: generated→none, test→none.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), `ignore` npm package (gitignore semantics), vitest.

**Spec:** `docs/superpowers/specs/2026-06-05-per-file-enrichment-policy-design.md`

**Worktree staging rule:** This worktree carries unrelated uncommitted changes from a parallel session (`derived-signals/*`, `explore/label-resolver.ts`, `explore/stats-recompute.ts`). **Stage ONLY the files each task names.** Never `git add -A`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/core/contracts/types/file-classification.ts` | Canonical `FileClassification` type | Create |
| `src/core/contracts/types/provider.ts` | `EnrichmentScope` + optional `shouldEnrich` on the contract | Modify |
| `src/core/infra/file-classification/patterns.ts` | `GENERATED_PATTERNS`, `TEST_PATTERNS`, markers, env override | Create |
| `src/core/infra/file-classification/classify.ts` | `classify()` impl (structural `FileClassification`) | Create |
| `src/core/infra/file-classification/index.ts` | Barrel | Create |
| `src/core/domains/trajectory/codegraph/exclusion.ts` | Source patterns from infra (dedup) | Modify |
| `src/core/domains/trajectory/git/provider.ts` | git `shouldEnrich` policy | Modify |
| `src/core/domains/trajectory/codegraph/<provider>.ts` | codegraph `shouldEnrich` policy | Modify |
| `src/core/domains/ingest/pipeline/enrichment/policy.ts` | stateless `enrichmentScope()` helper | Create |
| `src/core/domains/ingest/pipeline/enrichment/file-phase.ts` | gate file work by scope ≠ `"none"` | Modify |
| `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts` | gate chunk-churn by scope ≠ `"full"` | Modify |

---

## Task 1: Contract — `FileClassification` type + `EnrichmentScope` + `shouldEnrich`

**Files:**
- Create: `src/core/contracts/types/file-classification.ts`
- Modify: `src/core/contracts/types/provider.ts`

This task is type/contract-only (no runtime behaviour) — verified by `tsc`, not a unit test. Behaviour tests land with the consumers (Tasks 2, 4, 5, 7, 8).

- [ ] **Step 1: Create the canonical type**

```ts
// src/core/contracts/types/file-classification.ts
/**
 * What kind of file this is — the single FACT consumed by per-provider
 * enrichment policy (EnrichmentProvider.shouldEnrich). Canonical home.
 *
 * Domain-boundary note: core/infra/ may NOT import core/contracts/ (foundation
 * imports nothing — applies to `import type` too). So
 * infra/file-classification/classify() declares a structurally-identical local
 * return type instead of importing this one; the two are kept in sync by
 * structural assignability, mirroring the ChunkSignalOptions.blobReader ↔
 * CatFileBatchReader pairing in provider.ts.
 */
export interface FileClassification {
  /** Ordinary, human-edited source code. */
  isSource: boolean;
  /** Machine-generated (db/schema.rb, *.pb.go, @generated marker, vendored). */
  isGenerated: boolean;
  /** Documentation (markdown etc.) — derived from the file's language. */
  isDocumentation: boolean;
  /** Test file (*_spec.rb, *.test.ts, test dirs). */
  isTest: boolean;
}
```

- [ ] **Step 2: Add `EnrichmentScope` and `shouldEnrich` to the contract**

In `src/core/contracts/types/provider.ts`, add the scope type just above `export interface EnrichmentProvider {` (near line 214):

```ts
/**
 * How much enrichment a provider wants for one file.
 *   "full"      — file-level AND chunk-level enrichment (default).
 *   "file-only" — file-level only; skip the expensive chunk-churn walk.
 *   "none"      — skip both. The file stays indexed/searchable; only this
 *                 provider's signals are omitted for it.
 */
export type EnrichmentScope = "full" | "file-only" | "none";
```

Then add this optional member inside the `EnrichmentProvider` interface (after `handleDeletedPaths`, before `workerDescriptor`):

```ts
  /**
   * Per-file enrichment policy. The coordinator classifies each file once
   * (FileClassification) and asks the provider how much enrichment it wants.
   * Absent ⇒ "full" (backward-compatible: existing providers enrich
   * everything as before). `classification` is duck-typed structurally
   * (contracts is pure — no infra import); the canonical type is
   * FileClassification in contracts/types/file-classification.ts.
   */
  shouldEnrich?(file: {
    relPath: string;
    classification: { isSource: boolean; isGenerated: boolean; isDocumentation: boolean; isTest: boolean };
  }): EnrichmentScope;
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (additive optional member + new type, no existing code references it yet).

- [ ] **Step 4: Commit**

```bash
git add src/core/contracts/types/file-classification.ts src/core/contracts/types/provider.ts
git commit -m "feat(contracts): add FileClassification + EnrichmentScope + shouldEnrich"
```

---

## Task 2: Foundation — `infra/file-classification/classify()`

**Files:**
- Create: `src/core/infra/file-classification/patterns.ts`
- Create: `src/core/infra/file-classification/classify.ts`
- Create: `src/core/infra/file-classification/index.ts`
- Test: `tests/core/infra/file-classification/classify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/infra/file-classification/classify.test.ts
import { describe, it, expect } from "vitest";

import { classify } from "../../../../src/core/infra/file-classification/index.js";

describe("classify", () => {
  it("flags Rails schema as generated", () => {
    const c = classify("db/schema.rb");
    expect(c.isGenerated).toBe(true);
    expect(c.isSource).toBe(false);
  });

  it("flags vendored code and protobufs as generated", () => {
    expect(classify("vendor/bundle/gems/x.rb").isGenerated).toBe(true);
    expect(classify("api/user.pb.go").isGenerated).toBe(true);
    expect(classify("proto/user_pb2.py").isGenerated).toBe(true);
  });

  it("does NOT flag ordinary source as generated", () => {
    const c = classify("app/models/user.rb");
    expect(c.isGenerated).toBe(false);
    expect(c.isSource).toBe(true);
  });

  it("flags test files via test patterns", () => {
    expect(classify("spec/models/user_spec.rb").isTest).toBe(true);
    expect(classify("src/foo.test.ts").isTest).toBe(true);
    expect(classify("app/models/user.rb").isTest).toBe(false);
  });

  it("detects content-marker generated files", () => {
    const c = classify("api/zz_generated.go", { contentHead: "// Code generated by protoc. DO NOT EDIT." });
    expect(c.isGenerated).toBe(true);
  });

  it("passes documentation flag through and excludes it from isSource", () => {
    const c = classify("README.md", { isDocumentation: true });
    expect(c.isDocumentation).toBe(true);
    expect(c.isSource).toBe(false);
    expect(c.isGenerated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/file-classification/classify.test.ts`
Expected: FAIL — cannot resolve `infra/file-classification/index.js`.

- [ ] **Step 3: Create patterns**

```ts
// src/core/infra/file-classification/patterns.ts
/**
 * Single source of truth for "what kind of file is this" path patterns.
 * Consolidates the previously codegraph-only generated/test pattern lists
 * (was trajectory/codegraph/exclusion.ts) so git enrichment, codegraph, and
 * any future consumer share one definition. `ignore` (gitignore) syntax.
 */

/** Machine-generated files — never meaningfully owned, often huge. */
export const GENERATED_PATTERNS: readonly string[] = [
  // Rails generated AR schema — re-authored by `rails db:migrate`.
  "**/db/schema.rb",
  // Vendored third-party code (bundled gems, asset libs).
  "**/vendor/**",
  // Protobuf / gRPC generated stubs.
  "*.pb.go",
  "*_pb2.py",
  // Common "generated" naming conventions.
  "*.generated.*",
  "*.g.dart",
];

/** Conventional test-file shapes for every language with a codegraph walker. */
export const TEST_PATTERNS: readonly string[] = [
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/spec/**",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.mjs",
  "**/*.spec.cjs",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
  "**/*_test.rb",
  "**/*_spec.rb",
  "**/*Test.java",
  "**/*Tests.java",
  "**/*IT.java",
  "**/*_test.go",
  "**/*_test.rs",
];

/** First-N-lines markers that identify generated files with non-standard names. */
export const GENERATED_CONTENT_MARKERS: readonly RegExp[] = [
  /Code generated .* DO NOT EDIT/i,
  /@generated\b/,
  /^\s*#\s*Autogenerated/im,
];

/**
 * User-supplied extra generated patterns via `TEA_RAGS_GENERATED_PATTERNS`
 * (comma-separated gitignore globs). Shared knob — affects both git-skip and
 * codegraph graph-exclusion. The legacy `CODEGRAPH_CUSTOM_EXCLUDE` env keeps
 * working independently in codegraph's own filter.
 */
export const USER_GENERATED_PATTERNS: readonly string[] = (process.env.TEA_RAGS_GENERATED_PATTERNS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
```

- [ ] **Step 4: Create the classifier**

```ts
// src/core/infra/file-classification/classify.ts
import ignore, { type Ignore } from "ignore";

import { GENERATED_CONTENT_MARKERS, GENERATED_PATTERNS, TEST_PATTERNS, USER_GENERATED_PATTERNS } from "./patterns.js";

/**
 * Structurally identical to FileClassification in
 * core/contracts/types/file-classification.ts. Declared locally because
 * core/infra/ may not import core/contracts/ (foundation imports nothing).
 * Keep the two in sync — see the note in the contracts file.
 */
export interface FileClassification {
  isSource: boolean;
  isGenerated: boolean;
  isDocumentation: boolean;
  isTest: boolean;
}

export interface ClassifyOptions {
  /** First ~5 lines of the file, for content-marker generated detection. */
  contentHead?: string;
  /** Documentation flag, derived by the caller from the file's language. */
  isDocumentation?: boolean;
}

// Built once — immutable after construction (the `ignore` package is stateless
// once loaded). Lazily initialised so module import stays side-effect-light.
let generatedFilter: Ignore | undefined;
let testFilter: Ignore | undefined;

function getGeneratedFilter(): Ignore {
  if (!generatedFilter) {
    generatedFilter = ignore()
      .add(GENERATED_PATTERNS as string[])
      .add(USER_GENERATED_PATTERNS as string[]);
  }
  return generatedFilter;
}

function getTestFilter(): Ignore {
  if (!testFilter) testFilter = ignore().add(TEST_PATTERNS as string[]);
  return testFilter;
}

function hasGeneratedMarker(head: string): boolean {
  return GENERATED_CONTENT_MARKERS.some((re) => re.test(head));
}

/**
 * Classify a repo-relative path. Pattern-based generated/test detection plus
 * optional content-marker scan. `isDocumentation` is passed through (its
 * source of truth is the language layer in ingest/chunker/config.ts).
 */
export function classify(relPath: string, opts?: ClassifyOptions): FileClassification {
  const isGenerated =
    getGeneratedFilter().ignores(relPath) || (opts?.contentHead ? hasGeneratedMarker(opts.contentHead) : false);
  const isTest = getTestFilter().ignores(relPath);
  const isDocumentation = opts?.isDocumentation === true;
  // A generated or documentation file is not "source". A test IS source.
  const isSource = !isGenerated && !isDocumentation;
  return { isSource, isGenerated, isDocumentation, isTest };
}
```

- [ ] **Step 5: Create the barrel**

```ts
// src/core/infra/file-classification/index.ts
export { classify, type FileClassification, type ClassifyOptions } from "./classify.js";
export { GENERATED_PATTERNS, TEST_PATTERNS, GENERATED_CONTENT_MARKERS, USER_GENERATED_PATTERNS } from "./patterns.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/file-classification/classify.test.ts`
Expected: PASS (all 6).

- [ ] **Step 7: Commit**

```bash
git add src/core/infra/file-classification/ tests/core/infra/file-classification/
git commit -m "feat(infra): add file-classification single source of truth (classify)"
```

---

## Task 3: Dedup — codegraph `exclusion.ts` sources patterns from infra

**Files:**
- Modify: `src/core/domains/trajectory/codegraph/exclusion.ts`
- Test: `tests/core/domains/trajectory/codegraph/exclusion.test.ts` (existing — keep green; update only if it asserts the exact pattern array)

- [ ] **Step 1: Locate the existing exclusion test and its assertions**

Run: `npx vitest run tests/core/domains/trajectory/codegraph 2>&1 | tail -20`
Note which tests assert behaviour (schema.rb/vendor excluded — keep) vs the exact array contents (may need updating since infra adds `*.pb.go` etc.).

- [ ] **Step 2: Re-point the pattern constants to infra**

In `src/core/domains/trajectory/codegraph/exclusion.ts`, replace the two literal arrays (`CODEGRAPH_GENERATED_PATTERNS`, `CODEGRAPH_TEST_PATTERNS`) with re-exports from infra, keeping the export names for any importer:

```ts
import ignore, { type Ignore } from "ignore";

import { GENERATED_PATTERNS, TEST_PATTERNS } from "../../../infra/file-classification/index.js";

/**
 * Generated/machine-authored file patterns — now sourced from the single
 * source of truth in infra/file-classification. Re-exported under the
 * codegraph names for backward compatibility with existing importers.
 */
export const CODEGRAPH_GENERATED_PATTERNS: readonly string[] = GENERATED_PATTERNS;
export const CODEGRAPH_TEST_PATTERNS: readonly string[] = TEST_PATTERNS;
```

Leave `CodegraphExclusionOptions` and `buildCodegraphExclusionFilter` unchanged — they already consume these constants (`buildCodegraphExclusionFilter` adds `CODEGRAPH_GENERATED_PATTERNS`, then `CODEGRAPH_TEST_PATTERNS` when `excludeTests`, then `customPatterns`). The bespoke literal definitions are deleted; the behaviour is identical except generated coverage now includes the extra infra patterns.

- [ ] **Step 3: Run codegraph exclusion tests**

Run: `npx vitest run tests/core/domains/trajectory/codegraph`
Expected: PASS. If a test asserted the EXACT old array (`["**/db/schema.rb", "**/vendor/**"]`), update that assertion to match the consolidated list (this is a test of a data constant, not business logic — allowed). Behavioural assertions (`ignores("db/schema.rb") === true`) stay unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/trajectory/codegraph/exclusion.ts tests/core/domains/trajectory/codegraph/exclusion.test.ts
git commit -m "refactor(trajectory): source codegraph generated/test patterns from infra (dedup)"
```

---

## Task 4: Git provider `shouldEnrich`

**Files:**
- Modify: `src/core/domains/trajectory/git/provider.ts`
- Test: `tests/core/domains/trajectory/git/provider.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/core/domains/trajectory/git/provider.test.ts` (reuse the existing `GitEnrichmentProvider` construction in that file):

```ts
describe("shouldEnrich", () => {
  const provider = new GitEnrichmentProvider(/* existing test ctor args from this file */);
  const base = { isSource: true, isGenerated: false, isDocumentation: false, isTest: false };

  it("skips everything for generated files", () => {
    expect(provider.shouldEnrich!({ relPath: "db/schema.rb", classification: { ...base, isSource: false, isGenerated: true } })).toBe("none");
  });

  it("keeps file-level but skips chunk-churn for documentation", () => {
    expect(provider.shouldEnrich!({ relPath: "README.md", classification: { ...base, isSource: false, isDocumentation: true } })).toBe("file-only");
  });

  it("fully enriches ordinary source (incl. tests)", () => {
    expect(provider.shouldEnrich!({ relPath: "app/models/user.rb", classification: base })).toBe("full");
    expect(provider.shouldEnrich!({ relPath: "spec/user_spec.rb", classification: { ...base, isTest: true } })).toBe("full");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/trajectory/git/provider.test.ts -t shouldEnrich`
Expected: FAIL — `shouldEnrich` is undefined.

- [ ] **Step 3: Implement the policy**

In `src/core/domains/trajectory/git/provider.ts`, add the import and method to `GitEnrichmentProvider`:

```ts
import type { EnrichmentScope } from "../../../contracts/types/provider.js";
import type { FileClassification } from "../../../contracts/types/file-classification.js";
```

```ts
  /**
   * Git policy: generated files carry harmful signals (regeneration churn,
   * generator as "owner") and are huge blame targets → skip entirely.
   * Documentation keeps cheap file-level ownership but drops the per-chunk
   * churn walk over prose. Everything else (incl. tests) enriches fully.
   */
  shouldEnrich(file: { relPath: string; classification: FileClassification }): EnrichmentScope {
    if (file.classification.isGenerated) return "none";
    if (file.classification.isDocumentation) return "file-only";
    return "full";
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/trajectory/git/provider.test.ts -t shouldEnrich`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/git/provider.ts tests/core/domains/trajectory/git/provider.test.ts
git commit -m "feat(trajectory): git shouldEnrich — generated none, docs file-only"
```

---

## Task 5: Codegraph provider `shouldEnrich`

**Files:**
- Modify: codegraph EnrichmentProvider class (locate in Step 1)
- Test: that provider's test file

- [ ] **Step 1: Locate the codegraph EnrichmentProvider class + its test**

Run: `grep -rn "implements EnrichmentProvider" src/core/domains/trajectory/codegraph/`
Run: `grep -rln "excludeTests\|CODEGRAPH_EXCLUDE_TESTS" src/core/domains/trajectory/codegraph/`
Identify the class with `key = "codegraph"` and how it reads the exclude-tests flag (env `CODEGRAPH_EXCLUDE_TESTS`, default true).

- [ ] **Step 2: Write the failing test**

In that provider's test file, add (adapt construction to the file's existing pattern; pass `excludeTests: true` config if the ctor takes it):

```ts
describe("shouldEnrich", () => {
  const base = { isSource: true, isGenerated: false, isDocumentation: false, isTest: false };
  // construct provider with excludeTests=true per this file's existing setup
  it("skips generated files", () => {
    expect(provider.shouldEnrich!({ relPath: "db/schema.rb", classification: { ...base, isSource: false, isGenerated: true } })).toBe("none");
  });
  it("skips test files when excludeTests is on", () => {
    expect(provider.shouldEnrich!({ relPath: "spec/user_spec.rb", classification: { ...base, isTest: true } })).toBe("none");
  });
  it("fully enriches ordinary source", () => {
    expect(provider.shouldEnrich!({ relPath: "app/models/user.rb", classification: base })).toBe("full");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run <codegraph-provider-test-path> -t shouldEnrich`
Expected: FAIL — `shouldEnrich` undefined.

- [ ] **Step 4: Implement the policy**

Add to the codegraph provider class (reuse its existing `excludeTests` field/flag — do NOT re-read the env here):

```ts
import type { EnrichmentScope } from "../../../contracts/types/provider.js"; // adjust depth
import type { FileClassification } from "../../../contracts/types/file-classification.js"; // adjust depth
```

```ts
  /**
   * Codegraph policy: generated files have no human-authored call graph;
   * tests skew fanOut/isHub/PageRank (high fanOut, fanIn=0). Docs are
   * irrelevant to the graph and enrich fully (no chunk graph emitted for
   * them anyway).
   */
  shouldEnrich(file: { relPath: string; classification: FileClassification }): EnrichmentScope {
    if (file.classification.isGenerated) return "none";
    if (this.excludeTests && file.classification.isTest) return "none";
    return "full";
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run <codegraph-provider-test-path> -t shouldEnrich`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add <codegraph-provider-path> <codegraph-provider-test-path>
git commit -m "feat(trajectory): codegraph shouldEnrich — generated + test none"
```

---

## Task 6: Ingest — stateless `enrichmentScope()` helper

**Files:**
- Create: `src/core/domains/ingest/pipeline/enrichment/policy.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/policy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/ingest/pipeline/enrichment/policy.test.ts
import { describe, it, expect } from "vitest";

import { enrichmentScope } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/policy.js";
import type { EnrichmentProvider } from "../../../../../../src/core/contracts/types/provider.js";

function providerWith(shouldEnrich?: EnrichmentProvider["shouldEnrich"]): EnrichmentProvider {
  return { key: "x", shouldEnrich } as unknown as EnrichmentProvider;
}

describe("enrichmentScope", () => {
  it("defaults to full when the provider has no shouldEnrich", () => {
    expect(enrichmentScope(providerWith(undefined), "app/models/user.rb")).toBe("full");
  });

  it("classifies and delegates: generated → provider decides none", () => {
    const p = providerWith((f) => (f.classification.isGenerated ? "none" : "full"));
    expect(enrichmentScope(p, "db/schema.rb")).toBe("none");
    expect(enrichmentScope(p, "app/models/user.rb")).toBe("full");
  });

  it("derives isDocumentation from the file language (markdown → file-only)", () => {
    const p = providerWith((f) => (f.classification.isDocumentation ? "file-only" : "full"));
    expect(enrichmentScope(p, "README.md")).toBe("file-only");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/ingest/pipeline/enrichment/policy.test.ts`
Expected: FAIL — cannot resolve `policy.js`.

- [ ] **Step 3: Implement the helper**

```ts
// src/core/domains/ingest/pipeline/enrichment/policy.ts
/**
 * Bridges the FACT layer (infra/file-classification) and the POLICY layer
 * (EnrichmentProvider.shouldEnrich). Stateless — imported directly by
 * file-phase and chunk-phase so no DI threading touches the hot coordinator.
 *
 * isDocumentation's source of truth stays in the language layer
 * (chunker/config.ts LANGUAGE_DEFINITIONS) — derived here and passed into
 * classify(), never re-derived in infra.
 */
import { extname } from "node:path";

import type { EnrichmentProvider, EnrichmentScope } from "../../../../contracts/types/provider.js";
import { classify } from "../../../../infra/file-classification/index.js";
import { LANGUAGE_DEFINITIONS, LANGUAGE_MAP } from "../chunker/config.js";

function isDocumentationPath(relPath: string): boolean {
  const lang = LANGUAGE_MAP[extname(relPath).toLowerCase()];
  return lang ? LANGUAGE_DEFINITIONS[lang]?.isDocumentation === true : false;
}

/**
 * Resolve the enrichment scope a provider wants for a repo-relative path.
 * Computes the FileClassification (generated/test/doc/source) and delegates to
 * the provider's policy. Providers without `shouldEnrich` get "full".
 */
export function enrichmentScope(
  provider: EnrichmentProvider,
  relPath: string,
  contentHead?: string,
): EnrichmentScope {
  if (!provider.shouldEnrich) return "full";
  const classification = classify(relPath, { isDocumentation: isDocumentationPath(relPath), contentHead });
  return provider.shouldEnrich({ relPath, classification });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/ingest/pipeline/enrichment/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/policy.ts tests/core/domains/ingest/pipeline/enrichment/policy.test.ts
git commit -m "feat(ingest): enrichmentScope helper bridging classification + shouldEnrich"
```

---

## Task 7: File-phase — skip `"none"` files from file enrichment

**Files:**
- Modify: `src/core/domains/ingest/pipeline/enrichment/file-phase.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the file-phase test (adapt to existing helpers/mocks in that file). The intent: a provider whose `shouldEnrich` returns `"none"` for a path receives an `onBatch` that does NOT pass that path to `runFileBatch`.

```ts
it("omits scope=none files from file enrichment dispatch", async () => {
  const runFileBatch = vi.fn().mockResolvedValue(new Map());
  const provider = {
    key: "git",
    defersChunkEnrichment: false,
    fileSignalTransform: undefined,
    shouldEnrich: (f: { classification: { isGenerated: boolean } }) =>
      (f.classification.isGenerated ? "none" : "full"),
  } as unknown as EnrichmentProvider;
  // build FilePhase with an executor whose runFileBatch === the spy, init with
  // a single ctx for `provider`, then call onBatch with two ChunkItems whose
  // filePaths are `<root>/db/schema.rb` and `<root>/app/models/user.rb`.
  // ...existing-file setup...
  await Promise.all([...perProvider.values()]);
  const dispatchedPaths = runFileBatch.mock.calls[0][2]; // relPaths arg
  expect(dispatchedPaths).toContain("app/models/user.rb");
  expect(dispatchedPaths).not.toContain("db/schema.rb");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts -t "scope=none"`
Expected: FAIL — `db/schema.rb` is still dispatched.

- [ ] **Step 3: Gate the dispatch**

In `src/core/domains/ingest/pipeline/enrichment/file-phase.ts`, import the helper:

```ts
import { enrichmentScope } from "./policy.js";
```

Inside `onBatch`, right after `const relPaths = this.uniqueRelPaths(items, root);` (≈ line 141), filter out `"none"` paths before both the deferred and normal dispatch:

```ts
      const relPaths = this.uniqueRelPaths(items, root);
      // Per-file enrichment policy: drop files this provider declines entirely
      // ("none"). "file-only" still enriches file-level here — only chunk-phase
      // skips those. Providers without shouldEnrich get "full" (no-op filter).
      const enrichPaths = relPaths.filter((rel) => enrichmentScope(ctx.provider, rel) !== "none");
      if (enrichPaths.length === 0) continue;
```

Then replace the two `relPaths` arguments passed to `this.executor.runFileBatch(ctx.provider, root, relPaths, …)` (the deferred branch ≈ line 158 and the normal branch ≈ line 172) with `enrichPaths`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts`
Expected: PASS (new test + all existing file-phase tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/file-phase.ts tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts
git commit -m "feat(ingest): skip scope=none files from file-level enrichment"
```

---

## Task 8: Chunk-phase — skip non-`"full"` files from chunk-churn

**Files:**
- Modify: `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts`

`runChunkSignals` (chunk-phase.ts:372) is the single chokepoint both the streaming entry (`onBatchProvider` → line 187) and the post-flush entry (`enrichRemaining` → line 230) flow through. Filtering there covers both.

- [ ] **Step 1: Write the failing test**

Add to the chunk-phase test (adapt to existing helpers). Intent: a `buildChunkSignals` spy is NOT called for files whose provider scope is `"none"` or `"file-only"`, but IS for `"full"`.

```ts
it("skips chunk-churn for scope=none and scope=file-only files", async () => {
  const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
  const provider = {
    key: "git",
    defersChunkEnrichment: false,
    shouldEnrich: (f: { classification: { isGenerated: boolean; isDocumentation: boolean } }) =>
      f.classification.isGenerated ? "none" : f.classification.isDocumentation ? "file-only" : "full",
  } as unknown as EnrichmentProvider;
  // build ChunkPhase with an executor whose runChunkBatch/buildChunkSignals ===
  // the spy; init one ctx for `provider`; drive onBatchProvider with ChunkItems
  // for `db/schema.rb` (generated), `README.md` (doc), `app/models/user.rb`.
  // ...existing-file setup...
  await Promise.allSettled(/* the run's chunkWork */);
  const enrichedRel = new Set(buildChunkSignals.mock.calls.flatMap((c) => [...c[1].keys()]));
  expect(enrichedRel.has("app/models/user.rb")).toBe(true);
  expect(enrichedRel.has("db/schema.rb")).toBe(false);
  expect(enrichedRel.has("README.md")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts -t "skips chunk-churn"`
Expected: FAIL — generated/doc files still reach `buildChunkSignals`.

- [ ] **Step 3: Add the policy filter and apply it in `runChunkSignals`**

In `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts`, import the helper:

```ts
import { enrichmentScope } from "./policy.js";
```

Add a private method next to `filterByIgnore` (≈ line 458):

```ts
  /**
   * Drop files whose provider scope is not "full" — both "none" and
   * "file-only" skip the expensive chunk-churn walk. Mirrors filterByIgnore
   * but keys off per-file enrichment policy instead of the ignore filter.
   */
  private filterByEnrichmentPolicy(
    map: Map<string, ChunkLookupEntry[]>,
    provider: ProviderContext["provider"],
    root: string,
  ): Map<string, ChunkLookupEntry[]> {
    const out = new Map<string, ChunkLookupEntry[]>();
    for (const [filePath, entries] of map) {
      const rel = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
      if (enrichmentScope(provider, rel) === "full") out.set(filePath, entries);
    }
    return out;
  }
```

At the top of `runChunkSignals` (≈ line 380), apply the filter before the empty-check and before the streaming-enriched marking so dropped files are never marked enriched:

```ts
  private async runChunkSignals(
    ctx: ProviderContext,
    state: ChunkPhaseState,
    coll: string,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    useSemaphore: boolean,
  ): Promise<boolean> {
    // Per-file policy: only "full"-scope files get the chunk-churn walk.
    chunkMap = this.filterByEnrichmentPolicy(chunkMap, ctx.provider, root);
    if (chunkMap.size === 0) return Promise.resolve(true);
    // ...unchanged below...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts`
Expected: PASS (new test + all existing chunk-phase tests).

- [ ] **Step 5: Full suite + type-check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, no coverage regression. (If a pre-commit coverage gate trips, delegate to the `coverage-expander` subagent per `.claude/rules` — do not hand-chase lines.)

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts
git commit -m "feat(ingest): skip chunk-churn for non-full enrichment scope"
```

---

## Self-Review

**Spec coverage:**
- New axis (index but skip enrich) → Tasks 7 (file) + 8 (chunk). ✓
- Layered classification (isDocumentation + patterns + content-marker) → Task 2 (`classify`) + Task 6 (isDocumentation derivation). ✓
- Facts in infra, policy in provider → Task 2 (infra) + Task 1/4/5 (`shouldEnrich`). ✓
- Per-category depth (generated→none, docs→file-only) → Task 4 (git policy). ✓
- codegraph adopts the contract + dedup → Task 3 (dedup) + Task 5 (`shouldEnrich`). ✓
- Domain boundary (infra ⊥ contracts) → Task 1 note + Task 2 structural local type. ✓
- Env override `TEA_RAGS_GENERATED_PATTERNS` → Task 2 `USER_GENERATED_PATTERNS`. ✓
- `migrations` NOT in generated → not added to `GENERATED_PATTERNS` (Task 2). ✓
- Backward-compat (optional `shouldEnrich`) → Task 1 + Task 6 default `"full"`. ✓

**Type consistency:** `EnrichmentScope`, `FileClassification`, `shouldEnrich({relPath, classification})`, `classify(relPath, opts)`, `enrichmentScope(provider, relPath, contentHead?)`, `filterByEnrichmentPolicy(map, provider, root)` are used identically across tasks.

**Open follow-ups (out of scope, not blocking):**
- Reindex impact: files newly classified generated/doc lose git chunk signals on next index; on existing collections a `force_reindex` may be needed to drop stale chunk signals (incremental only touches changed files). Validate live before merge.
- `contentHead` is not yet threaded into the chunk-phase filter (pattern + isDocumentation cover the common cases there); file-phase content-marker threading can be a follow-up if non-pattern generated files need file-level skipping.
