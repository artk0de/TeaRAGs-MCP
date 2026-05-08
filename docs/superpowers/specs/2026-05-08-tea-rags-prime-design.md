# `tea-rags prime` — SessionStart context autofire

**Date:** 2026-05-08 **Status:** Design approved, ready for plan **Owner:**
artk0de

## Motivation

Currently the tea-rags plugin's `SessionStart` and `PreCompact` hooks run
`scripts/inject-rules.sh`, which `cat`s `rules/search-cascade.md`. Inside that
file there is a section "Session Start (EXECUTE IMMEDIATELY)" that _asks the
agent_ to run `get_index_status` and `get_index_metrics` itself, then memorize
the polyglot setup and label thresholds.

This is **prompt-based autofire** — the agent has to make MCP roundtrips before
it can answer the user's first message. The roundtrips cost latency, the rules
file is the same on every project, and the agent has no concrete data until it
executes the tool calls.

The beads plugin solves the same problem differently: its SessionStart hook runs
`bd prime`, a CLI subcommand that dumps a compact markdown digest to stdout.
Claude reads it as session context — **no MCP roundtrip needed**.

This spec adapts that pattern for tea-rags. We add `tea-rags prime <PATH>` as a
CLI subcommand that emits a markdown digest of `getIndexStatus`,
`getIndexMetrics` (primary-language labels), and `checkSchemaDrift`. The
SessionStart hook calls it directly.

## Goals

- Eliminate the need for the agent to run `get_index_status` /
  `get_index_metrics` as its first action in every session.
- Pre-load polyglot detection, label thresholds for the primary language, and
  schema drift status into SessionStart context.
- Reuse the existing `App` facade — no duplication of MCP-handler logic.
- Hook never blocks SessionStart for more than ~200ms when Qdrant is cold.
- Hook always exits 0 — failures degrade gracefully into placeholder output.

## Non-Goals

- **No new MCP tool.** Existing `get_index_status` / `get_index_metrics` /
  `checkSchemaDrift` stay as-is. Prime is a presentation layer over them.
- **No refactor of `src/mcp/tools/code.ts`.** It is the highest-bug-density file
  in this surface (bugFixRate 47% concerning). Hands off.
- **No support for embedded-Qdrant cold-spawn from prime.** If the daemon is not
  already running, prime emits a placeholder. The MCP server will spawn the
  daemon shortly after, on its own schedule.
- **No `--all-languages` flag.** Polyglot projects get the primary language only
  in the digest; secondary languages require an explicit `get_index_metrics`
  call from the agent.
- **No `--quiet` / `--verbose` flags.** YAGNI — single output mode.

## Architecture

### Layer placement

`tea-rags prime` is a CLI subcommand in `src/cli/commands/`. Following the
existing pattern of `serverCommand` and `tuneCommand`, it is registered in
`src/cli/create-cli.ts`.

The subcommand consumes the `App` facade from `core/api/public/`. Per
`.claude/rules/domain-boundaries.md`, CLI is a composition-root consumer — it
imports `bootstrap/factory.ts` (for `createAppContext`) and `core/api/index.ts`
(for `App` interface and DTOs). It does not import from `core/domains/*` or
`core/contracts/*` directly.

### Module split

```
src/cli/
  commands/
    prime.ts           # yargs CommandModule (~50 lines)
  prime/
    run-prime.ts       # runPrime(path) — orchestration (~80 lines)
    format.ts          # pure markdown formatter (~150 lines)
    types.ts           # local types (PrimeData, PrimeFailureReason)

tests/cli/
  commands/
    prime.test.ts      # integration with mocked App
  prime/
    format.test.ts     # unit tests for pure formatter
```

The split follows the project's discipline of keeping pure presentation logic
testable without bootstrap. `format.ts` is a pure function from
`(IndexStatus, IndexMetrics, DriftWarning) → string` and has dedicated unit
tests. `run-prime.ts` does the bootstrap and orchestration; it has an
integration test that mocks the `App` facade.

### Reuse, not duplication

`runPrime` calls three existing `App` methods:

