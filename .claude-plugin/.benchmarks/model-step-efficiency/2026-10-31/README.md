# Codex: missing evidence and model-step efficiency

User scope: Codex only. Model `gpt-6.1-sol`, medium, **one actor attempt per
case/condition**. No full GruntWorx replay was launched. Twenty case actors
completed across initial control/candidate, corrected-directory
control/candidate and two affected final-candidate cases. An independent review
agent graded answers separately; its usage is not part of case-cost totals.

## Shipped change

`scripts/gen-harness-codex.ts` now generates these Codex-only instructions:

- Choose missing facts from the current request before tools, reusing retained
  source/locators/edges inside workflows too. Explicit selection code does not
  require graph confirmation; missing caller/trigger/impact facts still permit
  graph.
- Resolve a known qualified member directly; clarify a genuinely ambiguous
  receiver or failed lookup. Metadata, outline and blocked reads do not count as
  an unseen body.
- Group already-known missing reads into one executor wave. Methods/files use
  symbols batch; directories use independent relativePath calls; config/spec
  reads remain bounded per file and labelled. Dependencies remain ordered.
- Resolve config filenames/policy names from a manifest with one scoped filename
  inventory, then read selected files. A content search for a filename does not
  locate that file.

Only generator plus `harness/codex/AGENTS.tea-rags.md`,
`tea-rags/scripts/codex-rules.txt` and `tea-rags/skills/tea-rags-core/SKILL.md`
changed. Common core, server schema/banner and real Claude/Cursor packages
remain byte-identical to base: **211 tracked files** checked against HEAD. The
earlier 109-file proof used a nonexistent Claude path and is explicitly
superseded in the retained proof.

## Observations: count model responses, not tool calls

One step is one deduplicated native `rawResponse/completed` response, including
the final answer. Parallel calls inside that response do not multiply the count.
Raw usage totals match native cumulative usage in every actor.

| Case                                     | Control responses | Candidate v1 | Final v2, affected only | Quality / changed behavior                                                                                        |
| ---------------------------------------- | ----------------: | -----------: | ----------------------: | ----------------------------------------------------------------------------------------------------------------- |
| R1 retained transport                    |                 4 |            4 |                       — | Answer PASS both; redundant graph removed, no response reduction                                                  |
| R2 selection body missing                |                 4 |            4 |                       — | PASS both; missing source still fetched                                                                           |
| M1 qualified member                      |                 3 |            3 |                       — | PASS both; direct lookup already worked in control                                                                |
| M2 ambiguous receiver                    |                 6 |            4 |                       — | PASS both; direct receiver method/body reads replace graph/outline detour                                         |
| B1 independent reads                     |                 2 |            3 |                       3 | Answers PASS; control batches but reads indexed TS with shell, candidates use MCP                                 |
| B2 dependent manifest                    |                 5 |            5 |                       4 | Answers PASS; v2 removes failed content search for policy filenames; dependency and selected-file scope preserved |
| D1 incomplete directory fixture          |                 6 |            4 |                       — | Candidate **PARTIAL/open**; fixture omits Ruby class declarations. Do not count as an efficiency win              |
| G1 missing CRM trigger                   |                 4 |            8 |                       — | Both report unknown external entry; broad prompt and wildcard graph fixture limit attribution                     |
| D2 corrected complete directory metadata |                 3 |            3 |                       — | PASS both; valid independent relativePath calls, no response reduction                                            |

The **original eight-case** total is **34→35 responses**, so it does not show an
overall improvement. Standard API-equivalent cost is **$0.392578→$0.398810**.
The final v2 was tested only on B1/B2: **8 responses in v1→7 in v2**, versus 7
in the original control (whose B1 uses the wrong source-reading route). Do not
combine different fingerprints into a purported full-final-candidate aggregate.
Results at n=1 are diagnostic; no latency or full39 quality/speed improvement is
established.

## Cost and caching

