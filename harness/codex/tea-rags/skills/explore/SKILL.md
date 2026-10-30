---
name: explore
description:
  "Use for questions about existing code behavior, usages, structure, examples,
  or explicit pre-change context that need investigation. Not bug symptoms,
  implementation-plan authoring, or broad code-health audits."
---

# Explore

Answer the literal question with the smallest sufficient source investigation.
Reuse code, outlines, edges, skills and guides already retained in context.
Reload only changed material or instructions missing after compaction; a new
question does not itself require rereading this skill.

## Choose the needed evidence

Start from what is known. If retained evidence answers the question, answer
without tools. Otherwise select one route below, not a sequence of all routes.
Core rules own project/path addressing, freshness, exact-text exceptions and
result contracts; do not fetch their guides again when those rules are known.

Keep context small: discovery starts `metaOnly:true` with a small set (e.g.
`limit:5`, adjusted to scope). Choose anchors before bodies. Batch only methods
needed now, not containing classes/trees; headers/shared declarations need their
own evidence gap. Every read closes a missing fact in this question, never
prefetches for a future one.

| Need                                                                | Route                                                                                                                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Known symbol's definition                                           | `find_symbol(symbol:)`; reuse a held real id/body.                                                                                                                   |
| Known file/directory or several files                               | `find_symbol(relativePath:)`, or ONE `find_symbol(symbols:[<file paths>])`. Read only needed member ids from an outline.                                             |
| Exact-name occurrences or complete inventory/absence in known paths | Shell rg -l --hidden --glob '!.git', filenames (`-l`) first; fetch enclosing bodies only for requested behavior/context. Ranked search is not proof of completeness. |
| Behavior without a known location                                   | `semantic_search`; exact symbol plus intent → `hybrid_search`. Scope to the supplied path; use hits to fetch only missing evidence.                                  |
| Callers, callees, flow or change impact                             | Known id → `get_callers`/`get_callees` (`depth: 2`); resolve missing ids once. A→B chain → `trace_path`. Batch only needed unread bodies.                            |
| Test coverage                                                       | One `hybrid_search` with module/exported names, `testFile:"only", metaOnly:true`; a missing hit is not proof of no tests.                                            |

A factual question about an existing integration is not automatically template
mining or preparation to implement it. Neither future implementation context nor
words inside symbol names change the current question's intent. "Lessons from
the existing integration" stays factual unless an implementation template is
requested. An explicitly requested body remains a direct read.

## Load only the selected detail

Use a reference only when that branch is needed and its instructions are not
already held. Recipes are not minimum call counts: continue only to close an
identified evidence gap.

- Explicit cycles → [cycle-pattern](./references/cycle-pattern.md).
- Dependency direction/layer violations → `architecture-diagnostics`.
- Explicit structure/architecture →
  [architecture-pattern](./references/architecture-pattern.md); entry points →
  [entry-point-pattern](./references/entry-point-pattern.md).
- Usage/impact needing more detail →
  [usage-pattern](./references/usage-pattern.md); graph unavailable →
  [trace-pattern](./references/trace-pattern.md).
- Explicit pre-change investigation →
  [pre-gen-pattern](./references/pre-gen-pattern.md): discover only missing
  targets, then ONE needed-symbol overlay batch for DDG. Do not automatically
  start implementation or a broad risk scan.
- Explicit example/template/reuse or pattern collection →
  [exemplar-pattern](./references/exemplar-pattern.md). One fitting example does
  not require collecting all variants or similarity expansion.
- Broad introduction needing several axes →
  [explore-flow](./references/explore-flow.md). Do not search
  tests/specifications merely because the source question is broad.
- A name's fit → `get_naming_lexicon`; names introduced by a diff →
  `review_changes(sections:["naming"])`. Detailed naming interpretation →
  [naming-pattern](./references/naming-pattern.md).
- Ownership/recent activity →
  [explain-pattern](./references/explain-pattern.md). History, risk scans,
  planning and failures follow core's dedicated routes.

Use an explicit current codegraph setting, otherwise availability in the tool
list; no probe call. Without graph evidence, label inferred calls/dependencies
and never claim a proven absence of cycles or paths.

## Evidence and stopping

Source establishes behavior; tests establish expectations; docs describe intent.
Add tests or specifications only when requested or needed to resolve
uncertainty. Verify a behavioral doc claim against source already held, or fetch
its known symbol; discovery search is needed only when the location is unknown.

A complete fresh body from ANY tea-rags tool, including `semantic_search`, is
already read authoritative code. Answer from it; no `find_symbol`, Read or shell
confirmation of the same body. Metadata/signatures/outlines/container headers
are not method bodies. Refresh only affected edited/stale or missing evidence. A
held full body can answer a point question with zero further reads. An outline
is an address map, not evidence of method behavior; fetch only the relevant
missing bodies in ONE batch. Reassemble `#partN` before reasoning about its
whole method. If needed content is truncated, follow the relevant continuation;
unneeded pages are not required. Known paths and returned ids replace
rediscovery.

Stop when the requested facts have evidence. State unresolved limits rather than
expanding into neighboring patterns, ownership, tests or design work. Answer
directly with relevant `file:line` citations and a concise explanation; report
an explicit inventory's coverage limit. No mandatory strategy preamble, workflow
recital or extra output format for a simple question.