- `app.getIndexStatus(path)` — already returns `IndexStatus` DTO with `status`,
  `chunksCount`, `enrichment`, `infraHealth` fields.
- `app.getIndexMetrics(path)` — already returns per-language `signals` map with
  `labelMap` for each scoped signal.
- `app.checkSchemaDrift({ path })` — already returns `DriftWarning | null`.

These three calls fire in `Promise.all` (independent reads, no shared state).

## Data Flow

```
SessionStart hook (plugin.json)
  ├─ inject-rules.sh                      # cat search-cascade.md (without obsolete section)
  └─ tea-rags prime "$CLAUDE_PROJECT_DIR" # new
                                            ↓
                                          runPrime(path)
                                            ↓
                                          1. validate path exists → on miss: emit
                                             "Path not found" placeholder, exit 0
                                            ↓
                                          2. parseAppConfig()
                                            ↓
                                          3. ping Qdrant (HEAD /collections, timeout 200ms)
                                             ├─ ok → continue
                                             └─ timeout/error → emit "warm-up pending"
                                                placeholder, exit 0
                                            ↓
                                          4. createAppContext(config) → App
                                            ↓
                                          5. Promise.all([
                                               app.getIndexStatus(path),
                                               app.getIndexMetrics(path),
                                               app.checkSchemaDrift({ path }),
                                             ])
                                            ↓
                                          6. formatPrime({ status, metrics, drift, path })
                                            ↓
                                          7. process.stdout.write(markdown)
                                            ↓
                                          8. ctx.cleanup() (release Qdrant client refs)
                                            ↓
                                          9. exit 0
```

### Warm-up ping detail

The 200ms ping uses the lightest available Qdrant call (e.g. `HEAD /` or
`GET /healthz`) bypassing `QdrantManager` initialization. If the project is
configured for external Qdrant (`QDRANT_URL` set), this is a single TCP connect.
If embedded, the daemon may not be running yet — a connect refused arrives
within milliseconds.

The ping uses a raw `fetch` with `AbortController.abort()` after 200ms — no
import of `QdrantManager` (which has its own retry semantics not appropriate
here).

If the ping succeeds we **then** call `createAppContext`, which sets up
`QdrantManager` with full retry and validation. The ping is a fast-fail gate,
not the actual data fetch.

## Output Format (markdown digest)

### Happy path — indexed, polyglot, no drift

```markdown
# tea-rags prime — /Users/artk0re/Dev/Tools/tea-rags-mcp

## Status

indexed · collection `code_27622aef` · 4218 chunks · payload v7 enrichment ·
git: file ✓ done, chunk ✓ done

## Polyglot

primary: typescript (3104 chunks, 73%) · also: javascript (612), markdown (502)
→ for non-primary languages, call `get_index_metrics` for their labelMap

## Schema drift

none

## Signal thresholds — typescript

### git.file (source / test)

| signal        | source                                      | test                                        |
| ------------- | ------------------------------------------- | ------------------------------------------- |
| commitCount   | low ≤2 / normal ≤5 / high ≤9 / extreme >9   | low ≤1 / normal ≤3 / high ≤6 / extreme >6   |
| ageDays       | recent ≤14 / typical ≤45 / legacy >45       | recent ≤14 / typical ≤45 / legacy >45       |
| bugFixRate    | healthy ≤30 / concerning ≤60 / critical >60 | healthy ≤30 / concerning ≤60 / critical >60 |
| relativeChurn | low ≤1.5 / normal ≤5 / high >5              | low ≤1 / normal ≤3 / high >3                |

### git.chunk (source / test)

| signal        | source | test |
| ------------- | ------ | ---- |
| commitCount   | ...    | ...  |
| ageDays       | ...    | ...  |
| bugFixRate    | ...    | ...  |
| relativeChurn | ...    | ...  |
```

### Failure / degraded outputs

