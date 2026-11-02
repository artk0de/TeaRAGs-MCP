# Embedded-sentinel integration

The source fix treats `QDRANT_URL=embedded` and config `qdrantUrl: embedded`
as selectors for daemon discovery. An external config cannot override an
explicit embedded environment selector. Explicit external addresses and the
existing localhost fallback retain their prior precedence.

The three source/test files are exact copies of commit `db0f4a72`, cherry-picked
without conflict onto main `953177d21` in an isolated integration worktree.
The separate startup candidate `cafc52ecc` is excluded.

Historical behavioral evidence is in `runs/firstfix-valid/verdicts.json` and
`native-delivery-addendum.json`: both baselines lack C01 addressing (0/2 fields),
both candidates restore it (2/2), and all C02 external-storage controls pass.
The valid cohort combines one immutable generation05 condition with seven
generation08 conditions, n=1 each. Earlier invalid attempts and source-age
warnings remain recorded. Each variant/harness uses one model response for C01
and two for C02; no model-step or timing improvement is demonstrated.

Original public records and complete reusable driver source are preserved;
`import-provenance.json` records the imported file hashes. Raw prompts/fixture
remain separate from controller-only grading. No actor homes, private journals,
auth values or private reasoning are included.

Integration checks are recorded in `integration-status.json` and
`integration-verification/`. Current main changed neighboring prime code since
the original test run: all21 affected checks now pass in three files (17+4,
maxWorkers1, no repeated17). One default-config attempt was interrupted without
results; its cause is unknown and its log is retained. The subsequent explicit
small configs preserve the original setup and HEAD guard; they bypass full-tree
module classification/projects and disable the transform disk cache. This is a
focused unit result, not a full-suite pass. All five direct-patch review sections
were built, with zero introduced findings and no partial detector.

A root-authorized overlap of these light checks with domain/freshness actors is
recorded; no speed claim follows. No index or build ran in that actor window.
Safe main fast-forward is recorded by Git ancestry and the final integration
report; main build/incremental indexing follow after the actor window closes.
The full benchmark remains paused.
