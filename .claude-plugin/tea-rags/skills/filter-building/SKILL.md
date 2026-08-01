---
name: filter-building
description:
  Construct tea-rags filter beyond `pathPattern`. Invoke whenever agent
  reasoning before a tea-rags search includes a SCOPE — domain, language,
  author, time window, ticket, prod-vs-test split, or directory exclusion.
  User almost never says "filter"; names the scope ("in the X domain", "Ruby
  code", "Alice's work", "modified this week", "for ticket RAGS-142",
  "production code"). Translate every scope into correct typed sugar field
  (`language`, `testFile`, `documentation`, `author`, `taskId`, `minAgeDays` /
  `maxAgeDays`, `minCommitCount`, `modifiedAfter` / `modifiedBefore`,
  `fileExtension`, `chunkType`, `symbolId`), the `level: "file" | "chunk"`
  switch (mandatory for time-based fields), picomatch negation in `pathPattern`
  (`!**/test/**`), or raw `filter` escape hatch (Qdrant
  `must`/`should`/`must_not`) for payload keys without typed sugar. Cases:
  "tests of AuthService" → implicit `testFile: "only"`; "Alice's recent code" →
  `author + modifiedAfter`; "old payments code" → `minAgeDays + level=file`;
  "what's new this week" → `modifiedAfter` + `level=file`; "production code, not
  tests" → `testFile: "exclude"`; "code linked to JIRA-1234" → `taskId`;
  "exclude vendor dir" → `pathPattern: "!**/vendor/**"`. NOT for picking a
  rerank preset — use `tea-rags:analytics-rerank`. NOT for general project
  exploration — use `tea-rags:explore`.
user-invocable: false
---

# Filter Building

Two ways to constrain a tea-rags search beyond `query` + `pathPattern`. Pick the
right mechanism — they compose.

## Implicit signals — when a filter is needed but the user didn't say "filter"

Triggers in agent reasoning chain. If thinking any of these BEFORE composing a
tea-rags search, this skill applies — translate the SCOPE into typed sugar:

| User said... (paraphrased)                         | Filter to add                                    |
| -------------------------------------------------- | ------------------------------------------------ |
| "in the X domain / module / area"                  | `pathPattern: "**/X/**"`                         |
| "tests of X" / "test coverage of X"                | `testFile: "only"` (+ symbolId or query)         |
| "production code for X" / "actual implementation"  | `testFile: "exclude"`                            |
| "Ruby / TypeScript / Python code"                  | `language: "<lang>"` (NOT pathPattern `**/*.rb`) |
| "modified recently" / "changed this week"          | `modifiedAfter: <ISO>` + `level: "file"`         |
| "old code" / "legacy" / "untouched for a while"    | `minAgeDays: <N>` + `level: "file"`              |
| "what's new" / "fresh additions" / "sprint review" | `modifiedAfter: <ISO>` + `level: "file"`         |
| "who's been working on X" / "Alice's code"         | `author: "Alice"` (blame-dominant)               |
| "related to ticket JIRA-X" / "for issue #N"        | `taskId: "JIRA-X"`                               |
| "drop one-off scripts" / "real code, not snippets" | `minCommitCount: 5`+                             |
| "docs about X" / "what's documented"               | `documentation: "only"`                          |
| "code, not docs"                                   | `documentation: "exclude"`                       |
| "AuthService class" (specific class)               | `symbolId: "AuthService"` OR `hybrid_search`     |
| "in /full/abs/path/" (subagent context)            | `pathPattern: "/full/abs/path/**"`               |
| "exclude vendor / generated / migrations"          | `pathPattern: "!**/vendor/**"` (no typed sugar)  |

**Rule of thumb:** user almost never says "filter". They name a SCOPE — domain,
language, author, time window, ticket, prod-vs-test. Translate the scope into
the right typed sugar; never leave it ambient ("query alone will sort it out").
An unfiltered `semantic_search` over a broad project returns results dominated
by the highest-churn domain — the rest is invisible.

## Typed filters (fast path)

Top-level params on every search request. Prefer over raw `filter:` whenever a
typed field expresses the constraint — intent-clear, schema-checked, survives
directory restructures.

| Field            | Values / type                          | When to use                             |
| ---------------- | -------------------------------------- | --------------------------------------- |
| `language`       | string (e.g. `"ruby"`, `"typescript"`) | scope to one language layer             |
| `fileExtension`  | string \| string[]                     | constrain by file extension(s)          |
| `chunkType`      | string (e.g. `"method"`, `"class"`)    | only chunks of this type                |
| `documentation`  | `"only" \| "exclude" \| "include"`     | docs vs code (string enum, not boolean) |
| `testFile`       | `"only" \| "exclude" \| "include"`     | tests vs production (string enum)       |
| `symbolId`       | string                                 | scope to one symbol                     |
| `author`         | string                                 | files where this author dominates blame |
| `modifiedAfter`  | ISO date string \| Date                | recent changes                          |
| `modifiedBefore` | ISO date string \| Date                | exclude recent changes                  |
| `minAgeDays`     | number                                 | min file age (use `level: "file"`)      |
| `maxAgeDays`     | number                                 | max file age (use `level: "file"`)      |
| `minCommitCount` | number                                 | drop one-off scripts                    |
| `taskId`         | string (e.g. `"RAGS-142"`)             | code linked to a ticket via git.taskIds |

