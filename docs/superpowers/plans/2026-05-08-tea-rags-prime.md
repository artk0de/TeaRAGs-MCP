# `tea-rags prime` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (chained from `dinopowers:subagent-driven-development` if delegating per-task)
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Add `tea-rags prime <PATH>` CLI subcommand that emits a markdown
digest of `getIndexStatus` + `getIndexMetrics` (primary language only) +
`checkSchemaDrift` for SessionStart/PreCompact hook autofire.

**Architecture:** New CLI subcommand at `src/cli/commands/prime.ts` consumes the
existing `App` facade via `createAppContext()`. Pure markdown formatter at
`src/cli/prime/format.ts` is unit-testable without bootstrap. Plugin
`SessionStart` and `PreCompact` hooks gain a second command line that runs
`tea-rags prime "$CLAUDE_PROJECT_DIR"` in addition to the existing
`inject-rules.sh`.

**Tech Stack:** TypeScript (strict), yargs, vitest. Reuses existing `App` facade
(`src/core/api/public/app.ts`) and bootstrap (`src/bootstrap/factory.ts`). No
new external dependencies.

**Spec:** `docs/superpowers/specs/2026-05-08-tea-rags-prime-design.md` (commit
`c53895f3`).

**DO NOT MODIFY:** `src/mcp/tools/code.ts` — high bug-fix-rate hot zone. Reuse
`App` facade methods only.

**Layer rule:** CLI consumes `core/api/public/`. Never import from
`core/domains/*` or `core/contracts/*` directly.

---

## Task 1: Discovery — lock open spec items inline

**Files:**

- Read: `src/core/api/public/dto/ingest.ts` (`IndexStatus`)
- Read: `src/core/api/public/dto/metrics.ts` (`IndexMetrics`, `SignalMetrics`)
- Read: `src/core/api/public/app.ts` (App interface)
- Read: `src/core/types.ts:119` (`IndexingStatus` enum)
- Read: `src/core/adapters/qdrant/embedded/daemon.ts:153` (Qdrant ping pattern)
- Modify: `docs/superpowers/specs/2026-05-08-tea-rags-prime-design.md` (resolve
  Open Items inline)

- [ ] **Step 1: Read each file and confirm the locked-down facts.**

The plan uses these exact shapes — verify they still match before any code:

```ts
// src/core/api/public/dto/ingest.ts (IndexStatus)
interface IndexStatus {
  isIndexed: boolean;                  // @deprecated
  status: IndexingStatus;               // "not_indexed" | "indexing" | "indexed" | "stale_indexing" | "unavailable"
  collectionName?: string;
  filesCount?: number;
  chunksCount?: number;
  lastUpdated?: Date;
  languages?: string[];                 // PRIMARY-LANGUAGE source
  embeddingModel?: string;
  qdrantUrl?: string;
  enrichment?: EnrichmentHealthMap;
  sparseVersion?: number;
  infraHealth?: { qdrant: {...}; embedding: {...} };
}

// src/core/api/public/dto/metrics.ts (IndexMetrics)
interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;
  distributions: Distributions;
  signals: Record<string, Record<string, Record<string, SignalMetrics>>>;
  // signals[lang][signalName][scope] where scope ∈ { "source", "test" }
  enrichment?: EnrichmentHealthMap;
}

interface SignalMetrics {
  min: number;
  max: number;
  mean?: number;
  count: number;
  labelMap: Record<string, number>;     // e.g. { high: 12, extreme: 30 }
}

// src/core/api/public/app.ts (App)
interface App {
  // ... other methods ...
  getIndexStatus: (path: string) => Promise<IndexStatus>;
  getIndexMetrics: (path: string) => Promise<IndexMetrics>;
  checkSchemaDrift: (ref: { path: string } | { collection: string }) => Promise<string | null>;
}
```

- [ ] **Step 2: Verify `IndexStatus.languages` ordering (sort by chunks count
      desc?).**

Run:
`grep -rn "languages\s*=\|languages:\|languages\[" src/core/domains/ingest/ src/core/api/internal/facades/ingest-facade.ts 2>/dev/null | head -20`

If `languages` is sorted by chunks count desc → use `languages[0]` as primary.
If not sorted → derive primary from `IndexMetrics.signals` keys via
`Object.keys(metrics.signals)[0]` after sorting by some chunks signal count.

Lock down whichever holds, write the heuristic into Task 5.

- [ ] **Step 3: Edit the spec to remove "Open Items" entries that are now
      locked.**

In `docs/superpowers/specs/2026-05-08-tea-rags-prime-design.md`, replace the
"Open Items" section with:

