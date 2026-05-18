---
name: extract-project-patterns
user-invocable: false
description:
  Agentic-only enrichment skill — surfaces battle-tested reference code from the
  project as templates for generation / modification. Three-level locality
  cascade (target subdomain → domain → project) with quality gate by overlay
  labels and the project-wide proven rerank preset. Returns a ranked list of
  reference chunks plus locality annotation (L1 / L2 / L3 / none). Invoked by
  `tea-rags:data-driven-generation` Step 2 (TEMPLATE),
  `dinopowers:writing-plans` (per code-gen Task), and
  `dinopowers:executing-plans` (per Task during execute). Skipped automatically
  when no `positiveIds` / `positiveCode` and no `behaviorQuery` are available.
---

# extract-project-patterns

Internal recipe for code generation skills. Find a battle-tested template in the
project for the code you are about to write, via a three-level locality cascade.
Invoked by parent skills; not by users directly.

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
present. Otherwise return
`{ templates: [], locality: "none", diagnostics: ["no input"] }`.

## Recipe — three-level locality cascade

```
L1 pathPattern = pathPatternL1                    (deepest subdomain)
L2 pathPattern = first 2 path segments of L1      (broader domain)
                 if L1 has ≤ 2 segments → L2 = L1, skip L2 step entirely
L3 pathPattern = null                             (project-wide)
```

**L2 derivation example.**

- L1 = `**/domains/trajectory/git/rerank/derived-signals/**` → segments
  `[domains, trajectory, git, rerank, derived-signals]` → L2 =
  `**/domains/trajectory/**`.
- L1 = `**/chunker/hooks/**` → segments `[chunker, hooks]` → L2 = L1, skip L2,
  jump to L3.

**For each level in [L1, L2, L3]:**

1. Call `find_similar` (or `semantic_search` / `hybrid_search` if only
   `behaviorQuery` is available) with:
   - `rerank: "proven"`
   - `pathPattern: <level>` (omit for L3)
   - `limit: <input limit, default 10>`
   - inputs: `positiveIds` | `positiveCode` | `query: behaviorQuery`
2. Apply quality gate over result overlay labels:
   - `ideal_count` = chunks where
     - `commitCount` label is `"low"` or `"typical"`, AND
     - `ageDays` label is `"old"` or `"legacy"`, AND
     - `bugFixRate` label is `"healthy"`
   - If `ideal_count ≥ 2` → return top result + locality annotation. Stop.
3. Apply reject filter (regardless of gate pass):
   - chunks where `bugFixRate` is `"critical"` OR (`ageDays` is `"recent"` AND
     `commitCount` is `"low"`) are excluded from the returned top.
4. If no qualifying chunk → next level.

If all three levels fail → return diagnostic
`"no proven templates for <input> in this project"` so caller can fall back
(generate from scratch, ask user, etc.).

## Output

Structured object for caller consumption:

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

Caller reads `templates[0]` as the reference; `locality` informs how to use the
template:

- `L1` → matches subdomain exactly. Use template's `blameDominantAuthor` for
  style and review routing.
- `L2` → template is from a sibling subdomain in the same broader domain.
  `blameDominantAuthor` reviews the technique, not exact code.
- `L3` → template is from the project at large. `blameDominantAuthor` reviews
  the technique only; verify architectural fit before adopting verbatim.
- `none` → no template found. Caller should generate from scratch and surface
  this to the user so they know to scrutinize the result.

## Skip clause

Return immediately with empty templates if:

- None of `positiveIds` / `positiveCode` / `behaviorQuery` are provided
- The project has no git enrichment indexed (no overlay labels available →
  quality gate cannot run)

## Invoked by

- `tea-rags:data-driven-generation` Step 2 (TEMPLATE)
- `dinopowers:writing-plans` (per code-generation / code-modification Task)
- `dinopowers:executing-plans` (per Task during execute)

## Eval coverage

`/optimize-skill extract-project-patterns` runs baseline cases. Fixture file
`evals/cases.json` is added in a follow-up PR (out of scope for the initial
recipe landing — see spec Component E).
