/**
 * Layer-guard fixture test.
 *
 * The foundation eslint zones (`contracts`, `infra`, `adapters`) were dead for
 * months: their globs were anchored at "core/", while every import
 * inside `src/core` is relative (`../domains/ingest/...`) and so never contains
 * the `core/` segment. Nothing matched, nothing was ever reported.
 *
 * A config-only fix is unverifiable by inspection, so this test lints fixture
 * sources at virtual paths inside each zone and asserts the expected message.
 *
 * The fixtures never touch disk (bd tea-rags-mcp-bbo1h.7). Writing them into
 * `src/` raced every parallel test that lists and then reads the source tree
 * (ENOENT on a fixture listed and then deleted), exposed their deliberate
 * violations to scanners, and left violating files behind on a crash.
 *
 * `lintText` with a virtual path cannot use the project's typed parsing: the
 * path is in no tsconfig program, so the parser rejects it before any rule runs.
 * The layer rule (`@typescript-eslint/no-restricted-imports`) does not need type
 * information, so this instance parses without a project and runs that rule
 * alone — the type-aware rules would refuse to run without one.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

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

/** The rule every zone is configured through — the only rule this test runs. */
const LAYER_RULE_ID = "@typescript-eslint/no-restricted-imports";

const messagesByFixture = new Map<string, string>();

beforeAll(async () => {
  const eslint = new ESLint({
    cwd: ROOT,
    // Virtual paths belong to no tsconfig program: parse without one.
    overrideConfig: { languageOptions: { parserOptions: { project: null, projectService: false } } },
    ruleFilter: ({ ruleId }) => ruleId === LAYER_RULE_ID,
  });

  for (const fixture of Object.values(FIXTURES)) {
    const [result] = await eslint.lintText(fixture.source, { filePath: join(ROOT, fixture.path) });
    if (result === undefined) throw new Error(`no lint result for ${fixture.path}`);
    messagesByFixture.set(fixture.path, result.messages.map((m) => `${m.ruleId ?? "parse"}: ${m.message}`).join("\n"));
  }
});

function reportFor(fixture: Fixture): string {
  const report = messagesByFixture.get(fixture.path);
  if (report === undefined) throw new Error(`fixture was not linted: ${fixture.path}`);
  return report;
}

describe("eslint layer guard — foundation zones", () => {
  it("lints every fixture without a file at its path under src/", () => {
    for (const fixture of Object.values(FIXTURES)) {
      expect(existsSync(join(ROOT, fixture.path)), fixture.path).toBe(false);
    }
  });

  // Without this, a parse failure or an ignored path would make every
  // "allows" case pass vacuously: those reports carry a null ruleId.
  it("reports only the layer rule — every fixture parsed and reached it", () => {
    for (const fixture of Object.values(FIXTURES)) {
      for (const line of reportFor(fixture).split("\n").filter(Boolean)) {
        expect(line, fixture.path).toMatch(new RegExp(`^${LAYER_RULE_ID}: `));
      }
    }
    expect(reportFor(FIXTURES.contractsToInfra)).toMatch(new RegExp(`^${LAYER_RULE_ID}: `));
  });

  it("rejects a relative contracts -> infra import", () => {
    expect(reportFor(FIXTURES.contractsToInfra)).toContain("contracts is pure");
  });

  it("rejects a relative adapters -> api import", () => {
    expect(reportFor(FIXTURES.adaptersToApi)).toContain("adapters may import only");
  });

  it("rejects a relative adapters -> domains import", () => {
    expect(reportFor(FIXTURES.adaptersToDomains)).toContain("adapters may import only");
  });

  it("allows an infra -> contracts type-only import", () => {
    expect(reportFor(FIXTURES.infraToContractsType)).not.toContain("infra is the lowest layer");
  });

  it("rejects a relative infra -> domains import", () => {
    expect(reportFor(FIXTURES.infraToDomains)).toContain("infra is the lowest layer");
  });
});
