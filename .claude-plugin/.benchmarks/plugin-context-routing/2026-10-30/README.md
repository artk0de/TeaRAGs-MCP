# Plugin context routing: 2026-10-30

**13/13 behavioral cases passed**: four targeted-read cases, four batching cases and five architecture-activation cases. These are current-plugin instruction-routing results on synthetic fixtures. There was no baseline arm, so they establish neither a before/after improvement nor a speed gain.

The source run was `.tmp/plugin-routing-evals/runs/20261030-182853-286087000`. Each case completed exactly one native actor turn, once, using `gpt-6.1-sol`, medium effort and TeaRAGs plugin `0.53.8`. No-turn preflight verified 14 trusted plugin hooks, 18 enabled plugin skills and a connected fixture MCP server in each isolated workspace. Actual runtime notifications contain **321 hook starts and 321 hook completions**, balanced per case; trusted registration was not treated as proof of execution. See [runtime-summary.json](runtime-summary.json) and [manifest.json](manifest.json).

| Case | Observed behavior | Result |
|---|---|---|
| targeted-1 | Reads the known candidateCount body directly; answers 40 and 160. | PASS |
| targeted-2 | Reuses the retained complete body with zero new retrievals; answers 250/500/2000 ms. | PASS |
| targeted-3 | Rephrases retained facts in two bullets with the code location; no new tools. | PASS |
| targeted-4 | Retrieves the missing shouldRetry body rather than inferring behavior from an outline. | PASS |
| batch-B1-Q34-config-spec | One executed Promise batch reads four known config/spec files; finds the 10-second versus 0-second mismatch. | PASS |
| batch-B2-Q36-known-migrations | One executed Promise batch reads three known migrations; explains schema, composite index and index-only rollback. | PASS |
| batch-B3-known-source-methods | One symbols request returns all three required bodies; distinguishes policy, email delegation and webhook refusal. | PASS |
| batch-B4-dependent-discovery-control | Reads the manifest first, then batches both selected configs; reports 45/0-second delays. | PASS |
| architecture-101 | Investigates OAuth-shaped contracts and runtime branches without activating architecture diagnostics. | PASS |
| architecture-102 | Explains subsystem organization from source without a diagnostic report. | PASS |
| architecture-103 | Explicit audit loads diagnostics and the report reference, then calls the scoped architecture report. | PASS |
| architecture-104 | Structural-refactoring request calls the report and a concrete restructure simulation; qualifies unavailable plan ordering. | PASS |
| architecture-105 | Explicit named-skill invocation loads diagnostics and calls the scoped report. | PASS |

The eight targeted/batching cases were graded independently by `/root/eval_architecture_gate`; root independently reviewed the five architecture answers and traces. [grade-other-cases.json](grade-other-cases.json), [grade-other-cases.md](grade-other-cases.md) and [grade-architecture.json](grade-architecture.json) retain criteria, tool/wrapper IDs, observed bodies and answer evidence. Required reads needed actual nonempty content; no-tool guesses or promised calls did not satisfy them. [runner-review.md](runner-review.md) records the separate pre-run review and its follow-up checks.

## Evidence and limits

Each `cases/<case>/` contains the actor input, deterministic fixture, status, thread-start facts, filesystem allowance/denial proofs, final answer, compressed native events and compressed MCP audit. The original three definitions are under `definitions/`. Expected answers and grading were kept outside actor input; fixture/controller/auth paths were denied to actors. The archive contains no authentication files, actor homes or per-home configuration bundles.

Retained context was replayed as raw chronological facts in the user input, not inserted as native conversation history. MCP metadata/descriptions were simplified. Graph queries without an explicit fixture returned `noEdgeFixture`; these runs do not validate real index or codegraph algorithms. Relative-path lookups in the fixture adapter return outlines even for short files. In architecture-102, a mixed class/method batch conservatively dropped content, causing additional body reads. That case establishes the activation boundary, not globally optimal retrieval counts.

File batches used actual `Promise.all`/`Promise.allSettled` wrappers and returned the required per-file bytes. Native operations had zero-ms or staggered scheduler timestamps, so overlapping execution timing is **UNVERIFIABLE**. Correct batching was graded separately from scheduler timing. There were no artificial delays, latency claims or production-index measurements.

## Snapshot and reproduction

`plugin-snapshot/` preserves the exact tested **87 files, 541,422 bytes**, before later formatting. Every file hash matches `manifest.json`'s `source_plugin_sha256`. The SHA-256 of its sorted `hash  relative-path\n` inventory is `d1d4415205e5db68a900cd41580716079d5d268af4a0df6e6c279d92593c5802`. `inventory.sha256` covers the archive's files except itself and can be checked from this directory with `shasum -a 256 -c inventory.sha256`.

The five Python files under `repro/` are archival, platform-specific scripts, not a portable standalone runner. Restore `codex61_app_rpc.py` to `.tmp/codex61_app_rpc.py` and the other four to `.tmp/plugin-routing-evals/` in the original repository layout. They require the original native Codex/macOS runtime and local executable paths. Their grading commands expect the original raw run layout, including actor thread/event files; this compact archive preserves the corresponding compressed evidence rather than actor homes. Consult the scripts before any new run; copying the archive does not authorize model turns.
