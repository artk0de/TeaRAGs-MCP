# mainSequence

## What it means

A component's distance from the main sequence crossed the tolerance because of
edges this diff added.

## Apply remedy

Apply the finding's `remedy` when present. It exists only when fixing the edges
in `evidence.edges` brings the distance back under the threshold.

- For each retarget in the remedy, edit the source import as in
  stableDependencies.md.
- Re-run the review. The distance must be under the threshold and no new finding
  present.

## No remedy

Judge `evidence.edges` one edge at a time with the stable-dependencies rule:
does the edge point from a stable component to a less stable one?

- Edge fails the rule and has a cheap retarget: retarget it.
- Edge passes: leave it, and say which rule it passes.
- Threshold flap: the metric crossed the tolerance by 0.02 or less. Treat it as
  an ordinary introduced finding. Fix cheaply if possible. Otherwise report the
  metric before and after, the threshold and the diff edge that moved it, and
  let the user decide.

## Known false positives

- `entryPoint: true`: a declared entry surface belongs at the unstable end and
  nothing imports it.
- `foundationTerminal: true` = every added edge ends in a layering foundation
  component. Triage data, not automatic FP: edge direction SDP-legal — judge it
  via No remedy, cite the rule it passes.
- Rise ending on or below served whole-repo `distanceThreshold`: detector drops
  it itself (`excludedBelowThresholdCount` on mainSequence row) — never listed.
- Unmeasured or unobservable abstractness (a language that rarely declares
  abstractions) is not a verdict.
- A project rule that places the component. Cite file and quote.

## Escalate when

- No edge in `evidence.edges` can be retargeted cheaply and the flap is not
  within 0.02.
- Fixing the distance needs abstractions added or components split.
- Two repair rounds left the finding introduced.
