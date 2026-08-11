/**
 * Layer-guard fixture test.
 *
 * The foundation eslint zones (`contracts`, `infra`, `adapters`) were dead for
 * months: their globs were anchored at "core/", while every import
 * inside `src/core` is relative (`../domains/ingest/...`) and so never contains
 * the `core/` segment. Nothing matched, nothing was ever reported.
 *
 * A config-only fix is unverifiable by inspection, so this test lints real
 * fixture files placed inside each zone and asserts the expected message. The
 * fixtures must exist on disk: `tsconfig.eslint.json` drives type-aware
 * parsing, and a virtual path would fail to parse instead of reaching the rule.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Import target that survives the whole infra-tidy plan (never relocated). */
const STABLE_DOMAIN_MODULE = "domains/explore/reranker.js";

interface Fixture {
  /** Repo-relative path; its directory decides which zone applies. */
  path: string;
  source: string;
}

const FIXTURES = {
  infraToDomains: {
    path: "src/core/infra/__layer_guard_infra_to_domains__.ts",
    source: `import "../${STABLE_DOMAIN_MODULE}";\n`,
  },
  contractsToInfra: {
    path: "src/core/contracts/__layer_guard_contracts_to_infra__.ts",
    source: 'import "../infra/runtime.js";\n',
  },
  adaptersToApi: {
    path: "src/core/adapters/__layer_guard_adapters_to_api__.ts",
    source: 'import "../api/public/index.js";\n',
  },
  adaptersToDomains: {
    path: "src/core/adapters/__layer_guard_adapters_to_domains__.ts",
    source: `import "../${STABLE_DOMAIN_MODULE}";\n`,
  },
  infraToContractsType: {
    path: "src/core/infra/__layer_guard_infra_to_contracts_type__.ts",
    source: 'import type { AstNode } from "../contracts/types/ast.js";\n\nexport type Fixture = AstNode;\n',
  },
} satisfies Record<string, Fixture>;

const messagesByFixture = new Map<string, string>();

/**
 * Wall-clock budget for the one type-aware ESLint program (bd tea-rags-mcp-ehbno).
 *
 * This hook is the single most expensive setup in the suite: it builds ONE
 * type-aware program over `tsconfig.eslint.json` — the whole of `src/` — to lint
 * five one-line fixtures. Its standalone cost swings by more than an order of
 * magnitude with the machine's state — 6.0s on an idle box, 78.8s on a loaded one.
 *
 * The previous 120s left only ~1.5x headroom over that worst case, which does not
 * survive contention. Under the full run it competes with `pool: "forks"` workers
 * (one per core) plus the forked chunker/blame/walk processes those spawn — the
 * same oversubscription documented on `WALL_CLOCK_BUDGET_MS` in vitest.config.ts —
 * and it timed out repeatedly, including twice on independent `npm run test:coverage`
 * release-gate runs. Each timeout costs far more than the hook: vitest emits no
 * coverage report when any suite fails, so a single flake here voids the entire gate.
 *
 * The in-suite figure is what this budget governs, and it tracks the box: 6.0s
 * standalone became 24.2s inside a full `test:coverage` run on a quiet machine, and
 * blew past 120s on a machine also carrying several parallel agents. 300s is ~3.8x
 * headroom over the worst measurement of either kind. It is not a hang budget being
 * relaxed — a genuine hang is unbounded and still trips it.
 *
 * This value MUST live here rather than on the CLI: the per-hook argument wins over
 * `--hookTimeout`, so passing that flag silently does nothing for this file.
 */
const ESLINT_PROGRAM_BUDGET_MS = 300_000;

beforeAll(async () => {
  for (const fixture of Object.values(FIXTURES)) {
    const absolute = join(ROOT, fixture.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, fixture.source, "utf8");
  }

  // One ESLint instance for every fixture: the type-aware program is built once.
  const eslint = new ESLint({ cwd: ROOT });
  const results = await eslint.lintFiles(Object.values(FIXTURES).map((f) => join(ROOT, f.path)));

  for (const result of results) {
    const relative = result.filePath.slice(ROOT.length + 1);
    messagesByFixture.set(relative, result.messages.map((m) => `${m.ruleId ?? "parse"}: ${m.message}`).join("\n"));
  }
}, ESLINT_PROGRAM_BUDGET_MS);

afterAll(() => {
  for (const fixture of Object.values(FIXTURES)) {
    rmSync(join(ROOT, fixture.path), { force: true });
  }
});

function reportFor(fixture: Fixture): string {
  const report = messagesByFixture.get(fixture.path);
  if (report === undefined) throw new Error(`fixture was not linted: ${fixture.path}`);
  return report;
}

describe("eslint layer guard — foundation zones", () => {
  it("rejects a relative contracts -> infra import", () => {
    expect(reportFor(FIXTURES.contractsToInfra)).toContain("contracts is pure");
  });

  it("rejects a relative adapters -> api import", () => {
    expect(reportFor(FIXTURES.adaptersToApi)).toContain("adapters may import only");
  });

  // Unskipped by tea-rags-mcp-pn12w: adapters/qdrant/client.ts throws the
  // explore-domain InvalidQueryError, so the "**/domains/**" pattern cannot be
  // enabled for this zone until that error taxonomy is fixed.
  it.skip("rejects a relative adapters -> domains import", () => {
    expect(reportFor(FIXTURES.adaptersToDomains)).toContain("adapters may import only");
  });

  it("allows an infra -> contracts type-only import", () => {
    expect(reportFor(FIXTURES.infraToContractsType)).not.toContain("infra is the lowest layer");
  });

  it("rejects a relative infra -> domains import", () => {
    expect(reportFor(FIXTURES.infraToDomains)).toContain("infra is the lowest layer");
  });
});
