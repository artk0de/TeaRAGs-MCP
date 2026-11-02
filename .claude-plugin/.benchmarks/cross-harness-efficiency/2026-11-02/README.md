# P0 cross-harness efficiency: targeted cases

Parent: tea-rags-mcp-ng1ni; first fix: ng1ni.5 (embedded readiness).
Full GruntWorx72 campaign remains paused. These are two narrowly scoped cases,
one baseline and one candidate per harness: Codex gpt-6.1-sol/medium and Claude
claude-sonnet-5-5/medium, n=1, eight actors maximum. No Cursor subscription or
live run. Do not infer a full-benchmark performance win from these cases.

cases.json and fixtures/ contain only raw tasks/source. grading.json stays
controller-only. Native profiles must deny grading/controller/auth reads and
foreign plugin exposure. Each actor starts fresh; normal provider prefix cache
is reported separately. Real indexed fixture: p0-context-eval-ng1ni at
/Users/Shared/nav-ab/p0-context-eval-ng1ni, commit acdcb95. No ancestor project
instruction files; fixture source contains no gold or expected index identifier.

C01 uses embedded backend mode. C02 uses the explicit external URL of the same
live backend as a compatibility control. Both CLI and MCP get identical trusted
environment per case; environment values are not added to user prompts.
TEA_RAGS_AUTO_UPDATE=0 disables unrelated client self-update. Original TaxDome
index and paused actor homes are not modified.

Status: the specific embedded-sentinel behavior is verified in both harnesses;
local latest-main integration is being verified separately. See
`runs/firstfix-valid/verdicts.json`, the native-delivery addendum and
`integration.md`. The valid logical cohort reuses immutable generation05 baseline
Codex C01 plus seven generation08 conditions (n=1 each); failed/invalid attempts
remain explicitly recorded and are excluded from valid totals. Units21/21 are
source checks, not behavioral substitutes. Full benchmark remains paused.

No model-step or timing improvement is established: C01 uses one response and
C02 two in both variants/harnesses; provider caching, mixed controller generations
and source-age warnings limit comparisons. Public historical records are copied
without rewriting their earlier status headings. The reusable source runner and
public schema/observer assets live in `repro/`; actor profiles/auth/private logs
are not included. See `import-provenance.json` for exact original-file hashes.
