# Declarative Changelog — Agent Instructions

You are post-processing a published release. Input available in the working dir:

- `commits.json` — array of `{ hash, subject, body }` for this release range.

Group from the commit `subject` + `body` (conventional commits carry a
`type(scope):` prefix — the scope is your primary grouping signal). If a subject
is ambiguous, read its `body` for context.

## Produce `release-notes.json` ONLY (no prose, no markdown to stdout)

Write a file `release-notes.json` matching this schema exactly:

```json
{
  "version": "1.30.0",
  "date": "2026-06-06",
  "compareUrl": "https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0",
  "repoUrl": "https://github.com/artk0de/TeaRAGs-MCP",
  "groups": [
    {
      "domain": "explore",
      "items": [
        {
          "description": "rerank presets resolve adaptive bounds per query",
          "commits": ["abc1234", "def5678"]
        },
        {
          "kind": "fix",
          "description": "preserve codegraph section in find_symbol outline",
          "commits": ["ae55b29"]
        }
      ]
    }
  ],
  "allCommits": [
    {
      "hash": "abc1234",
      "subject": "feat(explore): adaptive bounds per query"
    },
    {
      "hash": "ae55b29",
      "subject": "fix(explore): preserve codegraph section"
    },
    { "hash": "9344854", "subject": "refactor(infra): relocate ConfigError" }
  ]
}
```

## Rules

1. **Only `feat` and `fix` commits go into `groups`.** Everything else —
   `refactor`, `perf`, `docs`, `test`, `chore`, `style`, `build`, `ci` — is
   EXCLUDED from `groups` entirely. They carry no product value in the
   changelog; they still appear in `allCommits` (the Full Commits spoiler).
2. **Group by domain**, not by commit type. Domains come from the commit scope:
   `explore`, `ingest`, `trajectory`, `api`, `chunker`, `codegraph`, `adapters`,
   `infra`, `config`, `language`, `git`, `mcp`, `signals`. Derive the domain
   from the `type(scope):` prefix; if a scope is ambiguous, read the `body`.
3. **Mark fixes.** A `fix` commit's item gets `"kind": "fix"` — the renderer
   prefixes it with `fix:`. A `feat` commit's item has NO `kind` field.
4. **Declarative descriptions.** Describe the resulting capability/behavior, not
   the commit verb. "rerank presets resolve adaptive bounds per query", NOT "add
   adaptiveBounds() to Reranker".
5. **Collapse related commits.** Several `feat` commits forming one capability
   (e.g. an epic) collapse into one item; list all their hashes in `commits[]`.
   Same for related fixes.
6. **Every item lists its commit hashes** (7-char short) in `commits[]`.
7. **`allCommits`** = EVERY commit in range (feat, fix, refactor, chore — all of
   them), verbatim subject, for the Full Commits spoiler.
8. **Always set `date`** to the release date (YYYY-MM-DD) — it appears in both
   the changelog and the GitHub release header.

Do not emit anything to stdout. The only output is the `release-notes.json`
file.
