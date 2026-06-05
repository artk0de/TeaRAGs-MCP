# CYCLE Pattern

Circular-dependency intents. Uses `find_cycles` edge truth (strongly-connected
components from the import/call graph) — NOT content matching. Cycles are read
from a pre-computed table, sub-millisecond per call.

- **"Circular dependencies?" / "cycles in X?" / "dependency loop"** →
  `find_cycles scope=file`. Each result is one SCC of length >= 2 (single-node
  "cycles" excluded). Output the component members as a loop:
  `a.ts → b.ts → a.ts`.
- **"Circular calls between methods" / "recursive call cycle"** →
  `find_cycles scope=method`. Members are symbol ids
  (`Foo.bar → Baz.qux → Foo.bar`).
- **Scope the result to a module** → add `pathPattern` (picomatch glob), e.g.
  `find_cycles scope=file pathPattern="**/domains/ingest/**"`. A cycle is kept
  if AT LEAST ONE member resolves to a matching file path, so cross-boundary
  cycles (one file inside the scope, one outside) are RETAINED — those are
  usually the most interesting. Markers `in/inside/within/under <X>` in the
  request → derive the pattern (`**/<X>/**`), same scope-extraction rule as the
  main flow.

## Noise guard (large repos)

If a no-`pathPattern` run returns **more than 20 cycles**, do NOT dump them all.
Report the count, then narrow: re-run with a `pathPattern` for the subdomain the
user named (or the deepest shared directory of the first few cycles) and explain
that the list was scoped. Surfacing 50+ unrelated cycles buries the important
ones.

## Tail-suggestion (drill-down)

After listing cycles, offer the bottleneck drill-down: `get_callers` on a cycle
member surfaces who depends on the loop from outside it — the edge that, if cut,
breaks the cycle's blast radius. Resolve the exact symbol id with `find_symbol`
first when the member is a method (method-scope members are `Class.method` /
`Class#method` ids, not paths).

Empty result is a valid answer: "no cycles in `<scope>`" means the graph is a
DAG there — state it plainly, don't fall back to content search.
