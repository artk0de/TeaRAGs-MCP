# `--languages` selector — design

bd `tea-rags-mcp-mjzis`. Date 2026-08-11.

## What it is

A second selector on `index-codebase`, orthogonal to the provider-key one:

| Flag                  | Answers               | Values                                         |
| --------------------- | --------------------- | ---------------------------------------------- |
| `--force-enrichments` | what to recompute     | `all`, `git`, `codegraph`, `codegraph.symbols` |
| `--languages`         | which points to touch | `typescript`, `ruby`, … (comma-separated)      |

The two combine freely. `--force-enrichments codegraph --languages ruby`
rebuilds the codegraph layer for Ruby points only.

## Where it is allowed, and where it is refused

| Mode                         | `--languages` | Why                                                                       |
| ---------------------------- | ------------- | ------------------------------------------------------------------------- |
| `--force-enrichments <keys>` | allowed       | narrows the recompute set                                                 |
| `--force`                    | allowed       | narrows the whole run, chunking included                                  |
| plain incremental (no flag)  | **refused**   | the changed-file set already defines scope; a language filter on top only |
|                              |               | hides files the sync was supposed to catch up on                          |

The refusal is a typed input error naming the two modes that accept it, not a
silent no-op.

## Semantics per mode

### With `--force-enrichments`

Filters the points the recompute walks. One place changes:
`EnrichmentCoordinator.scrollStoredChunks` adds
`{ key: "language", match: { any: [...] } }` to the Qdrant filter it already
builds. `policy.ts` is untouched — that seam encodes the PROVIDER's own policy
(generated / test files), not an operator's choice, and conflating them would
make a user flag look like a permanent classification.

Correctness for codegraph holds because a partial file set is already the normal
case: the symbol table hydrates from the full persisted set
(`codegraph/factory.ts:185` → `listAllSymbols()`), so resolving a TypeScript
file still sees Ruby symbols; edges are replaced per file; cycles and PageRank
are wholesale recomputes each finalize. This is the same shape an incremental
reindex has always run in.

### With `--force`

Narrows the WHOLE run, chunking and embeddings included. No new plumbing: the
selected languages map to file extensions through `LANGUAGE_MAP`
(`chunker/config.ts:434`, extension → language, inverted here), and the result
is passed as the existing `IndexOptions.extensions`, which already reaches the
scanner (`operations/indexing.ts:227`).

**Consequence, stated once and loudly: `--force` builds a NEW versioned
collection and flips the alias to it.** Restricting the run therefore does not
"reindex less" — it produces a collection that CONTAINS ONLY the selected
languages. Everything else disappears from search until a later unrestricted
`--force` rebuilds it. This is the accepted trade for the speed (embeddings are
~92% of a force run's wall clock).

Because the cost is irreversible-in-practice rather than merely slow, the CLI
prints what will be dropped before it starts, listing the languages present in
the current index that the filter excludes:

```
--force --languages typescript will REBUILD the collection with typescript only.
Currently indexed and about to be dropped: ruby (8 041 chunks), python (312).
```

## Run-stats merge

`cg_run_stats` is written DELETE-then-INSERT over the whole table, so a
language-restricted run would erase the breakdown of every language it did not
touch. `DuckDbRunStatsStore.recordRunStats` changes to delete only the languages
present in the incoming rows:

```sql
DELETE FROM cg_run_stats WHERE language IN (?, ?, …)
```

This is not specific to the new flag — it also fixes the existing case where a
run that happens to observe only TypeScript wipes the Ruby row. Rows for
untouched languages survive; `prime` keeps showing them.

## Validation

- Unknown language → typed `InvalidParameterError` listing the languages
  actually present in the index, not the ones the build could parse. A language
  the parser supports but the corpus does not contain would silently select zero
  points, which reads as success.
- Empty list after parsing → refused, same as an empty provider selector.
- `--languages` without `--force` or `--force-enrichments` → refused (see
  table).
- Value is REQUIRED and takes exactly one argument (`nargs: 1`, comma-split).
  yargs would otherwise swallow the command's positional `[path]` — the same
  trap `--force-enrichments` hit and the reason it is shaped this way.

## Testing

Red-first, one behaviour each:

1. the language filter reaches the Qdrant filter on the recompute path
2. `--force --languages` reaches the scanner as `extensions`
3. plain incremental + `--languages` is refused
4. unknown language is refused, and the message names the indexed languages
5. `recordRunStats` keeps rows of a language absent from the incoming set
6. no `--languages` leaves both paths byte-identical to today

## Rejected

- **A `--paths` filter alongside.** Looks adjacent, but it intersects with
  ignore rules and codegraph exclusion globs in ways a language filter does not.
  Separate concern, separate design.
- **Restricting only the enrichment phase under `--force`.** It would keep the
  collection complete, but the selected-language chunks would be the only ones
  with payload, and the run would still pay the full embedding cost — which is
  the cost the flag exists to avoid.
- **Filtering inside `policy.ts`.** That seam is the provider's own skip policy;
  an operator flag routed through it would be stamped as `skippedAs` and outlive
  the run.
