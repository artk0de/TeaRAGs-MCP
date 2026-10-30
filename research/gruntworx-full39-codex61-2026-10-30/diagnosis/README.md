# Why this Codex A session was slower

The saved traces show a longer retrieval procedure and more generated output in A, rather than a generally larger amount of tool text consumed. The observed execution of tools and hooks explains only about 10% of the elapsed gap. The rest lies in visible message streaming and uninstrumented model/request/client time. This identifies concrete avoidable work; it does not isolate a statistically reproducible plugin effect from one ordered A/B pair.

No new model turns, benchmark runs or corpus MCP calls were made for this investigation. Source/plugin behavior was not changed. Detailed calculations are in [latency-agent.md](latency-agent.md) and [latency-agent.comparison.json](latency-agent.comparison.json); examples and per-question tool arguments are in [waste-agent.md](waste-agent.md) and [waste-agent.json](waste-agent.json).

## Where the extra time occurs

Actor wall, excluding explicit corpus verification, is A 1,249.804 seconds versus B 793.899 seconds: A adds 455.905 seconds. Native turn windows differ slightly from that external clock and account for 455.630 seconds of the gap:

| Native elapsed component | A seconds | B seconds | Difference |
|---|---:|---:|---:|
| Tool executors and hooks, merged intervals |67.647|21.864|45.783|
| Visible assistant message streaming |494.492|375.116|119.376|
| Remaining request/model/client time |684.565|394.094|290.471|

The executor interval runs from the completed raw tool call to its matching output; generated tool arguments precede it. Overlapping hooks are merged, not summed. Message streaming and executor intervals do not overlap in these traces. The remaining 0.275 seconds of actor-clock difference falls outside native turn windows. No request-start events exist, so the residual cannot be labeled pure inference or attributed entirely to reasoning. Service latency variation remains a confounder.

A's 581 hook completions sum to 45.067 seconds of reported durations but occupy only 24.548 seconds of overlapping notification intervals. Most of that is already inside executors. Adding reported hook times to executor time would double count. Thus neither slow hooks nor slow MCP execution alone explains the overall gap.

## What the agent does differently

| Observation | A | B |
|---|---:|---:|
| Underlying model responses |110|87|
| Outer executor calls |71|48|
| Nested completed tools |150|54|
| Output tokens, including reasoning |35,331|23,898|
| Reasoning tokens, included above |4,444|529|
| Final answer text, characters |80,130|65,463|
| Generated outer tool arguments, characters |36,935|23,475|
| Delivered tool-output text, characters |633,313|660,550|
| Input minus cached input, tokens |208,975|209,103|
| Largest single request input, tokens |224,007|210,242|
| Compactions |0|0|

B's 48 outer calls comprise 47 exec wrappers and one clarification request; A's 71 are exec wrappers. These counts must not be interchanged with nested tools or underlying responses. Delivered tool-output text excludes the common additional-tools schema, and includes source, instructions, serialized metadata and envelopes; it is not a unique-code count. Native shell buffers can be much larger than delivered output because truncation happens before delivery. For example, B Q26's broad substring search matched a zip-code database and produced a 1,048,572-character stored buffer. Comparing that buffer to A's delivered MCP text would be invalid.

The 48% output increase includes reasoning, generated arguments and messages; it is not just longer final prose. Commentary differs by only 1,224 characters. In 13 questions with no tools in either condition, A still takes 55.101 seconds longer, with 4,613 versus 3,110 output tokens and only 1.537 seconds of additional hook intervals. More tool execution cannot explain that subset.

Concrete sources of extra work:

* **Q02, mock transport: 87.817 versus 33.505 seconds.** A uses 18 nested tools and 8 model responses; B uses 4 tools and 3 responses. After a search already finds the mock adapter/router, A lists the directory, requests the files, requests the Router class header/outline again, then requests methods. A later ranked search includes an unrelated serializer, and a dynamic callee edge points at `DocumentChecklist::Imports::Aliases.match`. These additions do not establish mock activation. Actual spec/config references remain necessary.
* **Q04, vendor/OAuth assumptions: 91.613 versus 47.101 seconds.** A activates Architecture Diagnostics, reading 25,983 characters of workflow instructions. Its architecture report takes 12.550 seconds and returns `rootCauses:[]`. The semantic OAuth mismatch is instead established by source bodies. That report explains part, not all, of the gap; workflow activation is broader than the question requires.
* **Q34/Q36 show granularity costs.** Q34 spreads 3,502 visible characters across 5 tools/2 wrappers; B retrieves 4,612 characters in 1 tool/1 wrapper. Q36 uses 9 tools/2 wrappers versus 1/1 with similar delivered text, 8,558 versus 7,971 characters. Per-file output limits do not require serial execution of independent reads.
* **Q06 is partly useful answer scope.** A produces a 6,121-character mapping table while B asks for missing documentation and gives a short fragment. The 42.242-second gap includes 40.891 seconds of additional streaming but just 0.332 seconds of executor/hook difference. B's manual completeness grade is borderline. Cutting A's answer down to B's size is not automatically an improvement.
* **Q26 contains useful extra retrieval.** A gets ticket-linked metadata unavailable to B's source-only search. It takes 31.407 seconds longer despite 3.195 seconds less executor/hook time. More work here is not uniformly wasteful.

