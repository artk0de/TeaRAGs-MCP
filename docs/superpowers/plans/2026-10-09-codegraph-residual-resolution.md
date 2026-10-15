# Codegraph Residual Resolution (wave 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:executing-plans) or superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Close the call sites the static resolver leaves ambiguous or dynamic
with model verdicts (Kev first), cached across runs and applied as
`origin: "model"` edges.

**Architecture:** Static resolve records a residual table per generation; a
separate `ResidualResolutionPass` asks a pluggable `ResidualModelProvider` about
sites with no cached verdict, stores every verdict in a per-project DuckDB file
that survives `--force`, and applies confident ones as method edges through
`GraphDbClient` ops.

**Tech Stack:** TypeScript (Node), DuckDB (`@duckdb/node-api` via the existing
adapters), yargs CLI, zod config, vitest.

**Spec:**
`docs/superpowers/specs/2026-10-09-codegraph-residual-resolution-design.md`

## Global Constraints

- Wave 1 scope: residual kinds `ambiguous` and `dynamic` only; provider `kev`
  only. Jev, `claude-haiku`, `claude-haiku-cli`, cascade and metaprogramming
  gaps are out of scope.
- Indexing never waits on a model: the pass runs after embeddings and codegraph,
  and a failing provider ends the pass `skipped` without failing indexing.
- An edge is applied only when `site_key` and `menu_hash` match a current
  residual row and `p >= threshold`; Kev default threshold `0.7`.
- Verdict store file: `<rootDir>/residual-verdicts/<logicalName>.duckdb`, opened
  directly by the pass under the collection's `IndexingLock`; never removed by
  `--force`, `--force-enrichments`, or a generation swap; removed by
  project/index deletion.
- Defaults: `CODEGRAPH_RESIDUAL_CONCURRENCY=96`,
  `CODEGRAPH_RESIDUAL_MENU_LIMIT=40`,
  `CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS=180`.
- Migrations: new pairs `046-*` / `047-*`; never edit an applied migration;
  `ADD COLUMN IF NOT EXISTS`, nullable, no `DEFAULT`.
- `resolution-runner.ts` and `symbols/provider.ts` are hotspots: thin seams
  only, no new logic inside existing methods beyond a sink call.
- No launcher or Kev serving code in this repo; Kev is installed separately.
- Every task is TDD: failing test first, then implementation.

## Shared Contracts

Every task uses these names and shapes exactly.

```ts
// src/core/contracts/types/codegraph-residual.ts
export type ResidualKind = "ambiguous" | "dynamic";

export interface ResidualCallSiteRow {
  siteKey: string; // sha1(relPath, methodSymbolId, line, column, receiverText, member)
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  line: number;
  column: number;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  candidates: string[]; // target method symbolIds, e.g. "Firm#users"
  menuHash: string; // sha1 of sorted candidates joined by "\n"
  menuOverflow: boolean; // candidates were cut at the menu limit
}

export interface ModelEdgeRow {
  siteKey: string;
  sourceRelPath: string;
  sourceSymbolId: string; // = methodSymbolId of the residual row
  targetSymbolId: string; // the picked candidate
  model: string;
  p: number;
}

export type EdgeOrigin = "static" | "model";
```

```ts
// GraphDbClient additions (src/core/contracts/types/codegraph-storage.ts)
readResidualCallSites(): Promise<ResidualCallSiteRow[]>;
applyModelEdges(model: string, edges: ModelEdgeRow[]): Promise<void>; // scoped row diff over origin='model' rows of `model`; derives call_expression and target_rel_path in SQL
markDerivedStale(): Promise<void>;
```

```ts
// Also in src/core/contracts/types/codegraph-residual.ts — adapters may import
// only core/{contracts,infra}, and both ResidualVerdictStore and
// KevResidualProvider need these. The domain file
// src/core/domains/trajectory/codegraph/residual/types.ts re-exports them and
// declares ResidualPassReport only.
export interface ResidualVerdict {
  siteKey: string;
  menuHash: string;
  model: string;
  modelVersion: string;
  pick: string;
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
  createdAt: number; // epoch ms
  lastSeenAt: number; // epoch ms
}

export interface ResidualQuestion {
  siteKey: string;
  menuHash: string;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  candidates: string[];
}

export interface ResidualQuestionGroup {
  sourceRelPath: string;
  methodSymbolId: string;
  methodSource: string;
  questions: ResidualQuestion[];
}

export interface ResidualAnswer {
  siteKey: string;
  pick: string;
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
}

export interface ResidualModelProvider {
  readonly id: string;
  readonly threshold: number;
  version(): Promise<string>;
  health(): Promise<{ ok: true } | { ok: false; reason: string }>;
  resolveGroup(group: ResidualQuestionGroup): Promise<ResidualAnswer[]>;
}
```

```ts
// src/core/domains/trajectory/codegraph/residual/types.ts
export type {
  ResidualVerdict,
  ResidualQuestion,
  ResidualQuestionGroup,
  ResidualAnswer,
  ResidualModelProvider,
} from "../../../../contracts/types/codegraph-residual.js";

export interface ResidualPassReport {
  status: "completed" | "skipped";
  reason?: string;
  sites: number;
  reused: number;
  asked: number;
  applied: number;
  overflowSkipped: number;
}
```

```ts
// src/core/adapters/duckdb/residual-verdict-store.ts
export class ResidualVerdictStore {
  static async open(
    rootDir: string,
    logicalName: string,
  ): Promise<ResidualVerdictStore>;
  static pathFor(rootDir: string, logicalName: string): string;
  find(
    keys: { siteKey: string; menuHash: string; modelVersion: string }[],
  ): Promise<ResidualVerdict[]>;
  put(verdicts: ResidualVerdict[]): Promise<void>;
  touch(siteKeys: string[], model: string, now: number): Promise<void>;
  expire(retentionDays: number, now: number): Promise<number>; // rows deleted
  close(): Promise<void>;
}
```

---

### Task 1: Residual contracts and graph-DB migrations 046 / 047

**Files:**

- Create: `src/core/contracts/types/codegraph-residual.ts`
- Modify: `src/core/contracts/types/codegraph.ts` (barrel, one line after
  `export type * from "./codegraph-pass1.js";`)
- Create:
  `src/core/domains/maintenance/migration/database/migrations/046-cg-residual-call-sites.ts`
- Create:
  `src/core/domains/maintenance/migration/database/migrations/046-cg-residual-call-sites.sql`
  (generated)
- Create:
  `src/core/domains/maintenance/migration/database/migrations/047-cg-method-edges-origin.ts`
- Create:
  `src/core/domains/maintenance/migration/database/migrations/047-cg-method-edges-origin.sql`
  (generated)
- Modify:
  `src/core/domains/maintenance/migration/database/migrations/index.ts:50`
  (imports) and `:102` (registry)
- Test:
  `tests/core/domains/maintenance/migration/database/046-cg-residual-call-sites.test.ts`
- Test:
  `tests/core/domains/maintenance/migration/database/047-cg-method-edges-origin.test.ts`

**Interfaces:**

- Consumes: `runMigrations(db, migrations)`
  (`src/core/domains/maintenance/migration/database/runner.ts`),
  `DATABASE_MIGRATIONS`, `DuckDbGraphClient#init/run/queryAll/close`.
- Produces: `ResidualKind`, `ResidualCallSiteRow`, `ModelEdgeRow`, `EdgeOrigin`,
  `ResidualVerdict` (see note), `ResidualQuestion`, `ResidualQuestionGroup`,
  `ResidualAnswer`, `ResidualModelProvider` in `codegraph-residual.ts` (ALL
  residual port types live in contracts: adapters import only
  `core/{contracts,infra}`; `ResidualPassReport` stays in the domain
  `residual/types.ts`); table `cg_residual_call_sites`; columns
  `cg_symbols_edges_method.origin VARCHAR`, `.model VARCHAR`, `.p DOUBLE`,
  `.site_key VARCHAR`.

Note: `ResidualVerdict` is declared HERE (contracts), not in
`domains/trajectory/codegraph/residual/types.ts`: the adapter
`ResidualVerdictStore` (Task 6) must not import a domain (`eslint.config.js`
layer rule: adapters never import `core/domains/**`). The same holds for
`ResidualQuestion`, `ResidualQuestionGroup`, `ResidualAnswer` and
`ResidualModelProvider`: the Kev adapter (Plan B Task 8) implements the port, so
it must import it from contracts. The residual `types.ts` written later (Plan B
Task 7) re-exports all five and adds only `ResidualPassReport`. Names and shapes
are unchanged.

Column `call_column` (not `column`) avoids the SQL keyword. `candidates` is a
JSON array in a `VARCHAR`, the convention of
`cg_temporal_bundle_commits.task_ids` (045).

- [ ] **Step 1: Write the failing migration tests**

`tests/core/domains/maintenance/migration/database/046-cg-residual-call-sites.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "046-cg-residual-call-sites.sql";

const INSERT = `INSERT INTO cg_residual_call_sites
  (source_rel_path, site_key, method_symbol_id, method_start_line, method_end_line, line, call_column,
   receiver_text, member, kind, candidates, menu_hash, menu_overflow)
  VALUES ('app/a.rb', 'k1', 'A#run', 1, 9, 3, 4, 'account', 'users', 'dynamic', '["Firm#users"]', 'h', false)`;

describe("046 creates the residual call-site table", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-residual-sites-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after 045", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(
      names.indexOf("045-cg-temporal-bundle-task-ids.sql") + 1,
    );
  });

  it("stores one row per (file, site key) and rejects a duplicate", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.run(INSERT);

    const rows = await db.queryAll<{
      kind: string;
      candidates: string;
      menu_overflow: boolean;
    }>("SELECT kind, candidates, menu_overflow FROM cg_residual_call_sites");
    expect(rows).toEqual([
      { kind: "dynamic", candidates: '["Firm#users"]', menu_overflow: false },
    ]);
    await expect(db.run(INSERT)).rejects.toThrow();
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain(MIGRATION);
  });
});
```

