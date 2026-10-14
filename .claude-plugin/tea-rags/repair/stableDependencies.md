# stableDependencies

## What it means

A component depends on a less stable component: the edge points toward higher
instability than its source.

## Apply remedy

Apply the finding's `remedy`.

- `retargetImport`: in `sourceRelPath`, replace the import from `fromRelPath`
  with an import from `toRelPath`, for `importedNames` only.
- If the remedy carries `addExport`, add those `names` to the one named facade
  `facadeRelPath`, and change nothing else in it.
- Re-run the review. The finding must be gone and no new finding present.

## No remedy

The server found no cheap target. Look for one by hand:

- If the import goes through a re-export, import from the declaring file.
- If the dependency is a type, look for an existing contract of the same name in
  a more stable component and import that.
- Cheap repair never creates files, interfaces or moves. Escalated: use
  `## Ops recipe`, simulated through `restructure`.

Nothing found: if the finding carries `compositionRoot`, `compositionTable` or
`parentSurface`, that flag is the evidence, so record it as a false positive.
Otherwise escalate.

## Known false positives

- Edge from a declared composition root: flagged `compositionRoot`. Wiring
  concrete implementations is that component's job.
- Edge carried only by registration / routing tables: flagged `compositionTable`
  (every carrying file wires, with no call, more components than the corpus's
  callWeight-0 files plausibly reach — a significance test, not a size). Listing
  concretes is the table's job.
- Edge from a parent's own surface into the parent's internals: flagged
  `parentSurface` (used mostly from outside its parent, using mostly the
  parent's internals). A domain API depending on its own domain is its job.
- A project rule that permits the direction. Cite the project rule file and
  quote the line, for example a domain-boundaries rule naming this pair.
- A bare "by design" is not evidence.

## Escalate when

- No remedy, no `compositionRoot` / `compositionTable` / `parentSurface` flag
  and no citable project rule.
- The retarget would need a new file, interface or move.
- Two repair rounds left the finding introduced.

## Ops recipe

Inversion for the code remedy: A (stable) must stop depending on B (unstable).

- `removeEdge {from: A, to: B}`
- `addFile {file: I, component: <foundation>}`
- `addEdge {from: A, to: I}`
- `addEdge {from: B, to: I}`

New file path: I sits in the component `summary.foundation` names, in the
sub-tree nearest to both A and B (longest shared path prefix). No foundation
named: component of the contracts-kind file both already import. None: no
recipe, escalate. Never hard-code a directory.

Example, finding fields `sourceRelPath: A`, `toRelPath: B`,
`importedNames: [N]`:
`removeEdge A→B · addFile I (N declared there) · addEdge A→I · addEdge B→I`. A
still gets N, now through the stable I.

Simulate with `get_architecture_report restructure` before writing; the skill
`tea-rags:refactoring-planning` orders several.