There is one identical repeated BaseClient outline row, plus overlapping router/middleware outlines. Zero identical complete MCP result payloads did not prove there were no repeated fragments. The limited parsed-row audit did not find large repeated method bodies; shell/MCP overlap and reformatted fragments are not exhaustively measured. Five successfully loaded skills/references were each read once; no guide resources were reread. The earlier claim that repeats were eliminated must therefore be scoped to those instruction reloads.

## Why the older Claude result points the other way

The local Claude report is `/Users/artk0re/Dev/bench-private/taxdome/planning/results-2026-10-29-a053.md`; its raw A/B transcripts and marks are in sibling `runs/A-m53-sbx-nohist-bare/` and `runs/B-m26r2-sbx-nohist-bare/`. This investigation inspected those saved files without rerunning them.

| Existing replay | A seconds | B seconds | A/B |
|---|---:|---:|---:|
| Claude Sonnet 5.5, plugin 0.53.0 |1,027|1,191|0.862|
| Codex gpt-6.1-sol, plugin 0.53.7 |1,249.804|793.899|1.574|

These are separate experiments, not the same implementation on two interchangeable models. Claude's report excludes Q01 startup, uses a historical B reused from disk, and did not grade answer quality. Codex's clock excludes app-server startup and separately measures corpus verification. Model, harness, plugin version, tool interfaces and runtime all differ; there is one observation per condition. A causal comparison of model compatibility or speed is unsupported.

The traces nevertheless reveal a concrete strategy difference: Claude A uses only **13 MCP calls** (10 find_symbol, 3 semantic_search), plus 90 Bash, 1 Grep and 7 Read calls. Thirty-one Bash commands contain at least two sed/cat occurrences; many retrieve several source files in one operation. Codex A uses **72 MCP calls** (51 find_symbol, 11 semantic_search, 2 hybrid_search, 7 get_callees, 1 architecture report) plus 78 shell tools. Codex follows a more granular source/outline/graph route. Claude's favorable result therefore does not validate this Codex route.

Claude A makes 111 tools versus B's 96, a 15-call increase; Codex A makes 150 versus 54, a 96-call increase, though wrapper/batching differences limit direct cross-harness counts. Claude A's output grows about 13% versus its B, while Codex A's grows 48%. Token units are not comparable across the two models, but within-experiment ratios are informative. The original Claude report's B tool breakdown omitted one attempted Edit; the raw trace accounts for all 96 as 94 Bash, 1 Read and 1 rejected Edit. That attempt did not modify the corpus.

## Targeted next changes

1. Reuse known outlines and go directly from relevant search identifiers to the missing method bodies. Avoid directory enumeration after the requested files are already identified, and avoid an intermediate class-header request that only repeats an outline.
2. Restrict dependency/architecture diagnostics to questions that need structural evidence. Explain credential and port-contract semantics from the relevant implementations; a full detector report is not required merely because the question mentions an abstraction.
3. Execute independent bounded single-file reads concurrently in one wrapper, and batch known missing symbols. Preserve per-file output bounds without adding serial orchestration.
4. Keep answer size proportional to the requested evidence, while preserving requested tables and distinguishing useful completeness from padding. Do not treat Q06's shorter partial baseline answer as the target by default.

These changes target observed work; their speed effect remains unmeasured. There is no basis here to change the model, lower reasoning effort, reintroduce raw confirmations of trusted TeaRAGs bodies, or rerun a full benchmark automatically.

## Reproduction

`latency-agent.py <events.jsonl>` derives per-turn intervals and usage from one native event stream. The streams are preserved in this archive's raw gzip files and can be decompressed into a temporary directory for offline processing. The per-arm JSON and comparison retain values and timing definitions; the waste audit retains tool arguments, counts and delivered-output measurements. These helpers do not invoke actors. `inventory.sha256` in the parent directory covers these derived artifacts along with the original run data.
