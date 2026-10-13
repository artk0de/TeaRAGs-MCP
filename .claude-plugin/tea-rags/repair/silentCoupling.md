# silentCoupling

## What it means

Files that change together in history have no import or call between them, and
one of them was changed while its partner was not. Also covers
`incompleteChange`.

## Apply remedy

No server remedy for this family.

## No remedy

Inspect each untouched partner (symbol lookup or outline) and give a verdict
with evidence:

- The partner depends on the changed contract (a test, a doc, a registry, a
  mirror of the changed code): edit it in the same diff.
- The partner does not depend on it: write one line, "not touched because ...",
  citing the symbol you inspected.
- Never skip a partner silently.

## Known false positives

- Co-change from bulk commits (renames, formatting, releases) rather than from a
  shared contract.
- Partner pairs where the history is old and the shared code was since split.
- Version manifests (`.claude-plugin/**/plugin.json`, `package.json`, lockfiles,
  `version-pins.json`): detector drops them as silentCoupling partners, counted
  in `excluded.versionManifestEndpoints`. No dismissal needed. incompleteChange
  still lists them — missing manifest = version-bump question (project
  versioning rule), not coupling.
- "Not built" is not a clean result: no co-change data means no verdict.
- A dismissal needs a checkable reason: a named test that already pins the seam,
  or why the partner cannot change with this edit. "Not needed" without evidence
  is not a verdict.

## Escalate when

- The partner needs a change you cannot decide without product knowledge.
- Editing the partner is outside the task's footprint and you cannot tell
  whether it depends on the change.
