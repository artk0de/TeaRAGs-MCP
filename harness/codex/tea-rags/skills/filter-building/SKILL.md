---
name: filter-building
description:
  "Internal step invoked by $analytics-rerank, $bug-hunt. Build tea-rags filter
  beyond `pathPattern`."
---

# Filter Building

Two ways to constrain a tea-rags search beyond `query` + `pathPattern`. Pick the
right mechanism — they compose.

**Scope only — rerank is not here.** Request names weights, a preset, or "custom
rerank" ("rank by high bugFix + ownership") → invoke `$analytics-rerank` for the
`rerank` value. This skill builds the scope (`pathPattern`, typed sugar) in
parallel: every scope word (area, time, author, test/doc) still becomes its
typed field in the same call — the rerank value never replaces one. Never
compose `rerank: { custom: … }` here.

**Raw filter → read syntax FIRST.** Before writing any raw `filter` object (even
one range) → read `tea-rags://guide/filters` (MCP resource read), unless its
`# Qdrant Filter Syntax` is already in context. Never from memory.

## Implicit signals — when a filter is needed but the user didn't say "filter"

Triggers in agent reasoning chain. If thinking any of these BEFORE composing a
tea-rags search, this skill applies — translate the SCOPE into typed sugar:

| User said... (paraphrased)                            | Filter to add                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| "in the X domain / module / area / pipeline"          | `pathPattern: "**/X/**"` — always, beside rerank                         |
| "tests of X" / "tests for <Class>" (even a class)     | `hybrid_search` + `testFile: "only"`; no symbolId, never semantic_search |
| "production code for X" / "actual implementation"     | `testFile: "exclude"`                                                    |
| "Ruby / TypeScript / Python code"                     | `language: "<lang>"` (NOT pathPattern `**/*.rb`)                         |
| "modified recently" / "changed this week"             | `semantic_search` + `modifiedAfter: <ISO>` (no `level`)                  |
| "old code" / "legacy" / "untouched for a while"       | `modifiedBefore: <ISO>` (no `level` needed)                              |
| "what's new" / "fresh additions" / "sprint review"    | `semantic_search` + `modifiedAfter: <ISO>` (no `level`)                  |
| "<person>'s code" (lines they own)                    | `author: "<exact git name>"`                                             |
| "what did <person> work on" / recent work             | `recentAuthor: "<exact git name>"` + `modifiedAfter`                     |
| "everything <person> touched" / files committed to    | `contributor: "<exact git name>"`                                        |
| "related to ticket JIRA-X" / "for issue #N"           | `taskId: "JIRA-X"`                                                       |
| "drop one-off scripts" / "real code, not snippets"    | `minCommitCount: 5`+                                                     |
| "docs about X" / "what's documented"                  | `documentation: "only"`                                                  |
| "code, not docs"                                      | `documentation: "exclude"`                                               |
| "<Class> class itself" (prod code, ask has no "test") | `symbolId: "<Class>"` OR `hybrid_search`                                 |
| "in /full/abs/path/" (subagent context)               | `pathPattern: "<path from project root>/**"`                             |
| "exclude vendor / generated / migrations"             | `pathPattern: "!**/vendor/**"` (no typed sugar)                          |

**Person name (`author` / `recentAuthor` / `contributor`) — exact match only.**
User gives a short or first name (no surname, as typed in chat) → resolve it
before the filtered call: call 1 =
`rank_chunks(rerank="ownership", pathPattern=<scope>, metaOnly=true)`, read the
full spelling from `git.file.recentAuthors` / `git.file.blameAuthors`; call 2
carries it. Plan line, copied:
`<author|recentAuthor|contributor>: "<exact git name of <short name>, from call 1>"`.
Passing the short name as typed = silent empty result.

**Rule of thumb:** user almost never says "filter". They name a SCOPE — domain,
language, author, time window, ticket, prod-vs-test. Translate the scope into
the right typed sugar; never leave it ambient ("query alone will sort it out").
An unfiltered `semantic_search` over a broad project returns results dominated
by the highest-churn domain — the rest is invisible.

## Typed filters (fast path)

Typed params on every search request (tool schema; semantics:
`tea-rags://guide/overview` `### Typed filters`). Prefer over raw `filter:`
whenever a typed field expresses constraint — intent-clear, schema-checked,
survives directory moves. Fields, presets, thresholds, raw syntax:

No `# Qdrant Filter Syntax` above → read `tea-rags://guide/filters`
(read_mcp_resource) before composing.

