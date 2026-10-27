---
name: refactoring-scan
description:
  "Internal step invoked by $bug-hunt, $explore, $refactoring-planning,
  $risk-assessment. Multi-preset breadth-first scan for refactoring candidates."
---

# Refactoring Scan

Multi-preset breadth-first scan for refactoring candidates. Explore invokes on
broad-scope antipattern / refactoring intent (no specific entity).

**Not here:** bug intent ("find bugs in X", "найди баги", "what's broken in X"),
with or without a symptom → `bug-hunt` (named file / symbol = its scope).
Refactoring candidates ≠ defects.

**Trigger examples:**

- "what to refactor in explore"
- "cleanup ingest domain"
- "what needs refactoring across the project"
- "decomposition candidates in src/"

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **Tool choice + stop conditions from `tea-rags://guide/decision-tree`** —
   pass query + rerank + pathPattern, tree picks tool; gradient-drop /
   diminishing-returns / cross-preset rules, NO absolute score thresholds.
3. **No text search (shell grep -rl) for code discovery** — tea-rags tools; text
   search only for literal text (identifiers → `hybrid_search`).
4. **`limit=10` per preset = hard cap.** A preset returned more ("50 results —
   take all?") → no: keep the top results up to 10, cut earlier at a gradient
   drop / diminishing returns, never by an absolute score; SCAN never pages
   (`offset`) or raises `limit`.
5. **`metaOnly=false` on every scan call.** Asked for `metaOnly=true` "to save
   context" → refuse, print
   `metaOnly=false stays: ENRICH classifies Tier 1 from chunk content; 3 × 10 chunks fit`.

Lag / drift ≠ licence to leave tea-rags (core). Own checkout, `changedFiles` > 0
→ incremental `index_codebase`; subagent / linked worktree → never reindex. →
`tea-rags://guide/freshness`.

## Flow

```
1. SCAN — 3 presets via `tea-rags://guide/decision-tree`
2. MERGE — cross-reference by symbolId
3. ENRICH — Tier 1: read code, classify
4. OUTPUT — tiered table
```

### 1. SCAN

Scope words → ONE pathPattern (`<dir> domain` → `**/<dir>/**`, a path → that
path; whole project → none), passed to ALL three calls. The plan prints:

```
SCOPE pathPattern=<resolved glob | none — whole project>
1. <tool>(query=<$ARGUMENTS>, pathPattern=<resolved>, rerank="refactoring", filter={presets:"godMethods"}, limit=10, metaOnly=false)
2. same, rerank="decomposition"
3. same, rerank="hotspots"
```

`<tool>` from the decision tree. After EACH preset, before the next, check its
results against `tea-rags://guide/pagination` and print
`VALIDATE <preset>: disambiguation <one dominant dir group > 70% | 2+ unrelated groups → ask / narrow pathPattern>; no-match <score spread, lexical overlap, path clustering: ok | no match → stop, say so>`.

| Preset          | What it surfaces                                           |
| --------------- | ---------------------------------------------------------- |
| `refactoring`   | Large chunks + high churn — mechanical refactor candidates |
| `decomposition` | Oversized functions/classes — split candidates             |
| `hotspots`      | High churn + recent activity — stability risks             |

#### Filter presets (each scan call)

`filter: { presets: "godMethods" }` on all three (behavioral god-method chunks
pre-rerank → better signal/noise). Purely structural scan (no query, narrow
scope) → `filter: { presets: "coreLogic" }` (function/class chunks only).
`{presets}` ANDs w/ `pathPattern`.

**Empty-widen rule.** Query present AND all three `godMethods` scans empty →
re-run three presets w/ `filter: { presets: "coreLogic" }`, note in output:
`> strict filter (godMethods) returned no results — widened to coreLogic`.

### 2. MERGE

Print `MERGE key: symbolId (missing → relativePath + startLine)` — never by file
path alone or line-range overlap (loses symbol granularity).

| Overlap | Tier   | Meaning                                    |
| ------- | ------ | ------------------------------------------ |
| 3/3     | Tier 1 | High-value: large + churny + hot           |
| 2/3     | Tier 2 | Medium-value: two signals converge         |
| 1/3     | Tier 3 | Low-value: single signal, may not be worth |

### 3. ENRICH

**Tier 1 only.** Code already in results (metaOnly=false). Classify:

| Type              | Indicator                                           |
| ----------------- | --------------------------------------------------- |
| **Dead code**     | Unused methods, unreachable branches                |
| **God function**  | Single method > 80 lines, multiple responsibilities |
| **Duplication**   | Near-identical logic across files/modules           |
| **Complex logic** | Deep nesting, long condition chains                 |
| **Naming**        | Misleading names, inconsistent conventions          |

**Naming** = lexicon verdict, not taste (codegraph on = graph tools in tool
list):
`get_naming_lexicon(names=<Tier 1 identifiers>, language, pathPattern=<scope>)`,
one call per language (evidence never crosses languages) → `MISFIT` = Naming
candidate, Action `rename to <suggestion>`; `CONFORMS` = not candidate — line
per identifier:
`NAMING <identifier> — MISFIT → rename to <suggestion> | CONFORMS → not a candidate`.
Never judge a name from the code alone while codegraph is on. Codegraph off →
Naming only w/ cited in-scope precedent. Extra seeds:
`get_ontology_report(pathPattern=<scope>, sections=["outliers","synonyms"])` —
each outlier / synonym deviant = Naming candidate, Action
`rename to <dominant.name>`.

### 4. OUTPUT

```
Refactoring scan: [scope]
Found: [N] candidates across [M] modules

## Tier 1 — High Value (appears in 3/3 presets)

| # | Symbol | File:Line | Type | Lines | Action |
|---|--------|-----------|------|-------|--------|
| 1 | Reranker.rerank() | reranker.ts:76 | god function | 72 | split into phases |
| 2 | ... | ... | ... | ... | ... |

## Tier 2 — Medium Value (appears in 2/3 presets)

| # | Symbol | File:Line | Presets | Lines |
|---|--------|-----------|---------|-------|
| 1 | ... | ... | refactoring+hotspots | ... |

## Tier 3 — Low Value (single preset only)

[count] candidates — omitted; paginate on request
```

Tier 3 = count line only, also when the prompt states the count ("Tier 3=40") —
a count is not a request for rows. Rows only on a later explicit "show Tier 3" →
paginate with `offset`.
