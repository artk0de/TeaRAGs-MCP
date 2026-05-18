# data-driven-generation: project-wide proven templates with locale fallback

**Status:** Proposed **Date:** 2026-05-18 **Affects plugins:** tea-rags (patch)
**Affects code:** `src/core/domains/trajectory/git/rerank/presets/proven.ts`
**Beads epic:** `tea-rags-mcp-vr7v`

## Motivation

`tea-rags:data-driven-generation` (DDG) Step 2 TEMPLATE selects a battle-tested
reference implementation as input for code generation. Today it inherits the
`pathPattern` produced by `tea-rags:explore` PG-OUTPUT (typically a subdomain
glob like `**/chunker/hooks/**`) and passes it into `find_similar` together with
inline custom weights:

```
{ similarity: 0.2, stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05 }
```

This produces two problems:

1. **Subdomain starvation.** When the target subdomain is young, sparse, or
   under active churn, no chunk passes the quality gate (commitCount low/typical
   - ageDays old/legacy + bugFixRate healthy). The agent either degrades to a
     noisy reference or fabricates a pattern from training data. Both regress
     the code-quality intent of DDG.

2. **Drift from project preset registry.** A first-class `ProvenPreset` already
   exists in `src/core/domains/trajectory/git/rerank/presets/proven.ts` with
   weights numerically equivalent (modulo `knowledgeSilo` vs `ownership` —
   semantically preferable per its docstring). The skill's inline copy is a
   second source of truth that can drift, and it cannot be reused by other
   skills or by direct MCP tool calls.

## Design

### Overview

Rewrite DDG Step 2 (TEMPLATE) as a **two-pass cascade**:

1. **Pass A — locale.** `find_similar` with `pathPattern` from explore PG-OUTPUT
   and `rerank: "proven"`.
2. **Quality gate.** Count chunks whose overlay labels match the ideal profile.
   If ≥ 2 chunks qualify → use the top result. Otherwise → Pass B.
3. **Pass B — project fallback.** Same `find_similar` call with
   `pathPattern: null` and the same `rerank: "proven"`. Apply the same gate.
4. **Reject filter.** Unchanged from current SKILL.md:
   `bugFixRate "critical" OR (ageDays "recent" + commitCount "low")`.

Inline custom weights in SKILL.md are removed. The named preset `proven` becomes
the single source of truth.

### Component A — `ProvenPreset.tools[]` extension

**File:** `src/core/domains/trajectory/git/rerank/presets/proven.ts`

Current:

```ts
readonly tools = ["semantic_search", "hybrid_search", "search_code"];
```

Updated:

```ts
readonly tools = ["semantic_search", "hybrid_search", "search_code", "find_similar"];
```

**Why:** `schemaBuilder.buildRerankSchema("find_similar")` filters presets by
`tools[]` membership. Without this change, `rerank: "proven"` on a
`find_similar` call is rejected at schema validation. The preset's semantics
("battle-tested code as reference / template") are identical for find_similar —
in fact find_similar is the natural way to consume it, since the agent already
has the relevant chunk in hand from cascade Step 1.

No weights, overlayMask, or signalLevel change. No new file. Single-line edit.

### Component B — `SKILL.md` Step 2 TEMPLATE rewrite

**File:** `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`

Replace lines 70-83 (the `### Step 2: TEMPLATE` section through "Reject" gate)
with the two-pass cascade described in Overview. Concrete shape:

```
### Step 2: TEMPLATE

Use named preset `proven` (registered in code). Two-pass cascade:

#### Pass A — locale
find_similar(
  positiveIds | positiveCode = <best verified result from cascade Step 1>,
  pathPattern = <from explore PG-OUTPUT>,
  rerank = "proven",
  limit = 10,
)

Quality gate by labels (counted across results):
  Ideal = commitCount "low"/"typical"
          + ageDays "old"/"legacy"
          + bugFixRate "healthy"
  ≥ 2 ideal → use top, proceed to Step 3.
  < 2 ideal → Pass B.

#### Pass B — project fallback
find_similar(
  <same positiveIds | positiveCode>,
  pathPattern = null,                      ← project-wide
  rerank = "proven",
  limit = 10,
)
Same quality gate.

#### Reject (unchanged)
bugFixRate "critical" OR (ageDays "recent" + commitCount "low")

#### Output annotation
If Pass B was used at all (Pass A empty OR Pass A failed the gate),
emit one line:
  "locale templates unavailable / did not pass gate; reference taken from <path>"
so downstream Step 3 (STYLE) knows the template is cross-subdomain and
adjusts blame-author lookup accordingly.

#### Semantic fallback (when positiveIds/positiveCode are unavailable)
Search-cascade with behavior query + rerank="proven". Same two-pass shape:
locale (pathPattern) first, then project-wide.
```

The "Ideal / Reject" thresholds are unchanged from the current skill. Only the
orchestration and the preset name change.

### Data flow

```
explore PG-OUTPUT
  ├─ files
  ├─ pathPattern        ┐
  └─ overlay labels     │
                        ▼
                  DDG Step 2 Pass A
                  find_similar(pathPattern=…, rerank="proven")
                        │
              ┌─ pass ──┴── fail ─┐
              │                    │
         use top              Pass B
              │           find_similar(pathPattern=null, rerank="proven")
              │                    │
              │           ┌─ pass ─┴── fail ─┐
              │           │                   │
              │      use top + log       semantic fallback
              │           │           (behavior query, same two-pass)
              └───────────┴───────────────────┘
                          ▼
                  Step 3 STYLE
                  (blame-based author lookup —
                   uses template's blameDominantAuthor,
                   which may now belong to a different subdomain)
```

