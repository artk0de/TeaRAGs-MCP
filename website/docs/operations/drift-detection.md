---
title: "Drift Detection"
sidebar_position: 6
---

# Drift Detection

## What drift is

Every index run stamps what produced it: the payload keys the build declared,
the version of each language's chunker and walker that ran, the indexing
environment, the commit HEAD sat on. Drift is the comparison of those stamps
against what the current build, environment or working tree would produce now.

Nothing breaks when they disagree. The index keeps answering — some of what it
answers with was produced by an older build. The report tells you which stamps
moved and names the one command that repairs all of them.

## Where you see it

| Surface                              | Behaviour                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `driftWarning` on a search response  | Once per collection per server session, and again after every index run. It rides along with an answer, so it does not nag. |
| `## Drift` in `tea-rags prime`       | Every time. Prints `none` when the stamps match.                                                                             |
| `get_index_status`                   | Every time, appended as a `## Drift` block when something moved.                                                              |

`prime` and `get_index_status` inspect without consuming: a status call has to
answer the same way twice, and the once-per-session warning belongs to the next
search.

## Axes

One monitor per axis. A single report can carry findings from several.

| Axis                     | Compared                                                                                                                                                   | Stamp                      | Example                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------- |
| Payload keys             | the payload signal descriptors the running build declares vs the keys the collection recorded when it was indexed                                          | stats cache `payloadFieldKeys` | `codegraph.symbols.chunk.fanIn: absent → declared` |
| Language versions        | per-language `grammar` / `chunking` / `walker` / `codegraphSchema`                                                                                         | registry `languageVersions` | `python.walker: 1 → 3`                             |
| `*` (shared pseudo-lang) | shared kernel / resolver chain / chunker versions                                                                                                          | `languageVersions["*"]`    | `*.walker: 1 → 2`                                   |
| Indexing env             | the canonical indexing keys, grouped by what a change to each invalidates — chunk set, git enrichment, codegraph enrichment; runtime-only keys never drift | the registry `env` snapshot | `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: strict → first` |
| Working tree             | HEAD's sha vs the commit the last run indexed                                                                                                              | `RegistryGitState`         | `main: abcdef1 (dirty) → 0123456`                   |

<!-- axes: extend below -->

A moved HEAD is the cheapest finding there is: the remedy is a plain incremental
run, which the [auto-update watcher](/operations/auto-update) performs on its own
when it is enabled, so the finding usually clears without anyone typing
anything.

## Reading a report

A finding is one line — `subject: indexed → current` — grouped under its axis,
with the single command last:

```text
Language versions:
  python.walker: 1 → 3
Run: tea-rags index-codebase --project myapp --force-enrichments codegraph --languages python
```

A finding may carry a note in parentheses. A note explains what the reading
means, rather than restating it:

```text
Indexing env:
  CODEGRAPH_ENABLED: true → false (explains any codegraph.* payload-key drift — restore the flag instead of rebuilding)
```

The command is folded over every finding, so a report with several lines still
names exactly one. Findings that belong to a single language keep
`--languages`; one collection-wide finding — the shared `*` sources, an env key
— widens the whole command:

```text
Language versions:
  python.walker: 1 → 3
  *.walker: 1 → 2
Run: tea-rags index-codebase --project myapp --force-enrichments codegraph
```

### Phantom schema drift

The most common payload-key drift is not a schema change at all. Codegraph and
git payload descriptors are declared only when their trajectory is enabled, so a
process started with `CODEGRAPH_ENABLED` or `TRAJECTORY_GIT_ENABLED` flipped off
declares fewer keys than the index recorded, and every `codegraph.*` key reports
as removed. The env axis names the flag that explains it. Restore the flag in
the process that reads the index — a SessionStart hook running in a fresh shell
is the standing offender — instead of rebuilding anything.

## Remedies and their cost

| Remedy        | Command                                                                              | Cost                                      | What it rebuilds                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `none`        | `No action required.`                                                                | —                                         | Nothing. Every finding is something the current build stopped declaring, and nothing reads a key that is not declared. |
| `incremental` | `tea-rags index-codebase --project <alias>`                                          | seconds                                   | The files that changed since the stamped commit.                                                                      |
| `recompute`   | `tea-rags index-codebase --project <alias> --force-enrichments <scope> [--languages <lang>]` | minutes                                   | The enrichment payload, in place. No re-embedding, chunk ids unchanged.                                                |
| `force`       | `tea-rags index-codebase --project <alias> --force`                                  | minutes to hours on a large project       | Everything: new chunk ids, every vector re-embedded. Zero downtime — built into a new collection, alias swaps at the end. |

The report always names the cheapest command that repairs every finding it
lists, with `--project` already filled in from the registry. Escalation is
one-directional: a report mixing an enrichment-owned finding with a chunk-set
one gives you the `--force`, which rebuilds the enrichment layer anyway.

