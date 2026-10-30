# Plugin changes: behavioral eval gate

Every plugin change, including skills, descriptions, routing, references and
hooks, must add or update relevant behavioral eval cases and run them against
the updated plugin before claiming completion. This applies to feature work and
fixes, not only explicit skill optimization.

Keep reusable cases in `.claude-plugin/.benchmarks/`. Cover the changed behavior
and a nearby control that must still work. Execute only affected cases; do not
repeat the full benchmark for a small change. Respect the user's chosen model
and run count.

Keep prompts and raw fixtures separate from expected answers and grading rules.
Evaluate independent actors using the shipped plugin/injection path; record
observed tool calls and outcomes. Generator, wording, budget and unit tests do
not replace behavioral evals. Failed or unrun cases remain open; do not report
them as closed or silently retry them until they pass.

Persist the plugin version/source fingerprint, model, cases, transcripts and
verdicts with explicit limitations. Re-run a case after a relevant correction
and retain the failed attempt. Evidence must support any completion claim.