`tests/core/domains/maintenance/migration/database/047-cg-method-edges-origin.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const MIGRATION = "047-cg-method-edges-origin.sql";

describe("047 adds model-edge provenance to method edges", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-edge-origin-mig-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is registered after 046", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(MIGRATION)).toBe(
      names.indexOf("046-cg-residual-call-sites.sql") + 1,
    );
  });

  it("keeps a static edge written before it, reading every new column as NULL", async () => {
    await runMigrations(
      db,
      DATABASE_MIGRATIONS.filter((m) => m.filename < MIGRATION),
    );
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key, target_symbol_id)
       VALUES ('A#run', 'a.rb', 'b.rb', 'b.go', 'B#go', 'B#go')`,
    );

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toContain(MIGRATION);
    const rows = await db.queryAll<{
      origin: string | null;
      model: string | null;
      p: number | null;
      site_key: string | null;
    }>("SELECT origin, model, p, site_key FROM cg_symbols_edges_method");
    expect(rows).toEqual([
      { origin: null, model: null, p: null, site_key: null },
    ]);
  });

  it("is idempotent", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const second = await runMigrations(db, DATABASE_MIGRATIONS);
    expect(second.applied).not.toContain(MIGRATION);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/domains/maintenance/migration/database/046-cg-residual-call-sites.test.ts tests/core/domains/maintenance/migration/database/047-cg-method-edges-origin.test.ts`
Expected: FAIL — `indexOf(MIGRATION)` is `-1` (≠ 45's index + 1); the insert
fails with `Table with name cg_residual_call_sites does not exist` /
`Referenced column "origin" not found`.

- [ ] **Step 3: Create the contracts file**

`src/core/contracts/types/codegraph-residual.ts`:

```ts
/**
 * Codegraph residual resolution (wave 1) — the call sites the static resolver
 * leaves without an edge, the model edges a residual pass applies over them,
 * and the verdicts it caches. Shared by the resolver, the graph store, the
 * verdict store and the residual pass.
 */

export type ResidualKind = "ambiguous" | "dynamic";

export interface ResidualCallSiteRow {
  siteKey: string; // sha1(relPath, methodSymbolId, line, column, receiverText, member)
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  line: number;
  column: number;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  candidates: string[]; // target method symbolIds, e.g. "Firm#users"
  menuHash: string; // sha1 of sorted candidates joined by "\n"
  menuOverflow: boolean; // candidates were cut at the menu limit
}

export interface ModelEdgeRow {
  siteKey: string;
  sourceRelPath: string;
  sourceSymbolId: string; // = methodSymbolId of the residual row
  targetSymbolId: string; // the picked candidate
  model: string;
  p: number;
}

export type EdgeOrigin = "static" | "model";

export interface ResidualVerdict {
  siteKey: string;
  menuHash: string;
  model: string;
  modelVersion: string;
  pick: string;
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
  createdAt: number; // epoch ms
  lastSeenAt: number; // epoch ms
}

export interface ResidualQuestion {
  siteKey: string;
  menuHash: string;
  receiverText: string;
  member: string;
  kind: ResidualKind;
  candidates: string[];
}

export interface ResidualQuestionGroup {
  sourceRelPath: string;
  methodSymbolId: string;
  methodSource: string;
  questions: ResidualQuestion[];
}

export interface ResidualAnswer {
  siteKey: string;
  pick: string;
  p: number;
  probabilities: Record<string, number>;
  questionPayload: string;
}

export interface ResidualModelProvider {
  readonly id: string;
  readonly threshold: number;
  version(): Promise<string>;
  health(): Promise<{ ok: true } | { ok: false; reason: string }>;
  resolveGroup(group: ResidualQuestionGroup): Promise<ResidualAnswer[]>;
}
```

In `src/core/contracts/types/codegraph.ts`, after
`export type * from "./codegraph-pass1.js";` add:

```ts
export type * from "./codegraph-residual.js";
```

- [ ] **Step 4: Create migration 046**

`src/core/domains/maintenance/migration/database/migrations/046-cg-residual-call-sites.ts`:

```ts
/**
 * Codegraph schema — residual call sites (codegraph residual resolution, wave 1).
 *
 * One row per call site the static resolve left without a confident edge:
 * an over-cap ambiguous fan-out, or a receiver with no type evidence. Written
 * per source file by the same scoped reconciliation as the edge tables, read by
 * the residual pass. `candidates` is a JSON array of target symbol ids.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_046_CG_RESIDUAL_CALL_SITES = `
CREATE TABLE IF NOT EXISTS cg_residual_call_sites (
  source_rel_path   VARCHAR NOT NULL,
  site_key          VARCHAR NOT NULL,
  method_symbol_id  VARCHAR NOT NULL,
  method_start_line INTEGER NOT NULL,
  method_end_line   INTEGER NOT NULL,
  line              INTEGER NOT NULL,
  call_column       INTEGER NOT NULL,
  receiver_text     VARCHAR NOT NULL,
  member            VARCHAR NOT NULL,
  kind              VARCHAR NOT NULL,
  candidates        VARCHAR NOT NULL,
  menu_hash         VARCHAR NOT NULL,
  menu_overflow     BOOLEAN NOT NULL,
  PRIMARY KEY (source_rel_path, site_key)
);

CREATE INDEX IF NOT EXISTS idx_cg_residual_call_sites_site_key
  ON cg_residual_call_sites (site_key);
`;
```

- [ ] **Step 5: Create migration 047**

`src/core/domains/maintenance/migration/database/migrations/047-cg-method-edges-origin.ts`:

```ts
/**
 * Codegraph schema — model-edge provenance on method edges (codegraph residual
 * resolution, wave 1).
 *
 * `origin` is `'model'` on an edge a residual-pass verdict produced and NULL on
 * every static edge (readers treat NULL as static); `model` and `p` name the
 * provider and its probability; `site_key` ties the edge to its residual row.
 *
 * Nullable, no DEFAULT: every existing row stays a static edge without a
 * rewrite.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_047_CG_METHOD_EDGES_ORIGIN = `
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS origin VARCHAR;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS model VARCHAR;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS p DOUBLE;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS site_key VARCHAR;
`;
```

- [ ] **Step 6: Register both migrations**

In `src/core/domains/maintenance/migration/database/migrations/index.ts`, after
line 50 (`import { SQL_045_CG_TEMPORAL_BUNDLE_TASK_IDS } ...`) add:

```ts
import { SQL_046_CG_RESIDUAL_CALL_SITES } from "./046-cg-residual-call-sites.js";
import { SQL_047_CG_METHOD_EDGES_ORIGIN } from "./047-cg-method-edges-origin.js";
```

After line 102 (`{ filename: "045-cg-temporal-bundle-task-ids.sql", ... },`)
add:

```ts
  { filename: "046-cg-residual-call-sites.sql", sql: SQL_046_CG_RESIDUAL_CALL_SITES },
  { filename: "047-cg-method-edges-origin.sql", sql: SQL_047_CG_METHOD_EDGES_ORIGIN },
```

Generate the `.sql` twins:

Run: `npm run gen:migration-sql` Expected: writes
`046-cg-residual-call-sites.sql` and `047-cg-method-edges-origin.sql`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/core/domains/maintenance/migration/database/`
Expected: PASS (046, 047 and `sql-twins.test.ts` included).

Run: `npx tsc --noEmit` Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/core/contracts/types/codegraph-residual.ts src/core/contracts/types/codegraph.ts \
  src/core/domains/maintenance/migration/database/migrations/046-cg-residual-call-sites.ts \
  src/core/domains/maintenance/migration/database/migrations/046-cg-residual-call-sites.sql \
  src/core/domains/maintenance/migration/database/migrations/047-cg-method-edges-origin.ts \
  src/core/domains/maintenance/migration/database/migrations/047-cg-method-edges-origin.sql \
  src/core/domains/maintenance/migration/database/migrations/index.ts \
  tests/core/domains/maintenance/migration/database/046-cg-residual-call-sites.test.ts \
  tests/core/domains/maintenance/migration/database/047-cg-method-edges-origin.test.ts
git commit -m "feat(codegraph): residual contracts and migrations for call sites and model edges"
```

---

### Task 2: Residual capture seam in the resolver

**Files:**

- Create:
  `src/core/domains/trajectory/codegraph/residual/residual-site-builder.ts`
- Modify: `src/core/contracts/types/codegraph-graph.ts:14-17` (import) and
  `GraphEdges` (`:395-437`, new optional field after `ambiguousFanouts`)
- Modify: `src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts` —
  imports (`:33-45`), constructor (`:280-284`), new field next to
  `activeHierarchy` (`:293`), `resolve` (`:438-515`), `resolveCallSites`
  (`:752-755`)
- Test:
  `tests/core/domains/trajectory/codegraph/residual/residual-site-builder.test.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/resolution-runner-residual.test.ts`

**Interfaces:**

- Consumes: `CallRef` (`callText`, `receiver`, `member`, `startLine`,
  `startColumn?`), `ChunkExtraction` (`symbolId`, `startLine?`, `endLine?`),
  `GlobalSymbolTable#lookupByShortName(name, options?) => SymbolDefinition[]`,
  `ReceiverKind` (`symbols/receiver-kind.ts`), `CallSiteVerdict`
  (`receiverKind`, `outcome`, `missBucket?`).
- Produces:
  - `DEFAULT_RESIDUAL_MENU_LIMIT = 40`
  - `residualKindOf(verdict: ResidualVerdictView): ResidualKind | null`
  - `residualSiteKey(parts: ResidualSiteKeyParts): string`
  - `residualMenuHash(candidates: readonly string[]): string`
  - `class ResidualSiteCollector { constructor(sourceRelPath: RelPath, symbolTable: Pick<GlobalSymbolTable, "lookupByShortName">, menuLimit: number); observe(method: ResidualMethodView, call: CallRef, verdict: ResidualVerdictView): void; rows(): ResidualCallSiteRow[] }`
  - `GraphEdges.residualCallSites?: ResidualCallSiteRow[]`
  - `new CallEdgeResolutionRunner(languageFactory, runState, residualMenuLimit = DEFAULT_RESIDUAL_MENU_LIMIT)`

Residual decision (read off `ResolveMissBucket` and `classifyReceiverKind`):

- `ambiguous` — `verdict.outcome === "ambiguous"` (over-cap dispatch fan-out).
- `dynamic` — `outcome === "unresolved"`,
  `missBucket === "missWithInProjectDef"` (member is declared in the project;
  not external, not a core homonym, not undecidable, not a dynamic send) and
  `receiverKind ∈ {"dynamic", "ivar", "chain"}` — an unbound name or method
  result, an instance variable, a call chain. `localVar` (typed local),
  `constant`, `selfMember`, `super`, `bareCall` and `index` carry type evidence
  or are not a receiver question.
- Candidates for both kinds: every project definition whose short name is
  `member`, whose symbol id ends in `#<member>` or `.<member>`, declared in a
  file with the call site's extension (the `GlobalSymbolTable` carries no
  language per definition; extension equality is the same-language filter),
  deduplicated and sorted. The over-cap `DispatchFanoutOutcome` carries only
  `candidateCount`, not ids, so the ambiguous menu is re-derived the same way. A
  site with an empty menu is not recorded.
- Menu cut: sorted menu longer than the limit → first `menuLimit` ids,
  `menuOverflow: true`; `menuHash` hashes the stored (cut) list.
- `siteKey = sha1([relPath, methodSymbolId, line, column, receiverText, member].join("\u0000"))`,
  `menuHash = sha1(candidates.join("\n"))`, hex digests.
  `column = call.startColumn ?? 0`, `receiverText = call.receiver ?? ""`, method
  lines fall back to the call line when the chunk carries none.

- [ ] **Step 1: Write the failing builder test**

`tests/core/domains/trajectory/codegraph/residual/residual-site-builder.test.ts`:

```ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CallRef,
  GlobalSymbolTable,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  DEFAULT_RESIDUAL_MENU_LIMIT,
  residualKindOf,
  residualMenuHash,
  ResidualSiteCollector,
  residualSiteKey,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-site-builder.js";

const sha1 = (text: string): string =>
  createHash("sha1").update(text).digest("hex");

function def(symbolId: string, relPath: string): SymbolDefinition {
  const shortName = symbolId.split(/[#.]/).pop() ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [] };
}

function tableOf(
  defs: SymbolDefinition[],
): Pick<GlobalSymbolTable, "lookupByShortName"> {
  return {
    lookupByShortName: (name: string) =>
      defs.filter((d) => d.shortName === name),
  };
}

const CALL: CallRef = {
  callText: "account.users",
  receiver: "account",
  member: "users",
  startLine: 12,
  startColumn: 6,
};
const METHOD = { symbolId: "Billing#run", startLine: 10, endLine: 20 };
const DYNAMIC_MISS = {
  receiverKind: "dynamic",
  outcome: "unresolved",
  missBucket: "missWithInProjectDef",
} as const;

describe("residualKindOf", () => {
  it("records an over-cap fan-out as ambiguous", () => {
    expect(
      residualKindOf({ receiverKind: "localVar", outcome: "ambiguous" }),
    ).toBe("ambiguous");
  });

  it("records an in-project miss on an untyped receiver as dynamic", () => {
    expect(residualKindOf(DYNAMIC_MISS)).toBe("dynamic");
    expect(residualKindOf({ ...DYNAMIC_MISS, receiverKind: "ivar" })).toBe(
      "dynamic",
    );
    expect(residualKindOf({ ...DYNAMIC_MISS, receiverKind: "chain" })).toBe(
      "dynamic",
    );
  });

  it("skips resolved sites, other miss buckets and receivers with type evidence", () => {
    expect(
      residualKindOf({ receiverKind: "dynamic", outcome: "resolved" }),
    ).toBeNull();
    expect(
      residualKindOf({ ...DYNAMIC_MISS, missBucket: "noInProjectDef" }),
    ).toBeNull();
    expect(
      residualKindOf({ ...DYNAMIC_MISS, missBucket: "coreAmbiguous" }),
    ).toBeNull();
    expect(
      residualKindOf({ ...DYNAMIC_MISS, receiverKind: "localVar" }),
    ).toBeNull();
    expect(
      residualKindOf({ ...DYNAMIC_MISS, receiverKind: "constant" }),
    ).toBeNull();
  });
});

describe("residual hashes", () => {
  it("keys a site by file, method, position, receiver and member", () => {
    expect(
      residualSiteKey({
        relPath: "app/a.rb",
        methodSymbolId: "Billing#run",
        line: 12,
        column: 6,
        receiverText: "account",
        member: "users",
      }),
    ).toBe(
      sha1(
        ["app/a.rb", "Billing#run", "12", "6", "account", "users"].join(
          "\u0000",
        ),
      ),
    );
  });

  it("hashes the sorted menu joined by newlines", () => {
    expect(residualMenuHash(["Firm#users", "Team#users"])).toBe(
      sha1("Firm#users\nTeam#users"),
    );
  });
});

describe("ResidualSiteCollector", () => {
  it("builds a dynamic row whose menu is every same-language namesake method, sorted", () => {
    const table = tableOf([
      def("Team#users", "app/models/team.rb"),
      def("Firm#users", "app/models/firm.rb"),
      def("Firm#users", "app/models/firm/reopened.rb"),
      def("users", "app/helpers/users.rb"),
      def("Firm#users", "web/src/firm.ts"),
    ]);
    const collector = new ResidualSiteCollector(
      "app/services/billing.rb",
      table,
      DEFAULT_RESIDUAL_MENU_LIMIT,
    );

    collector.observe(METHOD, CALL, DYNAMIC_MISS);

    expect(collector.rows()).toEqual([
      {
        siteKey: residualSiteKey({
          relPath: "app/services/billing.rb",
          methodSymbolId: "Billing#run",
          line: 12,
          column: 6,
          receiverText: "account",
          member: "users",
        }),
        sourceRelPath: "app/services/billing.rb",
        methodSymbolId: "Billing#run",
        methodStartLine: 10,
        methodEndLine: 20,
        line: 12,
        column: 6,
        receiverText: "account",
        member: "users",
        kind: "dynamic",
        candidates: ["Firm#users", "Team#users"],
        menuHash: residualMenuHash(["Firm#users", "Team#users"]),
        menuOverflow: false,
      },
    ]);
  });

  it("cuts a menu over the limit and marks it overflowed", () => {
    const defs = ["A", "B", "C"].map((owner) =>
      def(`${owner}#users`, `app/models/${owner}.rb`),
    );
    const collector = new ResidualSiteCollector(
      "app/services/billing.rb",
      tableOf(defs),
      2,
    );

    collector.observe(METHOD, CALL, {
      receiverKind: "chain",
      outcome: "ambiguous",
    });

    const [row] = collector.rows();
    expect(row).toMatchObject({
      kind: "ambiguous",
      candidates: ["A#users", "B#users"],
      menuOverflow: true,
    });
    expect(row?.menuHash).toBe(residualMenuHash(["A#users", "B#users"]));
  });

  it("records nothing for a non-residual verdict or an empty menu", () => {
    const collector = new ResidualSiteCollector(
      "app/services/billing.rb",
      tableOf([]),
      DEFAULT_RESIDUAL_MENU_LIMIT,
    );

    collector.observe(METHOD, CALL, DYNAMIC_MISS);
    collector.observe(METHOD, CALL, {
      receiverKind: "dynamic",
      outcome: "resolved",
    });

    expect(collector.rows()).toEqual([]);
  });

  it("falls back to the call line and column 0 when positions are missing", () => {
    const collector = new ResidualSiteCollector(
      "app/services/billing.rb",
      tableOf([def("Firm#users", "app/models/firm.rb")]),
      DEFAULT_RESIDUAL_MENU_LIMIT,
    );

    collector.observe(
      { symbolId: "Billing#run" },
      { callText: "users", receiver: null, member: "users", startLine: 12 },
      DYNAMIC_MISS,
    );

    expect(collector.rows()[0]).toMatchObject({
      methodStartLine: 12,
      methodEndLine: 12,
      column: 0,
      receiverText: "",
    });
  });
});
```

- [ ] **Step 2: Write the failing runner test**

`tests/core/domains/trajectory/codegraph/symbols/resolution-runner-residual.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type {
  FileExtraction,
  GlobalSymbolTable,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { residualMenuHash } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-site-builder.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const DEFS: SymbolDefinition[] = [
  {
    symbolId: "Firm#users",
    fqName: "Firm#users",
    shortName: "users",
    relPath: "app/models/firm.rb",
    scope: ["Firm"],
  },
  {
    symbolId: "Team#users",
    fqName: "Team#users",
    shortName: "users",
    relPath: "app/models/team.rb",
    scope: ["Team"],
  },
];
const TABLE = {
  lookup: () => [],
  lookupByShortName: (name: string) => DEFS.filter((d) => d.shortName === name),
} as unknown as GlobalSymbolTable;

function factoryWith(resolver: object): LanguageFactoryDescriptor {
  return {
    supported: () => ["ruby"],
    create: () => ({ resolver }),
  } as unknown as LanguageFactoryDescriptor;
}

const EXTRACTION: FileExtraction = {
  relPath: "app/services/billing.rb",
  language: "ruby",
  imports: [],
  fileScope: [],
  chunks: [
    {
      symbolId: "Billing#run",
      scope: ["Billing"],
      startLine: 10,
      endLine: 20,
      calls: [
        {
          callText: "account.users",
          receiver: "account",
          member: "users",
          startLine: 12,
          startColumn: 6,
        },
      ],
    },
  ],
};

describe("CallEdgeResolutionRunner.resolve — residual call sites", () => {
  it("attaches a dynamic residual row for an untyped receiver whose member the project declares", () => {
    const resolver = {
      resolve: () => null,
      hasInProjectDefinition: () => true,
    };
    const runner = new CallEdgeResolutionRunner(
      factoryWith(resolver),
      new CodegraphRunState(),
    );

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges.methodEdges).toEqual([]);
    expect(edges.residualCallSites).toEqual([
      expect.objectContaining({
        sourceRelPath: "app/services/billing.rb",
        methodSymbolId: "Billing#run",
        methodStartLine: 10,
        methodEndLine: 20,
        line: 12,
        column: 6,
        kind: "dynamic",
        candidates: ["Firm#users", "Team#users"],
        menuHash: residualMenuHash(["Firm#users", "Team#users"]),
        menuOverflow: false,
      }),
    ]);
  });

  it("attaches an ambiguous residual row next to the over-cap aggregate", () => {
    const resolver = {
      resolve: () => null,
      resolveDispatch: () => ({
        kind: "ambiguous",
        member: "users",
        candidateCount: 17,
      }),
    };
    const runner = new CallEdgeResolutionRunner(
      factoryWith(resolver),
      new CodegraphRunState(),
    );

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges.ambiguousFanouts).toHaveLength(1);
    expect(edges.residualCallSites?.map((r) => r.kind)).toEqual(["ambiguous"]);
  });

  it("cuts menus at the limit the runner was built with", () => {
    const resolver = {
      resolve: () => null,
      hasInProjectDefinition: () => true,
    };
    const runner = new CallEdgeResolutionRunner(
      factoryWith(resolver),
      new CodegraphRunState(),
      1,
    );

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges.residualCallSites?.[0]).toMatchObject({
      candidates: ["Firm#users"],
      menuOverflow: true,
    });
  });

  it("attaches no residual field when every call resolved", () => {
    const resolver = {
      resolve: () => ({
        targetSymbolId: "Firm#users",
        targetRelPath: "app/models/firm.rb",
      }),
    };
    const runner = new CallEdgeResolutionRunner(
      factoryWith(resolver),
      new CodegraphRunState(),
    );

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges).not.toHaveProperty("residualCallSites");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/residual/residual-site-builder.test.ts tests/core/domains/trajectory/codegraph/symbols/resolution-runner-residual.test.ts`
Expected: FAIL — `Failed to load url .../residual/residual-site-builder.js`
(module does not exist).

- [ ] **Step 4: Add the `GraphEdges` field**

In `src/core/contracts/types/codegraph-graph.ts`, after
`import type { CodegraphPass1FileAggregates } from "./codegraph-pass1.js";` add:

```ts
import type { ResidualCallSiteRow } from "./codegraph-residual.js";
```

In `GraphEdges`, directly after the `ambiguousFanouts?: { ... }[];` member add:

```ts
  /**
   * Call sites this file's resolve left without a confident static edge — an
   * over-cap fan-out or an untyped receiver (codegraph residual resolution).
   * Persisted to `cg_residual_call_sites` by the per-file reconciliation.
   */
  residualCallSites?: ResidualCallSiteRow[];
```

- [ ] **Step 5: Create the builder**

`src/core/domains/trajectory/codegraph/residual/residual-site-builder.ts`:

```ts
/**
 * Residual call-site rows (codegraph residual resolution, wave 1): which call
 * sites the static resolve leaves for a model, and the menu each one carries.
 * Fed one verdict at a time by `CallEdgeResolutionRunner#resolveCallSites`.
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";

import type {
  ResidualCallSiteRow,
  ResidualKind,
} from "../../../../contracts/types/codegraph-residual.js";
import type {
  CallRef,
  GlobalSymbolTable,
  RelPath,
} from "../../../../contracts/types/codegraph.js";
import type { ReceiverKind } from "../symbols/receiver-kind.js";

/** Menu size the wave-1 eval measured; `CODEGRAPH_RESIDUAL_MENU_LIMIT` overrides it. */
export const DEFAULT_RESIDUAL_MENU_LIMIT = 40;

/** Receivers with no type evidence: an unbound name or method result, an ivar, a call chain. */
const DYNAMIC_RECEIVER_KINDS: ReadonlySet<ReceiverKind> = new Set<ReceiverKind>(
  ["dynamic", "ivar", "chain"],
);

/** The part of a `CallSiteVerdict` the residual decision reads. */
export interface ResidualVerdictView {
  receiverKind: ReceiverKind;
  outcome: "resolved" | "unresolved" | "ambiguous";
  missBucket?: string;
}

/** The enclosing method of a call site — a `ChunkExtraction` fits it. */
export interface ResidualMethodView {
  symbolId: string;
  startLine?: number;
  endLine?: number;
}

export interface ResidualSiteKeyParts {
  relPath: string;
  methodSymbolId: string;
  line: number;
  column: number;
  receiverText: string;
  member: string;
}

export function residualKindOf(
  verdict: ResidualVerdictView,
): ResidualKind | null {
  if (verdict.outcome === "ambiguous") return "ambiguous";
  if (
    verdict.outcome !== "unresolved" ||
    verdict.missBucket !== "missWithInProjectDef"
  )
    return null;
  return DYNAMIC_RECEIVER_KINDS.has(verdict.receiverKind) ? "dynamic" : null;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function residualSiteKey(parts: ResidualSiteKeyParts): string {
  return sha1(
    [
      parts.relPath,
      parts.methodSymbolId,
      String(parts.line),
      String(parts.column),
      parts.receiverText,
      parts.member,
    ].join("\u0000"),
  );
}

/** `candidates` must already be sorted — the row stores them sorted. */
export function residualMenuHash(candidates: readonly string[]): string {
  return sha1(candidates.join("\n"));
}

export class ResidualSiteCollector {
  private readonly collected: ResidualCallSiteRow[] = [];
  private readonly menus = new Map<string, string[]>();
  private readonly extension: string;

  constructor(
    private readonly sourceRelPath: RelPath,
    private readonly symbolTable: Pick<GlobalSymbolTable, "lookupByShortName">,
    private readonly menuLimit: number,
  ) {
    this.extension = extname(sourceRelPath);
  }

  observe(
    method: ResidualMethodView,
    call: CallRef,
    verdict: ResidualVerdictView,
  ): void {
    const kind = residualKindOf(verdict);
    if (kind === null) return;
    const menu = this.menuFor(call.member);
    if (menu.length === 0) return;
    const menuOverflow = menu.length > this.menuLimit;
    const candidates = menuOverflow ? menu.slice(0, this.menuLimit) : menu;
    const line = call.startLine;
    const column = call.startColumn ?? 0;
    const receiverText = call.receiver ?? "";
    this.collected.push({
      siteKey: residualSiteKey({
        relPath: this.sourceRelPath,
        methodSymbolId: method.symbolId,
        line,
        column,
        receiverText,
        member: call.member,
      }),
      sourceRelPath: this.sourceRelPath,
      methodSymbolId: method.symbolId,
      methodStartLine: method.startLine ?? line,
      methodEndLine: method.endLine ?? line,
      line,
      column,
      receiverText,
      member: call.member,
      kind,
      candidates,
      menuHash: residualMenuHash(candidates),
      menuOverflow,
    });
  }

  rows(): ResidualCallSiteRow[] {
    return this.collected;
  }

  /** Same-language method ids named `member`, deduplicated and sorted; cached per member. */
  private menuFor(member: string): string[] {
    const cached = this.menus.get(member);
    if (cached !== undefined) return cached;
    const ids = new Set<string>();
    for (const def of this.symbolTable.lookupByShortName(member)) {
      if (extname(def.relPath) !== this.extension) continue;
      if (
        !def.symbolId.endsWith(`#${member}`) &&
        !def.symbolId.endsWith(`.${member}`)
      )
        continue;
      ids.add(def.symbolId);
    }
    const menu = [...ids].sort();
    this.menus.set(member, menu);
    return menu;
  }
}
```

- [ ] **Step 6: Wire the seam into the runner**

`src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts`:

Imports — after
`import { normalizeInheritanceEdges } from "./inheritance-edges.js";` add:

```ts
import {
  DEFAULT_RESIDUAL_MENU_LIMIT,
  ResidualSiteCollector,
} from "../residual/residual-site-builder.js";
```

(keep import order as the linter wants: parent-directory imports before `./`
imports; move the line above
`import { mergeDerivedClassFieldTypes ... } from "./call-arg-param-types.js";`
if `eslint --fix` reorders it).

Constructor (`:281-284`):

```ts
  constructor(
    private readonly languageFactory: LanguageFactoryDescriptor,
    private readonly runState: CodegraphRunState,
    private readonly residualMenuLimit: number = DEFAULT_RESIDUAL_MENU_LIMIT,
  ) {}
```

After the `private activeHierarchy: ...` field (`:293`) add:

```ts
  /** The residual rows of the file {@link resolve} is resolving; absent outside it. */
  private activeResidual: ResidualSiteCollector | undefined;
```

In `resolve`, replace

```ts
this.activeHierarchy =
  recorder === undefined
    ? undefined
    : { relPath: extraction.relPath, recorder };
try {
  // Call sites FIRST, file edges second (bd tea-rags-mcp-y99pg.38): a
  // language whose imports name no file derives its file graph from where
  // these calls land, so `resolveFileEdges` receives them.
  this.resolveMethodEdges(
    extraction,
    symbolTable,
    resolver,
    inputs,
    methodEdges,
    ambiguousFanouts,
  );
} finally {
  this.activeHierarchy = undefined;
}
```

with

```ts
this.activeHierarchy =
  recorder === undefined
    ? undefined
    : { relPath: extraction.relPath, recorder };
const residual = new ResidualSiteCollector(
  extraction.relPath,
  symbolTable,
  this.residualMenuLimit,
);
this.activeResidual = residual;
try {
  // Call sites FIRST, file edges second (bd tea-rags-mcp-y99pg.38): a
  // language whose imports name no file derives its file graph from where
  // these calls land, so `resolveFileEdges` receives them.
  this.resolveMethodEdges(
    extraction,
    symbolTable,
    resolver,
    inputs,
    methodEdges,
    ambiguousFanouts,
  );
} finally {
  this.activeHierarchy = undefined;
  this.activeResidual = undefined;
}
```

and after
`if (ambiguousFanouts.length > 0) edges.ambiguousFanouts = ambiguousFanouts;`
add

```ts
const residualCallSites = residual.rows();
if (residualCallSites.length > 0) edges.residualCallSites = residualCallSites;
```

In `resolveCallSites` (`:752-755`), after
`const verdict = this.judgeCallSite(site, resolver, symbolTable, calleeKinds);`
add one line:

```ts
this.activeResidual?.observe(site.chunk, site.call, verdict);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/residual/residual-site-builder.test.ts tests/core/domains/trajectory/codegraph/symbols/resolution-runner-residual.test.ts`
Expected: PASS.

Run: `npx vitest run tests/core/domains/trajectory/codegraph/symbols/` Expected:
PASS. If an existing `toEqual` on a whole `GraphEdges` now fails only because
`residualCallSites` appears, read why: a fixture whose symbol table answers
`lookupByShortName` with same-extension `Class#member` defs for an untyped
in-project miss IS a residual site — report the test to the orchestrator instead
of editing its expectation.

Run:
`npx tsc --noEmit && npx eslint src/core/domains/trajectory/codegraph/residual src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/core/contracts/types/codegraph-graph.ts \
  src/core/domains/trajectory/codegraph/residual/residual-site-builder.ts \
  src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts \
  tests/core/domains/trajectory/codegraph/residual/residual-site-builder.test.ts \
  tests/core/domains/trajectory/codegraph/symbols/resolution-runner-residual.test.ts
git commit -m "feat(codegraph): capture ambiguous and dynamic residual call sites during resolve"
```

---

### Task 3: Persist residual rows per source file

**Files:**

- Modify: `src/core/adapters/duckdb/file-graph-store.ts` — constants (`:28-44`),
  `REMOVED_FILE_SOURCE_TABLES` (`:114-118`), `writeFileRowsGroup` row loop
  (`:268-276`) and reconciliation (`:333-340`)
- Test: `tests/core/adapters/duckdb/client-residual-call-sites.test.ts`

**Interfaces:**

- Consumes: `GraphEdges.residualCallSites` (Task 2),
  `DuckDbGraphSession#applyScopedRowDiff(table, scopeColumn, scopeValues, keyColumns, valueColumns, rows)`,
  `DuckDbGraphClient#upsertFile(node, edges)`, `#upsertFilesBulk(entries)`,
  `#removeFiles(relPaths)`.
- Produces: rows in `cg_residual_call_sites`, reconciled by `source_rel_path`
  exactly like `cg_ambiguous_fanout`; removed with the file.

Route (unchanged code carries it): `CallEdgeResolutionRunner#resolve` →
`GraphBuildFinalizer#resolveAndUpsert` (passes `GraphEdges` whole into
`upsertFilesBulk`; an edge-capped file gets empty edges, which also retires its
residual slice) → `GraphDbClient#upsertFilesBulk` (daemon: `upsertFilesBulk` op,
JSON) → `DuckDbFileGraphStore#writeFileRowsBulk` → `writeFileRowsGroup`.

- [ ] **Step 1: Write the failing test**

`tests/core/adapters/duckdb/client-residual-call-sites.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { ResidualCallSiteRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function site(
  sourceRelPath: string,
  siteKey: string,
  over: Partial<ResidualCallSiteRow> = {},
): ResidualCallSiteRow {
  return {
    siteKey,
    sourceRelPath,
    methodSymbolId: "Billing#run",
    methodStartLine: 10,
    methodEndLine: 20,
    line: 12,
    column: 6,
    receiverText: "account",
    member: "users",
    kind: "dynamic",
    candidates: ["Firm#users", "Team#users"],
    menuHash: "menu-1",
    menuOverflow: false,
    ...over,
  };
}

describe("DuckDbGraphClient — residual call-site persistence", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  const readRows = async () =>
    client.queryAll<{
      source_rel_path: string;
      site_key: string;
      kind: string;
      candidates: string;
      menu_overflow: boolean;
    }>(
      "SELECT source_rel_path, site_key, kind, candidates, menu_overflow FROM cg_residual_call_sites ORDER BY source_rel_path, site_key",
    );

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-cli-residual-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsertFile persists the file's residual rows with the menu as a JSON array", async () => {
    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [site("app/billing.rb", "k1")],
      },
    );

    expect(await readRows()).toEqual([
      {
        source_rel_path: "app/billing.rb",
        site_key: "k1",
        kind: "dynamic",
        candidates: '["Firm#users","Team#users"]',
        menu_overflow: false,
      },
    ]);
  });

  it("a re-walked file replaces its slice and an untouched file keeps its own", async () => {
    await client.upsertFilesBulk([
      {
        node: { relPath: "app/billing.rb", language: "ruby" },
        edges: {
          fileEdges: [],
          methodEdges: [],
          residualCallSites: [site("app/billing.rb", "k1")],
        },
      },
      {
        node: { relPath: "app/team.rb", language: "ruby" },
        edges: {
          fileEdges: [],
          methodEdges: [],
          residualCallSites: [site("app/team.rb", "t1")],
        },
      },
    ]);

    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [
          site("app/billing.rb", "k2", {
            kind: "ambiguous",
            menuOverflow: true,
          }),
        ],
      },
    );

    expect(
      (await readRows()).map((r) => [
        r.source_rel_path,
        r.site_key,
        r.kind,
        r.menu_overflow,
      ]),
    ).toEqual([
      ["app/billing.rb", "k2", "ambiguous", true],
      ["app/team.rb", "t1", "dynamic", false],
    ]);
  });

  it("a re-walk with no residual sites clears the file's slice", async () => {
    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [site("app/billing.rb", "k1")],
      },
    );

    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [] },
    );

    expect(await readRows()).toEqual([]);
  });

  it("removeFiles drops the removed file's residual rows", async () => {
    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [site("app/billing.rb", "k1")],
      },
    );

    await client.removeFiles(["app/billing.rb"]);

    expect(await readRows()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
`npx vitest run tests/core/adapters/duckdb/client-residual-call-sites.test.ts`
Expected: FAIL — `readRows()` returns `[]` where one row is expected (the writer
ignores `residualCallSites`); the `removeFiles` case passes trivially.

- [ ] **Step 3: Implement the reconciliation**

`src/core/adapters/duckdb/file-graph-store.ts`:

After `const FANOUT_VALUES = ["member", "candidate_count"] as const;` add:

```ts
// Migration 046: one row per residual call site of the file.
const RESIDUAL_KEYS = ["source_rel_path", "site_key"] as const;
const RESIDUAL_VALUES = [
  "method_symbol_id",
  "method_start_line",
  "method_end_line",
  "line",
  "call_column",
  "receiver_text",
  "member",
  "kind",
  "candidates",
  "menu_hash",
  "menu_overflow",
] as const;
```

`REMOVED_FILE_SOURCE_TABLES` becomes:

```ts
const REMOVED_FILE_SOURCE_TABLES = [
  "cg_symbols_inheritance",
  "cg_ambiguous_fanout",
  "cg_hierarchy_dependencies",
  "cg_residual_call_sites",
] as const;
```

In `writeFileRowsGroup`, next to `const fanoutRows: unknown[][] = [];` add
`const residualRows: unknown[][] = [];`; after the
`for (const a of edges.ambiguousFanouts ?? []) { ... }` loop add:

```ts
// Residual call sites (migration 046) — keyed by the NODE's path, so a
// re-walk replaces the file's slice and a file with none clears it.
for (const r of edges.residualCallSites ?? []) {
  residualRows.push([
    node.relPath,
    r.siteKey,
    r.methodSymbolId,
    r.methodStartLine,
    r.methodEndLine,
    r.line,
    r.column,
    r.receiverText,
    r.member,
    r.kind,
    JSON.stringify(r.candidates),
    r.menuHash,
    r.menuOverflow,
  ]);
}
```

After the `applyScopedRowDiff("cg_ambiguous_fanout", ...)` call add:

```ts
await this.session.applyScopedRowDiff(
  "cg_residual_call_sites",
  "source_rel_path",
  relPaths,
  RESIDUAL_KEYS,
  RESIDUAL_VALUES,
  residualRows,
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/adapters/duckdb/client-residual-call-sites.test.ts tests/core/adapters/duckdb/client-ambiguous-fanout.test.ts tests/core/adapters/duckdb/graph-session-scoped-row-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/duckdb/file-graph-store.ts tests/core/adapters/duckdb/client-residual-call-sites.test.ts
git commit -m "feat(codegraph): persist residual call sites per source file"
```

---

### Task 4: GraphDbClient residual ops — read sites, apply model edges, mark derived stale

**Files:**

- Create: `src/core/adapters/duckdb/residual-edge-store.ts`
- Modify: `src/core/adapters/duckdb/file-graph-store.ts:36` (`METHOD_EDGE_KEYS`
  / `METHOD_EDGE_VALUES` exported, values extended) and the method-edge row push
  (`:245-256`)
- Modify: `src/core/adapters/duckdb/graph-analytics-store.ts` (new
  `markDerivedStale` after `hasStaleDerivedTables`, `:512-515`)
- Modify: `src/core/contracts/types/codegraph-storage.ts` — import (`:14-56`),
  `GraphDbClient` members after `hasStaleDerivedTables` (`:1120`)
- Modify: `src/core/adapters/duckdb/client.ts` — import block, store field +
  constructor (`:137-169`), methods after `hasStaleDerivedTables` (`:609-611`)
- Modify: `src/core/adapters/duckdb/daemon/protocol.ts` — `DAEMON_OPS` (`:66`
  writes, `:162` reads), `DaemonRequest.params` union (`:225-262`), import
- Modify: `src/core/adapters/duckdb/daemon/op-commands.ts` — imports (`:20-33`),
  writes after `pruneDerivedForDeletedFiles` (`:217-219`), read after
  `hasStaleDerivedTables` (`:467`)
- Modify: `src/core/adapters/duckdb/daemon/client.ts` — methods after
  `hasStaleDerivedTables` (`:225-227`), import
- Test: `tests/core/adapters/duckdb/client-residual-model-edges.test.ts`
- Test: `tests/core/adapters/duckdb/daemon/server-residual-ops.test.ts`
- Test: `tests/core/adapters/duckdb/daemon/client-residual-ops.test.ts`

**Interfaces:**

- Consumes: `cg_residual_call_sites` (Task 3),
  `cg_symbols (rel_path, symbol_id)`, `cg_derived_stale (marker)`,
  `DuckDbGraphSession#applyScopedRowDiff/queryAll/exec/transaction`.
- Produces (`GraphDbClient`, property syntax like the rest of the interface):
  - `readResidualCallSites: () => Promise<ResidualCallSiteRow[]>`
  - `applyModelEdges: (model: string, edges: ModelEdgeRow[]) => Promise<void>`
  - `markDerivedStale: () => Promise<void>`
  - daemon ops `readResidualCallSites` (read), `applyModelEdges` (write),
    `markDerivedStale` (write).

Model-edge row shape in `cg_symbols_edges_method` (PK after 026:
`source_symbol_id, source_rel_path, call_expression, target_rel_path, target_symbol_key`,
all NOT NULL):

- `source_symbol_id` = `edge.sourceSymbolId`, `source_rel_path` =
  `edge.sourceRelPath`
- `call_expression` = `"<receiver_text>.<member>"` from the residual row with
  `site_key = edge.siteKey` (`member` alone when the receiver text is empty) —
  `ModelEdgeRow` carries neither, so an edge whose site is no longer a residual
  row is skipped
- `target_rel_path` = `MIN(rel_path)` of `cg_symbols` rows declaring
  `edge.targetSymbolId` (a reopened class declares the id in several files; one
  deterministic edge); unknown target → skipped
- `target_symbol_key` = `target_symbol_id` = `edge.targetSymbolId`; `edge_kind`
  = `'exact'`; `confidence` = `p` (fanIn / PageRank weigh a model edge by its
  probability)
- `origin` = `'model'`, `model`, `p`, `site_key`

Replacement is `applyScopedRowDiff` scoped by the `model` column: the model's
rows absent from `edges` are deleted, new ones inserted, changed ones updated —
never a delete and insert of one key in one transaction (the native-abort shape
documented on `applyScopedRowDiff`). Static rows have `model IS NULL` and are
outside the scope. A model edge whose key equals an existing static edge is
ignored by `INSERT OR IGNORE`: the static edge already connects that pair.

Static reconciliation (`writeFileRowsGroup`) and model rows:

- An UNTOUCHED file's model rows survive: the diff is scoped by
  `source_rel_path` of the files in the group only.
- A RE-WALKED file's model rows are deleted: they are in scope and absent from
  the static rows. The next residual pass re-applies them from cached verdicts
  when the site is unchanged.
- A re-walked static row whose key equals a model row's key now writes
  `origin/model/p/site_key = NULL`: `METHOD_EDGE_VALUES` gains those four
  columns, so the UPDATE branch turns the row back into a static edge instead of
  leaving it labelled `model` (where the next `applyModelEdges` could delete a
  proven edge).

- [ ] **Step 1: Write the failing in-process client test**

`tests/core/adapters/duckdb/client-residual-model-edges.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  ModelEdgeRow,
  ResidualCallSiteRow,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const SITE: ResidualCallSiteRow = {
  siteKey: "k1",
  sourceRelPath: "app/billing.rb",
  methodSymbolId: "Billing#run",
  methodStartLine: 10,
  methodEndLine: 20,
  line: 12,
  column: 6,
  receiverText: "account",
  member: "users",
  kind: "dynamic",
  candidates: ["Firm#users", "Team#users"],
  menuHash: "menu-1",
  menuOverflow: false,
};

const EDGE: ModelEdgeRow = {
  siteKey: "k1",
  sourceRelPath: "app/billing.rb",
  sourceSymbolId: "Billing#run",
  targetSymbolId: "Firm#users",
  model: "kev",
  p: 0.9,
};

interface EdgeRow {
  source_rel_path: string;
  call_expression: string;
  target_rel_path: string;
  target_symbol_id: string | null;
  edge_kind: string;
  origin: string | null;
  model: string | null;
  p: number | null;
  site_key: string | null;
}

describe("DuckDbGraphClient — residual ops", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  const readEdges = async (): Promise<EdgeRow[]> =>
    client.queryAll<EdgeRow>(
      `SELECT source_rel_path, call_expression, target_rel_path, target_symbol_id, edge_kind, origin, model, p, site_key
         FROM cg_symbols_edges_method ORDER BY source_rel_path, call_expression, target_symbol_id`,
    );

  const writeBilling = async (
    methodEdges: {
      targetSymbolId: string;
      targetRelPath: string;
      callExpression: string;
    }[] = [],
  ) =>
    client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: methodEdges.map((e) => ({
          sourceSymbolId: "Billing#run",
          ...e,
        })),
        residualCallSites: [SITE],
      },
    );

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-cli-model-edges-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    await client.upsertSymbols("app/models/firm.rb", [
      {
        symbolId: "Firm#users",
        fqName: "Firm#users",
        shortName: "users",
        relPath: "app/models/firm.rb",
        scope: ["Firm"],
      },
    ]);
    await client.upsertSymbols("app/models/team.rb", [
      {
        symbolId: "Team#users",
        fqName: "Team#users",
        shortName: "users",
        relPath: "app/models/team.rb",
        scope: ["Team"],
      },
    ]);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads residual rows back with the menu decoded", async () => {
    await writeBilling();

    expect(await client.readResidualCallSites()).toEqual([SITE]);
  });

  it("applies a model edge with its provenance, target file and call text from the residual row", async () => {
    await writeBilling();

    await client.applyModelEdges("kev", [EDGE]);

    expect(await readEdges()).toEqual([
      {
        source_rel_path: "app/billing.rb",
        call_expression: "account.users",
        target_rel_path: "app/models/firm.rb",
        target_symbol_id: "Firm#users",
        edge_kind: "exact",
        origin: "model",
        model: "kev",
        p: 0.9,
        site_key: "k1",
      },
    ]);
  });

  it("replaces the model's edges and leaves static edges alone", async () => {
    await writeBilling([
      {
        targetSymbolId: "Team#users",
        targetRelPath: "app/models/team.rb",
        callExpression: "team.users",
      },
    ]);
    await client.applyModelEdges("kev", [EDGE]);

    await client.applyModelEdges("kev", [
      { ...EDGE, targetSymbolId: "Team#users", p: 0.8 },
    ]);

    expect(
      (await readEdges()).map((e) => [
        e.call_expression,
        e.target_symbol_id,
        e.origin,
      ]),
    ).toEqual([
      ["account.users", "Team#users", "model"],
      ["team.users", "Team#users", null],
    ]);
  });

  it("skips an edge whose site is not a current residual row or whose target is unknown", async () => {
    await writeBilling();

    await client.applyModelEdges("kev", [
      { ...EDGE, siteKey: "gone" },
      { ...EDGE, targetSymbolId: "Nowhere#users" },
    ]);

    expect(await readEdges()).toEqual([]);
  });

  it("an untouched file keeps its model edges when another file is re-walked", async () => {
    await writeBilling();
    await client.applyModelEdges("kev", [EDGE]);

    await client.upsertFile(
      { relPath: "app/team.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [] },
    );

    expect((await readEdges()).map((e) => e.origin)).toEqual(["model"]);
  });

  it("a re-walked source file loses its model edges", async () => {
    await writeBilling();
    await client.applyModelEdges("kev", [EDGE]);

    await writeBilling();

    expect(await readEdges()).toEqual([]);
  });

  it("a re-walk that proves the model's edge statically turns it back into a static edge", async () => {
    await writeBilling();
    await client.applyModelEdges("kev", [EDGE]);

    await writeBilling([
      {
        targetSymbolId: "Firm#users",
        targetRelPath: "app/models/firm.rb",
        callExpression: "account.users",
      },
    ]);
    await client.applyModelEdges("kev", []);

    expect(
      (await readEdges()).map((e) => [
        e.target_symbol_id,
        e.origin,
        e.model,
        e.p,
        e.site_key,
      ]),
    ).toEqual([["Firm#users", null, null, null, null]]);
  });

  it("markDerivedStale marks the derived tables stale", async () => {
    expect(await client.hasStaleDerivedTables()).toBe(false);

    await client.markDerivedStale();
    await client.markDerivedStale();

    expect(await client.hasStaleDerivedTables()).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing daemon tests**

`tests/core/adapters/duckdb/daemon/server-residual-ops.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DAEMON_OP_COMMANDS } from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import type { ResidualCallSiteRow } from "../../../../../src/core/contracts/types/codegraph.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeServer() {
  root = mkdtempSync(join(tmpdir(), "cg-daemon-residual-"));
  const pool = new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
  });
  return { server: new CodegraphDaemonServer(pool), pool };
}

const SITE: ResidualCallSiteRow = {
  siteKey: "k1",
  sourceRelPath: "app/billing.rb",
  methodSymbolId: "Billing#run",
  methodStartLine: 10,
  methodEndLine: 20,
  line: 12,
  column: 6,
  receiverText: "account",
  member: "users",
  kind: "dynamic",
  candidates: ["Firm#users"],
  menuHash: "menu-1",
  menuOverflow: false,
};

