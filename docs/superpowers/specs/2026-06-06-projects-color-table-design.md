# `tea-rags projects` — Colored Informative Table (Design)

**Date:** 2026-06-06 **Status:** Approved (design), pending implementation plan
**Scope surface:** CLI only — `tea-rags projects` default/`list` text mode
(`runList`)

## Problem

`tea-rags projects` currently renders the registry as bare tab-separated text:

```ts
// src/cli/commands/projects.ts  runList (96-110)
process.stdout.write(
  `${e.name ?? "(no name)"}\t${e.collectionName}\t${e.path}\n`,
);
```

Three raw fields, no alignment, no color. The registry already carries far more
that is useful at a glance (chunk count, index age, tool version, Qdrant
endpoint), and several hygiene problems are invisible in the current output:
version drift across projects (1.27 / 1.28 / 1.29 live in the registry today),
anonymous entries (`name === null`), duplicate paths (the same worktree
registered twice under different ephemeral Qdrant ports), and which Qdrant a
project is bound to.

## Goal

A compact, aligned, **colored** table that surfaces the high-signal fields and
flags hygiene problems — readable by a human at a glance, with colors that match
the tea-rags documentation theme and adapt to the terminal background.

## Non-goals (decided)

- **No new surfaces.** MCP `list_projects` and `--json` stay byte-for-byte as
  they are (raw JSON). Only the human text path changes. Programmatic consumers
  are untouched.
- **No live I/O.** Pure-registry render: the table reformats only fields already
  returned by `registry.list()` plus values _computed from them_. No Qdrant
  probes, no `countPoints`, no disk `realpath`, no `resolveQdrantUrl`. This
  keeps the change in the calm render layer (`runList`) and out of the churning
  `ProjectRegistryOps` / `CollectionRegistry` read layer (hotspot: file
  bugFixRate 46–50, see enrichment note below).
- **No color dependency.** No `chalk` / `picocolors`. The repo currently has
  zero color deps and zero ANSI usage; we add a small internal helper.

## Risk note (tea-rags enrichment)

The render code is safe to extend: `runList` is recent and healthy (bugFixRate
21). The risk lives one layer down — `ProjectRegistryOps#list` (file bugFixRate
46 _concerning_, chunk 83 _critical_, commitCount 11 _high_) and
`CollectionRegistry#findByPath` (bugFixRate 50 _critical_). The pure-registry
constraint deliberately avoids touching that layer: the table consumes the
existing `list()` result and computes everything else in the CLI render code.

## Architecture

Two new/changed units, both in the `cli/` layer (allowed to import only
`bootstrap/` + `core/api/public/`).

### 1. `src/cli/infra/color.ts` (new, reusable)

A minimal truecolor ANSI helper. Responsibilities:

- Emit 24-bit foreground codes: `\x1b[38;2;R;G;Bm … \x1b[0m`, plus `bold`
  (`\x1b[1m`) and `dim` (`\x1b[2m`).
- **Enablement gate** (resolved once at module load / first use):
  - `NO_COLOR` set (any value) → colors OFF (honor the standard).
  - `FORCE_COLOR` set → colors ON regardless of TTY.
  - else colors ON iff `process.stdout.isTTY`.
  - When OFF, every styling function is identity (returns the raw string) — the
    table still renders, just monochrome.
- **Background adaptation** (`detectBackground(): "light" | "dark"`):
  - Parse `COLORFGBG` (set by iTerm2 and many terminals; format `"fg;bg"`, bg is
    the last field). bg index `0`–`6` or `8` → light; `7` / `9`–`15` → dark.
  - No `COLORFGBG` → default `dark`.
  - OSC 11 background query is explicitly **out of scope** for v1 (requires
    raw-mode stdin read + timeout; revisit if COLORFGBG proves insufficient).
- Expose a palette object keyed by semantic role, each role resolving to the
  correct hex for the detected background. Roles below.

The helper is generic (not projects-specific) so future CLI commands reuse it.

### 2. `src/cli/commands/projects.ts` — `runList` text branch

`--json` branch unchanged. Text branch replaced with a table renderer:

1. Compute derived values per entry (pure functions, see below).
2. Compute cross-entry facts in one pass: `maxVersion` (for drift), and a
   `Map<path, count>` to detect duplicate paths.
3. Lay out fixed-width columns, render header + rows, render footer legend only
   if any flag fired.

Renderer helpers (pure, unit-testable in isolation, color-agnostic — they
produce _cells_; coloring is applied at write time so tests can assert on plain
text):

- `humanCount(n)` → `11.5k`, `117.0k`, `9`.
- `relativeAge(indexedAt, now)` → `11h ago`, `1d ago`, `15d ago`, `(never)`.
- `classifyQdrant(url)` → `"local" | "embedded" | "remote"` + optional host.
- `wrapName(name, width)` → `string[]` (centered lines, see NAME rules).

## Columns

| Col     | Source                 | Width   | Notes                                             |
| ------- | ---------------------- | ------- | ------------------------------------------------- |
| NAME    | `entry.name`           | ~14 fix | **bold**, centered, wraps on separators           |
| CHUNKS  | `entry.chunksCount`    | right   | `humanCount`                                      |
| INDEXED | `entry.indexedAt`      | left    | `relativeAge`, status-colored                     |
| VER     | `entry.teaRagsVersion` | left    | amber if `< maxVersion` (drift)                   |
| QDRANT  | `entry.qdrantUrl`      | left    | `local` / `embedded` / `remote`                   |
| PATH    | `entry.path`           | rest    | `~` for homedir, middle-truncate, dim; red if dup |

### NAME rules (mandatory)

