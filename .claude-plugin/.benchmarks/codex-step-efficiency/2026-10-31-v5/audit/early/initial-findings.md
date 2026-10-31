# Q01–Q20 offline visible-behavior audit

No production reads/edits, gold/expected answers, private reasoning, reindex or actor/model runs. Input event SHA256s, exact IDs and qualifications are in `findings.json`. Source 0.54.0/ced48 is the supplied run identity, not validation of newest main.

## Three high-confidence fixes

1. **Q01: dispatch the right locator type and independent metadata together.** `exec-15f19631-308f-45c3-b4c5-d8fa705f8f44` requests registry.rb plus its directory in `symbols`. The registry is delivered in full L1–133; the directory is rejected explicitly. The next response (`resp_0774613464b3f479016ae6053ad0c08191aa2a58c354bf8ea7`) retries `relativePath` and also runs model discovery. After the preceding semantic metadata supplies registry.rb, registry read, standalone directory locator and independent model semantic query can share one response. **One call saved; one response saved only with that ready-query batching.** Fixing the directory argument alone does not establish a model-step reduction.

2. **Q12: move known graph-schema discovery earlier.** Q01 already supplies `MergeForContact#perform` exact id in an outline, but **not its body**. Q12 correctly reads its missing implementation in response1. It delays `get_callers` schema lookup to response2 with deletion bodies, then calls graph in response3 and reads the CRM consumer in response4; response5 answers. Keep the graph: it proves CRM merged-event wiring and discovers consumer ids. Schema lookup can accompany response1, allowing graph and dependent deletion bodies together in response2, consumer reads in response3, final in response4. **One response saved, same native calls and evidence.** Exact actual response/native ids in JSON.

3. **Q01: subtract genuinely covered bodies from later method batches.** `exec-81be775f-5b1a-4324-bf5e-21c9fec0744b` delivers VerifyGrant full file L1–36 and DisconnectAll full file L1–55. `exec-e9f246ed-ba3c-4eef-a1be-2196071ede3a` later rereads their `#perform` bodies L26–35 and L28–47. Omit these two entries; retain the other five needed bodies in that batch. **Two returned body rows saved, zero supported call or response savings.** Coverage is based on delivered source content, not filenames or outline extent.

## Controls and lower-impact findings

- A correctly answers Q08/Q10/Q11/Q13/Q18/Q19 without reads. Reuse is already working substantially.
- Q12 first merge bodies were not held before Q12; Q09 initialization/parameter methods were earlier outline-only. Q14 held ResumeSends#perform but still lacked the failed-document selector. These are not blanket redundant reads.
- Q16 reads unrelated TaxSoftwareBackups registry L1–25 (689 chars), even though literal scope is tax automation. Omit this row; same-wave context savings only. The needed tax registry, DestroyCleanup loop and reconciliation worker bodies were already held; KeepAliveWorker really was missing.
- Q07 settings extraction works. Its followup executes separate `/mock/=` and `/mock/p` scans; one scan suffices, with no native-response reduction.
- No unsupported claim that helper reads or CRM graph evidence are unnecessary.

## Reference B and evaluation limits

B counts are not causal effect estimates: Q01 is 9 responses versus A 11 and Q12 is 2 versus A 5, but B broadly preloads files and had already held full merge code since Q04. Future relevance is a confound, not proof broad preload is optimal. B also rereads retained content.

Local extracted actor cases can genuinely test locator-kind handling, ready-schema batching or body coverage. They are **microcases**, not original-question replays. Original replay needs exact original pre-question context, injections/tool metadata and source snapshot, including prior delivered content; do not give fixtures an answer/plan. None run here. Findings remain dependency-based hypotheses for behavioral evaluation, not measured speed wins.
