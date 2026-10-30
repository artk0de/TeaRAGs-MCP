# Independent audit: targeted reads and independent batches

Both suites keep actor prompts and retained tool observations separate from grading data. The raw code and config fixtures support the requested answers. Materialized targeted source line locations agree with the seeded symbol addresses. No concrete fixture defect was found during the pre-run audit.

Actor input must exclude expected_output, expected, assertions, failure_mode, grading and suite method/runner-contract prose. Retained tool observations are input facts, not new calls. Candidate skill/reference reads are distinguishable from project source retrievals. The targeted follow-up reference is intentionally retained, so rereading it is observable unnecessary work.

## Trace grading rules

- A successful method read requires the requested symbol and a nonempty returned body matching fixture bytes. Metadata, empty output, not-found output, an actor promise or an answer guessed from a conventional implementation cannot satisfy a body-read requirement.
- T1: first and only post-prompt source retrieval is the known candidateCount body through find_symbol with matching project/cwd; answer is 40 and 160. No rediscovery, outline refresh, unrelated method or whole-file read.
- T2: no post-prompt code retrieval; retained complete delayMs body supports 250/500/2000 ms for attempts 0/1/4. No-tools is correct only together with the answer facts.
- T3: no post-prompt source or retained-reference retrieval; exactly two bullets preserve 250 ms, doubling, 2000 ms and scheduler.ts:18.
- T4: first and only post-prompt source retrieval obtains shouldRetry through find_symbol with matching project/cwd and body content; answer is 429=true, 503=true, 400=false. Outline-only guessing fails.
- B1: four required source/config files each have their own bounded shell read; one common wrapper actually dispatches all four through Promise.all/allSettled without sequential awaits. Final answer distinguishes test override 2/0/false, matching request spec, matching production 5/30/true, and job-spec test delay 10 versus configured 0.
- B2: three known migrations each have their own bounded shell read; one common wrapper actually dispatches all three through Promise.all/allSettled without sequential awaits. Final answer includes the implicit id, tenant_id/file_key/timestamps/status/completed_at, queued default, composite tenant/status index, and rollback removing only the index.
- B3: exactly one find_symbol request has the three known method IDs in symbols, project/cwd and returned bodies for all three. Answer states the strict attempt limit, email delegation and webhook false. Three simultaneous singular requests fail the batch requirement.
- B4: the manifest body is read first. Its completion precedes child-read dispatch. A second wrapper actually dispatches the two selected bounded per-file reads through Promise.all/allSettled without sequential awaits. Answer gives production_east true/45 and test_isolated false/0. Guessed/globbed paths, missing bytes or serial child reads fail.

Every runtime verdict needs wrapper/tool IDs, returned-output facts and final-answer evidence. Use native timing as supporting evidence where observable. If the wrapper correctly dispatches the required actual reads through Promise.all/allSettled but native scheduling serializes execution or timer precision prevents overlap observation, mark timing UNVERIFIABLE without failing the workflow. A source promise without actual dispatched operations cannot pass. True sequential awaits fail. A correct answer with a batching workflow failure remains a failed behavioral case.

## Runtime results

Run: `runs/20261030-182853-286087000`; native `gpt-6.1-sol`, medium, shipped plugin 0.53.8. Independent grader command: `python3 .tmp/plugin-routing-evals/grade-other-cases.py .tmp/plugin-routing-evals/runs/20261030-182853-286087000`. Result: **8/8 PASS** (targeted 4/4, batch 4/4). Complete evidence is in `grade-other-cases.json`.

| Case | Observed evidence | Result |
|---|---|---|
| T1 | `exec-80643c72-895d-48a9-be45-224b16202159` obtains candidateCount only, with actual body; answer 40/160 | PASS |
| T2 | No new retrievals; answer 250/500/2000 ms from retained full body | PASS |
| T3 | No new tools; exactly two bullets retain 250 ms, doubling, 2000 ms, scheduler.ts:18 | PASS |
| T4 | `exec-46464d60-ae26-4cf4-8ae5-bc53f229f4f0` obtains shouldRetry body; true/true/false | PASS |
| B1 | `ctc_0d69e82735a8e1d3016ae4b8188e488191b30b4098024cf0ea` actually dispatches four bounded file reads through Promise.allSettled; all bytes match and answer finds 10 versus 0 mismatch | PASS |
| B2 | `ctc_016ba7a589f92f16016ae4b81f24a08191b5cb21babc09824a` dispatches three bounded migration reads; full schema/index/rollback answer correct | PASS |
| B3 | `exec-e95e0abb-3146-452b-82df-fd0cc3bdb587` is one symbols request returning all three method bodies; answer differentiates policy, email, webhook | PASS |
| B4 | Manifest `exec-ae6f047f-0a3e-434a-96b1-abb8c3739cf7` completes before child reads; `ctc_071ea401f3877d19016ae4b82d77c88191b4189e1c5302bb60` batches both; 45/0 and disabled test retries correct | PASS |

Native overlap timing is **UNVERIFIABLE** for B1/B2/B4 because operations report zero-ms or staggered scheduler timing; executed Promise batches and actual returned source bytes establish their batching workflow. No baseline arm was run, so these results establish current behavior, not a measured before/after improvement. Fixture MCP descriptions are simplified; native plugin rules, hooks and skill contents were loaded. No model runs were initiated by this audit agent.