```markdown
## Locked details (resolved 2026-05-08)

- **`IndexMetrics.labelMap` shape**: `Record<string, number>` (label name →
  threshold value). Source: `src/core/api/public/dto/metrics.ts`.
- **Primary-language source**: `IndexStatus.languages[0]` (first element of the
  `languages: string[]` array on `IndexStatus`). The `chunkCounts` field
  referenced earlier in the spec does NOT exist; use `languages` instead.
- **Qdrant ping endpoint**: `GET /readyz` with `AbortSignal.timeout(200)`.
  Pattern matches `src/core/adapters/qdrant/embedded/daemon.ts:153` (which uses
  2000ms; we use 200ms for SessionStart fast-fail).
- **Out of scope**: README global-install requirement remains undocumented in
  this spec — covered by separate doc work.
```

- [ ] **Step 4: Commit the spec update.**

```bash
git add docs/superpowers/specs/2026-05-08-tea-rags-prime-design.md
git commit -m "docs(specs): lock open items in tea-rags prime design

Replace 'Open Items' with 'Locked details' resolved during discovery:
IndexMetrics.labelMap is Record<string, number>, primary language is
IndexStatus.languages[0] (chunkCounts does NOT exist), Qdrant ping is
GET /readyz with 200ms AbortSignal."
```

---

## Task 2: Local types + pure formatter skeleton with placeholder cases

**Files:**

- Create: `src/cli/prime/types.ts`
- Create: `src/cli/prime/format.ts`
- Create: `tests/cli/prime/format.test.ts`

- [ ] **Step 1: Write the failing test (placeholder cases — RED).**

Create `tests/cli/prime/format.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";

describe("formatPrime", () => {
  describe("placeholder cases", () => {
    it("emits 'Path not found' when failure kind is path-not-found", () => {
      const out = formatPrime({ kind: "path-not-found", path: "/missing/dir" });
      expect(out).toBe("# tea-rags prime\nPath not found: /missing/dir\n");
    });

    it("emits 'warm-up pending' when failure kind is qdrant-cold", () => {
      const out = formatPrime({ kind: "qdrant-cold", path: "/some/project" });
      expect(out).toContain("# tea-rags prime");
      expect(out).toContain(
        "Qdrant warm-up pending — index queries will be available after MCP server attaches.",
      );
    });
  });
});
```

- [ ] **Step 2: Run the test to confirm RED.**

Run: `npx vitest run tests/cli/prime/format.test.ts` Expected: FAIL with "Cannot
find module '.../src/cli/prime/format.js'".

- [ ] **Step 3: Create the types file.**

Create `src/cli/prime/types.ts`:

```typescript
import type {
  IndexMetrics,
  IndexStatus,
} from "../../core/api/public/dto/index.js";

/**
 * Successful prime data — index reachable, status fetched.
 * `metrics` is null when the project is not yet indexed (status !== "indexed").
 */
export interface PrimeData {
  path: string;
  status: IndexStatus;
  metrics: IndexMetrics | null;
  drift: string | null;
}

/**
 * Degraded outputs that exit the runPrime pipeline early without a full digest.
 * Each variant produces a short markdown placeholder via formatPrime.
 */
export type PrimeFailureReason =
  | { kind: "path-not-found"; path: string }
  | { kind: "qdrant-cold"; path: string };
```

- [ ] **Step 4: Implement minimal `formatPrime` covering placeholder cases.**

Create `src/cli/prime/format.ts`:

```typescript
import type { PrimeData, PrimeFailureReason } from "./types.js";

export function formatPrime(input: PrimeData | PrimeFailureReason): string {
  if ("kind" in input) {
    return formatFailure(input);
  }
  // TODO Task 3+: handle full digest
  return "# tea-rags prime\n";
}

function formatFailure(reason: PrimeFailureReason): string {
  switch (reason.kind) {
    case "path-not-found":
      return `# tea-rags prime\nPath not found: ${reason.path}\n`;
    case "qdrant-cold":
      return (
        `# tea-rags prime — ${reason.path}\n` +
        `Qdrant warm-up pending — index queries will be available after MCP server attaches.\n`
      );
  }
}
```

- [ ] **Step 5: Run the test to confirm GREEN.**

Run: `npx vitest run tests/cli/prime/format.test.ts` Expected: PASS — 2 tests
passed.

- [ ] **Step 6: Commit.**

```bash
git add src/cli/prime/types.ts src/cli/prime/format.ts tests/cli/prime/format.test.ts
git commit -m "feat(cli): scaffold prime formatter with placeholder cases

Adds PrimeData/PrimeFailureReason types and formatPrime() with
path-not-found + qdrant-cold placeholder branches. Status/metrics
formatting comes in subsequent tasks."
```

---

## Task 3: Status section formatting (4 IndexingStatus variants)

**Files:**

- Modify: `src/cli/prime/format.ts`
- Modify: `tests/cli/prime/format.test.ts`

- [ ] **Step 1: Write the failing tests for all 4 status variants (RED).**

Append to `tests/cli/prime/format.test.ts`:

```typescript
import type { IndexStatus } from "../../../src/core/api/public/dto/ingest.js";

