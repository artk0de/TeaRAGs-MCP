---
name: explore
description:
  "Use for broad code-structure investigations, cross-component flow or impact,
  examples, explicit pre-change investigation, or an explicit explore request.
  Not focused behavior questions or locating their implementation, definitions,
  or local contracts covered by core; not bugs, plans, or code-health audits."
---

# Explore

Answer the requested facts from the smallest sufficient source investigation.
Reuse core's routing/contracts and retained evidence. A follow-up alone does not
require another read. Known bodies/local contracts need only core navigation.

## Independent facts, one executor wave

Silently identify which requested facts lack evidence. For multiple independent
production topics, run
`semantic_search(metaOnly:true, level:"chunk", distinctFiles:true, testFile:"exclude", limit:3)`
per topic concurrently in ONE executor. Config/spec topics keep core's scoped
filename/text routes; requested test behavior uses `testFile:"include"` or
`"only"`, not production-only search. Fixture/replay lessons need
creation/sanitization AND replay semantics; a replay helper alone does not
establish recording safety. Fuse synonyms of the SAME concept in one query; do
not fuse unrelated questions into one shared top-k, which can cover only one
topic. Keep the behavior/domain in workflow queries. Do not replace a focused
query with a product/vendor name or inventory all files mentioning that vendor.
Retain useful anchors for each topic; expand only the uncovered topic.

Known targets and exact identifiers use core's direct lookup/usages routes. An
exact filename inventory is appropriate for config/spec files; search hits are
not proof of complete occurrence coverage. Reuse known argument schemas. An
unknown schema can be retrieved beside independent source work rather than
spending a response on schema introspection alone.

## Deliver only needed bodies

Read known method ids with `find_symbol(symbols:[...])`; otherwise use the file
outline, not a directory tour. Batch ready work, label results and inspect
errors. Directories remain separate; config/spec reads stay per-file.

All concurrent calls share the OUTER executor's output budget. Splitting a large
read into concurrent MCP batches does not give each batch its own outer budget.
Select methods instead of dumping containing classes or several full file
groups. When every selected body is needed, allow enough outer output to deliver
them: set the executor's combined budget, not only each nested command. With
`functions.exec`, use its documented `// @exec: {"max_output_tokens": 20000}`
control for a needed large wave. If the cap cannot fit them, split the wave.
Never truncate silently or reread the entire batch to recover an omitted
portion. Fresh delivered bodies are authoritative; metadata, outlines, headers
and blocked/omitted bodies are not. Follow only needed missing continuations.

## Choose detail by the actual question

A contract needs production dispatch names and argument shapes, not every
implementation's internals. Group repeated dispatches by required member; do not
recurse into implementations/helpers after their required interface is proved.
For model overviews use current entities, relationships and keys; read
historical migrations only for requested physical DDL/history or an unresolved
model fact. Factual ports/registration/model/lessons do not require hub ranking
or templates. Graph closes a missing trigger/caller/flow fact, not a body's
explicit selection. Stop once all requested facts have proof.

Load a reference only for a requested methodology or a gap it resolves:

- Entry-point/hub centrality or structural dependency investigation:
  [architecture-pattern](./references/architecture-pattern.md); a plain factual
  overview does not need its prescribed ranking passes.
- Detailed usage/impact: [usage-pattern](./references/usage-pattern.md);
  unavailable graph: [trace-pattern](./references/trace-pattern.md).
- Explicit cycles: [cycle-pattern](./references/cycle-pattern.md).
- Explicit pre-change context:
  [pre-gen-pattern](./references/pre-gen-pattern.md).
- Requested examples/templates:
  [exemplar-pattern](./references/exemplar-pattern.md).
- Ownership/history: [explain-pattern](./references/explain-pattern.md).

Architecture diagnostics require an explicit diagnostic/refactoring request;
never use `get_architecture_report` for context collection. Source proves
behavior, tests expectations, docs intent. Add tests/specs only when requested
or needed to resolve uncertainty. Cite relevant `file:line` evidence and state
remaining gaps; do not expand into unrequested neighboring design work.
