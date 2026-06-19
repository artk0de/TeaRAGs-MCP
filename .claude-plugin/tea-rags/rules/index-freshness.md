# Index Freshness — reindex triggers

tea-rags search reads payloads written at index time. If the index lags the
working tree, results are silently stale. Before the first tea-rags
search/explore of a turn, check the conditions below (signals come from the
**prime** digest layer) and reindex when one fires.

| Trigger (signal in prime / session)                                              | Action                                  | User confirmation        |
| -------------------------------------------------------------------------------- | --------------------------------------- | ------------------------ |
| Prime banner `⚠ Index is stale (last updated Nd ago)`                            | `index_codebase` (incremental)          | no — reindex silently    |
| Files created/modified this session (`Write`/`Edit`, incl. by a subagent), not yet indexed | `index_codebase` (incremental)          | no — reindex silently    |
| Prime `## Schema drift` section is **not** `none` (lists new payload fields)      | `force_reindex` (full rebuild)          | **YES — explicit consent** |

## Why these three actions

- **Stale / new code → `index_codebase` incremental.** Only changed (and new)
  files are re-embedded — seconds, not a full rebuild. This is the default,
  no-confirmation path: a stale index produces wrong rankings, and the fix is
  cheap, so just run it.
- **Schema drift → `force_reindex`, with consent.** Drift means the running code
  declares payload fields the existing index never populated. Incremental reindex
  **cannot** fix this — unchanged files keep their old payload, and the
  schema-drift guard rejects an incremental run. Only a full rebuild repopulates
  every chunk. A full rebuild is expensive (minutes to hours on large projects),
  so it is **never** automatic — ask first. See `/tea-rags:force-reindex`.

## Detecting "files edited but not indexed"

If you (or a subagent) ran `Write`/`Edit` this turn and the NEXT step searches
for a *different* question, the index does not yet see those edits. Run
`index_codebase` (incremental) first. Skip when: zero files were edited, you are
continuing the same implementation task without re-searching, or the next step
uses ripgrep only.

dinopowers wrappers enforce this same edited-but-unindexed check via
`reindex_changes` before their tea-rags calls — see
`dinopowers/FRESHNESS.md`. That protocol and this rule are the same intent at two
layers; do not double-reindex if a wrapper already did.

## Do NOT

- Downgrade to ripgrep / Grep / Read because the index is stale — that trades
  away recall the user did not agree to. Reindex, then search.
- Run `force_reindex` for stale-only or edited-only cases — incremental is
  correct and far cheaper. Full rebuild is reserved for schema drift.
- Run `force_reindex` without explicit user consent, ever.
