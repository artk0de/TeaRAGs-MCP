# GruntWorx full39: Codex gpt-6.1-sol A/B

Exactly one fresh A session and one fresh B session completed all 39 questions. A used TeaRAGs Codex plugin 0.53.7 and the MCP server through the documented read-only isolation proxy; B had no plugin skills, hooks or MCP server. Both used `gpt-6.1-sol`, reasoning `medium`, the same bare opening, question texts, source snapshot and native filesystem/network policy. There were no pilot turns, repeated questions, harness retries or replacement runs. Quality is not inferred from these measurements; separate offline manual review is recorded below.

| Measurement | A: TeaRAGs | B: baseline |
|---|---:|---:|
| Completed question turns |39|39|
| Session wall excluding explicit file verification, seconds |1,249.804|793.899|
| Corpus/runtime verification, seconds |338.576|288.954|
| Controller session wall, seconds |1,588.380|1,082.853|
| Sum of question wall durations, seconds |1,247.689|791.649|
| Underlying model responses |110|87|
| Completed unique tool items |150|54|
| Shell / MCP items |78 /72|54 /0|
| Raw input tokens, accumulated across requests |16,062,927|12,370,383|
| Cached input tokens, subset of input |15,853,952|12,161,280|
| Input minus cached input |208,975|209,103|
| Output tokens |35,331|23,898|
| Reasoning tokens, subset of output |4,444|529|
| Largest single request input |224,007|210,242|
| Native reported context window |475,000|475,000|
| Compactions |0|0|

A's observed session wall excluding verification was 1.574× B's in this pair. That clock includes model responses, tools, hooks and orchestration. App-server initialization/startup and teardown are excluded. Verification hashes the actual readable corpus, including eligible ignored files, plus frozen runtime/config/helper files before every question and at completion; its measured duration is reported separately. This single pair provides observations, not a statistical effect estimate or an isolated attribution to one plugin instruction.

The native context window was left at its default: no `model_context_window` or automatic-compaction threshold override was set. Single-request input peaks are not cumulative token totals. Raw-response usage and latest thread usage agree exactly in both cells. `context-metrics.json` retains ordinary/compaction usage separately, per-response inputs, and first/last/max input per question. Empty compaction usage is not applicable because no compaction response occurred. Cached input and reasoning output are subsets; input minus cached input is provider accounting, not a count of unique source tokens.

A read five different skill/reference files, each once: Explore, its architecture-pattern reference, Architecture Diagnostics, and its phase 1 / phase 4 references. There were no guide-resource reads. The exact-result observer found one repeated 127-character shell observation in Q02 and no identical source-MCP result payloads. These counts do not measure overlapping fragments or prove that any read was unnecessary. Metadata discovery used a bounded names/short-description list and selected tool descriptions/schemas; no old full TeaRAGs catalog dump with truncation was observed. See [read-evidence-A.json](read-evidence-A.json) and each cell's `context-metrics.json`.

The proxy recorded 72 tool requests and 72 successful responses, with no rejected requests/responses or upstream errors. Before launch, all 17 exposed read tools had successful actual response fixtures; source bodies, resource text and table row counts were preserved. The live frozen upstream/proxy comparison preserved the 4,851-character registry source body and 19,961-character navigation guide exactly. Thirty-five adversarial/function/wire checks and native catalog/filesystem checks passed. Unlike the earlier Luna experiment, this run has no observed proxy parser/rejection failure. The proxy still scopes projects, removes registry configuration, and filters documentation; A is measured with that isolation layer.

Six A and four B shell items ended with native failed status. Four A and one B items were ordinary `rg` no-match exits, including compound commands whose final search returned no matches. The others were absent guessed paths or enforced documentation/`.git` denials; some commands also returned valid source hits. They are retained with commands, exit codes, durations and diagnostic lines in `read-evidence-A.json` / `read-evidence-B.json`. No MCP call failed. Tool failures are not correctness grades.

Source HEAD was `1d4c4ac600e813c8adf8e0ee61a316e5411068c0`; corpus HEAD was `f88b42f3c286815ea43b464960205d56445ee2e6`, alias `taxdome-worktree-navmaster`. The existing index was used read-only; no registry mutation or reindex occurred. The final native catalog showed A 18 enabled TeaRAGs skills, 14 trusted hooks with populated status messages, and 1 connected MCP server; B had none. Both had empty instruction sources and the same native permission profile. The benchmark process environment and argv were sanitized, prompts traveled over stdin, and actor filesystem access denied controller questions/gold, homes/auth, previous artifacts, sibling cells and corpus history/docs. Native process metadata is not claimed universally isolated; the bounded anti-leak limitation and actual frozen configuration remain in the manifest and reproduction files.

`A/answers/` and `B/answers/` contain 39 readable final answers each, extracted from native final-answer messages with no unknown-phase fallback. Raw global JSONL is preserved losslessly as gzip; `raw-manifest.json` records uncompressed and compressed SHA-256/byte counts, and `archive-verification.json` records round-trip verification. Per-question event copies are omitted because they are derivable from the global stream. Homes, auth, runtime binaries, private fixture payloads and private forensic logs are excluded. The original Luna archive and its inventory were not changed. `inventory.sha256` covers this archive except itself.

## Offline manual review

Review happened after both sessions completed, against the current source and the literal question, without injecting evidence into either actor. Three reviewers split the questions into [Q01–Q13](quality/quality-Q01-Q13.md), [Q14–Q26](quality/quality-Q14-Q26.md) and [Q27–Q39](quality/quality-Q27-Q39.md); accompanying JSON retains their detailed decisions.

| Manual verdict | A | B |
|---|---:|---:|
| Pass |36|35|
| Partial |3|4|
| Fail |0|0|

B Q06 is borderline: its clarification honestly avoids inventing a GruntWorx API, but omits known TaxDome mappings. Accepting clarification as a pass makes B 36 pass / 3 partial, equal to A. Each condition has one verified factual error: A Q19 overlooks archive as an exit from processed/exceeded states; B Q10 incorrectly applies return-type filtering to the in-flight duplicate guard. A Q01 and B Q39 also omit requested source details. Both Q26 answers qualify unavailable incident history and remain incomplete. These are diagnostic manual judgments, not calibrated accuracy estimates; this pair shows no clear quality advantage.

## Latency investigation

See [the saved-trace diagnosis](diagnosis/README.md) for time decomposition, unnecessary navigation examples, and why the older Claude result does not establish the same behavior on Codex. No model turns were run for this investigation.
