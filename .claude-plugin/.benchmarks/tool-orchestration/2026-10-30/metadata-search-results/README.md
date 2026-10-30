# Native metadata and search-evidence cases

Result: **four full passes and one partial case with an unsupported unit oracle**. All five fresh native actors completed once on `gpt-6.1-sol`, medium effort, with one turn and balanced hook events each. Completion status was checked separately from delivered tool output, actual arguments/results and final-answer facts. No actor was repeated.

| Case | Verdict | Observed behavior |
|---|---|---|
| M1: missing argument schema | PASS | One named lookup delivers a 405-character argument declaration, followed by one correctly parameterized inspector call and the true 17 / 5 / snapshot-217 answer. |
| M2: retained argument schema | PASS | No metadata rediscovery; one correct inspector call and the true 8 / 2 / snapshot-418 answer. |
| S1: retained full body | PASS | Zero post-prompt tools; correct 40 / 160 answer and source location from the actual retained body. |
| S2: metadata needs a body | PARTIAL, oracle limitation | One actual missing-body read; correct 100 / 200 / 500 values and location. The frozen “milliseconds” criterion is unsupported by the prompt and fixture, which specify no unit. |
| S3: downstream fact missing | PASS | A justified graph lookup and the actual downstream body establish three attempts, 100 / 200 ms waits and third-error rethrow. The held outer body is not reopened. |

M1's **actual delivered descriptor**, rather than the requested program alone, contains all six required argument fields and no shared core text, output type or unrelated tool descriptor. Its executor status header is a separate 47 characters. The fixture advertised a realistic 9819-character MCP description plus real input/output schemas; the native correct call and exact returned snapshot are recorded. This is not a before/after token or performance comparison.

There were five completed MCP calls in total: two inspectors, two source-body reads and one graph lookup. The latter three are source-context calls. One explore skill read is recorded separately. Four wrappers perform metadata introspection across the five cases. No pending-wait or asynchronous-question behavior claim is made from these tasks.

S2 is not a model failure. Its source is only `Math.min(100 * 2 ** attempt, 500)` in a method named `retryDelay`; neither the source nor the question establishes milliseconds. The answer correctly reports the numeric results without inventing a unit. Original fixtures and grading remain unchanged, with no retry. A future case can explicitly establish units in source and prompt.

The search-result banners were produced with `withAnswerBanner` imported from the current TypeScript source through `tsx`, not copied from a guessed string or stale build. The producer hash, command, full retained observations and no-turn native proofs are included.

Two package snapshots share version `0.53.9` and must be distinguished:

- This metadata/search snapshot: `694aac244746aa3fac8ccaa4b2daaf37b52e658754971c1826651bbc22b84b3c`.
- Earlier wait-only snapshot: `67cf171bf6c6e58fc64f9102bf1182405ba74542b72a3a7eae5c9d1181bbc472`.

These hashes cover canonical sorted relative-path-to-SHA256 inventories. The differing files are `scripts/codex-rules.txt` and the generated `skills/tea-rags-core/SKILL.md`. The earlier snapshot was not changed.

Archive layout keeps actor inputs separate from grading/oracles. Full native events, timelines, terminal snapshots, controller fixtures, profiles and preflight proofs are preserved; raw gzip copies have exact decompression/hash receipts. The frozen plugin contains all 87 files. Authentication files, home databases and unrelated plugin caches are excluded. The raw archive is evidence and must not be loaded as future actor context.

These are synthetic native fixture observations with one actor per case. They establish the tested behaviors and expose the S2 oracle limitation; they do not prove a general speed improvement, live production queue correctness, sleep compliance or the quality of a complete A39 benchmark.