function statusFixture(overrides: Partial<IndexStatus>): IndexStatus {
  return {
    isIndexed: false,
    status: "not_indexed",
    ...overrides,
  };
}

describe("formatPrime — status section", () => {
  it("emits 'not indexed' message with /tea-rags:index hint", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "not_indexed" }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("## Status");
    expect(out).toContain("not indexed. Run `/tea-rags:index`");
  });

  it("emits 'stale indexing marker' message", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "stale_indexing" }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("stale indexing marker");
    expect(out).toContain("Re-run /tea-rags:index");
  });

  it("emits 'indexing in progress' with chunks count and skips metrics block", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexing", chunksCount: 412 }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("indexing in progress (412 chunks so far)");
    expect(out).not.toContain("## Polyglot");
    expect(out).not.toContain("## Signal thresholds");
  });

  it("emits indexed status line with chunks count and collection name", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "code_27622aef",
        chunksCount: 4218,
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("indexed · collection `code_27622aef` · 4218 chunks");
  });
});
```

- [ ] **Step 2: Run the tests — confirm RED.**

Run: `npx vitest run tests/cli/prime/format.test.ts` Expected: 4 new tests FAIL
(output missing "## Status" section).

- [ ] **Step 3: Implement status section formatting.**

Replace `formatPrime` body in `src/cli/prime/format.ts`:

```typescript
import type { IndexStatus } from "../../core/api/public/dto/ingest.js";
import type { PrimeData, PrimeFailureReason } from "./types.js";

export function formatPrime(input: PrimeData | PrimeFailureReason): string {
  if ("kind" in input) {
    return formatFailure(input);
  }
  return formatDigest(input);
}

function formatFailure(reason: PrimeFailureReason): string {
  switch (reason.kind) {
    case "path-not-found":
      return `# tea-rags prime\nPath not found: ${reason.path}\n`;
    case "qdrant-cold":
      return (
        `# tea-rags prime — ${reason.path}\n` +
        `Qdrant warm-up pending — index queries will be available after MCP server attaches.\n`
      );
  }
}

function formatDigest(data: PrimeData): string {
  const lines: string[] = [];
  lines.push(`# tea-rags prime — ${data.path}`);
  lines.push("");
  lines.push("## Status");
  lines.push(formatStatusLine(data.status));
  lines.push("");
  return lines.join("\n");
}

function formatStatusLine(status: IndexStatus): string {
  switch (status.status) {
    case "not_indexed":
      return "not indexed. Run `/tea-rags:index` to index this codebase.";
    case "stale_indexing":
      return (
        "stale indexing marker (previous run crashed). " +
        "Re-run /tea-rags:index — stale collection will be cleaned up."
      );
    case "indexing":
      return `indexing in progress (${status.chunksCount ?? 0} chunks so far). Re-prime after completion.`;
    case "indexed":
      return `indexed · collection \`${status.collectionName ?? "unknown"}\` · ${status.chunksCount ?? 0} chunks`;
    case "unavailable":
      return "index unavailable.";
  }
}
```

- [ ] **Step 4: Run the tests — confirm GREEN.**

Run: `npx vitest run tests/cli/prime/format.test.ts` Expected: 6 tests passed (2
from Task 2 + 4 from Task 3).

- [ ] **Step 5: Commit.**

```bash
git add src/cli/prime/format.ts tests/cli/prime/format.test.ts
git commit -m "feat(cli): format status section for all IndexingStatus variants

Covers not_indexed, stale_indexing, indexing (with chunks count),
indexed (with collection name), unavailable. Indexing variant
produces only status line — no metrics block."
```

---

## Task 4: Polyglot detection + signal thresholds table

**Files:**

- Modify: `src/cli/prime/format.ts`
- Modify: `tests/cli/prime/format.test.ts`

- [ ] **Step 1: Write the failing tests for polyglot + thresholds (RED).**

Append to `tests/cli/prime/format.test.ts`:

```typescript
import type { IndexMetrics } from "../../../src/core/api/public/dto/metrics.js";

function metricsFixture(): IndexMetrics {
  return {
    collection: "code_27622aef",
    totalChunks: 4218,
    totalFiles: 327,
    distributions: {
      language: { typescript: 3104, javascript: 612, markdown: 502 },
    },
    signals: {
      typescript: {
        "git.file.commitCount": {
          source: {
            min: 1,
            max: 41,
            count: 250,
            labelMap: { low: 2, normal: 5, high: 9, extreme: 9 },
          },
          test: {
            min: 1,
            max: 12,
            count: 60,
            labelMap: { low: 1, normal: 3, high: 6, extreme: 6 },
          },
        },
        "git.file.ageDays": {
          source: {
            min: 0,
            max: 600,
            count: 250,
            labelMap: { recent: 14, typical: 45, legacy: 45 },
          },
          test: {
            min: 0,
            max: 600,
            count: 60,
            labelMap: { recent: 14, typical: 45, legacy: 45 },
          },
        },
      },
    },
  };
}

