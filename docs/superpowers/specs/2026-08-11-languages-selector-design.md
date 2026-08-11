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

The flag's own help text carries that warning, in the words an operator reads
before running it. A pre-flight diff of what is about to be dropped was designed
and NOT built: it needs a per-language count from the live index on a path that
otherwise touches nothing, and the same sentence in `--help` reaches the reader
earlier. If a restricted `--force` ever gets run against a real project by
accident, revisit this.

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

- Unknown language → typed `InvalidParameterError` naming every unsupported
  entry and listing what IS supported. Validated against `SELECTABLE_LANGUAGES`
  — the distinct values of `LANGUAGE_MAP` — rather than against the languages
  the index happens to contain. That keeps the check synchronous, and it makes
  "passes validation" and "can actually select files" the same set: a language
  with a parser but no extension mapping would pass a definitions-based check
  and then select nothing under `--force`.
- Empty list after parsing → refused, same as an empty provider selector.
- `--languages` without `--force` or `--force-enrichments` → refused (see
  table).
- Value is REQUIRED and takes exactly one argument (`nargs: 1`, comma-split).
  yargs would otherwise swallow the command's positional `[path]` — the same
  trap `--force-enrichments` hit and the reason it is shaped this way.

The earlier draft validated against the languages present in the index, to catch
a supported-but-absent language. That check needs a scan and buys little: a
supported language the corpus lacks selects zero points and the run reports
zero, which is legible on its own. The typo case — the one worth erroring on —
is caught either way.

## Testing

Red-first, one behaviour each:

1. the language filter reaches the Qdrant filter on the recompute path
2. `--force --languages` reaches the scanner as `extensions`
3. plain incremental + `--languages` is refused
4. an unsupported language is refused, and the message names what IS supported
5. `recordRunStats` keeps rows of a language absent from the incoming set
6. no `--languages` leaves both paths byte-identical to today

## Live validation (2026-08-11)

Recompute path, against the tea-rags self-index
(`--force-enrichments codegraph --languages typescript`):

| Check                     | Result                                                                |
| ------------------------- | --------------------------------------------------------------------- |
| Filter reaches the scroll | 906 of 1936 files touched, 53s wall clock                             |
| Selective by language     | typescript codegraph stamp `18:57:30` → `22:31:30`; markdown /        |
|                           | javascript / sql stayed at `18:57:30`                                 |
| Selective by provider     | every language's `git.file.enrichedAt` unchanged                      |
| Run-stats merge           | bash and javascript rows survived intact (javascript `attempted=196`, |
|                           | `resolved=47` before and after); typescript refreshed; 27 rows total  |
| No shadow DuckDB          | one `code_8b243ffe_v62.duckdb`, no alias-named sibling (snbzk holds)  |
| Health                    | `codegraph.symbols` file+chunk healthy, `failed` / `degraded` empty   |

Force path, against a throwaway 4-file polyglot fixture (ts / js / py / md),
because running it on a real index would rebuild that index with one language:

| Command                                 | Files indexed |
| --------------------------------------- | ------------- |
| baseline, no filter                     | 4 (7 chunks)  |
| `--force --languages typescript`        | 1 (3 chunks)  |
| `--force --languages typescript,python` | 2 (4 chunks)  |
| `--force`, filter removed               | 4 (7 chunks)  |

The rebuilt collection after the restricted run contained typescript points and
nothing else — the documented consequence, observed.

Refusals, live: `--languages` on a plain incremental and an unsupported language
both fail with `INPUT_INVALID_PARAMETER` before any work starts, the latter
listing all 31 supported languages.

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
