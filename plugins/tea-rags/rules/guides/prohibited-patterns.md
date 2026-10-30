# Prohibited patterns and fallback chains

Index of all routing guides: `tea-rags://guide/decision-tree`. Which tool to use
instead → guide `tool-choice`.

## Prohibited Patterns

- **Text search for behaviour / intent discovery** — use tea-rags
- **Bash shell over code** (`cat` / `sed -n` / `head` / `grep` /
  `git show <rev>:<file>`) to locate or understand code — alone or inside a
  compound (`cat a.rb; sed -n 90,130p a.rb; grep …`) — same downgrade as the
  default code read tool reading code; harness "use Bash" note does not
  override. Not prohibited: config, DSL, routes, migrations, specs, unindexed
  files, a `find_symbol` stub, all X in a known dir, proving absence (core
  routing row 1). Definition → find_symbol; file → find_symbol(relativePath:);
  exact-name occurrences → the default code search tool, bounded, its hits read
  by find_symbol
- **Leaving tea-rags because index lags / drifted / overlay cold** — guide
  `freshness` "Lag never licenses leaving tea-rags"
- **Read file to verify search results** — chunk is the source of truth
- **Read file after find_symbol** — find_symbol returns full definition (method)
  or addressable outline (class / doc)
- **Grep / Read a saved find_symbol dump or an outline** — lines are ids; drill
  `find_symbol(symbol: <id>)` instead
- **One `find_symbol` call per id** — 2+ known ids (outline members, hits) → ONE
  `find_symbol(symbols: [<ids>])`; misses come back in `missing[]`
- **`ls` / Glob / `find` to list a directory or discover code** —
  `find_symbol(relativePath: "<dir>")` returns its files with their top-level
  symbols
- **Empty answer read as "absent"** — act on `empty.reason` (guide `pagination`
  "Empty answers") before concluding anything
- **Config/inventory/absence:** filenames (`-l`) first; previews ≠ absence
  proof.
- **Conclusions from one `#partN` chunk** — fetch the whole symbol first
  (`find_symbol(symbol: parentSymbolId)`); parts of one symbol count as ONE hit
- **Multiple semantic_search for same area** — one call, navigate from results
- **Unfiltered semantic_search for cross-layer** — dominant language takes 100%
  of slots. Always use language filter (see `rules/references/polyglot-rule.md`)
- **Unbounded occurrence search** — content output with no files-with-matches
  mode or line cap, or the repo root when an anchor's dir is known; files first
  in the anchor's dir (else the source root), then find_symbol on the hits;
  never hybrid_search / semantic_search to find a dir for it
- **Default code read tool after a default code search tool hit** — the hit is
  an address: find_symbol outline → batch of only the needed methods
- **semantic_search / hybrid_search for "find all usages"** — exact-name
  occurrences → the default code search tool (literal); the index ranks, it does
  not enumerate every occurrence
- **Text search for symbol existence checks** — use find_symbol with
  metaOnly=true
- **Text search to read or understand code** — its hits are addresses; read them
  with find_symbol, never Read/cat
- **Text-search fallback justified by a stale prime digest** — digest is a
  start-of-session SNAPSHOT. Confirm a suspected embedding/index outage with a
  LIVE get_index_status before downgrading; find_symbol + hybrid_search BM25
  work with embedding down anyway
- **Doc-sourced behavior claim without code verification** — docs = hypothesis;
  verify via find_symbol/hybrid_search, flag drift (guide `navigation`
  "Principles")
- **Mixed-axis broad exploration** — one unfiltered query over src+tests+docs
  lets dominant class take all slots; split per
  `rules/references/axis-splitting.md`
- **Judging a name by grep or semantic_search on the draft name** — the draft
  pulls in its own lexical neighbours; use get_naming_lexicon (`names[]`); a
  diff → review_changes `naming` (never hand-list a diff's names)
- **hybrid_search / search_code for TODO/FIXME/HACK markers** — use text search
  (the default code search tool); no tea-rags tool serves literal markers
- **git log/blame/`-S`/show for code history** ("when did X appear", "посмотри
  через git") — overlay already has git signals:
  `semantic_search(query: <X>, rerank: "bugHunt")` (ageDays, commitCount,
  taskIds)
- **Curiosity search** — file or id already known → find_symbol, never another
  search
- **Read for "whole file" / "весь файл" / "for context"** — find_symbol (the
  hit's symbolId, then file outline); `Read` only on an explicit manual-read
  order ("by hand" / "руками" / "вручную" / "with Read"), no confirmation asked
- **10+ text-search calls instead of reading a file** — just read it
- **search_code directly** — ONLY used through /tea-rags:explore skill for
  user-facing exploration. Agents and subagents NEVER call search_code directly

## Fallback Chains

| Task                          | Primary                           | Fallback                                          |
| ----------------------------- | --------------------------------- | ------------------------------------------------- |
| Symbol definition             | find_symbol(symbol:)              | hybrid_search → text search                       |
| File structure                | find_symbol(relativePath:)        | Read (whole file)                                 |
| Directory contents            | find_symbol(relativePath: <dir>)  | `empty.reason` unknownPath → a `suggestions` path |
| Doc TOC                       | find_symbol(relativePath:)        | find_symbol(symbol: parentSymbolId)               |
| All usages                    | text search → find_symbol outline | callers of a symbol: + get_callers                |
| Behavioral discovery          | semantic_search                   | hybrid_search                                     |
| Cross-layer                   | semantic_search × per language    | same                                              |
| Exact text                    | text search                       | —                                                 |
| Call path A→B (codegraph on)  | trace_path                        | get_callees breadth-first (manual)                |
| Call path A→B (codegraph off) | semantic_search / hybrid + manual | — (graph tools unavailable; see Graph navigation) |
| Naming vocabulary / verdict   | get_naming_lexicon                | codegraph off: DDG Step 5 Naming concept recipe   |
| Naming review of a diff       | review_changes `naming`           | codegraph off: not assessed (no substitute)       |
