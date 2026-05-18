# extract-project-patterns — agent-only recipe for project-wide proven code patterns

**Status:** Proposed **Date:** 2026-05-18 **Affects plugins:** tea-rags (minor —
new skill), dinopowers (patch — wire-in) **Affects code:**
`src/core/domains/trajectory/git/rerank/presets/proven.ts` **Beads epic:**
`tea-rags-mcp-vr7v`

## Motivation

`tea-rags:data-driven-generation` (DDG) Step 2 TEMPLATE selects a battle-tested
reference implementation as input for code generation. Today it inherits the
`pathPattern` produced by `tea-rags:explore` PG-OUTPUT (typically a subdomain
glob like `**/chunker/hooks/**`) and uses inline custom weights for
`find_similar`:

```
{ similarity: 0.2, stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05 }
```

Three problems compound:

1. **Subdomain starvation.** When the target subdomain is young, sparse, or
   under active churn, no chunk passes the quality gate. The agent either
   degrades to a noisy reference or fabricates a pattern from training data.

2. **Drift from preset registry.** A first-class `ProvenPreset` already exists
   in `src/core/domains/trajectory/git/rerank/presets/proven.ts` with weights
   numerically equivalent. The skill's inline copy is a second source of truth
   that can drift and cannot be reused.

3. **No reuse across skills.** DDG is not the only code-generation consumer.
   `dinopowers:writing-plans` (when drafting Tasks that generate or modify code)
   and `dinopowers:executing-plans` need the same "find proven templates for X"
   capability. Today each would have to re-implement the cascade in its own
   SKILL.md — duplicate logic, drift risk.

## Design

### Overview

Introduce a new agent-only recipe-skill **`tea-rags:extract-project-patterns`**
modeled on `tea-rags:tests-as-context`. The skill encapsulates a **three-level
locality cascade** for finding proven reference code, returns structured output,
and is invoked by parent skills as enrichment — not directly by users.

**Consumers:**

- `tea-rags:data-driven-generation` (Step 2 TEMPLATE) — replaces inline
  find_similar + custom weights with a delegated call.
- `dinopowers:writing-plans` — per Task in the plan's Affected Files section
  that involves code generation or modification, invoke the recipe and attach
  proven templates as plan context (alongside existing per-file imports / churn
  / ownership enrichment).
- `dinopowers:executing-plans` — same, but during execute (Task-by-Task), so the
  implementation phase carries the same proven templates the plan was written
  against.

### Component A — `ProvenPreset.tools[]` extension

**File:** `src/core/domains/trajectory/git/rerank/presets/proven.ts`

Single-line change:

```ts
// before
readonly tools = ["semantic_search", "hybrid_search", "search_code"];
// after
readonly tools = ["semantic_search", "hybrid_search", "search_code", "find_similar"];
```

**Why:** `schemaBuilder.buildRerankSchema("find_similar")` filters presets by
`tools[]` membership. Without this change, `rerank: "proven"` on `find_similar`
is rejected at schema validation. The preset's semantics ("battle-tested code as
reference / template") are identical for find_similar — in fact find_similar is
the natural way to consume it, since the recipe carries a chunk in hand.

No weights, overlayMask, or signalLevel change.

### Component B — New skill `tea-rags:extract-project-patterns`

**Location:** `.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md`

**Frontmatter shape (modeled on `tests-as-context`):**

```yaml
---
name: extract-project-patterns
user-invocable: false
description:
  Agentic-only enrichment skill — surfaces battle-tested reference code from the
  project as templates for generation / modification. Three-level locality
  cascade (target subdomain → domain → project) with quality gate by overlay
  labels and a project-wide proven rerank preset. Returns a ranked list of
  reference chunks plus locality annotation (L1 / L2 / L3). Invoked by
  `tea-rags:data-driven-generation` Step 2 (TEMPLATE),
  `dinopowers:writing-plans` (per code-gen Task), and
  `dinopowers:executing-plans` (per Task during execute). Skipped automatically
  when no `positiveIds` / `positiveCode` and no behavior query are available.
---
```

**Inputs (passed by caller):**

| Input           | Required | Notes                                                   |
| --------------- | -------- | ------------------------------------------------------- |
| `positiveIds`   | one-of   | Chunk ids from prior cascade results                    |
| `positiveCode`  | one-of   | Raw code snippets (embedded on the fly by find_similar) |
| `behaviorQuery` | one-of   | Natural-language query if no chunk/code is available    |
| `pathPatternL1` | yes      | from explore PG-OUTPUT (the deepest subdomain target)   |
| `limit`         | no       | default 10                                              |

