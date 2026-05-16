---
name: filter-building
description:
  Construct a tea-rags filter beyond `pathPattern`. Covers typed sugar fields
  (`language`, `testFile`, `documentation`, `author`, `taskId`, `minAgeDays` /
  `maxAgeDays`, `minCommitCount`, `modifiedAfter` / `modifiedBefore`,
  `fileExtension`, `chunkType`, `symbolId`), the `level: "file" | "chunk"`
  switch (mandatory for time-based fields), picomatch negation in `pathPattern`
  (`!**/test/**`), and the escape hatch into raw `filter` (Qdrant
  `must`/`should`/`must_not`) when a payload key has no typed sugar. Invoke
  when the agent is about to issue a tea-rags search and recognizes intent
  like "scope to tests only", "exclude vendor dirs", "filter by author
  Alice", "code modified after 2026-03-01", "drop one-off scripts under 5
  commits", "files linked to ticket JIRA-1234", "raw filter for a non-typed
  payload field". NOT for picking a rerank preset — use
  `tea-rags:analytics-rerank` for that. NOT for general project exploration
  — use `tea-rags:explore`.
user-invocable: false
---

# Filter Building

Two ways to constrain a tea-rags search beyond `query` + `pathPattern`. Pick the
right mechanism — they compose.

## Typed filters (fast path)

Top-level params on every search request. Prefer these over raw `filter:`
whenever a typed field expresses the constraint — intent-clear, schema-checked,
and survives directory restructures.

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
They compose with typed filters (e.g. `language: "ruby"` +
`pathPattern: "**/services/**"`).

- GOOD: `**/enrichment/**` (directory prefix)
- GOOD: `{file1.rb,file2.rb}` (flat file names, no slashes)
- GOOD: `!**/test/**` (picomatch negation — exclude a directory subtree)
- GOOD: `!**/vendor/**` (exclude non-test dirs that have no typed sugar)
- BAD: `{app/services/foo.rb,app/models/bar.rb}` (slashes inside braces — breaks
  picomatch)

**When to prefer negation over typed sugar.** Use `testFile: "exclude"` for test
exclusion — it's intent-clear and survives test-directory renames. Use
`!**/dir/**` only for directories that have no typed sugar (`vendor`,
`generated`, `migrations`).

## Typed filter vs `pathPattern`

For `language`, `documentation`, `testFile` — **use the typed filter, not a
pathPattern**. The typed filter is intent-clear, schema-checked, and survives
directory restructures. `pathPattern` is for arbitrary directory globs. They
compose freely.

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

The resource is generated from the live registry; it always reflects what THIS
build supports. Do NOT memorize the payload key list — read it on demand.

## Stratified scanning (excluding a dominant domain)

A common analytics pattern: an unfiltered scan of a broad project returns
results dominated by the highest-churn domain. To surface the rest, run a SECOND
scan with the dominant domain negated:

```jsonc
// Pass 1: full project, no pathPattern → identifies dominant domain (say "ingest")
// Pass 2: same query, pathPattern: "!**/ingest/**"
//         → surfaces risk zones in the rest of the codebase
```

This is the same mechanism `tea-rags:risk-assessment` uses for domain-
stratified scanning, but you can apply it manually whenever a single scan is
dominated by one directory.

## Composition rules

- Typed filter + typed filter: AND across both fields (e.g. `language: "ruby"`
  AND `testFile: "exclude"`).
- Typed filter + `pathPattern`: AND across both.
- Typed filter + raw `filter`: AND across both — raw `filter` adds its
  must/should/must_not on top of the typed constraints.
- `level: "file"` applies to typed time-based fields uniformly. If you mix a
  file-level typed time filter with a chunk-level raw filter, you must
  understand what scope each part lives in — payload paths differ (`git.file.*`
  vs `git.chunk.*`).

## When this skill does NOT apply

- Picking a rerank preset (techDebt vs hotspots vs ownership) → use
  `tea-rags:analytics-rerank`.
- Generic project exploration → use `tea-rags:explore`.
- Investigating a specific bug → use `tea-rags:bug-hunt`.
- Multi-dimensional risk scan over a domain → use `tea-rags:risk-assessment`.

For composing the filter shape itself — payload keys, operators, level — stay
here.
