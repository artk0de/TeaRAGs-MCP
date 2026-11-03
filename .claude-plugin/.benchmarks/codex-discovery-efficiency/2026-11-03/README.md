# Codex discovery efficiency, 2026-11-03

Target: shipped TeaRAGs Codex plugin 0.55.5; gpt-6.1-sol, medium, one
independent actor per case and policy variant. No B or Claude model runs. Raw
questions/fixtures are in `cases.json`; controller-only grading is in
`grading.json`. Actors cannot access grading, previous answers, or other
profiles.

The native controller installs the generated plugin into fresh OS/Codex homes,
checks 18 skills, 14 trusted hooks and 17 read-only MCP tools, and verifies
denied access to protected inputs before starting any model. Its immutable
backend is b9e62c298 (7,879 sealed files); generated backend resources are
unchanged. TaxDome corpus and index are read-only. A provider prefix cache
cannot be cleared or disabled by this controller: observed cached tokens are
recorded, never misrepresented as an assurance of zero provider caching.

`evidence/*/public-actions.json` records public tool arguments, source locators,
body hashes, outer truncation, hooks and model-response waves. It excludes
private reasoning and source bodies. `metrics.json` counts model responses
(parallel tool calls remain within one response), input/cached/output tokens and
observed time. Original raw journals remain private at their recorded paths and
hashes. Failure variants remain evidence, not passing retries. Final shards may
overlap (at most two actors), so their wall times do not establish causal
speedups.

Reproduction requires the retained local frozen runtime and native controller
template referenced by `repro/prepare_stage.py`; it intentionally contains no
credentials. The shipped plugin fingerprint and controller/backend hash evidence
are in the per-stage provenance records. Authenticate through the native Codex
profile, never by embedding tokens in fixtures. Preparation runs no model turns.
Use `/opt/homebrew/bin/python3` for preparation/launch (the runtime guard
rejects other Python binaries). Launch only a new prepared stage, never
overwrite or silently resume a completed/failed actor. Every policy correction
gets a new stage and retains previous outcomes.

The original A10 provides RED evidence for needless setup, overly broad filename
inventory, and missing adapter/retry coverage. It also contains pre-existing
quality gaps; fewer steps alone does not turn an incomplete answer into PASS.
See the experiment ledger and report for accepted and rejected hypotheses.
