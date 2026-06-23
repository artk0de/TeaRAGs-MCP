# Dinopowers codegraph presence/fallback — tool-selection eval (with rule, fixed)

Series: dinopowers-codegraph-series / iteration-1
Mode: DESCRIBE only (no tool execution).

Environments:
- ENV-A prime `## Enrichment`: `git: file healthy, chunk healthy` (no `codegraph.symbols`).
  Tools: semantic_search, rank_chunks, find_symbol, hybrid_search, find_similar, ripgrep, Read.
  → codegraph OFF: `blastRadius`/`architecturalHub` presets are callable but their fan-graph
  signals (`fanIn`, `isHub`) are absent; graph TOOLS (get_callers/find_cycles/trace_path) NOT registered.
- ENV-B prime `## Enrichment`: `git: ...` + `codegraph.symbols: file healthy, chunk healthy`.
  Tools: ENV-A + get_callers, get_callees, find_cycles, trace_path.
  → codegraph ON: `fanIn`/`isHub` populated; graph tools registered.

---

CASE 1 (writing-plans [ENV-B]):
- enrichment rerank/tool: ONE `semantic_search`, `rerank: "blastRadius"`, brace-expanded `pathPattern` over the qdrant-adapter file set + its caller files, `metaOnly: true`, `limit: fileList*3`. Plus Step 3.5 `tea-rags:extract-project-patterns` per code-gen Task.
- codegraph available? yes — prime lists `codegraph.symbols`; `fanIn` is real.
- what I TELL THE USER: per-file enrichment table flags high-blast files by real **fanIn** (true blast radius, not import-proxy). "src/core/adapters/qdrant/client.ts — fanIn N (real dependents)". Caller refactor Tasks ordered by shared taskIds; high-fanIn files isolated into dedicated Tasks with explicit tests. No "approximate" caveat — fanIn is exact.

