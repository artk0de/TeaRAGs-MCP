# Codex read-efficiency hypotheses

Selected initially: record native Codex shell stdout correctly, accept its `cmd` alias, and clarify that known configuration files need content rather than filename rediscovery. Generic extra policy paragraphs and Codex PostToolUse delivery notices were rejected.

Native Codex supplies Bash `tool_response` as a string. The previous adapter expected an object and omitted successfully delivered shell ranges from the ledger. A captured real event fails on the baseline and records exactly `yabeda.rb:1–115` with the selected source. Existing source matching and invalidation rules remain authoritative; this fix preserves Claude/Cursor contracts.

The original selection below used plugin0.53.10 on `cb9e37310`. Main changed concurrently during integration. The fix was rebased onto `72d035ba3`, preserving its plugin0.54.0, range-nudge and core changes. Three affected native cases are checked separately under `integration-0.54.0/`; the original archive/results remain unchanged. Original12 results must not be presented as a fresh full12 run on0.54.0.

The first0.54.0 integration gate recorded two supported answers and one route-scope `OPEN_FAIL`: the actor omitted the outer namespace without any PostToolUse notice. That failure is preserved. A narrowly targeted correction now requires enclosing namespaces for a fully qualified route controller and batches a missing bounded header with its excerpt. Its separate three-case check is recorded under `integration-route-scope-0.54.0/`; no fixture or grading changes were made.

The correction's three native cases all have supported final answers/source coverage, with3/2/3 model responses (8total). The route actor reads713–758 and1–85 in the same native model response and identifies the fully qualified controller. This corrects coverage at the same response depth, not a speed improvement. Current integration checks:158 hook checks and4 affected generator checks pass; ESLint exits0. The earlier failed route attempt remains `OPEN_FAIL` in its own archive.

All actors used `gpt-6.1-sol`, medium, once per case/variant, through the generated plugin's native install/hooks/MCP path. Actor inputs contain raw questions/source only; grading is separate and inaccessible. Fresh profiles do not disable provider prefix caching; cache usage is reported.

| Short comparison | Native model responses, including final | Decision |
|---|---:|---|
| Baseline / compact rules / procedural rules, same four cases | 16 / 16 / 17 | Reject both added-prose variants |
| Raw-stdout fix / extra delivery notice, same three cases | 11 / 11 | Reject notice: missing outer route namespace, `OPEN_FAIL` |

The original0.53.10 selected snapshot completed twelve local final-answer/source checks in 36 responses: 668,254 input tokens, including 445,312 cached; 5,584 output tokens. The fixed historical API-equivalent accounting proxy is $0.5462552, not subscription billing or a current pricing claim. Its original87-file generated TeaRAGs Codex package matched that evaluated snapshot; the current0.54.0 integration has separate evidence above.

These results do **not** establish that all original audit inefficiencies are fixed. Complete held-file, spec and backend cases answer without fresh reads; known methods batch correctly in their local case. Route scope still uses a later read. Q25's invented skill path and Q37's original staging did not reproduce. Naming remains `OPEN` as an efficiency diagnostic: the fixture omits the real `get_naming_lexicon` capability, causing schema/fallback work. Q01/Q15 are extracted subquestions, not full original-context replays. Metrics' virtual worker body lacks a physical file and therefore cannot establish ledger persistence for that method.

The initial suspicion that `TMPDIR=/nonexistent` disabled the ledger was disproven: native plugin data already existed. Preserve [the correction](native-plugin-data-correction.json); missing shell records came from the stdout adapter bug. Controlled-state comparisons remain matched.

See [summary](summary.json), [case dispositions](final12-audit-disposition-matrix.json), [protocol](protocol.md), [raw cases](cases.json), [grading](grading.json) and [provenance](provenance.json). Rejected/failed/unrun attempts remain open and preserved; none were silently retried. No full39 benchmark ran.

[Evidence archive](evidence.tar.gz): 1,559 hash-verified members, SHA256 `82a61d8bb4b38cddaf44ac2879b3b5ef3377c318829f31ff577965acc5a4bd73`; [inventory](evidence-inventory.json). It contains runner/dependencies, source snapshots/fingerprints, native transcripts, observed calls, state proofs and verdicts. No homes, auth files or caches are archived. Readable verification sidecars are separate from this immutable archive.

Original0.53.10 affected checks: generator 60/0, ledger 132/0, search-drift 132/0, Claude source copying 3/0; ESLint exits 0 with one then-existing `prefer-template` warning. See [verification](verification/summary.json). Integration checks are recorded separately. Full-suite, full39 and statistical efficacy remain unassessed.
