# leakingAbstraction

## What it means

A file imports an internal file of a component past the facade its peers use.

## Apply remedy

Apply the finding's `remedy`.

- `retargetImport`: in `sourceRelPath`, import `importedNames` from `toRelPath`
  (the component facade, `evidence.facadeRelPath`) instead of `fromRelPath`.
- If the remedy carries `addExport`, the facade does not re-export those names
  yet. Add them to that one facade, then retarget.
- Re-run the review. The finding must be gone and no new finding present.

## No remedy

- The names are not meant to be public: do not widen the facade. Ask whether the
  importer belongs inside the component.
- A `preExisting` leak in a file you did not touch is report-only: one line, a
  bead suggestion, no edit.

## Known false positives

- Imports inside the same component (siblings of the facade) are not leaks.
- A facade nobody else uses is not a boundary. The detector reports it as not
  adopted, not as a leak.
- A project rule that names the deep import as allowed. Cite the rule file and
  quote it.

## Escalate when

- The facade would need more than one added export line in one file.
- Retargeting creates a cycle (see cycles.md).
- Two repair rounds left the leak introduced.

## Ops recipe

- `removeEdge {from: importer, to: deepFile}`
- `addEdge {from: importer, to: facade}`

Facade = `evidence.facadeRelPath`. It must already exist and re-export the
names. A relabel never creates an entry file: never `addFile` a facade. Names
not exported yet: add the one export line first (see Apply remedy), then the two
ops. No existing facade: no recipe, escalate.

No new file, so no path rule.

Example, finding fields `sourceRelPath: importer`, `fromRelPath: deepFile`,
`toRelPath: facade`: `removeEdge importer→deepFile · addEdge importer→facade`.

Simulate with `get_architecture_report restructure` before writing; the skill
`tea-rags:refactoring-planning` orders several.
