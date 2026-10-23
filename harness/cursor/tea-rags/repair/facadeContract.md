# facadeContract

## What it means

The diff removed or renamed a facade export that other files still consume.

## Apply remedy

Apply the finding's `remedy`.

- `restoreExport`: add `names` back to `facadeRelPath`, unchanged in signature.
- Alternative, when the removal is intended: move every consumer to the new home
  of the names in the same diff, then confirm no consumer remains.
- Re-run the review. The finding must be gone and no new finding present.

## No remedy

- List the consumers of each dropped name. None left: the removal is clean,
  record the evidence.
- Consumers outside the repository (a published package surface): restore the
  export or deprecate it first.

## Known false positives

- A dropped name with no remaining consumers.
- A rename where every consumer moved in the same diff.

## Escalate when

- Consumers exist in places the agent cannot edit.
- Restoring conflicts with the intent of the change.
- Two repair rounds left the finding introduced.
