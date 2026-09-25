---
name: mcp-schema-authoring
description:
  Change an EXISTING MCP tool's contract — a param, its .describe() hint, the
  tool description, an output schema, or the overview resource prose. Triggers
  on "change the X param", "fix the tool description", "add a filter to
  semantic_search", "the schema says Y but the code does Z", "shrink
  tools/list", "поправь описание параметра", "схема MCP". For a brand-new tool
  use add-mcp-endpoint instead.
---

# MCP Schema Authoring

Invariants live in `.claude/rules/mcp-tool-schemas.md` — read it first; this
skill is the order of work. Prose style: `.claude/rules/caveman-compression.md`.

## Implementation Checklist (in order)

- [ ] Baseline: `npx tsx scripts/measure-tools-list.ts --per-tool` → save bytes
- [ ] Trace the code path FIRST (step 1) — the schema follows the code
- [ ] Red test pinning the contract you are about to state (step 2)
- [ ] Edit schema / hint / output schema (step 3)
- [ ] Guards green (step 4)
- [ ] Re-measure, commit with before → after bytes (step 5)

🛑 Each row is a gate.

## 1. Trace what the code actually does

For every param or response field you touch, answer from code, not from the
existing prose (the prose is what drifted):

| Question                                                   | Where to look                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Is the param applied in EVERY composition that exposes it? | `SchemaBuilder#filterParamNames`, `TrajectoryRegistry#buildFilter`, the handler             |
| What is the real default?                                  | the constant the handler / facade reads — interpolate it into the hint                      |
| What shape does the response carry?                        | `contracts/types/*` (e.g. `RankingOverlay`), `filterMetaOnly`, the strategy's `postProcess` |
| Does the shape change with `metaOnly` / `fields` / preset? | `explore/post-process.ts`, `BaseExploreStrategy#applyMetaOnly`                              |

Use `find_symbol` / `get_callers` on the handler, never grep the prose.

## 2. Pin the contract red-first

Pick the guard that owns the invariant:

| Contract                          | Test file                                      |
| --------------------------------- | ---------------------------------------------- |
| param exposed ⇔ applied           | `tests/mcp/tools/param-applicability.test.ts`  |
| hint ≤ 20 words (real tools/list) | same file (`MAX_PARAM_HINT_WORDS`)             |
| input schema shape / enums        | `tests/mcp/tools/schemas.test.ts`              |
| output shape vs REAL results      | `tests/mcp/tools/output-schemas.test.ts`       |
| payload/overlay shape per mode    | `tests/core/domains/explore/**` strategy tests |

Output-schema tests parse results produced by the real code (`Reranker#rerank`,
`resolveSymbols`, `CodeChunkGrouper.groupMembers`), never a fixture written in
the shape you wish the tool returned. Changing an existing expectation =
intentional invariant change: say so in the commit (`test-invariants.md` rule
4).

## 3. Edit

- Hint: ≤ 20 words, the one thing an agent would get wrong. Everything else →
  `buildOverview` `## Param reference` in `src/mcp/resources/registry.ts`, and
  the tool description links `tea-rags://schema/overview`.
- Shared wording across tools → one exported constant (`META_ONLY_CONTRACT`).
- Dynamic param sets (filters, presets) → from `SchemaBuilder`, never a literal
  list.
- Output schema → mirror the contracts type; `.passthrough()` only on a
  runtime-keyed bag, documented in prose.
- A response shape change is `BREAKING CHANGE` in the commit footer.

## 4. Guards

```bash
npx tsc --noEmit
npx vitest run --maxWorkers=2 tests/mcp tests/core/api/internal/infra tests/core/domains/explore
```

Plugin rules/skills that referenced the old wording → update them to POINT at
the schema/overview (not restate), bump plugin version, and check
`scripts/inject-rules.sh --count` against the declared `--parts`.

## 5. Measure and commit

```bash
npx tsx scripts/measure-tools-list.ts --per-tool
```

Commit body: what contract changed, which code path proves it, `tools/list`
bytes codegraph ON/OFF before → after. Live check needs the server to load the
new build — ask the user before `npm link` (it is machine-wide), then exercise
the tool via MCP.

## Anti-patterns (each shipped once)

- Listing a filter the active composition never applies (86wsz).
- A 300-char `level` / `project` hint that belonged in the overview (ewg2s).
- A hint stating a default the handler does not use (search_code `limit`).
- An output schema declaring item fields no tool emits, hidden by
  `.passthrough()` (nb32e).
- `{value,label}` objects at a payload path that holds a number without
  `metaOnly` (9506eb2b6).
- The same contract paragraph copy-pasted into five tools, drifting apart.