## Test filter levels (file vs chunk granularity)

Two test-related filters address different granularity. They compose freely.

| Need                                                     | Filter combo                             |
| -------------------------------------------------------- | ---------------------------------------- |
| Any chunk from test files (helpers, imports, DSL chunks) | `testFile: "only"`                       |
| Only leaf-scope DSL test scenarios                       | `chunkType: "test"`                      |
| Only DSL fixture / setup chunks                          | `chunkType: "test_setup"`                |
| Strict DSL leaves in test files only (defense-in-depth)  | `testFile: "only"` + `chunkType: "test"` |
| Production code, not tests                               | `testFile: "exclude"`                    |

**`chunkType: "test"` and `chunkType: "test_setup"` require DSL test chunking.**
Currently supported:

| Language   | Frameworks          | Hook file                                                                         |
| ---------- | ------------------- | --------------------------------------------------------------------------------- |
| TypeScript | Vitest, Jest, Mocha | `src/core/domains/ingest/pipeline/chunker/hooks/typescript/test-scope-chunker.ts` |
| Ruby       | RSpec               | `src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`      |

For Python / Go / others, file-level `testFile: "only"` is the only option.
Detect availability via prime digest: DSL chunks absent if no `git.chunk.*`
signal shows a `test:` threshold row. Recipes depending on DSL chunks, see
`tea-rags:tests-as-context` (Step 0 preflight handles this automatically). New
language added → update this table in lock-step with the matching block in
`tea-rags:tests-as-context` and `dinopowers:test-driven-development` — see
`.claude/rules/test-spec-chunking.md`.

## Filter Level: file vs chunk

- **`level: "chunk"`** (default) — filters against `git.chunk.*` fields.
- **`level: "file"`** — filters against `git.file.*` fields.

**Warning:** At chunk level, `ageDays = 0` means "no git history for this
chunk", NOT "just created". For ALL time-based filters (`modifiedAfter`,
`modifiedBefore`, `minAgeDays`, `maxAgeDays`) — **use `level: "file"`**.
Otherwise the filter silently rejects every chunk whose git data is missing.

## Sugar filter pairing examples

| Sugar field                        | Resolves to                        | Pair with                     |
| ---------------------------------- | ---------------------------------- | ----------------------------- |
| `minAgeDays` / `maxAgeDays`        | `git.file.ageDays` range           | `level: "file"` (mandatory)   |
| `minCommitCount`                   | `git.file.commitCount` lower bound | drop one-off scripts          |
| `modifiedAfter` / `modifiedBefore` | `git.file.lastModifiedAt` range    | `level: "file"`               |
| `author`                           | blame-dominant author equals       | ownership analysis            |
| `taskId`                           | `git.file.taskIds` array contains  | trace code to a ticket        |
| `testFile`                         | `"only" \| "exclude" \| "include"` | scope to prod vs test         |
| `documentation`                    | `"only" \| "exclude" \| "include"` | scope to docs vs code         |
| `fileExtension`                    | one or more extensions             | language-adjacent constraints |
| `language`                         | one language                       | polyglot scoping              |

Concrete payload examples:

```jsonc
// Ruby tests modified after 2026-01-01, dropping one-off scripts:
{
  "query": "user signup",
  "language": "ruby",
  "testFile": "only",
  "modifiedAfter": "2026-01-01",
  "level": "file",
  "minCommitCount": 5
}

// Code linked to a Jira ticket, author-scoped:
{
  "query": "retry logic",
  "taskId": "JIRA-1234",
  "author": "alice@example.com",
  "level": "file"
}
```

## pathPattern Rules

`pathPattern` is for arbitrary directory globs where no typed filter applies.
Compose with typed filters (e.g. `language: "ruby"` +
`pathPattern: "**/services/**"`).

- GOOD: `**/enrichment/**` (directory prefix)
- GOOD: `{file1.rb,file2.rb}` (flat file names, no slashes)
- GOOD: `!**/test/**` (picomatch negation — exclude a directory subtree)
- GOOD: `!**/vendor/**` (exclude non-test dirs that have no typed sugar)
- BAD: `{app/services/foo.rb,app/models/bar.rb}` (slashes inside braces — breaks
  picomatch)

**When to prefer negation over typed sugar.** Use `testFile: "exclude"` for test
exclusion — intent-clear, survives test-directory renames. Use `!**/dir/**` only
for directories that have no typed sugar (`vendor`, `generated`, `migrations`).

## Typed filter vs `pathPattern`

For `language`, `documentation`, `testFile` — **use the typed filter, not a
pathPattern**. The typed filter is intent-clear, schema-checked, survives
directory restructures. `pathPattern` is for arbitrary directory globs. Compose
freely.

## Named filter presets (`{presets}` shorthand)

