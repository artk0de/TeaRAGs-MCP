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
- Do not create files, interfaces or moves to satisfy this family.

Nothing found: if the edge runs from a declared composition root, the
`compositionRoot` flag on the finding is the evidence, so record it as a false
positive. Otherwise escalate.

## Known false positives

- Edge from a declared composition root: flagged `compositionRoot`. Wiring
  concrete implementations is that component's job.
- A project rule that permits the direction. Cite the project rule file and
  quote the line, for example a domain-boundaries rule naming this pair.
- A bare "by design" is not evidence.

## Escalate when

- No remedy, no `compositionRoot` flag and no citable project rule.
- The retarget would need a new file, interface or move.
- Two repair rounds left the finding introduced.