describe("CodegraphDaemonServer.handle — residual ops", () => {
  it("reads residual sites, applies model edges and marks derived tables stale", async () => {
    const { server, pool } = makeServer();
    const c = "code_residual_v1";

    await server.handle({
      id: 1,
      op: "upsertSymbols",
      params: {
        collection: c,
        relPath: "app/models/firm.rb",
        definitions: [
          {
            symbolId: "Firm#users",
            fqName: "Firm#users",
            shortName: "users",
            relPath: "app/models/firm.rb",
            scope: ["Firm"],
          },
        ],
      },
    });
    await server.handle({
      id: 2,
      op: "upsertFile",
      params: {
        collection: c,
        node: { relPath: "app/billing.rb", language: "ruby" },
        edges: { fileEdges: [], methodEdges: [], residualCallSites: [SITE] },
      },
    });

    const sites = await server.handle({
      id: 3,
      op: "readResidualCallSites",
      params: { collection: c },
    });
    const applied = await server.handle({
      id: 4,
      op: "applyModelEdges",
      params: {
        collection: c,
        model: "kev",
        edges: [
          {
            siteKey: "k1",
            sourceRelPath: "app/billing.rb",
            sourceSymbolId: "Billing#run",
            targetSymbolId: "Firm#users",
            model: "kev",
            p: 0.9,
          },
        ],
      },
    });
    const callers = await server.handle({
      id: 5,
      op: "getCallers",
      params: { collection: c, symbolId: "Firm#users" },
    });
    const marked = await server.handle({
      id: 6,
      op: "markDerivedStale",
      params: { collection: c },
    });
    const stale = await server.handle({
      id: 7,
      op: "hasStaleDerivedTables",
      params: { collection: c },
    });

    expect(DAEMON_OP_COMMANDS.readResidualCallSites.access).toBe("read");
    expect(DAEMON_OP_COMMANDS.applyModelEdges.access).toBe("write");
    expect(DAEMON_OP_COMMANDS.markDerivedStale.access).toBe("write");
    expect((sites as { result: unknown }).result).toEqual([SITE]);
    expect(applied.ok).toBe(true);
    expect(
      (callers as { result: { sourceSymbolId: string }[] }).result.map(
        (e) => e.sourceSymbolId,
      ),
    ).toEqual(["Billing#run"]);
    expect(marked.ok).toBe(true);
    expect((stale as { result: unknown }).result).toBe(true);
    await pool.closeAll();
  });
});
```

`tests/core/adapters/duckdb/daemon/client-residual-ops.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";

let dir: string | undefined;
let srv: Server | undefined;
afterEach(async () => {
  await new Promise<void>((res) => {
    if (srv) srv.close(() => res());
    else res();
  });
  srv = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fakeDaemon(
  socketPath: string,
  onReq: (r: DaemonRequest) => unknown,
): Promise<void> {
  srv = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        const req = JSON.parse(f) as DaemonRequest;
        sock.write(encodeFrame({ id: req.id, ok: true, result: onReq(req) }));
      }
    });
  });
  srv.unref();
  const server = srv;
  await new Promise<void>((res) => server.listen(socketPath, () => res()));
}