`--force` is reserved for findings that MOVE THE CHUNK SET — a grammar or
chunking version, a changed embedding model or chunk size. Chunk point ids hash
file content and line range, so those relocate every id and nothing short of a
full rebuild is coherent. Everything else rewrites payload in place, which is
why `--force-enrichments` is measured in minutes where `--force` is measured in
hours.

A report can also be non-empty and say `No action required.` — that is a
collection carrying payload keys this build no longer declares, which costs
nothing and repairs itself the next time those points are written.

## Embedding model

`EmbeddingModelGuard` refuses a collection built by a different embedding model
than the one currently configured. It checks two things, and the second is why
an index that "nothing changed" under can still be wrong.

**The name.** Every collection's marker point (`__indexing_metadata__`) stores
`embeddingModel`. Point `EMBEDDING_MODEL` somewhere else and the next search or
index run fails with HTTP 409:

```text
Embedding model mismatch: collection indexed with "nomic-embed-text",
current config uses "mxbai-embed-large"
```

**The weights.** A name is not an identity. `nomic-embed-text:latest` is a
moving target: the tag gets republished upstream, `ollama pull` fetches new
weights, and your collection keeps the same model NAME while its stored vectors
came from a model that no longer exists. Search still returns results — they are
quietly worse, because query vectors and stored vectors now sit in slightly
different spaces.

So the guard also stores a canary: one fixed text, embedded the first time it
sees the collection and kept in the marker next to the model name. Every later
run re-embeds that text and compares it against the stored vector by cosine.
Below `EMBEDDING_CANARY_MIN_COSINE` (0.999) the collection is refused with the
same 409, and the reason says which check fired:

```text
Embedding model mismatch: collection indexed with "nomic-embed-text",
current config uses "nomic-embed-text (same name, different weights:
canary cosine 0.9412)"
```

Two ways out:

- Point `EMBEDDING_MODEL` back at the model that built the index — pin a version
  tag instead of `:latest` if one exists.
- Rebuild with the model you now have:
  `tea-rags index-codebase --project <alias> --force`. A full reindex is the only
  tool for this; the vectors themselves are what changed, so
  `--force-enrichments` cannot help.

Collections indexed before this check existed have no canary. The first run that
opens one embeds the canary and writes it into the marker, so comparison starts
from that moment — it does not retroactively detect a swap that already
happened. A full reindex rewrites the marker without a canary, and the next run
writes one from the model that did the rebuild.

If the embedding provider is unreachable when the canary would be checked, the
guard logs `[ModelGuard] Canary check skipped for <collection>` and continues on
the name comparison alone. A provider that is down must not block indexing.

## Codegraph payload heal

A codegraph signal is a property of the whole graph, not of one file. When a file
gains a caller, loses an importer, or drops in PageRank, the cause is usually a
change somewhere else — and until now the payload only got rewritten for files
that changed themselves. A file that stopped changing kept whatever `fanIn`,
`fanOut` and `pageRank` it had the last time someone touched it.

Every index run now diffs the fresh graph against the signals it recorded at the
end of the previous run and rewrites the payload of exactly the symbols and files
that moved — including the ones no commit went near. It is a payload rewrite and
nothing more: no re-extraction, no re-embedding, no change to the chunk set.

Two things to expect after upgrading:

- **The first run heals every point once.** The baseline starts empty, so the
  first run treats everything as moved and does one full payload sweep. It costs a
  scroll and a write per file, no embeddings. Runs after it are bounded by what
  actually changed, which on a normal incremental is a handful of files.
- **`isHub` and `transitiveImpact` are not themselves triggers.** Both are
  whole-collection quantities — `isHub` compares against a p95 that moves for
  every file at once, `transitiveImpact` is a depth-capped reverse BFS — so they
  are refreshed for the files the diff already names and otherwise wait for the
  next `tea-rags index-codebase --force-enrichments codegraph`.

The heal runs in the completion tail and reports itself in the debug log:

```text
[GitEnrich] PHASE: CODEGRAPH_PAYLOAD_HEAL | {"collection":"…","pointsRewritten":412,"filesTouched":57}
```

A heal that fails is logged as `CODEGRAPH_PAYLOAD_HEAL_FAILED` and does not fail
the run — the baseline is only advanced once the rewrite lands, so the next run
retries the same diff.

## After upgrading tea-rags

A report can appear right after an upgrade with nothing changed on your side. A
release that touches a walker, a resolver chain or the shared kernel bumps the
version the build declares, so every index built before it now carries an older
stamp: the code moved, the payload did not.

This release bumps the shared walker, so every index built before it reports
`*.walker: 1 → 2` once. The shared sources run under every language, so the
recompute it recommends is deliberately not narrowed by `--languages`:

```bash
tea-rags index-codebase --force-enrichments codegraph
```

After that run the stamp catches up and the report goes quiet.

## Related

- [Recovery & Reindexing](/operations/recovery-reindexing) — the three reindex
  modes and what each costs
- [Auto-Update Watcher](/operations/auto-update) — who runs the incremental for
  you
- [Troubleshooting & Error Codes](/operations/troubleshooting-and-error-codes) —
  what to do when a run fails rather than merely drifts