At least one of `positiveIds` / `positiveCode` / `behaviorQuery` must be
present.

**Recipe — three-level cascade:**

```
L1 pathPattern = pathPatternL1                    (deepest subdomain)
L2 pathPattern = first 2 path segments of L1      (broader domain)
                 if L1 has ≤ 2 segments → L2 = L1, then skip L2 step
L3 pathPattern = null                             (project-wide)

For each level in [L1, L2, L3]:
  Call find_similar (or semantic_search / hybrid_search if behaviorQuery only)
       with rerank = "proven", pathPattern = <level>, limit = 10.
  Apply quality gate over result overlay labels:
    ideal_count = chunks where
                  commitCount label is "low" or "typical"
                  AND ageDays label is "old" or "legacy"
                  AND bugFixRate label is "healthy"
    If ideal_count >= 2 → return top result + locality annotation
  Apply reject filter (regardless of gate pass):
    chunks where bugFixRate is "critical"
    OR (ageDays is "recent" AND commitCount is "low")
    are excluded from the returned top.
  If no qualifying chunk → next level.

If all three levels fail → return diagnostic
  "no proven templates for <input> in this project"
  so caller can fall back (generate from scratch, ask user, etc.).
```

**L2 derivation example.** For `pathPatternL1` =
`**/domains/trajectory/git/rerank/derived-signals/**`, segments are
`[domains, trajectory, git, rerank, derived-signals]`, so L2 =
`**/domains/trajectory/**`.

For `pathPatternL1` = `**/chunker/hooks/**`, segments are `[chunker, hooks]`, L2
= L1, skip L2 step, jump straight to L3.

**Output shape (structured, for caller consumption):**

```
{
  templates: [
    {
      chunkId: <id>,
      path: <relative path>,
      level: "L1" | "L2" | "L3",
      labels: { commitCount, ageDays, bugFixRate, blameContributorCount, ... },
      blameDominantAuthor: <author>,
    },
    ...
  ],
  locality: "L1" | "L2" | "L3" | "none",
  diagnostics: [<level fail reasons>],
}
```

Caller (DDG / writing-plans / executing-plans) reads `templates[0]` as the
reference; `locality` annotates the level so downstream STYLE step can adjust
blame-author lookup (a cross-subdomain author has a different review meaning
than a same-subdomain one).

**Skip clause.** The skill is skipped automatically (returns
`{ templates: [], locality: "none", diagnostics: ["no input"] }`) when none of
the required inputs are provided.

### Component C — `tea-rags:data-driven-generation` Step 2 rewrite

**File:** `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`

Replace lines 70-83 (current Step 2 TEMPLATE) with:

```
### Step 2: TEMPLATE

Delegate to `tea-rags:extract-project-patterns` with:
  positiveIds | positiveCode = <best verified result from cascade Step 1>
  pathPatternL1              = <from explore PG-OUTPUT>
  limit                      = 10

Read `templates[0]` as the reference for Step 4 (GENERATE).
Read `locality` to annotate Step 3 (STYLE):
  - L1 → use template's blameDominantAuthor for style and review
  - L2 → blameDominantAuthor reviews the technique, not exact code
  - L3 → blameDominantAuthor reviews the technique only; verify
         architectural fit before adopting verbatim
  - none → no template found; generate from scratch, surface this
           to the user so they know to scrutinize the result

(Inline custom weights and the local find_similar call are removed.
 All locality logic lives in extract-project-patterns.)
```

### Component D — `dinopowers:writing-plans` wire-in

**File:** `.claude-plugin/dinopowers/skills/writing-plans/SKILL.md`