- **Always bold.** tea-gold bold for a named entry; **amber bold** `(no name)`
  when `name === null`.
- Fits in column width → single centered line.
- Longer than width → wrap: split greedily at separator chars `-` `_` `.` (the
  separator stays attached to the preceding segment), pack segments into lines
  `≤ width`, **center each line** in the column. Never split a segment mid-word.
- Continuation lines occupy only the NAME column; CHUNKS/INDEXED/VER/QDRANT/PATH
  render on the **first** line of the entry, blank on continuation lines.

Example (`width = 14`):

```
     NAME          CHUNKS   INDEXED    VER      QDRANT     PATH
   tea-rags        11.5k    11h ago    1.28.0   embedded   ~/Dev/Tools/tea-rags-mcp
    taxdome       117.0k    1d ago     1.28.0   embedded   ~/Dev/Job/taxdome
 commons-lang-     12.7k    2d ago     1.28.0   embedded   ~/Dev/OS/.../commons-lang
     java
   tea-rags-        11.2k    8d ago     1.28.0   embedded   …/worktrees/enrichment-…
   worktree
   (no name)           9    15d ago    1.27.0   embedded   ~/.claude/jobs/…/fixture
```

### QDRANT classification (deterministic, from URL string only)

`resolveQdrantUrl` (`embedded/daemon.ts:243`) only knows embedded vs external at
runtime (it probes `localhost:6333` and may spawn the daemon). The registry
stores only the resolved URL string captured at index time — no `mode` field,
and the embedded daemon port is ephemeral (historical ports differ per session).
Under the no-I/O constraint we classify by URL shape:

- host ∈ {`localhost`, `127.0.0.1`, `::1`} **and** port `6333` → **`local`**
- host ∈ that set **and** any other port → **`embedded`** (ephemeral daemon)
- host not in that set → **`remote`** (optionally show `(host:port)` dim)

Known imprecision (accepted): an _external_ Qdrant on localhost at a non-6333
port is reported `embedded`. This is the cost of staying I/O-free; the value
reflects "URL shape as recorded at index time", which is what the registry
holds.

## Color scheme (doc-faithful, background-adaptive)

Palette derived from the docs theme (`website/src/css/custom.css`): signature
tea-gold `#c5a864` with explicit light/dark variants; success/warning/danger use
Docusaurus defaults (not overridden in the theme).

| Role     | Applied to                                  | dark-bg    | light-bg   |
| -------- | ------------------------------------------- | ---------- | ---------- |
| brand    | header row, NAME                            | `#d1ba83`  | `#917838`  |
| ok       | INDEXED ≤ 2d                                | `#00a400`  | `#008000`  |
| warn     | INDEXED > 14d; stale VER; `(no name)`       | `#ffba00`  | `#b07d00`  |
| alert    | duplicate PATH (+ `⧉` suffix)               | `#fa383e`  | `#d11a20`  |
| dim      | PATH, QDRANT `local`/`embedded`, collection | ANSI `2m`  | ANSI `2m`  |
| (remote) | QDRANT `remote`                             | brand gold | brand gold |

INDEXED status thresholds: `≤ 2d` ok (green), `≤ 14d` default (no color),
`> 14d` warn (amber), missing → `(never)` dim.

VER drift: amber when the entry's `teaRagsVersion` is below the maximum version
across all listed entries (semver compare); equal-to-max renders default.

## Footer legend

Printed only when at least one flag fired in the table:

```
⚠ stale (version or index)   ⧉ duplicate path
```

## Empty / edge cases

- Empty registry → unchanged `(no projects registered)`.
- `--json` → unchanged JSON dump.
- Colors OFF (NO_COLOR / non-TTY) → same table, no escape codes; flags still
  shown via the `⚠`/`⧉` glyphs and the footer legend, so signal survives without
  color.
- `indexedAt` missing/unparseable → `(never)`, dim.
- `teaRagsVersion` missing → render `(unknown)`, treated as below max → amber.

## Testing strategy

Pure helpers are the bulk of the coverage, all color-agnostic:

- `humanCount`: boundaries (999, 1000, 1.5k rounding, 117028 → `117.0k`).
- `relativeAge`: fixed `now` injected; h/d boundaries; missing → `(never)`.
- `classifyQdrant`: localhost:6333 → local; 127.0.0.1:ephemeral → embedded;
  remote host → remote; `::1`; malformed URL → safe fallback.
- `wrapName`: short (1 line centered); long with `-`/`_`/`.` separators
  (multi-line, each centered, separators retained, no mid-segment split);
  no-separator overflow (single overflowing segment left intact).
- `color.ts`: enablement matrix (NO_COLOR / FORCE_COLOR / isTTY combinations →
  identity vs escape codes); `COLORFGBG` parse → light/dark; missing → dark.
- `runList` integration: capture stdout with colors forced OFF, assert the full
  plain-text table layout (header, alignment, wrapped name rows, footer legend
  presence/absence, duplicate-path `⧉`, `(no name)`).

Follow existing CLI test conventions in `tests/cli/commands/projects.test.ts`.

## Files

| File                                  | Change                                       |
| ------------------------------------- | -------------------------------------------- |
| `src/cli/infra/color.ts`              | new — ANSI helper + palette + bg detection   |
| `src/cli/commands/projects.ts`        | rewrite `runList` text branch + pure helpers |
| `tests/cli/infra/color.test.ts`       | new                                          |
| `tests/cli/commands/projects.test.ts` | extend (table layout, helpers via runList)   |

Where the pure helpers live (inline in `projects.ts` vs a sibling
`projects-format.ts`) is an implementation-plan decision; prefer a sibling
module if `projects.ts` grows past a comfortable size.
