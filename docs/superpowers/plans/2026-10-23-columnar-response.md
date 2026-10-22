# Columnar Tool Responses + Plugin Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: dinopowers:executing-plans
> (inline in this session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Tool responses carry record arrays as `{columns, rows}` tables (-36%
Claude tokens measured), and `tea-rags update` brings the Claude Code plugins
along.

**Architecture:** One pure primitive `toColumns` turns records into a column
table. `formatStructuredResult` applies it to the five search tools'
`structuredContent.results`; `formatMcpResponse` applies it to record arrays in
every text tool and switches to compact JSON. `runUpdateCommand` gains a plugin
sync step over `claude plugin` CLI. A live eval runner gates the change on the
skills before merge.

**Tech Stack:** TypeScript, zod, vitest, MCP SDK, `claude` CLI.

**Spec:** `docs/superpowers/specs/2026-10-23-columnar-response-design.md`

## Global Constraints

- No new runtime dependency.
- Shape change ships with `BREAKING CHANGE` (mcp-tool-schemas invariant 5).
- Output schema tested by parsing a real reranked result (invariant 4).
- `npx tsx scripts/measure-tools-list.ts` before → after in the commit body
  (invariant 7).
- `.claude-plugin/**` touched → plugin version bumped (`plugin-versioning.md`).
- Never `npm link`, never reindex: more than one worktree is active
  (`parallel-sessions.md`). Local `npm run build` is fine.
- Tests that check a contract keep their assertion; only how they reach the
  record changes.
- Commits: summary shown and approved before each commit (user's commit
  workflow).

## tea-rags impact enrichment (rerank: blastRadius)

| File                          | Owner        | Churn | Age | fanIn / impact          |
| ----------------------------- | ------------ | ----- | --- | ----------------------- |
| src/core/api/tools/format.ts  | artk0de 100% | 12    | 1d  | HUB fanIn 12, impact 47 |
| src/core/api/tools/explore.ts | artk0de 100% | 32    | 0d  | impact 37               |
| src/mcp/resources/registry.ts | artk0de 100% | 50    | 0d  | impact 18, hot          |
| src/cli/commands/call.ts      | artk0de 100% | 8     | 6d  | impact 2                |
| src/cli/commands/update.ts    | artk0de 100% | 2     | 20d | impact 2                |
| src/core/api/tools/columns.ts | — (new)      |       |     |                         |

`format.ts` is a hub → own task, own commit. Naming: `ColumnTable` CONFORMS
(`*Table` like `DispatchTable`); `toColumns`, `tabulateRecordArrays`,
`syncClaudePlugins`, `PluginSyncReport` are NEW_TERM with no competing project
vocabulary.

## File Structure

| File                                                  | Responsibility                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/core/api/tools/columns.ts` (new)                 | `ColumnTable`, `toColumns`, `tabulateRecordArrays`                         |
| `src/core/api/tools/explore.ts`                       | search tools emit `results` as a table                                     |
| `src/core/api/tools/output-schemas.ts`                | `ColumnTableSchema`; `SearchResultItemSchema` exported as the row contract |
| `src/core/api/tools/format.ts`                        | `formatMcpResponse`: compact JSON + tabulated record arrays                |
| `src/mcp/resources/registry.ts`                       | overview `## Response shape`                                               |
| `src/cli/commands/update.ts`                          | `syncClaudePlugins` after npm install                                      |
| `tests/helpers/column-table.ts` (new)                 | `rowsOf(table)` → records, test-only inverse                               |
| `.claude-plugin/**`                                   | search-cascade + skills wording, versions                                  |
| `.claude-plugin/.benchmarks/columnar-response/` (new) | eval runner, cases, benchmark.md                                           |

---

### Task 1: `toColumns` primitive

**Files:**

- Create: `src/core/api/tools/columns.ts`
- Create: `tests/helpers/column-table.ts`
- Test: `tests/core/api/tools/columns.test.ts`

**Interfaces:**

- Produces: `interface ColumnTable { columns: string[]; rows: unknown[][] }`,
  `toColumns(records: readonly Record<string, unknown>[]): ColumnTable`,
  `tabulateRecordArrays(value: unknown): unknown`; test helper
  `rowsOf(table: ColumnTable): Record<string, unknown>[]` (nested back from
  dotted keys, `null` cells dropped).

- [ ] **Step 1: failing tests** — `columns.test.ts`:
  - flattens nested plain objects to dotted columns, first-seen order:
    `toColumns([{id:"a", payload:{relativePath:"x.ts", git:{file:{commitCount:3}}}}])`
    → columns `["id","payload.relativePath","payload.git.file.commitCount"]`,
    rows `[["a","x.ts",3]]`;
  - unions keys across rows, absent → `null`;
  - keeps arrays as cell values (`taskIds: ["T-1"]`), objects inside arrays
    untouched;
  - empty input → `{columns: [], rows: []}`;
  - `rowsOf(toColumns(records))` deep-equals records without nulls (round trip
    over a real reranked result — build it the way `output-schemas.test.ts` does
    with `Reranker`);
  - `tabulateRecordArrays`: an array of ≥ 2 plain objects at any depth becomes a
    table; a 1-element array, an array of scalars, and arrays inside a table
    cell stay as they are.
- [ ] **Step 2:** `npx vitest run tests/core/api/tools/columns.test.ts` → FAIL
      (module missing).
- [ ] **Step 3: implement** `columns.ts`:

```ts
/** Records as one header + one row each: the key text is paid once per response. */
export interface ColumnTable {
  columns: string[];
  rows: unknown[][];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function flattenInto(
  record: Record<string, unknown>,
  prefix: string,
  out: Map<string, unknown>,
): void {
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) flattenInto(value, path, out);
    else out.set(path, value);
  }
}

/** Nested objects → dotted columns (`payload.git.file.commitCount`); arrays stay cell values; absent → null. */
export function toColumns(
  records: readonly Record<string, unknown>[],
): ColumnTable {
  const flat = records.map((record) => {
    const out = new Map<string, unknown>();
    flattenInto(record, "", out);
    return out;
  });
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of flat) {
    for (const key of row.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return {
    columns,
    rows: flat.map((row) => columns.map((column) => row.get(column) ?? null)),
  };
}

/** Every array of two or more plain objects, at any depth, becomes a ColumnTable. */
export function tabulateRecordArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every(isPlainObject))
      return toColumns(value);
    return value.map(tabulateRecordArrays);
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      tabulateRecordArrays(inner),
    ]),
  );
}
```

`tests/helpers/column-table.ts` — `rowsOf` rebuilds nested records by splitting
column names on `.`, skipping `null` cells.

- [ ] **Step 4:** test run → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: commit** (after summary approval):
      `feat(api): toColumns — record arrays as column tables (zn0fg)`.

### Task 2: search tools emit tables

**Files:**

- Modify: `src/core/api/tools/explore.ts` (`formatStructuredResult`)
- Modify: `src/core/api/tools/output-schemas.ts`
- Test: `tests/core/api/tools/output-schemas.test.ts`, `explore.test.ts`,
  `explore-auto-update.test.ts`, `register-project.test.ts`,
  `tests/cli/commands/call.test.ts`

**Interfaces:**

- Consumes: `toColumns`, `ColumnTable`, `rowsOf`.
- Produces: `SearchResultOutputSchema.results` = `ColumnTableSchema`;
  `SearchResultItemSchema` exported (the row contract).

- [ ] **Step 1:** `npx tsx scripts/measure-tools-list.ts` → record before bytes.
- [ ] **Step 2: failing tests:**
  - `output-schemas.test.ts`: the item-contract tests target the exported
    `SearchResultItemSchema` (assertions unchanged); new test — the schema
    parses `formatStructuredResult` output built from a real `Reranker` result,
    and every `rowsOf(results)` record parses as `SearchResultItemSchema`.
  - `explore.test.ts`: a search tool's `structuredContent.results` has `columns`
    containing `id`, `score`, `payload.relativePath`, one row per result;
    top-level `workingTree` / `driftWarning` untouched.
  - the other four files: reach records via `rowsOf(structuredContent.results)`.
- [ ] **Step 3:** run those five files → FAIL on shape.
- [ ] **Step 4: implement** — `formatStructuredResult` sets
      `results: toColumns(response.results as unknown as Record<string, unknown>[])`;
      `output-schemas.ts`:

```ts
export const ColumnTableSchema = z
  .object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
  })
  .describe(
    "One row per result; cell i belongs to columns[i]. Dotted column = payload path " +
      "(payload.relativePath, rankingOverlay.chunk.bugFixRate.label). null = absent.",
  );
```

`results: ColumnTableSchema` in `SearchResultOutputSchema`;
`export const SearchResultItemSchema` (unchanged body).

- [ ] **Step 5:** five files PASS; `npx tsc --noEmit`; measure tools/list after.
- [ ] **Step 6: commit** (after approval):
      `feat(mcp)!: search results as column tables (zn0fg)` with
      `BREAKING CHANGE:` footer and tools/list before → after.

### Task 3: text tools — compact JSON, tabulated record arrays

**Files:**

- Modify: `src/core/api/tools/format.ts` (`formatMcpResponse`)
- Test: `tests/core/api/tools/format.test.ts` + the 7 text-parsing tests
  (`review-changes`, `graph-resolved-symbol-id`, `naming-lexicon-tool`,
  `list-projects`, `codegraph-gating`, `ontology-report-tool`,
  `unregister-project`)

**Interfaces:** Consumes `tabulateRecordArrays`.

- [ ] **Step 1: failing tests** in `format.test.ts`: output text has no
      newline-indent (compact); `{callers: [{a:1},{a:2}]}` serialises as
      `{"callers":{"columns":["a"],"rows":[[1],[2]]}}`; control-char escaping
      (`makeStrictJsonSafe`) still applies.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement:**

```ts
export function formatMcpResponse(data: unknown): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: makeStrictJsonSafe(JSON.stringify(tabulateRecordArrays(data))),
      },
    ],
  };
}
```

- [ ] **Step 4:** the 7 tests: where they index a record array, go through
      `rowsOf`; assertions unchanged. Run all 8 files → PASS.
- [ ] **Step 5: commit** (after approval):
      `feat(mcp)!: text tool responses compact, record arrays tabulated (zn0fg)`
      with `BREAKING CHANGE:` footer.

### Task 4: guidance — overview, search-cascade, skills

**Files:**

- Modify: `src/mcp/resources/registry.ts` (overview `## Response shape`)
- Modify: `.claude-plugin/tea-rags/rules/search-cascade.md` and the skills /
  references that phrase reads as `result.payload.X` / `results[i]`
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json`,
  `.claude-plugin/dinopowers/.claude-plugin/plugin.json` (minor bump)
- Test: the existing resource test for overview sections

- [ ] **Step 1: failing test** — overview resource text contains
      `## Response shape` naming `columns`, `rows`, dotted paths, `null` =
      absent.
- [ ] **Step 2: implement** the section (≤ 8 lines). search-cascade gets one
      line pointing at it ("results arrive as a table — column
      `payload.symbolId` of the row"); every skill sentence that tells the agent
      to read `result.payload.X` becomes "column `payload.X` of the row". Dotted
      path names in prose stay as they are — they are the column names.
- [ ] **Step 3:** `scripts/inject-rules.sh --count` vs declared `--parts 9`.
- [ ] **Step 4:** run resource test + `npm run lint` on touched md.
- [ ] **Step 5: commit** (after approval):
      `docs(tea-rags): read search answers as column tables (zn0fg)`.

### Task 5: `tea-rags update` syncs the Claude Code plugins

**Files:**

- Modify: `src/cli/commands/update.ts`
- Test: `tests/cli/commands/update.test.ts`

**Interfaces:**

- Produces:
  `RunUpdateDeps.runClaude(args: string[]): Promise<{ code: number | null; stdout: string; missing: boolean }>`;
  `syncClaudePlugins(deps): Promise<PluginSyncReport>` with
  `interface PluginSyncReport { updated: string[]; failed: { id: string; reason: string }[]; needsConfirmation: { id: string; command: string }[]; skipped?: "claude-missing" | "none-installed" }`.

- [ ] **Step 1: failing tests** (fake `runClaude`):
  - npm install exits 0 → `plugin list --json`, then
    `plugin marketplace update tea-rags`, then `plugin update <id> --json` for
    each `*@tea-rags` id; never `-y`; stdout ends with the restart hint; exit 0.
  - `claude` missing → one line, no further calls, exit 0.
  - no `@tea-rags` plugins → no marketplace update, no message.
  - a plugin update failing → printed, other plugins still updated, exit 0.
  - a JSON result with `shownCommand` → printed with the command, not accepted.
  - npm install non-zero → no sync, exit with npm's code (existing behaviour).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement** — `runNpmInstall`'s `exit` handler: code 0 →
      `await syncClaudePlugins(deps)`, print report, `deps.exit(0)`; else as
      today. `defaultDeps().runClaude` spawns `claude` with piped stdout via
      `deps.spawn`, maps `ENOENT` to `{ missing: true }`.
- [ ] **Step 4:** test file PASS; `npx tsc --noEmit`.
- [ ] **Step 5: commit** (after approval):
      `feat(cli): tea-rags update brings the Claude Code plugins along (zn0fg)`.

### Task 6: eval gate on the skills + token re-measure

**Files:**

- Create: `.claude-plugin/.benchmarks/columnar-response/run.ts`, `cases.json`,
  `benchmark.md`

- [ ] **Step 1:** `cases.json` — the 12 cases of the spec §6, each
      `{ id, prompt, tool, args, truth: <jq-like path or function name> }`.
- [ ] **Step 2:** `run.ts` (tsx): per arm (`row` = main checkout `build/` + its
      `.claude-plugin/tea-rags`; `columnar` = worktree `build/` + worktree
      plugin) — compute truth by calling the tool through an MCP client on that
      build, then
      `claude -p --model sonnet --plugin-dir <arm plugin> --mcp-config <arm server> --strict-mcp-config --output-format json`;
      grade the final answer against truth (exact / set match). 3 runs per case.
- [ ] **Step 3:** run both arms (user-visible cost: ~72 sonnet runs) → accuracy
      per arm.
- [ ] **Step 4:** token re-measure: the six probes of the spec, both arms,
      `claude -p` usage delta (haiku).
- [ ] **Step 5:** `benchmark.md` with both numbers; gate = columnar accuracy ≥
      row accuracy AND tokens ≥ 30% below compact JSON. Fail → stop, report, no
      merge.
- [ ] **Step 6: commit** (after approval):
      `test(beads): columnar-response eval gate (zn0fg)`.

## Self-review

- Spec §1 → T1, §2 → T2, §3 → T3, §4 → T2/T3/T4, §5 → T5, §6 → T6.
- Names consistent: `ColumnTable`, `toColumns`, `tabulateRecordArrays`,
  `rowsOf`, `ColumnTableSchema`, `SearchResultItemSchema`, `syncClaudePlugins`,
  `PluginSyncReport`, `runClaude`.
