# Per-language test-file path patterns (substrate)

**Date:** 2026-06-20 **Task:** tea-rags-mcp substrate for byLanguage codegraph
metrics (`cnqrg`) **Consumed by (next):** per-code-language `resolveSuccessRate`
(`cnqrg`)

## Problem

Test/spec path patterns live as one flat list in
`infra/file-classification/patterns.ts` (`TEST_PATTERNS`), mixing
language-specific suffixes (`*_spec.rb`, `*.test.ts`, `*Test.java`) with
language-agnostic directory conventions (`**/test/**`, `**/spec/**`). The
upcoming per-code-language metric breakdown wants each language to OWN its test
conventions in `domains/language/<lang>`, so the breakdown and the classifier
agree on what "a test file in language X" means. `infra/` is foundation and MUST
NOT import `domains/` (domain-boundaries), so per-language patterns can't be
imported into the classifier directly.

## Decision

**Option A — capability + DI** (user-approved), mirroring the `infra/runtime.ts`
`setDebug()` composition-time configuration precedent.

- Per-language **file-suffix** patterns move to `domains/language/<lang>` (each
  language owns its conventions).
- Language-agnostic **directory** patterns (`**/test/**`, `**/tests/**`,
  `**/spec/**`, `**/__tests__/**`) stay as the foundation base in
  `infra/file-classification` — they are genuinely cross-language.
- A `domains/language` aggregator collects per-language suffixes.
- The composition root (`api/internal`) injects the aggregate into the infra
  classifier via `configureTestPatterns()` — no `infra → domains` import.

This avoids the parallel-data-path anti-pattern: the base (dirs) lives once in
infra; the per-language suffixes live once in each language; composition unions
them. No pattern is duplicated.

## Architecture

### 1. Per-language suffix patterns — `domains/language/<lang>`

Each native code language exposes a static `testFilePatterns: readonly string[]`
(picomatch/gitignore globs). Static — NOT on the per-context `LanguageProvider`
instance (which loads a grammar); a module-level export read without
instantiation.

| Language   | `testFilePatterns`                                                    |
| ---------- | --------------------------------------------------------------------- |
| typescript | `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `**/*.spec.tsx`      |
| javascript | `**/*.test.{js,jsx,mjs,cjs}`, `**/*.spec.{js,jsx,mjs,cjs}` (expanded) |
| python     | `**/test_*.py`, `**/*_test.py`, `**/conftest.py`                      |
| ruby       | `**/*_test.rb`, `**/*_spec.rb`                                        |
| java       | `**/*Test.java`, `**/*Tests.java`, `**/*IT.java`                      |
| go         | `**/*_test.go`                                                        |
| rust       | `**/*_test.rs`                                                        |
| bash       | (none — no test-file convention)                                      |
| markdown   | (none — doc language)                                                 |

### 2. Aggregator — `domains/language/test-patterns.ts`

```ts
export function collectLanguageTestPatterns(): readonly string[];
// union of every native language's testFilePatterns (deduped), stable order.
```

Lives in `domains/language` (leaf domain, imports only contracts/infra). Sourced
from the same per-language modules the factory builds, but read statically.

### 3. Foundation base + DI setter — `infra/file-classification`

```ts
// patterns.ts — TEST_PATTERNS narrows to the language-agnostic DIRECTORY globs:
export const TEST_DIR_PATTERNS = [
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/spec/**",
];

// classify.ts — composition-time configuration, mirrors setDebug():
export function configureTestPatterns(extra: readonly string[]): void;
// getTestFilter() builds its matcher from TEST_DIR_PATTERNS ∪ configured-extra.
```

Default (un-configured, e.g. a unit test that doesn't run composition) = the
directory base only. After composition injects the per-language suffixes, the
full set is active — equal to today's `TEST_PATTERNS`.

### 4. Composition wiring — `api/internal/composition.ts`

```ts
configureTestPatterns(collectLanguageTestPatterns());
```

Called once during composition, before any indexing/enrichment runs.

## Data flow

```
domains/language/<lang>.testFilePatterns
  → collectLanguageTestPatterns()                    (domains/language)
  → configureTestPatterns(...)                        (api/internal composition)
  → getTestFilter() = TEST_DIR_PATTERNS ∪ extra       (infra/file-classification)
  → classifyFile(relPath).isTest                       (every consumer, unchanged)
```

## Backward-compatibility invariant

`TEST_DIR_PATTERNS ∪ collectLanguageTestPatterns()` MUST equal today's
`TEST_PATTERNS` set exactly (no test-file shape dropped, none added). A unit
test asserts set-equality so the relocation is provably lossless.

## Error handling / edge cases

- `configureTestPatterns` is idempotent (last call wins); calling it twice with
  the same aggregate is a no-op in effect.
- Un-configured contexts fall back to the directory base — never throws.
- `bash`/`markdown` contribute nothing (empty arrays) — no special-casing.

## Testing strategy

- Per-language: each `<lang>` module exposes the expected `testFilePatterns`.
- Aggregator: `collectLanguageTestPatterns()` dedupes + covers every code lang.
- **Lossless invariant**:
  `new Set([...TEST_DIR_PATTERNS, ...collectLanguageTestPatterns()])`
  deep-equals the pre-change `TEST_PATTERNS` set.
- Classifier: with the aggregate configured, `classifyFile` matches the same
  files as before (ruby `_spec.rb`, ts `.test.ts`, etc.); with only the base,
  directory matches still hold.
- Composition: `configureTestPatterns` is invoked (the wired path classifies a
  `*_spec.rb` as test).

## Out of scope

- byLanguage `resolveSuccessRate` metric + `cg_run_stats` language column (task
  `cnqrg`, Phase 2 — this substrate is its prerequisite).
- Generated-file patterns (`GENERATED_PATTERNS`) — same centralized shape kept
  for now; per-language relocation is a separate follow-up if wanted.
- Per-language test-DSL chunking (`test-dsl-filter.ts`, `rspec-scope-chunker`) —
  unrelated (chunking, not path classification).