function monolingualMetricsFixture(): IndexMetrics {
  const m = metricsFixture();
  m.distributions = { language: { typescript: 4218 } };
  return m;
}

describe("formatPrime — polyglot + thresholds", () => {
  it("emits Polyglot section with primary language (highest count) and others, sorted desc", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 4218,
      }),
      metrics: metricsFixture(),
      drift: null,
    });
    expect(out).toContain("## Polyglot");
    expect(out).toContain("primary: typescript");
    expect(out).toContain("also: javascript, markdown");
    expect(out).toContain(
      "for non-primary languages, call `get_index_metrics`",
    );
  });

  it("emits Language section (not Polyglot) when distributions has only one language", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 4218,
      }),
      metrics: monolingualMetricsFixture(),
      drift: null,
    });
    expect(out).toContain("## Language");
    expect(out).toContain("typescript");
    expect(out).not.toContain("## Polyglot");
  });

  it("emits Signal thresholds section with table for primary language", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 4218,
      }),
      metrics: monolingualMetricsFixture(),
      drift: null,
    });
    expect(out).toContain("## Signal thresholds — typescript");
    expect(out).toContain("git.file.commitCount");
    expect(out).toContain("low ≤2 / normal ≤5 / high ≤9 / extreme >9");
  });

  it("omits Polyglot/Language and Signal thresholds when metrics is null (e.g. no enrichment yet)", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 4218,
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("## Status");
    expect(out).not.toContain("## Signal thresholds");
  });
});
```

- [ ] **Step 2: Run the tests — confirm RED.**

Run: `npx vitest run tests/cli/prime/format.test.ts` Expected: 4 new tests FAIL.

- [ ] **Step 3: Implement polyglot + thresholds formatting.**

First, add the `IndexMetrics` import at the top of `src/cli/prime/format.ts`
(alongside the existing `IndexStatus` import):

```typescript
import type { IndexMetrics } from "../../core/api/public/dto/metrics.js";
```

Then modify `formatDigest` and add helpers:

```typescript
function formatDigest(data: PrimeData): string {
  const lines: string[] = [];
  lines.push(`# tea-rags prime — ${data.path}`);
  lines.push("");
  lines.push("## Status");
  lines.push(formatStatusLine(data.status));

  if (data.status.status !== "indexed") {
    return lines.join("\n") + "\n";
  }

  // Primary language is derived from IndexMetrics.distributions.language
  // (Record<string, number>, sorted by chunk count desc). IndexStatus.languages
  // is declared but never populated by any producer — do not use it.
  const languages = sortedLanguages(data.metrics);
  if (languages.length > 0) {
    lines.push("");
    lines.push(...formatLanguageSection(languages));
  }

  if (data.metrics && languages.length > 0) {
    const primary = languages[0];
    if (primary && data.metrics.signals[primary]) {
      lines.push("");
      lines.push(
        ...formatThresholdsSection(primary, data.metrics.signals[primary]),
      );
    }
  }

  return lines.join("\n") + "\n";
}

function sortedLanguages(metrics: IndexMetrics | null): string[] {
  if (!metrics?.distributions?.language) return [];
  return Object.entries(metrics.distributions.language)
    .sort(([, a], [, b]) => b - a)
    .map(([lang]) => lang);
}

function formatLanguageSection(languages: string[]): string[] {
  if (languages.length === 1) {
    return ["## Language", languages[0]!];
  }
  const [primary, ...rest] = languages;
  return [
    "## Polyglot",
    `primary: ${primary} · also: ${rest.join(", ")}`,
    "→ for non-primary languages, call `get_index_metrics` for their labelMap",
  ];
}

function formatThresholdsSection(
  language: string,
  signals: Record<string, Record<string, { labelMap: Record<string, number> }>>,
): string[] {
  const lines = [`## Signal thresholds — ${language}`, ""];
  for (const [signalName, scopes] of Object.entries(signals)) {
    const source = scopes.source ? formatLabelMap(scopes.source.labelMap) : "—";
    const test = scopes.test ? formatLabelMap(scopes.test.labelMap) : "—";
    lines.push(`- **${signalName}**`);
    lines.push(`  - source: ${source}`);
    lines.push(`  - test:   ${test}`);
  }
  return lines;
}

function formatLabelMap(labelMap: Record<string, number>): string {
  return Object.entries(labelMap)
    .map(([label, threshold]) => `${label} ≤${threshold}`)
    .join(" / ")
    .replace(/extreme ≤(\d+)/, "extreme >$1");
}
```

- [ ] **Step 4: Run the tests — confirm GREEN.**

Run: `npx vitest run tests/cli/prime/format.test.ts` Expected: 10 tests passed
(6 prior + 4 new).

- [ ] **Step 5: Commit.**

```bash
git add src/cli/prime/format.ts tests/cli/prime/format.test.ts
git commit -m "feat(cli): format polyglot detection and signal thresholds

