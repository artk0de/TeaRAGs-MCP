# Index Drift Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:executing-plans) or superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Turn the five independent drift detectors into one
`maintenance/drift/` subdomain with one report and one remedy, add the missing
detectors (shared kernel axes, env, commit, canary), heal codegraph payload
staleness, and put version-bump discipline under a mechanical gate.

**Architecture:** Advisory monitors implement `IndexDriftMonitor` and live in
`src/core/domains/maintenance/drift/`; `IndexDriftReporter` folds their findings
over the remedy lattice `none < incremental < recompute < force` and renders one
`Run:` line. Guards (`EmbeddingModelGuard`), spawn policies (`freshness/`),
migrations and enrichment heals stay where their side effect lives. Stamps are
written at index time (stats cache, registry, marker); monitors only read.

**Tech Stack:** TypeScript (Node 24), vitest, DuckDB (`@duckdb/node-api`),
Qdrant REST client, tsx scripts, picomatch globs in rule frontmatter.

**Spec:** `docs/superpowers/specs/2026-09-10-index-drift-program-design.md`

## Global Constraints

- Naming: every new exported type is `IndexDrift*` (`IndexDriftMonitor`,
  `IndexDriftFinding`, `IndexDriftReport`, `IndexDriftRemedy`,
  `IndexDriftReporter`); `SchemaDriftMonitor` and `LanguageVersionDriftMonitor`
  keep their names (`.claude/rules/naming.md`).
- Boundary: `maintenance/drift/` contains pure comparisons only. Nothing in it
  throws on drift, spawns a process, or writes to Qdrant / DuckDB / the
  registry.
- One report, one remedy: no consumer renders more than one `Run:` line for a
  collection.
- Tests move, never rewrite: a relocated module carries its `describe` blocks
  verbatim; only import paths change.
- TDD per task: failing test → implementation → green → commit. Commit subject
  carries the bead id, e.g. `refactor(drift): … (7fzfo)`.
- Live validation is user-gated (`epic-completion-gate.md`):
  `--force-enrichments <keys>` on the tea-rags self-index or taxdome, `--force`
  only where the chunk set moves. No `npm link` while more than one worktree is
  active (15 today).
- Rules ship with the code they govern, in the same task.
- Plugin `.md` edits (`.claude-plugin/tea-rags/**`) require a patch bump of
  `.claude-plugin/tea-rags/.claude-plugin/plugin.json` in the same commit
  (`check-plugin-version.sh`).
- Every migration change lands as a `.ts` + byte-identical `.sql` twin plus an
  entry in `DATABASE_MIGRATIONS` (`.claude/rules/migrations.md`).
- Drift detection is documented for users:
  `website/docs/operations/drift-detection.md` is created in B5 and extended by
  every task that adds an axis or a heal (C1–C4, D1); `recovery-reindexing.md`
  links to it (spec decision 12).
- The `Run:` line is one exact, copy-pasteable, cheapest-sufficient command
  (spec decision 14): `--project <alias>` comes from the registry entry, never a
  placeholder when the alias is known.
- `driftWarning` consumption is per collection per server process and is reset
  after every index run on that collection (spec decision 13).

## Beads

| Plan    | Bead                 | Title                                                |
| ------- | -------------------- | ---------------------------------------------------- |
| program | `tea-rags-mcp-41hq3` | Index drift program                                  |
| epic A  | `tea-rags-mcp-j53pf` | Drift rules and gates                                |
| A1      | `tea-rags-mcp-4s9tb` | Fix drift docs that contradict code                  |
| A2      | `tea-rags-mcp-c2mh8` | Guard migration `.ts`/`.sql` twins                   |
| A3      | `tea-rags-mcp-6a4qv` | Version-pins guard + `pin:lang-versions`             |
| A4      | `tea-rags-mcp-lnddr` | `migrations.md` creation-site paths + invariant test |
| A5      | `tea-rags-mcp-c8d3c` | `language-capability-sync.md` bump timing + trailer  |
| epic B  | `tea-rags-mcp-kiday` | `maintenance/drift/` unification                     |
| B1      | `tea-rags-mcp-7fzfo` | Extract schema-drift core out of `stats-cache.ts`    |
| B2      | `tea-rags-mcp-6vwim` | Relocate the two monitors                            |
| B3      | `tea-rags-mcp-omgln` | Contract, reporter, remedy lattice                   |
| B4      | `tea-rags-mcp-p0phi` | Wire the report into App / explore / prime / status  |
| B5      | `tea-rags-mcp-o7w4u` | Navigator + `index-drift.md`                         |
| epic C  | `tea-rags-mcp-sstan` | Remaining drift mechanisms                           |
| C1      | `tea-rags-mcp-y6igo` | Shared `*` axes                                      |
| C2      | `tea-rags-mcp-lg361` | `EnvDriftMonitor`                                    |
| C3      | `tea-rags-mcp-zf3x0` | `CommitDriftMonitor`                                 |
| C4      | `tea-rags-mcp-ie819` | Canary vector                                        |
| epic D  | `tea-rags-mcp-5wf6q` | Staleness defects                                    |
| D1      | `tea-rags-mcp-snbvm` | `a2ddb` payload heal                                 |
| D2      | `tea-rags-mcp-gl96z` | `sz1y0` spike                                        |
| D3      | `tea-rags-mcp-0ij6v` | `sz1y0` fix                                          |
| D4      | `tea-rags-mcp-e8wbs` | Ruby walker measurement                              |

Dependencies: B1 → B2 → B3 → B4 → B5; C1 depends on B3 and A3; C2, C3 depend on
B3; D3 depends on D2. Epic D runs in its own worktree (`drift-staleness`) in
parallel with B and C; A runs first.

## File Structure

Created:

```text
src/core/domains/maintenance/drift/
  index.ts                          barrel
  monitor.ts                        IndexDriftAxis, IndexDriftFinding, IndexDriftMonitor
  remedy.ts                         IndexDriftRemedy, foldIndexDriftRemedies, renderIndexDriftRemedy, resolveSchemaDriftRemedy
  report.ts                         IndexDriftReport, IndexDriftReporter, formatIndexDriftReport
  schema-drift.ts                   SchemaDrift, checkSchemaDrift            (from infra/stats-cache.ts)
  schema-drift-monitor.ts           moved from maintenance/
  language-version-drift-monitor.ts moved from maintenance/
  env-drift-monitor.ts              C2
  commit-drift-monitor.ts           C3
src/core/domains/language/capability/version-axes.ts     axis → source dirs (per language and "*")
src/core/domains/language/capability/version-pins.ts     digestSources, computeVersionPins
src/core/domains/language/kernel/capability.ts           SHARED_LANGUAGE, sharedVersions
src/core/domains/ingest/pipeline/enrichment/codegraph-payload-heal.ts   CodegraphPayloadHealer
src/core/domains/maintenance/migration/database/migrations/023-cg-signals-prev.{ts,sql}
scripts/pin-language-versions.ts
tests/core/domains/language/capability/version-pins.json  generated pins
.claude/rules/index-drift.md
.claude/rules/index-format-versions.md
```

Modified: `src/core/infra/stats-cache.ts` (loses the drift core),
`src/core/api/public/app.ts`, `src/core/api/internal/ops/explore-ops.ts`,
`src/core/api/internal/facades/explore-facade.ts`, `src/bootstrap/factory.ts`,
`src/cli/prime/{run-prime,format,types}.ts`,
`src/mcp/tools/code/register-status-tools.ts`,
`src/core/domains/maintenance/registry/env-groups.ts`,
`src/core/domains/language/capability/versions.ts`,
`src/core/adapters/qdrant/embedding-model-guard.ts`,
`src/core/contracts/types/codegraph-storage.ts`,
`src/core/adapters/duckdb/client.ts` + daemon server,
`src/core/domains/trajectory/codegraph/symbols/graph-finalizer.ts`,
`src/core/domains/ingest/pipeline/enrichment/coordinator.ts`,
`.claude/rules/{migrations,language-capability-sync}.md`,
`.claude-plugin/tea-rags/rules/{index-freshness,search-cascade}.md`,
`website/docs/operations/recovery-reindexing.md`,
`src/core/domains/maintenance/CLAUDE.md`, `package.json`.

Impact signals that shaped the split (blastRadius, 2026-09-10): no hubs among
the touched files; `env-groups.ts` (transitiveImpact 50), `env-replay.ts` (49),
`collection-registry.ts` (48), `repo-git-state.ts` (55) and `freshness-check.ts`
(46) are regional, so C2 and C3 add fields and readers and never change an
existing export; `enrichment/coordinator.ts` (55 commits, 3 authors,
bugFixRate 51) and `applier.ts` (23 commits, taskId `#4` shared with
`graph-finalizer.ts`) change in exactly one task, D1. Every drift file is an
artk0de silo, so there is no second owner to route review to; the tests are the
second reader.

---

## Epic A — Drift rules and gates (`tea-rags-mcp-j53pf`)

### Task A1: Fix drift docs that contradict code (`tea-rags-mcp-4s9tb`)

**Files:**

