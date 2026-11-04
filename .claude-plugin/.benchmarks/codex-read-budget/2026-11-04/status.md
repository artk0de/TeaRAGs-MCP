# Codex read-budget guard

The bound-write fix is accepted. A single-assignment Path binding is excluded
only when every use is a known write, write-only open or parent.mkdir. A real
read, unknown consumer, reassignment, alias or read/write mode keeps conservative
classification. Python AST only; arbitrary command code is never executed by the
classifier. Direct destinations and other-interpreter fallback remain intact.

Nine new executable generator cases: the three reproductions fail before the
patch with erroneous exit 2; six controls already pass. After the patch all
72 generator tests pass; 8 harness setup tests pass; lint passes. The existing
292 targeted backend tests and successful build cover the independent
distinct-file search changes in the same candidate. No full suite repeated.

Native gpt-6.1-sol/medium, n=1: original H05 FAIL retained; updated H05/H06/H07
PASS. Updated S01 actually exercises strict rejection. S02 is NOT_EXERCISED
under both updated and prototype policies: the actor refuses before tools.
Baseline S01 also refuses before tools. These are open limitations, not passes.

The unshipped two-file bounded-head prototype returns the same two names with
the same two model responses as parallel per-file reads (one executor wave plus
final). It prints 457 chars including headers versus 128 chars of per-file data;
outer labelled outputs are 622 versus 528 chars. These are different prompts,
so do not present wall/token differences as a matched performance result.
Eight synthetic executable safety checks pass, but the native over-cap control
remains open. Do not ship the relaxation; keep the default rule and parallelism.

Infrastructure attempt retained: the first sequence launcher started the
baseline controller, then failed because select.kqueue is not a context manager.
The launcher was corrected to explicit close and reattached to the existing
launch.json/PID. It did not relaunch or repeat baseline actors. Later stages ran
sequentially; one active model controller at a time; native process-exit waiting,
no sleep or busy polling.

Verification: review over all nine changed backend files plus the generator
built all five sections, introduced=0, touchedActive empty; the previous critical
public DTO/domain edge is resolved. Python embedded in scripts is explicitly
not judged by naming/cohesion (nonProduction/noCohesionData); no fabricated graph
coverage. One contract dependency norm is UNJUDGED/untypedRole, report-only.
The hook is covered by executable generator tests and actual native hooks.

Step 7 evidence:

```text
RISK code_md — scripts/** unindexed; blast radius unknown, native/executable guard checks used under the user's targeted-test requirement
N-TH-WAY find_similar: language-walker binding helpers are different AST/runtime boundaries; reuse the hook's existing Python AST parser, no new production module/import
PINS baseline 63; after patch 72 generator + 8 harness setup; 292 backend checks green
NAMING write_only NEW_TERM — kept: proves write-only AST uses; Python namespace has no competing project term
PARTNER tests/scripts/gen-harness-codex.test.ts — edited: bound destination and conservative fallback assertions
PARTNER harness/codex/tea-rags/hooks/hooks.json — not touched: matcher/command contract unchanged and existing generator test pins it
PARTNER scripts/gen-harness-cursor.ts — not touched: no one-file-read hook there (literal scoped absence check)
PARTNER harness/codex/README.md and harness/cursor/README.md — generated version references follow the source manifest bump
GATE review_changes: introduced=0, partial=false for returned sections; nonProduction/noCohesionData and UNJUDGED explicitly retained
```
