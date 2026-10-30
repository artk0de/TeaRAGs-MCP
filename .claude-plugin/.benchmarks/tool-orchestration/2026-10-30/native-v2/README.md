# Native orchestration v2: 2026-10-30

**3 PASS, 1 FAIL; four completed actors, once each.** Runtime completion was not treated as behavioral success. All used `gpt-6.1-sol`, medium effort and the exact final `0.53.9` package fingerprint `a6367025c7c9cd033bd68c6485316d136c790759ee93e9d6c3646e1c1b49941f` (canonical sorted inventory JSON SHA-256).

| Case | Observed evidence | Verdict |
|---|---|---|
| O4 independent mixed batch | One executed batch returns both config files and the method body with correct labels; all four retry decisions are correct. | PASS |
| O5 dependent discovery | Manifest precedes the labelled child batch, but the final answer omits `regional_primary`'s 350 ms delay required by the unchanged rubric. | **FAIL** |
| O6 new pending-route control | One real job checks five routes; the actor resumes the same native cell and receives both missing routes before answering. | PASS |
| P1 projected search locators | Actual production projection preserves both paths despite fields omitting them; actor maps HTTP 100/400 and webhook 300/1200 with zero extra tools. | PASS |

O4/O5 were independently graded by `/root/eval_targeted_reads`; O6/P1 were checked offline by `/root/eval_architecture_gate` against actual IDs, bytes, producer output and final facts. [Combined grades](grades-all.json), [O4/O5 review](grade-o4-o5-independent.json) and [O6/P1 evidence](grade-o6-p1.json) preserve the checks. O5's rubric was not softened: orchestration passes, answer completeness fails. Its “each selected” prompt scope is being investigated separately before adding further plugin rules.

## Pending completion and projection proofs

O6 is a **new five-route/two-missing inventory**, not a retry of O1. MCP request `exec-5443e773-c5d3-4d7b-9798-02a1c229bc68` links to wrapper `ctc_0dc334004bcd398f016ae4f6b964808191a5d6e4bb98fb607e` in the same thread/turn. One job, PID **11475**, became ready at monotonic **74864227790750**. Actual native pending cell **2** was observed at **74895190630541**, before FIFO release **74895190932416**. One native `wait(cell_id:"2")` then delivered the terminal result: `checked:5`, missing `payments.capture` and `reports.export`. Job audit, pending lifecycle and delivered wait bytes agree. Clock was available; no clock, synthetic delay, restart or fabricated completion was used.

The original O1 remains **INCONCLUSIVE_HARNESS_FAILURE**: its string-form native yield was discarded by the old array-only parser. The original attempt and old runner were not changed. [Parser proof](unit-parser-proof.json) preserves the exact old native string and old pure function, an explicitly labelled offline RED replay, and fixed-parser **8/8 GREEN** output; it does not pretend the later replay is captured historical test stdout. Original O4/O5 FAIL records likewise remain in the separate [original archive](../orchestration-results/README.md).

P1's [producer proof](projection-producer-proof.json) records actual `projectSearchResultPayloads(rawResults, ["symbolId","content"])`, optional mode omitted, from source SHA `fa453c2d0e8018771951e235deb5a062400910cfa572b8fb71500cb52804cedf`. Controller code added no locator and did not reorder rows. The real output remained webhook then HTTP, opposite the prompt order, with complete same-named function bodies and their upstream paths. The actor made **zero post-prompt tools** and cited the correct mapping.

## Archive scope and limits

The archive contains the exact 87-file package, case definitions and inputs, safe fixture/status/profile/capability/filesystem proofs, answers, compressed native events/thread state/MCP audit, producer provenance, grades, unit proof and platform-specific repro scripts. [Runtime summary](runtime-summary.json) records one native turn per case and balanced actual hooks. Only selected nonsecret permission/capability sections are saved; auth files, actor homes, whole per-home configurations, backend logs and environment bundles are excluded. An initial zero-model preparation failed at nested macOS `sandbox_apply`; its denial is retained separately, and approved preparation then succeeded. This was not an actor retry.

Each is one synthetic observation. Native batch overlap is not proven by coarse/staggered timestamps; executed labelled batches and real returned bytes establish workflow only. O4/O5 and P1 had clock absent; O6 separately verifies the clock-available choice. P1 is one actual shared-projector/native-consumption case, not a replacement for the broader server unit matrix. No full benchmark or speed claim is made.

`raw-sha256.json` records copied bytes and gzip roundtrips; `inventory.sha256` covers everything except itself. Repro scripts require the original macOS/native Codex environment and original `.tmp/` layout; `shared-routing-run.py` belongs at `.tmp/plugin-routing-evals/run.py`, and `codex61_app_rpc.py` at `.tmp/codex61_app_rpc.py`. These archival files do not authorize new model runs or overwrite old attempts.
