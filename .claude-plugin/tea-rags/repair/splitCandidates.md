# splitCandidates

## What it means

A file now holds a separate cluster of symbols with low cohesion to the rest.

## Apply remedy

No server remedy for this family.

## No remedy

Check who owns the cluster.

- The cluster consists entirely of symbols this diff added: move them to a
  neighbouring file with fitting vocabulary, or to a new file following the
  folder's convention. This is the one case where a new file is allowed, and
  only for your own new code. Re-run the review afterwards.
- The cluster touches pre-existing symbols: write one report line and a bead
  suggestion. Do not split.

## Known false positives

- A cluster that is a cohesive unit by vocabulary the detector cannot see (for
  example a generated or table-like block).
- A file whose project convention is to keep helpers together. Cite the rule
  file and quote it.
- History-only split verdict (diff adds no edge between clusters): detector
  suppresses it — split finding fires only when diff ADDS a dependency edge
  across two clusters. Never split pre-existing clusters in feature diff.

## Escalate when

- No neighbouring file fits and the folder has no convention for a new one.
- The split would change a public import path.
