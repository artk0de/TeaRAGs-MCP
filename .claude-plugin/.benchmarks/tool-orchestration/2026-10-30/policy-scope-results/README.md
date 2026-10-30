# Explicit policy answer scope: 2026-10-30

**G1 PASS; G2 PASS.** Two new conditions ran once each in fresh native sessions with `gpt-6.1-sol`, medium effort. The exact frozen `0.53.9` plugin was unchanged: 87 files, canonical inventory fingerprint `a6367025c7c9cd033bd68c6485316d136c790759ee93e9d6c3646e1c1b49941f`.

| Condition | Requested scope | Actual answer |
|---|---|---|
| G1 | Every manifest-listed policy: name, retry flag, delay, source; then identify disabled policies. | Both rows: `regional_primary=true/350 ms` at `zone_kappa.yml`; `isolated_preview=false/0 ms` at `zone_sigma.yml`. Names the disabled subset. |
| G2 | Only policies with timeout retries disabled: names, delays, sources. | Only `isolated_preview`, `0 ms`, `config/retry/zone_sigma.yml`; no unasked enabled row or delay. |

Both actors actually read `config/active_retry.yml` and both selected configs. Native outputs and actor-delivered labelled results match the fixture bytes. Manifest reads completed before child dispatch; each child pair ran in an executed labelled `Promise.allSettled` batch. These orchestration observations are diagnostic, separate from the primary answer-scope criteria. [grade.json](grade.json) records source item IDs, delivered values, wrappers and complete answers; runtime completion alone did not award PASS.

The raw fixture and initial context equal the earlier O5 case; only explicit user wording changed. Original O5 strict FAILs remain unchanged, including the [v2 FAIL](../native-v2/README.md) for omitting the enabled policy's delay under its frozen rubric. These two observations support a prompt-scope interpretation of that result. They do **not** establish that old O5 was fixed, prove a general completeness improvement, or justify adding a broader plugin rule. No production change was made for this diagnostic.

Each condition is a single synthetic observation, not statistical proof or a speed comparison. Zero-millisecond/staggered native timestamps do not prove physical read overlap. Clock was absent, matching the original O5 profile; clock-available waiting was tested separately by O6. Retained context is raw replay rather than native prior history, and fixture MCP metadata is simplified.

The archive preserves the exact package, definitions, actor inputs, real fixtures, final answers, statuses, selected nonsecret profiles, native preflight/isolation proofs, compressed native events/thread state/MCP audit and platform-specific repro scripts. Each preflight had 14 trusted hooks, 18 enabled skills, connected MCP and eight denied-path checks; [runtime-summary.json](runtime-summary.json) records one native turn per condition and actual balanced hooks. Auth files, actor homes, full per-home configurations, backend logs and environment bundles are excluded.

`raw-sha256.json` records byte hashes and gzip roundtrips. `inventory.sha256` covers the archive except itself. Repro scripts require the original `.tmp/` layout and macOS/native Codex environment; `shared-routing-run.py` belongs at `.tmp/plugin-routing-evals/run.py` and the RPC helper at `.tmp/codex61_app_rpc.py`. These files authorize no further model runs or replacement of previous attempts.