describe("DaemonGraphDbClient — residual ops", () => {
  it("sends each residual op with its params and returns the daemon's rows", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-residual-"));
    const socketPath = join(dir, "d.sock");
    const seen: DaemonRequest[] = [];
    await fakeDaemon(socketPath, (r) => {
      seen.push(r);
      return r.op === "readResidualCallSites" ? [{ siteKey: "k1" }] : null;
    });
    const edge = {
      siteKey: "k1",
      sourceRelPath: "a.rb",
      sourceSymbolId: "A#run",
      targetSymbolId: "B#go",
      model: "kev",
      p: 0.9,
    };

    const client = new DaemonGraphDbClient(
      socketPath,
      fixturePhysicalCollectionName("code_x_v1"),
    );
    await client.init();
    const sites = await client.readResidualCallSites();
    await client.applyModelEdges("kev", [edge]);
    await client.markDerivedStale();
    await client.close();

    expect(sites).toEqual([{ siteKey: "k1" }]);
    expect(seen.find((r) => r.op === "applyModelEdges")?.params).toMatchObject({
      collection: "code_x_v1",
      model: "kev",
      edges: [edge],
    });
    expect(seen.map((r) => r.op)).toEqual(
      expect.arrayContaining(["readResidualCallSites", "markDerivedStale"]),
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/adapters/duckdb/client-residual-model-edges.test.ts tests/core/adapters/duckdb/daemon/server-residual-ops.test.ts tests/core/adapters/duckdb/daemon/client-residual-ops.test.ts`
Expected: FAIL — `client.readResidualCallSites is not a function`;
`DAEMON_OP_COMMANDS.readResidualCallSites` is `undefined`.

- [ ] **Step 4: Extend the static method-edge write**

`src/core/adapters/duckdb/file-graph-store.ts` — export the key list and add the
provenance columns to the values:

```ts
export const METHOD_EDGE_KEYS = [
  "source_symbol_id",
  "source_rel_path",
  "call_expression",
  "target_rel_path",
  "target_symbol_key",
] as const;
// Migration 047: a static row writes NULL provenance, so a re-walk that proves a
// model edge statically turns it back into a static edge.
export const METHOD_EDGE_VALUES = [
  "target_symbol_id",
  "edge_kind",
  "confidence",
  "origin",
  "model",
  "p",
  "site_key",
] as const;
```

In the `for (const e of edges.methodEdges)` push, append four nulls after
`e.confidence ?? 1.0,`:

```ts
          e.confidence ?? 1.0,
          null,
          null,
          null,
          null,
        ]);
```

- [ ] **Step 5: Create the residual edge store**

`src/core/adapters/duckdb/residual-edge-store.ts`:

```ts
/**
 * Residual call sites and the model edges applied over them (codegraph
 * residual resolution, wave 1) — the graph-DB half of the residual pass.
 */
import type {
  ModelEdgeRow,
  ResidualCallSiteRow,
  ResidualKind,
} from "../../contracts/types/codegraph.js";
import { METHOD_EDGE_KEYS, METHOD_EDGE_VALUES } from "./file-graph-store.js";
import type { DuckDbGraphSession } from "./graph-session.js";

const IN_LIST_CHUNK = 200;

interface ResidualSiteDbRow {
  site_key: string;
  source_rel_path: string;
  method_symbol_id: string;
  method_start_line: number | bigint;
  method_end_line: number | bigint;
  line: number | bigint;
  call_column: number | bigint;
  receiver_text: string;
  member: string;
  kind: string;
  candidates: string;
  menu_hash: string;
  menu_overflow: boolean;
}

export class DuckDbResidualEdgeStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async readResidualCallSites(): Promise<ResidualCallSiteRow[]> {
    const rows = await this.session.queryAll<ResidualSiteDbRow>(
      `SELECT site_key, source_rel_path, method_symbol_id, method_start_line, method_end_line, line, call_column,
              receiver_text, member, kind, candidates, menu_hash, menu_overflow
         FROM cg_residual_call_sites ORDER BY source_rel_path, site_key`,
    );
    return rows.map((r) => ({
      siteKey: r.site_key,
      sourceRelPath: r.source_rel_path,
      methodSymbolId: r.method_symbol_id,
      methodStartLine: Number(r.method_start_line),
      methodEndLine: Number(r.method_end_line),
      line: Number(r.line),
      column: Number(r.call_column),
      receiverText: r.receiver_text,
      member: r.member,
      kind: r.kind as ResidualKind,
      candidates: JSON.parse(r.candidates) as string[],
      menuHash: r.menu_hash,
      menuOverflow: r.menu_overflow,
    }));
  }

  /**
   * Replace every `origin = 'model'` edge of `model` with `edges`. Scoped by the
   * `model` column, so static edges (model NULL) and other models' edges are
   * outside the diff.
   */
  async applyModelEdges(
    model: string,
    edges: readonly ModelEdgeRow[],
  ): Promise<void> {
    await this.session.transaction(async () => {
      const callTexts = await this.callTextsBySite(edges.map((e) => e.siteKey));
      const targetPaths = await this.targetPathsBySymbol(
        edges.map((e) => e.targetSymbolId),
      );
      const rows: unknown[][] = [];
      for (const e of edges) {
        const callExpression = callTexts.get(e.siteKey);
        const targetRelPath = targetPaths.get(e.targetSymbolId);
        if (callExpression === undefined || targetRelPath === undefined)
          continue;
        rows.push([
          e.sourceSymbolId,
          e.sourceRelPath,
          callExpression,
          targetRelPath,
          e.targetSymbolId,
          e.targetSymbolId,
          "exact",
          e.p,
          "model",
          model,
          e.p,
          e.siteKey,
        ]);
      }
      await this.session.applyScopedRowDiff(
        "cg_symbols_edges_method",
        "model",
        [model],
        METHOD_EDGE_KEYS,
        METHOD_EDGE_VALUES,
        rows,
      );
    });
  }

  /** `receiver.member` of each current residual site — `member` alone for an empty receiver. */
  private async callTextsBySite(
    siteKeys: readonly string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(siteKeys)];
    for (let i = 0; i < unique.length; i += IN_LIST_CHUNK) {
      const chunk = unique.slice(i, i + IN_LIST_CHUNK);
      const rows = await this.session.queryAll<{
        site_key: string;
        receiver_text: string;
        member: string;
      }>(
        `SELECT site_key, receiver_text, member FROM cg_residual_call_sites WHERE site_key IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      );
      for (const r of rows)
        out.set(
          r.site_key,
          r.receiver_text === "" ? r.member : `${r.receiver_text}.${r.member}`,
        );
    }
    return out;
  }

  /** The first file (by path) declaring each symbol id. */
  private async targetPathsBySymbol(
    symbolIds: readonly string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(symbolIds)];
    for (let i = 0; i < unique.length; i += IN_LIST_CHUNK) {
      const chunk = unique.slice(i, i + IN_LIST_CHUNK);
      const rows = await this.session.queryAll<{
        symbol_id: string;
        rel_path: string;
      }>(
        `SELECT symbol_id, MIN(rel_path) AS rel_path FROM cg_symbols WHERE symbol_id IN (${chunk.map(() => "?").join(", ")}) GROUP BY symbol_id`,
        chunk,
      );
      for (const r of rows) out.set(r.symbol_id, r.rel_path);
    }
    return out;
  }
}
```

- [ ] **Step 6: Add `markDerivedStale` to the analytics store**

`src/core/adapters/duckdb/graph-analytics-store.ts`, after
`hasStaleDerivedTables()`:

```ts
  /** Mark cycles + PageRank stale so the next derived recompute runs; idempotent. */
  async markDerivedStale(): Promise<void> {
    await this.session.exec("INSERT OR IGNORE INTO cg_derived_stale (marker) VALUES ('derived')");
  }
```

- [ ] **Step 7: Extend the `GraphDbClient` contract**

`src/core/contracts/types/codegraph-storage.ts` — add to the imports:

```ts
import type {
  ModelEdgeRow,
  ResidualCallSiteRow,
} from "./codegraph-residual.js";
```

After `hasStaleDerivedTables: () => Promise<boolean>;` add:

```ts
/** Every residual call site of the generation, ordered by file then site key. */
readResidualCallSites: () => Promise<ResidualCallSiteRow[]>;

/**
 * Replace every `origin = 'model'` method edge of `model` with `edges`;
 * static edges and other models' edges are untouched. An edge whose site is
 * not a current residual row or whose target symbol is unknown is skipped.
 */
applyModelEdges: (model: string, edges: ModelEdgeRow[]) => Promise<void>;

/** Mark cycles + PageRank stale so the next derived recompute runs. */
markDerivedStale: () => Promise<void>;
```

- [ ] **Step 8: Implement in the in-process client**

`src/core/adapters/duckdb/client.ts` — add `ModelEdgeRow` and
`ResidualCallSiteRow` to the
`import type { ... } from "../../contracts/types/codegraph.js";` list, then:

```ts
import { DuckDbResidualEdgeStore } from "./residual-edge-store.js";
```

Field after `private readonly typeNames: DuckDbTypeNameStore;`:

```ts
  private readonly residualEdges: DuckDbResidualEdgeStore;
```

Constructor after `this.typeNames = new DuckDbTypeNameStore(this.session);`:

```ts
this.residualEdges = new DuckDbResidualEdgeStore(this.session);
```

Methods after `hasStaleDerivedTables()`:

```ts
  async readResidualCallSites(): Promise<ResidualCallSiteRow[]> {
    return this.residualEdges.readResidualCallSites();
  }

  async applyModelEdges(model: string, edges: ModelEdgeRow[]): Promise<void> {
    return this.residualEdges.applyModelEdges(model, edges);
  }

  async markDerivedStale(): Promise<void> {
    return this.analytics.markDerivedStale();
  }
```

- [ ] **Step 9: Wire the daemon**

`src/core/adapters/duckdb/daemon/protocol.ts`:

- add `ModelEdgeRow` to the
  `import type { ... } from "../../../contracts/types/codegraph.js";` list;
- in `DAEMON_OPS`, after `"pruneDerivedForDeletedFiles",` add
  `"applyModelEdges",` and `"markDerivedStale",`; after
  `"hasStaleDerivedTables",` add `"readResidualCallSites",`;
- in `DaemonRequest.params`, extend the `{ collection: string }` comment with
  `| readResidualCallSites | markDerivedStale` and add the member:

```ts
    | { collection: string; model: string; edges: ModelEdgeRow[] } // applyModelEdges
```

`src/core/adapters/duckdb/daemon/op-commands.ts`:

- add `ModelEdgeRow` to the
  `import type { ... } from "../../../contracts/types/codegraph.js";` list;
- after the `pruneDerivedForDeletedFiles` entry:

```ts
  applyModelEdges: write(async (graphDb, p) => graphDb.applyModelEdges(p.model as string, p.edges as ModelEdgeRow[])),
  markDerivedStale: write(async (graphDb) => graphDb.markDerivedStale()),
```

- after the `hasStaleDerivedTables` entry:

```ts
  readResidualCallSites: read(async (graphDb) => graphDb.readResidualCallSites()),
```

`src/core/adapters/duckdb/daemon/client.ts` — add `ModelEdgeRow` and
`ResidualCallSiteRow` to its contracts import, then after
`hasStaleDerivedTables()`:

```ts
  async readResidualCallSites(): Promise<ResidualCallSiteRow[]> {
    return (await this.call("readResidualCallSites", {})) as ResidualCallSiteRow[];
  }

  async applyModelEdges(model: string, edges: ModelEdgeRow[]): Promise<void> {
    await this.call("applyModelEdges", { model, edges });
  }

  async markDerivedStale(): Promise<void> {
    await this.call("markDerivedStale", {});
  }
```

- [ ] **Step 10: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/adapters/duckdb/client-residual-model-edges.test.ts tests/core/adapters/duckdb/daemon/server-residual-ops.test.ts tests/core/adapters/duckdb/daemon/client-residual-ops.test.ts tests/core/adapters/duckdb/daemon/protocol.test.ts tests/core/adapters/duckdb/method-edges-namesake-write.test.ts tests/core/adapters/duckdb/client-edge-kind.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit && npx tsc -p tsconfig.tests.json` Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/core/adapters/duckdb/residual-edge-store.ts src/core/adapters/duckdb/file-graph-store.ts \
  src/core/adapters/duckdb/graph-analytics-store.ts src/core/contracts/types/codegraph-storage.ts \
  src/core/adapters/duckdb/client.ts src/core/adapters/duckdb/daemon/protocol.ts \
  src/core/adapters/duckdb/daemon/op-commands.ts src/core/adapters/duckdb/daemon/client.ts \
  tests/core/adapters/duckdb/client-residual-model-edges.test.ts \
  tests/core/adapters/duckdb/daemon/server-residual-ops.test.ts \
  tests/core/adapters/duckdb/daemon/client-residual-ops.test.ts
git commit -m "feat(codegraph): GraphDbClient ops to read residual sites and apply model edges"
```

---

### Task 5: Expose edge origin on the method-edge read path

**Files:**

- Modify: `src/core/contracts/types/codegraph-graph.ts` — `CallerEdge`
  (`:476-484`), `CalleeEdge` (`:501-509`)
- Modify: `src/core/adapters/duckdb/method-edge-reader.ts` — `getCallers`
  (`:50-73`), `getCallees` (`:75-104`)
- Modify: `src/core/api/public/dto/graph.ts` — import (`:12`), `CallerResult`
  (`:52-56`), `CalleeResult` (`:175-179`)
- Test: `tests/core/adapters/duckdb/method-edge-origin.test.ts`
- Test: `tests/core/api/internal/ops/declared-visibility-origin.test.ts`

**Interfaces:**

- Consumes: `cg_symbols_edges_method.origin/model/p` (Task 1),
  `GraphDbClient#applyModelEdges` (Task 4), `decorateCallers` /
  `decorateCallees` (`src/core/api/internal/ops/declared-visibility-lookup.ts`,
  spread each edge into the response).
- Produces: `CallerEdge` / `CalleeEdge` / `CallerResult` / `CalleeResult` gain
  `origin?: EdgeOrigin; model?: string; p?: number`.

Representation: the fields are present only on a model edge (`origin: "model"`,
`model`, `p`); a static edge (NULL `origin`) omits all three, and consumers read
absence as `"static"`. That follows the response convention already used for
`visibility` (omitted, never null) and leaves every existing static-edge
equality (38 `toEqual` sites over `getCallers` / `getCallees`) byte-identical.
`get_callers` / `get_callees` carry it with no facade change:
`GraphFacade#getCallers` / `#getCallees` spread the reader's edges. `trace_path`
steps are nodes (`PathStep`) fed by `getCalleeEdges`, which returns bare ids —
carrying an edge origin there is a separate DTO change, see the report.

- [ ] **Step 1: Write the failing reader test**

`tests/core/adapters/duckdb/method-edge-origin.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("method-edge reads — edge origin", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-edge-origin-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    await client.upsertSymbols("app/models/firm.rb", [
      {
        symbolId: "Firm#users",
        fqName: "Firm#users",
        shortName: "users",
        relPath: "app/models/firm.rb",
        scope: ["Firm"],
      },
    ]);
    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Billing#audit",
            targetSymbolId: "Firm#users",
            targetRelPath: "app/models/firm.rb",
            callExpression: "firm.users",
          },
        ],
        residualCallSites: [
          {
            siteKey: "k1",
            sourceRelPath: "app/billing.rb",
            methodSymbolId: "Billing#run",
            methodStartLine: 10,
            methodEndLine: 20,
            line: 12,
            column: 6,
            receiverText: "account",
            member: "users",
            kind: "dynamic",
            candidates: ["Firm#users"],
            menuHash: "menu-1",
            menuOverflow: false,
          },
        ],
      },
    );
    await client.applyModelEdges("kev", [
      {
        siteKey: "k1",
        sourceRelPath: "app/billing.rb",
        sourceSymbolId: "Billing#run",
        targetSymbolId: "Firm#users",
        model: "kev",
        p: 0.9,
      },
    ]);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("getCallers marks the model edge and leaves the static edge unmarked", async () => {
    const callers = await client.getCallers("Firm#users");

    expect(
      callers.find((c) => c.sourceSymbolId === "Billing#run"),
    ).toMatchObject({
      callExpression: "account.users",
      origin: "model",
      model: "kev",
      p: 0.9,
    });
    const staticCaller = callers.find(
      (c) => c.sourceSymbolId === "Billing#audit",
    );
    expect(staticCaller).toBeDefined();
    expect(staticCaller).not.toHaveProperty("origin");
    expect(staticCaller).not.toHaveProperty("model");
    expect(staticCaller).not.toHaveProperty("p");
  });

  it("getCallees marks the model edge", async () => {
    const callees = await client.getCallees("Billing#run");

    expect(callees).toEqual([
      expect.objectContaining({
        targetSymbolId: "Firm#users",
        origin: "model",
        model: "kev",
        p: 0.9,
      }),
    ]);
  });

  it("getCallees leaves a static edge unmarked", async () => {
    const [callee] = await client.getCallees("Billing#audit");

    expect(callee).toBeDefined();
    expect(callee).not.toHaveProperty("origin");
  });
});
```

`tests/core/api/internal/ops/declared-visibility-origin.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  decorateCallees,
  decorateCallers,
} from "../../../../../src/core/api/internal/ops/declared-visibility-lookup.js";

const NO_LEVELS = { getSymbolVisibilities: async () => [] };

describe("decorated graph responses keep the edge origin", () => {
  it("a caller keeps origin, model and p", async () => {
    const { callers } = await decorateCallers(NO_LEVELS, "Firm#users", [
      {
        sourceSymbolId: "Billing#run",
        sourceRelPath: "a.rb",
        callExpression: "account.users",
        origin: "model",
        model: "kev",
        p: 0.9,
      },
    ]);

    expect(callers).toEqual([
      {
        sourceSymbolId: "Billing#run",
        sourceRelPath: "a.rb",
        callExpression: "account.users",
        origin: "model",
        model: "kev",
        p: 0.9,
      },
    ]);
  });

  it("a callee keeps origin, model and p", async () => {
    const callees = await decorateCallees(NO_LEVELS, [
      {
        targetSymbolId: "Firm#users",
        targetRelPath: "f.rb",
        callExpression: "account.users",
        origin: "model",
        model: "kev",
        p: 0.9,
      },
    ]);

    expect(callees[0]).toMatchObject({ origin: "model", model: "kev", p: 0.9 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/adapters/duckdb/method-edge-origin.test.ts tests/core/api/internal/ops/declared-visibility-origin.test.ts`
Expected: FAIL — the reader test's `toMatchObject` misses `origin: "model"`; the
decorate test fails type-checking in vitest only if `tsc` runs, so at runtime it
may PASS already (the spread keeps unknown keys) — that test pins the
pass-through, the reader test is the RED one.

- [ ] **Step 3: Extend the edge contracts**

`src/core/contracts/types/codegraph-graph.ts` — add to the imports:

```ts
import type { EdgeOrigin } from "./codegraph-residual.js";
```

(merge with the `ResidualCallSiteRow` import from Task 2:
`import type { EdgeOrigin, ResidualCallSiteRow } from "./codegraph-residual.js";`)

Append to both `CallerEdge` and `CalleeEdge`:

```ts
  /** `"model"` on an edge a residual-resolution verdict produced; absent on a static edge. */
  origin?: EdgeOrigin;
  /** Provider id of a model edge. */
  model?: string;
  /** Provider probability of a model edge. */
  p?: number;
```

- [ ] **Step 4: Read the columns in the reader**

`src/core/adapters/duckdb/method-edge-reader.ts` — after
`const SCOPED_EDGE_IN_LIST_CHUNK = 200;` add:

```ts
/** Model-edge provenance columns (migration 047); NULL on a static edge. */
interface EdgeOriginColumns {
  origin: string | null;
  model: string | null;
  p: number | null;
}

/** Drop the provenance columns, re-attaching them only on a model edge. */
function withEdgeOrigin<E extends object>(row: E & EdgeOriginColumns): E {
  const { origin, model, p, ...edge } = row;
  if (origin !== "model" || model === null || p === null)
    return edge as unknown as E;
  return { ...(edge as unknown as E), origin: "model", model, p };
}
```

`getCallers` becomes:

```ts
  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    const direct = (
      await this.session.queryAll<CallerEdge & EdgeOriginColumns>(
        'SELECT source_symbol_id AS "sourceSymbolId", source_rel_path AS "sourceRelPath", call_expression AS "callExpression", edge_kind AS "edgeKind", confidence, origin, model, p FROM cg_symbols_edges_method WHERE target_symbol_id = ? ORDER BY source_rel_path, source_symbol_id',
        [symbolId],
      )
    ).map((r) => withEdgeOrigin<CallerEdge>(r));
    // bd tea-rags-mcp-2jet-E — symmetric CHA cone expansion. A large cone was
    // capped to ONE `poly-base` edge to the base declaration `T#m`. Callers of a
    // concrete override `Sub#m` must therefore ALSO include any caller that
    // (polymorphically) targeted `T#m` via poly-base, for every ancestor `T` of
    // `Sub`. Re-derive those callers through the forward inheritance index.
    const split = splitMethodSymbol(symbolId);
    if (!split) return direct;
    const polyBaseCallers = (
      await this.session.queryAll<CallerEdge & EdgeOriginColumns>(
        `SELECT m.source_symbol_id AS "sourceSymbolId", m.source_rel_path AS "sourceRelPath", m.call_expression AS "callExpression", m.edge_kind AS "edgeKind", m.confidence, m.origin, m.model, m.p
           FROM cg_symbols_edges_method m
           JOIN cg_symbols_inheritance i ON i.source_fq_name = ?
          WHERE m.edge_kind = 'poly-base'
            AND m.target_symbol_id = i.ancestor_fq_name || ? || ?
          ORDER BY m.source_rel_path, m.source_symbol_id`,
        [split.base, split.sep, split.member],
      )
    ).map((r) => withEdgeOrigin<CallerEdge>(r));
    if (polyBaseCallers.length === 0) return direct;
    return dedupeCallerEdges([...direct, ...polyBaseCallers]);
  }
```

In `getCallees`, change the row type and SELECT, and attach the provenance onto
`base`:

```ts
    const edges = await this.session.queryAll<
      CalleeEdge & { edgeKind: MethodEdgeKind | null; confidence: number | null } & EdgeOriginColumns
    >(
      `SELECT target_symbol_id AS "targetSymbolId", target_rel_path AS "targetRelPath", call_expression AS "callExpression", edge_kind AS "edgeKind", confidence, origin, model, p
         FROM cg_symbols_edges_method WHERE source_symbol_id = ? ORDER BY target_rel_path`,
      [symbolId],
    );
    const out: CalleeEdge[] = [];
    for (const e of edges) {
      const base: CalleeEdge = {
        targetSymbolId: e.targetSymbolId,
        targetRelPath: e.targetRelPath,
        callExpression: e.callExpression,
        edgeKind: e.edgeKind ?? undefined,
        confidence: e.confidence ?? undefined,
      };
      if (e.origin === "model" && e.model !== null && e.p !== null) {
        base.origin = "model";
        base.model = e.model;
        base.p = e.p;
      }
      out.push(base);
```

(the rest of the loop — the `poly-base` expansion — is unchanged.)

- [ ] **Step 5: Extend the public DTOs**

`src/core/api/public/dto/graph.ts` — line 12 becomes:

```ts
import type {
  CycleScope,
  DeclaredSymbolVisibility,
  EdgeOrigin,
  RelPath,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
```

Append to both `CallerResult` and `CalleeResult`:

```ts
  /** `"model"` when a residual-resolution verdict produced the edge; absent means a static edge. */
  origin?: EdgeOrigin;
  /** Provider id of a model edge. */
  model?: string;
  /** Provider probability of a model edge. */
  p?: number;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/adapters/duckdb/method-edge-origin.test.ts tests/core/api/internal/ops/declared-visibility-origin.test.ts tests/core/adapters/duckdb/`
Expected: PASS.

Run: `npx tsc --noEmit && npx tsc -p tsconfig.tests.json` Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/contracts/types/codegraph-graph.ts src/core/adapters/duckdb/method-edge-reader.ts \
  src/core/api/public/dto/graph.ts tests/core/adapters/duckdb/method-edge-origin.test.ts \
  tests/core/api/internal/ops/declared-visibility-origin.test.ts
git commit -m "feat(codegraph): surface model-edge origin on get_callers and get_callees"
```

---

### Task 6: ResidualVerdictStore and its footprint artifact

**Files:**

- Create: `src/core/adapters/duckdb/residual-verdict-store.ts`
- Create: `src/core/domains/maintenance/footprint/residual-verdicts-artifact.ts`
- Modify: `src/core/domains/maintenance/footprint/artifact.ts` (`ArtifactId`
  union)
- Modify: `src/core/domains/maintenance/footprint/factory.ts` (`FootprintDeps`,
  `build`)
- Modify: `src/bootstrap/factory.ts:1627-1644` and
  `src/bootstrap/footprint-purge.ts:90-100` (wire the path)
- Modify: `tests/core/domains/maintenance/footprint-purger.test.ts` (harness
  override only, `:86-112`)
- Test: `tests/core/adapters/duckdb/residual-verdict-store.test.ts`
- Test:
  `tests/core/domains/maintenance/footprint/residual-verdicts-artifact.test.ts`

**Interfaces:**

- Consumes: `DuckDbGraphSession({ path })` +
  `open/exec/run/queryAll/transaction/close` (the repo's one DuckDB opener —
  `openNative` creates the parent directory), `ResidualVerdict` (contracts, Task
  1), `CollectionArtifact` / `FootprintContext` (`footprint/artifact.ts`),
  `CollectionFootprintPurger#purge({ logicalName })`.
- Produces:
  - `class ResidualVerdictStore` with exactly the Shared Contracts API:
    `static open(rootDir, logicalName)`, `static pathFor(rootDir, logicalName)`
    (= `join(rootDir, "residual-verdicts", `${logicalName}.duckdb`)`), `find`,
    `put`, `touch`, `expire`, `close`.
  - `class ResidualVerdictsArtifact implements CollectionArtifact` — id
    `"residual-verdicts"`, addressing `"logical"`, clone no-op, remove unlinks
    the file and its `.wal`, idempotent.
  - `FootprintDeps.residualVerdictFile?: (logicalName: string) => string`.

Lifecycle: the store file is not a codegraph generation file (stem has no
`_vN`), so `--force` / `--force-enrichments` / a generation swap never reach it
— those paths go through `GraphDbClientPool`, not the footprint. Only footprint
removal (`delete_collection`, `unregister_project`, purge) deletes it, via the
logical artifact. A worktree clone copies nothing (clone no-op); its rollback
removes only the TARGET logical name's file.

`put` upserts with `INSERT ... ON CONFLICT DO UPDATE` (an in-place update, not
the delete+insert shape `applyScopedRowDiff` warns about); input rows are
collapsed last-wins per key first, since DuckDB refuses to update one row twice
in one statement. `created_at` keeps the first write.

- [ ] **Step 1: Write the failing store test**

`tests/core/adapters/duckdb/residual-verdict-store.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResidualVerdictStore } from "../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import type { ResidualVerdict } from "../../../../src/core/contracts/types/codegraph.js";

const DAY = 86_400_000;

function verdict(over: Partial<ResidualVerdict> = {}): ResidualVerdict {
  return {
    siteKey: "k1",
    menuHash: "m1",
    model: "kev",
    modelVersion: "kev-4b@v1.0",
    pick: "Firm#users",
    p: 0.9,
    probabilities: { "Firm#users": 0.9, "Team#users": 0.1 },
    questionPayload: '{"q":1}',
    createdAt: 1_000,
    lastSeenAt: 1_000,
    ...over,
  };
}

describe("ResidualVerdictStore", () => {
  let root: string;
  let store: ResidualVerdictStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "residual-verdicts-"));
    store = await ResidualVerdictStore.open(root, "code_a");
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("lives at <rootDir>/residual-verdicts/<logicalName>.duckdb", () => {
    expect(ResidualVerdictStore.pathFor(root, "code_a")).toBe(
      join(root, "residual-verdicts", "code_a.duckdb"),
    );
    expect(existsSync(ResidualVerdictStore.pathFor(root, "code_a"))).toBe(true);
  });

  it("finds a stored verdict by site, menu and model version only", async () => {
    await store.put([verdict()]);

    expect(
      await store.find([
        { siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      ]),
    ).toEqual([verdict()]);
    expect(
      await store.find([
        { siteKey: "k1", menuHash: "m2", modelVersion: "kev-4b@v1.0" },
      ]),
    ).toEqual([]);
    expect(
      await store.find([
        { siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.1" },
      ]),
    ).toEqual([]);
  });

  it("put overwrites the answer of a known key and keeps its creation time", async () => {
    await store.put([verdict()]);

    await store.put([
      verdict({
        pick: "Team#users",
        p: 0.75,
        createdAt: 5_000,
        lastSeenAt: 5_000,
      }),
    ]);

    expect(
      await store.find([
        { siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      ]),
    ).toEqual([
      verdict({
        pick: "Team#users",
        p: 0.75,
        createdAt: 1_000,
        lastSeenAt: 5_000,
      }),
    ]);
  });

  it("put collapses repeated keys in one batch, last wins", async () => {
    await store.put([
      verdict({ pick: "Team#users" }),
      verdict({ pick: "Firm#users" }),
    ]);

    const [found] = await store.find([
      { siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
    ]);
    expect(found?.pick).toBe("Firm#users");
  });

  it("touch moves last_seen_at for the model's sites only", async () => {
    await store.put([
      verdict(),
      verdict({ siteKey: "k2" }),
      verdict({ model: "jev", modelVersion: "jev@1" }),
    ]);

    await store.touch(["k1"], "kev", 9_000);

    const seen = await store.find([
      { siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      { siteKey: "k2", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      { siteKey: "k1", menuHash: "m1", modelVersion: "jev@1" },
    ]);
    expect(seen.map((v) => [v.siteKey, v.model, v.lastSeenAt])).toEqual([
      ["k1", "jev", 1_000],
      ["k1", "kev", 9_000],
      ["k2", "kev", 1_000],
    ]);
  });

  it("expire deletes verdicts unseen for longer than the retention and counts them", async () => {
    const now = 400 * DAY;
    await store.put([
      verdict({ siteKey: "old", lastSeenAt: now - 181 * DAY }),
      verdict({ siteKey: "fresh", lastSeenAt: now - DAY }),
    ]);

    expect(await store.expire(180, now)).toBe(1);

    const left = await store.find([
      { siteKey: "old", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      { siteKey: "fresh", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
    ]);
    expect(left.map((v) => v.siteKey)).toEqual(["fresh"]);
  });

  it("keeps verdicts across a close and reopen", async () => {
    await store.put([verdict()]);
    await store.close();

    store = await ResidualVerdictStore.open(root, "code_a");

    expect(
      await store.find([
        { siteKey: "k1", menuHash: "m1", modelVersion: "kev-4b@v1.0" },
      ]),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Write the failing artifact test**

`tests/core/domains/maintenance/footprint/residual-verdicts-artifact.test.ts`:

```ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { cloneCollectionFootprint } from "../../../../../src/core/domains/maintenance/footprint/clone-saga.js";
import { ResidualVerdictsArtifact } from "../../../../../src/core/domains/maintenance/footprint/residual-verdicts-artifact.js";

function resolved(logicalName: string) {
  return {
    logicalName,
    physicalName: fixturePhysicalCollectionName(`${logicalName}_v1`),
    path: "/p",
    embeddingModel: "j",
    embeddingDimensions: 768,
    qdrantUrl: "http://h",
    codegraphEnabled: true,
  };
}

describe("ResidualVerdictsArtifact", () => {
  let root: string;
  const fileFor = (logicalName: string): string =>
    join(root, "residual-verdicts", `${logicalName}.duckdb`);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "residual-artifact-"));
    mkdirSync(join(root, "residual-verdicts"));
    writeFileSync(fileFor("code_src"), "db");
    writeFileSync(`${fileFor("code_src")}.wal`, "wal");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is a logical artifact", () => {
    const artifact = new ResidualVerdictsArtifact(fileFor);
    expect([artifact.id, artifact.addressing]).toEqual([
      "residual-verdicts",
      "logical",
    ]);
  });

  it("remove deletes the target's file and its WAL, and is idempotent", async () => {
    const artifact = new ResidualVerdictsArtifact(fileFor);
    const ctx = { source: resolved("code_src"), target: resolved("code_src") };

    await artifact.remove(ctx);
    await artifact.remove(ctx);

    expect(existsSync(fileFor("code_src"))).toBe(false);
    expect(existsSync(`${fileFor("code_src")}.wal`)).toBe(false);
  });

  it("clone copies nothing and leaves the source file in place", async () => {
    const artifact = new ResidualVerdictsArtifact(fileFor);

    await artifact.clone({
      source: resolved("code_src"),
      target: resolved("code_dst"),
    });

    expect(existsSync(fileFor("code_src"))).toBe(true);
    expect(existsSync(fileFor("code_dst"))).toBe(false);
  });

  it("a rolled-back clone removes only the target's file, never the source's", async () => {
    const failing = {
      id: "stats" as const,
      addressing: "logical" as const,
      clone: async () => {
        throw new Error("boom");
      },
      remove: async () => undefined,
    };
    writeFileSync(fileFor("code_dst"), "stray");
    const factory = {
      build: () => ({
        context: { source: resolved("code_src"), target: resolved("code_dst") },
        artifacts: [new ResidualVerdictsArtifact(fileFor), failing],
      }),
    };

    await expect(
      cloneCollectionFootprint(
        factory,
        resolved("code_src"),
        resolved("code_dst"),
      ),
    ).rejects.toThrow("boom");

    expect(existsSync(fileFor("code_src"))).toBe(true);
    expect(existsSync(fileFor("code_dst"))).toBe(false);
  });
});
```

In `tests/core/domains/maintenance/footprint-purger.test.ts`, extend the harness
(no existing assertion changes):

- `PurgerHarnessOverrides` gains
  `residualVerdictFile?: (logicalName: string) => string;`
- in `buildPurger`, the `new CollectionFootprintFactory({ ... })` argument gains
  `...(over.residualVerdictFile ? { residualVerdictFile: over.residualVerdictFile } : {}),`

and add, inside `describe("CollectionFootprintPurger", ...)`:

```ts
describe("residual verdicts", () => {
  it("purging the collection deletes its verdict store and WAL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purge-residual-"));
    const fileFor = (logical: string) => join(dir, `${logical}.duckdb`);
    writeFileSync(fileFor("code_a"), "db");
    writeFileSync(`${fileFor("code_a")}.wal`, "wal");
    writeFileSync(fileFor("code_b"), "db");
    const qdrant = fakeQdrant(
      ["code_a_v1", "code_a_v2"],
      [{ aliasName: "code_a", collectionName: "code_a_v2" }],
    );
    const { purger } = buildPurger({ qdrant, residualVerdictFile: fileFor });

    const report = await purger.purge({ logicalName: "code_a" });

    expect(report.failures).toEqual([]);
    expect(existsSync(fileFor("code_a"))).toBe(false);
    expect(existsSync(`${fileFor("code_a")}.wal`)).toBe(false);
    expect(existsSync(fileFor("code_b"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/adapters/duckdb/residual-verdict-store.test.ts tests/core/domains/maintenance/footprint/residual-verdicts-artifact.test.ts tests/core/domains/maintenance/footprint-purger.test.ts`
Expected: FAIL — `Failed to load url .../residual-verdict-store.js` and
`.../residual-verdicts-artifact.js`; the purger case fails with
`fileFor("code_a")` still existing (the factory ignores the unknown dep).

- [ ] **Step 4: Create the verdict store**

`src/core/adapters/duckdb/residual-verdict-store.ts`:

```ts
/**
 * Residual-resolution verdict cache (codegraph residual resolution, wave 1).
 *
 * One DuckDB file per logical collection, outside every codegraph generation,
 * so `--force` and a generation swap never touch it; removed only with the
 * collection's footprint. Opened directly by the residual pass under the
 * collection's IndexingLock — never through the codegraph daemon.
 */
import { join } from "node:path";

import type { ResidualVerdict } from "../../contracts/types/codegraph-residual.js";
import { DuckDbGraphSession } from "./graph-session.js";

const CHUNK_ROWS = 200;
const DAY_MS = 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS residual_verdicts (
  site_key         VARCHAR NOT NULL,
  menu_hash        VARCHAR NOT NULL,
  model            VARCHAR NOT NULL,
  model_version    VARCHAR NOT NULL,
  pick             VARCHAR NOT NULL,
  p                DOUBLE  NOT NULL,
  probabilities    VARCHAR NOT NULL,
  question_payload VARCHAR NOT NULL,
  created_at       BIGINT  NOT NULL,
  last_seen_at     BIGINT  NOT NULL,
  PRIMARY KEY (site_key, menu_hash, model, model_version)
)`;

const COLUMNS = [
  "site_key",
  "menu_hash",
  "model",
  "model_version",
  "pick",
  "p",
  "probabilities",
  "question_payload",
  "created_at",
  "last_seen_at",
] as const;

interface VerdictRow {
  site_key: string;
  menu_hash: string;
  model: string;
  model_version: string;
  pick: string;
  p: number;
  probabilities: string;
  question_payload: string;
  created_at: number | bigint;
  last_seen_at: number | bigint;
}

function toVerdict(r: VerdictRow): ResidualVerdict {
  return {
    siteKey: r.site_key,
    menuHash: r.menu_hash,
    model: r.model,
    modelVersion: r.model_version,
    pick: r.pick,
    p: r.p,
    probabilities: JSON.parse(r.probabilities) as Record<string, number>,
    questionPayload: r.question_payload,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
  };
}

export class ResidualVerdictStore {
  private constructor(private readonly session: DuckDbGraphSession) {}

  static pathFor(rootDir: string, logicalName: string): string {
    return join(rootDir, "residual-verdicts", `${logicalName}.duckdb`);
  }

  static async open(
    rootDir: string,
    logicalName: string,
  ): Promise<ResidualVerdictStore> {
    const session = new DuckDbGraphSession({
      path: ResidualVerdictStore.pathFor(rootDir, logicalName),
    });
    await session.open();
    await session.exec(SCHEMA);
    return new ResidualVerdictStore(session);
  }

  async find(
    keys: { siteKey: string; menuHash: string; modelVersion: string }[],
  ): Promise<ResidualVerdict[]> {
    const out: ResidualVerdict[] = [];
    for (let i = 0; i < keys.length; i += CHUNK_ROWS) {
      const chunk = keys.slice(i, i + CHUNK_ROWS);
      const rows = await this.session.queryAll<VerdictRow>(
        `SELECT v.${COLUMNS.join(", v.")}
           FROM residual_verdicts v
           JOIN (VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}) AS k(site_key, menu_hash, model_version)
             ON v.site_key = k.site_key AND v.menu_hash = k.menu_hash AND v.model_version = k.model_version
          ORDER BY v.site_key, v.model`,
        chunk.flatMap((k) => [k.siteKey, k.menuHash, k.modelVersion]),
      );
      out.push(...rows.map(toVerdict));
    }
    return out;
  }

  async put(verdicts: ResidualVerdict[]): Promise<void> {
    const byKey = new Map<string, ResidualVerdict>();
    for (const v of verdicts)
      byKey.set(
        [v.siteKey, v.menuHash, v.model, v.modelVersion].join("\u0000"),
        v,
      );
    const rows = [...byKey.values()];
    const tuple = `(${COLUMNS.map(() => "?").join(", ")})`;
    await this.session.transaction(async () => {
      for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
        const chunk = rows.slice(i, i + CHUNK_ROWS);
        await this.session.run(
          `INSERT INTO residual_verdicts (${COLUMNS.join(", ")}) VALUES ${chunk.map(() => tuple).join(", ")}
           ON CONFLICT (site_key, menu_hash, model, model_version) DO UPDATE SET
             pick = excluded.pick,
             p = excluded.p,
             probabilities = excluded.probabilities,
             question_payload = excluded.question_payload,
             last_seen_at = excluded.last_seen_at`,
          chunk.flatMap((v) => [
            v.siteKey,
            v.menuHash,
            v.model,
            v.modelVersion,
            v.pick,
            v.p,
            JSON.stringify(v.probabilities),
            v.questionPayload,
            v.createdAt,
            v.lastSeenAt,
          ]),
        );
      }
    });
  }

  async touch(siteKeys: string[], model: string, now: number): Promise<void> {
    const unique = [...new Set(siteKeys)];
    for (let i = 0; i < unique.length; i += CHUNK_ROWS) {
      const chunk = unique.slice(i, i + CHUNK_ROWS);
      await this.session.run(
        `UPDATE residual_verdicts SET last_seen_at = ? WHERE model = ? AND site_key IN (${chunk.map(() => "?").join(", ")})`,
        [now, model, ...chunk],
      );
    }
  }

  /** Delete verdicts unseen for longer than `retentionDays`; resolves to the rows deleted. */
  async expire(retentionDays: number, now: number): Promise<number> {
    const cutoff = now - retentionDays * DAY_MS;
    return this.session.transaction(async () => {
      const [counted] = await this.session.queryAll<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM residual_verdicts WHERE last_seen_at < ?",
        [cutoff],
      );
      await this.session.run(
        "DELETE FROM residual_verdicts WHERE last_seen_at < ?",
        [cutoff],
      );
      return Number(counted?.n ?? 0);
    });
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
```

- [ ] **Step 5: Create the artifact and register it**

`src/core/domains/maintenance/footprint/artifact.ts` — the id union becomes:

```ts
export type ArtifactId =
  | "qdrant"
  | "codegraph"
  | "snapshot"
  | "stats"
  | "quarantine"
  | "indexing-lock"
  | "residual-verdicts";
```

`src/core/domains/maintenance/footprint/residual-verdicts-artifact.ts`:

```ts
import { rmSync } from "node:fs";

import type { CollectionArtifact, FootprintContext } from "./artifact.js";

/**
 * The residual-resolution verdict store of a logical collection. Its verdicts
 * are keyed by call-site content, not by generation, so a clone copies nothing
 * and only the collection's removal deletes the file.
 */
export class ResidualVerdictsArtifact implements CollectionArtifact {
  readonly id = "residual-verdicts" as const;
  readonly addressing = "logical" as const;
  constructor(private readonly fileFor: (logicalName: string) => string) {}

  async clone(): Promise<void> {
    // Nothing to copy — see the class docblock.
  }

  async remove(ctx: FootprintContext): Promise<void> {
    const file = this.fileFor(ctx.target.logicalName);
    rmSync(file, { force: true });
    rmSync(`${file}.wal`, { force: true });
  }
}
```

`src/core/domains/maintenance/footprint/factory.ts`:

- import:
  `import { ResidualVerdictsArtifact } from "./residual-verdicts-artifact.js";`
- `FootprintDeps` gains:

```ts
  /** Verdict-store file of a logical collection; absent → the artifact is not registered. */
  residualVerdictFile?: (logicalName: string) => string;
```

- in `build`, add `residualVerdictFile,` to the destructuring and append to the
  `artifacts` array after
  `new IndexingLockArtifact(snapshotBaseDir, indexingLockStoreFactory),`:

```ts
      ...(residualVerdictFile === undefined ? [] : [new ResidualVerdictsArtifact(residualVerdictFile)]),
```

Wire the path in both footprint constructions:

`src/bootstrap/factory.ts` (`new CollectionFootprintFactory({ ... })`, `:1627`)
— add after `indexingLockStoreFactory: ...,`:

```ts
    residualVerdictFile: (logicalName) => ResidualVerdictStore.pathFor(config.paths.appData, logicalName),
```

and
`import { ResidualVerdictStore } from "../core/adapters/duckdb/residual-verdict-store.js";`
next to the other `../core/adapters/duckdb/` imports.

`src/bootstrap/footprint-purge.ts` (`:90`) — add after
`indexingLockStoreFactory: ...,`:

```ts
    residualVerdictFile: (logicalName) => ResidualVerdictStore.pathFor(deps.appDataDir, logicalName),
```

with the same import (`../core/adapters/duckdb/residual-verdict-store.js`).

- [ ] **Step 6: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/adapters/duckdb/residual-verdict-store.test.ts tests/core/domains/maintenance/footprint/residual-verdicts-artifact.test.ts tests/core/domains/maintenance/footprint-purger.test.ts tests/core/domains/maintenance/footprint.test.ts tests/core/domains/maintenance/worktree-provisioner.test.ts`
Expected: PASS (the `footprint.test.ts` artifact-order case is unchanged: its
deps carry no `residualVerdictFile`).

Run:
`npx tsc --noEmit && npx tsc -p tsconfig.tests.json && npx eslint src/core/adapters/duckdb/residual-verdict-store.ts src/core/domains/maintenance/footprint src/bootstrap/factory.ts src/bootstrap/footprint-purge.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/adapters/duckdb/residual-verdict-store.ts \
  src/core/domains/maintenance/footprint/artifact.ts \
  src/core/domains/maintenance/footprint/residual-verdicts-artifact.ts \
  src/core/domains/maintenance/footprint/factory.ts \
  src/bootstrap/factory.ts src/bootstrap/footprint-purge.ts \
  tests/core/adapters/duckdb/residual-verdict-store.test.ts \
  tests/core/domains/maintenance/footprint/residual-verdicts-artifact.test.ts \
  tests/core/domains/maintenance/footprint-purger.test.ts
git commit -m "feat(codegraph): per-collection residual verdict store removed with the footprint"
```

### Task 7: Residual provider port, factory and `codegraph.residual` config

The port types are the Shared Contracts domain types. The factory follows the
`EmbeddingProviderFactory` switch (`src/core/adapters/embeddings/factory.ts`):
an unknown model throws `ConfigValueInvalidError`. The `kev` case lands in Task
8 together with `KevResidualProvider`, so after this task every model is still
rejected.

**Files:**

- Create: `src/core/domains/trajectory/codegraph/residual/types.ts`
- Create:
  `src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.ts`
- Modify: `src/bootstrap/config/schemas.ts` (new `codegraphResidualSchema` above
  `codegraphSchema` at ~215; `residual` field at the end of `codegraphSchema`,
  after `ambiguousResolveMode` ~283)
- Modify: `src/bootstrap/config/parse.ts:160-168` (the `codegraph` input object)
- Modify: `src/bootstrap/config/env-snapshot.ts:108-113` (codegraph `put` block)
- Modify: `src/core/domains/maintenance/registry/env-groups.ts:111-116`
  (codegraph groups)
- Modify: `tests/bootstrap/env-snapshot.test.ts:205` (the drift-guard fixture
  sets every optional)
- Modify: `tests/core/domains/maintenance/registry/env-groups.test.ts`
  (`covers the FULL indexing env surface` list)
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts:128-150`
  (`CodegraphProviderDeps.residualMenuLimit`) and `:322` (the
  `new CallEdgeResolutionRunner(...)` call — the only construction site,
  verified with `find_symbol`/ripgrep: `provider.ts:322`)
- Modify: `src/core/domains/trajectory/codegraph/index.ts:41-95`
  (`CodegraphDeps.residualMenuLimit`; `createCodegraphTrajectories` already
  spreads every `CodegraphDeps` field into the provider deps, so the main thread
  needs nothing else)
- Modify: `src/core/domains/trajectory/codegraph/factory.ts:52-140`
  (`CodegraphWorkerConfig.residualMenuLimit`) and `:270-283` (worker-side
  `new CodegraphEnrichmentProvider({...})`)
- Modify: `src/bootstrap/factory.ts:1009-1019` (`codegraphWorkerConfig`) and
  `:1036-1050` (`const deps: CodegraphDeps`)
- Test: `tests/bootstrap/config-residual.test.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/provider-residual-menu-limit.test.ts`

The menu limit is consumed by Part A's static side: `CallEdgeResolutionRunner`
takes an optional third constructor argument (default
`DEFAULT_RESIDUAL_MENU_LIMIT = 40`) and cuts candidate menus there. This task
only threads `CODEGRAPH_RESIDUAL_MENU_LIMIT` to it — one optional dep per hop,
no logic in `provider.ts` (hotspot). Resolution runs in enrichment workers, so
the value rides both the main-thread `CodegraphDeps` and the worker's
`CodegraphWorkerConfig`, exactly as `ambiguousResolveMode` does.

**Interfaces:**

- Consumes: `ResidualKind`, `ResidualVerdict`, `ResidualQuestion`,
  `ResidualQuestionGroup`, `ResidualAnswer`, `ResidualModelProvider` from
  `src/core/contracts/types/codegraph-residual.ts` (Task 1 / contract update);
  `CallEdgeResolutionRunner(languageFactory, runState, menuLimit?: number)`
  (Part A); `ConfigValueInvalidError(field, value, expected)` and
  `ConfigValueMissingError(field, envVar)` from `src/core/infra/errors.ts`;
  `commaSeparatedList`, `floatWithDefault`, `intWithDefault` from
  `src/bootstrap/config/schemas.ts` / `utils.ts`.
- Produces:
  - `residual/types.ts`: type-only re-exports of `ResidualVerdict`,
    `ResidualQuestion`, `ResidualQuestionGroup`, `ResidualAnswer`,
    `ResidualModelProvider` from contracts (declared in Plan A Task 1, no second
    declaration) plus `ResidualPassReport` exactly as in Shared Contracts.
  - `CodegraphProviderDeps.residualMenuLimit?: number`,
    `CodegraphDeps.residualMenuLimit?: number`,
    `CodegraphWorkerConfig.residualMenuLimit?: number` → third argument of
    `new CallEdgeResolutionRunner(...)`.
  - `export interface ResidualProviderConfig { kevUrls?: readonly string[]; kevThreshold: number }`
  - `export const RESIDUAL_MODELS: readonly ["kev"]`
  - `ResidualModelProviderFactory.create(model: string, config: ResidualProviderConfig): ResidualModelProvider`
  - `CodegraphConfig["residual"]` =
    `{ kevUrls: string[] | undefined; kevThreshold: number; concurrency: number; menuLimit: number; retentionDays: number }`
  - Env: `CODEGRAPH_RESIDUAL_KEV_URL` (comma-separated, like
    `EMBEDDING_BASE_URL`), `CODEGRAPH_RESIDUAL_KEV_THRESHOLD`,
    `CODEGRAPH_RESIDUAL_CONCURRENCY`, `CODEGRAPH_RESIDUAL_MENU_LIMIT`,
    `CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS`, all registry consequence
    `runtime`.

- [ ] **Step 1: Write the failing config test**

`tests/bootstrap/config-residual.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseAppConfigZod } from "../../src/bootstrap/config/index.js";

describe("codegraph.residual config", () => {
  it("defaults: no Kev URL, threshold 0.7, concurrency 96, menu limit 40, retention 180 days", () => {
    const { codegraph } = parseAppConfigZod({});

    expect(codegraph.residual).toEqual({
      kevUrls: undefined,
      kevThreshold: 0.7,
      concurrency: 96,
      menuLimit: 40,
      retentionDays: 180,
    });
  });

  it("reads every CODEGRAPH_RESIDUAL_* variable; the Kev URL list is comma-separated", () => {
    const { codegraph } = parseAppConfigZod({
      CODEGRAPH_RESIDUAL_KEV_URL: "http://gpu:8090, http://gpu:8091",
      CODEGRAPH_RESIDUAL_KEV_THRESHOLD: "0.85",
      CODEGRAPH_RESIDUAL_CONCURRENCY: "8",
      CODEGRAPH_RESIDUAL_MENU_LIMIT: "20",
      CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS: "30",
    });

    expect(codegraph.residual).toEqual({
      kevUrls: ["http://gpu:8090", "http://gpu:8091"],
      kevThreshold: 0.85,
      concurrency: 8,
      menuLimit: 20,
      retentionDays: 30,
    });
  });

  it("records the residual keys as explicitly set", () => {
    const { flags } = parseAppConfigZod({
      CODEGRAPH_RESIDUAL_KEV_URL: "http://gpu:8090",
    });

    expect(flags.explicitEnvKeys).toContain("CODEGRAPH_RESIDUAL_KEV_URL");
  });
});
```

`tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  RESIDUAL_MODELS,
  ResidualModelProviderFactory,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.js";
import { ConfigValueInvalidError } from "../../../../../../src/core/infra/errors.js";

describe("ResidualModelProviderFactory", () => {
  it("rejects an unknown model with a typed config error naming the supported models", () => {
    const create = () =>
      ResidualModelProviderFactory.create("gpt-9", {
        kevUrls: ["http://gpu:8090"],
        kevThreshold: 0.7,
      });

    expect(create).toThrow(ConfigValueInvalidError);
    expect(create).toThrow(
      /Invalid value "gpt-9" for configuration field "residualModel"/,
    );
  });

  it("lists kev as the only wave-1 model", () => {
    expect(RESIDUAL_MODELS).toEqual(["kev"]);
  });
});
```

`tests/core/domains/trajectory/codegraph/symbols/provider-residual-menu-limit.test.ts`
(the construction seam only — the cut itself is Part A's runner test):

```ts
import { describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const runnerArgs = vi.hoisted(() => [] as unknown[][]);

vi.mock(
  "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js")
      >();
    class RecordingRunner extends actual.CallEdgeResolutionRunner {
      constructor(
        ...args: ConstructorParameters<typeof actual.CallEdgeResolutionRunner>
      ) {
        super(...args);
        runnerArgs.push(args);
      }
    }
    return { ...actual, CallEdgeResolutionRunner: RecordingRunner };
  },
);

const build = (residualMenuLimit?: number): CodegraphEnrichmentProvider =>
  new CodegraphEnrichmentProvider({
    graphDb: {} as never,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
    ...(residualMenuLimit !== undefined ? { residualMenuLimit } : {}),
  });

describe("CodegraphEnrichmentProvider — residual menu limit seam", () => {
  it("hands CODEGRAPH_RESIDUAL_MENU_LIMIT to the call-edge resolution runner", () => {
    runnerArgs.length = 0;
    build(12);

    expect(runnerArgs).toHaveLength(1);
    expect(runnerArgs[0][2]).toBe(12);
  });

  it("leaves the runner on its own default when no limit is configured", () => {
    runnerArgs.length = 0;
    build();

    expect(runnerArgs[0][2]).toBeUndefined();
  });
});
```

(`buildTestCodegraphDeps` lives in
`tests/core/domains/trajectory/codegraph/__helpers__/language-factory.ts` and is
how `provider-run-reset-seams.test.ts` builds a provider; if its signature
differs, follow that file's call.)

Add to `tests/core/domains/maintenance/registry/env-groups.test.ts`, inside the
key list of `it("covers the FULL indexing env surface: ...")`, after
`"CODEGRAPH_AMBIGUOUS_RESOLVE_MODE"` (or after the `// codegraph` comment if the
key is not listed there):

```ts
      "CODEGRAPH_RESIDUAL_KEV_URL",
      "CODEGRAPH_RESIDUAL_KEV_THRESHOLD",
      "CODEGRAPH_RESIDUAL_CONCURRENCY",
      "CODEGRAPH_RESIDUAL_MENU_LIMIT",
      "CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS",
```

In `tests/bootstrap/env-snapshot.test.ts:205` (drift guard: every optional set)
replace

```ts
cfg.codegraph = codegraphSchema.parse({
  dbPath: "/tmp/cg",
  customExcludePatterns: "vendor/**",
});
```

with

```ts
cfg.codegraph = codegraphSchema.parse({
  dbPath: "/tmp/cg",
  customExcludePatterns: "vendor/**",
  residual: { kevUrls: "http://gpu:8090" },
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`npx vitest run tests/bootstrap/config-residual.test.ts tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts tests/core/domains/maintenance/registry/env-groups.test.ts tests/core/domains/trajectory/codegraph/symbols/provider-residual-menu-limit.test.ts`
Expected: FAIL — `codegraph.residual` is `undefined`; the factory module does
not exist; `CODEGRAPH_RESIDUAL_KEV_URL` missing from the canonical set; the
runner's third argument is `undefined` for `build(12)`.

- [ ] **Step 3: Implement**

`src/core/domains/trajectory/codegraph/residual/types.ts`:

```ts
/**
 * Residual resolution port, domain side. The port types are declared in
 * contracts (Plan A Task 1) because adapters (`ResidualVerdictStore`,
 * `KevResidualProvider`) may import only `core/{contracts,infra}`; domain code
 * reads them through this re-export. `ResidualPassReport` is domain-only.
 */

export type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestion,
  ResidualQuestionGroup,
  ResidualVerdict,
} from "../../../../contracts/types/codegraph-residual.js";

export interface ResidualPassReport {
  status: "completed" | "skipped";
  reason?: string;
  sites: number;
  reused: number;
  asked: number;
  applied: number;
  overflowSkipped: number;
}
```

`src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.ts`:

```ts
import { ConfigValueInvalidError } from "../../../../infra/errors.js";
import type { ResidualModelProvider } from "./types.js";

/** Models `--resolve-residual` / `--model` accept. Wave 1: Kev only. */
export const RESIDUAL_MODELS = ["kev"] as const;

/** The slice of `codegraph.residual` a provider is built from. */
export interface ResidualProviderConfig {
  kevUrls?: readonly string[];
  kevThreshold: number;
}

export class ResidualModelProviderFactory {
  static create(
    model: string,
    _config: ResidualProviderConfig,
  ): ResidualModelProvider {
    switch (model) {
      default:
        throw new ConfigValueInvalidError(
          "residualModel",
          model,
          RESIDUAL_MODELS.join(" | "),
        );
    }
  }
}
```

`src/bootstrap/config/schemas.ts` — insert directly above
`export const codegraphSchema`:

```ts
/**
 * Residual resolution (`index-codebase --resolve-residual`, `resolve-codegraph-residual`):
 * model verdicts for the call sites the static resolver left ambiguous or dynamic.
 */
export const codegraphResidualSchema = z.object({
  /** Kev base URLs; several are used round-robin. */
  kevUrls: commaSeparatedList,
  /** Minimum verdict probability for a Kev answer to become an edge. */
  kevThreshold: floatWithDefault(0.7),
  /** Concurrent provider requests (one request per enclosing method). */
  concurrency: intWithDefault(96),
  /** A site with more candidates than this is not asked. */
  menuLimit: intWithDefault(40),
  /** Verdicts not seen by any run for this many days are dropped. */
  retentionDays: intWithDefault(180),
});
```

and append to the `codegraphSchema` object, after `ambiguousResolveMode`:

```ts
  /** Model-assisted resolution of residual call sites. */
  residual: codegraphResidualSchema.prefault({}),
```

(`prefault`, not `default`: zod 4.3 `default({})` returns `{}` without running
the field defaults.)

`src/bootstrap/config/parse.ts` — in `const codegraph = { ... }` add after
`ambiguousResolveMode`:

```ts
    residual: {
      kevUrls: env("CODEGRAPH_RESIDUAL_KEV_URL"),
      kevThreshold: env("CODEGRAPH_RESIDUAL_KEV_THRESHOLD"),
      concurrency: env("CODEGRAPH_RESIDUAL_CONCURRENCY"),
      menuLimit: env("CODEGRAPH_RESIDUAL_MENU_LIMIT"),
      retentionDays: env("CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS"),
    },
```

`src/core/domains/maintenance/registry/env-groups.ts` — after the
`CODEGRAPH_AMBIGUOUS_RESOLVE_MODE` line:

```ts
  // codegraph.residual — which model answers and how many requests are in flight;
  // verdicts are cached outside the index, so none of these invalidates it.
  { canonical: "CODEGRAPH_RESIDUAL_KEV_URL", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_RESIDUAL_KEV_THRESHOLD", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_RESIDUAL_CONCURRENCY", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_RESIDUAL_MENU_LIMIT", aliases: [], consequence: "runtime" },
  { canonical: "CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS", aliases: [], consequence: "runtime" },
```

`src/bootstrap/config/env-snapshot.ts` — after
`put("CODEGRAPH_AMBIGUOUS_RESOLVE_MODE", ...)`:

```ts
putList("CODEGRAPH_RESIDUAL_KEV_URL", codegraph.residual.kevUrls);
put("CODEGRAPH_RESIDUAL_KEV_THRESHOLD", codegraph.residual.kevThreshold);
put("CODEGRAPH_RESIDUAL_CONCURRENCY", codegraph.residual.concurrency);
put("CODEGRAPH_RESIDUAL_MENU_LIMIT", codegraph.residual.menuLimit);
put(
  "CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS",
  codegraph.residual.retentionDays,
);
```

Menu-limit seam (one optional field per hop, mirroring `ambiguousResolveMode`):

`src/core/domains/trajectory/codegraph/symbols/provider.ts` — in
`CodegraphProviderDeps`, after `composer`:

```ts
  /** Candidate-menu cap for residual call sites (`CODEGRAPH_RESIDUAL_MENU_LIMIT`); runner default when absent. */
  residualMenuLimit?: number;
```

and replace line 322

```ts
this.resolutionRunner = new CallEdgeResolutionRunner(
  deps.languageFactory,
  this.runState,
);
```

with

```ts
this.resolutionRunner = new CallEdgeResolutionRunner(
  deps.languageFactory,
  this.runState,
  deps.residualMenuLimit,
);
```

`src/core/domains/trajectory/codegraph/index.ts` — in `CodegraphDeps`, after
`ambiguousResolveMode`:

```ts
  /** `CODEGRAPH_RESIDUAL_MENU_LIMIT`, spread into the symbols provider deps. */
  residualMenuLimit?: number;
```

`src/core/domains/trajectory/codegraph/factory.ts` — in `CodegraphWorkerConfig`,
after `ambiguousResolveMode`:

```ts
  /** `CODEGRAPH_RESIDUAL_MENU_LIMIT` for the in-thread provider's resolution runner. */
  residualMenuLimit?: number;
```

and in the worker-side `new CodegraphEnrichmentProvider({ ... })` object, after
`exclusion: ...`:

```ts
      ...(config.residualMenuLimit !== undefined ? { residualMenuLimit: config.residualMenuLimit } : {}),
```

`src/bootstrap/factory.ts` — `codegraphWorkerConfig`, after
`ambiguousResolveMode: ambiguousMode,`:

```ts
    residualMenuLimit: codegraph.residual.menuLimit,
```

and `const deps: CodegraphDeps = { ... }`, after
`ambiguousResolveMode: ambiguousMode,`:

```ts
    residualMenuLimit: codegraph.residual.menuLimit,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`npx vitest run tests/bootstrap/config-residual.test.ts tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts tests/core/domains/maintenance/registry/env-groups.test.ts tests/bootstrap/env-snapshot.test.ts tests/bootstrap/config-zod.test.ts tests/bootstrap/effective-index-env-snapshot.test.ts tests/core/domains/trajectory/codegraph/symbols/provider-residual-menu-limit.test.ts tests/bootstrap/factory.test.ts`
Expected: PASS. Then `npx tsc --noEmit -p tsconfig.json`: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/residual/types.ts \
  src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.ts \
  src/bootstrap/config/schemas.ts src/bootstrap/config/parse.ts src/bootstrap/config/env-snapshot.ts \
  src/core/domains/maintenance/registry/env-groups.ts \
  src/core/domains/trajectory/codegraph/symbols/provider.ts src/core/domains/trajectory/codegraph/index.ts \
  src/core/domains/trajectory/codegraph/factory.ts src/bootstrap/factory.ts \
  tests/bootstrap/config-residual.test.ts tests/bootstrap/env-snapshot.test.ts \
  tests/core/domains/maintenance/registry/env-groups.test.ts \
  tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts \
  tests/core/domains/trajectory/codegraph/symbols/provider-residual-menu-limit.test.ts
git commit -m "feat(codegraph): residual provider port, factory, CODEGRAPH_RESIDUAL_* config and menu-limit seam"
```

---

### Task 8: `KevResidualProvider`

One `POST <url>/v1/systemone` per question group; `health()` and `version()`
read `GET <url>/v1/models`. HTTP goes through an injected `fetch`, the way
`LlamaServerEmbeddings` does (`LlamaServerEmbeddingsDeps.fetch`), so the
contract test drives it with recorded JSON fixtures and no socket.

Adapters may import only `core/{contracts,infra}` (`eslint.config.js:426-443`),
so the port types come from `contracts/types/codegraph-residual.ts` (Plan A Task
1), not from the domain `residual/types.ts`; the class is declared
`implements ResidualModelProvider`.

**Files:**

- Create: `src/core/adapters/kev/errors.ts`
- Create: `src/core/adapters/kev/kev-residual-provider.ts`
- Modify: `src/core/adapters/errors.ts` (`INFRA_ERROR_CODES`, after the
  `// Codegraph daemon` block, before `] as const;`)
- Modify:
  `src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.ts`
  (add the `kev` case)
- Create: `tests/fixtures/kev/models.json`
- Create: `tests/fixtures/kev/systemone-two-sites.json`
- Test: `tests/core/adapters/kev/kev-residual-provider.test.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts`
  (extend)

**Interfaces:**

- Consumes: `InfraError` (`src/core/adapters/errors.ts`),
  `ConfigValueMissingError` (`src/core/infra/errors.ts`),
  `ResidualQuestionGroup`, `ResidualAnswer`, `ResidualModelProvider`
  (`src/core/contracts/types/codegraph-residual.ts`).
- Produces:
  - `export interface KevResidualProviderOptions { urls: readonly string[]; threshold: number }`
  - `export interface KevResidualProviderDeps { fetch?: typeof fetch }`
  - `export class KevResidualProvider implements ResidualModelProvider { readonly id = "kev"; readonly threshold: number; version(): Promise<string>; health(): Promise<{ ok: true } | { ok: false; reason: string }>; resolveGroup(group: ResidualQuestionGroup): Promise<ResidualAnswer[]> }`
  - `export function kevQuestion(receiverText: string, member: string, classes: readonly string[]): KevChoiceQuestion`
  - `export function candidateClass(symbolId: string): string`
  - `KevUnavailableError` (`INFRA_KEV_UNAVAILABLE`), `KevResponseError`
    (`INFRA_KEV_RESPONSE_ERROR`)
  - `ResidualModelProviderFactory.create("kev", config, deps?)` →
    `KevResidualProvider`; no URL → `ConfigValueMissingError`.

- [ ] **Step 1: Write the fixtures and the failing test**

`tests/fixtures/kev/models.json`:

```json
{ "models": [{ "id": "kev-latest", "run": "jaredpalmer/kev-4b@v1.0" }] }
```

`tests/fixtures/kev/systemone-two-sites.json`:

```json
{
  "answers": {
    "site-a": {
      "choice": "Firm",
      "probabilities": { "Firm": 0.91, "Client": 0.09 }
    },
    "site-b": {
      "choice": "Client",
      "probabilities": { "Firm": 0.2, "Client": 0.8 }
    }
  }
}
```

`tests/core/adapters/kev/kev-residual-provider.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  KevResponseError,
  KevUnavailableError,
} from "../../../../src/core/adapters/kev/errors.js";
import {
  candidateClass,
  kevQuestion,
  KevResidualProvider,
} from "../../../../src/core/adapters/kev/kev-residual-provider.js";
import type { ResidualQuestionGroup } from "../../../../src/core/contracts/types/codegraph-residual.js";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/kev");
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

interface Recorded {
  url: string;
  method: string;
  body?: unknown;
}

type Route = (url: string, init?: RequestInit) => Response | "refused";

function fakeFetch(route: Route): {
  fetch: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) }
        : {}),
    });
    const outcome = route(url, init);
    if (outcome === "refused")
      throw new TypeError("fetch failed: ECONNREFUSED");
    return outcome;
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const GROUP: ResidualQuestionGroup = {
  sourceRelPath: "app/services/sync.rb",
  methodSymbolId: "Sync#run",
  methodSource: "def run(firm, client)\n  firm.users\n  client.users\nend",
  questions: [
    {
      siteKey: "site-a",
      menuHash: "menu-1",
      receiverText: "firm",
      member: "users",
      kind: "ambiguous",
      candidates: ["Firm#users", "Client#users"],
    },
    {
      siteKey: "site-b",
      menuHash: "menu-1",
      receiverText: "client",
      member: "users",
      kind: "ambiguous",
      candidates: ["Firm#users", "Client#users"],
    },
  ],
};

describe("candidateClass", () => {
  it("takes the class part of instance and class method symbolIds", () => {
    expect(candidateClass("Firm#users")).toBe("Firm");
    expect(candidateClass("TaxPreparation::DocDir#client")).toBe(
      "TaxPreparation::DocDir",
    );
    expect(candidateClass("Firm.find_by_slug")).toBe("Firm");
    expect(candidateClass("Firm")).toBe("Firm");
  });
});

describe("KevResidualProvider", () => {
  it("sends one /v1/systemone request per group: state = file header + method source, one choice question per site", async () => {
    const { fetch, requests } = fakeFetch(() =>
      json(fixture("systemone-two-sites.json")),
    );
    const provider = new KevResidualProvider(
      { urls: ["http://gpu:8090"], threshold: 0.7 },
      { fetch },
    );

    await provider.resolveGroup(GROUP);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "http://gpu:8090/v1/systemone",
      method: "POST",
      body: {
        model: "kev-latest",
        state:
          "# file: app/services/sync.rb\ndef run(firm, client)\n  firm.users\n  client.users\nend",
        questions: {
          "site-a": kevQuestion("firm", "users", ["Firm", "Client"]),
          "site-b": kevQuestion("client", "users", ["Firm", "Client"]),
        },
      },
    });
    expect(kevQuestion("firm", "users", ["Firm", "Client"])).toEqual({
      type: "choice",
      instructions:
        "In this Ruby method, `firm` is the receiver of the call `firm.users`. " +
        "Which class is the object passed as `firm`?",
      criteria: { Firm: null, Client: null },
    });
  });

  it("maps each answer's class back to the candidate symbolId, p = probability of the choice", async () => {
    const { fetch } = fakeFetch(() =>
      json(fixture("systemone-two-sites.json")),
    );
    const provider = new KevResidualProvider(
      { urls: ["http://gpu:8090"], threshold: 0.7 },
      { fetch },
    );

    const answers = await provider.resolveGroup(GROUP);

    expect(answers).toEqual([
      {
        siteKey: "site-a",
        pick: "Firm#users",
        p: 0.91,
        probabilities: { "Firm#users": 0.91, "Client#users": 0.09 },
        questionPayload: JSON.stringify(
          kevQuestion("firm", "users", ["Firm", "Client"]),
        ),
      },
      {
        siteKey: "site-b",
        pick: "Client#users",
        p: 0.8,
        probabilities: { "Firm#users": 0.2, "Client#users": 0.8 },
        questionPayload: JSON.stringify(
          kevQuestion("client", "users", ["Firm", "Client"]),
        ),
      },
    ]);
  });

  it("rejects an answer naming a class outside the menu", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        answers: {
          "site-a": { choice: "Account", probabilities: { Account: 1 } },
        },
      }),
    );
    const provider = new KevResidualProvider(
      { urls: ["http://gpu:8090"], threshold: 0.7 },
      { fetch },
    );

    await expect(
      provider.resolveGroup({ ...GROUP, questions: [GROUP.questions[0]] }),
    ).rejects.toBeInstanceOf(KevResponseError);
  });

  it("round-robins groups across URLs and fails over past a refused one", async () => {
    const { fetch, requests } = fakeFetch((url) =>
      url.startsWith("http://b:1")
        ? "refused"
        : json(fixture("systemone-two-sites.json")),
    );
    const provider = new KevResidualProvider(
      { urls: ["http://a:1", "http://b:1"], threshold: 0.7 },
      { fetch },
    );

    await provider.resolveGroup(GROUP);
    await provider.resolveGroup(GROUP);

    expect(requests.map((r) => r.url)).toEqual([
      "http://a:1/v1/systemone",
      "http://b:1/v1/systemone",
      "http://a:1/v1/systemone",
    ]);
  });

  it("throws KevUnavailableError when every URL is down", async () => {
    const { fetch } = fakeFetch(() => "refused");
    const provider = new KevResidualProvider(
      { urls: ["http://a:1", "http://b:1"], threshold: 0.7 },
      { fetch },
    );

    await expect(provider.resolveGroup(GROUP)).rejects.toBeInstanceOf(
      KevUnavailableError,
    );
  });

  it("version() is the run of the served model; health() is ok when /v1/models answers", async () => {
    const { fetch, requests } = fakeFetch(() => json(fixture("models.json")));
    const provider = new KevResidualProvider(
      { urls: ["http://gpu:8090"], threshold: 0.7 },
      { fetch },
    );

    expect(await provider.version()).toBe("jaredpalmer/kev-4b@v1.0");
    expect(await provider.health()).toEqual({ ok: true });
    expect(
      requests.every(
        (r) => r.url === "http://gpu:8090/v1/models" && r.method === "GET",
      ),
    ).toBe(true);
  });

  it("health() reports the reason when no URL serves a model", async () => {
    const { fetch } = fakeFetch(() => "refused");
    const provider = new KevResidualProvider(
      { urls: ["http://gpu:8090"], threshold: 0.7 },
      { fetch },
    );

    const health = await provider.health();

    expect(health.ok).toBe(false);
    expect(health).toEqual({
      ok: false,
      reason: expect.stringMatching(/http:\/\/gpu:8090.*ECONNREFUSED/),
    });
  });

  it("carries the configured threshold and id", () => {
    const provider = new KevResidualProvider({
      urls: ["http://gpu:8090"],
      threshold: 0.85,
    });

    expect(provider.id).toBe("kev");
    expect(provider.threshold).toBe(0.85);
  });
});
```

Extend
`tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts`
(add the imports at the top and the two cases inside the `describe`):

```ts
import { KevResidualProvider } from "../../../../../../src/core/adapters/kev/kev-residual-provider.js";
import { ConfigValueMissingError } from "../../../../../../src/core/infra/errors.js";

it("builds a KevResidualProvider for kev with the configured threshold", () => {
  const provider = ResidualModelProviderFactory.create("kev", {
    kevUrls: ["http://gpu:8090"],
    kevThreshold: 0.8,
  });

  expect(provider).toBeInstanceOf(KevResidualProvider);
  expect(provider.threshold).toBe(0.8);
});

it("refuses kev without CODEGRAPH_RESIDUAL_KEV_URL", () => {
  expect(() =>
    ResidualModelProviderFactory.create("kev", { kevThreshold: 0.7 }),
  ).toThrow(ConfigValueMissingError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/adapters/kev/kev-residual-provider.test.ts tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts`
Expected: FAIL — `src/core/adapters/kev/*` does not exist; the factory rejects
`kev`.

- [ ] **Step 3: Implement**

`src/core/adapters/errors.ts` — append to `INFRA_ERROR_CODES` before
`] as const;`:

```ts
  // Kev residual model
  "INFRA_KEV_UNAVAILABLE",
  "INFRA_KEV_RESPONSE_ERROR",
```

`src/core/adapters/kev/errors.ts`:

```ts
/** Kev residual-model provider errors. */

import { InfraError } from "../errors.js";

/** No configured Kev URL answered. */
export class KevUnavailableError extends InfraError {
  constructor(urls: readonly string[], cause?: Error) {
    super({
      code: "INFRA_KEV_UNAVAILABLE",
      message: `No Kev endpoint is reachable at ${urls.join(", ")}`,
      hint:
        "Start the Kev server on the GPU host, check that its port is reachable from here, " +
        `and verify CODEGRAPH_RESIDUAL_KEV_URL=${urls.join(",")}`,
      cause,
    });
  }
}

/** Kev answered, but not with what was asked. */
export class KevResponseError extends InfraError {
  constructor(url: string, detail: string) {
    super({
      code: "INFRA_KEV_RESPONSE_ERROR",
      message: `Kev at ${url} returned an unusable response: ${detail}`,
      hint: "Check that the endpoint serves the Kev systemone API (POST /v1/systemone, GET /v1/models).",
      httpStatus: 502,
    });
  }
}
```

`src/core/adapters/kev/kev-residual-provider.ts`:

```ts
/**
 * Kev (`/v1/systemone`) as a residual-resolution model. One request per
 * enclosing method: `state` is the method source, one `choice` question per
 * call site, the menu is the candidates' classes. Kev caches the state as a
 * prefix, so the questions of one method cost one prefill.
 */

import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestion,
  ResidualQuestionGroup,
} from "../../contracts/types/codegraph-residual.js";
import { KevResponseError, KevUnavailableError } from "./errors.js";

const MODEL_NAME = "kev-latest";
const RESOLVE_TIMEOUT_MS = 120_000;
const MODELS_TIMEOUT_MS = 5_000;

export interface KevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, null>;
}

export interface KevResidualProviderOptions {
  urls: readonly string[];
  threshold: number;
}

export interface KevResidualProviderDeps {
  fetch?: typeof fetch;
}

interface SystemOneResponse {
  answers?: Record<
    string,
    { choice?: string; probabilities?: Record<string, number> }
  >;
}

interface ModelsResponse {
  models?: { run?: string }[];
}

/** Class part of a candidate method symbolId: `Firm#users` / `Firm.find` → `Firm`. */
export function candidateClass(symbolId: string): string {
  const hash = symbolId.lastIndexOf("#");
  const cut = hash > 0 ? hash : symbolId.lastIndexOf(".");
  return cut > 0 ? symbolId.slice(0, cut) : symbolId;
}

export function kevQuestion(
  receiverText: string,
  member: string,
  classes: readonly string[],
): KevChoiceQuestion {
  return {
    type: "choice",
    instructions:
      `In this Ruby method, \`${receiverText}\` is the receiver of the call \`${receiverText}.${member}\`. ` +
      `Which class is the object passed as \`${receiverText}\`?`,
    criteria: Object.fromEntries(classes.map((name) => [name, null])),
  };
}

export class KevResidualProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold: number;
  private readonly urls: readonly string[];
  private readonly fetchFn: typeof fetch;
  private nextUrl = 0;

  constructor(
    options: KevResidualProviderOptions,
    deps: KevResidualProviderDeps = {},
  ) {
    this.urls = options.urls;
    this.threshold = options.threshold;
    this.fetchFn = deps.fetch ?? (async (input, init) => fetch(input, init));
  }

  async version(): Promise<string> {
    const failures: string[] = [];
    for (const url of this.urls) {
      try {
        return await this.readRun(url);
      } catch (error) {
        failures.push(`${url}: ${errorMessage(error)}`);
      }
    }
    throw new KevUnavailableError(this.urls, new Error(failures.join("; ")));
  }

  async health(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const failures: string[] = [];
    for (const url of this.urls) {
      try {
        await this.readRun(url);
        return { ok: true };
      } catch (error) {
        failures.push(`${url}: ${errorMessage(error)}`);
      }
    }
    return { ok: false, reason: failures.join("; ") };
  }

  async resolveGroup(group: ResidualQuestionGroup): Promise<ResidualAnswer[]> {
    const menus = group.questions.map((question) =>
      classMenu(question.candidates),
    );
    const questions = group.questions.map((question, i) =>
      kevQuestion(question.receiverText, question.member, [...menus[i].keys()]),
    );
    const body = JSON.stringify({
      model: MODEL_NAME,
      state: `# file: ${group.sourceRelPath}\n${group.methodSource}`,
      questions: Object.fromEntries(
        group.questions.map((question, i) => [question.siteKey, questions[i]]),
      ),
    });
    const { url, response } = await this.postAcrossUrls(body);
    return group.questions.map((question, i) =>
      toAnswer(url, question, menus[i], questions[i], response),
    );
  }

  private async readRun(url: string): Promise<string> {
    const response = await this.fetchFn(`${url}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`GET /v1/models answered ${response.status}`);
    const run = ((await response.json()) as ModelsResponse).models?.[0]?.run;
    if (typeof run !== "string" || run.length === 0)
      throw new KevResponseError(url, "/v1/models lists no model run");
    return run;
  }

  /** Round-robin start, then every other URL once; 4xx and malformed bodies are not retried elsewhere. */
  private async postAcrossUrls(
    body: string,
  ): Promise<{ url: string; response: SystemOneResponse }> {
    const start = this.nextUrl;
    this.nextUrl = (this.nextUrl + 1) % this.urls.length;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const url = this.urls[(start + attempt) % this.urls.length];
      let response: Response;
      try {
        response = await this.fetchFn(`${url}/v1/systemone`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      if (response.status >= 500) {
        lastError = new Error(`${url} answered ${response.status}`);
        continue;
      }
      if (!response.ok)
        throw new KevResponseError(
          url,
          `HTTP ${response.status}: ${await response.text()}`,
        );
      return { url, response: (await response.json()) as SystemOneResponse };
    }
    throw new KevUnavailableError(this.urls, lastError);
  }
}

/** Class → candidate symbolId, first candidate wins a class shared by two. */
function classMenu(candidates: readonly string[]): Map<string, string> {
  const menu = new Map<string, string>();
  for (const symbolId of candidates) {
    const name = candidateClass(symbolId);
    if (!menu.has(name)) menu.set(name, symbolId);
  }
  return menu;
}

function toAnswer(
  url: string,
  question: ResidualQuestion,
  menu: Map<string, string>,
  payload: KevChoiceQuestion,
  response: SystemOneResponse,
): ResidualAnswer {
  const answer = response.answers?.[question.siteKey];
  const choice = answer?.choice;
  const pick = choice === undefined ? undefined : menu.get(choice);
  if (choice === undefined || pick === undefined) {
    throw new KevResponseError(
      url,
      `site ${question.siteKey}: choice ${String(choice)} is not on the menu`,
    );
  }
  const probabilities: Record<string, number> = {};
  for (const [name, p] of Object.entries(answer?.probabilities ?? {})) {
    const symbolId = menu.get(name);
    if (symbolId !== undefined) probabilities[symbolId] = p;
  }
  return {
    siteKey: question.siteKey,
    pick,
    p: answer?.probabilities?.[choice] ?? 0,
    probabilities,
    questionPayload: JSON.stringify(payload),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

`src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.ts`
— replace the file body:

```ts
import {
  KevResidualProvider,
  type KevResidualProviderDeps,
} from "../../../../adapters/kev/kev-residual-provider.js";
import {
  ConfigValueInvalidError,
  ConfigValueMissingError,
} from "../../../../infra/errors.js";
import type { ResidualModelProvider } from "./types.js";

/** Models `--resolve-residual` / `--model` accept. Wave 1: Kev only. */
export const RESIDUAL_MODELS = ["kev"] as const;

/** The slice of `codegraph.residual` a provider is built from. */
export interface ResidualProviderConfig {
  kevUrls?: readonly string[];
  kevThreshold: number;
}

export class ResidualModelProviderFactory {
  static create(
    model: string,
    config: ResidualProviderConfig,
    deps: KevResidualProviderDeps = {},
  ): ResidualModelProvider {
    switch (model) {
      case "kev": {
        const urls = (config.kevUrls ?? []).filter((url) => url.length > 0);
        if (urls.length === 0) {
          throw new ConfigValueMissingError(
            "codegraph.residual.kevUrls",
            "CODEGRAPH_RESIDUAL_KEV_URL",
          );
        }
        return new KevResidualProvider(
          { urls, threshold: config.kevThreshold },
          deps,
        );
      }
      default:
        throw new ConfigValueInvalidError(
          "residualModel",
          model,
          RESIDUAL_MODELS.join(" | "),
        );
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/adapters/kev/kev-residual-provider.test.ts tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts tests/core/adapters/infra-error-codes.test.ts`
Expected: PASS. `npx tsc --noEmit -p tsconfig.json` clean (proves
`KevResidualProvider` is a `ResidualModelProvider`);
`npx eslint src/core/adapters/kev src/core/domains/trajectory/codegraph/residual`
clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/kev src/core/adapters/errors.ts \
  src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.ts \
  tests/fixtures/kev tests/core/adapters/kev \
  tests/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.test.ts
git commit -m "feat(codegraph): Kev residual provider over /v1/systemone"
```

---

### Task 9: `ResidualResolutionPass`

**Files:**

- Create:
  `src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.ts`
- Test:
  `tests/core/domains/trajectory/codegraph/residual/residual-resolution-pass.test.ts`

**Interfaces:**

- Consumes: `ResidualCallSiteRow`, `ModelEdgeRow`
  (`src/core/contracts/types/codegraph-residual.ts`, Task 1);
  `GraphDbClient#readResidualCallSites/applyModelEdges/markDerivedStale`
  (`src/core/contracts/types/codegraph-storage.ts`, Task 3);
  `ResidualVerdictStore#find/put/touch/expire`, `ResidualVerdictStore.open`
  (`src/core/adapters/duckdb/residual-verdict-store.ts`, Task 5); port types
  from Task 7.
- Produces:
  - `export const DEFAULT_MAX_GROUP_FAILURES = 3`
  - `export interface ResidualPassInput { graphDb: Pick<GraphDbClient, "readResidualCallSites" | "applyModelEdges" | "markDerivedStale">; store: Pick<ResidualVerdictStore, "find" | "put" | "touch" | "expire">; provider: ResidualModelProvider; concurrency: number; menuLimit: number; retentionDays: number; readMethodSource: (relPath: string, startLine: number, endLine: number) => Promise<string>; now: () => number; onProgress?: (progress: { done: number; total: number }) => void; maxGroupFailures?: number }`
  - `export class ResidualResolutionPass { run(input: ResidualPassInput): Promise<ResidualPassReport> }`

Semantics: `asked` counts the deduplicated questions sent this run (failed
groups included); `reused` counts eligible rows answered from the cache; `sites`
counts every current residual row. More than `maxGroupFailures` failed groups
end the pass `skipped` without touching edges; verdicts already stored stay, so
the next run resumes from them. Up to that many failures, the pass completes and
names the first failure in `reason`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import type {
  ModelEdgeRow,
  ResidualCallSiteRow,
} from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import { ResidualResolutionPass } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestion,
  ResidualQuestionGroup,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/types.js";

function row(
  over: Partial<ResidualCallSiteRow> & { siteKey: string },
): ResidualCallSiteRow {
  return {
    sourceRelPath: "app/a.rb",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 5,
    line: 2,
    column: 4,
    receiverText: "firm",
    member: "users",
    kind: "ambiguous",
    candidates: ["Firm#users", "Client#users"],
    menuHash: "menu-1",
    menuOverflow: false,
    ...over,
  };
}

class FakeProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold = 0.7;
  readonly calls: ResidualQuestionGroup[] = [];
  healthy = true;
  failOn = new Set<string>();

  constructor(
    private readonly answer: (q: ResidualQuestion) => {
      pick: string;
      p: number;
    },
  ) {}

  async version(): Promise<string> {
    return "fake@1";
  }

  async health(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.healthy
      ? { ok: true }
      : { ok: false, reason: "connection refused" };
  }

  async resolveGroup(group: ResidualQuestionGroup): Promise<ResidualAnswer[]> {
    this.calls.push(group);
    if (this.failOn.has(group.methodSymbolId))
      throw new Error(`boom ${group.methodSymbolId}`);
    return group.questions.map((q) => {
      const { pick, p } = this.answer(q);
      return {
        siteKey: q.siteKey,
        pick,
        p,
        probabilities: { [pick]: p },
        questionPayload: JSON.stringify(q),
      };
    });
  }
}

function fakeGraphDb(rows: ResidualCallSiteRow[]) {
  const applied: { model: string; edges: ModelEdgeRow[] }[] = [];
  let staleMarks = 0;
  return {
    applied,
    staleMarks: () => staleMarks,
    readResidualCallSites: async () => rows,
    applyModelEdges: async (model: string, edges: ModelEdgeRow[]) => {
      applied.push({ model, edges });
    },
    markDerivedStale: async () => {
      staleMarks++;
    },
  };
}

const firmPick = () => ({ pick: "Firm#users", p: 0.9 });

describe("ResidualResolutionPass", () => {
  let rootDir: string;
  let store: ResidualVerdictStore;
  let sourceReads: string[];

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-pass-"));
    store = await ResidualVerdictStore.open(rootDir, "code_test");
    sourceReads = [];
  });

  afterEach(async () => {
    await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  const run = async (
    graphDb: ReturnType<typeof fakeGraphDb>,
    provider: FakeProvider,
    over: { maxGroupFailures?: number; concurrency?: number } = {},
  ) =>
    new ResidualResolutionPass().run({
      graphDb,
      store,
      provider,
      concurrency: over.concurrency ?? 4,
      menuLimit: 40,
      retentionDays: 180,
      readMethodSource: async (relPath, startLine, endLine) => {
        sourceReads.push(`${relPath}:${startLine}-${endLine}`);
        return `# source of ${relPath}`;
      },
      now: () => 1_000,
      ...(over.maxGroupFailures !== undefined
        ? { maxGroupFailures: over.maxGroupFailures }
        : {}),
    });

  it("ends skipped without reading the graph when the provider is unhealthy", async () => {
    const graphDb = fakeGraphDb([row({ siteKey: "s1" })]);
    const provider = new FakeProvider(firmPick);
    provider.healthy = false;

    const report = await run(graphDb, provider);

    expect(report).toEqual({
      status: "skipped",
      reason: "provider kev unavailable: connection refused",
      sites: 0,
      reused: 0,
      asked: 0,
      applied: 0,
      overflowSkipped: 0,
    });
    expect(provider.calls).toEqual([]);
    expect(graphDb.applied).toEqual([]);
  });

  it("groups questions by enclosing method and drops duplicate questions", async () => {
    const graphDb = fakeGraphDb([
      row({ siteKey: "s1" }),
      row({ siteKey: "s1" }),
      row({ siteKey: "s2", line: 3, receiverText: "client" }),
      row({
        siteKey: "s3",
        sourceRelPath: "app/b.rb",
        methodSymbolId: "B#go",
        methodStartLine: 10,
        methodEndLine: 20,
      }),
    ]);
    const provider = new FakeProvider(firmPick);

    const report = await run(graphDb, provider);

    expect(provider.calls).toHaveLength(2);
    const byMethod = Object.fromEntries(
      provider.calls.map((g) => [g.methodSymbolId, g]),
    );
    expect(byMethod["A#run"].questions.map((q) => q.siteKey)).toEqual([
      "s1",
      "s2",
    ]);
    expect(byMethod["A#run"].methodSource).toBe("# source of app/a.rb");
    expect(byMethod["B#go"].questions.map((q) => q.siteKey)).toEqual(["s3"]);
    expect(sourceReads.sort()).toEqual(["app/a.rb:1-5", "app/b.rb:10-20"]);
    expect(report).toMatchObject({
      status: "completed",
      sites: 4,
      asked: 3,
      reused: 0,
    });
  });

  it("applies only verdicts at or above the provider threshold, then marks derived metrics stale", async () => {
    const graphDb = fakeGraphDb([
      row({ siteKey: "sure" }),
      row({ siteKey: "unsure", line: 4 }),
    ]);
    const provider = new FakeProvider((q) =>
      q.siteKey === "sure"
        ? { pick: "Firm#users", p: 0.7 }
        : { pick: "Client#users", p: 0.5 },
    );

    const report = await run(graphDb, provider);

    expect(graphDb.applied).toEqual([
      {
        model: "kev",
        edges: [
          {
            siteKey: "sure",
            sourceRelPath: "app/a.rb",
            sourceSymbolId: "A#run",
            targetSymbolId: "Firm#users",
            model: "kev",
            p: 0.7,
          },
        ],
      },
    ]);
    expect(graphDb.staleMarks()).toBe(1);
    expect(report).toMatchObject({ status: "completed", applied: 1 });
  });

  it("reuses cached verdicts for the same site, menu and model version", async () => {
    const rows = [row({ siteKey: "s1" }), row({ siteKey: "s2", line: 3 })];
    const provider = new FakeProvider(firmPick);
    await run(fakeGraphDb(rows), provider);

    const second = fakeGraphDb(rows);
    const report = await run(second, provider);

    expect(provider.calls).toHaveLength(1);
    expect(report).toEqual({
      status: "completed",
      sites: 2,
      reused: 2,
      asked: 0,
      applied: 2,
      overflowSkipped: 0,
    });
    expect(second.applied[0].edges.map((e) => e.siteKey)).toEqual(["s1", "s2"]);
  });

  it("asks again when the menu changed", async () => {
    const provider = new FakeProvider(firmPick);
    await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);

    await run(
      fakeGraphDb([
        row({
          siteKey: "s1",
          menuHash: "menu-2",
          candidates: ["Firm#users", "User#users"],
        }),
      ]),
      provider,
    );

    expect(provider.calls).toHaveLength(2);
  });

  it("skips sites whose menu overflowed", async () => {
    const graphDb = fakeGraphDb([
      row({ siteKey: "s1" }),
      row({ siteKey: "s2", menuOverflow: true }),
    ]);
    const provider = new FakeProvider(firmPick);

    const report = await run(graphDb, provider);

    expect(
      provider.calls.flatMap((g) => g.questions.map((q) => q.siteKey)),
    ).toEqual(["s1"]);
    expect(report).toMatchObject({
      sites: 2,
      asked: 1,
      overflowSkipped: 1,
      applied: 1,
    });
  });

  it("keeps the verdicts of groups that answered when one group throws, and resumes with the rest", async () => {
    const rows = [
      row({ siteKey: "s1" }),
      row({ siteKey: "s3", sourceRelPath: "app/b.rb", methodSymbolId: "B#go" }),
    ];
    const provider = new FakeProvider(firmPick);
    provider.failOn.add("B#go");

    const first = await run(fakeGraphDb(rows), provider);
    expect(first).toMatchObject({
      status: "completed",
      applied: 1,
      reason: "1 group(s) failed: boom B#go",
    });

    provider.failOn.clear();
    provider.calls.length = 0;
    const second = await run(fakeGraphDb(rows), provider);

    expect(provider.calls.map((g) => g.methodSymbolId)).toEqual(["B#go"]);
    expect(second).toMatchObject({
      status: "completed",
      reused: 1,
      asked: 1,
      applied: 2,
    });
  });

  it("ends skipped and leaves edges alone when more groups fail than allowed", async () => {
    const rows = ["A#a", "A#b", "A#c"].map((method, i) =>
      row({ siteKey: `s${i}`, methodSymbolId: method }),
    );
    const graphDb = fakeGraphDb(rows);
    const provider = new FakeProvider(firmPick);
    for (const method of ["A#a", "A#b", "A#c"]) provider.failOn.add(method);

    const report = await run(graphDb, provider, {
      maxGroupFailures: 1,
      concurrency: 1,
    });

    expect(report.status).toBe("skipped");
    expect(report.reason).toMatch(/^2 group\(s\) failed: boom A#/);
    expect(provider.calls).toHaveLength(2);
    expect(graphDb.applied).toEqual([]);
    expect(graphDb.staleMarks()).toBe(0);
  });

  it("reports progress per finished group", async () => {
    const graphDb = fakeGraphDb([
      row({ siteKey: "s1" }),
      row({ siteKey: "s3", sourceRelPath: "app/b.rb", methodSymbolId: "B#go" }),
    ]);
    const progress: { done: number; total: number }[] = [];

    await new ResidualResolutionPass().run({
      graphDb,
      store,
      provider: new FakeProvider(firmPick),
      concurrency: 1,
      menuLimit: 40,
      retentionDays: 180,
      readMethodSource: async () => "",
      now: () => 1_000,
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/residual/residual-resolution-pass.test.ts`
Expected: FAIL — `residual-resolution-pass.js` does not exist.

- [ ] **Step 3: Implement**

`src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.ts`:

```ts
/**
 * Asks a residual model about the call sites the static resolver left open,
 * caches every verdict, and applies the confident ones as `origin: "model"`
 * edges. A provider that is down or keeps failing ends the pass `skipped`;
 * the graph then stays exactly what static resolution produced.
 */

import type { ResidualVerdictStore } from "../../../../adapters/duckdb/residual-verdict-store.js";
import type {
  ModelEdgeRow,
  ResidualCallSiteRow,
} from "../../../../contracts/types/codegraph-residual.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualPassReport,
  ResidualQuestion,
  ResidualVerdict,
} from "./types.js";

export const DEFAULT_MAX_GROUP_FAILURES = 3;

export interface ResidualPassInput {
  graphDb: Pick<
    GraphDbClient,
    "readResidualCallSites" | "applyModelEdges" | "markDerivedStale"
  >;
  store: Pick<ResidualVerdictStore, "find" | "put" | "touch" | "expire">;
  provider: ResidualModelProvider;
  concurrency: number;
  menuLimit: number;
  retentionDays: number;
  readMethodSource: (
    relPath: string,
    startLine: number,
    endLine: number,
  ) => Promise<string>;
  now: () => number;
  onProgress?: (progress: { done: number; total: number }) => void;
  maxGroupFailures?: number;
}

interface PendingGroup {
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  questions: ResidualQuestion[];
}

const verdictKey = (siteKey: string, menuHash: string): string =>
  `${siteKey}\u0000${menuHash}`;

export class ResidualResolutionPass {
  async run(input: ResidualPassInput): Promise<ResidualPassReport> {
    const { provider } = input;
    const health = await provider.health();
    if (!health.ok)
      return emptyReport(
        `provider ${provider.id} unavailable: ${health.reason}`,
      );

    await input.store.expire(input.retentionDays, input.now());
    const rows = await input.graphDb.readResidualCallSites();
    const eligible = rows.filter(
      (r) => !r.menuOverflow && r.candidates.length <= input.menuLimit,
    );
    const overflowSkipped = rows.length - eligible.length;
    const modelVersion = await provider.version();

    const verdicts = new Map<string, ResidualVerdict>();
    const cached = await input.store.find(
      eligible.map((r) => ({
        siteKey: r.siteKey,
        menuHash: r.menuHash,
        modelVersion,
      })),
    );
    for (const verdict of cached) {
      if (verdict.model === provider.id)
        verdicts.set(verdictKey(verdict.siteKey, verdict.menuHash), verdict);
    }
    const reusedRows = eligible.filter((r) =>
      verdicts.has(verdictKey(r.siteKey, r.menuHash)),
    );
    if (reusedRows.length > 0) {
      await input.store.touch(
        [...new Set(reusedRows.map((r) => r.siteKey))],
        provider.id,
        input.now(),
      );
    }

    const groups = groupQuestions(
      eligible.filter((r) => !verdicts.has(verdictKey(r.siteKey, r.menuHash))),
    );
    const asked = groups.reduce((n, g) => n + g.questions.length, 0);
    const failures = await this.askGroups(
      groups,
      modelVersion,
      verdicts,
      input,
    );
    const maxFailures = input.maxGroupFailures ?? DEFAULT_MAX_GROUP_FAILURES;
    const counts = {
      sites: rows.length,
      reused: reusedRows.length,
      asked,
      overflowSkipped,
    };
    const failureReason =
      failures.length > 0
        ? `${failures.length} group(s) failed: ${failures[0]}`
        : undefined;
    if (failures.length > maxFailures) {
      return {
        status: "skipped",
        reason: failureReason,
        ...counts,
        applied: 0,
      };
    }

    const edges = buildEdges(eligible, verdicts, provider);
    await input.graphDb.applyModelEdges(provider.id, edges);
    await input.graphDb.markDerivedStale();
    return {
      status: "completed",
      ...(failureReason !== undefined ? { reason: failureReason } : {}),
      ...counts,
      applied: edges.length,
    };
  }

  /** Pool of `concurrency` workers; each group's verdicts are stored as soon as it answers. */
  private async askGroups(
    groups: PendingGroup[],
    modelVersion: string,
    verdicts: Map<string, ResidualVerdict>,
    input: ResidualPassInput,
  ): Promise<string[]> {
    const failures: string[] = [];
    const maxFailures = input.maxGroupFailures ?? DEFAULT_MAX_GROUP_FAILURES;
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (next < groups.length && failures.length <= maxFailures) {
        const group = groups[next++];
        try {
          const methodSource = await input.readMethodSource(
            group.sourceRelPath,
            group.methodStartLine,
            group.methodEndLine,
          );
          const answers = await input.provider.resolveGroup({
            sourceRelPath: group.sourceRelPath,
            methodSymbolId: group.methodSymbolId,
            methodSource,
            questions: group.questions,
          });
          const fresh = toVerdicts(
            group.questions,
            answers,
            input.provider.id,
            modelVersion,
            input.now(),
          );
          await input.store.put(fresh);
          for (const verdict of fresh)
            verdicts.set(
              verdictKey(verdict.siteKey, verdict.menuHash),
              verdict,
            );
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        done++;
        input.onProgress?.({ done, total: groups.length });
      }
    };
    const workers = Math.max(1, Math.min(input.concurrency, groups.length));
    await Promise.all(Array.from({ length: workers }, async () => worker()));
    return failures;
  }
}

function emptyReport(reason: string): ResidualPassReport {
  return {
    status: "skipped",
    reason,
    sites: 0,
    reused: 0,
    asked: 0,
    applied: 0,
    overflowSkipped: 0,
  };
}

/** One group per enclosing method; a site asked twice with the same menu is asked once. */
function groupQuestions(rows: ResidualCallSiteRow[]): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  const seen = new Set<string>();
  for (const r of rows) {
    const key = verdictKey(r.siteKey, r.menuHash);
    if (seen.has(key)) continue;
    seen.add(key);
    const groupKey = `${r.sourceRelPath}\u0000${r.methodSymbolId}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        sourceRelPath: r.sourceRelPath,
        methodSymbolId: r.methodSymbolId,
        methodStartLine: r.methodStartLine,
        methodEndLine: r.methodEndLine,
        questions: [],
      };
      groups.set(groupKey, group);
    }
    group.questions.push({
      siteKey: r.siteKey,
      menuHash: r.menuHash,
      receiverText: r.receiverText,
      member: r.member,
      kind: r.kind,
      candidates: r.candidates,
    });
  }
  return [...groups.values()];
}

function toVerdicts(
  questions: ResidualQuestion[],
  answers: ResidualAnswer[],
  model: string,
  modelVersion: string,
  now: number,
): ResidualVerdict[] {
  const bySite = new Map(questions.map((q) => [q.siteKey, q]));
  const verdicts: ResidualVerdict[] = [];
  for (const answer of answers) {
    const question = bySite.get(answer.siteKey);
    if (!question || !question.candidates.includes(answer.pick)) continue;
    verdicts.push({
      siteKey: answer.siteKey,
      menuHash: question.menuHash,
      model,
      modelVersion,
      pick: answer.pick,
      p: answer.p,
      probabilities: answer.probabilities,
      questionPayload: answer.questionPayload,
      createdAt: now,
      lastSeenAt: now,
    });
  }
  return verdicts;
}

function buildEdges(
  rows: ResidualCallSiteRow[],
  verdicts: Map<string, ResidualVerdict>,
  provider: ResidualModelProvider,
): ModelEdgeRow[] {
  const edges: ModelEdgeRow[] = [];
  const emitted = new Set<string>();
  for (const r of rows) {
    const key = verdictKey(r.siteKey, r.menuHash);
    const verdict = verdicts.get(key);
    if (!verdict || emitted.has(key)) continue;
    if (verdict.p < provider.threshold || !r.candidates.includes(verdict.pick))
      continue;
    emitted.add(key);
    edges.push({
      siteKey: r.siteKey,
      sourceRelPath: r.sourceRelPath,
      sourceSymbolId: r.methodSymbolId,
      targetSymbolId: verdict.pick,
      model: provider.id,
      p: verdict.p,
    });
  }
  return edges;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/residual/residual-resolution-pass.test.ts`
Expected: PASS (10 tests). `npx tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.ts \
  tests/core/domains/trajectory/codegraph/residual/residual-resolution-pass.test.ts
git commit -m "feat(codegraph): residual resolution pass with cached verdicts and resumable groups"
```

---

### Task 10: `resolving-residual` progress phase

`src/core/types.ts` is a hub (transitiveImpact 215): this task touches only the
`ProgressUpdate.phase` union. The worker forwards every `ProgressUpdate` as an
`embedding`-typed IPC message (`worker.ts:117-127`); `isWorkerMessage` accepts
any string `phase` (`ipc-protocol.ts:80-85, 103-104`), so the protocol needs no
code change — the test pins that it accepts the new phase. The renderer gives
the phase its own bar instead of folding it into the embeddings bar.

The residual pass runs while the collection is still held after enrichment (Task
11), so its updates arrive before `whenEnrichmentComplete()` resolves; the
worker measures the phase from its first to its last update and reports
`phase-done` for it after the enrichment `phase-done`.

**Files:**

- Modify: `src/core/types.ts:546-556` (`ProgressUpdate.phase`)
- Modify: `src/cli/index-progress/worker.ts:107-205` (`runIndexWorker`)
- Modify: `src/cli/index-progress/renderer.ts` (`formatProgressLine` ~165; the
  `case "embedding"` dispatch ~346; `markPhaseBarsDone` ~614; new
  `renderResidualBar`)
- Test: `tests/cli/index-progress/ipc-protocol.test.ts`
- Test: `tests/cli/index-progress/renderer.test.ts`
- Test: `tests/cli/index-progress/worker.test.ts`

**Interfaces:**

- Produces: `ProgressUpdate.phase` includes `"resolving-residual"`; renderer bar
  key `"residual"` labelled `residual resolution`; worker message
  `{ type: "phase-done", phase: "resolving-residual", elapsedMs }`.

- [ ] **Step 1: Write the failing tests**

`tests/cli/index-progress/ipc-protocol.test.ts` — add inside
`describe("isWorkerMessage", ...)`:

```ts
it("accepts residual-resolution progress and its phase-done", () => {
  expect(
    isWorkerMessage({
      type: "embedding",
      phase: "resolving-residual",
      percentage: 50,
      current: 1,
      total: 2,
    }),
  ).toBe(true);
  expect(
    isWorkerMessage({
      type: "phase-done",
      phase: "resolving-residual",
      elapsedMs: 1200,
    }),
  ).toBe(true);
});
```

`tests/cli/index-progress/renderer.test.ts` — add inside
`describe("formatProgressLine", ...)`:

```ts
it("labels residual-resolution progress as its own line", () => {
  const line = formatProgressLine({
    type: "embedding",
    phase: "resolving-residual",
    percentage: 25,
    current: 3,
    total: 12,
  });
  expect(line).toBe(`${"residual resolution".padEnd(22)}3/12 (25%)`);
});
```

and inside `describe("TtyProgressRenderer — phase-done inline", ...)`:

```ts
it("draws residual resolution on its own bar and closes only that bar on its phase-done", () => {
  const r = new TtyProgressRenderer(colors);
  r.handle({
    type: "embedding",
    phase: "embedding",
    percentage: 100,
    current: 10,
    total: 10,
  });
  r.handle({
    type: "enrichment",
    providerKey: "git",
    level: "file",
    applied: 2,
    total: 2,
  });
  r.handle({
    type: "embedding",
    phase: "resolving-residual",
    percentage: 50,
    current: 1,
    total: 2,
  });

  const { barStates } = r as unknown as {
    barStates: Map<string, { done: boolean; value: number; total: number }>;
  };
  expect(barStates.get("residual")).toMatchObject({
    value: 1,
    total: 2,
    done: false,
  });
  expect(barStates.get("embedding")?.value).toBe(10);

  r.handle({ type: "phase-done", phase: "enrichment", elapsedMs: 100 });
  expect(barStates.get("residual")?.done).toBe(false);

  r.handle({ type: "phase-done", phase: "resolving-residual", elapsedMs: 900 });
  expect(barStates.get("residual")?.done).toBe(true);
});
```

`tests/cli/index-progress/worker.test.ts` — add inside
`describe("runIndexWorker", ...)`:

```ts
it("reports the residual-resolution phase after enrichment, timed from its first to its last update", async () => {
  let clock = 0;
  const app = {
    indexCodebase: vi.fn(async (_path, _opts, progress) => {
      progress?.({
        phase: "embedding",
        current: 5,
        total: 5,
        percentage: 100,
        message: "",
      });
      return { status: "completed" };
    }),
    getIndexStatus: vi.fn().mockResolvedValue(healthy),
    whenEnrichmentComplete: vi.fn(async () => {
      const progress = app.indexCodebase.mock.calls[0][2] as (
        p: unknown,
      ) => void;
      clock = 100;
      progress({
        phase: "resolving-residual",
        current: 1,
        total: 2,
        percentage: 50,
        message: "",
      });
      clock = 1_300;
      progress({
        phase: "resolving-residual",
        current: 2,
        total: 2,
        percentage: 100,
        message: "",
      });
    }),
  };
  const sent: WorkerMessage[] = [];

  await runIndexWorker(
    app as never,
    "/repo",
    {},
    (m) => sent.push(m),
    () => clock,
  );

  const phases = sent.filter((m) => m.type === "phase-done");
  expect(phases.map((m) => m.phase)).toEqual([
    "embedding",
    "enrichment",
    "resolving-residual",
  ]);
  expect(phases[2]).toEqual({
    type: "phase-done",
    phase: "resolving-residual",
    elapsedMs: 1_200,
  });
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "embedding",
      phase: "resolving-residual",
      current: 2,
      total: 2,
    }),
  );
});
```

(The options are `{}` here because `IndexOptions.resolveResidual` lands in Task
11, which switches this call to `{ resolveResidual: "kev" }`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`npx vitest run tests/cli/index-progress/ipc-protocol.test.ts tests/cli/index-progress/renderer.test.ts tests/cli/index-progress/worker.test.ts`
Expected: the ipc test PASSES already (the protocol accepts any string phase —
it pins behaviour); the renderer tests FAIL (label is `embedding`, no `residual`
bar); the worker test FAILS (no `resolving-residual` phase-done).

- [ ] **Step 3: Implement**

`src/core/types.ts` — in `ProgressUpdate`:

```ts
/**
 * Canonical phases:
 * - `scanning`  — file discovery
 * - `chunking`  — files parsed and queued (current=filesProcessed, total=files.length)
 * - `embedding` — chunks embedded by the pipeline (current=itemsProcessed, total=chunksQueued)
 * - `storing`   — finalization
 * - `enriching` — git/static enrichment
 * - `resolving-residual` — model verdicts for residual call sites (current/total = methods asked)
 */
phase: "scanning" |
  "chunking" |
  "embedding" |
  "storing" |
  "enriching" |
  "resolving-residual";
```

`src/cli/index-progress/worker.ts` — in `runIndexWorker`, declare before
`const embeddingStart = now();`:

```ts
// The residual pass runs while the collection is held after enrichment, so
// its updates arrive inside whenEnrichmentComplete(); time it on its own.
let residualFirstMs: number | undefined;
let residualLastMs: number | undefined;
```

replace the progress callback head

```ts
    (p) => {
      send({
```

with

```ts
    (p) => {
      if (p.phase === "resolving-residual") {
        residualFirstMs ??= now();
        residualLastMs = now();
      }
      send({
```

and directly after the enrichment
`send({ type: "phase-done", phase: "enrichment", ... });` add:

```ts
if (residualFirstMs !== undefined && residualLastMs !== undefined) {
  send({
    type: "phase-done",
    phase: "resolving-residual",
    elapsedMs: residualLastMs - residualFirstMs,
  });
}
```

`src/cli/index-progress/renderer.ts`:

1. Under `const LABEL_WIDTH = 22;` add:

```ts
/** Bar key and label of the residual-resolution phase (its own bar, not the embeddings one). */
const RESIDUAL_BAR_KEY = "residual";
const RESIDUAL_LABEL = "residual resolution";
const RESIDUAL_PHASE = "resolving-residual";
```

2. In `formatProgressLine`, `case "embedding"`, replace
   `const label = "embedding".padEnd(LABEL_WIDTH);` with

```ts
const label = (
  message.phase === RESIDUAL_PHASE ? RESIDUAL_LABEL : "embedding"
).padEnd(LABEL_WIDTH);
```

3. In `TtyProgressRenderer#handle`, replace the `case "embedding":` body
   `this.renderEmbeddingBar(message);` with

```ts
if (message.phase === RESIDUAL_PHASE) this.renderResidualBar(message);
else this.renderEmbeddingBar(message);
```

4. In `markPhaseBarsDone`, replace the `if/else` that sets `keysToMark` with

```ts
if (message.phase === "embedding") {
  keysToMark = ["embedding"];
} else if (message.phase === RESIDUAL_PHASE) {
  keysToMark = [RESIDUAL_BAR_KEY];
} else {
  // all enrichment bars
  keysToMark = [...this.barStates.keys()].filter(
    (k) => k !== "embedding" && k !== RESIDUAL_BAR_KEY,
  );
}
```

5. Add the method after `renderEmbeddingBar` (the bar-state literal mirrors the
   one `renderEmbeddingBar` creates at ~521-536; keep the two in step if that
   shape gains a field):

```ts
  /** Residual resolution: one determinate bar, methods asked / methods to ask. */
  private renderResidualBar(message: WorkerMessageOf<"embedding">): void {
    const label = this.colors.brand(RESIDUAL_LABEL.padEnd(LABEL_WIDTH));
    let state = this.barStates.get(RESIDUAL_BAR_KEY);
    if (!state) {
      const bar = this.multibar.create(message.total, 0, {
        label,
        rate: "",
        eta: "",
        elapsed: "",
        totalFinal: true,
      });
      state = {
        bar,
        startMs: this.now(),
        value: 0,
        total: message.total,
        label,
        rate: "",
        done: false,
        etaBaseSeconds: null,
        etaBaseAtMs: this.now(),
        totalFinal: true,
      };
      this.barStates.set(RESIDUAL_BAR_KEY, state);
      this.startTickIfNeeded();
    }
    const nowMs = this.now();
    state.total = message.total;
    state.value = Math.min(message.current, message.total);
    state.etaBaseSeconds = computeEtaSeconds(state.value, state.total, nowMs - state.startMs);
    state.etaBaseAtMs = nowMs;
    state.bar.setTotal(message.total);
    state.bar.update(state.value, { label, rate: "", eta: "", elapsed: "", totalFinal: true });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cli/index-progress/` Expected: PASS.
`npx tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/cli/index-progress/worker.ts src/cli/index-progress/renderer.ts \
  tests/cli/index-progress/ipc-protocol.test.ts tests/cli/index-progress/renderer.test.ts \
  tests/cli/index-progress/worker.test.ts
git commit -m "feat(cli): resolving-residual progress phase with its own bar"
```

---

### Task 11: `index-codebase --resolve-residual <model>`

Where the pass runs: `IndexingOps#run` returns once embeddings and the alias are
done; codegraph enrichment keeps running in the background, and the collection's
`IndexingLock` stays held until `releaseCollectionWhenEnrichmentSettles`
(`src/core/api/internal/ops/indexing-ops.ts:595-612`) has seen
`enrichment.whenCompletionsSettled(physical)` and the trailing enrichment. That
is the one point where embeddings, codegraph enrichment and its
collection-completion finalize are all done and the lock is still held — so the
pass runs there, not inside `IndexPipeline`/`ReindexPipeline`
(`ingest/operations/indexing.ts`, `reindexing.ts`), which return before
enrichment completes. `whenEnrichmentComplete()` already awaits
`pendingCollectionReleases`, so the CLI worker stays alive through the pass.

`ResidualResolutionOps` (api/internal) owns everything the pass needs from
outside the domain: the codegraph root (verdict store path), the pool's write
handle, the config, the method-source reader. It never throws: every failure
becomes a `skipped` report.

**Files:**

- Create: `src/core/api/internal/ops/residual-resolution-ops.ts`
- Modify: `src/core/api/index.ts` (export next to `WorktreeOps`, line ~87)
- Modify: `src/core/api/public/dto/ingest.ts:34-50`
  (`IndexOptions.resolveResidual`)
- Modify: `src/core/types.ts:75-90` (`IndexOptions.resolveResidual`, mirror)
- Modify: `src/core/api/internal/ops/indexing-ops.ts` (`IndexingOpsDeps`
  ~95-131; constructor ~331; `run` ~381-404;
  `releaseCollectionWhenEnrichmentSettles` ~595-612)
- Modify: `src/core/api/internal/facades/ingest-facade.ts` (`IngestFacadeDeps`
  ~65-125; `new IndexingOps({...})` ~200-245)
- Modify: `src/bootstrap/factory.ts` (`CodegraphContext` ~444; `wireCodegraph`
  return; `IngestSliceDeps` ~1105; `createIngestFacade` ~1178; `ingestSlice`
  ~1647)
- Modify: `src/cli/commands/index-codebase.ts` (`IndexCodebaseArgs` ~22-45;
  `buildIndexOptions` ~151-166; `.option(...)` after `force-enrichments` ~245)
- Test: `tests/core/api/internal/ops/residual-resolution-ops.test.ts`
- Test: `tests/core/api/internal/ops/indexing-ops-residual.test.ts`
- Test: `tests/cli/index-codebase-resolve-residual.test.ts`
- Modify: `tests/cli/index-progress/worker.test.ts` (Task 10's test: `{}` →
  `{ resolveResidual: "kev" }`)

**Interfaces:**

- Consumes: `ResidualResolutionPass` (Task 9), `ResidualModelProviderFactory`
  (Task 8), `ResidualVerdictStore.open` (Task 5),
  `GraphDbClientPool#acquireWrite(physical): Promise<CollectionGraphHandle>`
  (`src/core/adapters/duckdb/pool.ts:564`), `resolvePhysicalCollection`
  (`domains/ingest/operations/index.js`), `validatePath`
  (`infra/collection-name.js`).
- Produces:
  - `IndexOptions.resolveResidual?: string`
  - `export interface ResidualResolutionConfig { kevUrls?: readonly string[]; kevThreshold: number; concurrency: number; menuLimit: number; retentionDays: number }`
  - `export interface ResidualResolveRequest { logicalName: string; physicalCollectionName: PhysicalCollectionName; projectRoot: string; model: string; onProgress?: ProgressCallback }`
  - `export class ResidualResolutionOps { constructor(deps: ResidualResolutionOpsDeps); resolve(request: ResidualResolveRequest): Promise<ResidualPassReport> }`
  - `IndexingOpsDeps.residualResolution?: Pick<ResidualResolutionOps, "resolve">`
  - `IngestFacadeDeps.residualResolution?: ResidualResolutionOps`
  - CLI flag `--resolve-residual <model>`

- [ ] **Step 1: Write the failing tests**

`tests/core/api/internal/ops/residual-resolution-ops.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResidualResolutionOps } from "../../../../../src/core/api/internal/ops/residual-resolution-ops.js";
import type {
  ModelEdgeRow,
  ResidualCallSiteRow,
} from "../../../../../src/core/contracts/types/codegraph-residual.js";
import type { PhysicalCollectionName } from "../../../../../src/core/contracts/types/collection-identity.js";
import type {
  ResidualModelProvider,
  ResidualQuestionGroup,
} from "../../../../../src/core/domains/trajectory/codegraph/residual/types.js";
import type { ProgressUpdate } from "../../../../../src/core/types.js";

const PHYSICAL = "code_test_v1" as PhysicalCollectionName;

const ROW: ResidualCallSiteRow = {
  siteKey: "s1",
  sourceRelPath: "app/sync.rb",
  methodSymbolId: "Sync#run",
  methodStartLine: 2,
  methodEndLine: 4,
  line: 3,
  column: 2,
  receiverText: "firm",
  member: "users",
  kind: "ambiguous",
  candidates: ["Firm#users", "Client#users"],
  menuHash: "m1",
  menuOverflow: false,
};

const CONFIG = {
  kevUrls: ["http://gpu:8090"],
  kevThreshold: 0.7,
  concurrency: 4,
  menuLimit: 40,
  retentionDays: 180,
};

function provider(groups: ResidualQuestionGroup[]): ResidualModelProvider {
  return {
    id: "kev",
    threshold: 0.7,
    version: async () => "fake@1",
    health: async () => ({ ok: true }),
    resolveGroup: async (group) => {
      groups.push(group);
      return group.questions.map((q) => ({
        siteKey: q.siteKey,
        pick: "Firm#users",
        p: 0.9,
        probabilities: { "Firm#users": 0.9 },
        questionPayload: "{}",
      }));
    },
  };
}

describe("ResidualResolutionOps", () => {
  let rootDir: string;
  let projectRoot: string;
  let applied: ModelEdgeRow[][];
  const pool = {
    acquireWrite: async () => ({
      graphDb: {
        readResidualCallSites: async () => [ROW],
        applyModelEdges: async (_model: string, edges: ModelEdgeRow[]) => {
          applied.push(edges);
        },
        markDerivedStale: async () => undefined,
      },
      symbolTable: {},
    }),
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-ops-root-"));
    projectRoot = mkdtempSync(join(tmpdir(), "residual-ops-project-"));
    mkdirSync(join(projectRoot, "app"));
    writeFileSync(
      join(projectRoot, "app/sync.rb"),
      "class Sync\n  def run(firm)\n    firm.users\n  end\nend\n",
    );
    applied = [];
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("runs the pass on the collection's graph with the method's source lines and reports progress as resolving-residual", async () => {
    const groups: ResidualQuestionGroup[] = [];
    const progress: ProgressUpdate[] = [];
    const ops = new ResidualResolutionOps({
      rootDir,
      codegraphPool: pool as never,
      config: CONFIG,
      createProvider: () => provider(groups),
    });

    const report = await ops.resolve({
      logicalName: "code_test",
      physicalCollectionName: PHYSICAL,
      projectRoot,
      model: "kev",
      onProgress: (p) => progress.push(p),
    });

    expect(report).toEqual({
      status: "completed",
      sites: 1,
      reused: 0,
      asked: 1,
      applied: 1,
      overflowSkipped: 0,
    });
    expect(groups[0].methodSource).toBe(
      "  def run(firm)\n    firm.users\n  end",
    );
    expect(applied[0].map((e) => e.targetSymbolId)).toEqual(["Firm#users"]);
    expect(progress.at(-1)).toMatchObject({
      phase: "resolving-residual",
      current: 1,
      total: 1,
      percentage: 100,
    });
  });

  it("keeps verdicts in <rootDir>/residual-verdicts/<logicalName>.duckdb across runs", async () => {
    const groups: ResidualQuestionGroup[] = [];
    const ops = new ResidualResolutionOps({
      rootDir,
      codegraphPool: pool as never,
      config: CONFIG,
      createProvider: () => provider(groups),
    });
    const request = {
      logicalName: "code_test",
      physicalCollectionName: PHYSICAL,
      projectRoot,
      model: "kev",
    };

    await ops.resolve(request);
    const second = await ops.resolve(request);

    expect(groups).toHaveLength(1);
    expect(second).toMatchObject({ reused: 1, asked: 0, applied: 1 });
  });

  it("turns an unknown model into a skipped report instead of throwing", async () => {
    const ops = new ResidualResolutionOps({
      rootDir,
      codegraphPool: pool as never,
      config: CONFIG,
    });

    const report = await ops.resolve({
      logicalName: "code_test",
      physicalCollectionName: PHYSICAL,
      projectRoot,
      model: "gpt-9",
    });

    expect(report.status).toBe("skipped");
    expect(report.reason).toMatch(/residualModel/);
  });
});
```

`tests/core/api/internal/ops/indexing-ops-residual.test.ts` (harness copied from
`indexing-ops-concurrent-run.test.ts:24-77`):

```ts
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  IndexingOps,
  type IndexingOpsDeps,
} from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import { resolveCollectionName } from "../../../../../src/core/infra/collection-name.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const ALIAS = resolveCollectionName(resolve("/repo"));

const changeStats: ChangeStats = {
  filesAdded: 0,
  filesModified: 0,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 0,
  chunksDeleted: 0,
  durationMs: 5,
  status: "completed",
};

const SKIPPED = {
  status: "skipped" as const,
  sites: 0,
  reused: 0,
  asked: 0,
  applied: 0,
  overflowSkipped: 0,
};

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return { open, opened };
}

function makeDeps(
  overrides: Partial<IndexingOpsDeps>,
  settled: Promise<void>,
  order: string[],
): IndexingOpsDeps {
  const readPoint = async () => Promise.resolve(null);
  return {
    qdrant: {
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      listCollections: vi.fn().mockResolvedValue([]),
      getPoint: vi.fn(readPoint),
      getPointOrThrow: vi.fn(readPoint),
    } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn() } as never,
    reindex: {
      reindexChanges: vi.fn().mockResolvedValue(changeStats),
    } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn(async () => {
        await settled;
        order.push("enrichment-settled");
      }),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    ...overrides,
  };
}

describe("IndexingOps — residual resolution after enrichment", () => {
  it("runs the residual pass only after codegraph enrichment settled, still holding the collection", async () => {
    const settled = gate();
    const order: string[] = [];
    const progress = vi.fn();
    const residualResolve = vi.fn(async () => {
      order.push("residual");
      return SKIPPED;
    });
    const ops = new IndexingOps(
      makeDeps(
        { residualResolution: { resolve: residualResolve } },
        settled.opened,
        order,
      ),
    );

    await ops.run("/repo", { resolveResidual: "kev" }, progress);
    expect(order).toEqual([]);

    settled.open();
    await ops.whenEnrichmentComplete();

    expect(order).toEqual(["enrichment-settled", "residual"]);
    expect(residualResolve).toHaveBeenCalledWith({
      logicalName: ALIAS,
      physicalCollectionName: ALIAS,
      projectRoot: resolve("/repo"),
      model: "kev",
      onProgress: progress,
    });
  });

  it("does not run the pass without --resolve-residual", async () => {
    const settled = gate();
    settled.open();
    const residualResolve = vi.fn(async () => SKIPPED);
    const ops = new IndexingOps(
      makeDeps(
        { residualResolution: { resolve: residualResolve } },
        settled.opened,
        [],
      ),
    );

    await ops.run("/repo");
    await ops.whenEnrichmentComplete();

    expect(residualResolve).not.toHaveBeenCalled();
  });

  it("releases the collection even when the pass rejects", async () => {
    const settled = gate();
    settled.open();
    const residualResolve = vi.fn(async () => {
      throw new Error("duckdb gone");
    });
    const ops = new IndexingOps(
      makeDeps(
        { residualResolution: { resolve: residualResolve } },
        settled.opened,
        [],
      ),
    );

    await ops.run("/repo", { resolveResidual: "kev" });
    await expect(ops.whenEnrichmentComplete()).resolves.toBeUndefined();

    await expect(ops.run("/repo")).resolves.toBeDefined();
  });
});
```

`tests/cli/index-codebase-resolve-residual.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import yargs from "yargs";

import {
  buildIndexOptions,
  indexCodebaseCommand,
} from "../../src/cli/commands/index-codebase.js";

function parse(argv: string[]): Record<string, unknown> {
  let failure: string | undefined;
  const parsed = yargs([])
    .command({ ...indexCodebaseCommand, handler: () => undefined })
    .exitProcess(false)
    .fail((msg: string) => {
      failure = msg;
    })
    .parse(argv) as Record<string, unknown>;
  if (failure !== undefined) throw new Error(failure);
  return parsed;
}

describe("index-codebase --resolve-residual", () => {
  it("carries the model into IndexOptions", () => {
    const argv = parse(["index-codebase", "--resolve-residual", "kev"]);

    expect(buildIndexOptions(argv as never)).toMatchObject({
      resolveResidual: "kev",
    });
  });

  it("leaves IndexOptions without the key when the flag is absent", () => {
    const argv = parse(["index-codebase"]);

    expect(buildIndexOptions(argv as never)).not.toHaveProperty(
      "resolveResidual",
    );
  });

  it("refuses a model outside the supported list", () => {
    expect(() =>
      parse(["index-codebase", "--resolve-residual", "gpt-9"]),
    ).toThrow(/Invalid values/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/api/internal/ops/residual-resolution-ops.test.ts tests/core/api/internal/ops/indexing-ops-residual.test.ts tests/cli/index-codebase-resolve-residual.test.ts`
Expected: FAIL — `residual-resolution-ops.js` missing; `residualResolution` is
not an `IndexingOpsDeps` key and is never called; `--resolve-residual` unknown.

- [ ] **Step 3: Implement**

`src/core/api/internal/ops/residual-resolution-ops.ts`:

```ts
/**
 * Runs the residual resolution pass against one collection generation: opens
 * the per-project verdict store, takes the graph's write handle, builds the
 * provider and reads method sources from the working tree. Never throws — a
 * failure of any of those ends the pass `skipped`, and indexing carries on.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import { ResidualVerdictStore } from "../../../adapters/duckdb/residual-verdict-store.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { ResidualModelProviderFactory } from "../../../domains/trajectory/codegraph/residual/residual-model-provider-factory.js";
import { ResidualResolutionPass } from "../../../domains/trajectory/codegraph/residual/residual-resolution-pass.js";
import type {
  ResidualModelProvider,
  ResidualPassReport,
} from "../../../domains/trajectory/codegraph/residual/types.js";
import type { ProgressCallback } from "../../../types.js";

export interface ResidualResolutionConfig {
  kevUrls?: readonly string[];
  kevThreshold: number;
  concurrency: number;
  menuLimit: number;
  retentionDays: number;
}

type VerdictStoreHandle = Pick<
  ResidualVerdictStore,
  "find" | "put" | "touch" | "expire" | "close"
>;

export interface ResidualResolutionOpsDeps {
  /** The codegraph root; the store lives at `<rootDir>/residual-verdicts/<logicalName>.duckdb`. */
  rootDir: string;
  codegraphPool: Pick<GraphDbClientPool, "acquireWrite">;
  config: ResidualResolutionConfig;
  createProvider?: (model: string) => ResidualModelProvider;
  openStore?: (
    rootDir: string,
    logicalName: string,
  ) => Promise<VerdictStoreHandle>;
  now?: () => number;
}

export interface ResidualResolveRequest {
  logicalName: string;
  physicalCollectionName: PhysicalCollectionName;
  projectRoot: string;
  model: string;
  onProgress?: ProgressCallback;
}

export class ResidualResolutionOps {
  private readonly createProvider: (model: string) => ResidualModelProvider;
  private readonly openStore: (
    rootDir: string,
    logicalName: string,
  ) => Promise<VerdictStoreHandle>;
  private readonly now: () => number;

  constructor(private readonly deps: ResidualResolutionOpsDeps) {
    this.createProvider =
      deps.createProvider ??
      ((model) => ResidualModelProviderFactory.create(model, deps.config));
    this.openStore =
      deps.openStore ??
      (async (root, name) => ResidualVerdictStore.open(root, name));
    this.now = deps.now ?? Date.now;
  }

  async resolve(request: ResidualResolveRequest): Promise<ResidualPassReport> {
    let store: VerdictStoreHandle | undefined;
    try {
      const provider = this.createProvider(request.model);
      store = await this.openStore(this.deps.rootDir, request.logicalName);
      const { graphDb } = await this.deps.codegraphPool.acquireWrite(
        request.physicalCollectionName,
      );
      const report = await new ResidualResolutionPass().run({
        graphDb,
        store,
        provider,
        concurrency: this.deps.config.concurrency,
        menuLimit: this.deps.config.menuLimit,
        retentionDays: this.deps.config.retentionDays,
        readMethodSource: async (relPath, startLine, endLine) =>
          sliceLines(
            await readFile(join(request.projectRoot, relPath), "utf8"),
            startLine,
            endLine,
          ),
        now: this.now,
        onProgress: ({ done, total }) => {
          request.onProgress?.({
            phase: "resolving-residual",
            current: done,
            total,
            percentage: total > 0 ? Math.round((done / total) * 100) : 100,
            message: `Resolving residual call sites (${done}/${total} methods)`,
          });
        },
      });
      return report;
    } catch (error) {
      return {
        status: "skipped",
        reason: error instanceof Error ? error.message : String(error),
        sites: 0,
        reused: 0,
        asked: 0,
        applied: 0,
        overflowSkipped: 0,
      };
    } finally {
      await store?.close().catch(() => undefined);
    }
  }
}

/** Lines `startLine..endLine`, 1-based and inclusive. */
function sliceLines(text: string, startLine: number, endLine: number): string {
  return text
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
}
```

`src/core/api/index.ts` — next to `export { WorktreeOps } ...`:

```ts
export { ResidualResolutionOps } from "./internal/ops/residual-resolution-ops.js";
export type { ResidualResolutionConfig } from "./internal/ops/residual-resolution-ops.js";
```

`src/core/api/public/dto/ingest.ts` and `src/core/types.ts` — add to
`IndexOptions` right after `forceEnrichments` (both copies, same text):

```ts
  /**
   * After codegraph enrichment, ask this model (`kev`) about the call sites the
   * static resolver left ambiguous or dynamic, and add confident verdicts as
   * model edges. Never fails the run: an unreachable model ends that pass
   * skipped.
   */
  resolveResidual?: string;
```

`src/core/api/internal/ops/indexing-ops.ts`:

1. Imports (with the other `api/internal` and domain imports):

```ts
import type { ResidualPassReport } from "../../../domains/trajectory/codegraph/residual/types.js";
import type { ResidualResolutionOps } from "./residual-resolution-ops.js";
```

2. `IndexingOpsDeps` — after `codegraphPool?: GraphDbClientPool;`:

```ts
  /**
   * Residual resolution (`--resolve-residual`). Runs after the run's enrichment
   * settled, while the collection is still held. Absent when codegraph is off.
   */
  residualResolution?: Pick<ResidualResolutionOps, "resolve">;
```

3. Class field + constructor (next to `codegraphPool`):

```ts
  private readonly residualResolution?: Pick<ResidualResolutionOps, "resolve">;
```

```ts
this.residualResolution = deps.residualResolution;
```

4. In `run`, replace

```ts
const release = this.releaseCollectionWhenEnrichmentSettles(collectionName);
```

with

```ts
const residualModel = options?.resolveResidual;
const release = this.releaseCollectionWhenEnrichmentSettles(
  collectionName,
  residualModel && this.residualResolution
    ? async (physicalCollectionName) => {
        await this.residualResolution?.resolve({
          logicalName: collectionName,
          physicalCollectionName,
          projectRoot: await validatePath(path),
          model: residualModel,
          ...(progressCallback ? { onProgress: progressCallback } : {}),
        });
      }
    : undefined,
);
```

5. Replace `releaseCollectionWhenEnrichmentSettles` with (the alias lookup moves
   into `physicalCollectionOf`, which Task 12 reuses):

```ts
  /**
   * Hold the collection until the enrichment the operation detached has settled,
   * then run `afterSettle` (residual resolution) while still holding it. Waits on
   * the collection the run actually wrote — the alias target — because that is
   * the name its completion is tracked under. Never rejects.
   */
  private async releaseCollectionWhenEnrichmentSettles(
    collectionName: string,
    afterSettle?: (physicalCollectionName: PhysicalCollectionName) => Promise<void>,
  ): Promise<void> {
    try {
      const physicalCollectionName = await this.physicalCollectionOf(collectionName);
      await this.enrichment.whenCompletionsSettled(physicalCollectionName);
      // Awaited only when there is one: the release must land in the same tick
      // as before for every run that started nothing afterwards.
      const trailing = this.trailingEnrichment.get(collectionName);
      if (trailing) await trailing;
      if (afterSettle) {
        await afterSettle(physicalCollectionName).catch((error: unknown) => {
          pipelineLog.step({ component: "IndexRun" }, "RESIDUAL_FAILED", {
            collection: collectionName,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } finally {
      this.trailingEnrichment.delete(collectionName);
      await this.releaseCollectionForIndexing(collectionName);
    }
  }

  /** The alias target of `collectionName`, or the name itself when it is no alias. */
  private async physicalCollectionOf(collectionName: string): Promise<PhysicalCollectionName> {
    try {
      return resolvePhysicalCollection(collectionName, await this.qdrant.aliases.listAliases());
    } catch {
      // No alias listing: the run addressed the collection under this name.
      return resolvePhysicalCollection(collectionName, []);
    }
  }
```

(`pipelineLog` and `PhysicalCollectionName` are already imported in this file —
`runClaimed` uses `pipelineLog.resetProfiler()`, the pool calls use the brand;
if `PhysicalCollectionName` is not, add
`import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";`.
`resolvePhysicalCollection` returns `PhysicalCollectionName`; verify with
`find_symbol(symbol: "resolvePhysicalCollection")` before compiling.)

`src/core/api/internal/facades/ingest-facade.ts`:

- `IngestFacadeDeps`, after `codegraphPool?: GraphDbClientPool;`:

```ts
  /** Residual resolution for `--resolve-residual` / `resolve-codegraph-residual`. Absent when codegraph is off. */
  residualResolution?: ResidualResolutionOps;
```

- import:
  `import type { ResidualResolutionOps } from "../ops/residual-resolution-ops.js";`
- in `new IndexingOps({ ... })`, after `codegraphPool: deps.codegraphPool,`:

```ts
      ...(deps.residualResolution ? { residualResolution: deps.residualResolution } : {}),
```

`src/bootstrap/factory.ts`:

- `CodegraphContext` (~444) gains `rootDir: string;` with the doc line
  `/** Root the pool's files live under — the residual verdict store sits beside them. */`;
  `wireCodegraph`'s returned `CodegraphContext` object adds `rootDir,` (the
  local `const rootDir = codegraph.dbPath ? ... : config.paths.appData;` at
  ~800).
- import `ResidualResolutionOps` in the existing `from "../core/api/index.js"`
  block.
- `IngestSliceDeps` (~1105) gains `residualResolution?: ResidualResolutionOps;`.
- `ingestSlice` (~1647) gains:

```ts
    residualResolution: codegraphContext
      ? new ResidualResolutionOps({
          rootDir: codegraphContext.rootDir,
          codegraphPool: codegraphContext.pool,
          config: zodConfig.codegraph.residual,
        })
      : undefined,
```

- `createIngestFacade` → `new IngestFacade({ ... })` gains, after
  `codegraphPool: shared.codegraphPool,`:

```ts
    residualResolution: shared.residualResolution,
```

`src/cli/commands/index-codebase.ts`:

- `IndexCodebaseArgs` after `"force-enrichments"?: string;`:

```ts
  /** Model to resolve residual call sites with after codegraph enrichment (`kev`). */
  "resolve-residual"?: string;
```

- `buildIndexOptions` return object, after the `forceEnrichments` spread:

```ts
    ...(argv["resolve-residual"] !== undefined ? { resolveResidual: argv["resolve-residual"] } : {}),
```

- builder, after the `force-enrichments` option:

```ts
      .option("resolve-residual", {
        type: "string",
        nargs: 1,
        choices: ["kev"] as const,
        describe:
          "After codegraph enrichment, ask this model about the call sites static resolution left " +
          "ambiguous or dynamic, and add its confident answers as model edges. Verdicts are cached " +
          "across runs. Needs CODEGRAPH_RESIDUAL_KEV_URL. An unreachable model skips the pass; " +
          "indexing still succeeds.",
      })
```

`tests/cli/index-progress/worker.test.ts` — in the Task 10 test, replace `{}`
with `{ resolveResidual: "kev" }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/api/internal/ops/residual-resolution-ops.test.ts tests/core/api/internal/ops/indexing-ops-residual.test.ts tests/cli/index-codebase-resolve-residual.test.ts tests/core/api/internal/ops/indexing-ops-concurrent-run.test.ts tests/cli/index-progress/worker.test.ts tests/cli/commands/index-codebase-help.test.ts tests/bootstrap/factory.test.ts`
Expected: PASS. `npx tsc --noEmit -p tsconfig.json` and
`npx eslint src/core/api src/bootstrap src/cli/commands/index-codebase.ts`
clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/ops/residual-resolution-ops.ts src/core/api/index.ts \
  src/core/api/public/dto/ingest.ts src/core/types.ts \
  src/core/api/internal/ops/indexing-ops.ts src/core/api/internal/facades/ingest-facade.ts \
  src/bootstrap/factory.ts src/cli/commands/index-codebase.ts \
  tests/core/api/internal/ops/residual-resolution-ops.test.ts \
  tests/core/api/internal/ops/indexing-ops-residual.test.ts \
  tests/cli/index-codebase-resolve-residual.test.ts tests/cli/index-progress/worker.test.ts
git commit -m "feat(codegraph): index-codebase --resolve-residual runs the pass after enrichment settles"
```

---

### Task 12: `tea-rags resolve-codegraph-residual`

Runs the pass against the current generation without indexing. The collection is
claimed through the same `IndexingLock` path `run` uses
(`claimCollectionForIndexing`), so it refuses with
`IndexingAlreadyInProgressError` while an index run holds it. The CLI may import
only `bootstrap/`, `core/api/public` and the `core/api` barrel
(`eslint.config.js:172-195`): it reaches the op through a CLI-only
`AppContext.resolveCodegraphResidual`, the way `worktree` reaches `worktreeOps`.

**Files:**

- Modify: `src/core/api/internal/ops/indexing-ops.ts` (new public
  `resolveResidual`, after `whenEnrichmentComplete`)
- Modify: `src/core/api/internal/facades/ingest-facade.ts` (new public
  `resolveCodegraphResidual`)
- Modify: `src/bootstrap/factory.ts` (`AppContext` ~191-204; the returned object
  ~1882)
- Create: `src/cli/commands/resolve-codegraph-residual.ts`
- Modify: `src/cli/create-cli.ts` (import +
  `.command(resolveCodegraphResidualCommand)` after `indexCodebaseCommand`)
- Modify: `src/cli/completion.ts` (`--model` under `resolve-codegraph-residual`)
- Test: `tests/core/api/internal/ops/indexing-ops-residual.test.ts` (extend)
- Test: `tests/cli/commands/resolve-codegraph-residual.test.ts`
- Test: `tests/cli/completion.test.ts` (extend; create the file with the import
  below if it does not exist)

**Interfaces:**

- Consumes: `ResidualResolutionOps#resolve` (Task 11), `applyProjectDefaults`
  (`src/cli/registry-resolver.ts:63`), `resolveRegistryEnv`,
  `pickRegistryEnvSeed`, `CollectionRegistry` (`core/api/public`).
- Produces:
  - `IndexingOps#resolveResidual(path: string, model: string, progressCallback?: ProgressCallback): Promise<ResidualPassReport>`
  - `IngestFacade#resolveCodegraphResidual(path: string, model: string, progressCallback?: ProgressCallback): Promise<ResidualPassReport>`
  - `AppContext.resolveCodegraphResidual?: IngestFacade["resolveCodegraphResidual"]`
  - The CLI cannot import `ResidualPassReport` (domains are off-limits to
    `cli/`); it types the report as
    `Awaited<ReturnType<NonNullable<AppContext["resolveCodegraphResidual"]>>>`.
  - `export function formatResidualReport(report: ResidualReport): string`
  - `export async function runResolveCodegraphResidual(args: ResolveResidualArgs, deps: ResolveResidualDeps): Promise<number>`
    (exit code)
  - `export const resolveCodegraphResidualCommand: CommandModule<object, ResolveResidualArgs>`

- [ ] **Step 1: Write the failing tests**

Extend `tests/core/api/internal/ops/indexing-ops-residual.test.ts`:

```ts
import { IndexingAlreadyInProgressError } from "../../../../../src/core/domains/ingest/errors.js";

describe("IndexingOps#resolveResidual", () => {
  it("holds the collection for the pass — an index run meanwhile is refused", async () => {
    const settled = gate();
    settled.open();
    const held = gate();
    const residualResolve = vi.fn(async () => {
      await held.opened;
      return { ...SKIPPED, status: "completed" as const, applied: 3 };
    });
    const ops = new IndexingOps(
      makeDeps(
        { residualResolution: { resolve: residualResolve } },
        settled.opened,
        [],
      ),
    );

    const pending = ops.resolveResidual("/repo", "kev");
    await vi.waitFor(() => {
      expect(residualResolve).toHaveBeenCalledTimes(1);
    });
    await expect(ops.run("/repo")).rejects.toBeInstanceOf(
      IndexingAlreadyInProgressError,
    );

    held.open();
    await expect(pending).resolves.toMatchObject({
      status: "completed",
      applied: 3,
    });
    expect(residualResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalName: ALIAS,
        physicalCollectionName: ALIAS,
        model: "kev",
      }),
    );
    await expect(ops.run("/repo")).resolves.toBeDefined();
  });

  it("reports skipped when codegraph is disabled", async () => {
    const settled = gate();
    settled.open();
    const ops = new IndexingOps(makeDeps({}, settled.opened, []));

    await expect(ops.resolveResidual("/repo", "kev")).resolves.toMatchObject({
      status: "skipped",
      reason: "codegraph is disabled (CODEGRAPH_ENABLED=false)",
    });
  });
});
```

`tests/cli/commands/resolve-codegraph-residual.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import {
  formatResidualReport,
  resolveCodegraphResidualCommand,
  runResolveCodegraphResidual,
} from "../../../src/cli/commands/resolve-codegraph-residual.js";

const COMPLETED = {
  status: "completed" as const,
  sites: 120,
  reused: 80,
  asked: 40,
  applied: 95,
  overflowSkipped: 3,
};

function parse(argv: string[]): Record<string, unknown> {
  let failure: string | undefined;
  const parsed = yargs([])
    .command({ ...resolveCodegraphResidualCommand, handler: () => undefined })
    .exitProcess(false)
    .fail((msg: string) => {
      failure = msg;
    })
    .parse(argv) as Record<string, unknown>;
  if (failure !== undefined) throw new Error(failure);
  return parsed;
}

describe("formatResidualReport", () => {
  it("prints the counts of a completed pass", () => {
    expect(formatResidualReport(COMPLETED)).toBe(
      "Residual resolution: completed\n" +
        "  sites:            120\n" +
        "  reused verdicts:  80\n" +
        "  asked:            40\n" +
        "  edges applied:    95\n" +
        "  menu overflow:    3\n",
    );
  });

  it("prints the reason of a skipped pass", () => {
    expect(
      formatResidualReport({
        status: "skipped",
        reason: "provider kev unavailable: ECONNREFUSED",
        sites: 0,
        reused: 0,
        asked: 0,
        applied: 0,
        overflowSkipped: 0,
      }),
    ).toContain(
      "Residual resolution: skipped — provider kev unavailable: ECONNREFUSED\n",
    );
  });
});

describe("resolve-codegraph-residual command", () => {
  it("requires --model and accepts only kev", () => {
    expect(() => parse(["resolve-codegraph-residual"])).toThrow(
      /Missing required argument: model/,
    );
    expect(() =>
      parse(["resolve-codegraph-residual", "--model", "gpt-9"]),
    ).toThrow(/Invalid values/);
    expect(
      parse([
        "resolve-codegraph-residual",
        "--model",
        "kev",
        "--project",
        "app",
      ]),
    ).toMatchObject({
      model: "kev",
      project: "app",
    });
  });

  it("runs the pass for the resolved path, prints the report and exits 0", async () => {
    const out: string[] = [];
    const resolveCodegraphResidual = vi.fn().mockResolvedValue(COMPLETED);
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const code = await runResolveCodegraphResidual(
      { path: "/repo", model: "kev" },
      {
        createContext: async () => ({ resolveCodegraphResidual, cleanup }),
        write: (s) => out.push(s),
      },
    );

    expect(code).toBe(0);
    expect(resolveCodegraphResidual).toHaveBeenCalledWith(
      "/repo",
      "kev",
      expect.any(Function),
    );
    expect(out.join("")).toContain("edges applied:    95");
    expect(cleanup).toHaveBeenCalled();
  });

  it("emits JSON with --json", async () => {
    const out: string[] = [];

    await runResolveCodegraphResidual(
      { path: "/repo", model: "kev", json: true },
      {
        createContext: async () => ({
          resolveCodegraphResidual: vi.fn().mockResolvedValue(COMPLETED),
        }),
        write: (s) => out.push(s),
      },
    );

    expect(JSON.parse(out.join(""))).toEqual(COMPLETED);
  });

  it("exits 1 when codegraph is not wired in this process", async () => {
    const out: string[] = [];

    const code = await runResolveCodegraphResidual(
      { path: "/repo", model: "kev" },
      { createContext: async () => ({}), write: (s) => out.push(s) },
    );

    expect(code).toBe(1);
    expect(out.join("")).toMatch(/CODEGRAPH_ENABLED=true/);
  });

  it("exits 1 on a skipped pass so scripts notice", async () => {
    const code = await runResolveCodegraphResidual(
      { path: "/repo", model: "kev" },
      {
        createContext: async () => ({
          resolveCodegraphResidual: vi.fn().mockResolvedValue({
            ...COMPLETED,
            status: "skipped",
            reason: "down",
          }),
        }),
        write: () => undefined,
      },
    );

    expect(code).toBe(1);
  });
});
```

Completion test (`tests/cli/completion.test.ts`; if the file exists, add only
the `it`):

```ts
import { describe, expect, it } from "vitest";

import { maybeCompleteProjectName } from "../../src/cli/completion.js";

describe("maybeCompleteProjectName — resolve-codegraph-residual", () => {
  it("completes --model with the residual models", () => {
    expect(
      maybeCompleteProjectName(
        ["resolve-codegraph-residual", "--model", ""],
        ["tea-rags", "resolve-codegraph-residual"],
      ),
    ).toEqual(["kev"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`npx vitest run tests/core/api/internal/ops/indexing-ops-residual.test.ts tests/cli/commands/resolve-codegraph-residual.test.ts tests/cli/completion.test.ts`
Expected: FAIL — `resolveResidual` is not a function; the command module does
not exist; completion returns `null`.

- [ ] **Step 3: Implement**

`src/core/api/internal/ops/indexing-ops.ts` — after `whenEnrichmentComplete`:

```ts
  /**
   * Residual resolution against the collection's current generation, without
   * indexing (`tea-rags resolve-codegraph-residual`). Claims the collection like
   * an index run, so it never overlaps one.
   */
  async resolveResidual(
    path: string,
    model: string,
    progressCallback?: ProgressCallback,
  ): Promise<ResidualPassReport> {
    if (!this.residualResolution) {
      return {
        status: "skipped",
        reason: "codegraph is disabled (CODEGRAPH_ENABLED=false)",
        sites: 0,
        reused: 0,
        asked: 0,
        applied: 0,
        overflowSkipped: 0,
      };
    }
    this.assertProcessBuildCurrent();
    const collectionName = await this.claimCollectionForIndexing(path, undefined);
    try {
      return await this.residualResolution.resolve({
        logicalName: collectionName,
        physicalCollectionName: await this.physicalCollectionOf(collectionName),
        projectRoot: await validatePath(path),
        model,
        ...(progressCallback ? { onProgress: progressCallback } : {}),
      });
    } finally {
      await this.releaseCollectionForIndexing(collectionName);
    }
  }
```

`src/core/api/internal/facades/ingest-facade.ts` — public method next to the
facade's other `indexingOps` delegations; add
`import type { ResidualPassReport } from "../../../domains/trajectory/codegraph/residual/types.js";`
and `ProgressCallback` to the existing `types.js` import if absent:

```ts
  /** Residual resolution on the current generation (CLI `resolve-codegraph-residual`). */
  async resolveCodegraphResidual(
    path: string,
    model: string,
    progressCallback?: ProgressCallback,
  ): Promise<ResidualPassReport> {
    return this.indexingOps.resolveResidual(path, model, progressCallback);
  }
```

`src/bootstrap/factory.ts`:

- `AppContext`, after `worktreeOps`:

```ts
  /** CLI-only residual resolution on the current generation; absent when codegraph is off. */
  resolveCodegraphResidual?: IngestFacade["resolveCodegraphResidual"];
```

- the returned object (~1882), after `worktreeOps,`:

```ts
    ...(codegraphContext
      ? {
          resolveCodegraphResidual: async (path: string, model: string, onProgress?: ProgressCallback) =>
            ingest.resolveCodegraphResidual(path, model, onProgress),
        }
      : {}),
```

(`ProgressCallback`: import from `../core/api/public/index.js` if `factory.ts`
does not already have it; `find_symbol(symbol: "ProgressCallback")` names its
export path.)

`src/cli/commands/resolve-codegraph-residual.ts`:

```ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandModule } from "yargs";

import { resolveRegistryEnvCodeDefaults } from "../../bootstrap/config/index.js";
import type { AppContext } from "../../bootstrap/factory.js";
import {
  CollectionRegistry,
  pickRegistryEnvSeed,
  resolveRegistryEnv,
} from "../../core/api/public/index.js";
import { applyProjectDefaults } from "../registry-resolver.js";

export interface ResolveResidualArgs {
  path?: string;
  project?: string;
  model: string;
  json?: boolean;
}

type ResidualReport = Awaited<
  ReturnType<NonNullable<AppContext["resolveCodegraphResidual"]>>
>;

export interface ResolveResidualDeps {
  createContext: () => Promise<
    Pick<AppContext, "resolveCodegraphResidual" | "cleanup">
  >;
  write: (text: string) => void;
}

export function formatResidualReport(report: ResidualReport): string {
  const head =
    report.status === "completed" && report.reason === undefined
      ? `Residual resolution: ${report.status}\n`
      : `Residual resolution: ${report.status} — ${report.reason ?? ""}\n`;
  return (
    head +
    `  sites:            ${report.sites}\n` +
    `  reused verdicts:  ${report.reused}\n` +
    `  asked:            ${report.asked}\n` +
    `  edges applied:    ${report.applied}\n` +
    `  menu overflow:    ${report.overflowSkipped}\n`
  );
}

export async function runResolveCodegraphResidual(
  args: ResolveResidualArgs,
  deps: ResolveResidualDeps,
): Promise<number> {
  const path = resolve(args.path ?? process.cwd());
  const ctx = await deps.createContext();
  try {
    if (!ctx.resolveCodegraphResidual) {
      deps.write(
        "Codegraph is disabled for this project — set CODEGRAPH_ENABLED=true and index it first.\n",
      );
      return 1;
    }
    const report = await ctx.resolveCodegraphResidual(path, args.model, (p) => {
      if (!args.json) process.stderr.write(`\r${p.message}`);
    });
    if (!args.json) process.stderr.write("\n");
    deps.write(
      args.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatResidualReport(report),
    );
    return report.status === "completed" ? 0 : 1;
  } finally {
    await ctx.cleanup?.();
  }
}

/** Seed this process's env from the project's registry entry; the ambient env wins. */
function applyRegistryEnv(project: string | undefined, path: string): void {
  const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  const registry = new CollectionRegistry(dataDir, {
    envCodeDefaults: resolveRegistryEnvCodeDefaults,
  });
  const registryEnv = resolveRegistryEnv(
    pickRegistryEnvSeed(registry, { project, path }),
  );
  for (const [key, value] of Object.entries(registryEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const resolveCodegraphResidualCommand: CommandModule<
  object,
  ResolveResidualArgs
> = {
  command: "resolve-codegraph-residual",
  describe:
    "Ask a model about the call sites codegraph left ambiguous or dynamic in the current index, " +
    "and add its confident answers as model edges. Cached verdicts are reused.",
  builder: (y) =>
    y
      .option("model", {
        type: "string",
        demandOption: true,
        choices: ["kev"] as const,
        describe: "Residual model (needs CODEGRAPH_RESIDUAL_KEV_URL).",
      })
      .option("project", {
        alias: "p",
        type: "string",
        describe: "Registered project alias.",
      })
      .option("path", {
        type: "string",
        describe: "Project directory (default: current directory).",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print the report as JSON.",
      }) as never,
  handler: async (argv) => {
    const resolved = applyProjectDefaults({ ...argv, model: argv.model });
    const path = resolve(resolved.path ?? process.cwd());
    applyRegistryEnv(argv.project, path);
    const code = await runResolveCodegraphResidual(
      { path, model: argv.model, json: Boolean(argv.json) },
      {
        createContext: async () => {
          const { parseAppConfig } =
            await import("../../bootstrap/config/index.js");
          const { createAppContext } =
            await import("../../bootstrap/factory.js");
          return createAppContext(parseAppConfig());
        },
        write: (text) => process.stdout.write(text),
      },
    );
    process.exit(code);
  },
};
```

(`applyProjectDefaults` fills `model` from the registry's embedding model only
when `argv.model` is unset; `--model` is demanded, so ours always stands.
`import type { AppContext }` from `bootstrap/factory.js` is a type-only import
of an allowed layer; verify `AppContext` is exported there — it is,
`factory.ts:191`.)

`src/cli/create-cli.ts`: add
`import { resolveCodegraphResidualCommand } from "./commands/resolve-codegraph-residual.js";`
and `.command(resolveCodegraphResidualCommand)` right after
`.command(indexCodebaseCommand)`.

`src/cli/completion.ts` — in `maybeCompleteProjectName`, before the `--project`
branch:

```ts
// `tea-rags resolve-codegraph-residual --model <TAB>` — the residual models.
if (
  last === "--model" &&
  withoutScriptName(parsedPositionals)[0] === "resolve-codegraph-residual"
) {
  return ["kev"];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`npx vitest run tests/core/api/internal/ops/indexing-ops-residual.test.ts tests/cli/commands/resolve-codegraph-residual.test.ts tests/cli/completion.test.ts tests/cli/`
Expected: PASS. `npx tsc --noEmit -p tsconfig.json` and
`npx eslint src/cli src/bootstrap/factory.ts src/core/api` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/ops/indexing-ops.ts src/core/api/internal/facades/ingest-facade.ts \
  src/bootstrap/factory.ts src/cli/commands/resolve-codegraph-residual.ts src/cli/create-cli.ts \
  src/cli/completion.ts tests/core/api/internal/ops/indexing-ops-residual.test.ts \
  tests/cli/commands/resolve-codegraph-residual.test.ts tests/cli/completion.test.ts
git commit -m "feat(cli): resolve-codegraph-residual runs the residual pass on the current index"
```

---

### Task 13: Eval gate `scripts/residual-eval.ts`

The gate measures Kev the way the pass asks it: each fixture site becomes a
one-question group through `KevResidualProvider`, candidates expanded to
`<Class>#<member>`. Baselines from the reference run: accuracy 0.93 overall,
0.80 on sites where the parameter name does not name the class
(`naming_hit: false`).

**Files:**

- Create: `tests/fixtures/residual-eval/sites40.jsonl` (copy of
  `/Users/artk0re/.claude/jobs/44f70430/tmp/sites40.jsonl`, 91 rows)
- Create: `scripts/residual-eval.ts`
- Test: `tests/scripts/residual-eval.test.ts`

**Interfaces:**

- Consumes: `KevResidualProvider` (Task 8).
- Produces:
  - `export interface EvalSite { file: string; line: number; method: string; param: string; member: string; truth: string; candidates: string[]; all_candidates: number; naming_hit: boolean; source: string }`
  - `export interface EvalOutcome { site: EvalSite; pick: string; p: number }`
  - `export interface EvalScore { total: number; accuracy: { all: number; namingMiss: number; namingHit: number }; atThreshold: { threshold: number; coverage: number; precision: number }[] }`
  - `export const BASELINE: { all: 0.93; namingMiss: 0.8 }`
  - `export function scoreOutcomes(outcomes: EvalOutcome[], thresholds?: readonly number[]): EvalScore`
  - `export function gateFailures(score: EvalScore): string[]`
  - `export function siteGroup(site: EvalSite, index: number): ResidualQuestionGroup`

- [ ] **Step 1: Vendor the fixture**

```bash
mkdir -p tests/fixtures/residual-eval
cp /Users/artk0re/.claude/jobs/44f70430/tmp/sites40.jsonl tests/fixtures/residual-eval/sites40.jsonl
wc -l tests/fixtures/residual-eval/sites40.jsonl   # expect 91
```

- [ ] **Step 2: Write the failing test**

`tests/scripts/residual-eval.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BASELINE,
  gateFailures,
  scoreOutcomes,
  siteGroup,
  type EvalOutcome,
  type EvalSite,
} from "../../scripts/residual-eval.js";

const site = (over: Partial<EvalSite>): EvalSite => ({
  file: "app/a.rb",
  line: 3,
  method: "run",
  param: "firm",
  member: "users",
  truth: "Firm",
  candidates: ["Firm", "Client"],
  all_candidates: 2,
  naming_hit: true,
  source: "def run(firm)\n  firm.users\nend",
  ...over,
});

const outcome = (
  over: Partial<EvalSite>,
  pick: string,
  p: number,
): EvalOutcome => ({ site: site(over), pick, p });

describe("scoreOutcomes", () => {
  const outcomes = [
    outcome({ naming_hit: true }, "Firm", 0.95),
    outcome({ naming_hit: true }, "Client", 0.6),
    outcome({ naming_hit: false, truth: "Client" }, "Client", 0.8),
    outcome({ naming_hit: false, truth: "Client" }, "Firm", 0.4),
  ];

  it("splits accuracy by whether the parameter name named the class", () => {
    const score = scoreOutcomes(outcomes);

    expect(score.total).toBe(4);
    expect(score.accuracy).toEqual({
      all: 0.5,
      namingMiss: 0.5,
      namingHit: 0.5,
    });
  });

  it("reports coverage and precision of the answers at or above each threshold", () => {
    const score = scoreOutcomes(outcomes, [0.5, 0.7, 0.9]);

    expect(score.atThreshold).toEqual([
      { threshold: 0.5, coverage: 0.75, precision: 2 / 3 },
      { threshold: 0.7, coverage: 0.5, precision: 1 },
      { threshold: 0.9, coverage: 0.25, precision: 1 },
    ]);
  });

  it("gives precision 0 when no answer clears the threshold", () => {
    expect(
      scoreOutcomes([outcome({}, "Firm", 0.1)], [0.9]).atThreshold,
    ).toEqual([{ threshold: 0.9, coverage: 0, precision: 0 }]);
  });
});

describe("gateFailures", () => {
  it("passes at the baseline and fails below it, naming each missed bar", () => {
    const at = {
      total: 1,
      accuracy: {
        all: BASELINE.all,
        namingMiss: BASELINE.namingMiss,
        namingHit: 1,
      },
      atThreshold: [],
    };
    expect(gateFailures(at)).toEqual([]);

    const below = {
      ...at,
      accuracy: { all: 0.9, namingMiss: 0.7, namingHit: 1 },
    };
    expect(gateFailures(below)).toEqual([
      "accuracy 0.900 < baseline 0.93",
      "naming-miss accuracy 0.700 < baseline 0.8",
    ]);
  });
});

describe("siteGroup", () => {
  it("asks one question per site with method-symbol candidates", () => {
    const group = siteGroup(site({}), 7);

    expect(group).toEqual({
      sourceRelPath: "app/a.rb",
      methodSource: "def run(firm)\n  firm.users\nend",
      questions: [
        {
          siteKey: "site-7",
          receiverText: "firm",
          member: "users",
          candidates: ["Firm#users", "Client#users"],
        },
      ],
    });
  });
});

describe("sites40 fixture", () => {
  it("holds 91 sites, each with its truth on the menu", () => {
    const rows = readFileSync(
      join(import.meta.dirname, "../fixtures/residual-eval/sites40.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as EvalSite);

    expect(rows).toHaveLength(91);
    for (const r of rows) expect(r.candidates).toContain(r.truth);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/scripts/residual-eval.test.ts` Expected: FAIL —
`scripts/residual-eval.ts` does not exist. (If the last case fails because a
fixture row's truth is not on its menu, that row is a fixture defect: report it,
do not edit the fixture.)

- [ ] **Step 4: Implement**

`scripts/residual-eval.ts`:

```ts
/**
 * Residual-resolution eval gate against a Kev endpoint.
 *
 *   npx tsx scripts/residual-eval.ts --url http://gpu:8090 \
 *     --sites tests/fixtures/residual-eval/sites40.jsonl [--gate] [--concurrency 8]
 *
 * Asks every fixture site as a one-question group, prints accuracy (all /
 * naming-miss / naming-hit) and coverage + precision at p >= 0.5/0.7/0.9.
 * With --gate, exits 1 below the baseline.
 */

import { readFileSync } from "node:fs";
import { sep } from "node:path";

import {
  candidateClass,
  KevResidualProvider,
} from "../src/core/adapters/kev/kev-residual-provider.js";
import type { ResidualQuestionGroup } from "../src/core/contracts/types/codegraph-residual.js";

export interface EvalSite {
  file: string;
  line: number;
  method: string;
  param: string;
  member: string;
  truth: string;
  candidates: string[];
  all_candidates: number;
  naming_hit: boolean;
  source: string;
}

export interface EvalOutcome {
  site: EvalSite;
  /** Picked class. */
  pick: string;
  p: number;
}

export interface EvalScore {
  total: number;
  accuracy: { all: number; namingMiss: number; namingHit: number };
  atThreshold: { threshold: number; coverage: number; precision: number }[];
}

export const BASELINE = { all: 0.93, namingMiss: 0.8 } as const;
const THRESHOLDS = [0.5, 0.7, 0.9] as const;

const ratio = (hits: number, of: number): number => (of === 0 ? 0 : hits / of);

export function scoreOutcomes(
  outcomes: EvalOutcome[],
  thresholds: readonly number[] = THRESHOLDS,
): EvalScore {
  const correct = (o: EvalOutcome): boolean => o.pick === o.site.truth;
  const accuracyOf = (subset: EvalOutcome[]): number =>
    ratio(subset.filter(correct).length, subset.length);
  return {
    total: outcomes.length,
    accuracy: {
      all: accuracyOf(outcomes),
      namingMiss: accuracyOf(outcomes.filter((o) => !o.site.naming_hit)),
      namingHit: accuracyOf(outcomes.filter((o) => o.site.naming_hit)),
    },
    atThreshold: thresholds.map((threshold) => {
      const kept = outcomes.filter((o) => o.p >= threshold);
      return {
        threshold,
        coverage: ratio(kept.length, outcomes.length),
        precision: ratio(kept.filter(correct).length, kept.length),
      };
    }),
  };
}

export function gateFailures(score: EvalScore): string[] {
  const failures: string[] = [];
  if (score.accuracy.all < BASELINE.all) {
    failures.push(
      `accuracy ${score.accuracy.all.toFixed(3)} < baseline ${BASELINE.all}`,
    );
  }
  if (score.accuracy.namingMiss < BASELINE.namingMiss) {
    failures.push(
      `naming-miss accuracy ${score.accuracy.namingMiss.toFixed(3)} < baseline ${BASELINE.namingMiss}`,
    );
  }
  return failures;
}

export function siteGroup(
  site: EvalSite,
  index: number,
): ResidualQuestionGroup {
  return {
    sourceRelPath: site.file,
    methodSymbolId: site.method,
    methodSource: site.source,
    questions: [
      {
        siteKey: `site-${index}`,
        menuHash: `eval-${index}`,
        receiverText: site.param,
        member: site.member,
        kind: "ambiguous",
        candidates: site.candidates.map((name) => `${name}#${site.member}`),
      },
    ],
  };
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readSites(path: string): EvalSite[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalSite);
}

async function main(): Promise<void> {
  const url = argValue("--url");
  const sitesPath = argValue("--sites");
  if (!url || !sitesPath)
    throw new Error(
      "usage: residual-eval.ts --url <kev> --sites <jsonl> [--gate] [--concurrency N]",
    );
  const concurrency = Number(argValue("--concurrency") ?? "8");
  const provider = new KevResidualProvider({
    urls: url.split(","),
    threshold: 0.7,
  });
  const health = await provider.health();
  if (!health.ok) throw new Error(`Kev unavailable: ${health.reason}`);
  process.stdout.write(`model: ${await provider.version()}\n`);

  const sites = readSites(sitesPath);
  const outcomes: EvalOutcome[] = new Array(sites.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sites.length) {
      const index = next++;
      const [answer] = await provider.resolveGroup(
        siteGroup(sites[index], index),
      );
      outcomes[index] = {
        site: sites[index],
        pick: candidateClass(answer.pick),
        p: answer.p,
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => worker()),
  );

  const score = scoreOutcomes(outcomes);
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  process.stdout.write(
    `sites: ${score.total}\n` +
      `accuracy  all ${pct(score.accuracy.all)}  naming-miss ${pct(score.accuracy.namingMiss)}  ` +
      `naming-hit ${pct(score.accuracy.namingHit)}\n` +
      score.atThreshold
        .map(
          (t) =>
            `p>=${t.threshold}  coverage ${pct(t.coverage)}  precision ${pct(t.precision)}\n`,
        )
        .join(""),
  );
  if (process.argv.includes("--gate")) {
    const failures = gateFailures(score);
    if (failures.length > 0) {
      process.stderr.write(
        `GATE FAILED\n${failures.map((f) => `  ${f}\n`).join("")}`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write("GATE PASSED\n");
  }
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split(sep).pop() ?? "")
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/scripts/residual-eval.test.ts` Expected: PASS.
`npx tsc --noEmit -p tsconfig.json` clean (if `scripts/` is outside the root
tsconfig, run `npx tsc --noEmit -p tsconfig.eslint.json`). Manual (needs a live
Kev, not part of CI):
`npx tsx scripts/residual-eval.ts --url http://<kev-host>:8090 --sites tests/fixtures/residual-eval/sites40.jsonl --gate`

- [ ] **Step 6: Commit**

```bash
git add scripts/residual-eval.ts tests/scripts/residual-eval.test.ts tests/fixtures/residual-eval/sites40.jsonl
git commit -m "test(codegraph): residual eval gate script with the 91-site Kev fixture"
```

---

### Task 14: Docs — reconcile the Kev page with the delivered feature

The page `website/docs/config/kev-setup.md` (sidebar_position 5, under
Configuration) was written ahead of the code on 2026-10-15. It carries the Kev
host setup measured that day (reference host Windows 11 + ROCm, RX 7800M), a
hardware-tuning section, and a "Configure tea-rags" / "Run it" / "Check
accuracy" part describing Tasks 7, 11, 12 and 13 as designed. Its caution
admonition says the tea-rags side is in development. This task makes the page
describe what Tasks 1–13 actually shipped. The README subsection "🧪
Model-assisted call resolution with Kev (experimental)" links to it.

**Files:**

- Modify: `website/docs/config/kev-setup.md`
- Modify: `README.md` (Kev subsection, only if a number or flag changed)

**Interfaces:**

- Consumes: env vars and defaults (Task 7 `codegraphSchema.residual`),
  `--resolve-residual` (Task 11), `resolve-codegraph-residual` output and exit
  codes (Task 12), `scripts/residual-eval.ts` flags and gate (Task 13), verdict
  file location (Task 6).

- [ ] **Step 1: Diff the page against the code**

For each claim in "Configure tea-rags", "Run it" and "Check accuracy", find the
implementing symbol with `find_symbol` and compare: variable names and defaults
(`concurrency` 96, `menuLimit` 40, `kev.threshold` 0.7, `verdictRetentionDays`
180), the CLI option spelling, the summary line the command prints, the exit
code on `skipped`, the verdict path
`<data dir>/residual-verdicts/<collection>.duckdb`, and the eval gate thresholds
(0.93 / 0.80). Any divergence: the page follows the code, unless the code
contradicts the spec — then stop and raise it.

- [ ] **Step 2: Update the admonition**

Replace the "is in development and lands with the residual-resolution epic"
sentence with the experimental status only: the feature ships, flags may change.
Keep the `:::caution Experimental` block.

- [ ] **Step 3: Lint and build check**

Run: `npx prettier --check website/docs/config/kev-setup.md README.md`, then
`npm run website:build` if that script exists (otherwise the CI website job
covers it). Expected: clean; the page appears under Configuration after "Local
Exposed GPU Setup".

- [ ] **Step 4: Commit**

```bash
git add website/docs/config/kev-setup.md README.md
git commit -m "docs(kev): page describes the shipped residual resolution"
```

---

## Open Items for the Executor

- Task 7's wiring test constructs the codegraph provider with
  `graphDb: {} as never`. Confirm with `find_symbol` that the constructor does
  not touch `graphDb` in direct mode before relying on it; if it does, build the
  provider the way the neighbouring provider tests do.
- The working-tree graph path (`WorkingTreeGraphProviderConfig`, a `Pick` of
  `CodegraphWorkerConfig`) does not carry `residualMenuLimit`, so overlay builds
  use the runner default of 40. Intentional for wave 1: the residual pass never
  runs on a working-tree overlay.
- Static `get_callers` / `get_callees` rows carry no `origin`; only model edges
  do. Do not add `origin: "static"` to existing expectations.
- `trace_path` steps do not carry `origin` in wave 1.
