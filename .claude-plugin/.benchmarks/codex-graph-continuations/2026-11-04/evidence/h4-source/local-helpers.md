# Local helper conditions — Codex code mode

Use this only when a held body delegates a requested condition to known local
helpers. If held code already answers, stop. Choose a narrow helper from that
body; do not expand an entire entry point, class, or namespace for orientation.
Global flow/impact/centrality still uses the full graph.

A new locator need not cost a model response when the held plan determines its
selection mechanically. A sole next caller, an exact returned id, or a required
small helper closure can feed the next tool inside the same executor. Await the
first call; if choosing among candidates needs interpretation, emit them
instead.

For missing same-file helper conditions, one bounded depth-2 callee query can
collect their ids before body reads. A default 40-row BFS page can be consumed
by other files' fan-out; request up to 200 rows and project only the held source
file inside JS. Keep truncation/unresolved flags: this projection is not the
whole graph, and static edges do not prove runtime reachability.

Fill `p`, `focusId`, `relativePath` and `heldIds` from retained facts. The
example counts only fully delivered current bodies in `heldIds`, not
outlines/known ids. is for a narrow closure whose bodies are ALL needed by the
current question; otherwise emit the projected locators for selection. Never
fetch every callee merely because it exists. Read this recipe beside an
independent needed body when possible, not as a separate setup-only response.

```js
try {
  const r = await tools.mcp__tea_rags__get_callees({
    ...p,
    symbolId: focusId,
    depth: 2,
    limit: 200,
  });
  if (r.isError) throw new Error(JSON.stringify(r));
  const d =
    r.structuredContent ??
    JSON.parse(r.content.find((x) => x.type === "text").text);
  const { tree: t, ...graph } = d;
  const at = Object.fromEntries((t?.columns ?? []).map((name, i) => [name, i]));
  const local = (t?.rows ?? []).filter(
    (row) => row[at.relPath] === relativePath,
  );
  const exact = local.filter(
    (row) => row[at.edgeKind] === "exact" && row[at.signature],
  );
  const ids = [
    ...new Set([focusId, ...exact.map((row) => row[at.symbolId])]),
  ].filter((id) => !heldIds.has(id));
  if (t && !d.truncated && ids.length && ids.length <= 20) {
    const bodies = await tools.mcp__tea_rags__find_symbol({
      ...p,
      symbols: ids,
    });
    text({
      focusId,
      relativePath,
      bodies,
      graph,
      otherLocalRows: local.filter((row) => !exact.includes(row)),
    });
  } else {
    text({ focusId, relativePath, columns: t?.columns, rows: local, graph });
  }
} catch (error) {
  text({ focusId, relativePath, error: String(error) });
}
```

Keep ids without signatures and non-exact local edges as unresolved candidates
when their behavior matters; do not call them absent. If a body is omitted or
stale, use core's needed continuation/freshness route. Do not reread the whole
batch or repeat the full graph. Every body must close the current evidence gap.