- Modify: `.claude-plugin/tea-rags/rules/index-freshness.md` (the "Why these
  three actions" bullet and the trigger table row for schema drift)
- Modify: `website/docs/operations/recovery-reindexing.md:73-81`
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (patch bump)

**Interfaces:** none (docs).

- [ ] **Step 1: Replace the false "guard rejects incremental" claim**

In `index-freshness.md`, replace the bullet that begins
`**Schema drift → \`force_reindex\`, with consent.\*\*` with:

```markdown
- **Schema drift → the command the warning names, with consent.** Drift =
  running code declares payload fields the existing index never populated. An
  incremental run neither refuses nor fixes it: unchanged files keep their old
  payload, so the warning persists until the named remedy has run —
  `tea-rags index-codebase --force-enrichments <trajectory>` when every new key
  is enrichment-owned (`git.*`, `codegraph.*`), `--force` when a chunker-owned
  key moved. Both rewrite shared state and `--force` is minutes to hours on a
  large project, so **never** run either automatically — ask first. See
  `/tea-rags:force-reindex`.
```

Replace the table row `| Prime \`## Schema drift\` section is **not** \`none\`
(lists new payload fields) | \`force_reindex\` (full rebuild) | **YES — explicit
consent** |` with:

```markdown
| Prime `## Schema drift` section is **not** `none` (lists new payload fields) |
the `Run:` command the section names (`--force-enrichments <trajectory>` or
`--force`) | **YES — explicit consent** |
```

- [ ] **Step 2: Replace the stale remedy in the website doc**

In `recovery-reindexing.md`, replace the "Additive drift" bullet with:

```markdown
- **Additive drift** (new fields, no new indexes) — detected by
  `SchemaDriftMonitor`. The warning names the narrowest command that repopulates
  the new keys: `tea-rags index-codebase --force-enrichments <trajectory>` when
  they are enrichment-owned (`git.*`, `codegraph.*`), `--force` only when a
  chunker-owned key moved. Existing search keeps working meanwhile.
```

- [ ] **Step 3: Bump the plugin patch version**

Run: `rg -n '"version"' .claude-plugin/tea-rags/.claude-plugin/plugin.json` and
raise the patch number by one.

- [ ] **Step 4: Lint**

Run:
`npx markdownlint-cli2 .claude-plugin/tea-rags/rules/index-freshness.md website/docs/operations/recovery-reindexing.md`
(or the `mcp__markdownlint__lint_markdown` tool). Expected: no findings.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/tea-rags/rules/index-freshness.md website/docs/operations/recovery-reindexing.md .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "docs(drift): make the freshness and recovery docs match the incremental path (4s9tb)"
```

### Task A2: Guard migration `.ts`/`.sql` twins with a byte-equality test (`tea-rags-mcp-c2mh8`)

**Files:**

- Test: `tests/core/domains/maintenance/migration/database/sql-twins.test.ts`

**Interfaces:**

- Consumes: `DATABASE_MIGRATIONS: DatabaseMigration[]`
  (`{ filename: string; sql: string }`) from
  `src/core/domains/maintenance/migration/database/migrations/index.ts`.

- [ ] **Step 1: Write the test**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";

const DIR = "src/core/domains/maintenance/migration/database/migrations";

/**
 * Production loads only the `.ts` twin; the `.sql` exists for the directory
 * path `runMigrations` accepts in tests. A twin that drifts changes nothing at
 * runtime and fails no build, so this is the only place the pair is checked.
 */
describe("database migration .ts/.sql twins", () => {
  it("every registered migration's sql is byte-identical to its .sql twin", () => {
    for (const migration of DATABASE_MIGRATIONS) {
      const twin = readFileSync(join(DIR, migration.filename), "utf8");
      expect(twin, migration.filename).toBe(migration.sql);
    }
  });

  it("every .sql file on disk is registered exactly once, in filename order", () => {
    const onDisk = readdirSync(DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(DATABASE_MIGRATIONS.map((m) => m.filename)).toEqual(onDisk);
  });
});
```

- [ ] **Step 2: Run it**

Run:
`npx vitest run tests/core/domains/maintenance/migration/database/sql-twins.test.ts`
Expected: PASS, or FAIL naming the drifted pair. Fix a failure in the `.sql` (or
`.ts`) file, never by normalising whitespace in the test.

- [ ] **Step 2b: Navigator**

In `src/core/domains/maintenance/CLAUDE.md`, the Gotchas bullet that begins
`**Every database migration ships twice, and only the \`.ts\` twin reaches
production.\*\*`ends with "so the drift is invisible until someone runs the disk path". Replace that clause with: "so`tests/core/domains/maintenance/migration/database/sql-twins.test.ts`pins every registered migration to its`.sql`
twin byte-for-byte and fails on the first divergence".

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/maintenance/CLAUDE.md tests/core/domains/maintenance/migration/database/sql-twins.test.ts
git commit -m "test(migration): pin every database migration to its .sql twin (c2mh8)"
```

### Task A3: Version-pins guard + `npm run pin:lang-versions` (`tea-rags-mcp-6a4qv`)

**Files:**

- Create: `src/core/domains/language/capability/version-axes.ts`
- Create: `src/core/domains/language/capability/version-pins.ts`
- Create: `scripts/pin-language-versions.ts`
- Create (generated): `tests/core/domains/language/capability/version-pins.json`
- Test: `tests/core/domains/language/capability/version-pins.test.ts`
- Modify: `package.json` (`scripts.pin:lang-versions`)
- Modify: `src/core/domains/language/CLAUDE.md` (Gotchas: the pin guard and the
  re-pin idiom, next to the "capability drift-guard is one-sided" bullet it
  completes)

**Interfaces:**

- Consumes: `LanguageFactory#capabilities(): Map<string, LanguageCapability>`;
  `LanguageCapability.versions: LanguageSupportVersions`
  (`{ chunking, walker, codegraphSchema }`).
- Produces: `versionAxisSources(language: string): VersionAxisSources[]`;
  `digestSources(source: VersionAxisSourceSet, root?: string): string | null`;
  `computeVersionPins(caps, root?): VersionPins`. C1 extends
  `versionAxisSources` for `"*"`.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { versionAxisSources } from "../../../../../src/core/domains/language/capability/version-axes.js";
import {
  digestSources,
  type VersionPins,
} from "../../../../../src/core/domains/language/capability/version-pins.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

const PINS_PATH = "tests/core/domains/language/capability/version-pins.json";

/**
 * A version number is a claim that the sources behind an axis produce what the
 * index stored. This pins the sources' digest to the declared version: change
 * the sources and either bump the version (output moved) or re-pin without a
 * bump (byte-identical claim, recorded in git). `npm run pin:lang-versions`
 * regenerates the pin file.
 */
describe("language version pins", () => {
  const caps = new LanguageFactory().capabilities();
  const pins = JSON.parse(readFileSync(PINS_PATH, "utf8")) as VersionPins;

  for (const [language, cap] of caps) {
    for (const { axis, paths } of versionAxisSources(language)) {
      const digest = digestSources(paths);
      if (digest === null) continue; // language has no sources on this axis

      it(`${language}.${axis} sources are pinned to version ${cap.versions[axis]}`, () => {
        const pin = pins[language]?.[axis];
        expect(
          pin,
          `no pin for ${language}.${axis} — run: npm run pin:lang-versions`,
        ).toBeDefined();
        expect(
          pin?.version,
          `${language}.${axis} declared version moved — run: npm run pin:lang-versions`,
        ).toBe(cap.versions[axis]);
        expect(
          pin?.digest,
          `${paths.join(", ")} changed since ${language}.${axis} v${cap.versions[axis]} was pinned. ` +
            `Bump versions.${axis} in ${language}/capability.ts if the output changed, then run: npm run pin:lang-versions. ` +
            `Re-pinning without a bump is a byte-identical claim — add "Versions: unchanged — <why>" to the commit body.`,
        ).toBe(digest);
      });
    }
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
`npx vitest run tests/core/domains/language/capability/version-pins.test.ts`
Expected: FAIL — module `version-axes.js` not found.

- [ ] **Step 3: Write the axis → sources map**

`src/core/domains/language/capability/version-axes.ts`:

```ts
/** The two axes a digest can stand behind; `codegraphSchema` stays hand-judged. */
export type PinnedVersionAxis = "chunking" | "walker";

export interface VersionAxisSources {
  readonly axis: PinnedVersionAxis;
  /** Directories or files, repo-relative. Missing entries are skipped. */
  readonly paths: readonly string[];
}

const LANGUAGE_ROOT = "src/core/domains/language";
const HOOKS_ROOT = "src/core/domains/ingest/pipeline/chunker/hooks";

/**
 * Which sources a language's `versions.<axis>` number vouches for. `walker`
 * covers walker + resolver chain + DSL grammar (the rule's "walker pass,
 * resolver chain, dispatch narrowing" row); `chunking` covers the language's
 * chunking hooks on both sides of the chunker boundary.
 */
export function versionAxisSources(language: string): VersionAxisSources[] {
  return [
    {
      axis: "chunking",
      paths: [
        `${LANGUAGE_ROOT}/${language}/chunking`,
        `${HOOKS_ROOT}/${language}`,
      ],
    },
    {
      axis: "walker",
      paths: [
        `${LANGUAGE_ROOT}/${language}/walker`,
        `${LANGUAGE_ROOT}/${language}/resolver`,
        `${LANGUAGE_ROOT}/${language}/dsl`,
      ],
    },
  ];
}
```

- [ ] **Step 4: Write the digest + pins module**

`src/core/domains/language/capability/version-pins.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { LanguageCapability } from "../../../contracts/types/language.js";
import { versionAxisSources, type PinnedVersionAxis } from "./version-axes.js";

export interface VersionPin {
  version: number;
  digest: string;
}

export type VersionPins = Record<
  string,
  Partial<Record<PinnedVersionAxis, VersionPin>>
>;

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .map((entry) => join(path, entry))
    .filter(
      (file) =>
        statSync(file).isFile() &&
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts"),
    );
}

/** sha256 over sorted repo-relative paths + contents; null when nothing exists. */
export function digestSources(
  source: VersionAxisSourceSet,
  root: string = process.cwd(),
): string | null {
  const files = source.paths.flatMap((p) => sourceFiles(join(root, p))).sort();
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function computeVersionPins(
  caps: Map<string, LanguageCapability>,
  root?: string,
): VersionPins {
  const pins: VersionPins = {};
  for (const [language, cap] of [...caps].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const { axis, paths } of versionAxisSources(language)) {
      const digest = digestSources(paths, root);
      if (digest === null) continue;
      (pins[language] ??= {})[axis] = { version: cap.versions[axis], digest };
    }
  }
  return pins;
}
```

- [ ] **Step 5: Write the generator script and npm alias**

`scripts/pin-language-versions.ts`:

```ts
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeVersionPins } from "../src/core/domains/language/capability/version-pins.js";
import { LanguageFactory } from "../src/core/domains/language/factory.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(
  root,
  "tests/core/domains/language/capability/version-pins.json",
);
const pins = computeVersionPins(new LanguageFactory().capabilities(), root);
writeFileSync(target, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
console.log(`✓ ${target} re-pinned for ${Object.keys(pins).length} languages.`);
```

`package.json`, next to `gen:lang-compat`:
`"pin:lang-versions": "tsx scripts/pin-language-versions.ts"`.

- [ ] **Step 6: Generate the pins and run the test**

Run:
`npm run pin:lang-versions && npx vitest run tests/core/domains/language/capability/version-pins.test.ts`
Expected: PASS. Then prove the gate: append a comment line to
`src/core/domains/language/bash/walker/walker.ts` (or any bash walker file),
rerun — expected FAIL with the bump-or-re-pin message; revert the line.

- [ ] **Step 6b: Navigator**

In `src/core/domains/language/CLAUDE.md`, directly after the bullet that begins
`**The capability drift-guard is one-sided.**`, add:

```markdown
- **The version pins close the other side.**
  `tests/core/domains/language/capability/version-pins.test.ts` hashes (sha256)
  every `.ts` under a language's `walker/`, `resolver/`, `dsl/` (axis `walker`)
  and `chunking/` + its chunker hooks (axis `chunking`) and pins the digest to
  `versions.<axis>` in `version-pins.json`. Any change under those paths — a
  comment included — turns the test red until you either bump the axis (output
  moved) or re-pin (`npm run pin:lang-versions`, byte-identical claim,
  `Versions: unchanged — <why>` in the commit body). `codegraphSchema` has no
  digest; it is judged by hand. Sources per axis: `capability/version-axes.ts`.
```

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/CLAUDE.md src/core/domains/language/capability/version-axes.ts src/core/domains/language/capability/version-pins.ts scripts/pin-language-versions.ts tests/core/domains/language/capability/version-pins.json tests/core/domains/language/capability/version-pins.test.ts package.json
git commit -m "test(language): pin walker and chunking sources to their declared versions (6a4qv)"
```

### Task A4: `migrations.md` creation-site paths + `initializeSchema` ⟺ schema-migrations invariant test (`tea-rags-mcp-lnddr`)

**Files:**

- Modify: `.claude/rules/migrations.md` (frontmatter `paths:` + "When to Add a
  Migration" table)
- Test: `tests/core/adapters/qdrant/schema-manager-migrations-parity.test.ts`

**Interfaces:**

- Consumes: `SchemaManager#initializeSchema(collectionName)`;
  `SchemaMigrator(collection, indexStore, { enableHybrid }, enrichmentStore?, snapshotStore?)#getMigrations()`;
  `IndexStore.ensureIndex(collection, field, type)`.

- [ ] **Step 1: Extend the rule's reach**

Add to `paths:` in `migrations.md`:

```yaml
- "src/core/adapters/qdrant/schema-manager.ts"
- "src/core/adapters/qdrant/sparse.ts"
- "src/core/domains/ingest/infra/collection-stats.ts"
- "src/core/domains/trajectory/*/stats/**/*.ts"
```

Add rows to the "When to Add a Migration" table:

```markdown
| Index added to `initializeSchema` for NEW collections | `schema` | The parity
test fails until the same index has a migration | | BM25 tokenizer / vocabulary
change in `sparse.ts` | `sparse` | Bump `sparseVersion`; rebuild sparse vectors
| | Percentile / stats formula change | `stats` | Derived-version check must see
the new field |
```

- [ ] **Step 2: Write the failing parity test**

Read `tests/core/adapters/qdrant/schema-manager.test.ts` first and reuse its
Qdrant fake shape for `initializeSchema` (it already stubs `createPayloadIndex`,
`getCollectionInfo`, `addPoints`). Then:

```ts
import { describe, expect, it } from "vitest";

import { SchemaManager } from "../../../../src/core/adapters/qdrant/schema-manager.js";
import { SchemaMigrator } from "../../../../src/core/domains/maintenance/migration/schema-migrator.js";
import type { IndexStore } from "../../../../src/core/domains/maintenance/migration/types.js";

type IndexKey = `${string}:${string}`;

function recordingIndexStore(seen: Set<IndexKey>): IndexStore {
  return {
    getSchemaVersion: async () => 0,
    ensureIndex: async (_c, field, type) => {
      seen.add(`${field}:${type}`);
      return true;
    },
    storeSchemaVersion: async () => undefined,
    hasPayloadIndex: async () => false,
    getCollectionInfo: async () => ({ hybridEnabled: true, vectorSize: 8 }),
    updateSparseConfig: async () => undefined,
    deletePointsByFilter: async () => undefined,
    scrollAllPayload: async () => [],
    batchSetPayload: async () => undefined,
    deletePayloadKeys: async () => undefined,
  };
}

/**
 * A fresh collection is stamped at LATEST_SCHEMA_VERSION, so every schema
 * migration is filtered out as already applied. Any index `initializeSchema`
 * forgets therefore never appears on a force-rebuilt collection (taxdome `_v13`:
 * schemaVersion 13, zero enrichedAt indexes). The two paths must create the
 * same index set.
 */
describe("initializeSchema ⟺ schema migrations parity", () => {
  it("creates exactly the indexes the migrations would", async () => {
    const fromInit = new Set<IndexKey>();
    const fakeQdrant = {
      createPayloadIndex: async (_c: string, field: string, schema: string) => {
        fromInit.add(`${field}:${schema}`);
      },
      getCollectionInfo: async () => ({ vectorSize: 8, hybridEnabled: true }),
      addPoints: async () => undefined,
      addPointsWithSparse: async () => undefined,
    };
    await new SchemaManager(fakeQdrant as never).initializeSchema("c");

    const fromMigrations = new Set<IndexKey>();
    const migrator = new SchemaMigrator(
      "c",
      recordingIndexStore(fromMigrations),
      { enableHybrid: true },
    );
    for (const migration of migrator.getMigrations()) await migration.apply();

    expect([...fromInit].sort()).toEqual([...fromMigrations].sort());
  });
});
```

- [ ] **Step 3: Run it**

Run:
`npx vitest run tests/core/adapters/qdrant/schema-manager-migrations-parity.test.ts`
Expected: PASS if the sets already agree; FAIL listing the asymmetric index. A
failure is fixed on the side that is missing the index (a new migration for a
set missing on the migration side; an `initializeSchema` line for the other),
never by filtering the sets.

- [ ] **Step 4: Commit**

```bash
git add .claude/rules/migrations.md tests/core/adapters/qdrant/schema-manager-migrations-parity.test.ts
git commit -m "test(migration): pin initializeSchema to the schema-migration index set (lnddr)"
```

### Task A5: `language-capability-sync.md` — bump before merge, `Versions:` trailer, stats paths (`tea-rags-mcp-c8d3c`)

**Files:**

- Modify: `.claude/rules/language-capability-sync.md`

**Interfaces:** none.

- [ ] **Step 1: Add the two missing sections**

Append after "Which `versions` number to bump":

```markdown
## When the bump lands

The bump is part of the branch, not of a later cleanup: it MUST be on the
worktree branch before the merge into `main`. A `chore(language): declare …`
commit at the end of a wave is fine (python does this); a release cut between
the merge and a bump that never came ships an index every user believes is
current. `tests/core/domains/language/capability/version-pins.test.ts` runs on
the merged result in CI and fails when walker / resolver / chunking sources
changed while neither the version nor the pin moved.

## Relocations and other byte-identical changes

Moving code into the kernel, extracting a helper, or renaming leaves `versions`
alone — but the claim that the output is byte-identical is a claim. Record it:
re-pin with `npm run pin:lang-versions` and put

    Versions: unchanged — <why the output cannot have moved>

in the commit body, the same way `silo-pairing.md` demands a `Why:` line. For
resolver relocations the evidence is the harness delta
(`scripts/codegraph-chain-tally.ts --lang <lang>` before and after, edge count
and resolveSuccessRate equal), not a reading of the diff. Seven ruby relocations
(2026-09-09/10) shipped on the reading alone; D4 of the drift program measures
them after the fact.
```

- [ ] **Step 2: Lint and commit**

Run: `npx markdownlint-cli2 .claude/rules/language-capability-sync.md`

```bash
git add .claude/rules/language-capability-sync.md
git commit -m "docs(rules): say when a language version bump lands and how a relocation records byte-identity (c8d3c)"
```

---

## Epic B — `maintenance/drift/` unification (`tea-rags-mcp-kiday`)

### Task B1: Extract the schema-drift core and `IndexDriftRemedy` out of `infra/stats-cache.ts` (`tea-rags-mcp-7fzfo`)

**Files:**

- Create: `src/core/domains/maintenance/drift/schema-drift.ts`
- Create: `src/core/domains/maintenance/drift/remedy.ts`
- Modify: `src/core/infra/stats-cache.ts` (delete `SchemaDrift`,
  `checkSchemaDrift`, `formatSchemaDriftWarning`, `DriftRemedy`,
  `resolveDriftRemedy`; keep `payloadFieldKeys` persistence)
- Modify: `src/core/domains/maintenance/schema-drift-monitor.ts` (imports)
- Test: `tests/core/domains/maintenance/drift/schema-drift.test.ts`,
  `tests/core/domains/maintenance/drift/remedy.test.ts` — the `describe` blocks
  for these functions move here from `tests/core/infra/stats-cache.test.ts`
  verbatim (find them with
  `rg -n "checkSchemaDrift|formatSchemaDriftWarning|resolveDriftRemedy" tests/`).

**Interfaces:**

- Produces: `SchemaDrift { added: string[]; removed: string[] }`;
  `checkSchemaDrift(cachedKeys: string[] | undefined, currentKeys: string[]): SchemaDrift | null`;
  `formatSchemaDriftWarning(drift, owners?): string`;
  `IndexDriftRemedy = { kind: "none" | "reindex" | "recompute"; hint: string }`
  (B3 replaces this shape with the lattice);
  `resolveSchemaDriftRemedy(drift, owners: readonly PayloadKeyOwner[]): IndexDriftRemedy`.

- [ ] **Step 1: Move the tests first (they must fail on the new import path)**

Create the two test files with the moved `describe` blocks, importing from
`../../../../../src/core/domains/maintenance/drift/schema-drift.js` and
`.../drift/remedy.js`; `resolveDriftRemedy` is referenced as
`resolveSchemaDriftRemedy` and `DriftRemedy` as `IndexDriftRemedy`: a rename,
not a rewrite of the assertions.

Run: `npx vitest run tests/core/domains/maintenance/drift` Expected: FAIL —
modules not found.

- [ ] **Step 2: Create `schema-drift.ts`**

```ts
import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";
import { resolveSchemaDriftRemedy, type IndexDriftRemedy } from "./remedy.js";

export interface SchemaDrift {
  added: string[];
  removed: string[];
}

/** Compare cached payload keys vs current. Returns null if no drift or no cached keys. */
export function checkSchemaDrift(
  cachedKeys: string[] | undefined,
  currentKeys: string[],
): SchemaDrift | null {
  if (!cachedKeys) return null;
  const cachedSet = new Set(cachedKeys);
  const currentSet = new Set(currentKeys);
  const added = currentKeys.filter((k) => !cachedSet.has(k));
  const removed = cachedKeys.filter((k) => !currentSet.has(k));
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

/**
 * Human-readable warning. With `owners`, the hint names the narrowest command
 * that repopulates the drifted keys; without them the legacy full-reindex hint
 * is kept for callers that have no attribution to give.
 */
export function formatSchemaDriftWarning(
  drift: SchemaDrift,
  owners?: readonly PayloadKeyOwner[],
): string {
  const remedy: IndexDriftRemedy | null = owners
    ? resolveSchemaDriftRemedy(drift, owners)
    : null;
  const lines: string[] = ["Payload schema changed since last indexing."];
  if (drift.added.length > 0) {
    const verb = remedy?.kind === "recompute" ? "recompute" : "reindex";
    lines.push(
      `New fields: ${drift.added.join(", ")} (require ${verb} to populate)`,
    );
  }
  if (drift.removed.length > 0) {
    lines.push(`Removed fields: ${drift.removed.join(", ")} (no longer used)`);
  }
  lines.push(
    remedy
      ? remedy.hint
      : "Run index_codebase with forceReindex=true to update.",
  );
  return lines.join("\n");
}
```

- [ ] **Step 3: Create `remedy.ts`** (the body of today's `resolveDriftRemedy`,
      renamed)

```ts
import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";
import type { SchemaDrift } from "./schema-drift.js";

export interface IndexDriftRemedy {
  kind: "none" | "reindex" | "recompute";
  hint: string;
}

export function resolveSchemaDriftRemedy(
  drift: SchemaDrift,
  owners: readonly PayloadKeyOwner[],
): IndexDriftRemedy {
  if (drift.added.length === 0) {
    return {
      kind: "none",
      hint: "Removed fields are simply ignored by the current build — no action required.",
    };
  }
  const ownerByKey = new Map(owners.map((o) => [o.key, o]));
  const trajectories = new Set<string>();
  for (const key of drift.added) {
    const owner = ownerByKey.get(key);
    // An unattributed key is treated as chunker-owned: assuming it is cheap to
    // recompute would hand back a command that silently populates nothing.
    if (!owner?.recomputable || owner.trajectory === undefined) {
      return { kind: "reindex", hint: "Run: tea-rags index-codebase --force" };
    }
    trajectories.add(owner.trajectory);
  }
  const scope = [...trajectories].sort().join(",");
  return {
    kind: "recompute",
    hint: `Run: tea-rags index-codebase --force-enrichments ${scope}`,
  };
}
```

- [ ] **Step 4: Delete the originals from `stats-cache.ts` and repoint
      importers**

Run:
`rg -n "checkSchemaDrift|formatSchemaDriftWarning|resolveDriftRemedy|DriftRemedy\b|SchemaDrift\b" src tests --glob '!**/drift/**'`
and change every hit to the new modules (`SchemaDriftMonitor`, `explore-ops.ts`,
any stats-recompute consumer). `StatsCache` keeps
`save(collection, stats, payloadFieldKeys)` / `load()` untouched.

- [ ] **Step 5: Run the suite**

Run:
`npx vitest run tests/core/domains/maintenance tests/core/infra/stats-cache.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/maintenance/drift src/core/infra/stats-cache.ts src/core/domains/maintenance/schema-drift-monitor.ts tests/core/domains/maintenance/drift tests/core/infra/stats-cache.test.ts
git commit -m "refactor(drift): move the schema-drift core out of the infra stats cache (7fzfo)"
```

### Task B2: Relocate `SchemaDriftMonitor` and `LanguageVersionDriftMonitor` into `maintenance/drift/` (`tea-rags-mcp-6vwim`)

**Files:**

- Move: `src/core/domains/maintenance/schema-drift-monitor.ts` →
  `src/core/domains/maintenance/drift/schema-drift-monitor.ts`
- Move: `src/core/domains/maintenance/language-version-drift-monitor.ts` →
  `src/core/domains/maintenance/drift/language-version-drift-monitor.ts`
- Move: `tests/core/domains/maintenance/schema-drift-monitor.test.ts` and
  `tests/core/domains/maintenance/language-version-drift-monitor.test.ts` →
  `tests/core/domains/maintenance/drift/`
- Create: `src/core/domains/maintenance/drift/index.ts`
- Modify importers: `src/core/api/public/app.ts`,
  `src/core/api/internal/ops/explore-ops.ts`,
  `src/core/api/internal/facades/explore-facade.ts`, `src/bootstrap/factory.ts`.

**Interfaces:** unchanged — exports keep their names.

- [ ] **Step 1: Move with history**

```bash
git mv src/core/domains/maintenance/schema-drift-monitor.ts src/core/domains/maintenance/drift/
git mv src/core/domains/maintenance/language-version-drift-monitor.ts src/core/domains/maintenance/drift/
git mv tests/core/domains/maintenance/schema-drift-monitor.test.ts tests/core/domains/maintenance/drift/
git mv tests/core/domains/maintenance/language-version-drift-monitor.test.ts tests/core/domains/maintenance/drift/
```

- [ ] **Step 2: Fix relative imports** in the moved files (`../../contracts/...`
      → `../../../contracts/...`, `../../infra/...` → `../../../infra/...`;
      tests gain one `../`) and repoint importers:
      `rg -l "maintenance/schema-drift-monitor|maintenance/language-version-drift-monitor" src tests`.

- [ ] **Step 3: Barrel**

`src/core/domains/maintenance/drift/index.ts`:

```ts
export {
  checkSchemaDrift,
  formatSchemaDriftWarning,
  type SchemaDrift,
} from "./schema-drift.js";
export { type IndexDriftRemedy, resolveSchemaDriftRemedy } from "./remedy.js";
export { SchemaDriftMonitor } from "./schema-drift-monitor.js";
export { LanguageVersionDriftMonitor } from "./language-version-drift-monitor.js";
```

- [ ] **Step 4: Verify**

Run:
`npx tsc --noEmit && npx vitest run tests/core/domains/maintenance tests/core/api tests/cli/prime`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/core/domains/maintenance tests/core/domains/maintenance src/core/api src/bootstrap/factory.ts
git commit -m "refactor(drift): relocate the drift monitors into maintenance/drift (6vwim)"
```

### Task B3: `IndexDriftMonitor` contract, `IndexDriftReporter`, remedy lattice fold (`tea-rags-mcp-omgln`)

**Files:**

- Create: `src/core/domains/maintenance/drift/monitor.ts`
- Create: `src/core/domains/maintenance/drift/report.ts`
- Modify: `src/core/domains/maintenance/drift/remedy.ts` (lattice replaces the
  `{kind, hint}` shape)
- Modify: `src/core/domains/maintenance/drift/schema-drift.ts`
  (`formatSchemaDriftWarning` renders through `renderIndexDriftRemedy`)
- Modify: both monitors (implement `IndexDriftMonitor#check`)
- Modify: `src/core/domains/maintenance/drift/index.ts`
- Test: `tests/core/domains/maintenance/drift/remedy.test.ts` (fold cases
  added), `tests/core/domains/maintenance/drift/report.test.ts`; the "returns
  null when already warned" / "already-checked collection" cases move from
  `schema-drift-monitor.test.ts` to `report.test.ts` (consumption moves with
  them); the "one command for the whole report" cases from
  `language-version-drift-monitor.test.ts` move to `remedy.test.ts`.

**Interfaces:**

- Produces:

```ts
export type IndexDriftAxis =
  | "payloadKeys"
  | "languageVersions"
  | "env"
  | "commit";
export interface IndexDriftFinding {
  axis: IndexDriftAxis;
  subject: string; // payload key | "<language>.<axis>" | env key | branch
  indexed: string;
  current: string;
  remedy: IndexDriftRemedy;
  note?: string;
}
export interface IndexDriftMonitor {
  readonly axis: IndexDriftAxis;
  check(collectionName: string): IndexDriftFinding[];
}
export type IndexDriftRemedy =
  | { kind: "none" }
  | { kind: "incremental" }
  | {
      kind: "recompute";
      trajectories: ReadonlySet<string>;
      languages: ReadonlySet<string> | null;
    }
  | { kind: "force" };
export function foldIndexDriftRemedies(
  remedies: readonly IndexDriftRemedy[],
): IndexDriftRemedy;
export function renderIndexDriftRemedy(
  remedy: IndexDriftRemedy,
  projectAlias?: string,
): string; // --project filled in when known
export interface IndexDriftReport {
  findings: readonly IndexDriftFinding[];
  remedy: IndexDriftRemedy;
  projectAlias?: string; // registry name of the collection, when registered
}
export class IndexDriftReporter {
  constructor(
    monitors: readonly IndexDriftMonitor[],
    resolveAlias?: (collectionName: string) => string | undefined,
  );
  checkByCollectionName(collectionName: string): IndexDriftReport | null;
  checkAndConsume(path: string): Promise<IndexDriftReport | null>; // once per collection per process, until reset
  reset(collectionName: string): void; // IndexingOps calls it after every run on the collection
}
export function formatIndexDriftReport(report: IndexDriftReport): string;
```

- [ ] **Step 1: Failing fold tests** (append to `remedy.test.ts`)

```ts
import {
  foldIndexDriftRemedies,
  renderIndexDriftRemedy,
  type IndexDriftRemedy,
} from "../../../../../src/core/domains/maintenance/drift/remedy.js";

const recompute = (
  trajectories: string[],
  languages: string[] | null,
): IndexDriftRemedy => ({
  kind: "recompute",
  trajectories: new Set(trajectories),
  languages: languages === null ? null : new Set(languages),
});

describe("foldIndexDriftRemedies", () => {
  it("is none over an empty list", () => {
    expect(foldIndexDriftRemedies([])).toEqual({ kind: "none" });
  });
  it("keeps the language narrowing when every recompute names a language", () => {
    const folded = foldIndexDriftRemedies([
      recompute(["codegraph"], ["ruby"]),
      recompute(["codegraph"], ["python"]),
    ]);
    expect(folded).toEqual(recompute(["codegraph"], ["python", "ruby"]));
  });
  it("drops the narrowing when one recompute is collection-wide", () => {
    const folded = foldIndexDriftRemedies([
      recompute(["codegraph"], ["ruby"]),
      recompute(["git"], null),
    ]);
    expect(folded).toEqual(recompute(["codegraph", "git"], null));
  });
  it("force subsumes every recompute", () => {
    expect(
      foldIndexDriftRemedies([recompute(["git"], null), { kind: "force" }]),
    ).toEqual({ kind: "force" });
  });
  it("incremental outranks none only", () => {
    expect(
      foldIndexDriftRemedies([{ kind: "none" }, { kind: "incremental" }]),
    ).toEqual({ kind: "incremental" });
    expect(
      foldIndexDriftRemedies([
        { kind: "incremental" },
        recompute(["git"], null),
      ]),
    ).toEqual(recompute(["git"], null));
  });
  it("renders one command", () => {
    expect(
      renderIndexDriftRemedy(recompute(["git", "codegraph"], ["ruby"])),
    ).toBe(
      "Run: tea-rags index-codebase --force-enrichments codegraph,git --languages ruby",
    );
    expect(renderIndexDriftRemedy({ kind: "force" })).toBe(
      "Run: tea-rags index-codebase --force",
    );
    expect(renderIndexDriftRemedy({ kind: "incremental" })).toBe(
      "Run: tea-rags index-codebase --project <alias>",
    );
    expect(renderIndexDriftRemedy({ kind: "incremental" }, "taxdome")).toBe(
      "Run: tea-rags index-codebase --project taxdome",
    );
    expect(renderIndexDriftRemedy(recompute(["git"], null), "taxdome")).toBe(
      "Run: tea-rags index-codebase --project taxdome --force-enrichments git",
    );
    expect(renderIndexDriftRemedy({ kind: "none" })).toBe(
      "No action required.",
    );
  });
});
```

Run: `npx vitest run tests/core/domains/maintenance/drift/remedy.test.ts` —
expected FAIL (`foldIndexDriftRemedies` not exported).

- [ ] **Step 2: Lattice in `remedy.ts`**

```ts
export type IndexDriftRemedy =
  | { kind: "none" }
  | { kind: "incremental" }
  | {
      kind: "recompute";
      trajectories: ReadonlySet<string>;
      languages: ReadonlySet<string> | null;
    }
  | { kind: "force" };

const RANK: Record<IndexDriftRemedy["kind"], number> = {
  none: 0,
  incremental: 1,
  recompute: 2,
  force: 3,
};

/**
 * Maximum over the lattice. Recomputes union their trajectories; the
 * `--languages` narrowing survives only when every recompute named one —
 * a collection-wide finding (shared kernel, env) widens the whole command.
 */
export function foldIndexDriftRemedies(
  remedies: readonly IndexDriftRemedy[],
): IndexDriftRemedy {
  let top: IndexDriftRemedy["kind"] = "none";
  const trajectories = new Set<string>();
  let languages: Set<string> | null = new Set<string>();
  for (const remedy of remedies) {
    if (RANK[remedy.kind] > RANK[top]) top = remedy.kind;
    if (remedy.kind !== "recompute") continue;
    for (const t of remedy.trajectories) trajectories.add(t);
    if (remedy.languages === null) languages = null;
    else if (languages !== null)
      for (const l of remedy.languages) languages.add(l);
  }
  if (top !== "recompute") return { kind: top };
  return {
    kind: "recompute",
    trajectories,
    languages: languages && languages.size > 0 ? languages : null,
  };
}

/**
 * One exact command. `--project` is filled in when the alias is known; an
 * incremental run needs a target, so it keeps a visible placeholder when it is
 * not, while recompute / force fall back to the CLI's cwd resolution.
 */
export function renderIndexDriftRemedy(
  remedy: IndexDriftRemedy,
  projectAlias?: string,
): string {
  const project = projectAlias ? ` --project ${projectAlias}` : "";
  switch (remedy.kind) {
    case "none":
      return "No action required.";
    case "incremental":
      return `Run: tea-rags index-codebase --project ${projectAlias ?? "<alias>"}`;
    case "force":
      return `Run: tea-rags index-codebase${project} --force`;
    case "recompute": {
      const scope = [...remedy.trajectories].sort().join(",");
      const languages = remedy.languages
        ? ` --languages ${[...remedy.languages].sort().join(",")}`
        : "";
      return `Run: tea-rags index-codebase${project} --force-enrichments ${scope}${languages}`;
    }
  }
}

export function resolveSchemaDriftRemedy(
  drift: SchemaDrift,
  owners: readonly PayloadKeyOwner[],
): IndexDriftRemedy {
  if (drift.added.length === 0) return { kind: "none" };
  const ownerByKey = new Map(owners.map((o) => [o.key, o]));
  const trajectories = new Set<string>();
  for (const key of drift.added) {
    const owner = ownerByKey.get(key);
    if (!owner?.recomputable || owner.trajectory === undefined)
      return { kind: "force" };
    trajectories.add(owner.trajectory);
  }
  return { kind: "recompute", trajectories, languages: null };
}
```

`formatSchemaDriftWarning` now ends with `renderIndexDriftRemedy(remedy)` when
owners are given; the legacy string stays for the no-owners path. The moved
`resolveDriftRemedy` tests assert on `kind` and on the rendered line — update
the expected hint strings only where the old `hint` field was asserted
(`"Run: …"` text is unchanged).

- [ ] **Step 3: Contract + reporter**

`monitor.ts` — the types from the Interfaces block above, nothing else.

`report.ts`:

```ts
import {
  resolveCollectionName,
  validatePath,
} from "../../../infra/collection-name.js";
import type {
  IndexDriftAxis,
  IndexDriftFinding,
  IndexDriftMonitor,
} from "./monitor.js";
import {
  foldIndexDriftRemedies,
  renderIndexDriftRemedy,
  type IndexDriftRemedy,
} from "./remedy.js";

export interface IndexDriftReport {
  findings: readonly IndexDriftFinding[];
  remedy: IndexDriftRemedy;
  /** Registry name of the collection, when one is registered — fills `--project`. */
  projectAlias?: string;
}

const AXIS_TITLE: Record<IndexDriftAxis, string> = {
  payloadKeys: "Payload keys",
  languageVersions: "Language versions",
  env: "Indexing env",
  commit: "Working tree",
};

export class IndexDriftReporter {
  private readonly consumed = new Set<string>();

  constructor(
    private readonly monitors: readonly IndexDriftMonitor[],
    private readonly resolveAlias: (
      collectionName: string,
    ) => string | undefined = () => undefined,
  ) {}

  checkByCollectionName(collectionName: string): IndexDriftReport | null {
    const findings = this.monitors.flatMap((monitor) =>
      monitor.check(collectionName),
    );
    if (findings.length === 0) return null;
    const projectAlias = this.resolveAlias(collectionName);
    return {
      findings,
      remedy: foldIndexDriftRemedies(findings.map((f) => f.remedy)),
      ...(projectAlias ? { projectAlias } : {}),
    };
  }

  /**
   * Once per collection per process, until `reset` — a search response carries
   * the warning one time per server session, and again after each index run.
   */
  async checkAndConsume(path: string): Promise<IndexDriftReport | null> {
    let collectionName: string;
    try {
      collectionName = resolveCollectionName(await validatePath(path));
    } catch {
      return null;
    }
    if (this.consumed.has(collectionName)) return null;
    this.consumed.add(collectionName);
    return this.checkByCollectionName(collectionName);
  }

  /** Called by `IndexingOps` after the stamps of a run are written (spec decision 13). */
  reset(collectionName: string): void {
    this.consumed.delete(collectionName);
  }
}

export function formatIndexDriftReport(report: IndexDriftReport): string {
  const byAxis = new Map<IndexDriftAxis, IndexDriftFinding[]>();
  for (const finding of report.findings) {
    byAxis.set(finding.axis, [...(byAxis.get(finding.axis) ?? []), finding]);
  }
  const lines: string[] = [];
  for (const [axis, findings] of byAxis) {
    lines.push(`${AXIS_TITLE[axis]}:`);
    for (const f of findings) {
      lines.push(
        `  ${f.subject}: ${f.indexed} → ${f.current}${f.note ? ` (${f.note})` : ""}`,
      );
    }
  }
  lines.push(renderIndexDriftRemedy(report.remedy, report.projectAlias));
  return lines.join("\n");
}
```

- [ ] **Step 4: Monitors implement `check`**

`SchemaDriftMonitor`:

```ts
readonly axis = "payloadKeys" as const;

check(collectionName: string): IndexDriftFinding[] {
  const stats = this.statsCache.load(collectionName);
  const drift = checkSchemaDrift(stats?.payloadFieldKeys, this.currentPayloadKeys);
  if (!drift) return [];
  const ownerByKey = new Map((this.payloadKeyOwners ?? []).map((o) => [o.key, o]));
  const remedyFor = (key: string): IndexDriftRemedy => {
    const owner = ownerByKey.get(key);
    if (!owner?.recomputable || owner.trajectory === undefined) return { kind: "force" };
    return { kind: "recompute", trajectories: new Set([owner.trajectory]), languages: null };
  };
  return [
    ...drift.added.map((key) => ({ axis: this.axis, subject: key, indexed: "absent", current: "declared", remedy: remedyFor(key) })),
    ...drift.removed.map((key) => ({ axis: this.axis, subject: key, indexed: "recorded", current: "absent", remedy: { kind: "none" } as const })),
  ];
}
```

`LanguageVersionDriftMonitor`:

```ts
readonly axis = "languageVersions" as const;

check(collectionName: string): IndexDriftFinding[] {
  const entry = this.registry.get(collectionName);
  if (!entry) return [];
  const stats = this.statsCache.load(collectionName);
  const present = Object.keys(stats?.distributions?.language ?? {});
  if (present.length === 0) return [];
  return LanguageVersionDriftMonitor.detectDrift(entry.languageVersions, this.currentVersions, present).flatMap((drift) =>
    drift.axes.map((axis) => ({
      axis: this.axis,
      subject: `${drift.language}.${axis.axis}`,
      indexed: String(axis.indexed),
      current: String(axis.current),
      remedy: CHUNK_SET_AXES.has(axis.axis)
        ? ({ kind: "force" } as const)
        : ({ kind: "recompute", trajectories: new Set(["codegraph"]), languages: new Set([drift.language]) } as const),
    })),
  );
}
```

`checkByCollectionName(): string | null` on both monitors becomes
`const report = new IndexDriftReporter([this]).checkByCollectionName(name); return report && formatIndexDriftReport(report);`
so B4 can swap consumers one at a time; `formatWarning` /
`resolveVersionDriftCommand` are deleted, their cases live in `remedy.test.ts`
now.

- [ ] **Step 5: Reporter tests** (`report.test.ts`)

```ts
import { describe, expect, it } from "vitest";

import type {
  IndexDriftFinding,
  IndexDriftMonitor,
} from "../../../../../src/core/domains/maintenance/drift/monitor.js";
import {
  formatIndexDriftReport,
  IndexDriftReporter,
} from "../../../../../src/core/domains/maintenance/drift/report.js";

const fixed = (findings: IndexDriftFinding[]): IndexDriftMonitor => ({
  axis: findings[0]?.axis ?? "payloadKeys",
  check: () => findings,
});

const keyFinding: IndexDriftFinding = {
  axis: "payloadKeys",
  subject: "git.file.ageDays",
  indexed: "absent",
  current: "declared",
  remedy: {
    kind: "recompute",
    trajectories: new Set(["git"]),
    languages: null,
  },
};
const languageFinding: IndexDriftFinding = {
  axis: "languageVersions",
  subject: "python.walker",
  indexed: "1",
  current: "3",
  remedy: {
    kind: "recompute",
    trajectories: new Set(["codegraph"]),
    languages: new Set(["python"]),
  },
};

describe("IndexDriftReporter", () => {
  it("returns null when no monitor reports", () => {
    expect(
      new IndexDriftReporter([fixed([])]).checkByCollectionName("c"),
    ).toBeNull();
  });

  it("folds findings from every monitor into one remedy", () => {
    const report = new IndexDriftReporter([
      fixed([keyFinding]),
      fixed([languageFinding]),
    ]).checkByCollectionName("c");
    expect(report?.findings).toHaveLength(2);
    expect(report?.remedy).toEqual({
      kind: "recompute",
      trajectories: new Set(["codegraph", "git"]),
      languages: null,
    });
  });

  it("renders one block per axis and exactly one Run: line", () => {
    const report = new IndexDriftReporter([
      fixed([keyFinding]),
      fixed([languageFinding]),
    ]).checkByCollectionName("c");
    const text = formatIndexDriftReport(report!);
    expect(text).toBe(
      [
        "Payload keys:",
        "  git.file.ageDays: absent → declared",
        "Language versions:",
        "  python.walker: 1 → 3",
        "Run: tea-rags index-codebase --force-enrichments codegraph,git",
      ].join("\n"),
    );
    expect(text.match(/^Run:/gm)).toHaveLength(1);
  });

  it("fills --project from the alias resolver", () => {
    const report = new IndexDriftReporter(
      [fixed([keyFinding])],
      () => "taxdome",
    ).checkByCollectionName("c");
    expect(formatIndexDriftReport(report!)).toContain(
      "Run: tea-rags index-codebase --project taxdome --force-enrichments git",
    );
  });

  it("reset makes checkAndConsume report the collection again", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);
    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    reporter.reset(
      resolveCollectionName(await validatePath("/tmp/test-project")),
    );
    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
  });

  // Moved from schema-drift-monitor.test.ts — consumption now lives here.
  it("checkAndConsume reports a collection once per process", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);
    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    expect(await reporter.checkAndConsume("/tmp/test-project")).toBeNull();
  });

  it("checkAndConsume swallows an invalid path", async () => {
    expect(
      await new IndexDriftReporter([fixed([keyFinding])]).checkAndConsume(""),
    ).toBeNull();
  });
});
```

- [ ] **Step 6: Run and commit**

Run: `npx tsc --noEmit && npx vitest run tests/core/domains/maintenance/drift`
Expected: PASS.

```bash
git add src/core/domains/maintenance/drift tests/core/domains/maintenance/drift
git commit -m "feat(drift): fold every monitor into one IndexDriftReport with one remedy (omgln)"
```

### Task B4: Wire the report — `App.checkIndexDrift`, `driftWarning`, prime `## Drift`, `get_index_status` (`tea-rags-mcp-p0phi`)

**Files:**

- Modify: `src/core/api/public/app.ts` (`AppDeps`:
  `driftReporter: IndexDriftReporter` replaces `schemaDriftMonitor` +
  `languageVersionDriftMonitor`; `App.checkIndexDrift` replaces
  `checkSchemaDrift` + `checkLanguageVersionDrift`)
- Modify: `src/core/api/internal/ops/explore-ops.ts:401-406` (`checkDrift` uses
  the reporter), `src/core/api/internal/facades/explore-facade.ts` (dep rename)
- Modify: `src/bootstrap/factory.ts:846-857, 899-911` (build the reporter with
  the registry alias resolver, pass it)
- Modify: `src/core/api/internal/ops/indexing-ops.ts` (`driftReporter.reset`
  after the stamps of every run — `fullIndex`, `tryIncrementalIndex`,
  `recomputeEnrichments`)
- Modify: `src/cli/prime/run-prime.ts:167-215`, `src/cli/prime/types.ts:15-44`,
  `src/cli/prime/format.ts:32-143`
- Modify: `src/mcp/tools/code/register-status-tools.ts` (append the block)
- Modify: `.claude-plugin/tea-rags/rules/index-freshness.md`,
  `.claude-plugin/tea-rags/rules/search-cascade.md` (`## Schema drift` →
  `## Drift`), `plugin.json` patch bump
- Test: `tests/cli/prime/format*.test.ts` (section rename),
  `tests/core/api/**/app*.test.ts`,
  `tests/core/api/internal/ops/explore-ops*.test.ts`

**Interfaces:**

- Produces:
  `App.checkIndexDrift(req: { path?: string; collection?: string }): Promise<string | null>`
  — the rendered report; `PrimeData.drift: string | null` keeps its name,
  `PrimeData.languageVersionDrift` is removed.

- [ ] **Step 1: Failing prime format test**

In `tests/cli/prime/format.test.ts` (or the closest existing digest test —
`rg -l "Schema drift" tests/cli/prime`), using that file's existing
indexed-status fixture as `baseData` and its fixed clock as `NOW`, change the
expectation for the drift block to a single section:

```ts
it("renders one ## Drift section with the report, or none", () => {
  const withDrift = formatPrime(
    {
      ...baseData,
      drift:
        "Language versions:\n  python.walker: 1 → 3\nRun: tea-rags index-codebase --force-enrichments codegraph --languages python",
    },
    NOW,
  );
  expect(withDrift).toContain("## Drift\nLanguage versions:");
  expect(withDrift).not.toContain("## Schema drift");
  expect(withDrift).not.toContain("## Language versions");
  expect(formatPrime({ ...baseData, drift: null }, NOW)).toContain(
    "## Drift\nnone",
  );
});
```

Run: `npx vitest run tests/cli/prime` — expected FAIL.

- [ ] **Step 2: `App`**

```ts
// AppDeps
driftReporter: IndexDriftReporter;
// App
checkIndexDrift: (req: { path?: string; collection?: string }) => Promise<string | null>;
// createApp
checkIndexDrift: async ({ path, collection }) => {
  const report = path
    ? await deps.driftReporter.checkAndConsume(path)
    : collection
      ? deps.driftReporter.checkByCollectionName(collection)
      : null;
  return report && formatIndexDriftReport(report);
},
```

Delete `checkSchemaDrift` / `checkLanguageVersionDrift` from the interface and
the object.

- [ ] **Step 3: `ExploreOps#checkDrift`**

```ts
private async checkDrift(path?: string, collectionName?: string): Promise<string | null> {
  if (!this.driftReporter) return null;
  const report = path
    ? await this.driftReporter.checkAndConsume(path)
    : collectionName
      ? this.driftReporter.checkByCollectionName(collectionName)
      : null;
  return report && formatIndexDriftReport(report);
}
```

`ExploreOpsDeps.schemaDriftMonitor?: SchemaDriftMonitor` →
`driftReporter?: IndexDriftReporter`; same rename in `ExploreFacade`'s deps.

- [ ] **Step 4: Factory**

Replace the two monitor constructions' consumers (keep the constructions):

```ts
const driftReporter = new IndexDriftReporter(
  [schemaDriftMonitor, languageVersionDriftMonitor],
  (collectionName) => collectionRegistry.get(collectionName)?.name,
);
// ExploreFacade deps: driftReporter,
// createApp deps:     driftReporter,
// IngestFacade / IndexingOps deps: driftReporter (for reset)
```

- [ ] **Step 4b: Reset consumption after every run**

In `IndexingOps`, after `stampLanguageVersions` (full index and codegraph
recompute) and after the registry record of an incremental run, call
`this.driftReporter?.reset(collectionName)`. Test in
`tests/core/api/internal/ops/indexing-ops*.test.ts`: a fake reporter records the
collection names it was reset for; one per run path.

- [ ] **Step 5: Prime**

`run-prime.ts`: one `ctx.app.checkIndexDrift({ path })` in the
`Promise.allSettled` tuple; `PrimeData.drift` receives it; drop
`languageVersionDrift`. `types.ts`: delete `languageVersionDrift` and its
comment; the `drift` comment becomes "Rendered `IndexDriftReport` — every axis,
one `Run:` line. Null = nothing moved." `format.ts`: replace the two blocks with

```ts
lines.push("");
lines.push("## Drift");
lines.push(data.drift ?? "none");
```

- [ ] **Step 6: Status tool**

In `register-status-tools.ts`, after the `indexed` text is built:
`const drift = await app.checkIndexDrift({ path }); if (drift) text += \`\n\n##
Drift\n${drift}\`;`.

- [ ] **Step 7: Plugin docs**

Replace every `## Schema drift` in `index-freshness.md` and `search-cascade.md`
with `## Drift`; the trigger-table row reads "Prime `## Drift` section is
**not** `none`". Bump `plugin.json` patch.

- [ ] **Step 8: Run everything and commit**

Run:
`npx tsc --noEmit && npx vitest run tests/cli/prime tests/core/api tests/mcp tests/core/domains/maintenance`
Expected: PASS.

```bash
git add src/core/api src/bootstrap/factory.ts src/cli/prime src/mcp/tools/code/register-status-tools.ts .claude-plugin/tea-rags tests
git commit -m "feat(drift): surface one Drift report in search responses, prime and get_index_status (p0phi)"
```

### Task B5: Navigator, `.claude/rules/index-drift.md` and the website `drift-detection` page (`tea-rags-mcp-o7w4u`)

**Files:**

- Create: `.claude/rules/index-drift.md`
- Create: `src/core/domains/maintenance/drift/CLAUDE.md` (navigator for the new
  directory)
- Modify: `.claude/CLAUDE.md` (Domain Navigators table gains the
  `domains/maintenance/drift/` row)
- Create: `website/docs/operations/drift-detection.md`
- Modify: `website/docs/operations/recovery-reindexing.md` (the "Schema Drift
  Recovery" section becomes a pointer to the new page)
- Modify: `src/core/domains/maintenance/CLAUDE.md` (Gotchas: the "Drift compares
  FEATURE-FLAG-dependent descriptors" bullet gains the pointer to the reporter;
  H1 unchanged)
- Modify: `.claude/rules/migrations.md:48-52` (point at `maintenance/drift/`
  instead of `SchemaDriftMonitor` alone)

- [ ] **Step 1: Write the rule**

```markdown
---
paths:
  - "src/core/domains/maintenance/drift/**"
  - "tests/core/domains/maintenance/drift/**"
---

# Index Drift (MANDATORY)

`maintenance/drift/` compares what an index STAMPED at index time against what
the current build or environment would produce now. Everything here is a pure
comparison. The line that decides what belongs:

- **Compare → here.** Reads a stamp (stats cache `payloadFieldKeys`, registry
  `languageVersions` / `env` / `indexedCommit`), reads the current value,
  returns `IndexDriftFinding[]`. No I/O beyond those reads.
- **Side effect → elsewhere.** Throws on mismatch (`EmbeddingModelGuard`,
  `adapters/qdrant/`), decides to spawn (`maintenance/freshness/`), upgrades a
  store (`maintenance/migration/`), rewrites payload
  (`ingest/pipeline/ enrichment/`). Those may CONSUME a finding; they never live
  here.

## One report, one remedy

Every monitor implements `IndexDriftMonitor#check(collectionName)`.
`IndexDriftReporter` folds the findings over
`none < incremental < recompute(trajectories, languages?) < force` (`remedy.ts`)
and `formatIndexDriftReport` renders ONE `Run:` line. A consumer that prints two
commands for one collection is a defect — add the monitor to the reporter in
`src/bootstrap/factory.ts`, do not render it separately.

## Adding a monitor

1. Decide the stamp: what the index run writes, where, and whether it is sticky
   (`registry/CLAUDE.md`). A monitor with no stamp compares nothing.
2. `readonly axis: IndexDriftAxis` — extend the union in `monitor.ts`.
3. Each finding's `remedy` comes from the lattice; `force` only when the chunk
   set moves, `recompute` names its trajectories, `languages: null` when the
   finding is collection-wide.
4. Register in `factory.ts`; tests in `tests/core/domains/maintenance/drift/`
   with a fake registry / stats cache — never a live Qdrant.
5. If the finding's cause has a rule (`language-capability-sync.md`,
   `index-format-versions.md`, `migrations.md`), link it from the finding's
   `note`, do not restate it.

## Why not `teaRagsVersion`

A package-version axis would flag drift on every release. The stamps above are
narrower and each names its own remedy.
```

- [ ] **Step 2: Navigator + migrations pointer**

In `src/core/domains/maintenance/CLAUDE.md`, the Gotchas bullet that begins
`**Drift compares FEATURE-FLAG-dependent descriptors against index-time keys.**`
gains, as its last sentence: "Since the drift program, `SchemaDriftMonitor` is
one of several `IndexDriftMonitor`s folded by `drift/report.ts`; the env-parity
case it describes is reported as an `env` finding with an attribution note
(`drift/env-drift-monitor.ts`), so read the `## Drift` block as a whole before
reindexing. Boundary and how to add a monitor: `.claude/rules/index-drift.md`."

In `.claude/rules/migrations.md`, replace the paragraph that begins
`**Drift detection is not a substitute either, and often cannot even see the change.**`
with:

```markdown
**Drift detection is not a substitute either, and often cannot even see the
change.** The monitors in `src/core/domains/maintenance/drift/` compare stamps —
payload keys, language versions, the indexing env, the indexed commit. A field
that lives in the stats cache, the snapshot, or the DuckDB file has no stamp, so
"the user will be warned" is false by construction outside those axes
(`.claude/rules/index-drift.md`).
```

- [ ] **Step 2b: Navigator for `drift/`**

`src/core/domains/maintenance/drift/CLAUDE.md` — local editing facts only, each
stated once, linking to `index-drift.md` for the boundary:

```markdown
# domains/maintenance/drift — stamps compared, never written

## Mechanics

- **Every monitor is a pure read.** Inputs are the stats cache
  (`payloadFieldKeys`), the registry entry (`languageVersions`, `env`,
  `RegistryGitState`) and the current build's declarations; the writers live in
  `ingest/pipeline/base.ts` (registry record),
  `api/internal/ops/ indexing-ops.ts` (`stampLanguageVersions`) and
  `infra/stats-cache.ts`. A monitor that needs a value nobody stamps has found a
  missing stamp, not a place to compute one.
- **`IndexDriftReporter` owns consumption.** `checkAndConsume` shows a
  collection once per process; `IndexingOps` calls `reset(collectionName)` after
  every run's stamps. A monitor never tracks "already shown".
- **The `Run:` line comes from the fold, not from a monitor.** A finding carries
  a lattice `remedy`; `foldIndexDriftRemedies` picks the maximum and unions
  recomputes; `renderIndexDriftRemedy` fills `--project` from
  `IndexDriftReport.projectAlias` (registry name resolved by the reporter).
  Rendering a command inside a monitor is a defect.
- **`EnvDriftMonitor` never reads `process.env`.** Its second constructor
  argument is the effective-env resolver the composition root builds (outer
  env > stored registry env > code default, the same replay
  `ProjectIngestFactory` performs). Comparing against the bare process env
  reports phantom drift for every project whose registry env differs.
- **`*` is a language to the version monitor.** `sharedVersions`
  (`language/kernel/capability.ts`) is compared unconditionally; its findings
  render with no `--languages`.

## Gotchas

- `checkByCollectionName` is silent when the stats cache has no language
  distribution — a collection indexed before stats existed reports nothing, not
  "no drift".
- A removed payload key folds to `none`; a report can therefore be non-empty and
  still say "No action required."

## See also

- `.claude/rules/index-drift.md` — boundary, lattice, how to add a monitor.
- `../CLAUDE.md` — the flag-conditional descriptor gotcha this directory
  inherits.
```

Add the row `| \`domains/maintenance/drift/\` | stamps compared never written,
reporter-owned consumption, lattice-only remedies
|`to the Domain Navigators table in`.claude/CLAUDE.md`.

- [ ] **Step 3: Website page**

`website/docs/operations/drift-detection.md` (Docusaurus front matter like its
siblings in `operations/`), sections in this order, each stating the facts
listed:

1. **What drift is** — a stamp written at index time vs what the current build,
   environment or working tree would produce; the index keeps working, the
   report tells you what is stale and the one command that fixes it.
2. **Where you see it** — the `driftWarning` field on search responses (once per
   server session per collection, again after every index run), the `## Drift`
   block in `tea-rags prime`, and `get_index_status`.
3. **Axes** — a table with one row per monitor: what is compared, what the stamp
   is, an example line (`python.walker: 1 → 3`). Rows shipped by this task:
   payload keys, language versions. Later tasks add their rows here (C1 `*`, C2
   env, C3 commit, C4 canary, D1 heal) — leave a `<!-- axes: extend below -->`
   marker.
4. **Reading a report** — `subject: indexed → current (note)`; what a `note`
   means (an env flip that explains payload-key drift).
5. **Remedies and their cost** — `none`, incremental (seconds), recompute
   (`--force-enrichments`, minutes, no re-embedding), force (hours on a large
   project, re-embeds everything); the report always names the cheapest command
   that repairs every finding, with `--project` filled in.
6. **After upgrading tea-rags** — why a report can appear with no change on your
   side (a walker or shared-kernel bump), and that running the named command
   once clears it.

In `recovery-reindexing.md`, replace the body of "Schema Drift Recovery" with
two sentences and a link to the new page.

- [ ] **Step 4: Lint and commit**

Run:
`npx markdownlint-cli2 .claude/rules/index-drift.md src/core/domains/maintenance/CLAUDE.md .claude/rules/migrations.md`

```bash
git add .claude/rules/index-drift.md .claude/CLAUDE.md src/core/domains/maintenance/CLAUDE.md src/core/domains/maintenance/drift/CLAUDE.md .claude/rules/migrations.md website/docs/operations/drift-detection.md website/docs/operations/recovery-reindexing.md
git commit -m "docs(drift): rule, navigator and user docs for the maintenance/drift subdomain (o7w4u)"
```

---

## Epic C — Remaining drift mechanisms (`tea-rags-mcp-sstan`)

### Task C1: Shared `*` axes — kernel capability, unconditional compare, `index-format-versions.md`, pin globs (`tea-rags-mcp-y6igo`)

**Files:**

- Create: `src/core/domains/language/kernel/capability.ts`
- Modify: `src/core/domains/language/capability/versions.ts:47-61`
  (`resolveLanguageCodeVersions` adds `*`)
- Modify: `src/core/domains/maintenance/drift/language-version-drift-monitor.ts`
  (`*` compared unconditionally; `languages: null` for `*`)
- Modify: `src/core/domains/language/capability/version-axes.ts` (`*` sources)
- Create: `.claude/rules/index-format-versions.md`
- Modify: `.claude/rules/language-capability-sync.md` (row for shared sources)
- Test: `tests/core/domains/language/capability/versions.test.ts`,
  `tests/core/domains/maintenance/drift/language-version-drift-monitor.test.ts`,
  `version-pins.test.ts` (iterates `"*"` too)

**Interfaces:**

- Produces: `SHARED_LANGUAGE = "*"`; `sharedVersions: LanguageSupportVersions`.

- [ ] **Step 1: Failing tests**

`versions.test.ts`:

```ts
it("declares the shared * pseudo-language without a grammar axis", () => {
  const resolved = resolveLanguageCodeVersions(
    new LanguageFactory().capabilities(),
    () => "1.0.0",
  );
  expect(resolved.get("*")).toEqual({
    chunking: 1,
    walker: 2,
    codegraphSchema: 1,
  });
  expect(resolved.get("*")?.grammar).toBeUndefined();
});
```

`language-version-drift-monitor.test.ts`:

```ts
it("compares * regardless of which languages the index holds", () => {
  const current = new Map([
    ["*", { chunking: 1, walker: 2, codegraphSchema: 1 }],
  ]);
  const drifts = LanguageVersionDriftMonitor.detectDrift(
    { "*": { walker: 1 } },
    current,
    ["ruby"],
  );
  expect(drifts).toEqual([
    { language: "*", axes: [{ axis: "walker", indexed: 1, current: 2 }] },
  ]);
});
it("a * finding recomputes codegraph for the whole collection", () => {
  // build the monitor with a registry stamping * walker 1 and a stats cache holding ruby only
  const finding = monitor.check("code_abc123")[0];
  expect(finding.subject).toBe("*.walker");
  expect(finding.remedy).toEqual({
    kind: "recompute",
    trajectories: new Set(["codegraph"]),
    languages: null,
  });
});
```

- [ ] **Step 2: Kernel capability**

```ts
import type { LanguageSupportVersions } from "../../../contracts/types/language.js";

/** Pseudo-language whose stamp vouches for every language at once. */
export const SHARED_LANGUAGE = "*";

/**
 * Versions of the sources every language vertical runs through. Bumped by
 * `.claude/rules/index-format-versions.md`; pinned by version-pins.test.ts.
 *
 * walker 2: the kernel gained return inference (4906f4fcc), type-fact channels
 * (fd51e5ce2), package re-export following (b88dd636b) and entry-narrowing
 * (2c321ba26) after every existing index stamped its languages at walker 1 —
 * edges moved for every language and no per-language number said so.
 */
export const sharedVersions: LanguageSupportVersions = {
  chunking: 1,
  walker: 2,
  codegraphSchema: 1,
};
```

`resolveLanguageCodeVersions`: after the loop,
`resolved.set(SHARED_LANGUAGE, { ...sharedVersions });`.

- [ ] **Step 3: Monitor**

In `detectDrift`, iterate `[...presentLanguages, SHARED_LANGUAGE]` (dedupe) —
`*` is never in the stats distribution, so it is appended explicitly; `check()`
maps `drift.language === SHARED_LANGUAGE` to `languages: null`.
`IndexingOps#stampLanguageVersions` needs no change: with no `--languages`
selector it stamps every key of `languageCodeVersions`, `*` included, and a
`--languages ruby` run correctly leaves `*` alone.

- [ ] **Step 4: Pin sources for `*`**

In `version-axes.ts`:

```ts
const SHARED_SOURCES: VersionAxisSources[] = [
  {
    axis: "chunking",
    paths: [
      "src/core/domains/ingest/pipeline/chunker/base.ts",
      "src/core/domains/ingest/pipeline/chunker/tree-sitter.ts",
      "src/core/domains/ingest/pipeline/chunker/markdown-chunker.ts",
      "src/core/domains/ingest/pipeline/chunker/character.ts",
      "src/core/domains/ingest/pipeline/chunker/symbol-id-disambiguator.ts",
      "src/core/domains/ingest/pipeline/chunker/chunk-navigation.ts",
      "src/core/domains/ingest/pipeline/chunker/utils/chunk-id.ts",
      "src/core/infra/symbolid",
    ],
  },
  {
    axis: "walker",
    paths: [
      "src/core/domains/language/kernel",
      "src/core/domains/language/resolver-chain.ts",
      "src/core/domains/language/cone-dispatch.ts",
      "src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts",
    ],
  },
];

export function versionAxisSources(language: string): VersionAxisSources[] {
  if (language === SHARED_LANGUAGE) return SHARED_SOURCES;
  …
}
```

`computeVersionPins` and the pins test iterate
`[...caps.keys(), SHARED_LANGUAGE]`, reading `sharedVersions` for `*`. Run
`npm run pin:lang-versions`.

- [ ] **Step 5: Rule**

`.claude/rules/index-format-versions.md`:

```markdown
---
paths:
  - "src/core/domains/language/kernel/**"
  - "src/core/domains/language/resolver-chain.ts"
  - "src/core/domains/language/cone-dispatch.ts"
  - "src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts"
  - "src/core/domains/ingest/pipeline/chunker/*.ts"
  - "src/core/domains/ingest/pipeline/chunker/utils/chunk-id.ts"
  - "src/core/infra/symbolid/**"
  - "src/core/contracts/types/codegraph-*.ts"
---

# Index Format Versions (MANDATORY)

These sources run under EVERY language. A change here moves every language's
output at once, and no `<lang>/capability.ts` number can say so. The stamp is
`sharedVersions` in `src/core/domains/language/kernel/capability.ts`, compared
for the `*` pseudo-language by `LanguageVersionDriftMonitor`.

| Change                                                                  | Bump                             | Hint recommends                                    |
| ----------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| chunk id hashing, symbolId classification, chunker boundaries, markdown | `sharedVersions.chunking`        | `tea-rags index-codebase --force`                  |
| kernel resolution, resolver chain, cone dispatch, resolution runner     | `sharedVersions.walker`          | `--force-enrichments codegraph` (no `--languages`) |
| edge kinds / columns every language writes (`codegraph-*.ts`, DDL)      | `sharedVersions.codegraphSchema` | `--force-enrichments codegraph` (no `--languages`) |

Byte-identical change → no bump, but re-pin (`npm run pin:lang-versions`) and a
`Versions: unchanged — <why>` line in the commit body
(`language-capability-sync.md`). The pin test is the gate.
```

Add to `language-capability-sync.md`'s bump table:
`| Shared kernel / chunker / symbolId (not under \`<lang>/\`) |
\`sharedVersions.<axis>\` — see \`index-format-versions.md\` | as that rule says
|`.

- [ ] **Step 5a: Navigator**

In `src/core/domains/language/CLAUDE.md`, after the version-pins bullet from A3,
add:

```markdown
- **`kernel/capability.ts` is the version of everything shared.**
  `sharedVersions` stamps the pseudo-language `*`: `walker` covers `kernel/**`,
  `resolver-chain.ts`, `cone-dispatch.ts` and the codegraph
  `resolution-runner.ts`; `chunking` covers the shared chunker files and
  `infra/symbolid/**`. A kernel change that alters resolution output bumps
  `sharedVersions.walker`, not eight per-language walkers; the pin test covers
  the `*` sources too. Rule: `.claude/rules/index-format-versions.md`.
```

- [ ] **Step 5b: Website page**

Add the `*` row to the axes table of
`website/docs/operations/drift-detection.md` (compared: shared kernel / chunker
versions; stamp: `languageVersions["*"]`; example `*.walker: 1 → 2`) and, under
"After upgrading tea-rags", the sentence that this release bumps the shared
walker so every index reports it once.

- [ ] **Step 6: Run and commit**

Run:
`npx tsc --noEmit && npx vitest run tests/core/domains/language/capability tests/core/domains/maintenance/drift`

```bash
git add src/core/domains/language/kernel/capability.ts src/core/domains/language/CLAUDE.md src/core/domains/language/capability tests/core/domains/language/capability src/core/domains/maintenance/drift tests/core/domains/maintenance/drift .claude/rules/index-format-versions.md .claude/rules/language-capability-sync.md website/docs/operations/drift-detection.md
git commit -m "feat(drift): version the shared kernel and chunker as the * pseudo-language (y6igo)"
```

### Task C2: `EnvDriftMonitor` — consequence class per env group, snapshot diff, flag-flip attribution (`tea-rags-mcp-lg361`)

**Files:**

- Modify: `src/core/domains/maintenance/registry/env-groups.ts`
  (`RegistryEnvGroup.consequence`)
- Create: `src/core/domains/maintenance/drift/env-drift-monitor.ts`
- Modify: `src/bootstrap/factory.ts` (register the monitor with an effective-env
  resolver built the way `ProjectIngestFactory#buildIngest` builds an index
  run's env)
- Modify: `website/docs/operations/drift-detection.md` (env row + the "phantom
  schema drift" paragraph)
- Modify: `src/core/domains/maintenance/drift/index.ts`
- Test: `tests/core/domains/maintenance/registry/env-groups.test.ts` (every
  group classified),
  `tests/core/domains/maintenance/drift/env-drift-monitor.test.ts`

**Interfaces:**

- Produces:
  `EnvConsequence = "chunk-set" | "enrichment:git" | "enrichment:codegraph" | "runtime"`;
  `RegistryEnvGroup.consequence: EnvConsequence`;
  `class EnvDriftMonitor implements IndexDriftMonitor` with
  `constructor(registry: Pick<CollectionRegistry, "get">, effectiveSnapshotFor: (stored: Readonly<Record<string, string>>) => Readonly<Record<string, string>>)`
  — the second argument builds the env the NEXT index run on that collection
  would use (outer env > stored registry env > code default, spec decision 6);
  the monitor never reads `process.env` itself.

- [ ] **Step 1: Failing tests**

`env-groups.test.ts`:

```ts
it("classifies every group by what a change to it invalidates", () => {
  const byCanonical = new Map(
    REGISTRY_ENV_GROUPS.map((g) => [g.canonical, g.consequence]),
  );
  for (const g of REGISTRY_ENV_GROUPS)
    expect(g.consequence, g.canonical).toBeDefined();
  expect(byCanonical.get("INGEST_CHUNK_SIZE")).toBe("chunk-set");
  expect(byCanonical.get("CODE_TEST_PATHS")).toBe("chunk-set");
  expect(byCanonical.get("EMBEDDING_MODEL")).toBe("chunk-set");
  expect(byCanonical.get("TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS")).toBe(
    "enrichment:git",
  );
  expect(byCanonical.get("CODEGRAPH_AMBIGUOUS_RESOLVE_MODE")).toBe(
    "enrichment:codegraph",
  );
  expect(byCanonical.get("INGEST_TUNE_CHUNKER_POOL_SIZE")).toBe("runtime");
  expect(byCanonical.get("QDRANT_TURBO_QUANT")).toBe("runtime");
});
```

`env-drift-monitor.test.ts`:

```ts
function registryWith(env: Record<string, string>) {
  return { get: () => ({ env }) } as never;
}
it("reports a value change whose consequence is not runtime, with the matching remedy", () => {
  const monitor = new EnvDriftMonitor(
    registryWith({
      TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12",
      INGEST_TUNE_CHUNKER_POOL_SIZE: "8",
    }),
    () => ({
      TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "6",
      INGEST_TUNE_CHUNKER_POOL_SIZE: "4",
    }),
  );
  expect(monitor.check("c")).toEqual([
    {
      axis: "env",
      subject: "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
      indexed: "12",
      current: "6",
      remedy: {
        kind: "recompute",
        trajectories: new Set(["git"]),
        languages: null,
      },
    },
  ]);
});
it("attributes a flag flip to the payload keys it explains", () => {
  const [finding] = new EnvDriftMonitor(
    registryWith({ CODEGRAPH_ENABLED: "true" }),
    () => ({ CODEGRAPH_ENABLED: "false" }),
  ).check("c");
  expect(finding.note).toBe(
    "explains any codegraph.* payload-key drift — restore the flag instead of rebuilding",
  );
  expect(finding.remedy).toEqual({ kind: "none" });
});
it("stays silent for keys present on one side only, and for legacy entries without a snapshot", () => {
  expect(
    new EnvDriftMonitor(
      registryWith({ INGEST_CHUNK_SIZE: "2000" }),
      () => ({}),
    ).check("c"),
  ).toEqual([]);
  expect(
    new EnvDriftMonitor({ get: () => ({}) } as never, () => ({
      INGEST_CHUNK_SIZE: "2000",
    })).check("c"),
  ).toEqual([]);
});
it("sees no drift when the effective env is the replayed stamp (no outer override)", () => {
  const stored = {
    INGEST_CHUNK_SIZE: "2000",
    CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "strict",
  };
  expect(
    new EnvDriftMonitor(registryWith(stored), (s) => s).check("c"),
  ).toEqual([]);
});
```

- [ ] **Step 2: Classify the groups**

`env-groups.ts`:

```ts
export type EnvConsequence =
  | "chunk-set"
  | "enrichment:git"
  | "enrichment:codegraph"
  | "runtime";

export interface RegistryEnvGroup {
  canonical: string;
  aliases: readonly string[];
  /** What a change to this value invalidates in an existing index. */
  consequence: EnvConsequence;
}
```

Classification (every entry in `REGISTRY_ENV_GROUPS` gets one):

| consequence            | canonical keys                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chunk-set`            | `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `INGEST_ENABLE_AST`, `INGEST_ENABLE_HYBRID`, `INGEST_CHUNK_SIZE`, `INGEST_CHUNK_OVERLAP`, `CODE_TEST_PATHS`                                              |
| `enrichment:git`       | `TRAJECTORY_GIT_ENABLED`, `TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`, `TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS`, `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES`, `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS`, `TRAJECTORY_GIT_SESSION_GAP_MINUTES` |
| `enrichment:codegraph` | `CODEGRAPH_ENABLED`, `CODEGRAPH_CUSTOM_EXCLUDE`, `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE`                                                                                                                                       |
| `runtime`              | everything else: URLs, `GIT_ADAPTER`, `EMBEDDING_DEVICE`, `OLLAMA_*`, every `*_TUNE_*`, `INGEST_PIPELINE_CONCURRENCY`, `CODEGRAPH_DB_*`, `QDRANT_*`                                                                       |

- [ ] **Step 3: Monitor**

```ts
import type { CollectionRegistry } from "../registry/collection-registry.js";
import {
  REGISTRY_ENV_GROUPS,
  type EnvConsequence,
} from "../registry/env-groups.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";
import type { IndexDriftRemedy } from "./remedy.js";

const FLAG_NOTES: Record<string, string> = {
  CODEGRAPH_ENABLED:
    "explains any codegraph.* payload-key drift — restore the flag instead of rebuilding",
  TRAJECTORY_GIT_ENABLED:
    "explains any git.* payload-key drift — restore the flag instead of rebuilding",
};

function remedyFor(consequence: EnvConsequence): IndexDriftRemedy {
  switch (consequence) {
    case "chunk-set":
      return { kind: "force" };
    case "enrichment:git":
      return {
        kind: "recompute",
        trajectories: new Set(["git"]),
        languages: null,
      };
    case "enrichment:codegraph":
      return {
        kind: "recompute",
        trajectories: new Set(["codegraph"]),
        languages: null,
      };
    case "runtime":
      return { kind: "none" };
  }
}

/**
 * Diffs the env snapshot the index run recorded against the env the NEXT run
 * on this collection would use — outer env > stored registry env > code
 * default, the replay `ProjectIngestFactory` performs. A finding therefore
 * means the outer env explicitly overrides a stamped value; a changed code
 * default is not drift, because replay keeps the stamped value (spec
 * decision 6). Only keys present on BOTH sides can drift: a legacy entry
 * without the key and an unset optional carry no claim.
 */
export class EnvDriftMonitor implements IndexDriftMonitor {
  readonly axis = "env" as const;

  constructor(
    private readonly registry: Pick<CollectionRegistry, "get">,
    private readonly effectiveSnapshotFor: (
      stored: Readonly<Record<string, string>>,
    ) => Readonly<Record<string, string>>,
  ) {}

  check(collectionName: string): IndexDriftFinding[] {
    const entry = this.registry.get(collectionName);
    const stored = entry?.env ?? entry?.tuning;
    if (!stored) return [];
    const effective = this.effectiveSnapshotFor(stored);
    const findings: IndexDriftFinding[] = [];
    for (const group of REGISTRY_ENV_GROUPS) {
      if (group.consequence === "runtime") continue;
      const indexed = stored[group.canonical];
      const current = effective[group.canonical];
      if (indexed === undefined || current === undefined || indexed === current)
        continue;
      const note = FLAG_NOTES[group.canonical];
      findings.push({
        axis: this.axis,
        subject: group.canonical,
        indexed,
        current,
        remedy: remedyFor(group.consequence),
        ...(note ? { note } : {}),
      });
    }
    return findings;
  }
}
```

- [ ] **Step 4: Factory** — the effective-env resolver lives in the composition
      root because `core/` must not import `bootstrap/`. Mirror
      `ProjectIngestFactory#buildIngest` (replay onto a COPY of the process env,
      never onto `process.env` itself):

```ts
const envDriftMonitor = new EnvDriftMonitor(collectionRegistry, (stored) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  replayRegistryEnv(stored, env);
  return buildRegistryEnvSnapshot(parseAppConfigZod(env));
});
```

      Add it to the reporter's monitor list.

- [ ] **Step 4b: Website page** — add the env row to the axes table (compared:
      the 41 canonical indexing keys by consequence class; stamp: the registry
      `env` snapshot; example
      `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: strict → first`) and a "Phantom schema
      drift" paragraph: a flipped `CODEGRAPH_ENABLED` / `TRAJECTORY_GIT_ENABLED`
      shows up as removed payload keys, the env row names the flag, restore the
      flag instead of rebuilding.

- [ ] **Step 5: Run and commit**

Run:
`npx tsc --noEmit && npx vitest run tests/core/domains/maintenance tests/bootstrap`

```bash
git add src/core/domains/maintenance/registry/env-groups.ts src/core/domains/maintenance/drift src/bootstrap/factory.ts tests/core/domains/maintenance website/docs/operations/drift-detection.md
git commit -m "feat(drift): report indexing-env changes by what they invalidate (lg361)"
```

### Task C3: `CommitDriftMonitor` — `indexedCommit` vs HEAD, dirty tree as a note (`tea-rags-mcp-zf3x0`)

**Files:**

- Create: `src/core/domains/maintenance/drift/commit-drift-monitor.ts`
- Modify: `src/bootstrap/factory.ts`,
  `src/core/domains/maintenance/drift/index.ts`
- Modify: `website/docs/operations/drift-detection.md` (commit row)
- Test: `tests/core/domains/maintenance/drift/commit-drift-monitor.test.ts`

**Interfaces:**

- Consumes: `CollectionEntry.indexedBranch / indexedCommit / indexedDirty`
  (`contracts/types/registry.ts:14-21`, written by
  `BaseIndexingPipeline#buildRegistryGitState`);
  `readRepoGitState(path): RepoGitState | null` (`infra/repo-git-state.ts`,
  reads refs from disk, no `git` process).
- Produces: `class CommitDriftMonitor implements IndexDriftMonitor` with
  `constructor(registry, readGitState = readRepoGitState)`.

- [ ] **Step 1: Failing test**

```ts
const entry = {
  path: "/p",
  indexedBranch: "main",
  indexedCommit: "abcdef1234567890",
  indexedDirty: false,
};
it("reports a moved HEAD with the incremental remedy", () => {
  const monitor = new CommitDriftMonitor({ get: () => entry } as never, () => ({
    branch: "main",
    commit: "0123456789abcdef",
    transient: false,
  }));
  expect(monitor.check("c")).toEqual([
    {
      axis: "commit",
      subject: "main",
      indexed: "abcdef1",
      current: "0123456",
      remedy: { kind: "incremental" },
      note: "HEAD moved since the last index run",
    },
  ]);
});
it("annotates a moved HEAD when the tree was dirty at index time", () => {
  const monitor = new CommitDriftMonitor(
    { get: () => ({ ...entry, indexedDirty: true }) } as never,
    () => ({ branch: "main", commit: "0123456789abcdef", transient: false }),
  );
  expect(monitor.check("c")[0]).toMatchObject({
    indexed: "abcdef1 (dirty)",
    note: "HEAD moved since the last index run; the tree was dirty when it was indexed",
  });
});
it("is silent when HEAD did not move, even if the tree was dirty at index time", () => {
  // A developer's tree is dirty for the whole session; a dirty-only finding could never clear (spec decision 7).
  const monitor = new CommitDriftMonitor(
    { get: () => ({ ...entry, indexedDirty: true }) } as never,
    () => ({ branch: "main", commit: entry.indexedCommit, transient: false }),
  );
  expect(monitor.check("c")).toEqual([]);
});
it("is silent without a stamp, outside a repo, or when nothing moved", () => {
  expect(
    new CommitDriftMonitor(
      { get: () => ({ path: "/p" }) } as never,
      () => null,
    ).check("c"),
  ).toEqual([]);
  expect(
    new CommitDriftMonitor({ get: () => entry } as never, () => null).check(
      "c",
    ),
  ).toEqual([]);
  expect(
    new CommitDriftMonitor({ get: () => entry } as never, () => ({
      branch: "main",
      commit: entry.indexedCommit,
      transient: false,
    })).check("c"),
  ).toEqual([]);
});
```

- [ ] **Step 2: Monitor**

```ts
import {
  readRepoGitState,
  type RepoGitState,
} from "../../../infra/repo-git-state.js";
import type { CollectionRegistry } from "../registry/collection-registry.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";

const short = (sha: string): string => sha.slice(0, 7);

/** The stamp is written at finalize (`buildRegistryGitState`); this is the reader. */
export class CommitDriftMonitor implements IndexDriftMonitor {
  readonly axis = "commit" as const;

  constructor(
    private readonly registry: Pick<CollectionRegistry, "get">,
    private readonly readGitState: (
      path: string,
    ) => RepoGitState | null = readRepoGitState,
  ) {}

  check(collectionName: string): IndexDriftFinding[] {
    const entry = this.registry.get(collectionName);
    if (!entry?.indexedCommit) return [];
    const state = this.readGitState(entry.path);
    if (!state?.commit) return [];
    // Only a moved HEAD is a finding. A dirty tree at index time is a note on
    // it: a dirty-only finding would never clear during a working session
    // (spec decision 7); uncommitted content is the merkle diff's business.
    if (state.commit === entry.indexedCommit) return [];
    return [
      {
        axis: this.axis,
        subject: entry.indexedBranch ?? "HEAD",
        indexed: `${short(entry.indexedCommit)}${entry.indexedDirty ? " (dirty)" : ""}`,
        current: short(state.commit),
        remedy: { kind: "incremental" },
        note: entry.indexedDirty
          ? "HEAD moved since the last index run; the tree was dirty when it was indexed"
          : "HEAD moved since the last index run",
      },
    ];
  }
}
```

- [ ] **Step 3: Register in the factory, add the website row, run, commit**

Website: the commit row in the axes table (compared: HEAD sha vs
`indexedCommit`; stamp: `RegistryGitState`; example
`main: abcdef1 (dirty) → 0123456`) and one sentence that the remedy is a plain
incremental run, which auto-update performs on its own when enabled.

```bash
git add src/core/domains/maintenance/drift src/bootstrap/factory.ts tests/core/domains/maintenance/drift website/docs/operations/drift-detection.md
git commit -m "feat(drift): report the commit the index was built at against HEAD (zf3x0)"
```

### Task C4: Canary vector in `EmbeddingModelGuard` (`tea-rags-mcp-ie819`)

**Files:**

- Modify: `src/core/adapters/qdrant/embedding-model-guard.ts` (constructor gains
  optional `embeddings`; marker gains `canary`; `ensureMatch` compares cosine)
- Modify: `src/core/contracts/constants.ts` (`EMBEDDING_CANARY_TEXT`,
  `EMBEDDING_CANARY_MIN_COSINE`)
- Modify: `src/bootstrap/factory.ts` (pass `infra.embeddings` to the guard)
- Test: `tests/core/adapters/qdrant/embedding-model-guard.test.ts`

**Interfaces:**

- Consumes: `EmbeddingProvider.embed(text): Promise<{ embedding: number[] }>`.
- Produces: marker payload field `canary: { text: string; vector: number[] }` on
  `INDEXING_METADATA_ID`; `EmbeddingModelMismatchError` reason text
  `same name, different weights (canary cosine 0.9412)`.

- [ ] **Step 1: Failing tests** — extend
      `tests/core/adapters/qdrant/embedding-model-guard.test.ts`, reusing its
      existing fake Qdrant (marker read/write) and adding a fake provider:

```ts
function providerReturning(vector: number[]) {
  return { embed: async () => ({ embedding: vector }) } as never;
}
const V = [1, 0, 0, 0];
const ORTHOGONAL = [0, 1, 0, 0];

describe("EmbeddingModelGuard canary", () => {
  it("writes the canary into a marker that has none", async () => {
    const qdrant = fakeQdrantWithMarker({ embeddingModel: "m" }); // existing helper in this file
    await new EmbeddingModelGuard(
      qdrant,
      "m",
      4,
      providerReturning(V),
    ).ensureMatch("c");
    expect(qdrant.marker("c").canary).toEqual({
      text: EMBEDDING_CANARY_TEXT,
      vector: V,
    });
  });

  it("passes when the same name embeds the canary to the same vector", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    await expect(
      new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(V)).ensureMatch(
        "c",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects the same name when the weights changed", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    await expect(
      new EmbeddingModelGuard(
        qdrant,
        "m",
        4,
        providerReturning(ORTHOGONAL),
      ).ensureMatch("c"),
    ).rejects.toThrow(/same name, different weights: canary cosine 0\.0000/);
  });

  it("without a provider behaves as before", async () => {
    const qdrant = fakeQdrantWithMarker({ embeddingModel: "m" });
    await new EmbeddingModelGuard(qdrant, "m", 4).ensureMatch("c");
    expect(qdrant.marker("c").canary).toBeUndefined();
  });
});
```

If the file has no marker helper yet, add `fakeQdrantWithMarker(payload)`
returning an object with the `scroll`/`setPayload`/`addPoints` methods the guard
calls and a `marker(collection)` accessor over its in-memory point — read
`readOrCreateMarker` (`embedding-model-guard.ts:89-188`) for the exact calls
before writing it.

- [ ] **Step 2: Implementation**

```ts
export const EMBEDDING_CANARY_TEXT =
  "tea-rags embedding canary: resolve(callSite) -> SymbolResolutionOutcome";
export const EMBEDDING_CANARY_MIN_COSINE = 0.999;

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
```

In `ensureMatch`, after the name comparison passes: if `this.embeddings` is set,
read `marker.canary`; when absent, embed and `setPayload` it (same backfill path
the model name uses); when present, embed and compare —
`< EMBEDDING_CANARY_MIN_COSINE` →
`throw new EmbeddingModelMismatchError(stored, \`${this.currentModel} (same
name, different weights: canary cosine ${cos.toFixed(4)})\`)`. Cache the verdict
per collection alongside the model name. A failed embed (provider down) skips
the canary and logs once, as the marker-read failure does today.

- [ ] **Step 3: Live threshold check (user-gated, self-index)** — with the guard
      built, run `tea-rags prime` twice, once against the primary ollama
      endpoint and once against the fallback (`EMBEDDING_BASE_URL` swapped): the
      canary must pass on both. If the cross-endpoint cosine is below 0.999, set
      `EMBEDDING_CANARY_MIN_COSINE` to the measured value minus 0.001 in this
      task and record the measurement in the constant's comment.

- [ ] **Step 3b: Website page** — under "Embedding model", state that the guard
      now also compares a canary vector, what the 409 message looks like
      (`same name, different weights: canary cosine 0.9412`), and that the fix
      is to point `EMBEDDING_MODEL` back or run `--force`.

- [ ] **Step 4: Commit**

```bash
git add src/core/adapters/qdrant/embedding-model-guard.ts src/core/contracts/constants.ts src/bootstrap/factory.ts tests/core/adapters/qdrant/embedding-model-guard.test.ts website/docs/operations/drift-detection.md
git commit -m "feat(adapters): reject an embedding model that kept its name but changed its weights (ie819)"
```

---

## Epic D — Staleness defects (`tea-rags-mcp-5wf6q`)

Run this epic from a second worktree (`EnterWorktree` name `drift-staleness`,
then `git merge --ff-only main`); it touches `ingest/pipeline/enrichment/**`,
`trajectory/codegraph/**` and `adapters/duckdb/**` only.

### Task D1: `a2ddb` — heal codegraph payload for symbols whose metrics moved (`tea-rags-mcp-snbvm`)

**Files:**

- Create:
  `src/core/domains/maintenance/migration/database/migrations/023-cg-signals-prev.ts` +
  `.sql` (+ entry in `migrations/index.ts`)
- Modify: `src/core/contracts/types/codegraph-storage.ts`
  (`GraphDbClient.diffSymbolSignals`, `refreshSymbolSignalsPrev`)
- Modify: `src/core/adapters/duckdb/client.ts` (`DuckDbGraphClient`
  implementation) and `src/core/adapters/duckdb/daemon/server.ts` (daemon RPC
  for both)
- Modify:
  `src/core/domains/trajectory/codegraph/symbols/graph-finalizer.ts:489-528`
  (`runMetricsRecompute` returns the changed set)
- Create:
  `src/core/domains/ingest/pipeline/enrichment/codegraph-payload-heal.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` (call the
  healer after finalize, excluding this run's `chunkMap` files)
- Modify: `src/core/domains/trajectory/codegraph/symbols/payload-signals.ts`
  (export the per-symbol / per-file builders the provider already uses — read
  the file first:
  `find_symbol(relativePath: "src/core/domains/trajectory/codegraph/symbols/payload-signals.ts")`)
- Test:
  `tests/core/domains/maintenance/migration/database/023-cg-signals-prev.test.ts`,
  `tests/core/domains/ingest/pipeline/enrichment/codegraph-payload-heal.test.ts`,
  `tests/core/adapters/duckdb/symbol-signals-diff.test.ts`

**Interfaces:**

- Produces:

```ts
export interface ChangedSymbolSignal { relPath: string; symbolId: string }
export interface ChangedFileSignal { relPath: string }
// GraphDbClient
diffSymbolSignals(): Promise<{ symbols: ChangedSymbolSignal[]; files: ChangedFileSignal[] }>;
refreshSymbolSignalsPrev(): Promise<void>;
// enrichment
export class CodegraphPayloadHealer {
  constructor(deps: {
    qdrant: Pick<QdrantManager, "scrollFiltered" | "batchSetPayload">;
    buildChunkSignals: (relPath: string, symbolId: string) => Promise<Record<string, unknown> | null>;
    buildFileSignals: (relPath: string) => Promise<Record<string, unknown> | null>;
  });
  heal(collectionName: string, changed: { symbols: ChangedSymbolSignal[]; files: ChangedFileSignal[] }, skipRelPaths: ReadonlySet<string>): Promise<{ pointsRewritten: number; filesTouched: number }>;
}
```

Proven template: none (`extract-project-patterns` locality `none`, 2026-09-10).
The nearest technique is `SparseStoreAdapter#rebuildSparseVectors` (scroll +
`batchSetPayload`) plus `EnrichmentCoordinator#scrollStoredChunks`. Review the
point mapping line by line; the live measurement in Step 7 is the acceptance
test.

- [ ] **Step 1: Migration 023** — `.sql` (and its byte-identical `.ts` twin
      exporting `SQL_023_CG_SIGNALS_PREV`):

```sql
-- Codegraph schema — previous-run symbol/file signals (bd tea-rags-mcp-a2ddb).
-- `cg_symbols_metrics` and the edge tables are recomputed wholesale every run,
-- but the Qdrant payload derived from them was rewritten only for files in the
-- run's chunk map. A file that stopped changing kept the fanIn / fanOut /
-- pageRank it had when it last changed while the graph under it moved. These
-- two tables hold the signals as of the END of the previous run; the finalizer
-- diffs the fresh signals against them and the payload healer rewrites exactly
-- the points whose signals moved. Empty after this migration, so the first run
-- heals every point once (one payload sweep, no extraction) and later runs are
-- bounded by what actually changed.
-- Mirrors 023-cg-signals-prev.ts — keep in sync.
CREATE TABLE IF NOT EXISTS cg_symbol_signals_prev (
  rel_path   VARCHAR NOT NULL,
  symbol_id  VARCHAR NOT NULL,
  fan_in     BIGINT  NOT NULL,
  fan_out    BIGINT  NOT NULL,
  page_rank  DOUBLE  NOT NULL,
  PRIMARY KEY (rel_path, symbol_id)
);

CREATE TABLE IF NOT EXISTS cg_file_signals_prev (
  rel_path  VARCHAR PRIMARY KEY,
  fan_in    BIGINT NOT NULL,
  fan_out   BIGINT NOT NULL
);
```

Register in `DATABASE_MIGRATIONS` as
`{ filename: "023-cg-signals-prev.sql", sql: SQL_023_CG_SIGNALS_PREV }`. Test:
run the migrations on a fresh DuckDB file (as `runner.test.ts` does) and assert
both tables exist with those columns; A2's twin test covers the pair.

- [ ] **Step 2: Diff + refresh in `DuckDbGraphClient`** (and the same two
      statements behind a daemon RPC)

```sql
-- CURRENT_SYMBOL_SIGNALS (a CTE both statements share)
WITH fi AS (
  SELECT target_symbol_id AS symbol_id, target_rel_path AS rel_path, count(*) AS fan_in
  FROM cg_symbols_edges_method WHERE target_symbol_id IS NOT NULL GROUP BY 1, 2
), fo AS (
  SELECT source_symbol_id AS symbol_id, source_rel_path AS rel_path, count(*) AS fan_out
  FROM cg_symbols_edges_method GROUP BY 1, 2
), cur AS (
  SELECT s.rel_path, s.symbol_id,
         coalesce(fi.fan_in, 0)  AS fan_in,
         coalesce(fo.fan_out, 0) AS fan_out,
         coalesce(m.page_rank, 0) AS page_rank
  FROM cg_symbols s
  LEFT JOIN fi USING (rel_path, symbol_id)
  LEFT JOIN fo USING (rel_path, symbol_id)
  LEFT JOIN cg_symbols_metrics m ON m.symbol_id = s.symbol_id
)
-- diffSymbolSignals (symbols half)
SELECT cur.rel_path, cur.symbol_id
FROM cur LEFT JOIN cg_symbol_signals_prev p USING (rel_path, symbol_id)
WHERE p.symbol_id IS NULL
   OR cur.fan_in <> p.fan_in OR cur.fan_out <> p.fan_out
   OR abs(cur.page_rank - p.page_rank) > 1e-12;
```

Files half: the same shape over `cg_symbols_files` with `fan_in` = count of
`cg_symbols_edges_file` rows by `target_rel_path`, `fan_out` by
`source_rel_path`, diffed against `cg_file_signals_prev`.
`refreshSymbolSignalsPrev()` =
`DELETE FROM <prev>; INSERT INTO <prev> SELECT * FROM cur` for both tables,
inside one transaction. Test (`symbol-signals-diff.test.ts`): seed two symbols
and one edge, refresh, add a second edge to symbol B, assert diff = `[B]`;
refresh again, assert diff = `[]`.

- [ ] **Step 3: Finalizer returns the changed set** — `runMetricsRecompute`
      (both the daemon-delegated and the inline path) ends with
      `return graphDb.diffSymbolSignals()`; `recomputeMetrics` returns it to the
      coordinator. `refreshSymbolSignalsPrev()` is called by the coordinator
      AFTER the heal succeeded, so a heal that throws leaves the diff standing
      for the next run.

- [ ] **Step 4: Healer**

```ts
/** One file's points per scroll; a file with more chunks than this is a chunker defect, not a heal concern. */
const HEAL_SCROLL_CAP = 10_000;

export class CodegraphPayloadHealer {
  constructor(private readonly deps: CodegraphPayloadHealerDeps) {}

  async heal(collectionName, changed, skipRelPaths) {
    const byFile = new Map<string, Set<string>>();
    for (const { relPath, symbolId } of changed.symbols) {
      if (skipRelPaths.has(relPath)) continue; // this run's chunk map rewrote these already
      (byFile.get(relPath) ?? byFile.set(relPath, new Set()).get(relPath)!).add(
        symbolId,
      );
    }
    for (const { relPath } of changed.files)
      if (!skipRelPaths.has(relPath))
        byFile.set(relPath, byFile.get(relPath) ?? new Set());

    let pointsRewritten = 0;
    for (const [relPath, symbolIds] of byFile) {
      const points = await this.deps.qdrant.scrollFiltered(
        collectionName,
        { must: [{ key: "relativePath", match: { value: relPath } }] },
        HEAL_SCROLL_CAP,
        undefined,
        ["symbolId", "codegraph"],
      );
      const file = await this.deps.buildFileSignals(relPath);
      const operations = [];
      for (const point of points) {
        const symbolId =
          typeof point.payload?.symbolId === "string"
            ? point.payload.symbolId
            : null;
        const chunk =
          symbolId && symbolIds.has(symbolId)
            ? await this.deps.buildChunkSignals(relPath, symbolId)
            : ((point.payload?.codegraph as any)?.symbols?.chunk ?? null);
        if (!file && !chunk) continue;
        operations.push({
          points: [point.id],
          payload: {
            codegraph: {
              symbols: {
                ...(file ? { file } : {}),
                ...(chunk ? { chunk } : {}),
              },
            },
          },
        });
      }
      if (operations.length > 0) {
        await this.deps.qdrant.batchSetPayload(collectionName, operations);
        pointsRewritten += operations.length;
      }
    }
    return { pointsRewritten, filesTouched: byFile.size };
  }
}
```

`buildChunkSignals` / `buildFileSignals` are the provider's own builders keyed
by symbol / path (exported from `payload-signals.ts` after reading it in Step 0)
— the heal writes the same shape the provider writes, including a fresh
`enrichedAt`. Test with `MockQdrantManager` from
`tests/core/domains/ingest/__helpers__/test-helpers.ts`: three points in two
files, one file skipped, assert exactly the expected `batchSetPayload`
operations.

- [ ] **Step 5: Coordinator** — after finalize (`applyFinalizeFile` has run for
      this run's files):
      `const changed = <from recomputeMetrics>; const result = await healer.heal(collectionName, changed, new Set(state.deferredChunkMap.keys())); await graphDb.refreshSymbolSignalsPrev();`
      with a `pipelineLog` line
      `codegraph heal: ${pointsRewritten} points / ${filesTouched} files`.

- [ ] **Step 6: Unit gate** —
      `npx tsc --noEmit && npx vitest run tests/core/domains/ingest tests/core/adapters/duckdb tests/core/domains/maintenance/migration`.

- [ ] **Step 7: Live validation (user-gated, taxdome)** — ask first. (1)
      `DEBUG=1 tea-rags index-codebase --project taxdome --force-enrichments codegraph --json`
      as the baseline; (2) edit one hub file (add a call from a hub to a leaf),
      commit locally; (3) incremental
      `tea-rags index-codebase --project taxdome`; (4) count points whose
      `codegraph.symbols.chunk.fanIn` differs from `cur.fan_in` in DuckDB.
      Expected: 0 after the heal. For the "before" number, run the same sequence
      once on a scratch build with the `healer.heal(...)` call in the
      coordinator commented out; there is deliberately no runtime flag to switch
      the heal off. Record both numbers in the bead.

- [ ] **Step 7a: Navigators** — two facts, each in the directory that owns it:
      `src/core/domains/ingest/pipeline/enrichment/CLAUDE.md` (the payload-key
      ownership section) gains "`CodegraphPayloadHealer` is the second writer of
      `codegraph.symbols.{chunk,file}.*`: it rewrites points OUTSIDE the run's
      `chunkMap` whose derived signals moved, always after `applyFinalizeFile`,
      never touching `enrichedAt` semantics — a third writer needs the same
      builders (`payload-signals.ts`) or the two drift apart";
      `src/core/domains/trajectory/codegraph/CLAUDE.md` gains
      "`cg_symbol_signals_prev` / `cg_file_signals_prev` (migration 023) are
      refreshed by the coordinator AFTER a successful heal, not by the finalizer
      — refreshing them before the heal would hide the diff a failed heal must
      retry".

- [ ] **Step 7b: Website page** — a "Codegraph payload heal" section: the
      finalizer now rewrites the codegraph signals of every symbol whose fan-in
      / fan-out / pageRank moved, file change or not; the first run after
      upgrading does one full payload sweep (no re-extraction, no embeddings);
      `isHub` stays as it was until the next `--force-enrichments codegraph`.

- [ ] **Step 8: Commit** (implementation) and close `tea-rags-mcp-a2ddb` with
      the measured numbers.

```bash
git add src/core/domains/maintenance/migration/database/migrations src/core/contracts/types/codegraph-storage.ts src/core/adapters/duckdb src/core/domains/trajectory/codegraph src/core/domains/ingest/pipeline/enrichment tests website/docs/operations/drift-detection.md
git commit -m "fix(pipeline): heal codegraph payload for symbols whose metrics moved without a file change (snbvm)"
```

### Task D2: `sz1y0` spike — why unchanged files fail the `content_hash` match on the repair leg (`tea-rags-mcp-gl96z`)

Diagnosis runs in the parent session (model routing); its deliverable is a
verdict, not code.

**Files:**

- Read: `src/core/domains/ingest/pipeline/enrichment/extraction-repair.ts:43-64`
  (`computeExtractionRepair`), the write leg that stamps
  `cg_symbols_files.content_hash`
  (`rg -n "content_hash" src/core/adapters/duckdb src/core/domains/trajectory/codegraph`),
  and the scan leg's hashing.

- [ ] **Step 1: Instrument** — a temporary `pipelineLog` line in
      `computeExtractionRepair` printing
      `(relPath, scannedHash, persistedHash, byteLength)` for every mismatch.
      Throwaway; not committed.
- [ ] **Step 2: Controlled re-run** — on the `ex28m` fixture (or
      `tests/fixtures/codegraph-ts`): index once, run a second incremental with
      no file change, capture the mismatch lines.
- [ ] **Step 3: Classify** the cause into one of: (a) different hash algorithm
      or encoding between legs (hex vs base64, sha1 vs sha256); (b) different
      bytes hashed (CRLF / BOM / trailing-newline normalisation on one leg
      only); (c) different path key (worktree-relative vs project-relative,
      symlink resolution); (d) rows written with an empty hash by one write path
      (memory: the ex28m wave found "no NULL-hash treadmill" — re-check after
      020).
- [ ] **Step 4: Record** the verdict as a comment on `tea-rags-mcp-sz1y0` and
      `tea-rags-mcp-gl96z` with the captured lines; decide the Program-admission
      question (D3) from the size of the honest repair set: if a correct compare
      selects ≤ 50 files per typical run, the repair leg does not need a
      `ts.Program` and the precision delta is accepted and documented; if it
      selects hundreds, D3 admits the Program.

### Task D3: `sz1y0` fix — hash comparison per spike verdict + Program admission decision (`tea-rags-mcp-0ij6v`)

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/extraction-repair.ts`,
  the write-leg hash site, and (if the verdict is (a)/(b)) a migration
  `024-cg-symbols-files-content-hash-rehash.{ts,sql}` that clears `content_hash`
  so the next run restamps in the canonical form.
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/extraction-repair.test.ts`

**Interfaces:**

- Produces: `contentHashOf(bytes: Uint8Array): string` — ONE function in
  `src/core/domains/trajectory/codegraph/symbols/content-hash.ts`, imported by
  both legs. Whatever the verdict, the fix is that both legs call it.

- [ ] **Step 1: Failing test** — the repair set for a corpus whose files did not
      change is empty: build two scans of the same fixture through both legs'
      hashing and assert `computeExtractionRepair(scanned, persisted).files` is
      `[]`.
- [ ] **Step 2: Implement** — introduce `contentHashOf` (sha256 hex over the raw
      file bytes, no normalisation), replace both call sites, add migration 024
      when the persisted form differs from the canonical one.
- [ ] **Step 3: Program admission** — per the D2 verdict: either route the
      repair leg through the same admission function the live run uses
      (`whole-Program auto+roots-union`, memory `6aytq`) when the repair set
      exceeds the live threshold, or add a comment block in `runRepairPass`
      stating the accepted precision delta and the measured repair-set size.
- [ ] **Step 4: Live check (user-gated)** — an incremental on taxdome with no
      changes: expected `repair: 0 files`. Close `tea-rags-mcp-sz1y0` with the
      number.

```bash
git commit -m "fix(pipeline): hash the same bytes on the scan and write legs of the codegraph repair pass (0ij6v)"
```

### Task D4: Ruby walker — measure the edge delta after the kernel relocations (`tea-rags-mcp-e8wbs`)

**Files:**

- Modify: `src/core/domains/language/ruby/capability.ts` (bump `walker` to 2 if
  the delta is non-zero) and
  `tests/core/domains/language/capability/version-pins.json` (re-pin either way)

- [ ] **Step 1: Offline baseline** — from a throwaway worktree at `63832af60`
      (the `frwka` merge, before the seven relocations):
      `npx tsx scripts/codegraph-chain-tally.ts --lang ruby` on the mastodon
      fixture used by the Ruby recall wave; save edges / resolved / unresolved
      counts.
- [ ] **Step 2: Current** — the same tally on HEAD.
- [ ] **Step 3: Decide** — any difference in edge count, resolved count, or
      per-receiver-kind rates →
      `versions: { chunking: 1, walker: 2, codegraphSchema: 2 }` with a comment
      naming the relocation commits
      (`c95552c0e 3c7e162f1 72d73a0db 794e78b5d 17c3d902f 768b1db9a 9c971f176`);
      identical → re-pin only, commit body
      `Versions: unchanged — chain tally identical at 63832af60 and HEAD (edges N, resolved M)`.
- [ ] **Step 4: Commit**

```bash
git add src/core/domains/language/ruby/capability.ts tests/core/domains/language/capability/version-pins.json
git commit -m "chore(language): settle the ruby walker version after the kernel relocations (e8wbs)"
```

---

## Verification per epic

| Epic | Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `npm run test:coverage` green; A3's test red on a deliberate walker edit, green after re-pin; A4's test red when an index is added on one side only                                                                                                                                                                                                                                                                                                                     |
| B    | `npm run test:coverage` green; `tea-rags prime` on the self-index shows one `## Drift` block whose `Run:` line carries `--project tea-rags`; a `semantic_search` response carries one `driftWarning` with findings from two axes (language + the removed-key finding of a server started with `CODEGRAPH_ENABLED=false`); the report shows again after an incremental run; `website/docs/operations/drift-detection.md` exists and `recovery-reindexing.md` links to it |
| C    | setting `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE` in the MCP server env to a value that differs from the stamp produces an env finding on the self-index without a reindex, and removing the override clears it; a local commit produces a commit finding, a dirty tree alone does not; C4's canary passes on both ollama endpoints; the website axes table has the `*`, env, commit and canary rows                                                                           |
| D    | taxdome numbers recorded on `a2ddb` (stale points 0 after heal) and `sz1y0` (repair set 0 on an unchanged tree); D4's tally delta recorded on the bead                                                                                                                                                                                                                                                                                                                  |

Every live run is user-gated; ask, state the exact command, wait.
