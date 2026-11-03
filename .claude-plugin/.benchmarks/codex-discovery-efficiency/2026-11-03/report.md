# Outcome

Codex-only policy changes remove a standalone setup response on focused
questions, start property lookup with the named construct, and stop when a
proven rejection makes downstream internals irrelevant. Explicit Explore and
requested downstream investigation remain separate controls. Filename globs now
explain union semantics; independent ready reads share executor waves without
exceeding result budgets.

Static startup plus turn-routing context: **17,385 → 16,889 characters** (496
fewer, 2.85%). Per-turn routing alone: **1,624 → 987**. This measures text
characters, not provider tokens. The full scheduling rule remains at startup.
Route namespace scope remains in the actual turn hook; duplication was removed
from startup.

Latest bounded-navigation model responses, not tool-call counts:

| Case                        | Old A 0.55.4 | Candidate | Outcome                                                                    |
| --------------------------- | -----------: | --------: | -------------------------------------------------------------------------- |
| Q08 size units              |            7 |         5 | Correct binary boundary and equality; first query only the named construct |
| Q10 pre-send rejection      |            5 |         5 | Correct refusal scopes/dispatch; no internal retry detour                  |
| E01 explicit Explore        |      not run |         6 | Requested skill loaded; correct rejection answer                           |
| W01 explicit internal retry |      not run |        13 | PASS: real workflow/preparation/reset and step retry distinction           |

Named lookup L01 and held-code R01 passed in their recorded policy variants (2
and 1 responses). The final navigation correction leaves their contracts
unchanged; their evidence is not relabelled as a fresh full campaign. Q01/Q03
completeness guards recovered the required background adapter callback and
ten-retry/reset limitations. Their later broad-survey answers used **16/14
responses vs old 11/12**, while an earlier quality variant used 11/10. These n1
samples do not prove a general response-count reduction; broad investigation
batching remains open. Do not quote the best intermediate 4-step Q10 as the
final result.

Rejected broad-domain and globally-short-query variants, plus the 8-step Q08/Q10
candidate, remain in `experiment-ledger.json` and public transcripts. No failed
variant was silently retried until passing. A copy-only correction was followed
by separate lookup/reuse controls. Final navigation corrections received new
independent questions on the generated shipped-plugin path.

Validation: 61 affected generator tests green, structural skill validation
green, native preflight isolation tests and protected-input denials pass.
Worktree build and pre-commit checks have retained logs. No full suite or A/B
campaign was run. Each native actor uses a fresh independent home and read-only
MCP proxy. Provider prefix caching remains observable and uncontrollable, rather
than falsely disabled. No memory/previous benchmark answers are supplied. Final
answer and source-fact grading is controller-side; model reasoning is neither
inspected nor exported.

See `verification.md` for review gate and its unjudged source-graph limitations.
Claude/Cursor behavior is unchanged; no Claude behavioral validation is claimed.