| Scenario                                             | Output (markdown)                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Path not found                                       | `# tea-rags prime\nPath not found: <path>`                                                                               |
| Qdrant unreachable (200ms ping fail)                 | `# tea-rags prime\nQdrant warm-up pending — index queries will be available after MCP server attaches.`                  |
| `status: not_indexed`                                | `# tea-rags prime — <path>\n## Status\nnot indexed. Run \`/tea-rags:index\` to index this codebase.`                     |
| `status: stale_indexing`                             | `## Status\nstale indexing marker (previous run crashed). Re-run /tea-rags:index — stale collection will be cleaned up.` |
| `status: indexing`                                   | `## Status\nindexing in progress (<N> chunks so far). Re-prime after completion.` (skip metrics block)                   |
| Schema drift detected                                | `## Schema drift\nnew fields: <list>. Run /tea-rags:force-reindex to populate.`                                          |
| `app.getIndexMetrics` empty (e.g. no enrichment yet) | omit "Signal thresholds" section, keep status section                                                                    |

All scenarios exit 0.

### Primary-language heuristic

`getIndexMetrics` returns a per-language `signals` map. Primary language is
determined by the highest chunks count from `getIndexStatus.chunkCounts` (an
existing field, scoped per language). Ties broken by alphabetical order
(deterministic).

If only one language is present, the "Polyglot" section degrades to:

```
## Language
typescript (4218 chunks, 100%)
```

## Failure Modes & Exit Codes

| Failure                                                         | Exit code | stdout             | stderr      |
| --------------------------------------------------------------- | --------- | ------------------ | ----------- |
| Any of: path missing, Qdrant cold, not indexed, indexing, drift | 0         | placeholder digest | nothing     |
| Programming error (uncaught throw, e.g. yargs parse error)      | 1         | nothing            | error trace |

The hook contract is "always exit 0 if input is valid". This matches beads:
`bd prime` never errors out on missing data — it emits "no beads found".

Programming errors (exit 1) only fire on truly malformed invocation (no path
arg, etc.) — in normal operation the hook always succeeds.

## Hook Integration

### `plugin.json` changes (`.claude-plugin/tea-rags/.claude-plugin/plugin.json`)

```jsonc
"hooks": {
  "SessionStart": [
    {
      "matcher": "",
      "hooks": [
        { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-rules.sh" },
        { "type": "command", "command": "tea-rags prime \"$CLAUDE_PROJECT_DIR\"" }
      ]
    }
  ],
  "PreCompact": [
    {
      "matcher": "",
      "hooks": [
        { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-rules.sh" },
        { "type": "command", "command": "tea-rags prime \"$CLAUDE_PROJECT_DIR\"" }
      ]
    }
  ]
}
```

`tea-rags` binary is expected to be on `PATH` (npm global install — the
documented happy path). No `npx -y` prefix — that's an installation-method
fallback, not the recommended setup.

### Slash command (`.claude-plugin/tea-rags/commands/prime.md`)

```markdown
Re-prime the agent's context with current tea-rags index state for this project.

Use after running `/tea-rags:index` mid-session, or when the agent's view of
index health may be stale.

\`\`\`bash tea-rags prime "$CLAUDE_PROJECT_DIR" \`\`\`
```

(Mirrors `bd prime` slash-command pattern.)

### `search-cascade.md` cleanup

Remove the entire "Session Start (EXECUTE IMMEDIATELY)" section. The CLI now
delivers the same data pre-computed; the agent does not need to make these calls
itself.

Keep all other sections of `search-cascade.md` (search principles, polyglot
rule, MANDATORY directives) — those remain prompt-injected via
`inject-rules.sh`.

## Testing Strategy

Per `.claude/rules/test-patterns.md`:

### Unit — `tests/cli/prime/format.test.ts`

Pure formatter, no mocks. Test cases:

1. Happy path, polyglot project (3+ languages) — assert table structure,
   primary-language detection, "→ for non-primary languages" footer.
2. Happy path, monolingual project — assert "## Language" replaces "##
   Polyglot".
3. `status: not_indexed` — assert "not indexed" message, no thresholds table.
4. `status: stale_indexing` — assert stale marker message.
5. `status: indexing` — assert progress message + chunks count, metrics omitted.
6. Schema drift present — assert drift section lists new fields with reindex
   hint.
7. Empty `getIndexMetrics` (no enrichment) — assert thresholds section omitted,
   status preserved.
