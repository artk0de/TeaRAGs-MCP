# Original16 observed outcomes

ORIGINAL16_PRESERVED; CODEX8_VALID; CLAUDE8_INVALID_NATIVE_PERMISSION_PATH

| Actor | Responses | Target bodies / rereads | Frozen core facts | Behavior attribution | Fresh/cache/output/reason tokens | Native cost USD |
|---|---:|---|---|---|---|---|
| baseline-codex-D01 | 5 | N/A | PASS* | DOMAIN_ADOPTION_NOT_SUPPORTED | 21350/77696/675/51 | unknown/unpriced |
| baseline-claude-D01 | 5 | N/A | PASS* | INVALID_NATIVE_PERMISSION_PATH | 24509/89706/1466/257 | 0.1216466 |
| baseline-claude-D02 | 4 | N/A | PASS* | INVALID_NATIVE_PERMISSION_PATH | 11086/64620/1049/66 | 0.0612800 |
| baseline-codex-D02 | 3 | N/A | PASS* | KNOWN_FILE_CONTROL_PASS | 19581/35968/422/0 | unknown/unpriced |
| baseline-codex-F01 | 4 | 2/1 | PASS* | FAIL_EXTRA_CURRENT_BODY_CONFIRMATION | 19731/54528/461/12 | unknown/unpriced |
| baseline-claude-F01 | 3 | N/A | PASS* | INVALID_NATIVE_PERMISSION_PATH | 10875/45795/703/31 | 0.0550975 |
| baseline-claude-F02 | 3 | N/A | PASS* | INVALID_NATIVE_PERMISSION_PATH | 10824/45749/432/0 | 0.0521789 |
| baseline-codex-F02 | 5 | 3/2 | PASS* | FAIL_EXTRA_CURRENT_BODY_CONFIRMATION | 11212/82944/461/23 | unknown/unpriced |
| candidate-codex-D01 | 7 | N/A | PASS* | DOMAIN_ADOPTION_NOT_SUPPORTED | 29756/159232/963/102 | unknown/unpriced |
| candidate-claude-D01 | 6 | N/A | PASS* | INVALID_NATIVE_PERMISSION_PATH | 16148/122769/1756/231 | 0.0944049 |
| candidate-claude-D02 | 3 | N/A | PASS* | INVALID_NATIVE_PERMISSION_PATH | 10538/46006/837/37 | 0.0551106 |
| candidate-codex-D02 | 3 | N/A | PASS* | KNOWN_FILE_CONTROL_PASS | 19496/35712/410/0 | unknown/unpriced |
| candidate-codex-F01 | 3 | 1/0 | PASS* | PASS | 19393/35584/397/0 | unknown/unpriced |
| candidate-claude-F01 | 3 | N/A | PASS* | INVALID_NATIVE_PERMISSION_PATH | 10514/45945/761/100 | 0.0542485 |
| candidate-claude-F02 | 3 | N/A | PASS* | INVALID_NATIVE_PERMISSION_PATH | 10569/46008/542/91 | 0.0522848 |
| candidate-codex-F02 | 5 | 2/1 | PASS* | PASS | 20281/73984/571/82 | unknown/unpriced |

*Core-fact factual grading only. Claude native denial invalidates plugin attribution; D01 Claude additionally overstates unverified caller absence.

Billable invalid Claude cost: **$0.5462518**. Total unique model responses: **65**. Codex price unknown, never zero.

Both Codex D01 first queries were exactly `refund settlement processing state changes dashboard event frame`, `metaOnly:true, limit:5`, with the target rank1 in identical returned top5. Both final answers meet the frozen core facts. The extra domain paragraph has no demonstrated adoption benefit. Candidate D01 used extra caller/schema/source exploration and7responses vs5; this n1 does not prove which wording caused the difference.

F01 delivered current complete body (~1193 serialized outer-output bytes) before any confirm; baseline fetched it twice, candidate once. F02 delivered old marked body (~1220 bytes), then current complete body; baseline fetched current again, candidate did not. All relevant outer responses have no truncation marker; native-only bodies are not substituted for held outer evidence.

Candidate F02 still used5responses: an unavailable `index_codebase` schema lookup returned `undefined`, then a broader index schema list was co-waved with the needed refresh. Fewer source reads did not reduce model responses. No index/write ran.

Claude attempted scoped TeaRAGs MCP calls, native dontAsk denied them, and it fell back to Read. A prompt revision would mask this harness defect; prompts remain unchanged. Corrected exact17allowlist is source-reviewed/tested but its actual native permission execution is not yet proven.

Prime payloads: all8Codex canonical external alias/collection;6/8Claude canonical. BaselineClaudeD02 andcandidateClaudeF01 delivered exit0 warm-up-pending placeholders. Source-age warnings exist inall8Claude. Exact public payload hashes are in `*-prime.json`.

First-body/confirmation outer IDs are retained in `original16-verdicts.json`. Public calls/results, native numeric usage/cost, extraction scripts and raw-source hashes are retained alongside it. No private reasoning content was selected.
