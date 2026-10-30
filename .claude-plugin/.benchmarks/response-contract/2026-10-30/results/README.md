# Response-contract experiment: 2026-10-30

**Decision: INCONCLUSIVE_LOW_BASELINE; NOT APPLIED.** Reported reasoning tokens changed from **253 to 252 (−0.395%)**, below the preregistered 500-token control floor. Only **2 of 4** pairs with nonzero control reasoning decreased, and the required aggregate decrease of at least 20% was not reached. All **16/16** case/arm quality reviews passed. No candidate change was applied to production.

## Hypothesis and tested candidate

The hypothesis was that a final-answer contract could reduce reported reasoning tokens while preserving evidence gathering, correctness and explicit detail requests. The private candidate appended exactly this text to `scripts/codex-rules.txt`; no other plugin file differed:

> For code-investigation tasks, lead with the direct answer. Include only facts needed to answer the request, relevant code locations, and caveats that affect the conclusion. Omit the search narrative, a repeated conclusion, and an unsolicited next-step plan. By default, keep the final answer within 180 words and use at most six bullets or one compact table. Explicit requests for a complete table or inventory, code, a plan, detailed explanation, or another required format override these defaults: preserve every requested item and necessary detail. This contract governs the final response only; required evidence gathering and tool use remain unchanged.

The frozen [preregistration](frozen-design/prereg.json), [candidate bytes](frozen-design/candidate.txt) and [guard cases](frozen-design/evals.json) are preserved. The gate required at least 20% aggregate `reasoningOutputTokens` reduction, a strict decrease on a majority of control-nonzero pairs, and no quality/instruction regression. Aggregate control reasoning below 500 or fewer than three nonzero control pairs made the result inconclusive. Zero-control pairs remained in aggregate and quality checks. These rules and the eight cases were fixed before candidate results.

## Design and results

Eight fixed cases ran once per arm in fresh native sessions: current plugin `0.53.8` as control and its private appended-contract copy as candidate. Both used `gpt-6.1-sol`, medium effort, the same tools and permissions, and matching actor inputs/fixtures after cwd/alias normalization. Each arm had 14 trusted plugin hooks, 18 enabled plugin skills and a connected fixture MCP. All 16 cases completed exactly one native actor turn; actual hook events were balanced at **336 starts / 336 completions**. [Equality proofs](prep-equality-proofs.json), [runtime summary](runtime-summary.json) and [source EOF summary](source-runtime-summary.json) retain the checks.

| Case | Reasoning A → B | Output A → B | Quality A/B |
|---|---:|---:|---|
| Missing method body: targeted-1 | 0 → 0 | 363 → 217 | PASS / PASS |
| Retained full body: targeted-2 | 20 → 25 | 65 → 87 | PASS / PASS |
| Config/spec comparison: batch-B1 | 0 → 0 | 390 → 363 | PASS / PASS |
| Migration schema: batch-B2 | 0 → 0 | 370 → 373 | PASS / PASS |
| Contract behavior: architecture-101 | 12 → 0 | 1047 → 845 | PASS / PASS |
| Subsystem overview: architecture-102 | 91 → 73 | 1917 → 1585 | PASS / PASS |
| Explicit complete table: response-201 | 0 → 0 | 1384 → 814 | PASS / PASS |
| Explicit deep detail: response-202 | 130 → 154 | 1618 → 1774 | PASS / PASS |
| **Aggregate** | **253 → 252** | **7154 → 6058** | **16/16 PASS** |

The primary counters come from unique native response-usage records and reconcile with completed-thread totals; cumulative usage updates were not repeatedly added. Output tokens cover the complete actor turn, including generated tool-call arguments, rather than final-answer word count alone. Secondary observed sums were output tokens **−15.32%**, native turn duration **199,430 → 178,484 ms**, and controller wall duration **215,519 → 190,272 ms**. These descriptive timings do not establish a repeatable latency improvement.

Root independently graded config/spec, migration and both new guard pairs; the metric agent independently graded targeted-read and architecture-negative pairs. Required retrievals needed actual returned source bytes. Both complete-table answers preserved all 12 rows and full purposes; both were 457 whitespace-counted words. Deep-detail answers were 657/697 words and preserved all ten worked examples, code, branches and locations. See [metric/decision grade](grades/metric-grade.json), [root quality grade](grades/root-quality-grade.json), [independent quality grade](grades/independent-quality-1.json) and [merged quality](grades/independent-quality-2.json).

## Evidence and limits

`cases/<arm>/<case>/` retains allowlisted actor inputs, fixtures, status, thread-start facts, filesystem proofs, hook-injection proofs, answers, observed metrics, compressed native events/thread state and compressed MCP audit. `plugin-snapshots/` preserves both exact packages; their only difference is the appended contract. No auth files, actor homes, per-home config bundles or backend process/environment logs were copied. [raw-sha256.json](raw-sha256.json) records copied-byte hashes and verified gzip decompression roundtrips. `inventory.sha256` covers the archive except itself; verify with `shasum -a 256 -c inventory.sha256` from this directory.

This is one observation per case/arm on synthetic fixtures, not statistical proof or a full Gruntworx benchmark. Retained context was replayed as raw facts rather than native history. Fixture tool metadata was simplified; unspecified graph queries returned `noEdgeFixture`, and relative-path lookups returned outlines even for short files. A mixed class/method batch could drop body content and cause extra reads. Native file-overlap timing remains unverified where scheduler timing is too coarse. Cache state, scheduling and model variability limit timing comparisons. A reported zero reasoning counter does not prove an absence of internal reasoning; the observable control baseline was too small to support this hypothesis.

The `repro/` scripts are archival and platform-specific. Restore them to their original `.tmp/plugin-routing-evals/` paths, except `codex61_app_rpc.py`, which belongs at `.tmp/codex61_app_rpc.py`, before reviewing reproduction requirements. They do not authorize another model run. The original preregistration and candidate files remain unchanged; the tested candidate stays private and unapplied.