8. Path-not-found short form — assert single-line "Path not found: <path>".
9. Qdrant warm-up placeholder — assert "warm-up pending" message.

### Integration — `tests/cli/commands/prime.test.ts`

Uses `MockQdrantManager` and `MockEmbeddingProvider` from
`tests/core/domains/ingest/__helpers__/test-helpers.ts`. Test cases:

1. `runPrime` calls `app.getIndexStatus`, `app.getIndexMetrics`,
   `app.checkSchemaDrift` exactly once each (parallel — all called before any
   resolves, verified via mock instrumentation).
2. `runPrime` writes formatter output to `process.stdout`.
3. `runPrime` resolves without throwing on the happy path.
4. `runPrime` calls `ctx.cleanup` after writing output.
5. When path doesn't exist, `runPrime` writes "Path not found" placeholder and
   does NOT call `createAppContext`.
6. When Qdrant ping fails, `runPrime` writes "warm-up pending" placeholder and
   does NOT call `createAppContext`.

### NOT tested

- End-to-end with real embedded Qdrant — too expensive for CI per
  `coverage strategy` in test-patterns.md. The integration test mocks
  `QdrantManager`; the unit test covers the format.

## Versioning

Per `.claude/rules/plugin-versioning.md`:

- New skill / command file → minor bump.
- We add `commands/prime.md` (new) and modify `plugin.json` (new hook entry) +
  `rules/search-cascade.md` (text edit).
- **Bump tea-rags plugin from `0.16.2` → `0.17.0`.**

The npm package itself (`tea-rags-mcp`) gets a `feat(cli)` commit. Per
`.claude/rules/commit-rules.md`, scope `cli` is not in the listed scopes — we
extend the scope table or use `feat` (minor bump). Recommendation: add `cli` to
`.releaserc.json` scope table as a public+functional scope (minor) before this
change lands.

## Acceptance Criteria

1. `tea-rags prime <indexed-project>` exits 0 in <500ms with full digest.
2. `tea-rags prime <unindexed-project>` exits 0 in <500ms with placeholder.
3. `tea-rags prime <nonexistent-path>` exits 0 in <50ms with "Path not found".
4. SessionStart hook on a fresh shell (Qdrant not running) — exits in <300ms
   with "warm-up pending" placeholder, does NOT spawn embedded daemon.
5. `tests/cli/prime/format.test.ts` covers all 9 format scenarios.
6. `tests/cli/commands/prime.test.ts` covers all 6 integration scenarios.
7. `npm run build && npm test` passes; coverage thresholds maintained.
8. `search-cascade.md` no longer contains the "Session Start (EXECUTE
   IMMEDIATELY)" section — verified by grep.
9. `plugin.json` has both hooks (`SessionStart` and `PreCompact`) wired to
   `tea-rags prime "$CLAUDE_PROJECT_DIR"`.
10. Plugin version bumped to `0.17.0`.

## Locked details (resolved 2026-05-08)

- **`IndexMetrics.labelMap` shape**: `Record<string, number>` (label name →
  threshold value, e.g. `{ "high": 12, "extreme": 30 }`). Source:
  `src/core/api/public/dto/metrics.ts` `SignalMetrics.labelMap`.
- **Primary-language source**: `IndexMetrics.distributions.language`
  (`Record<string, number>` of language → chunk count). Sort entries by count
  desc and take the first key. Reason: `IndexStatus.languages` is declared in
  the DTO but **never populated** by any producer (`StatusModule` does not set
  it) — the field is dead. `IndexMetrics.signals` keys come from
  `perLanguage.keys()` insertion order and are NOT sorted by count, so they
  cannot be used directly. The `chunkCounts` field referenced earlier in the
  spec does NOT exist.
- **Qdrant ping endpoint**: `GET /readyz` with `AbortSignal.timeout(200)`.
  Pattern matches `src/core/adapters/qdrant/embedded/daemon.ts:153` (which uses
  2000ms; we use 200ms for SessionStart fast-fail).
- **Out of scope**: README global-install requirement remains undocumented in
  this spec — covered by separate doc work.
