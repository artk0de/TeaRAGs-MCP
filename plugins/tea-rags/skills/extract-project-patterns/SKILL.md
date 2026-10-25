---
name: extract-project-patterns
user-invocable: false
description:
  Agentic-only — runs on any behaviorQuery / positiveIds handoff: proven code as
  code-gen templates, not test patterns. Read
  body before planning: locality cascade L1 = target subdomain → L2 = infra
  prefix + first semantic segment (skipped when semantic tail ≤ 1 segment) → L3
  = project; find_similar (behaviorQuery → semantic_search) + rerank proven +
  battleTested filter, relax to production on empty; label quality gate.
  Returns templates + locality. Called by data-driven-generation Step 2,
  dinopowers writing-plans / executing-plans. No input → returns { templates:
  [], locality: "none", diagnostics: ["no input"] }, zero calls.
---

# extract-project-patterns

Internal recipe for code-gen skills: battle-tested template for code about to be
written, via three-level locality cascade.

**Handoff = run the recipe now.** Prompt `[invoked by <caller> …]` carrying
`behaviorQuery=` / `positiveIds=` / `positiveCode=` → you are this recipe, not
the caller: its own steps (guard, DDG, chain) stay with it. Target dir without
`pathPatternL1` → L1 = `**/<target dir>/**`. First call = L1 below:
`semantic_search` (`find_similar` when ids/code), `path=<working dir>`,
`rerank: "proven"`, `pathPattern: <L1>`.

## Inputs

Caller passes:

| Input           | Required | Notes                                                       |
| --------------- | -------- | ----------------------------------------------------------- |
| `positiveIds`   | one-of   | Chunk IDs from prior cascade results                        |
| `positiveCode`  | one-of   | Raw code snippet(s) (embedded on the fly by `find_similar`) |
| `behaviorQuery` | one-of   | NL query if no chunk/code is available                      |
| `pathPatternL1` | yes      | From explore PG-OUTPUT (deepest subdomain target)           |
| `limit`         | no       | Default 10                                                  |

At least one of `positiveIds` / `positiveCode` / `behaviorQuery` MUST be
present. Else return
`{ templates: [], locality: "none", diagnostics: ["no input"] }`.

## Recipe — three-level locality cascade

Every call: `project=<alias>` + `path=<working dir>`. `treeState` row = pre-edit
copy → never template; current body via `find_symbol`. Lag / drift ≠ licence to
leave tea-rags (core); own checkout `changedFiles` > 0 → incremental
`index_codebase`, subagent / linked worktree → never reindex. →
`tea-rags://guide/freshness`.

```
L1 pathPattern = pathPatternL1                         (deepest subdomain)
L2 pathPattern = infra prefix + first semantic segment (broader domain)
L3 pathPattern = null                                  (project-wide)
```

**L2 derivation.** Split L1 segments: leading run from skip-vocabulary = infra
prefix (NOT counted, KEPT in glob); rest = semantic tail. L2 = glob cut after
first semantic segment. Semantic tail ≤ 1 segment → L2 = L1, skip L2 step
entirely.

Skip-vocabulary (infra/layer prefixes): `app`, `src`, `lib`, `core`, `packages`,
`internal`, `domains`; Rails layers: `services`, `models`, `controllers`,
`jobs`, `workers`, `mailers`, `concerns`, `graphql`, `serializers`,
`presenters`, `decorators`, `operations`, `interactors`, `policies`.

- L1 = `**/domains/trajectory/git/rerank/derived-signals/**` → prefix
  `[domains]`, semantic `[trajectory, git, rerank, derived-signals]` → L2 =
  `**/domains/trajectory/**`.
- L1 = `**/app/services/crm/accounts/**` → prefix `[app, services]`, semantic
  `[crm, accounts]` → L2 = `**/app/services/crm/**` (NOT `**/app/services/**` —
  layer-wide L2 = degenerate L3).
- L1 = `**/app/services/billing/**` → semantic `[billing]`, 1 segment → skip L2.
- L1 = `**/domains/explore/strategies/new-feature/**` → prefix `[domains]`,
  semantic `[explore, strategies, new-feature]` = 3 segments → L2 =
  `**/domains/explore/**`. Count tail segments one by one; never skip L2 on a
  tail ≥ 2.
- L1 = `**/domains/explore/**` / `**/some-new-area/**` → semantic tail 1 segment
  → skip L2: cascade L1 → L3, never a parent glob.
- L1 = `**/chunker/hooks/**` → no prefix, semantic `[chunker, hooks]` → L2 =
  `**/chunker/**` (2 segments is NOT too shallow — L1 always runs).
- L1 = `**/language/ruby/chunking/**` → no prefix, semantic
  `[language, ruby, chunking]` → L2 = `**/language/**`.

**For each level in [L1, L2, L3]:**

1. `find_similar` (only `behaviorQuery` → `semantic_search` / `hybrid_search`):
   - `rerank: "proven"` + `level: "chunk"` (proven is file-level; keep chunk
     results)
   - `filter: { presets: "battleTested" }` — ANDs w/ `pathPattern`
   - `pathPattern: <level>` (omit for L3)
   - `limit: <input limit, default 10>`
   - inputs: `positiveIds` | `positiveCode` | `query: behaviorQuery`

   **Relax-on-empty:** 0 results → re-run once w/
   `filter: { presets: "production" }`, record
   `"no battle-tested reference found; widened to production code"` in
   `diagnostics`. Never return empty silently while relax possible.

2. Quality gate over overlay labels:
   - `ideal_count` = chunks where
     - `commitCount` label is `"low"` or `"typical"`, AND
     - `ageDays` label is `"old"` or `"legacy"`, AND
     - `bugFixRate` label is `"healthy"`
   - `ideal_count ≥ 2` → return top result + locality. Stop.
   - **Lone-ideal-hub**: `ideal_count == 1` AND lone ideal's
     `payload.codegraph.symbols.file.isHub == true` → level accepted,
     `templates[0]` = lone ideal (NOT top-by-score). Stop. Hub = usage-proof
     (fanIn > p95). No `codegraph.symbols` in payload → branch inert.
3. Reject filter (always): exclude `bugFixRate` `"critical"` OR (`ageDays`
   `"recent"` AND `commitCount` `"low"`).
4. No qualifying chunk → next level.

All levels fail → `diagnostics` carries BOTH lines, verbatim:
`"no battle-tested reference found; widened to production code"` (every relax
that ran) + `"no proven templates for <input> in this project"`;
`locality: "none"` (caller falls back: scratch, ask user).

## Output

```
{
  templates: [
    {
      chunkId,
      path,
      level: "L1" | "L2" | "L3",
      labels: { commitCount, ageDays, bugFixRate, blameContributorCount, ... },
      blameDominantAuthor,
    },
    ...
  ],
  locality: "L1" | "L2" | "L3" | "none",
  diagnostics: [<per-level fail reasons>],
}
```

Caller reads `templates[0]`; `locality` → usage:

- `L1` → exact subdomain. `blameDominantAuthor` → style + review routing.
- `L2` → sibling subdomain. `blameDominantAuthor` reviews technique, not code.
- `L3` → project-wide. Technique only; verify architectural fit before verbatim
  adoption.
- `none` → caller generates from scratch, tells user to scrutinize.

## Skip clause

Return empty templates immediately if:

- none of `positiveIds` / `positiveCode` / `behaviorQuery`
- no git enrichment indexed (no overlay labels → gate cannot run)
