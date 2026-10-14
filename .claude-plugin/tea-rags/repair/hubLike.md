# hubLike

## What it means

A diff edge carried a component across the hub threshold: it now has both high
afferent and high efferent coupling.

## Apply remedy

Apply the finding's `remedy` when present. The server picks a target in a
component the source already depends on, so efferent coupling does not grow.

- In `sourceRelPath`, import `importedNames` from `toRelPath` instead of
  `fromRelPath`.
- Re-run the review. The component must be under the threshold and no new
  finding present.

## No remedy

- Look for a symbol already reachable through a component the source depends on.
- Edges into contracts never count toward a hub's efferent coupling. If the
  added edge is a type import, retarget it to an existing contract.
- Threshold flap (0.02 or less): report metric before and after, threshold and
  the moving edge, and let the user decide.
- Splitting the hub is not a cheap fix. Report it with a bead suggestion;
  escalated, the split is `## Ops recipe`, simulated through `restructure`.

## Known false positives

- `compositionRoot`: a composition root is meant to depend on many components.
- `compositionTable`: the hub holds a registration / routing table — a file
  wiring, with no call, significantly more components than the corpus's
  callWeight-0 files reach.
- `parentSurface`: the hub is its parent's surface — used mostly from outside
  its parent, using mostly the parent's internals.
- Contracts edges counted before the contracts exclusion fix: re-check the edge
  target kind before accepting the finding.
- A project rule that names the component as an aggregator. Cite file and quote.

## Escalate when

- Every candidate target would add a new component dependency.
- The only fix is splitting the component.
- Two repair rounds left the finding introduced.

## Ops recipe

Split the hub's afferent surface, one cluster of consumers at a time. Cluster =
consumers importing the same subset of `importedNames` from the hub H.

Per cluster C with interface I:

- `addFile {file: I, component: <H's component>}`
- `removeEdge {from: c, to: H}` for each c in C
- `addEdge {from: c, to: I}` for each c in C
- `addEdge {from: H, to: I}`

New file path: I sits beside H, same directory. Never in a component H does not
already depend on: efferent coupling must not grow. Edge into a contract-kind
file does not count toward Ce, so prefer the contracts component when the
report's tree has one H already imports.

Example, finding fields `component: H`, consumers `[c1, c2]`,
`importedNames: [N]`:
`addFile H-dir/I · removeEdge c1→H · removeEdge c2→H · addEdge c1→I · addEdge c2→I · addEdge H→I`.
Ca of H drops by 2; Ce gains one local edge.

Simulate with `get_architecture_report restructure` before writing; the skill
`tea-rags:refactoring-planning` orders several.
