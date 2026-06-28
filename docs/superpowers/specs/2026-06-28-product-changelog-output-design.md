# Product-Oriented Release Output — Design

**Date:** 2026-06-28 **Status:** Approved (brainstorming) **Area:**
`scripts/release-changelog-prompt.md`, `scripts/lib/render-changelog.js`,
`tests/scripts/render-changelog.test.ts`

## Problem

Release output (GitHub release notes + `CHANGELOG.md` + website changelog) is
engineering-facing, not product-facing. Two concrete failures, visible in
`1.33.0`:

1. **Grouped by internal module**, not by user value. 11 sections keyed by
   conventional-commit scope (`api`, `cli`, `contracts`, `factory`, `ingest`,
   `maintenance`, `mcp`, `pipeline`, `qdrant`, `tea-rags`, `trajectory`) —
   module names mean nothing to a tea-rags user.
2. **Descriptions in codebase vocabulary.** Items name internal symbols
   (`TypeFactStore`, `WorkerDispatchPool.dispatch`, `QdrantOperationError`,
   `CHA cone devirtualization`, `inProjectEdgeRecall`, `ivarTypes`). The reader
   learns the _mechanism_ but never the _benefit_ — what they can now do, or
   what stopped breaking.

Goal: the release output reads as a **product** changelog — the end value for a
tea-rags user is the headline, internal mechanism is demoted out of the product
view.

## Decisions (from brainstorming)

| #   | Decision               | Choice                                                                                                                |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Structure strategy     | **Product-only rewrite.** No domain grouping. Engineering detail survives only in the `Full Commits` spoiler.         |
| 2   | Grouping axis          | **Fixed product-theme taxonomy** tied to tea-rags surfaces (below). Consistent across releases; empty themes omitted. |
| 3   | CHANGELOG traceability | **Clean — no inline hash links.** Release-level traceability via `compareUrl` in the version header.                  |
| 4   | Scope of change        | **Both artifacts** (GitHub release notes + CHANGELOG/website), since they share `renderGroups`.                       |

## Architecture (unchanged pipeline, changed semantics)

The pipeline shape is preserved end-to-end:

```
git log → git-log-to-json.js → commits.json
        → [Claude agent reads release-changelog-prompt.md] → release-notes.json
        → build-changelog-artifacts.js → render-changelog.js
            ├── renderReleaseNotes()    → GitHub release notes (+ Full Commits spoiler)
            └── renderChangelogSection() → CHANGELOG.md / website (clean, no spoiler)
```

Out of scope (YAGNI, untouched): `git-log-to-json.js`,
`build-changelog-artifacts.js` wiring, `prepare-changelog.sh`,
`.github/workflows/release-changelog.yml` (prompt path unchanged),
semantic-release.

## Theme taxonomy

Fixed, ordered, emitted only when non-empty. The agent maps each `feat`/`fix`
commit's `type(scope):` prefix to a theme; the renderer maps the theme key to
its emoji + label.

| Theme key   | Rendered heading          | Source scopes                                                              |
| ----------- | ------------------------- | -------------------------------------------------------------------------- |
| `search`    | 🔎 Search & ranking       | `explore`, `rerank`, `hybrid`, `signals`, `presets`, `filters`             |
| `codeIntel` | 🧠 Code intelligence      | `trajectory`, `codegraph`, `mcp` (callers/callees/trace_path)              |
| `indexing`  | ⚡ Indexing & performance | `ingest`, `pipeline`, `chunker`, `embedding`, `embedded`, `qdrant`, `perf` |
| `language`  | 🗣 Language support       | `language`, per-language scopes (ruby/python/…)                            |
| `workflow`  | 🛠 CLI & workflow         | `cli`, `config`, `api`, `mcp` (tooling), `factory`, `bootstrap`            |
| `fixes`     | 🩹 Fixes                  | any user-visible `fix` (overrides theme mapping)                           |

**Rendering order** = the table order above. A scope not in the table → the
agent picks the closest theme by reading the commit `body`; if still ambiguous
and no user benefit is expressible, the item is dropped from `groups` (see rule
3).

## The product engine — three prompt rules

These three rules in `release-changelog-prompt.md` are what makes the output
product-shaped. They are the core of the change.

