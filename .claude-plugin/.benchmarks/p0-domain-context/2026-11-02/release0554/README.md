# P0 acceptance — plugin 0.55.4

**Integration approved; Claude follow-up waived by user on 2026-11-03.**
The two remaining Claude resource-discovery cases are NOT RUN, not passed.
See integration-decision.json for the explicit instruction and scan limitations.
The eight direct/hook cases below passed. A subsequent
guide-consistency correction passed both explicit-guide Codex cases. Claude's
guide cases exposed an overly restrictive builtin-resource metadata guard; its
correction passes55 pure checks but the live follow-up is blocked by Anthropic
`verification_required`. The user requested integration without that follow-up.
Full cross-harness validation is therefore not claimed.

Eight final shipped-path actors satisfy the targeted behavior criteria.
Integration is recorded separately after merge. Models: gpt-6.1-sol/medium and
claude-sonnet-5-5/medium; n=1 valid result per selected condition/case. Cursor
is static only. The full GruntWorx campaign remains paused.

| Case                                | Codex 0.55.3 → 0.55.4 responses | Claude 0.55.3 → 0.55.4 responses | Observed behavior                                         |
| ----------------------------------- | ------------------------------: | -------------------------------: | --------------------------------------------------------- |
| D02 known file                      |                           3 → 2 |   unchanged control previously 2 | First Codex tool is find_symbol                           |
| F01 current body, unrelated pending |                           3 → 2 |                            2 → 2 | One body delivery; no confirmation                        |
| F02 genuinely stale body            |                           5 → 3 |                            3 → 3 | Same find_symbol arguments repeated once; no Read refresh |
| D01 unknown location                |                           7 → 7 |   unchanged control previously 6 | Explore/discovery retained; correct domain/body           |
| C02 storage configuration           |                           2 → 2 |                            2 → 2 | Correct source facts; Codex membership CLI launches 2 → 0 |

The isolated description-only experiment failed (3/3/7 responses), and its
source and results remain retained. The explicit first-call rule passed (2/2/7).
Short freshness wording failed on Claude; the stronger repeat-the-same-arguments
rule passed before combination and again in the final package. The first final
Codex F01 attempt returned serverOverloaded, with no valid answer; attempt02
retains that failure and provides the single valid result. Model substitution
and behavioral retries until a pass were not used.

Final machine checks: ../runs/release0554-verdicts.json. The final cohorts are
../runs/release0554-domain, ../runs/release0554-domain-attempt02 and
../runs/release0554-startup. Raw prompts remain in ../cases.json and
../../../prime-agent-startup/2026-11-02/cases.json, separate from the frozen
domain-grading.json and startup-grading.json. Source/profile/runtime
inventories, public tool actions, final answers, native usage and private
raw-journal hashes are retained for every actor. Credential files and private
reasoning are absent from the public exports.

## All six issues and evidence

1. **Eval isolation/native MCP permission:** exact17 readonly tools, Codex18
   skills/14 named hooks and Claude17 source skills/11 public commands; actual
   successful MCP execution, not merely catalog discovery. See
   ../runs/main-acceptance01 and final cohort native before/after checks.
2. **Domain anchor:** the literal original Q20 including Instead/GruntWorx
   context succeeds in both harnesses in6 responses. No answer paths or new
   domain rule were injected. See ../q20-repro and
   ../runs/q20-main-acceptance01.
3. **Synchronous overhead:** lean prime retains addresses without the full CLI
   bootstrap/backend ping; neutral reads no longer boot membership CLI. The
   actual C02 audit changed from2 launches to0. Instrumented hook component
   records distinguish child wall/CPU from native outer intervals. Safety hooks,
   mixed read/search exemption, third-search denial, cooldown and resets remain
   synchronous and preserved. Historical169s is not claimed fully explained.
4. **Rereads/freshness:** F01 reads once despite unrelated pending3; F02
   refreshes the same requested locator once via MCP and answers the current
   value.
5. **Embedded sentinel:** prior validated firstfix cohort remains at
   ../../../cross-harness-efficiency/2026-11-02/runs/firstfix-valid; current
   startup4 retains correct addresses and honest unknown readiness.
6. **Instruction-only first response:** the narrow Codex known-file/local-body
   exception eliminates Explore-only setup on D02/F01. Discovery/flow/explicit
   skill workflows retain their skills; D01 is the nearby control.

## Verification and limits

Hook baseline132/132; new regression tests initially141 pass/3 fail, then144/144
after correction. Five affected generator checks and51 controller checks passed;
the isolated branch build completed. No full test suite was run.

Earlier experiments used c807; final package uses the newly built4e8042bdb
branch plus these changes, preserving unrelated main work. The source change and
first tool action establish the scheduling result; no cross-engine causal
whole-model latency or universal search-quality claim is made. Provider prefix
cache is observed, not cleared. Claude costs are native list-equivalent
estimates, not an invoice; Codex remains unpriced.

One final Claude C02 answer correctly names the configured variables/default
relationship but additionally assumes IAM isolation. Configuration alone does
not establish real permissions or resolved environment values; that extra claim
is not accepted as evidence. The table grades the requested source facts and
changed tool behavior, not perfect accuracy of every added sentence.

The shared-main mutation invalidated freshness05; it is preserved separately.
Subsequent dedicated runtimes and post-actor seal checks passed. Startup01 had
historical identity wording in its old grading file, overridden by the explicit
current-main pre-model spec; raw fixture/source bindings were real. Final
release graders explicitly bind the current package/engine condition.

OpenAI documents synchronous hooks as the default and background hooks as unable
to control tool operations: https://learn.chatgpt.com/docs/hooks. No blanket
async conversion or global hook-trust bypass was introduced.
