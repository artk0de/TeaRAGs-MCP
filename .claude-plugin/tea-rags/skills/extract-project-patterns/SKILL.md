---
name: extract-project-patterns
user-invocable: false
description:
  Agentic-only enrichment skill — surface battle-tested reference code from
  project as templates for generation / modification. Three-level locality
  cascade (target subdomain → domain → project), quality gate by overlay labels
  + project-wide proven rerank preset. Returns ranked list of reference chunks +
  locality annotation (L1 / L2 / L3 / none). Invoked by
  `tea-rags:data-driven-generation` Step 2 (TEMPLATE),
  `dinopowers:writing-plans` (per code-gen Task), `dinopowers:executing-plans`
  (per Task during execute). Skipped when no `positiveIds` / `positiveCode` and
  no `behaviorQuery` available.
---

# extract-project-patterns

Internal recipe for code-gen skills. Find battle-tested template in project for
code you about to write, via three-level locality cascade. Invoked by parent
skills; not users directly.

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
- L1 = `**/chunker/hooks/**` → no prefix, semantic `[chunker, hooks]` → L2 =
  `**/chunker/**`.

**For each level in [L1, L2, L3]:**

1. Call `find_similar` (or `semantic_search` / `hybrid_search` if only
   `behaviorQuery` available) with:
   - `rerank: "proven"`
   - `filter: { presets: "battleTested" }` — narrows to genuinely battle-tested
     code; composes (AND) with any `pathPattern` / locality scoping
   - `pathPattern: <level>` (omit for L3)
   - `limit: <input limit, default 10>`
   - inputs: `positiveIds` | `positiveCode` | `query: behaviorQuery`

   **Relax-on-empty:** if the call returns 0 results, re-run once with
   `filter: { presets: "production" }` (hygiene only; no battle-tested
   guarantee) and record
   `"no battle-tested reference found; widened to production code"` in
   `diagnostics`. A reference is required — never return empty silently when a
   relax is still possible.

2. Apply quality gate over result overlay labels:
   - `ideal_count` = chunks where
     - `commitCount` label is `"low"` or `"typical"`, AND
     - `ageDays` label is `"old"` or `"legacy"`, AND
     - `bugFixRate` label is `"healthy"`
   - If `ideal_count ≥ 2` → return top result + locality annotation. Stop.
   - **Lone-ideal-hub**: `ideal_count == 1` AND lone ideal's
     `payload.codegraph.symbols.file.isHub == true` → level accepted,
     `templates[0]` = lone ideal itself (NOT top-by-score). Stop. Why: hub =
     usage-proof (fanIn > p95), corroborates single replication. No
     `codegraph.symbols` in payload → branch inert, normal fall-through.
3. Apply reject filter (regardless of gate pass):
   - chunks where `bugFixRate` is `"critical"` OR (`ageDays` is `"recent"` AND
     `commitCount` is `"low"`) excluded from returned top.
4. If no qualifying chunk → next level.

All three levels fail → return diagnostic
`"no proven templates for <input> in this project"` so caller falls back
(generate from scratch, ask user, etc.).

## Output

Structured object for caller:

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

Caller reads `templates[0]` as reference; `locality` informs how to use
template:

- `L1` → matches subdomain exactly. Use template's `blameDominantAuthor` for
  style + review routing.
- `L2` → template from sibling subdomain in same broader domain.
  `blameDominantAuthor` reviews technique, not exact code.
- `L3` → template from project at large. `blameDominantAuthor` reviews technique
  only; verify architectural fit before adopting verbatim.
- `none` → no template found. Caller generates from scratch and surfaces this to
  user so they know to scrutinize result.

## Skip clause

Return immediately empty templates if:

- None of `positiveIds` / `positiveCode` / `behaviorQuery` provided
- Project has no git enrichment indexed (no overlay labels → quality gate cannot
  run)

## Invoked by

- `tea-rags:data-driven-generation` Step 2 (TEMPLATE)
- `dinopowers:writing-plans` (per code-generation / code-modification Task)
- `dinopowers:executing-plans` (per Task during execute)

## Eval coverage

`/optimize-skill extract-project-patterns` runs baseline cases. Fixture file
`evals/cases.json` added in follow-up PR (out of scope for initial recipe
landing — see spec Component E).