Pass `filter: { presets: "name" }` (or CSV `"a,b,c"` for multiple) to apply a
named adaptive filter bundle instead of writing a raw Qdrant filter manually.
Thresholds are collection percentiles (e.g. p75 of `commitCount`) — they scale
per repository. Cold-start fallbacks apply when stats are unavailable.

**Mutually exclusive with raw filter.** `{ presets: "..." }` and a raw Qdrant
filter object are a discriminated union — pass one OR the other, not both in the
same call. Typed params (`language`, `minAgeDays`, `author`, etc.) AND-compose
freely with `{presets}`.

### Preset catalog (12 total)

**Static — always available:**

| Name            | What it isolates                                     |
| --------------- | ---------------------------------------------------- |
| `production`    | Excludes test/docs — hygiene, safe in any mode       |
| `coreLogic`     | Excludes test/docs/config — core logic only, hygiene |
| `securityPaths` | Path-risk signals (auth, crypto, secrets, etc.)      |

**Require git trajectory:**

| Name                | What it isolates                                           |
| ------------------- | ---------------------------------------------------------- |
| `freshLegacyEdits`  | Old code (high ageDays) recently modified                  |
| `fragileSilo`       | Single-author, low-churn, high bug-fix rate                |
| `panicZone`         | High churn + high bug-fix rate simultaneously              |
| `godMethods`        | Very high per-chunk import density (structural complexity) |
| `battleTested`      | High commit count + low bug-fix rate (stable + exercised)  |
| `abandonedHotspots` | High churn in the past, then quiet for a long time         |

**Require codegraph.symbols trajectory:**

| Name             | What it isolates                                 |
| ---------------- | ------------------------------------------------ |
| `hubs`           | High call-graph fan-in (many callers)            |
| `deadCandidates` | Zero callers, zero callees — potential dead code |
| `unstableCore`   | High churn + high fan-in (dangerous shared code) |

Names unavailable when their required trajectory isn't registered are gated out
automatically. Read `tea-rags://schema/filters` for the live catalog with exact
threshold definitions.

### Inventory-vs-query rule

A HARD specific filter (e.g. `fragileSilo`, `panicZone`) belongs to **inventory
mode** — where the query is absent and you want a specific slice of the
codebase. When a natural-language query is present, rank broadly without
hard-filtering to preserve recall. Hygiene presets (`production`, `coreLogic`)
are safe in either mode.

### Examples

```jsonc
// Inventory: all production-code files in the fragileSilo bucket
{
  "query": "",
  "filter": { "presets": "coreLogic,fragileSilo" },
  "metaOnly": true
}

// Triage: securityAudit rerank, security paths narrowed, Ruby only
{
  "query": "authentication token validation",
  "language": "ruby",
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
    "must_not": [{ "key": "git.file.ageDays", "range": { "lt": 30 } }],
  },
}
```

For exact syntax and the full list of payload keys, **read the resource — do not
invent syntax**:

```
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/filters")
```

Resource generated from the live registry; always reflects what THIS build
supports. Do NOT memorize the payload key list — read it on demand.

### Codegraph filters (only when codegraph is active)

The `codegraph.file.*` / `codegraph.chunk.*` payload keys exist ONLY when prime
`## Enrichment` lists `codegraph.symbols`; filtering on them against an index
built without codegraph matches nothing. Examples:

```jsonc
// Architectural hubs — high-fan-in backbone files
{ "filter": { "must": [{ "key": "codegraph.file.isHub", "match": { "value": true } }] } }

// High blast radius — many incoming call/import edges
{ "filter": { "must": [{ "key": "codegraph.file.fanIn", "range": { "gte": 10 } }] } }

// Efferent-coupling sources (instability near 1 = depends on many, few depend on it)
{ "filter": { "must": [{ "key": "codegraph.file.instability", "range": { "gte": 0.8 } }] } }
```

`fanIn` / `isHub` are the edge-truth replacements for the `git`/`imports` proxy.
When codegraph is off, filter on `imports` instead and treat it as approximate.

## Stratified scanning (excluding a dominant domain)

Common analytics pattern: an unfiltered scan of a broad project returns results
dominated by the highest-churn domain. To surface the rest, run a SECOND scan
with the dominant domain negated:

```jsonc
// Pass 1: full project, no pathPattern → identifies dominant domain (say "ingest")
// Pass 2: same query, pathPattern: "!**/ingest/**"
//         → surfaces risk zones in the rest of the codebase
```

Same mechanism `tea-rags:risk-assessment` uses for domain-stratified scanning,
but apply it manually whenever a single scan is dominated by one directory.

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
- `level: "file"` applies to typed time-based fields uniformly. If you mix a
  file-level typed time filter with a chunk-level raw filter, understand what
  scope each part lives in — payload paths differ (`git.file.*` vs
  `git.chunk.*`).

## When this skill does NOT apply

- Picking a rerank preset (techDebt vs hotspots vs ownership) → use
  `tea-rags:analytics-rerank`.
- Generic project exploration → use `tea-rags:explore`.
- Investigating a specific bug → use `tea-rags:bug-hunt`.
- Multi-dimensional risk scan over a domain → use `tea-rags:risk-assessment`.

For composing the filter shape itself — payload keys, operators, level — stay
here.
