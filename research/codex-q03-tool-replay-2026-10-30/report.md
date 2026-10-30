# Original Q03 batch: direct MCP replay

The original nine-file `find_symbol` batch resolves all nine files on the original historical repository `/Users/Shared/nav-ab/repo-master`, alias `taxdome-worktree-navmaster`, current clean HEAD `f88b42f3c286815ea43b464960205d56445ee2e6`. Both old and current runtimes return eight complete file bodies and an outline for `LinkEntityByName`, because it exceeds the remaining shared 24000-character full-text budget. The current runtime does not make the historical small-file deferral disappear; it supplies a more explicit continuation.

| Measure | Frozen old runtime | Current built runtime |
|---|---:|---:|
| Requested/resolved files | 9/9 | 9/9 |
| Missing files | 0 | 0 |
| Complete files / outlined files | 8 / 1 | 8 / 1 |
| Payload content characters | 21650 | 21650 |
| Pretty JSON response characters | 26193 | 26251 |
| Batch wall seconds | 0.056 | 0.061 |
| Continuation LinkEntityByName | complete file | complete file |

Current continuation returns `kind:file`, `startLine:1`, `endLine:147`, 7210 content characters. This records exact current tool metadata; historical analysis called it a 148-line file. The report does not assume that historical description proves identical current line accounting.

Old banner: `Bodies shown in full — answer from them; outline rows list ids…`. Current banner: `Body rows are complete; class headers may be inlined beside method ids. Outline ids…`. The current budget notice gives the exact actionable request `find_symbol(symbols:["app/services/tax_preparation/tax_automations/instead/clients/link_entity_by_name.rb"])`; old notice asked for one `relativePath` file request. Both continuations deliver the body successfully.

This default nine-file batch verifies no extra body loss and an actionable continuation. It does not independently exercise an optional container-header request or prove the separate header-budget regression fix. Old runtime lacks the newer optional header feature; runtime differences extend beyond one isolated option, so do not interpret the tiny wall-time difference causally.

No model inference, reindex, registry change, repository edit, or history operation was used. Each stdio server passed `initialize`, `tools/list` (including `find_symbol`), and a nonempty Registry source read before the batch. Source request is the exact saved tool input at historical transcript line111, now addressed to the original repository path and alias. The old frozen runtime required restoring its static `.qdrant-required-version` root asset before successful initialization; original packaging failure is retained outside this valid result set. An initial attempt on the unrelated repo-a localization snapshot was rejected/discarded because the historical files were absent. Sandbox-local Qdrant access failed; successful runs used explicitly approved escalation.

Raw requests, responses, continuation bodies, readiness summaries and runtime status are alongside this report. Private project listings, MCP configuration, credentials and runtime binaries are excluded.

The SHA256 hashes and lengths of all nine delivered content rows exactly match the original historical batch response at transcript line112. `historical-content-hashes.json` and `current-content-hashes.json` are identical, verifying the saved Q03 evidence against this corpus rather than assuming it from the repository path.