Polyglot section lists primary + others with hint to call
get_index_metrics for non-primary languages. Single-language
projects render '## Language' instead. Thresholds section
renders labelMap for each {signal, scope} pair of the primary
language. Replaces last 'extreme ≤N' with 'extreme >N' for
unbounded top label semantics."
```

---

## Task 5: Schema drift section

**Files:**

- Modify: `src/cli/prime/format.ts`
- Modify: `tests/cli/prime/format.test.ts`

- [ ] **Step 1: Write the failing tests (RED).**

Append to `tests/cli/prime/format.test.ts`:

```typescript
describe("formatPrime — schema drift", () => {
  it("emits 'none' when drift is null", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 100,
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("## Schema drift");
    expect(out).toContain("none");
  });

  it("includes drift warning text when drift is non-null", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 100,
      }),
      metrics: null,
      drift:
        "New fields: navigation. Run index_codebase with forceReindex=true.",
    });
    expect(out).toContain("## Schema drift");
    expect(out).toContain("New fields: navigation");
    expect(out).toContain("Run index_codebase with forceReindex=true");
  });

  it("omits drift section when status is not 'indexed'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "not_indexed" }),
      metrics: null,
      drift: null,
    });
    expect(out).not.toContain("## Schema drift");
  });
});
```

- [ ] **Step 2: Run the tests — confirm RED.**

Run: `npx vitest run tests/cli/prime/format.test.ts` Expected: 3 new tests FAIL.

- [ ] **Step 3: Add drift section to `formatDigest`.**

In `src/cli/prime/format.ts`, modify `formatDigest` — insert drift block AFTER
status check, BEFORE language section (drift only for indexed projects):

```typescript
function formatDigest(data: PrimeData): string {
  const lines: string[] = [];
  lines.push(`# tea-rags prime — ${data.path}`);
  lines.push("");
  lines.push("## Status");
  lines.push(formatStatusLine(data.status));

  if (data.status.status !== "indexed") {
    return lines.join("\n") + "\n";
  }

  lines.push("");
  lines.push("## Schema drift");
  lines.push(data.drift ?? "none");

  const languages = sortedLanguages(data.metrics);
  if (languages.length > 0) {
    lines.push("");
    lines.push(...formatLanguageSection(languages));
  }

  if (data.metrics && languages.length > 0) {
    const primary = languages[0];
    if (primary && data.metrics.signals[primary]) {
      lines.push("");
      lines.push(
        ...formatThresholdsSection(primary, data.metrics.signals[primary]),
      );
    }
  }

  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run the tests — confirm GREEN.**

Run: `npx vitest run tests/cli/prime/format.test.ts` Expected: 13 tests passed
(10 prior + 3 new).

- [ ] **Step 5: Commit.**

```bash
git add src/cli/prime/format.ts tests/cli/prime/format.test.ts
git commit -m "feat(cli): add schema drift section to prime digest

When status is 'indexed', emit '## Schema drift' with either
'none' or the drift warning string from checkSchemaDrift.
Skipped for non-indexed states (no drift can be evaluated)."
```

---

## Task 6: `runPrime` orchestration — happy path with mocked App

**Files:**

- Create: `src/cli/prime/run-prime.ts`
- Create: `tests/cli/prime/run-prime.test.ts`

- [ ] **Step 1: Write the failing test for the happy path (RED).**

Create `tests/cli/prime/run-prime.test.ts`:

```typescript
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  writeMock.mockClear();
  process.stdout.write = writeMock as unknown as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = stdoutOriginal;
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

const pingMock = vi.fn();
vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({
  pingQdrant: pingMock,
}));

const createAppContextMock = vi.fn();
vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: createAppContextMock,
}));

vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: () => ({}),
  getZodConfig: () => ({ deprecations: [] }),
}));

describe("runPrime — happy path", () => {
  it("calls all three App methods and writes formatted digest to stdout", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const cleanupMock = vi.fn();
    const getStatusMock = vi.fn().mockResolvedValue({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    });
    const getMetricsMock = vi.fn().mockResolvedValue({
      collection: "c",
      totalChunks: 100,
      totalFiles: 10,
      distributions: { language: { typescript: 100 } },
      signals: {},
    });
    const checkDriftMock = vi.fn().mockResolvedValue(null);

    createAppContextMock.mockResolvedValue({
      app: {
        getIndexStatus: getStatusMock,
        getIndexMetrics: getMetricsMock,
        checkSchemaDrift: checkDriftMock,
      },
      cleanup: cleanupMock,
    });

    await runPrime("/some/project");

    expect(getStatusMock).toHaveBeenCalledWith("/some/project");
    expect(getMetricsMock).toHaveBeenCalledWith("/some/project");
    expect(checkDriftMock).toHaveBeenCalledWith({ path: "/some/project" });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]![0]).toContain(
      "# tea-rags prime — /some/project",
    );
    expect(cleanupMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test — confirm RED.**

Run: `npx vitest run tests/cli/prime/run-prime.test.ts` Expected: FAIL with
"Cannot find module '.../src/cli/prime/run-prime.js'".

- [ ] **Step 3: Implement `runPrime` minimally.**

Create `src/cli/prime/qdrant-ping.ts`:

```typescript
/**
 * Lightweight Qdrant readiness ping for SessionStart fast-fail.
 * Returns true if /readyz responds OK within `timeoutMs`. False on any error or timeout.
 */
export async function pingQdrant(
  url: string,
  timeoutMs = 200,
): Promise<boolean> {
  try {
    const res = await fetch(`${url}/readyz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

Create `src/cli/prime/run-prime.ts`:

```typescript
import { existsSync } from "node:fs";

import { parseAppConfig } from "../../bootstrap/config/index.js";
import { createAppContext } from "../../bootstrap/factory.js";
import { formatPrime } from "./format.js";
import { pingQdrant } from "./qdrant-ping.js";
import type { PrimeData } from "./types.js";

/**
 * Run prime: emit a markdown digest of index state to stdout.
 * Always exits 0 — degrades to placeholder when path missing or Qdrant cold.
 */
export async function runPrime(path: string): Promise<void> {
  if (!existsSync(path)) {
    process.stdout.write(formatPrime({ kind: "path-not-found", path }));
    return;
  }

  const config = parseAppConfig();
  const qdrantUrl = config.qdrantUrl ?? "http://localhost:6333";
  const reachable = await pingQdrant(qdrantUrl);
  if (!reachable) {
    process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
    return;
  }

  const ctx = await createAppContext(config);
  try {
    const [status, metricsResult, drift] = await Promise.allSettled([
      ctx.app.getIndexStatus(path),
      ctx.app.getIndexMetrics(path),
      ctx.app.checkSchemaDrift({ path }),
    ]);

    if (status.status !== "fulfilled") {
      process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
      return;
    }

    const data: PrimeData = {
      path,
      status: status.value,
      metrics:
        metricsResult.status === "fulfilled" ? metricsResult.value : null,
      drift: drift.status === "fulfilled" ? drift.value : null,
    };
    process.stdout.write(formatPrime(data));
  } finally {
    if (ctx.cleanup) {
      await ctx.cleanup();
    }
  }
}
```

- [ ] **Step 4: Run the test — confirm GREEN.**

Run: `npx vitest run tests/cli/prime/run-prime.test.ts` Expected: PASS — 1 test.

- [ ] **Step 5: Commit.**

```bash
git add src/cli/prime/run-prime.ts src/cli/prime/qdrant-ping.ts tests/cli/prime/run-prime.test.ts
git commit -m "feat(cli): runPrime orchestration with App facade calls

Validates path, pings Qdrant /readyz with 200ms timeout, calls
getIndexStatus/getIndexMetrics/checkSchemaDrift in parallel via
Promise.allSettled, formats and writes to stdout. Cleans up
AppContext on exit. Status failure degrades to qdrant-cold
placeholder; metrics/drift failures degrade individually."
```

---

## Task 7: `runPrime` failure paths — missing path and Qdrant cold

**Files:**

- Modify: `tests/cli/prime/run-prime.test.ts`

- [ ] **Step 1: Write the failing tests for failure paths (RED).**

Append to `tests/cli/prime/run-prime.test.ts`:

```typescript
describe("runPrime — failure paths", () => {
  it("does NOT call createAppContext when path is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    createAppContextMock.mockClear();
    pingMock.mockClear();

    await runPrime("/missing/dir");

    expect(createAppContextMock).not.toHaveBeenCalled();
    expect(pingMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]![0]).toContain(
      "Path not found: /missing/dir",
    );
  });

  it("does NOT call createAppContext when Qdrant ping fails", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(false);
    createAppContextMock.mockClear();

    await runPrime("/some/project");

    expect(createAppContextMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]![0]).toContain("warm-up pending");
  });
});
```

- [ ] **Step 2: Run the tests — confirm GREEN immediately.**

Run: `npx vitest run tests/cli/prime/run-prime.test.ts` Expected: 3 tests passed
(1 from Task 6 + 2 new) — `runPrime` already implements both branches.

If GREEN immediately — no implementation needed (regression-prevention tests).

- [ ] **Step 3: Commit.**

```bash
git add tests/cli/prime/run-prime.test.ts
git commit -m "test(cli): cover prime failure paths — missing path + qdrant cold