## Test filter levels (file vs chunk granularity)

Two test-related filters address different granularity. They compose freely.

| Need                                                     | Filter combo                             |
| -------------------------------------------------------- | ---------------------------------------- |
| Any chunk from test files (helpers, imports, DSL chunks) | `testFile: "only"`                       |
| Only leaf-scope DSL test scenarios                       | `chunkType: "test"`                      |
| Only DSL fixture / setup chunks                          | `chunkType: "test_setup"`                |
| Strict DSL leaves in test files only (defense-in-depth)  | `testFile: "only"` + `chunkType: "test"` |
| Production code, not tests                               | `testFile: "exclude"`                    |

**`chunkType: "test"` and `chunkType: "test_setup"` require AST test chunking.**
Currently supported:

| Language   | Frameworks                 | Granularity | Chunker                                                               |
| ---------- | -------------------------- | ----------- | --------------------------------------------------------------------- |
| TypeScript | Vitest, Jest, Mocha        | scope       | `src/core/domains/language/typescript/chunking/test-scope-chunker.ts` |
| JavaScript | Vitest, Jest, Mocha        | scope       | `src/core/domains/language/javascript/chunking/test-scope-chunker.ts` |
| Ruby       | RSpec                      | scope       | `src/core/domains/language/ruby/chunking/rspec-scope-chunker.ts`      |
| Swift      | XCTest, swift-testing      | test case   | `src/core/domains/language/swift/chunking/suite-recognition.ts`       |
| Swift      | Quick / Nimble             | scope       | `src/core/domains/language/swift/chunking/quick-scope-chunker.ts`     |
| Rust       | `#[cfg(test)]` / `#[test]` | test case   | `src/core/domains/language/rust/chunking/test-scope-chunker.ts`       |

Granularity `scope` = one chunk per describe/context with ancestor setup spliced
in. `test case` = one chunk per method (XCTest and swift-testing declare cases
as methods, not DSL calls); their fixtures / `setUp` / helpers → `test_setup`.
Swift is BOTH rows: which one a file gets follows its framework, and a Quick
suite's non-DSL members land in one `test_setup` chunk named after the class.

For Python / Go / others, file-level `testFile: "only"` is the only option. Full
per-language support: `tea-rags://guide/language-capability` (GENERATED — never
restate it here). Test chunks absent if no `git.chunk.*` row of
`tea-rags://project/<alias>/metrics?section=thresholds` has a `test ≥` value.
Recipes depending on test chunks, see `$tests-as-context` (Step 0 preflight
handles this automatically). New language added → update this table in lock-step
with the matching block in `$tests-as-context` and `test-driven-development` —
see `.claude/rules/test-spec-chunking.md`.

## Filter level vs result granularity

`level` does TWO things at once — set it for one, get both.

1. **Scope of level-aware typed filters.** No effective level → each filter's
   OWN default: `minAgeDays`, `maxAgeDays`, `minCommitCount` → `git.chunk.*`;
   `taskId`, `author`, codegraph `minFanIn` / `minFanOut` → file. Effective
   level set → every level-aware filter follows it.
   - `modifiedAfter` / `modifiedBefore` → ALWAYS `git.file.lastModifiedAt`,
     `recentAuthor` → ALWAYS `git.file.recentDominantAuthor*`, `contributor` →
     ALWAYS `git.file.recentAuthors`, any `level`. Never need `level: "file"`.
2. **Result granularity.** `level: "file"` → one result per file (file-level
   payload only — no chunk fields, no content; outline it via
   `find_symbol(relativePath)`), git signals blended at file level only.
   `"chunk"` or none → individual chunks.

Effective level = explicit `level`, else rerank preset `signalLevel` (e.g.
`ownership`, `proven` = file), else none. `search_code` has no `level` param —
only its preset sets it.

**NEVER set `level: "file"` just to make a time filter file-level** → unwanted
file-grouped results. Pick time filter by intent:

| Intent                                        | Use                                           | Reads                                    |
| --------------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| File changed since date (sprint, "this week") | `modifiedAfter: <ISO>`                        | file last-commit time, any level         |
| File untouched since date (old / legacy code) | `modifiedBefore: <ISO>`                       | file last-commit time, any level         |
| Old / fresh FILES as file list                | `minAgeDays` / `maxAgeDays` + `level: "file"` | file last-commit time, one result / file |
| Chunks whose OWN lines changed in last N days | `maxAgeDays: <N>` (default chunk)             | chunk last-commit time                   |

