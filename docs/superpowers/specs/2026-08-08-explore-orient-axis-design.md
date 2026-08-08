# Explore ORIENT phase + axis splitting + docs-as-hypothesis

Date: 2026-08-08 Status: approved (brainstorm session) Scope:
`.claude-plugin/tea-rags/` markdown only — no runtime code. Presets
(`entryPoint`, `onboarding`) and filters (`testFile`, `documentation`) already
exist in the registry; this design adds the agent-facing selection policy that
uses them.

## Problem

1. Entry-point discovery fires only on explicit "where does X start" intent
   (codegraph intent row 3). Broad exploration ("how is ingest organized",
   "introduce me to the project") gets no orientation step — BREADTH starts
   blind, without the flow skeleton entry points provide.
2. `search-cascade.md` has no stance on documentation truthfulness. Doc chunks
   compete with source chunks as equal evidence; drifted docs silently poison
   explanations.
3. Broad searches mix sources, tests, and docs in one result limit. The dominant
   class takes all slots — the same failure `polyglot-rule.md` fixed for
   languages.

## Decisions (with alternatives rejected)

### D1. ORIENT phase inside Explore Flow, gated by request target

Broad target (system / domain / directory) → ORIENT runs before BREADTH.
Named-symbol / narrow target → skipped entirely.

- codegraph on (prime lists `codegraph.symbols`):
  `semantic_search rerank="entryPoint"` over the scope — graph-confirmed
  composition roots.
- codegraph off: `rerank="onboarding"` (docs + stability + maturity, no graph
  signals) — best available starting ground, explicitly flagged
  content-inferred, not graph-confirmed.

Rejected: separate ONBOARD intent row ("I'm new here" phrases) — entry points
serve every broad exploration, not only self-declared newcomers. Rejected:
ORIENT for all EXPLAIN — pure overhead on point questions about known symbols.

`entry-point-pattern.md` (point question "where does X start") stays unchanged;
its relevance + chunkSize fallback is more honest than the onboarding preset for
a point entry question.

### D2. "Code is evidence, docs are hypothesis" principle in search-cascade

Docs = navigation + intent (why / what-for). Code = the only evidence of
behavior. Any behavioral claim sourced from a doc chunk that enters the final
answer must be verified against code (`find_symbol` / `hybrid_search`) first; on
conflict code wins and the drift is flagged explicitly. Questions ABOUT the docs
themselves are untouched — there the doc is the subject.

Rejected: hard prohibition on doc chunks in behavior answers — kills legitimate
ADR/design-intent use. Rejected: explore-only placement — bug-hunt, mr-review,
risk-assessment need the same stance; cascade is the selection-policy layer.

### D3. Axis splitting rule (sources / tests / docs)

New `rules/references/axis-splitting.md` (pattern: `polyglot-rule.md`) +
prohibited-pattern line in the cascade. Broad exploration splits queries per
axis via existing filters: sources
(`testFile: exclude, documentation: exclude`), tests (`testFile: "only"`), docs
(`documentation: "only"`).

Axis roles are fixed vocabulary: **sources = behavior truth**, **tests =
executable spec** (intent confirmed by execution; src↔test conflict → report
both facts), **docs = hypothesis / navigation**. Point questions don't split —
the axis is implied by the question.

Rejected: always-three-queries — ×3 cost when the answer needs one axis.
Rejected: explore-only placement — same reason as D2.

## Affected files

| File                                                 | Change                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `rules/search-cascade.md`                            | Principles: code-evidence/docs-hypothesis; 2 prohibited patterns; reference-files entry   |
| `rules/references/axis-splitting.md`                 | NEW — axis roles, filter recipes, when-not-to-split                                       |
| `skills/explore/SKILL.md`                            | ORIENT phase in Explore Flow, gate rule, codegraph on/off branches, axis order in BREADTH |
| `skills/explore/references/explain-pattern.md`       | Doc-claim verification + axis order in broad EXPLAIN output                               |
| `.claude-plugin/tea-rags/.claude-plugin/plugin.json` | minor bump (new rule file)                                                                |

All prose caveman-compressed (bodies/rules = ultra). `inject-rules.sh` needs no
change — it injects `rules/*.md` only; references are read on demand.

## Verification

Per `optimize-skill` feature-driven update rule: eval cases for the new behavior
(ORIENT gate on/off, axis splitting, docs-hypothesis) + regression controls
(point intents skip ORIENT, doc-subject questions unaffected,
entry-point-pattern intact). One with-skill subagent vs one baseline subagent,
tool-selection plans graded, iterate to 100% with-rule. Persist evals.json +
benchmark.md appendix under `.claude-plugin/.benchmarks/`.
