# Scanner Default-Ignore for Data Formats (json / yaml / yml)

- **Date:** 2026-06-26
- **Status:** Design — approved for spec review
- **Bead:** `tea-rags-mcp-dygln` — derived from octokit full-index reproduction;
  relates to `tea-rags-mcp-kgjzq` (separate) and `tea-rags-mcp-0wwb6`
  (separate).
- **Scope:** `src/core/domains/ingest/pipeline/ignore-defaults.ts` (+ its
  scanner consumer and tests). One file of production change.

## Summary

tea-rags is a **code** RAG. Data/serialization files (JSON fixtures, VCR
cassettes, YAML config) are not code and pollute a code index: they inflate it
with noise, waste embeddings, and under volume destabilize the run. Add
`*.json`, `*.yaml`, `*.yml` to the scanner's `BUILTIN_IGNORE_PATTERNS`, with a
built-in allowlist (negations) that keeps signal-bearing JSON manifests
(`package.json`, `tsconfig.json`, `*.config.json`, …). YAML is ignored with no
allowlist.

## Problem (measured, not assumed)

Reproduced by removing `.contextignore` from `octokit.rb` and running a full
index (worktree CLI, 2026-06-26):

| Index                       | Files (post-scan) | Chunks          | Exit                                              |
| --------------------------- | ----------------- | --------------- | ------------------------------------------------- |
| `.rb`-only (the workaround) | 159               | 1510            | 0, clean                                          |
| Full (no `.contextignore`)  | **893** (922→893) | **3078 (2.0×)** | **exit 1** (run A); stalled in enrichment (run B) |

- octokit ships **714 JSON** VCR cassettes + **11 YAML**. They are not source;
  they character-fallback-chunk into ~1568 noise chunks — a **2× index** of pure
  recorded-HTTP-response data.
- **Binaries are already handled**: of 922 files, 29 (png/pem/pub/ghp/ghl/netrc)
  are filtered by existing `BUILTIN_IGNORE_PATTERNS` + secrets detection —
  proven by a 7-file min-set index that admitted only the 1 `.rb`. The gap is
  **json / yaml**, which currently pass straight through to chunk + embed.
- The failure is **volume-driven and intermittent** (run A exit 1, run B reached
  enrichment), matching the documented `tree-sitter` process-global
  thread-unsafety (`yl9tv`): more files → more concurrent parses → higher native
  crash probability. It is **not a single poison-pill file** — every `.rb`
  parses cleanly (`hasError=0` across all 159, verified with the real grammar).
  The problem is **categorical**: data formats do not belong in a code index.

## Goals

1. Keep JSON/YAML data (fixtures, cassettes, CI/config) out of the index **by
   default**, at scan time (prevention, before chunk/embed).
2. Preserve signal-bearing JSON **manifests** that agents legitimately search
   (dependency/build config).
3. No regression to existing default-ignores or directory traversal.
4. Users can override both directions via their own `.contextignore`.

## Non-Goals

- **`tea-rags-mcp-kgjzq`** (whitelist `.contextignore` `*` + `!*.rb` → 0 files).
  Independent bug — see "Why kgjzq is NOT a prerequisite" below.
- **`tea-rags-mcp-0wwb6`** (throw-gated quarantine misses error-recovered parses
  of _supported_ source). Separate subsystem (chunker/quarantine); real-as-code
  but did not manifest on octokit. Stays its own bead.
- Hardening the pipeline against the intermittent `yl9tv` crash itself. Removing
  the json/yaml volume removes the trigger; the underlying concurrency hardening
  is tracked separately.
- Other formats (`.txt`, `.sql`, `.md`). Markdown is docs (useful context) and
  stays. `.txt`/`.sql` out of scope for this change.

## Design

### 1. Patterns added to `BUILTIN_IGNORE_PATTERNS`

`ignore-defaults.ts` is a flat `string[]` consumed by `FileScanner`
(`loadIgnorePatterns` adds it first, then project ignore files, into a single
`ignore()` instance — last-match-wins). Append a new "Data / serialization
formats" block:

```ts
// Data / serialization formats (not code — fixtures, cassettes, CI/config).
// A code RAG should not embed recorded HTTP responses or config blobs.
"*.json",
"*.yaml",
"*.yml",
// …but keep signal-bearing JSON manifests (deps / build config).
"!package.json",
"!tsconfig.json",
"!tsconfig.*.json",
"!*.config.json",
"!composer.json",
"!deno.json",
```

- **JSON**: ignore all, re-include the manifest allowlist.
- **YAML**: ignore all, **no allowlist** (per decision — yaml in a code repo is
  config/CI/data; users re-include via `.contextignore` if they want it).

