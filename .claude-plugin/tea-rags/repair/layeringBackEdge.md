# layeringBackEdge

## What it means

A diff edge runs against the inferred layer order or closes a knot.

## Apply remedy

Apply the finding's `remedy`.

- `retargetImport`: in `sourceRelPath`, import `importedNames` from `toRelPath`,
  the declaring file in a permitted layer (or an existing contract of the same
  name there).
- If the remedy carries `addExport`, add those names to the one named facade.
- Re-run the review. The back-edge must be gone and no new finding present.

## No remedy

- If the import goes through a re-export, import from the declaring file.
- If the dependency is a type, look for an existing contract in a permitted
  layer.
- Do not move files between layers to satisfy this family.

## Known false positives

- Composition edges are not back-edges: a module wiring its own sub-parts. A
  knot flagged `composition: true` is informational.
- `compositionRoot` or `entryPoint` source: such components sit above the stack
  by design.
- A project rule that permits the direction. Cite file and quote.

## Escalate when

- No permitted-layer target exists for the imported names.
- The fix needs a move, a new file or a new interface.
- Two repair rounds left the back-edge introduced.
