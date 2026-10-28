# EXPLAIN Pattern — situational answers

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Opened from explore FORMAT for these asks only; "how does X work", "where is X
used", "is X tested", "what changed", contrast are planned in SKILL.md.

- **"Who owns X?" / "Who knows about X?"** → rank_chunks `rerank="ownership"` +
  pathPattern. Overlay: `blameDominantAuthor`, `blameDominantAuthorPct`,
  `blameAuthors[]` (live-line ownership, `git blame HEAD`). Report distribution.
- **"Who recently committed to X?"** → rank_chunks
  `rerank="recentActivityConcentration"` + pathPattern. Overlay:
  `recentDominantAuthor`, `recentDominantAuthorPct`, `recentAuthors[]`
  (commit-based — who's loaded in for fast review). Differs from ownership:
  owner who stopped contributing shows in `blame*`, not `recent*`.
- **"Is X tested?" with zero hits** → find_symbol X `metaOnly=true` to split
  "exists but untested" from "wrong name". `metaOnly=true` = existence,
  `metaOnly=false` = test content; never test-dir discovery (Glob prohibited —
  `tea-rags://guide/prohibited-patterns`).

## Evidence discipline (broad EXPLAIN)

- Build from SOURCES axis first (behavior truth). Tests = executable spec → cite
  for "should do". Docs = intent/hypothesis → cite for "why", NEVER sole
  evidence of behavior.
- Behavioral claim from doc chunk → verify via a `documentation:"exclude"`
  search + `find_symbol` BEFORE it enters answer. Conflict → code wins; answer
  states the code value and names the drifted doc: "`<doc path>` says X, code
  does Y at `file:line`". Full rule: `../../../references/axis-splitting.md`.