### Edge cases

| Situation                           | Behavior                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Pass A returns 0 results            | Skip gate, go directly to Pass B                                                 |
| Pass B returns 0 results            | Run semantic fallback (behavior query, two-pass)                                 |
| Semantic fallback also empty        | Diagnostic: "no proven templates for X in this project; generating from scratch" |
| All Pass B results are rejected     | Same diagnostic; do NOT silently substitute rejected code                        |
| `positiveCode` only (no chunk id)   | Both passes work; find_similar embeds on the fly                                 |
| explore did NOT provide pathPattern | Pass A becomes equivalent to Pass B; skip Pass B (idempotent)                    |

### Trade-offs

**Pro.**

- Single source of truth: `ProvenPreset` weights live in code, the skill
  references them by name. Drift impossible.
- Locale-first preserves contextual fit (architectural conventions vary across
  subdomains — using a same-subdomain template avoids unsolicited
  cross-subdomain style transfer).
- Project-wide fallback removes the "starved subdomain" failure mode where DDG
  had no choice but to use a low-quality reference or invent one.
- Named preset becomes reusable: other skills (or direct MCP calls) can request
  `rerank: "proven"` and inherit the same calibrated weights / overlay.

**Con.**

- Up to 2× find_similar calls when Pass A fails the gate. Acceptable: chunk-id
  based find_similar is cheap (scroll, no embedding work).
- Pass B can surface a template from a structurally distant subdomain (e.g. a
  builder pattern from `ingest/` while editing in `trajectory/`). Mitigated by
  similarity weight 0.2 in `proven` plus positiveIds/positiveCode carrying the
  local chunk as semantic anchor.
- Step 3 STYLE's blame-author lookup will now sometimes name an author from a
  different subdomain. The output annotation makes this explicit so the user
  understands "this owner reviews the technique, not the immediate code".

### Alternatives considered

| Alternative                                           | Why rejected                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-pass project-wide (drop pathPattern entirely)  | Loses local-context fit. User's correction during brainstorming explicitly preferred locale-first.                                                                                                                                    |
| Keep inline custom weights in SKILL.md                | Drift between skill and code. Cannot be reused by other skills.                                                                                                                                                                       |
| Replace `find_similar` with `semantic_search`         | Loses "templates by code shape" semantics. find_similar uses the chunk as positive vector — that is exactly the right query for "find more code that looks like this proven exemplar".                                                |
| Separate `proven` preset for find_similar (new class) | Two presets with identical weights = drift. The existing preset's docstring already calls out template/reference use cases as primary; adding find_similar to tools[] is alignment, not change.                                       |
| Quality-gate threshold ≥ 1 instead of ≥ 2             | Single qualifying chunk is a thin signal; one statistical outlier defeats the locale-first goal. ≥ 3 too conservative for small subdomains. ≥ 2 chosen by analogy to the "≥ 3 commits" heuristic class used elsewhere in DDG signals. |

## Testing

### Unit

- `tests/core/domains/trajectory/git/rerank/presets/proven.test.ts` — extend (or
  create if missing) to assert `ProvenPreset.tools.includes("find_similar")`.
- Verify `SchemaBuilder.buildRerankSchema("find_similar")` enumeration includes
  `"proven"` (integration with composition).

### Skill behavior

SKILL.md changes are text-only and tested empirically via `optimize-skill` evals
if regression risk is observed. No unit test for the two-pass cascade itself —
orchestration is agent-driven, not code-driven.

### Manual MCP test sequence (per `.claude/rules/.local/mcp-testing.md`)

1. `npm run build && npm test`
2. Request MCP reconnect.
3. From a chunk in a sparse subdomain (e.g. a freshly-added file), invoke
   `find_similar` with `rerank: "proven"` — verify it is accepted and returns
   results with the `proven` overlay (file: ageDays, commitCount, bugFixRate,
   blameContributorCount).
4. Repeat with `pathPattern` set to the same subdomain — verify locale results
   are filtered as expected.

## Affected files

| File                                                              | Change                                       | Plugin bump        |
| ----------------------------------------------------------------- | -------------------------------------------- | ------------------ |
| `src/core/domains/trajectory/git/rerank/presets/proven.ts`        | `tools[]` += `"find_similar"`                | —                  |
| `tests/core/domains/trajectory/git/rerank/presets/proven.test.ts` | Assert tools[] membership (extend or create) | —                  |
| `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`  | Step 2 TEMPLATE rewrite (two-pass cascade)   | tea-rags **patch** |
| `.claude-plugin/tea-rags/.claude-plugin/plugin.json`              | version bump                                 | tea-rags **patch** |

## Out of scope

- Changing `proven` preset weights, overlayMask, or signalLevel.
- Extending the cascade to a third pass (e.g. cross-language).
- Restructuring `tea-rags:explore` PG-OUTPUT format. The pathPattern field
  contract stays as-is.
- Step 1 STRATEGY SELECTION, Step 3 STYLE, Step 4 GENERATE, Step 5 VERIFY, Step
  6 IMPACT — untouched.

## References

- Skill: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`
- Preset: `src/core/domains/trajectory/git/rerank/presets/proven.ts`
- Explore PG output contract:
  `.claude-plugin/tea-rags/skills/explore/references/pre-gen-pattern.md`
- Schema builder: `src/mcp/tools/schemas.ts` `findSimilarRerankSchema`
- Naming conventions: `.claude/CLAUDE.md` "Don't Generate — Interrogate"
- Plugin versioning: `.claude/rules/plugin-versioning.md`