Verifies runPrime short-circuits before createAppContext when
path doesn't exist or Qdrant ping fails. Prevents regressions
where heavy bootstrap fires on degraded inputs."
```

---

## Task 8: yargs `primeCommand` + register in CLI

**Files:**

- Create: `src/cli/commands/prime.ts`
- Modify: `src/cli/create-cli.ts`
- Create: `tests/cli/commands/prime.test.ts`

- [ ] **Step 1: Write the failing test (RED).**

Create `tests/cli/commands/prime.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { primeCommand } from "../../../src/cli/commands/prime.js";

describe("primeCommand", () => {
  it("declares the 'prime <path>' command shape with positional path arg", () => {
    expect(primeCommand.command).toBe("prime <path>");
    expect(primeCommand.describe).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test — confirm RED.**

Run: `npx vitest run tests/cli/commands/prime.test.ts` Expected: FAIL — module
not found.

- [ ] **Step 3: Implement the command module.**

Create `src/cli/commands/prime.ts`:

```typescript
import type { CommandModule } from "yargs";

import { runPrime } from "../prime/run-prime.js";

interface PrimeArgs {
  path: string;
}

export const primeCommand: CommandModule<object, PrimeArgs> = {
  command: "prime <path>",
  describe: "Emit a markdown digest of index state for SessionStart context.",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      describe: "Project path (typically $CLAUDE_PROJECT_DIR from a hook)",
      demandOption: true,
    }),
  handler: async (argv) => {
    await runPrime(argv.path);
  },
};
```

- [ ] **Step 4: Register in `create-cli.ts`.**

Modify `src/cli/create-cli.ts` — add ONE import and ONE `.command()` call:

```typescript
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { primeCommand } from "./commands/prime.js";
import { serverCommand } from "./commands/server.js";
import { tuneCommand } from "./commands/tune.js";

/**
 * Create a yargs CLI instance.
 * @param argv - Command line arguments. Pass `undefined` to use process.argv.
 */
export function createCli(argv?: string[]): ReturnType<typeof yargs> {
  return yargs(argv ?? hideBin(process.argv))
    .scriptName("tea-rags")
    .command(serverCommand)
    .command(tuneCommand)
    .command(primeCommand)
    .demandCommand(
      1,
      "Please specify a command. Run with --help to see available commands.",
    )
    .strict()
    .help();
}
```

- [ ] **Step 5: Run the test + manual smoke — confirm GREEN.**

Run: `npx vitest run tests/cli/commands/prime.test.ts` Expected: PASS.

Smoke: `npm run build && node build/cli/index.js prime --help` Expected: yargs
output showing `tea-rags prime <path>` with positional describe.

- [ ] **Step 6: Commit.**

```bash
git add src/cli/commands/prime.ts src/cli/create-cli.ts tests/cli/commands/prime.test.ts
git commit -m "feat(cli): wire prime subcommand into yargs

Registers primeCommand alongside serverCommand and tuneCommand.
Single positional 'path' (required), no flags — prime always
takes the project root explicitly from the caller."
```

---

## Task 9: Plugin slash command + remove obsolete rules section

**Files:**

- Create: `.claude-plugin/tea-rags/commands/prime.md`
- Modify: `.claude-plugin/tea-rags/rules/search-cascade.md` (delete one section)

- [ ] **Step 1: Create the slash command file.**

Create `.claude-plugin/tea-rags/commands/prime.md`:

```markdown
Re-prime the agent's context with the current tea-rags index state for this
project.

Use after running `/tea-rags:index` mid-session, or when the agent's view of
index health may be stale.

\`\`\`bash tea-rags prime "$CLAUDE_PROJECT_DIR" \`\`\`
```

- [ ] **Step 2: Remove the obsolete "Session Start (EXECUTE IMMEDIATELY)"
      section from search-cascade.md.**

In `.claude-plugin/tea-rags/rules/search-cascade.md`, locate the section
starting with the heading `## Session Start (EXECUTE IMMEDIATELY)` and delete it
through to the next `##`-level heading. The autofired CLI now provides what that
section asked the agent to do.

After the edit, verify with:

```bash
grep -n "Session Start (EXECUTE IMMEDIATELY)" .claude-plugin/tea-rags/rules/search-cascade.md
```

Expected: no matches (exit code 1).

- [ ] **Step 3: Commit.**

```bash
git add .claude-plugin/tea-rags/commands/prime.md .claude-plugin/tea-rags/rules/search-cascade.md
git commit -m "feat(plugin): add /tea-rags:prime slash command + drop stale prompt

Slash command parallels the SessionStart hook for manual re-prime
after mid-session indexing. Removes the now-redundant 'Session Start
(EXECUTE IMMEDIATELY)' rule that asked the agent to run get_index_status
itself — autofired CLI replaces it."
```

---

## Task 10: Plugin hooks wiring + version bump (LAST — minimizes conflict window)

**Files:**

- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json`

- [ ] **Step 1: Pull latest from main and rebase.**

Plugin.json is touched daily by other work — minimize merge-conflict surface by
rebasing right before this final edit:

```bash
git fetch origin main
git rebase origin/main
```

If the rebase has conflicts in plugin.json, resolve them now (carefully — other
sessions may have bumped the version or added unrelated keys; preserve those,
layer ours on top).

- [ ] **Step 2: Edit `plugin.json` — add the second hook entry to SessionStart
      and PreCompact, bump version.**

Modify `.claude-plugin/tea-rags/.claude-plugin/plugin.json`:

```jsonc
{
  "name": "tea-rags",
  "description": "Data-driven code generation strategies powered by TeaRAGs git signals",
  "version": "0.17.0",
  "author": { "name": "artk0de" },
  "keywords": ["code-generation", "git-signals", "strategies", "search"],
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-rules.sh",
          },
          {
            "type": "command",
            "command": "tea-rags prime \"$CLAUDE_PROJECT_DIR\"",
          },
        ],
      },
    ],
    "PreToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/enforce-tearags-search.sh",
          },
        ],
      },
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-rules.sh",
          },
          {
            "type": "command",
            "command": "tea-rags prime \"$CLAUDE_PROJECT_DIR\"",
          },
        ],
      },
    ],
  },
}
```

- [ ] **Step 3: Manual smoke test.**

```bash
npm run build
tea-rags prime "$(pwd)" | head -20
```

Expected: `# tea-rags prime — <pwd>` header followed by status section. Either a
real digest (if Qdrant is up) or "warm-up pending" placeholder.

