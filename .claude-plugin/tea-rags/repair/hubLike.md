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
- Splitting the hub is not a cheap fix. Report it with a bead suggestion.

## Known false positives

- `compositionRoot`: a composition root is meant to depend on many components.
- Contracts edges counted before the contracts exclusion fix: re-check the edge
  target kind before accepting the finding.
- A project rule that names the component as an aggregator. Cite file and quote.

## Escalate when

- Every candidate target would add a new component dependency.
- The only fix is splitting the component.
- Two repair rounds left the finding introduced.