Age filters compute age at QUERY time from last-commit timestamp — no drift;
`maxAgeDays: 0` = last commit within a day.

**Chunk age caveat.** Chunk last-commit time exists only where chunk churn walk
attributed a commit inside its window (`TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS`,
default 6); `0` / absent on every doc chunk + chunks untouched in window → chunk
age filters drop them. Chunk-level `minAgeDays` never finds code older than
window → old code: `modifiedBefore` or `level: "file"`.

**Reading overlay `ageDays`.** Payload stamp: whole days, floored, at ENRICHMENT
time. `0` = last commit < 1 day before enrichment = freshest, not "no data" (no
data = key absent). Point not re-enriched keeps old stamp → overlay value, `age`
/ `recency` rerank and `ageDays` filter presets (`freshLegacyEdits`,
`battleTested`, `abandonedHotspots`) can lag; typed age filters and
`modifiedAfter` / `modifiedBefore` do not.

## Sugar filter pairing examples

| Sugar field                        | Resolves to                                                              | Pair with                                           |
| ---------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `minAgeDays` / `maxAgeDays`        | `git.<effective level>.lastModifiedAt` vs query-time now (chunk default) | `level: "file"` only for a file list                |
| `minCommitCount`                   | `git.<effective level>.commitCount` (chunk default)                      | drop one-off scripts                                |
| `modifiedAfter` / `modifiedBefore` | `git.file.lastModifiedAt` range, at any level                            | nothing — no `level` needed                         |
| `author`                           | `git.<effective level>.blameDominantAuthor` (file default)               | exact blame NAME, not email                         |
| `recentAuthor`                     | `git.file.recentDominantAuthor` OR `…Email`, at any level                | `modifiedAfter` — "what did X work on"              |
| `contributor`                      | `git.file.recentAuthors` match.any, at any level                         | superset of `recentAuthor` — "everything X touched" |
| `taskId`                           | `git.<effective level>.taskIds` (file default)                           | `level: "chunk"` for chunk's own commits            |
| `testFile`                         | `"only" \| "exclude" \| "include"`                                       | scope to prod vs test                               |
| `documentation`                    | `"only" \| "exclude" \| "include"`                                       | scope to docs vs code                               |
| `fileExtension`                    | one or more extensions                                                   | language-adjacent constraints                       |
| `language`                         | one language                                                             | polyglot scoping                                    |

Concrete payload examples:

```jsonc
// Ruby test FILES modified after 2026-01-01, ≥5 file commits. modifiedAfter
// needs no level; level "file" = minCommitCount on git.file.commitCount +
// one result per file:
{
  "query": "user signup",
  "language": "ruby",
  "testFile": "only",
  "modifiedAfter": "2026-01-01",
  "level": "file",
  "minCommitCount": 5
}

// Code linked to a Jira ticket, author-scoped. `author` = exact blame-owner
// NAME (git blame author name, not email); taskId + author both file-level by
// default, so no `level` needed:
{
  "query": "retry logic",
  "taskId": "JIRA-1234",
  "author": "Alice Smith"
}
```

## pathPattern Rules

`pathPattern` is for arbitrary directory globs where no typed filter applies.
Compose with typed filters (e.g. `language: "ruby"` +
`pathPattern: "**/services/**"`).

Matched exactly (picomatch) against project-relative `relativePath`.

- GOOD: `**/<dir>/**` (directory at any depth)
- GOOD: `{app/services/foo.rb,app/models/bar.rb}` (exact relativePaths from
  results)
- GOOD: `**/{file1.rb,file2.rb}` (bare file names, any directory)
- GOOD: `!**/test/**` (picomatch negation — exclude a directory subtree)
- GOOD: `!**/vendor/**` (exclude non-test dirs that have no typed sugar)
- BAD: `{file1.rb,file2.rb}`, `services/**` (no `**/` → project root only)
- BAD: `/full/abs/path/**` (absolute path — never matches; strip project root)

**When to prefer negation over typed sugar.** Use `testFile: "exclude"` for test
exclusion — intent-clear, survives test-directory renames. Use `!**/dir/**` only
for directories that have no typed sugar (`vendor`, `generated`, `migrations`).

## Typed filter vs `pathPattern`

For `language`, `documentation`, `testFile` — **use the typed filter, not a
pathPattern**. The typed filter is intent-clear, schema-checked, survives
directory restructures. `pathPattern` is for arbitrary directory globs. Compose
freely.

## Named filter presets (`{presets}` shorthand)

