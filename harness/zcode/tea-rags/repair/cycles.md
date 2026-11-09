# cycles

## What it means

A diff edge closes a dependency cycle between files or components.

## Apply remedy

Apply the finding's `remedy` when present. It is a `retargetImport` for the case
where the import went through a barrel that sits on the cycle.

- In `sourceRelPath`, import `importedNames` from `toRelPath`, the file that
  declares the names and lies off the cycle path.
- Re-run the review. The cycle must be gone and no new finding present.

## No remedy

- Find the edge that closes the cycle and check what it imports. If a type, use
  an existing contract that lies off the cycle.
- If the names live on the cycle itself, the cycle is real: do not hide it
  behind another barrel.
- A `preExisting` cycle the diff only touches is report-only.

## Known false positives

- Informational composition cycles (a module and its own nested sub-parts, or an
  island) are not violations. Count them separately and label them
  informational.
- A knot flagged `composition: true` joins a directory to directories nested
  inside it. It is not a layering defect.

## Escalate when

- The cycle runs through declaring files, so no retarget breaks it.
- Breaking it needs a move or a new file.
- Two repair rounds left the cycle introduced.