### 2. Allowlist rationale

| Kept manifest                       | Why                                             |
| ----------------------------------- | ----------------------------------------------- |
| `package.json`                      | deps, scripts, project name — high search value |
| `tsconfig.json` + `tsconfig.*.json` | TS build/path config                            |
| `*.config.json`                     | vitest/jest/eslint/etc. config                  |
| `composer.json`                     | PHP deps                                        |
| `deno.json`                         | Deno deps/config                                |

Negations match at **any depth** (`packages/foo/package.json` is kept). A
fixture literally named `package.json` would also be kept — accepted
(vanishingly rare, and harmless).

### 3. Mechanics — validated, no kgjzq dependency

Confirmed against the real `ignore` package (2026-06-26):

```
keep   package.json / tsconfig.json / vitest.config.json / jest.config.json
keep   packages/foo/package.json            (nested manifest)
keep   lib/octokit.rb
IGNORE spec/cassettes/x.json / .github/workflows/ci.yml / config/database.yml / openapi.yaml
dir spec / spec/cassettes / lib / .github  →  ignored? false   (traversal NOT blocked)
```

**Why kgjzq is NOT a prerequisite.** kgjzq is the _whitelist_ form (`*` +
`!*/` + `!*.rb`): the catch-all `*` makes `FileScanner.walkDirectory` see
`ig.ignores("lib") === true` and skip the directory before descending, so the
`!*.rb` re-include is never reached (`!*/` does not match the
trailing-slash-less dir path). Our change is the _blacklist-with-exceptions_
form: `*.json` matches **files**, not directories, so
`ig.ignores("spec") === false` → traversal proceeds → `!package.json`
re-includes normally. The two negation scenarios are independent; this ships
standalone.

### 4. User override (both directions)

- **Re-include** dropped data (e.g. a project that indexes k8s yaml):
  `!**/*.yml` or `!openapi.yaml` in `.contextignore` — later add wins.
- **Drop** a kept manifest (e.g. a huge generated `package.json`):
  `package.json` in `.contextignore` re-ignores it.

## Edge Cases & Risks

| Case                                                              | Outcome / mitigation                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project legitimately indexes config yaml/json                     | Opt back in via `.contextignore` `!pattern` (documented)                                                                                                                                                                       |
| Fixture named `package.json`                                      | Kept (false-keep) — rare, harmless                                                                                                                                                                                             |
| Existing indexes already containing json/yaml chunks              | Cleared on next **reindex**: scanner stops returning them → deletion-detection drops them. No schema-drift; an incremental reindex over an unchanged tree will treat them as removed paths. Document "reindex to take effect". |
| `*.config.json` over-broad (keeps app data named `x.config.json`) | Acceptable; manifest-shaped names are intentional signal                                                                                                                                                                       |

## Testing (TDD)

Unit tests on the scanner / patterns — the validation matrix above is the test
spec. Add to the scanner test suite:

1. `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.json`,
   `composer.json`, nested `packages/a/package.json` → **scanned (kept)**.
2. `spec/cassettes/x.json`, `fixtures/y.json`, `.github/workflows/ci.yml`,
   `config/database.yml`, `openapi.yaml` → **ignored**.
3. A `.rb`/`.ts` source file alongside them → still scanned (no collateral).
4. Directory traversal: a `spec/` dir containing only json is still
   **descended** (regression guard for the kgjzq-vs-allowlist distinction).
5. User-override: a `.contextignore` with `!openapi.yaml` re-includes it; one
   with `package.json` drops it.

Per `.claude/rules/test-patterns.md` — high-level scanner-behavior tests, not
per-line. No existing passing test rewritten.

## Affected Files

| File                                                           | Change                         |
| -------------------------------------------------------------- | ------------------------------ |
| `src/core/domains/ingest/pipeline/ignore-defaults.ts`          | +data-format block + allowlist |
| `tests/core/domains/ingest/pipeline/scanner.test.ts` (or peer) | +behavior tests above          |
| `CHANGELOG` / docs note (reindex-to-take-effect)               | user-facing note               |

## Rollout

- `improve(ingest)`. **Treat as BREAKING(ingest)**: the default indexing surface
  shrinks — a project that previously indexed its json/yaml will silently stop
  doing so. Per `commit-rules.md` ("any change that requires user action"),
  users who relied on indexed json/yaml must opt back in via `.contextignore`
  `!pattern`. Add a `BREAKING CHANGE:` footer documenting the negation escape
  hatch; call it out in the changelog.
- Takes effect on next reindex per project (no schema-drift; deletion-detection
  drops the now-unscanned json/yaml chunks).
