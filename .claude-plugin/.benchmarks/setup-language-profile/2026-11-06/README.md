# Setup language profile regression

The upstream language additions made the setup profiler omit PHP, Kotlin and
Objective-C. The initial full run retained at
`/tmp/tea-rags-release.WNPdAD/tests.log` failed its extension-table assertion: 1
failed, 29776 passed, 3 skipped. The corrected four-test profile suite passed.

`cases.json` and `fixtures/` are reusable actor inputs. Expected answers are
separate in `grading.json` and were not supplied to either actor. Each native
Codex actor used gpt-6.1-sol with medium reasoning, n=1, and executed the
generated Codex setup package's `profile.mjs` against a temporary git
repository. Both the added-language case and the existing-language/ignore
control passed exact JSON grading.

Copy a case's fixture directory into a temporary repository before running its
prompt. Rename `src/b.ts.fixture` to `src/b.ts` before staging the control
repository: the suffix stores sample code as benchmark input data rather than
project TypeScript. Its bytes are identical to the `src/b.ts` used by the
retained actor run. Stage every fixture file, including ignored files, before
profiling.

`evidence.json` records source and generated-package fingerprints, model, run
count and limitations. The per-case result files retain observed public tool
events, final outputs, exit codes and paths to private raw journals. This is
narrow profiler validation, not a complete installation, embedding-service or
first-index benchmark. Failed earlier evidence was not replaced.