1. **Scope → theme mapping.** Use the taxonomy table. `fix` commits with
   user-visible impact go to `fixes` regardless of scope.
2. **Benefit derivation.** For every `feat`/`fix`, answer: _"so what, for
   someone using tea-rags?"_ Write the resulting capability or the resolved
   symptom in plain language — not the implementation. Example transform:
   - before: _"Ruby receiver type-propagation engine resolves types through
     multi-hop call chains via TypeFactStore with source precedence"_
   - after: _"Ruby call-graph navigation (find-callers, impact, blast-radius)
     returns complete results through chained and ActiveRecord-heavy calls."_
3. **Banned vocabulary + drop-internal (anti-fabrication).** Internal symbols
   and types are forbidden in product bullets: class/type names, method names,
   error types, internal metric names (`TypeFactStore`, `WorkerDispatchPool`,
   `QdrantOperationError`, `CHA`, `inProjectEdgeRecall`, `ivarTypes`, …). **If a
   benefit cannot be stated without naming an internal symbol, the item is
   internal-only → exclude it from `groups`.** It is NOT given a fabricated
   benefit. It still appears verbatim in `allCommits` / the Full Commits
   spoiler. This drops substrate-only feats ("class hierarchy edges persisted as
   substrate") and internal-only fixes ("typed error instead of plain Error")
   from the product view.

Retained from the current prompt: only `feat`/`fix` enter `groups`; `refactor`,
`perf`, `docs`, `test`, `chore`, `style`, `build`, `ci` never do; related
commits collapse into one bullet with all hashes in `commits[]`; `allCommits`
lists every commit verbatim; `date` always set.

## `release-notes.json` schema change

```jsonc
{
  "version": "1.33.0",
  "date": "2026-06-28",
  "compareUrl": "…/compare/v1.32.0...v1.33.0",
  "repoUrl": "…",
  "groups": [
    {
      "theme": "codeIntel", // was: "domain"; now a fixed enum key
      "items": [
        {
          "description": "Ruby call-graph navigation returns complete results through chained and ActiveRecord-heavy calls",
          "commits": ["20d6d31", "e4b476f", "a913793", "b796f89"],
        },
      ],
    },
  ],
  "allCommits": [{ "hash": "…", "subject": "…" }], // unchanged
}
```

Changes vs current schema:

- `groups[].domain` → `groups[].theme` (enum: `search` | `codeIntel` |
  `indexing` | `language` | `workflow` | `fixes`).
- `item.kind` (`"fix"`) **removed** — `fixes` is its own theme, so the per-item
  `fix:` prefix is redundant.
- `item.description` semantics change to benefit-framed (shape unchanged).
- `allCommits` unchanged.

## `render-changelog.js` change

- Add a `THEME` registry: ordered key → `{ label, emoji }` map.
- `renderGroups(data)`: iterate `THEME` order (not array order), render only
  themes present in `data.groups`, heading = `### ${emoji} ${label}`.
- `renderItem`: drop the `fix:` prefix logic (no more `it.kind`).
- `renderChangelogSection` (CHANGELOG/website): drop inline hash links — bullet
  = `* ${description}` (no `(hashLinks…)`). Header keeps `compareUrl`.
- `renderReleaseNotes` (GitHub): product themes + **unchanged** `Full Commits`
  spoiler from `allCommits`. Decision: GitHub product bullets are clean too
  (full traceability lives in the spoiler).
- `spliceVersionSection` — unchanged.

## Testing (TDD)

`tests/scripts/render-changelog.test.ts`:

- theme headings render with emoji + label;
- themes render in fixed order regardless of `groups` array order;
- empty themes are omitted;
- CHANGELOG bullets carry **no** inline hash links;
- GitHub release notes still render the `Full Commits` spoiler from
  `allCommits`;
- new fixture `release-notes.json` keyed by `theme`.

Business-logic tests for `spliceVersionSection` (semver insert / replace) are
unchanged — only renderer-shape tests are added/updated.

## Risk

tea-rags enrichment over `**/scripts/**`: the changelog tooling is fresh (~16
days), low-churn, single-owner, zero codegraph fan-in — no blast radius.
Structure change is safe. The only behavioral coupling is the JSON contract
between the agent prompt and `render-changelog.js`; both change together in this
plan, and the renderer tests pin the contract.