`filter: { presets: "a,b" }` — catalog, gating, inventory-vs-query rule: guide
above (`## Named filter presets`). Mutually exclusive with raw filter; typed
params AND-compose with it.

### Examples

```jsonc
// Inventory: all production-code files in the fragileSilo bucket
{
  "query": "",
  "filter": { "presets": "coreLogic,fragileSilo" },
  "metaOnly": true
}

// Ask names dir words ("<a>/<b> paths") → pathPattern, NO securityPaths
{
  "query": "<topic>",
  "pathPattern": "**/{<a>,<b>}/**",
  "rerank": "securityAudit"
}

// Ask names NO dir word ("security-sensitive code") → securityPaths preset
{
  "query": "<topic>",
  "language": "<lang>",
  "filter": { "presets": "securityPaths" },
  "rerank": "securityAudit"
}
```

## Raw `filter` param (escape hatch)

Use only when typed filters cannot express the constraint: custom payload key,
OR-of-conditions across different fields, range on a non-typed numeric field.

```jsonc
{
  "filter": {
    "must": [{ "key": "git.file.bugFixRate", "range": { "gte": 30 } }],
    "should": [
      { "key": "language", "match": { "value": "ruby" } },
      { "key": "language", "match": { "value": "typescript" } },
    ],
    "must_not": [
      { "key": "git.file.blameContributorCount", "range": { "lt": 2 } },
    ],
  },
}
```

Exact syntax + payload keys: `tea-rags://guide/filters`, read before this object
is written — never invent syntax or key names.

### Codegraph filters (only when codegraph is active)

Typed params only — raw `codegraph.*` keys do not resolve (nested payload path).
Exposed only when graph tools registered. Examples:

```jsonc
// Architectural hubs — high-fan-in backbone files
{ "isHub": true }

// High blast radius — many incoming call/import edges
{ "minFanIn": 10 }

// Efferent-coupling sources (instability near 1 = depends on many)
{ "minInstability": 0.8 }
```

`fanIn` / `isHub` are the edge-truth replacements for the `git`/`imports` proxy.
When codegraph is off, filter on `imports` instead and treat it as approximate.

## Stratified scanning (excluding a dominant domain)

Common analytics pattern: an unfiltered scan of a broad project returns results
dominated by the highest-churn domain. To surface the rest, run a SECOND scan
with the dominant domain negated:

```jsonc
// Pass 1: full project, no pathPattern → identifies dominant domain <dir>
// Pass 2: same query, pathPattern: "!**/<dir>/**"
//         → surfaces risk zones in the rest of the codebase
```

Same mechanism `$risk-assessment` uses for domain-stratified scanning, but apply
it manually whenever a single scan is dominated by one directory.

## Composition rules

- Typed filter + typed filter: AND across both fields (e.g. `language: "ruby"`
  AND `testFile: "exclude"`).
- Typed filter + `pathPattern`: AND across both.
- Typed filter + raw `filter`: AND across both — raw `filter` adds its
  must/should/must_not on top of the typed constraints.
- Typed filter + `{presets}`: AND across both — named presets AND-compose with
  all typed params (`language`, `minAgeDays`, `author`, etc.).
- `{presets}` vs raw `filter`: **mutually exclusive** — discriminated union;
  pass one form or the other in a single call, never both.
- `level` re-scopes only level-aware typed fields (`minAgeDays`, `maxAgeDays`,
  `minCommitCount`, `taskId`, `author`, `minFanIn`, `minFanOut`);
  `modifiedAfter` / `modifiedBefore` stay on `git.file.lastModifiedAt`,
  `recentAuthor` / `contributor` on `git.file.*`. Raw `filter` names own payload
  path (`git.file.*` vs `git.chunk.*`), ignores `level`.
- File-level age at chunk granularity → `modifiedAfter` / `modifiedBefore`
  (absolute date vs `git.file.lastModifiedAt`, any level). NEVER a raw range on
  `git.file.ageDays` — enrichment-time stamp, lags (Reading overlay `ageDays`).
  `minAgeDays` / `maxAgeDays` also compare at query time, but are level-aware:
  chunk age by default, file age only at effective level `file` — explicit
  `level: "file"` regroups results into files.

## When this skill does NOT apply

- Picking a rerank preset (techDebt vs hotspots vs ownership) → use
  `$analytics-rerank`.
- Generic project exploration → use `$explore`.
- Investigating a specific bug → use `$bug-hunt`.
- Multi-dimensional risk scan over a domain → use `$risk-assessment`.

For composing the filter shape itself — payload keys, operators, level — stay
here.