CASE 2 (writing-plans [ENV-A]):
- enrichment rerank/tool: ONE `semantic_search`, fallback `rerank: { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (codegraph OFF → `blastRadius` fan signals gone), same brace-expanded `pathPattern`, `metaOnly: true`.
- codegraph available? no — `codegraph.symbols` absent; `fanIn` unavailable.
- what I TELL THE USER: blast radius shown via the **import-proxy (approximate)** — "high-blast files ranked by `imports` score, NOT real fanIn; import-count is a proxy, true call-graph dependents not assessed". Same Task-sequencing guidance (shared taskIds, isolate high-import files), but explicitly labelled approximate so the user knows the centrality claim is name/import-based, not edge-truth.

CASE 3 (executing-plans [ENV-B]):
- enrichment rerank/tool: pre-touch guard — ONE `semantic_search`, `rerank: "blastRadius"`, `pathPattern: "{chunker.ts}"` (Task-local resolved from src/core/domains/ingest/pipeline/chunker.ts), `metaOnly: true`. Verdict ladder SAFE/CAUTION/UNSAFE off `imports`(fanIn)/bugFixRate/silo labels. Step 4.5/5 cascade if Task is code-gen.
- codegraph available? yes — `fanIn` feeds the imports-score input to the verdict ladder (real dependents).
- what I TELL THE USER: per-Task guard block with verdict; blast input is real **fanIn**. e.g. "Task 3 verdict CAUTION/UNSAFE — chunker.ts fanIn N (real dependents) + bugFixRate label". Gate: SAFE proceeds, CAUTION waits for confirm, UNSAFE pauses. fanIn flagged as exact, not import-proxy.

CASE 4 (executing-plans [ENV-A]):
- enrichment rerank/tool: pre-touch guard — ONE `semantic_search`, fallback `rerank: { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (codegraph OFF), `pathPattern: "{chunker.ts}"`, `metaOnly: true`. Same SAFE/CAUTION/UNSAFE ladder, blast input from `imports` proxy.
- codegraph available? no — `fanIn` absent; verdict uses `imports` proxy.
- what I TELL THE USER: per-Task verdict block, but blast dimension is **import-proxy (approximate)** — "chunker.ts verdict from `imports` score, churn, ownership; real call-graph fanIn not available, so the blast-radius input is approximate". Same gating semantics; the caveat is that UNSAFE/CAUTION on the blast axis rests on import-count, not exact dependents.

CASE 5 (verification-before-completion [ENV-B]):
- enrichment rerank/tool: collateral-damage scan — ONE `semantic_search`, `rerank: "blastRadius"`, brace-expanded `pathPattern` over `git diff --name-only` (reranker.ts + 2 callers), `metaOnly: true`. Plus Step 3a `tea-rags:tests-as-context` recipe `tests-at-risk`. Then chain `superpowers:verification-before-completion`.
- codegraph available? yes — blast read from real **fanIn** (true dependents).
- what I TELL THE USER: HIGH/MEDIUM/LOW-BLAST verdict per edited file off **fanIn**. e.g. "reranker.ts HIGH-BLAST — fanIn N real dependents → run tests covering those dependents, not just reranker's own". Targeted scenarios from tests-at-risk. fanIn flagged as exact; verification scope = real dependents.

CASE 6 (verification-before-completion [ENV-A]):
- enrichment rerank/tool: collateral-damage scan — ONE `semantic_search`, fallback `rerank: { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (codegraph OFF), `pathPattern` over diff files, `metaOnly: true`. Step 3a tests-at-risk still runs.
- codegraph available? no — blast read from `imports` proxy (ladder explicitly reads `imports` when codegraph off).
- what I TELL THE USER: HIGH/MEDIUM/LOW-BLAST verdict, but blast = **import-proxy (approximate)** — "reranker.ts ranked HIGH-BLAST by `imports` count, NOT real fanIn; verify dependents found via import-proxy, true call-graph dependents not assessed". Same prescriptive "verify dependents" recommendation, labelled approximate.

CASE 7 (brainstorming [ENV-B]):
- enrichment rerank/tool: FOUR parallel `semantic_search` calls, `pathPattern` over `domains/ingest/**` (enrichment coordinator area), `metaOnly: true`, `limit: 10`: A `"hotspots"`, B `"ownership"`, C `"techDebt"`, **D `"architecturalHub"`** (codegraph-gated). Then chain `superpowers:brainstorming`.
- codegraph available? yes — Call D runs; `architecturalHub` has real `fanIn`/`isHub`.
- what I TELL THE USER: 4-lens enrichment block including a **structural backbone** section — "coordinator is/contains hub X by real fanIn/isHub; redesign must respect wide blast radius". Hotspots/silos/tech-debt as usual. Backbone IS assessed (do not omit Call D).

CASE 8 (brainstorming [ENV-A]):
- enrichment rerank/tool: THREE parallel `semantic_search` calls only — A `"hotspots"`, B `"ownership"`, C `"techDebt"`; **omit Call D** (`architecturalHub` fan signals gone with codegraph OFF). Same `pathPattern`, `metaOnly: true`, `limit: 10`.
- codegraph available? no — Call D dropped per the skill's codegraph gate.
- what I TELL THE USER: 3-lens enrichment block, and explicitly **"structural backbone was NOT assessed"** (codegraph off; do NOT substitute a similarity-ranked list as "the hubs"). Hotspots/silos/tech-debt drive the brainstorm; structural-hub blast radius is flagged as unknown.

CASE 9 (requesting-code-review [ENV-B]):
- enrichment rerank/tool: ONE `semantic_search`, custom `rerank: { imports: 0.5, churn: 0.3, ownership: 0.2 }` (this skill uses custom weights for the ownership/churn/taskIds bundle, NOT `blastRadius`), brace-expanded `pathPattern` over diff files (AppConfig + 3 services), `metaOnly: true`. Plus **Step 2.5 reviewer-hub**: `find_symbol` to resolve changed symbol ids → `get_callers` for the affected callers. Plus Step 3a tests-at-risk.
- codegraph available? yes — `get_callers` registered; Step 2.5 runs.
- what I TELL THE USER: reviewer-context bundle (per-file owner/contributors/churn/taskIds/bugFixRate) PLUS an **"Affected callers / suggested reviewers"** line — callers of the changed AppConfig/service symbols and their blameDominantAuthors looped in as stakeholders. Caller-impact computed (not "not assessed").

CASE 10 (finishing-a-development-branch [ENV-B]):
- enrichment rerank/tool: delegate to `Skill(tea-rags:risk-assessment)` over the full branch diff (`pathPattern` brace-expanded over `git diff base...HEAD`), NOT ad-hoc `semantic_search`. risk-assessment converges hotspots+ownership+techDebt; with codegraph ON its structural axis runs automatically — `architecturalHub` amplifier + **`find_cycles`** over branch-diff scope.
- codegraph available? yes — structural axis active; cycle detection runs.
- what I TELL THE USER: branch completion scan with tier-classified risks (Critical/High/Medium) AND a **"Structural risks"** section — blast-radius hubs the branch touches + any **circular dependencies the branch introduces/touches** (a new cross-module cycle is a merge-blocker even with clean git signals). Recommendation (ready-to-merge / address-critical-first / needs-review-pairing) factors cycles in. NOT "no cycles" by default — cycles actively assessed because codegraph is on.

---

## Pass/fail self-check against the fixed rule

| Case | Env | Expected surface | Expected fallback flag | Verdict |
|---|---|---|---|---|
| 1 | B | blastRadius (real fanIn) | none — exact | PASS |
| 2 | A | custom imports/churn/ownership | "import-proxy approximate", fanIn not assessed | PASS |
| 3 | B | blastRadius guard (real fanIn) | none — exact | PASS |
| 4 | A | custom-weight guard | "import-proxy approximate" | PASS |
| 5 | B | blastRadius scan (real fanIn) | none — exact | PASS |
| 6 | A | custom-weight scan | "import-proxy approximate" | PASS |
| 7 | B | hotspots+ownership+techDebt + architecturalHub (Call D) | backbone assessed | PASS |
| 8 | A | hotspots+ownership+techDebt only | "structural backbone NOT assessed", no fake hubs | PASS |
| 9 | B | custom ownership bundle + get_callers reviewer-hub | caller-impact computed | PASS |
| 10 | B | risk-assessment + structural axis + find_cycles | cycles actively assessed (not "no cycles") | PASS |

All 10 cases route correctly under the fixed codegraph-presence/fallback rule:
ENV-B reaches for the codegraph surface (blastRadius real fanIn / architecturalHub
Call D / get_callers reviewer-hub / find_cycles), ENV-A falls back to the
import-proxy custom weights and explicitly flags the OFF state
("import-proxy approximate", "structural backbone not assessed") without ever
fabricating a fan-graph fact.
