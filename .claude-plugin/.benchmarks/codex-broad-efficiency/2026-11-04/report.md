# Selected result: H2, not the best cases pooled across attempts

Model: gpt-6.1-sol, medium, n1 per policy/case. Native shipped-plugin path,
independent fresh homes/history; gold and old answers denied. Source backend
b9e62c298 (7,879 sealed files), corpus unchanged/read-only. No B or Claude run.

| Case                    | Fresh A0.55.5 steps | Selected A0.55.6 | Historical B | Fresh A seconds | Selected seconds |
| ----------------------- | ------------------: | ---------------: | -----------: | --------------: | ---------------: |
| Q01 contract/model      |                  11 |                9 |            9 |           142.8 |            106.4 |
| Q03 operational lessons |                   9 |               13 |           11 |           123.1 |            105.0 |

Fresh A's Q03 misses recording-hook scrubbing, so its nine steps are not a
quality-equivalent win. Selected H2 covers all five material points, including
retry/reset bounds and cassette creation safety; Q01 retains the required
background callback. H2 V01 confirms recording-hook scope and explicitly refuses
to infer retroactive cassette sanitization. W01 still follows requested workflow
preparation/reset, distinguishing workflow reentry from worker retry (20 steps;
not claimed optimized). No outer truncation occurred in selected Q01/Q03.

| Q01+Q03 token sums                  | Fresh A0.55.5 | Selected H2 | Historical B |
| ----------------------------------- | ------------: | ----------: | -----------: |
| input                               |       753,086 |     841,245 |      826,061 |
| fresh input                         |       172,862 |     122,141 |      168,269 |
| cached input                        |       580,224 |     719,104 |      657,792 |
| output (reasoning already included) |         8,805 |       7,873 |        6,503 |
| model responses                     |            20 |          22 |           20 |

H2 reduces fresh input29.3%, output10.6% and observed pair time20.5% versus
fresh A, while increasing total/cached input and steps. Native accounting is
unpriced; no dollar bill is invented. At unit rates p(input),c(cache),o(output),
H2 minus historical B costs (-46128p +61312c +1370o)/1e6. The exact break-even
is o/p < (46128-61312(c/p))/1370. This is a tariff condition, not current
pricing. For example c/p=.05,o/p=5 gives15.5% lower normalized cost, not a
subscription bill.

Q01 historical B took76.1s, so selected A is still slower there. Q03 B's407.5s
includes an environment interruption and is excluded from speed claims. These
are exploratory n1 samples with historical B; no causal full-benchmark speedup
or global superiority is established. Provider prefix cache is observed rather
than forcibly disabled. Public extracts exclude private reasoning/source bodies;
raw journals remain private at recorded paths/hashes.

H1 shortened Explore but regressed Q01/Q03 and still omitted scrubbing. H3
improved Q03 steps but regressed Q01 and lost entity-reuse coverage, so the
whole H3 policy was rejected. Failed source snapshots, transcripts and metrics
remain. Selected Explore bytes exactly match the H2 frozen package, SHA256
03c545370457182d778cb9aa1b0a2465ad897edf231df3c286189bd7e7f07023.

Code changes: optional Codex-only skill body uses canonical metadata/references;
compact Explore separates independent topics, routes spec creation/replay, stops
interface investigation at production dispatch, and accounts for the shared
outer executor budget. Canonical Claude/Cursor Explore/core and hook executables
are byte-identical to base. A passive Codex body template is also exported with
the Claude package; it is not linked by Claude's canonical skill.

Validation: 61 baseline generator tests; RED7694>4800;62 generator tests green
after implementation; targeted body-budget tests green after corrections;
structural skill validation green; native isolation/preflight gates pass. See
per-stage provenance, verdicts and verification scope. Overall performance goal
remains open: the next observed problem is global BFS pagination spending its
first40 rows on policy/other-file fan-out before local helper conditions.