USD Standard estimate: `(input-cached)*2/1e6 + cached*0.10/1e6 + output*10/1e6`,
from [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
checked 2026-10-31. Cache write reported 0; reasoning included in output, not
added twice. This is not an actual Codex subscription bill. Cache-hit and
machine load differed; compare measured categories, not just response counts or
cache ratios.

For corrected D2, identical response counts still cost $0.0295532 control versus
$0.0452108 candidate because cache hits differed. Final B1/B2 cost $0.0889276
versus v1 $0.1062548 and original control $0.0820264. These small single
observations do not isolate an instruction effect on cache pricing.
Index/infrastructure/reviewer costs are excluded.

## Cases, boundaries and preserved problems

Actor-only `cases.json`, `directory-corrected.json` and `config-affected.json`
hold natural prompts and raw synthetic fixtures. `grading.json` is separate and
is never served by fixture MCP. Native profiles deny controller, fixtures,
source repository and auth paths; actor workspace/plugin reads are permitted.
Plugin installation, trusted hooks, enabled skill provenance, MCP connection and
filesystem denials are checked before model turns. This uses small
retained-context text, not fresh native tool history or a 200K context stress
test.

- Original B1 rubric demanded milliseconds absent from prompt/source.
  `grading-original.json` is retained; the corrected rubric evaluates values
  without requiring invented units, equally in both conditions. Actor inputs
  were unchanged and not rerun for this rubric correction.
- Original D1 remains PARTIAL. D2 separately supplies complete class/method
  directory metadata, with exactly one corrected actor per condition. It does
  not overwrite the failed attempt.
- G1's graph override matches any callers query and returns the same edges;
  production regression cannot be inferred from extra upstream-entry research.
  Actual missing-trigger graph use remains allowed.
- Initial candidate preparation froze an old package before generation finished
  and then failed with an empty startup catalog. **Zero actor turns** ran there.
  The failed preparation is retained. Candidate-v1 preparation followed
  completed generation; its actual new rules, installed inventory and
  fingerprint were verified. Startup preparation now waits on native
  notifications even for an initially empty catalog.
- V2 is a relevant correction after observing B2's redundant filename-content
  lookup, not an unrecorded retry of an unchanged candidate. Previous v1 results
  stay intact. Only B1/B2 were rerun against it.

## Fingerprints and verification

Advertised plugin version remains **0.53.9**; fingerprints identify each tested
source:

- Base/source HEAD `8cabb11aee4027d071e767d6251c5cbd0cf40beb`.
- Control: `a6367025c7c9cd033bd68c6485316d136c790759ee93e9d6c3646e1c1b49941f`.
- Candidate v1 / corrected D2:
  `9fb3c097382f86eaa96f37ca0e01b3945b6af47d6ec0f8b92d89fa2fdd76674d`.
- Final config v2:
  `76c348dbbf6c6bdf93509d7694c5dd26a970b0cd64c6b9626d476ea68ea6573a`.

The installed Codex cache was first matched to the complete control inventory;
only `scripts/codex-rules.txt` and `skills/tea-rags-core/SKILL.md` were updated
in place. Its complete inventory now matches final v2 exactly; see
`installed-proof.json`. The advertised version was not bumped. SessionStart
instructions activate in new Codex sessions; the MCP server did not change and
needs no restart.

Generator tests: baseline **58/58**, candidate-v1 **58/58**; after final text
correction, affected hook-budget/generated-copy checks **2/2**. Script
type-check passes after linking existing root build assets into the isolated
worktree; the first missing-build import errors are retained. Prettier
TS/Markdown and `git diff --check` pass; the initial unsupported `.txt` parser
command is retained. Server implementation did not change and was not rebuilt.
No full test suite was run.

Codegraph review found introduced architecture findings=0 but cannot judge these
nonproduction/docs files fully: naming checked=0/notJudged=4, cohesion
analyzed=0, architecture notJudged=3. Impact scan is UNVERIFIABLE because
generator and generated harness are ignored by the index. Relevant generator and
behavioral checks were used according to the user's explicit narrow-testing
requirement; no clean architecture verdict or invented blast-radius signal is
claimed.

`results.json` retains exact per-case usage/fingerprints and archive SHA.
`evidence.tar.gz` contains prompts, raw fixtures, actor transcripts, answers,
original attempts, preflight proofs, package snapshots, review, reproduction
helpers and validation logs. Every listed member is verified byte-for-byte.
Actor homes, auth, full configs and environment bundles are excluded.
Reproduction helpers are platform/path-specific and reference the original
`.tmp` layout; restore their original locations or adapt paths without changing
cases/candidates. All failed/unrun hypotheses remain open. The full GruntWorx
correctness review and any new full A/B remain separate work.