- [ ] **Step 4: Commit.**

```bash
git add .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "feat(plugin): autofire tea-rags prime in SessionStart + PreCompact

Adds 'tea-rags prime \"\$CLAUDE_PROJECT_DIR\"' as a second hook
command alongside inject-rules.sh in both SessionStart and
PreCompact. Replaces the prompt-based 'Session Start (EXECUTE
IMMEDIATELY)' rule that asked the agent to call get_index_status
itself — eliminates first-message MCP roundtrip.

Bumps plugin version 0.16.2 -> 0.17.0 (minor: new feature)."
```

---

## Task 11 (optional): Add `cli` to release-scope table

**Files:**

- Modify: `.releaserc.json`

- [ ] **Step 1: Check if `cli` is already a recognized release scope.**

Run: `grep -n "cli" .releaserc.json`

If present → skip this task entirely.

- [ ] **Step 2: Add `cli` as a public+functional scope (minor bump default).**

If `.releaserc.json` has a scope-to-release-type mapping, add `cli` to the same
group as `mcp`, `api`, `explore` (public+functional → minor).

Example minimal patch (adjust to existing structure):

```jsonc
{
  // ... existing config ...
  "release": {
    "scopes": {
      "public-functional": ["api", "mcp", "explore", "rerank", "ingest", "cli"],
    },
  },
}
```

