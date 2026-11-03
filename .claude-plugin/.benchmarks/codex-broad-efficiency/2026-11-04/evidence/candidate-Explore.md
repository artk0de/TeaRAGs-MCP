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
Core is already loaded: reuse its routing, project/path, freshness and body
contracts. Reuse retained evidence and instructions; a follow-up alone does not
require another read. Known bodies/local contracts need only core navigation.

## Independent facts, one executor wave

Silently identify which requested facts lack evidence. For multiple independent
topics, run a small `semantic_search(metaOnly:true, limit:3)` per missing topic
concurrently in ONE executor. Fuse synonyms of the SAME concept in one query; do
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

Use returned method ids directly in `find_symbol(symbols:[...])`. A file path
without the needed method ids may need an outline; it does not require listing
its directory first. Batch ready independent work, label each result with its
input, and inspect errors as well as successes. Directories remain separate
calls; config/spec/migration reads are bounded per-file calls.

All concurrent calls share the OUTER executor's output budget. Splitting a large
read into concurrent MCP batches does not give each batch its own outer budget.
Select methods instead of dumping containing classes or several full file
groups. When every selected body is needed, allow enough outer output to deliver
them; if the cap cannot fit them, a separate wave is justified. Never truncate
silently or reread the entire batch to recover an omitted portion. Fresh
delivered bodies are authoritative; metadata, outlines, headers and
blocked/omitted bodies are not. Follow only needed missing continuations.

## Choose detail by the actual question

A factual explanation of ports, registration, data models or an integration's
lessons uses the evidence above. It does not require entry-point/hub ranking, a
graph walk, tests, implementation templates or architecture diagnostics. Graph
is useful for a missing trigger/caller/flow fact, not to confirm a selection
already explicit in a body. Stop once all requested facts have proof.

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
