# Codex reading depth, 2026-10-31

Model: **gpt-6.1-sol / medium**, one actor per case and tested source fingerprint.
Native Codex 0.166.0 installs the shipped plugin in separate fresh homes, with
14 trusted hooks, 18 skills and a fixture MCP. Raw source/context is separate from
grading. Native filesystem probes deny grader/controller/other homes/auth.

The final policy plans evidence for all current subquestions, reuses proved
facts, and merges ready reads with the current or an already-unavoidable
dependent wave. It must not create another model response for a ready group.
Reading every helper earlier is not the objective. Source coverage and factual
support remain mandatory. More than 20 symbols uses concurrent valid batches.

## Final affected cases

| Case | Valid control responses | Final v3 responses |
|---|---:|---:|
| W02 mock route, handles, transport/spec |5|4|
| W21 HTTP errors and OAuth metrics |4|3|
| W35 methods plus absence check |3|3|
| Dependent discovery |4|4|
| Partial header is not a body |3|3|
| Batch21methods |4|3|
| Total |23|20|

All 6 final response-depth/factual cases passed independent semantic review.
Limits were recorded before actors ran. Inputs: 490350→429781 tokens;
outputs: 5018→4982. These small fixtures establish neither full 39-question
quality nor a general latency/cost/optimality claim. The full A/B is separate.

## Retained failures and limits

- Initial control preparation lacked generated .mcp.json: 0 model turns.
- Control-v2 exposed fixture/parser/grader defects. It is retained and is not
  evidence of a plugin improvement. Source repairs use saved deliveries plus
  one authorized read-only corpus batch, documented in provenance v2/v3.
- Candidate-v1 saved responses on suggestion/batch cases but still split known
  W02/W21 reads; strict efficiency gate remained OPEN.
- V2 reached 4/3 responses on W02/W21. The literal ALL-first/11-body contract
  still failed. W02 needs a subsequent discovered spec read; W21 does not need
  token_connection to prove its actual claims. These strict failures remain
  **OPEN_FAIL** diagnostics, not retroactive PASSes.
- Before v3, a separate response-depth/factual gate was recorded. All-ready-first
  is explicitly not its contract. Native completed turns are not graded answers.
- W35 absence is limited to the compact fixture file. Retained real source
  coordinates can differ from compact file positions. Some optional backend
  methods are unserved; no unsupported final claim was accepted for them.
- n=1 per case/fingerprint; repaired fixtures and changed policy fingerprints
  justify the recorded new attempts. Failed attempts were not overwritten.
- Generator 58 baseline tests, expected new-test RED, 59 GREEN, and 5 affected hook/
  budget checks after each later policy correction are retained. Controller
  tests 33 PASS. These do not replace native behavioral evidence.

`cases.json` contains prompts/raw fixtures; `grading.json` contains evaluator
rules and is never actor-readable. Provenance files identify actual source.
`evidence.tar.gz` retains frozen packages, actor inputs/events/answers, proofs,
reviews, failed attempts, controller source/tests and logs. Auth/home trees are
excluded. `evidence-inventory.json` hashes every archived member.
