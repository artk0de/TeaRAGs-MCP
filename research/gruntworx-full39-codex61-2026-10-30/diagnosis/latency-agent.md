# Saved Sol A/B latency decomposition

Sources: existing runs/A and runs/B events.jsonl and marks.json; archived summary.json. Same gpt-6.1-sol/medium; one sequential A-then-B sample. No new runs, model/MCP calls or production/archive edits.

Actor wall excluding corpus verification: A1249.804s, B793.899s, delta455.905s (+57.426%). Sum marked question walls1247.689/791.649s. Native turn notification windows sum1246.704/791.074s; delta455.630s. Actor time outside native turn windows3.100/2.825s accounts for the remaining0.275s delta.

| Native turn partition | A seconds | B seconds | A minus B | Share of native delta |
|---|---:|---:|---:|---:|
| Tool executor + hooks, interval union |67.647|21.864|45.783|10.048%|
| Visible assistant message streaming |494.492|375.116|119.376|26.200%|
| Remaining request/model/client time |684.565|394.094|290.471|63.752%|
| Total native turn windows |1246.704|791.074|455.630|100%|

**Definition:** pair rawResponseItem completed custom_tool_call/function_call with its matching call_id output. The interval begins after tool-call arguments have been generated and ends when its output notification arrives. Merge overlapping intervals and union them with hook started/completed notification intervals. This observed blocking envelope captures dispatch/startup plus nested hooks, without double counting. It is a critical-path occupancy proxy, not CPU usage or a counterfactual causal estimate. No exact model-request-start events are available.

Raw outer executor intervals alone total61.903/21.864s; their sums equal their unions (no observed overlap). Adding hooks adds only5.744s outside A executors. Native inner tools alone total35.523/14.142s; native shell timers omit startup (41/54 B commands report0ms despite nonempty output), so they are insufficient as the main tool latency measure. Both observations produce a roughly46s executor/hook delta, far below the456s overall delta.

A has581 sync hook completions:4 sessionStart,117 userPromptSubmit,237 preToolUse,223 postToolUse. Reported hook duration sums45.067s, while notification interval sums63.181s and their union24.548s. Concurrent hooks and overlap with executor envelopes mean none of those sums can be added to67.647s. B has no hook events.

Counts: native inner tool calls150/54; outer exec wrappers71/47, plus one B request_user_input_async function call lasting0.053s. Raw model responses110/87. These are different counting levels. A has78 shell and72 MCP calls; B54 shell calls. Output tokens35331/23898 (+11433,+47.841%); reasoning tokens4444/529 (+3915); remaining output tokens30887/23369 (+7518). More output and23 additional responses are observed, but no per-token causal time attribution is justified.

Largest marked question wall deltas (last three time columns partition native windows, which differ slightly from marked walls):

| Q | A wall | B wall | Marked delta | Executor/hook delta | Stream delta | Residual delta | Responses A/B | Output tokens A/B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Q02 | 87.817 | 33.505 | 54.312 | 4.516 | 9.138 | 40.579 | 8/3 | 2477/1058 |
| Q04 | 91.613 | 47.101 | 44.512 | 13.836 | 3.980 | 26.688 | 4/2 | 2013/1290 |
| Q06 | 60.499 | 18.257 | 42.242 | 0.332 | 40.891 | 1.014 | 2/2 | 2094/430 |
| Q03 | 84.776 | 51.194 | 33.582 | 2.852 | 5.598 | 25.129 | 8/5 | 2583/1598 |
| Q26 | 60.776 | 29.369 | 31.407 | -3.195 | 7.152 | 27.445 | 4/3 | 1374/697 |
| Q01 | 123.519 | 94.766 | 28.753 | 9.448 | -7.190 | 26.467 | 12/8 | 3866/3438 |

Top5 question deltas sum206.055s; top10 sum308.945s. Q06 is the clearest answer-length/streaming case: only0.332s extra executor/hook envelope,40.891s extra visible streaming, output2094 versus430 tokens. Q26 actually spends3.195s less in executors/hooks while taking31.407s longer overall.

Thirteen questions have zero native tool calls in both conditions:Q08,Q10,Q11,Q13,Q14,Q18,Q19,Q24,Q25,Q27,Q31,Q32,Q38. Their marked wall totals177.880/122.779s (delta55.101s); native windows177.571/122.515s (delta55.056s). They each have13 model responses. A hook union1.537s versus0; streaming82.857/67.374s (delta15.483s); residual93.177/55.141s (delta38.036s). Output4613/3110 tokens (+1503), reasoning982/103 (+879). Additional tool invocations cannot explain this subset's slowdown; changed output/hidden reasoning and uninstrumented request latency remain compatible explanations.

Limits: visible streaming intervals are first-to-completed message timing, not decoder CPU. Residual includes inference/request latency, hidden reasoning, generated tool arguments, transport, client bookkeeping, and other uninstrumented gaps. Therefore roughly90% of the extra elapsed time lies outside observed executor/hook blocking, but the saved traces cannot prove which server-side mechanism caused it. Single ordered A/B sessions cannot separate condition effects from service latency variation. All hook/call pairs matched; no overlap with visible message streaming was observed.

Machine-readable per-question values and definitions:latency-agent.comparison.json. Reproduction helper:latency-agent.py; per-arm derived values:latency-agent.A.json and latency-agent.B.json.

