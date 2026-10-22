# Columnar tool responses + plugin sync on `tea-rags update`

Bead: `tea-rags-mcp-zn0fg`. Branch: `worktree-columnar-response`.

## Problem

Search-tool responses are arrays of nested records (`id`, `score`,
`payload.git.file.*`, `rankingOverlay.{file,chunk}.*`). Every record repeats
every key, so the key text dominates the token cost of a response.

Measured on six live TaxDome responses with the real Claude tokenizer
(`claude -p` usage delta over a fixed baseline; haiku and opus count
identically):

| Shape                           | Tokens | vs compact JSON |
| ------------------------------- | ------ | --------------- |
| pretty JSON                     | 111175 | +28.1%          |
| compact JSON (today)            | 86780  | —               |
| TOON over today's records       | 86295  | -0.6%           |
| flattened TOON text             | 54182  | -37.6%          |
| columnar JSON `{columns, rows}` | 55484  | -36.1%          |

Two findings fix the design:

1. The saving comes from the shape (one header per response, one row per
   record), not from TOON syntax. TOON over today's nested records never enters
   its tabular mode.
2. When a tool result carries `structuredContent`, Claude Code hands the model
   only the compact JSON of `structuredContent` and drops `content[].text`
   (stub-server probe: a `TEXT_BETA` marker in `content` never reached the
   model). A TOON text channel would be invisible.

So: columnar JSON inside `structuredContent`. No TOON dependency, no custom
escaping, still schema-valid and machine-readable by any MCP client.

Rejected: TOON text in `content` (invisible in Claude Code, 1.5pp gain);
dropping `outputSchema` for a text channel (loses structure for every client); a
fixed column set per tool (ignores `fields` / `metaOnly`, pads with nulls).

## Decisions

- Columnar shape is the default, no flag. `BREAKING CHANGE` (mcp-tool-schemas
  invariant 5).
- The eval gate runs on the skills in this branch, before merge — not after
  rollout.
- `tea-rags update` brings the Claude Code plugins along, so server and skills
  never disagree about the shape.

## Components

### 1. `toColumns(records)` — table primitive

`src/core/api/tools/columns.ts`, pure, no dependencies.

```ts
interface ColumnTable {
  columns: string[];
  rows: unknown[][];
}
function toColumns(records: readonly Record<string, unknown>[]): ColumnTable;
```

- A plain-object value is flattened into dotted keys
  (`payload.git.file.commitCount`); recursion stops at arrays and scalars.
- Arrays stay JSON arrays inside the cell (`payload.git.file.taskIds`); objects
  inside arrays are not flattened.
- `columns` = union of keys in first-seen order over all rows.
- A key absent from a record → `null` in its row. `null` therefore reads "absent
  or null"; no path in today's records distinguishes the two.
- Empty input → `{ columns: [], rows: [] }`.

Dotted names equal today's payload paths, so `payload.symbolId` and
`rankingOverlay.file.bugFixRate` keep meaning what skills and rules already say.

### 2. Search tools — `structuredContent.results` becomes a table

`formatStructuredResult` (`src/core/api/tools/explore.ts`) serves all five
search tools: `semantic_search`, `hybrid_search`, `rank_chunks`, `find_similar`,
`find_symbol`. It emits `results: toColumns(response.results)`. Every other
top-level field (`workingTree`, `driftWarning`, `confidence`,
`presetFilterNotice`, `fieldsWarning`, `denseUnavailable`, …) is unchanged.

`SearchResultOutputSchema` (`output-schemas.ts`) declares
`results: { columns: string[], rows: unknown[][] }`. Its describe text carries
the reading rule once (invariant 6): one row per result, cell `i` belongs to
`columns[i]`, dotted column = payload path, `null` = absent. Tested by parsing
the output of a real reranked result (invariant 4).

### 3. Text tools — compact JSON, record arrays tabulated

`formatMcpResponse` (`format.ts`, hub: fanIn 12) serialises compact instead of
pretty JSON, and every array of two or more plain objects inside the data is
replaced by its `toColumns` table. Covers `get_callers`, `get_callees`,
`trace_path`, `find_cycles`, `review_changes`, `get_naming_lexicon`, collection
and status tools. Measured on `get_callers`: pretty 3930 → compact 3228 →
tabulated 2651 tokens. `makeStrictJsonSafe` still wraps the output. Separate
commit — widest blast radius in the change.

### 4. Consumers

- `tea-rags call` prints `structuredContent` / text as before; it shows what the
  agent sees, so it follows the new shape with no own logic.
- Tests that read `results[i].payload` through the MCP surface move to the table
  form via one test helper `rowsOf(table)` → records. Assertions keep their
  business meaning (no rewriting of what a test checks).
- `tea-rags://schema/overview` gains `## Response shape`; search-cascade and
  skills point at it and replace "result.payload.X" phrasing with "column
  `payload.X`". Plugin versions bumped (`plugin-versioning.md`).
- `scripts/measure-tools-list.ts` before → after in the commit body (invariant
  7).

### 5. `tea-rags update` syncs the Claude Code plugins

After a successful `npm install -g`, `runUpdateCommand` runs a plugin sync:

1. `claude plugin list --json` → installed entries whose `id` ends with
   `@tea-rags`.
2. None installed → skip silently. `claude` not on PATH (Cursor, Roo) → one line
   saying plugins were not touched.
3. `claude plugin marketplace update tea-rags`, then
   `claude plugin update <id> --json` per entry.
4. Never pass `-y`: a marketplace-declared command change is a human decision. A
   result that asks for confirmation is printed with the command to run.
5. A failed plugin step does not fail the update (the server is already
   installed); exit code stays 0, the failure is printed. Ends with "restart
   Claude Code to load the updated skills" when anything updated.

Process spawning goes through the injected `RunUpdateDeps`, so the sync is
unit-tested without a real `claude`.

### 6. Eval gate on the skills

`claude plugin eval` suite under `.claude-plugin/tea-rags/evals/columnar/`, real
tea-rags server (`--mocks off --allow-tools mcp__tea-rags__*`), against the
self-index. 12 cases, each a task an agent does from a search answer:

- read a field of the N-th row (`payload.relativePath`, `score`);
- drill a row's `payload.symbolId` into `find_symbol`;
- build a `pathPattern` from several rows' `payload.relativePath`;
- read a label from `rankingOverlay.chunk.<signal>.label`;
- spot `#partN` and fetch `payload.parentSymbolId`;
- pick rows by a filter column (`payload.chunkType == "function"`);
- count distinct files across rows;
- cite `workingTree.changedFiles` alongside rows;
- same three on `get_callers` / `trace_path` tables.

Arms: this branch's build vs `main`'s build, same cases. Gate: columnar accuracy
≥ row-shape accuracy, and the six-probe token re-measure ≥ 30% below compact
JSON. Results go to `.claude-plugin/.benchmarks/columnar-response/`.

The arms need the MCP server from a given build; the run uses the worktree
`build/` through the eval's server config, never `npm link` (more than one
worktree is active — `parallel-sessions.md`).

## Out of scope

- Dropping rarely used columns (`id`, `chunkIndex`, `enrichedAt`). Revisit only
  if the eval shows wide tables cost accuracy.
- Tabulating nested arrays inside table cells.

## Risks

- Agents and skills not yet updated look for `results[0].payload` and miss. The
  eval gate and the plugin sync in `update` exist for exactly this.
- Wide tables (46–81 columns on real responses). If the gate fails on it, the
  first lever is the column drop listed under out of scope.
