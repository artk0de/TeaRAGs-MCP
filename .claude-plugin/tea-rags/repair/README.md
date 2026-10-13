# Repair strategy files

One file per architecture-finding family. Each tells an agent how to repair a
finding, or how to justify leaving it, at the moment it appears. Shared by the
data-driven-generation verify step, architecture-diagnostics and
risk-assessment.

Load a file only when a finding of that family is present in the findings you
are acting on. Never preload the directory.

Every file has the same five sections, in this order: `## What it means`,
`## Apply remedy`, `## No remedy`, `## Known false positives`,
`## Escalate when`.

Rules common to all families:

- Fix findings the diff introduced. Fix a `preExisting` finding only when the
  repair is cheap: edge edits only, footprint within the diff files plus at most
  one facade, and a re-run of the review shows the finding gone, no new finding,
  tests green and untouched.
- Accept a finding as a false positive only with evidence: a detector flag
  (`compositionRoot`, `entryPoint`, `foundationTerminal`) or a cited project
  rule (rule file path plus a quoted line). "By design" alone is not evidence.
- At most two repair rounds. A round that adds a finding or breaks a test is
  reverted whole. Findings still introduced after round two go to the user.