The wrapper already enriches Affected Files with per-file imports / churn /
ownership / bugFixRate / taskIds. Add a parallel per-Task enrichment when a Task
is classified as code-generation or code-modification (heuristic: Task title or
description mentions "implement / add / write / extend / refactor / modify a
function | method | class | helper | module"):

```
For each code-gen / code-mod Task:
  1. Derive pathPatternL1 from the Task's Affected Files (deepest common
     ancestor).
  2. Invoke `tea-rags:extract-project-patterns` with pathPatternL1 +
     behaviorQuery = Task title.
  3. Attach to the Task body under "Proven templates" subsection:
       - top template: <path> (locality: L1|L2|L3|none)
       - rationale: labels (commitCount, ageDays, bugFixRate)
       - reviewer: blameDominantAuthor (with note on locality semantics)
  4. If locality = "none", attach diagnostic so the plan reader knows
     this Task has no proven precedent in the project.
```

**`dinopowers:executing-plans` wire-in** — same hook, but at Task execute time,
before the actual code edit. Recipe call result is loaded into the session as
`tea-rags:data-driven-generation` Step 2 input directly, so DDG inside
executing-plans does not re-invoke the recipe.

### Component E — Eval coverage via `/optimize-skill`

**File (created later, not part of this spec's PR):**
`.claude-plugin/tea-rags/skills/extract-project-patterns/evals/cases.json`

Eval cases — written as part of TDD before the recipe is finalized:

| Case                     | L1 setup                            | Expected locality | Asserts                                        |
| ------------------------ | ----------------------------------- | ----------------- | ---------------------------------------------- |
| Healthy subdomain        | rich, old, low-bug L1               | `L1`              | top template returns; labels match ideal       |
| Starved subdomain        | new, sparse L1; rich domain         | `L2`              | L1 gate fails, L2 succeeds, annotation correct |
| Fragmented domain        | sparse L1 + sparse L2; rich project | `L3`              | L1 + L2 fail, L3 succeeds                      |
| Empty project            | no proven chunks anywhere           | `none`            | diagnostic returned, no fabrication            |
| Shallow L1 (≤2 segments) | L1 = `**/chunker/hooks/**`          | `L1` or `L3`      | L2 step skipped, no double L1 call             |
| Behavior-query only      | no positiveIds / positiveCode       | works at L1/2/3   | semantic_search path used                      |

Each case is a fixture + expected output. `/optimize-skill` runs the recipe
against fixtures via parallel subagents and measures pass rate. Iteration
target: 100% on first stable build.

### Data flow

```
caller (DDG Step 2, or dinopowers:writing-plans per Task)
  │
  │ inputs: positiveIds|positiveCode|behaviorQuery, pathPatternL1
  ▼
tea-rags:extract-project-patterns
  │
  ├─ Pass L1  find_similar(rerank="proven", pathPattern=L1)
  │            └─ gate → top? return + locality=L1
  ├─ Pass L2  find_similar(rerank="proven", pathPattern=first2segs)
  │            └─ gate → top? return + locality=L2
  ├─ Pass L3  find_similar(rerank="proven", pathPattern=null)
  │            └─ gate → top? return + locality=L3
  └─ none → diagnostic
  │
  ▼
caller reads { templates, locality, diagnostics }
  │
  ├─ DDG: feeds into Step 3 STYLE + Step 4 GENERATE
  ├─ writing-plans: attaches to Task body
  └─ executing-plans: loads into session as DDG Step 2 result
```

### Trade-offs

**Pro.**

- Single source of truth: `ProvenPreset` weights in code, locality cascade in
  one SKILL.md. Drift impossible.
- Three-level cascade preserves locale context where available (L1), expands to
  domain when starved (L2), falls back to whole project when truly needed (L3).
  Matches user's request literally.
- L2 = first 2 segments — deterministic, no path-convention magic, no
  measurement overhead, no project config.
- Recipe is reusable across DDG, writing-plans, executing-plans. New consumers
  (e.g. a future "refactoring" skill) get the cascade for free.
- Eval-covered. `/optimize-skill` gives regression confidence; future threshold
  tuning has a baseline.

**Con.**

- Up to 3× find_similar calls when L1 + L2 both fail. Acceptable: chunk-id based
  find_similar is cheap (scroll, no embedding work). L2 = L1 case collapses to 2
  passes max.
- L2 = "first 2 segments" produces under-broadening for some projects (a plain
  `**/auth/**` project with L1 = `**/auth/**` collapses L2 to L1). Accepted: L2
  → L3 cascade still works; the L2 layer is best-effort.
- New skill adds plugin surface (one more SKILL.md to maintain). Mitigated by
  clear ownership and eval coverage.

### Alternatives considered

| Alternative                                     | Why rejected                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Inline cascade in DDG only (no separate skill)  | Loses reuse for writing-plans / executing-plans. Would force duplication of cascade logic.                       |
| Two-level cascade (L1 + L3, drop L2)            | User explicitly asked for three levels. Skipping L2 frequently sends similar requests straight to project scope. |
| Adaptive walk-up to "domain root" markers       | Project conventions vary too widely. No reliable marker list.                                                    |
| Chunk-count adaptive strip (×5 threshold)       | Adds 1-3 count_chunks calls per invocation. Threshold is itself a magic constant.                                |
| Explore returns all 3 pathPatterns              | Couples explore PG-OUTPUT contract to extract-project-patterns internals. Recipe should own its locality logic.  |
| Separate `proven` preset class for find_similar | Two presets, identical weights = drift. Single-line `tools[]` extension is cleaner.                              |

## Testing

### Unit

- `tests/core/domains/trajectory/git/rerank/presets/proven.test.ts` — assert
  `ProvenPreset.tools.includes("find_similar")` (extend or create).
- `SchemaBuilder.buildRerankSchema("find_similar")` enumeration includes
  `"proven"`.

### Skill behavior — eval-driven

Eval cases listed under Component E. `/optimize-skill extract-project-patterns`
runs them via parallel subagents; success criterion = 100% pass on stable build.
Iteration cycle handles description tuning, edge-case discovery, and threshold
refinement.

### Manual MCP test sequence (per `.claude/rules/.local/mcp-testing.md`)

1. `npm run build && npm test`
2. Request MCP reconnect.
3. Pick a chunk in a sparse subdomain (e.g. a freshly-added file inside
   `domains/trajectory/git/rerank/derived-signals/`) and call `find_similar`
   with `rerank: "proven"` — verify schema accepts it.
4. Manually drive extract-project-patterns recipe (read SKILL.md, simulate
   inputs) and walk through L1 → L2 → L3 for known healthy / starved subdomains
   in the tea-rags repo itself. Cross-check locality annotations against
   expectations.

## Affected files

| File                                                                       | Change                                       | Plugin bump          |
| -------------------------------------------------------------------------- | -------------------------------------------- | -------------------- |
| `src/core/domains/trajectory/git/rerank/presets/proven.ts`                 | `tools[]` += `"find_similar"`                | —                    |
| `tests/core/domains/trajectory/git/rerank/presets/proven.test.ts`          | Assert tools[] membership                    | —                    |
| `.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md` (new)   | New recipe skill                             | tea-rags **minor**   |
| `.claude-plugin/tea-rags/skills/extract-project-patterns/evals/cases.json` | Eval fixtures                                | tea-rags **minor**   |
| `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`           | Step 2 delegates to extract-project-patterns | tea-rags **minor**   |
| `.claude-plugin/tea-rags/.claude-plugin/plugin.json`                       | minor bump                                   | tea-rags **minor**   |
| `.claude-plugin/dinopowers/skills/writing-plans/SKILL.md`                  | Wire-in per code-gen Task                    | dinopowers **patch** |
| `.claude-plugin/dinopowers/skills/executing-plans/SKILL.md`                | Wire-in per Task execute                     | dinopowers **patch** |
| `.claude-plugin/dinopowers/.claude-plugin/plugin.json`                     | patch bump                                   | dinopowers **patch** |

## Out of scope

- Changing `proven` preset weights, overlayMask, or signalLevel.
- Extending the cascade beyond 3 levels.
- Path-convention heuristics (adaptive walk-up, domain-root markers).
- Restructuring `tea-rags:explore` PG-OUTPUT format. The pathPattern field
  contract stays as-is.
- New rerank presets. `proven` covers the recipe's needs.

## References

- Recipe template: `.claude-plugin/tea-rags/skills/tests-as-context/SKILL.md`
- Recipe template (lighter):
  `.claude-plugin/tea-rags/skills/pattern-search/SKILL.md`
- Current DDG skill:
  `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`
- Preset: `src/core/domains/trajectory/git/rerank/presets/proven.ts`
- Explore PG output contract:
  `.claude-plugin/tea-rags/skills/explore/references/pre-gen-pattern.md`
- Schema builder: `src/mcp/tools/schemas.ts` `findSimilarRerankSchema`
- Naming conventions: `.claude/CLAUDE.md` "Don't Generate — Interrogate"
- Plugin versioning: `.claude/rules/plugin-versioning.md`
- Eval optimization workflow: `.claude/agents/optimize-skill.md`
- Dinopowers wrapper pattern:
  `.claude-plugin/dinopowers/skills/writing-plans/SKILL.md`