- [ ] **Step 3: Commit.**

```bash
git add .releaserc.json
git commit -m "chore(release): add 'cli' to public+functional scope table

CLI surface (subcommands, flags, exit codes) is user-facing and
deserves minor bump on additions, parity with mcp/api scopes."
```

---

## Final Verification

- [ ] Run full test suite: `npx vitest run` — expect 3842 + 13 (format) + 3
      (run-prime) + 1 (command) = ~3859 tests passing.
- [ ] Type-check: `npx tsc --noEmit` — clean.
- [ ] Build: `npm run build` — clean.
- [ ] Manual smoke: `tea-rags prime "$(pwd)"` from this worktree — outputs
      digest or placeholder, exit 0.
- [ ] Verify plugin.json version is `0.17.0`, not `0.16.2`.
- [ ] Verify
      `grep -n "Session Start (EXECUTE IMMEDIATELY)" .claude-plugin/tea-rags/rules/search-cascade.md`
      returns no matches.

## Self-Review Notes

**Spec coverage:** all 9 format scenarios from the spec map to tests in Tasks
2-5; all 6 integration scenarios from the spec map to tests in Tasks 6-7; both
hook integrations covered in Task 10; slash command in Task 9; spec inline
updates in Task 1. Acceptance criteria 1-10 from the spec are covered.

**Type consistency:** `PrimeData`, `PrimeFailureReason`, `formatPrime`,
`runPrime`, `primeCommand` names are stable across tasks. `IndexStatus`,
`IndexMetrics`, `SignalMetrics`, `IndexingStatus` are imported from existing
source files and not redefined.

**No placeholders:** every step contains actual code or actual commands. Task 11
is optional and explicitly marked.

**Hot-zone discipline:** plan touches zero lines of `src/mcp/tools/code.ts`. App
facade methods called by `runPrime` are existing (verified in Task 1).

**Plugin.json conflict mitigation:** edit isolated to Task 10 (final task),
preceded by `git fetch && git rebase origin/main` to minimize merge-conflict
window with parallel sessions.
