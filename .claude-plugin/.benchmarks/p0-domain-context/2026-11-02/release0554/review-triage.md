# Scoped review triage

The six canonical changed files were reviewed with naming, incompleteChange,
cohesion, architecture and norms. All detector sections built; introduced
architecture findings/edges:0. Docs/JSON/Bash lack applicable graph data and
nonproduction naming is not judged. This is not a clean whole-repository
architecture result. The initial broad review was cancelled without a returned
verdict; only scoped-review.json is used.

The user explicitly requires affected checks for small changes. Unsupported
structural coverage is disclosed; the selected checks and real behavior gates
were used instead of a full-suite fallback.

Co-change suggestions were examined individually (duplicate suggestions for the
same partner share the following verdict):

- tests/scripts/gen-harness-codex.test.ts: not changed. Its named test “emits
  codex-description as the description when the source carries one” already pins
  the existing projection seam. Both hook-cap checks and the executable
  known-config route check also passed. New policy decisions are covered by
  reusable behavioral cases rather than unit assertions mirroring prose.
- harness/codex/tea-rags/hooks/hooks.json: not changed. Byte-identical hash
  6aea80ba4272b3a08ec9455c6b7fe583d97d58fe63f64be7ddba680c7af12eb6; 14 named
  native hooks remain. Script bodies changed, event registration did not.
- scripts/gen-harness-cursor.ts: not changed. Its inspected imports already use
  SHARED_HOOK_SCRIPTS; Cursor receives the common script/core through
  generation. Codex-only startup/description behavior is not projected to
  Cursor.
- scripts/harness/transform.ts: not changed. toCodexSkill already reads
  codex-description and supplies the existing description option; the named
  projection test passed. No transform API changed.
- scripts/harness/package.ts: not changed. The inspected SHARED_HOOK_SCRIPTS
  array already registers search-drift.sh. Byte-parity checks passed.
- harness/codex/tea-rags/scripts/turn-routing.txt: not changed. Byte-identical
  hash b638b9a62b9b892dd4d2c4c2834cd795ff4da18eca3620d759a0e3c322872539; general
  turn routing remains compatible with the startup-only local exception.
- .claude-plugin/tea-rags/skills/explore/SKILL.md: not changed. Byte-identical
  hash6d94873f5d9091cbe0ae89e93648525b66334d8072484638438885ef81212b8d; source
  description is unchanged, only codex-description is modified.
- harness/cursor/tea-rags/skills/explore/SKILL.md: not changed. Cursor keeps the
  unchanged full source description; the Codex override is not its contract.
- plugins/tea-rags/rules/guides/decision-tree.md: not changed. Inspected row14
  links treeState/staleness to freshness; it contains no conflicting mechanism.
- plugins/tea-rags/skills/explore/references/usage-pattern.md: not changed.
  Inspected caller/callee/import/flow routes still require Explore and are not
  the direct local-body exception.

No production imports, signatures, exported symbols or graph edges were added.
The search-drift fast return reuses its existing concept classifier and leaves
mixed-read membership handling and all state transitions in place.
