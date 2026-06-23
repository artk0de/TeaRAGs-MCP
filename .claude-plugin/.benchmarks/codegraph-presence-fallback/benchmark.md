# Benchmark — codegraph-presence-fallback

Bead **tea-rags-mcp-3hkuy**. Cross-cutting correctness pass so skills that route
to codegraph graph-tools detect codegraph availability from the **prime digest**
and fall back to non-codegraph routes (or honest "unavailable") when codegraph
is OFF — without falsely claiming "no cycles", dropping a hypothesis, or naming
an architectural centre they cannot measure.

## Summary

| Metric | Value |
| --- | --- |
| Scope (decided) | Full cross-cutting: `search-cascade.md` (canon) + `explore` SKILL + 4 patterns + `bug-hunt` + `systematic-debugging` + `receiving-code-review` |
| Eval cases | 13 (6 audit-finding OFF, 5 controls ON, 2 subagent-context, incl. 1 non-English) |
| with-rule (current) | 13/13 (100%) |
| without-rule baseline | 12/13 (92%) — case 3 ripgrep-first |
| with-rule (FIXED) | 13/13 (100%), no ON-control regression |
| Behavioral delta (Opus-class) | +8pp — concentrated on fallback route quality, NOT on the audited false-claims |

## Key finding — registration gating reframes the premise

`src/mcp/tools/codegraph.ts:128` gates the four graph tools at registration:
`if (!app.hasProvider("codegraph.symbols")) return;`. When codegraph is OFF the
tools are **not registered** — absent from the tool list, NOT returning empty.

Consequence measured by the honest eval (raw prime block + per-ENV tool list, no
editorial hint): an Opus-class agent trivially infers "graph facts not
computable" from tool absence and **refuses** the dangerous false-claims the
audit hypothesized (F2 false-DAG, F3 drop-hypothesis). Both with-rule and
without-rule arms passed those cases. The audit's premise — that skills would
call a tool, get empty, and misreport — does not hold for a strong model under
registration gating.

The first eval run scored 100%/100% because the harness was **contaminated**
(the tool list told both arms "tools return empty when codegraph disabled" and
the prime was annotated "[NO codegraph.symbols — means OFF]"). The contaminated
run is archived at `workspace/iteration-1/contaminated-v1/`. The honest re-run
(graph tools simply absent from ENV-A, raw prime) is the reported baseline.

## What the fix actually delivers (decided scope: lean correctness-pass)

The value is instruction **correctness** + robustness for weaker subagent
models, not a measured Opus behavior gap:

| # | File | Change |
| --- | --- | --- |
| F1 | `search-cascade.md` Graph navigation | Added prime `codegraph.symbols` availability signal + a "When codegraph is off" per-intent fallback table (the canonical source). |
| F4 | `search-cascade.md` Fallback Chains | Split "Call path A→B" into codegraph-on (trace_path) vs codegraph-off (semantic/hybrid + manual) — the old fallback `get_callees` is itself codegraph-dependent. |
| F1 | `explore/SKILL.md` | "return empty for every input" → "not registered / absent from tool list"; check prime first. |
| F1 | `usage-pattern.md` | Same correction; "prime shows no codegraph.symbols ⇒ get_callers/get_callees not registered". |
| F2 | `cycle-pattern.md` | "empty = DAG" now gated on codegraph ON; when find_cycles is unregistered, empty is NOT a DAG — say cycle detection unavailable. |
| F5 | `architecture-pattern.md` | Added codegraph-off note distinct from no-hubs-in-scope; fan-in centrality unavailable, no false "architectural centre". |
| F5 | `entry-point-pattern.md` | Added codegraph-off note; relevance + chunkSize, flagged content-inferred. |
| F3 | `systematic-debugging.md` | Anti-pattern row "empty trace_path = structurally false → drop" gated on codegraph ON; when off, trace_path absent ≠ evidence, keep hypothesis. Step 3.5 precondition added. |
| F6 | `bug-hunt/SKILL.md` | trace_path chain step gated on codegraph ON; off ⇒ flat suspects only. |
| F6 | `receiving-code-review/SKILL.md` | Step 3.5 trace_path route gated on codegraph ON; off ⇒ stay with Step 2 fanIn. |

Plugin bumps (patch, text-only): tea-rags 0.26.0 → 0.26.1, dinopowers 0.17.5 → 0.17.6.

## Per-case verdicts (honest harness)

| Case | ENV | without-rule | with-rule current | with-rule FIXED |
| --- | --- | --- | --- | --- |
| 1 cycle-off-no-false-dag | A | PASS | PASS | PASS |
| 2 sysdebug-off-no-drop | A | PASS | PASS | PASS |
| 3 usage-off-fallback | A | FAIL (ripgrep-first) | PASS | PASS |
| 4 tracepath-off-fallback | A | PASS | PASS | PASS |
| 5 architecture-off | A | PASS | PASS | PASS |
| 6 bughunt-off-flat | A | PASS | PASS | PASS |
| 7 control-cycle-on | B | PASS | PASS | PASS |
| 8 control-usage-on | B | PASS | PASS | PASS |
| 9 control-tracepath-on | B | PASS | PASS | PASS |
| 10 edge-on-genuine-empty-dag | B | PASS | PASS | PASS |
| 11 edge-nonenglish-off | A | PASS | PASS | PASS |
| 12 subagent-explore-off | A | PASS | PASS | PASS |
| 13 subagent-taskagent-on | B | PASS | PASS | PASS |

## Honest limitations

- Delta is small for an Opus-class agent — tool-absence is self-evident. The fix
  is justified by correctness (the "returns empty" text was factually wrong) and
  by weaker-model robustness (subagents may run on haiku), which this Opus-only
  eval cannot fully measure.
- Eval tests INSTRUCTION CLARITY (tool selection plan), not live tool execution.
