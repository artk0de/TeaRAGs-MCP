# Mandatory source locators

Explicit `fields` now retains an existing nonempty string `relativePath` before the requested payload fields. Every other field stays allowlisted. The producer never derives a path from a symbol or name. Missing or invalid upstream paths produce an advisory in the existing `fieldsWarning`, naming result IDs; requested-field warnings remain intact. This exception is documented in the shared fields schema and canonical overview.

The shared producer covers semantic/hybrid search, ranking, similarity, and single/batch symbol retrieval. The server matrix uses schema-valid inputs for all five registered search tools, real projection output, and actual column-table serialization. It verifies locators and requested bodies survive while unrelated payload fields stay absent. Budget handling trims rows rather than their locator columns. The graph caller tree already carries its own relative `relPath` and was not changed.

Scoped GREEN: **106/106** tests across three files. The final tests-only input correction was verified with **5/5** matrix cases (64 unrelated cases skipped). Before implementation, DTO and ops expectations failed on missing source paths; the missing-locator warning also failed. The first server assertion used the wrong column decoder, which was corrected and is explicitly disclosed in `verification.json`. Root subsequently reported final generation and fresh build exit 0.

`verification.json` and `unit-console-excerpts.log` preserve transcribed captured console evidence, rather than pretending it is original raw output. `scoped.diff` and `snapshots/` are direct workspace captures, with hashes in `source-manifest.json`. `scoped-review.json` records the review result and index-lag limits. This archive contains no actor/model run, full-suite claim, or commit. The native P1 locator behavior case and its runtime evidence are frozen and graded separately by the v2 runner owner.

The redundant shared hot-core paragraph was removed by root to preserve the core character budget. The schema and overview describe the server-enforced contract without adding an agent obligation.
