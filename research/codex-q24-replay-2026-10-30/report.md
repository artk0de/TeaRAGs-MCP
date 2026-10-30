# Codex Q24 paired transferred-context replay

**End-to-end setup invalid; textual observations retained.** A subsequent direct MCP readiness check found that the copied server runtime lacked its required root `.qdrant-required-version` asset and could not initialize. The six CLI outputs remain real, but successful MCP availability was not established before those runs. Additionally, `/Users/Shared/nav-ab/repo-a` is an older localization snapshot: its `registry.rb` and `link_entity_by_name.rb` files do not exist, although the transferred historical context contains their bodies from `/Users/Shared/nav-ab/repo-master`. The mapped scoped index likewise lacks all nine Q03 files. These runs cannot be treated as a valid end-to-end test of repository discovery. A repaired rerun must validate initialization, tool listing, a nonempty source read, and the correct historical repository before model calls.

## Corrected interpretation

The literal Q24 request is about choosing `GruntWorx`, using an explicit dictionary, and using `downcase` instead of `camelize`. It does not explicitly ask for an autoload initializer location. Five answers are acceptable narrow responses to that request; new-3 is mixed because it starts by saying the explicit dictionary is unnecessary, then correctly says the reverse mapping needs one. None connects the proposal to the already delivered `BaseClient#vendor` implementation. All six omit the historical Zeitwerk gold fact, but that omission alone does not establish failure to satisfy the literal user request.

All six made zero tool calls. Relevant source was already in the checkpoint, so zero calls are compatible with correct evidence reuse. This experiment provides no evidence that the filename-first rule helped or harmed discovery; the agents did not perform discovery. The original report's blanket `0/3 versus 0/3 failure` interpretation conflated a historical autoload diagnostic with direct user intent and is superseded by this audit.

## Evidence available before Q24

Exact final question:

> Хочется именно GruntWorx, просто сделаем явный словарь
>
> instead => Instead
> gruntworx => GruntWorx. Значит не camelize нужен, а downcase, этого хватит

The transferred checkpoint contains actual delivered source bodies, not merely filenames or outlines:

- **Registry**, Q01, context record12, original transcript line31. `app/lib/tax_preparation/tax_automations/registry.rb:10`: `ADAPTERS = {instead: TaxPreparation::TaxAutomations::Instead}.freeze`. Lines24–28: `adapter_for_provider(provider)` uses `ADAPTERS.fetch(provider&.to_sym)` and raises for an unknown key. Lines54–56: `provider_of(adapter)` uses `ADAPTERS.key(adapter)`. The method does **not** currently downcase a mixed-case incoming key. The full numbered Registry body was delivered.
- **BaseClient**, Q21, context record179, original transcript line367. The delivered `sed` output includes lines418–520 of `app/lib/tax_preparation/tax_automations/base_client.rb`, including `def vendor; @vendor ||= self.class.name.deconstantize.demodulize.underscore; end`. It also includes the neighboring vendor-tagged metrics. This is sufficient to explain that replacing `underscore` with `downcase` changes `GruntWorx` from `grunt_worx` to `gruntworx`, without a new tool call.
- Q16's prior answer, context record160, explicitly restates the registry's namespace lookup and reverse `ADAPTERS.key` mapping. Q21's prior answer, record184, describes BaseClient's vendor-tagged metrics. No pre-Q24 record contains `camelize`, `grunt_worx`, `zeitwerk.rb`, or `inflections.rb`; the initializer implementation was not delivered. A concrete repository-specific autoload location claim would therefore need additional evidence.

Existing code evidence supports answering the dictionary/downcase proposal. It does not justify claiming that all autoload implications have been checked. The bare question leaves the desired scope narrower than the benchmark's historical gold criteria. Also, several answers frame the dictionary as display labels and show strings; those examples should not be mistaken for a verified implementation of a namespace-to-module registry.

## Observed answers and metrics

| Cell | Direct literal request | BaseClient grounding | Zeitwerk diagnostic finds/cites | Calls | Input | Cached | Output | Reasoning | Wall s |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| old-1 | acceptable narrow | omitted | no/no | 0 | 160609 | 11520 | 88 | 0 | 8.509 |
| new-1 | acceptable narrow | omitted | no/no | 0 | 160607 | 11520 | 250 | 113 | 9.723 |
| new-2 | acceptable narrow | omitted | no/no | 0 | 160607 | 11520 | 125 | 0 | 8.786 |
| old-2 | acceptable narrow | omitted | no/no | 0 | 160609 | 0 | 98 | 0 | 9.142 |
| old-3 | acceptable narrow | omitted | no/no | 0 | 160609 | 11520 | 102 | 0 | 11.131 |
| new-3 | mixed wording | omitted | no/no | 0 | 160607 | 0 | 91 | 0 | 9.676 |

No answer makes an unsupported absence claim. New-1 cites the already available Registry/FirmSettings evidence. Old-1/2/3 and new-2 accept an explicit dictionary. New-1 says `Instead → instead`, `GruntWorx → gruntworx`; new-2/3 correctly distinguish reverse mapping. None explains the existing `underscore` method or proposes the exact BaseClient change.

Old mean wall 9.594s and output96 tokens; new mean wall9.395s and output155.333 tokens. With three trials and no search, these numbers do not support an efficiency or quality conclusion about filename-first discovery. Historical autoload diagnostic is 0/3 in both arms, reported separately from direct-intent grading.

## Method and reproducibility

Real `codex exec`, explicit model `gpt-6-luna`, medium reasoning, six fresh CODEX_HOMEs, plugins disabled, same MCP configuration and copied frozen server runtime, `--json --sandbox read-only --ephemeral`. Repository `/Users/Shared/nav-ab/repo-a`, commit `293529bb11cf77278d8cce857c5d286fd72d46ed`, remained clean and unchanged. Frozen runtime excludes the separately developed retrieval-delivery-state implementation. The core paragraph is the only projected rule difference.

This is a **transferred visible context replay**, not native Codex resume or an exact reproduction of Claude's hidden/system context. The 533109-character checkpoint reconstructs bare opening/Q01–Q23 question text only and visible assistant text/tool calls/tool results, ending at original transcript line419 (23rd result boundary). It excludes thinking/signatures/system events, duplicate result answers, all `context_added`/gold fields, and all Q24+ responses. Exact Q24 is appended without hints. No context reduction or truncation was applied. `config/initializers/zeitwerk.rb` is absent from the checkpoint.

The same `nameCodeTools` function and Codex dialect transform the original and final compact canonical cores. Exact context/core/prompt hashes and run order are in `manifest.json`. Raw CLI JSONL, final answers, statuses and corrected grading are archived; reasoning tokens were explicitly exposed by CLI usage. Credentials, auth symlinks, CODEX_HOMEs, MCP configuration and copied runtime are excluded from the research archive.

Two setup attempts were invalid and excluded: relative CODEX_HOME failed before startup, and sandbox network failed before a model response. Network retry used proper escalation approval. All six valid cells exited zero with no error events.
