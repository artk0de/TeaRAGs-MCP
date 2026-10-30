# Codex context, execution and source identity

Candidate: TeaRAGs plugin 0.53.9, based on `177bf56bbd8dcd5e14a74eba2ff6f00f3dda3a36` (0.53.8). Native actors use `gpt-6.1-sol`, medium effort. Each candidate/case condition receives one actor attempt; failed and invalid attempts remain in this archive.

Full evidence is stored in each result directory's `evidence.tar.gz`; summaries remain directly readable. All 824 original member files were verified byte for byte before packing, including unchanged inner inventories. Follow each `STORAGE.md` to extract into a scratch directory before using inner reproduction paths. Captured TypeScript is data and stays outside project lint/test discovery. `evidence-storage.json` records the outer archive hashes.

## Changes and evidence

- Codex discovers a missing tool argument declaration without printing its complete description, shared core or return schema. Saved Q01 delivered 39,617 characters of selected descriptions, already truncated, with at least 6,066 duplicated shared-core characters. The focused M1 actor obtained the needed declaration in 405 delivered characters and then executed the correct call. These are different scenarios, not a measured percentage improvement.
- Search banners distinguish full bodies, mixed answers and metadata. They no longer mandate a graph traversal after sufficient source. Graph remains available for a missing flow/impact fact. Source unit tests: 47 passed after recorded RED failures. S1 uses held source without another context call; S2 retrieves its missing body; S3 retrieves necessary downstream evidence.
- Codex waits on a real executor/session or agent completion, and yields to the user after a necessary question. Sleeping, timer delays and busy polling are prohibited as substitutes. Clock remains exposed in O1/O2/O3: correct behavior is not attributed merely to removing the tool.
- Codex batches independent calls while respecting dependencies. The first batch tests revealed lost source identity and an omitted requested item. The revised candidate requires results/errors labelled by their input and inspection of every settled outcome, covering every requested item.
- Source-search results retain their real `relativePath`, including when explicit `fields` omits it. Other payload fields remain allowlisted. Paths are not inferred from symbol names; malformed upstream locator data is reported through the existing warning channel.

The Promise and native executor wording is generated only for Codex. The shared result-projection and banner changes apply to the server's search results.

## Preserved first attempts

| Case | Verdict | Actual observation |
| --- | --- | --- |
| M1 missing schema | PASS | One argument-only discovery, correct native call and snapshot facts. |
| M2 retained schema | PASS | No schema rediscovery, correct native call and facts. |
| S1 complete source | PASS | No additional source-context call; correct values and file location. |
| S2 metadata only | PARTIAL | Correct body retrieval, values and location. Frozen oracle asks for milliseconds although the prompt and source establish no unit; unit quality is unsupported. |
| S3 missing downstream fact | PASS | Needed graph and downstream body, no reread of the retained outer body. |
| O1 pending exec cell | INCONCLUSIVE_HARNESS_FAILURE | One real job and matching native waits. Controller discarded a string-form pending result and never released its FIFO until timeout cleanup; no completion was delivered. |
| O2 pending command session | PASS | Resumed the real session and received terminal output; 3 valid, 1 rejected; no sleep or restart. |
| O3 clarification | PASS | Asked for the missing local time, retained Europe/Moscow, yielded without attempted writes or sleep. |
| O4 independent mixed batch | FAIL | Actual concurrent batch, but anonymous completion output caused HTTP/Webhook limits to be swapped. |
| O5 dependent discovery | FAIL | Correct dependency and child batch, but final answer omitted one selected policy. |

Raw actor inputs, grading, native events, profiles, snapshots, hashes and limitations are separated in `metadata-search-results/` and `orchestration-results/`. These snapshots have the same candidate version but distinct recorded fingerprints: orchestration was tested before the metadata change, and both precede the batch-label correction and mandatory-path change.

## Follow-up validation

The corrected pending parser has 8 passing offline regression checks, including the exact string-form pending response and unrelated-job rejection. The final 87-file candidate fingerprint is `a6367025c7c9cd033bd68c6485316d136c790759ee93e9d6c3646e1c1b49941f`.

| Final-candidate case | Verdict | Actual observation |
| --- | --- | --- |
| O4 labelled independent batch | PASS | Concurrent three-operation batch; HTTP=3 and Webhook=5 remain bound to their files; all retry answers correct. |
| O5 dependent discovery | FAIL under frozen criterion | Correct dependent reads and labelled child batch; answer still gives only the disabled policy, omitting the other manifest-selected policy required by the frozen rubric. |
| O6 new pending-cell control | PASS | One real job, matching string-form pending cell, job-ready proof, controller release, one native wait on that cell, real terminal result: five routes, two missing. Clock exposed; no sleep/restart. |
| P1 mandatory file paths | PASS | Actual production projection retains both original paths despite fields omitting them. With zero post-prompt context calls, the actor correctly associates both same-named methods with their files and values. |

The O5 prompt combines “which policies ... disable” with “each selected policy,” allowing two selection scopes. Its strict frozen failure is retained. On the exact same candidate and fixtures, G1 explicitly asks for every manifest-selected policy and G2 explicitly asks only for the disabled subset. Both new conditions passed once: G1 reports both policies and G2 only the disabled policy. This supports a prompt-scope explanation at n=1, not a general completeness claim or a relabelling of O5. No further production answer-completeness rule was added. Full evidence is in `policy-scope-results/`.

Original attempts remain unchanged. `native-v2/` records final-candidate verdicts separately; no retry is silently substituted for a failed or invalid attempt.

Source validation: 58 generator tests, 47 banner tests, 106 projection/ops/server tests and 76 schema/resource tests passed. The corrected schema-valid server matrix passed all five cases (a subset), and the final hook-budget check passed. Fresh build passed. Codex core remains 9,625 characters; the separate Codex rules are 2,958 characters.

After actor evaluation, ESLint required destructuring one existing property access. `post-eval-equivalence.json` records both source hashes and an identical actual P1 producer return; no actor was repeated for this mechanical correction. Frozen TypeScript evidence stays outside project linting and keeps its original bytes. The archived unified diff likewise retains its original blank context-line spaces.

The commit hook's first affected-test run passed 3,435 tests and caught one 32-word parameter hint exceeding the 20-word budget. The `fields` hint was shortened without changing its contract; the focused schema and real tool-surface checks then passed 67/67. The original failed run is retained as `affected-tests-before-hint-fix.log.gz`. Detailed locator semantics stay in the overview resource.

## Benchmark transport

`proxy/` contains a future-run copy fixing legitimate `get_callers` noEdges banners. It accepts the same narrow trusted grammar as `get_callees`, checks the requested symbol, and rejects mismatched or arbitrary text. Thirty focused banner checks and the 35 existing adversarial guard checks pass. The frozen full-A proxy is unchanged, SHA-256 `b5aaa2b5433dcd1a6e18bf08a1e795896ce1b25b72b52eff78e4c669feca4569`.

`capabilities/` records a separate no-model catalog proof: `features.sleep_tool=false` removes only `clock.sleep` and retains native waiting and question interfaces. This does not by itself prove model compliance and does not alter the user's global configuration.

The completed full A39 used 0.53.8. It was not repeated for these changes. Focused fixture results establish behavior in these cases, not a new GruntWorx speed or quality improvement. Historical performance results retain their sleep/proxy caveats.
