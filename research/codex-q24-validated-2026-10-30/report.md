# Q24: corrected paired Codex replay

The repaired historical-corpus experiment completed all six runs. Both arms answered the literal dictionary/downcase proposal without new tools. The checkpoint already contained the necessary Registry and BaseClient bodies, so zero calls are compatible with appropriate evidence reuse. This experiment does not demonstrate a benefit or regression from filename-first discovery, because no discovery was performed.

The literal user question chooses `GruntWorx`, proposes `instead => Instead` / `gruntworx => GruntWorx`, and says `downcase` is enough instead of `camelize`. It does not explicitly request an autoload initializer location. The answers contain technically valid string-transform observations. Old-1 has mixed wording about whether a dictionary is needed; all answers predominantly frame the mapping as display labels rather than implementing Ruby namespace lookup. None identifies the existing BaseClient method that should change. Treat them as narrow responses with incomplete contextual grounding, not verified complete implementation plans.

## Results

| Cell | Tools | Input | Cached input | Output | Reasoning | Wall seconds |
|---|---:|---:|---:|---:|---:|---:|
| validated-old-1 | 0 | 160610 | 11520 | 102 | 0 | 10.419 |
| validated-new-1 | 0 | 160609 | 0 | 101 | 0 | 8.226 |
| validated-new-2 | 0 | 160609 | 11520 | 145 | 0 | 12.535 |
| validated-old-2 | 0 | 160610 | 11520 | 106 | 0 | 10.802 |
| validated-old-3 | 0 | 160610 | 11520 | 119 | 0 | 8.659 |
| validated-new-3 | 0 | 160609 | 11520 | 132 | 0 | 8.774 |

Old means: 9.960 seconds and 109 output tokens. New means: 9.845 seconds and 126 output tokens. With three pairs and no search, these differences do not establish a discovery-quality or efficiency effect. All cells exit zero, expose reasoning tokens explicitly, and contain no error events.

Historical autoload diagnostic: neither arm finds/cites `config/initializers/zeitwerk.rb` (0/3 each). No answer makes an unsupported absence claim. The autoload omission is recorded separately from direct user intent; the question did not expressly ask for that location. No answer explains the already delivered `BaseClient#vendor` / `underscore` implementation, so a stronger context-grounded response was possible without additional tools.

## Why existing evidence was sufficient

The checkpoint contains actual delivered code:

- Q01, context record12 / original transcript line31, full Registry body: `ADAPTERS = {instead: TaxPreparation::TaxAutomations::Instead}.freeze`; `adapter_for_provider(provider)` uses `ADAPTERS.fetch(provider&.to_sym)`, and `provider_of(adapter)` uses `ADAPTERS.key(adapter)`. The current registry normalizes strings to symbols; it does not downcase arbitrary input. This is explicit namespace lookup, distinct from display labels.
- Q21, context record179 / transcript line367: `BaseClient#vendor` contains `@vendor ||= self.class.name.deconstantize.demodulize.underscore`. The surrounding delivered code tags metrics with `vendor`. That body suffices to explain `"GruntWorx".underscore → "grunt_worx"` versus `"GruntWorx".downcase → "gruntworx"` without rereading the repository.
- No checkpoint record contains `zeitwerk.rb` or `inflections.rb`. A concrete repository-specific initializer claim would require more evidence; its absence does not invalidate the already supported dictionary/downcase reasoning.

## Setup and corrections

Real Codex CLI, explicit `gpt-6-luna`, medium reasoning, fresh homes, plugins disabled, `exec --json --sandbox read-only --ephemeral`. Both arms use the identical repaired frozen old MCP runtime, isolating the single projected core-rule paragraph. `nameCodeTools` projects the full old/new canonical cores with the same Codex dialect. Context and core hashes are recorded in `manifest.json`.

Correct repository: `/Users/Shared/nav-ab/repo-master`, full alias `taxdome-worktree-navmaster`, clean HEAD `f88b42f3c286815ea43b464960205d56445ee2e6`. No source edit, reindex or registry mutation. The prior repo-a localization runs are preserved separately and marked invalid for historical end-to-end comparison: the wrong snapshot lacks historical Registry/LinkEntity source, and the copied runtime lacked a required static root asset.

Before these six corrected runs, the missing `.qdrant-required-version` asset was restored to the frozen runtime. A direct stdio MCP check successfully completed `initialize`, `tools/list`, a nonempty Registry source read, and the original nine-file Q03 batch. The nine delivered Q03 content hashes exactly match the historical transcript line112, providing direct evidence that this corpus reproduces the saved Q03 content. The historical session's full commit hash was not saved in its run status; current HEAD is recorded rather than assumed identical.

The 533109-character transferred checkpoint is unchanged: bare opening/Q01–Q23 questions and visible assistant/tool messages only, ending at historical line419. No `context_added`, gold fields, Q24 answer, hidden thinking, or later answer is included. This is transferred visible-context replay, not native Codex resume. The same exact Q24 question was used; only the erroneous execution-path/alias prelude was corrected for both arms. Model inputs contain no search hints added to force tool use.

Raw CLI transcripts, answers, statuses, corrected grading, prompts and hashes are archived here. Private CODEX_HOMEs, auth links, MCP configuration and runtime binaries are excluded. See the neighboring Q03 report for the direct tool replay; it confirms the existing budget deferral remains but the new continuation notice is explicit.
