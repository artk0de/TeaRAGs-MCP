/**
 * Storage-owner import-direction pin (bd tea-rags-mcp-89k7k.25).
 *
 * The silent-coupling detector flagged two duckdb files as co-changing
 * strongly with `contracts/types/codegraph-storage.ts` while importing the
 * vocabulary through the `codegraph.ts` barrel — op-commands at 0.67 over 12
 * co-changes, identifier-store at 0.51 over 4. The coupling lived in the
 * daemon's dispatch table and the identifier store's SQL, not in any import.
 *
 * The barrel's own contract says: "import a sibling directly when you want
 * the narrow surface, or this barrel when you want the set." Both files
 * program against the storage surface (`GraphDbClient` and its query / row
 * shapes), so they import the OWNER directly; this pin keeps that edge
 * declared so the pair can never again read as silent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../..");

const OP_COMMANDS = "src/core/adapters/duckdb/daemon/op-commands.ts";
const IDENTIFIER_STORE = "src/core/adapters/duckdb/identifier-store.ts";

/** Names `codegraph-storage.ts` itself defines — the storage surface. */
const STORAGE_OWNED = {
  [OP_COMMANDS]: [
    "BulkFileUpsertEntry",
    "BulkSymbolUpsertEntry",
    "GraphDbClient",
    "IdentifierReplaceEntry",
    "MethodHeadWordQuery",
    "MethodNamePatternQuery",
    "MethodTailVerbQuery",
    "OntologyReportQuery",
    "Pass1AggregateReadScope",
    "ReviewFileEdge",
    "TypeDeclarationReplaceEntry",
    "TypeNameQuery",
  ],
  [IDENTIFIER_STORE]: [
    "AnchorIdentifierTypeRow",
    "IdentifierCalleeAggregateRow",
    "IdentifierCalleeScopeQuery",
    "IdentifierLanguageCountQuery",
    "IdentifierLanguageCountRow",
    "IdentifierNameKindTypeRow",
    "IdentifierNameScopeQuery",
    "IdentifierNameTypeRow",
    "IdentifierReplaceEntry",
    "IdentifierRow",
    "IdentifierShapeSampleQuery",
    "IdentifierShapeSampleRow",
    "IdentifierTypeAggregateQuery",
    "IdentifierTypeAggregateRow",
    "IdentifierTypeScopeQuery",
    "MethodHeadWordQuery",
    "MethodHeadWordRow",
    "MethodNamePatternQuery",
    "MethodNameRow",
    "MethodNameScopeQuery",
    "MethodTailVerbQuery",
    "MethodTailVerbRow",
  ],
} as const;

interface NamedImport {
  names: Set<string>;
  specifier: string;
}

/** Named-form import statements (`import type { A, B } from "mod"`). */
function namedImports(text: string): NamedImport[] {
  return [...text.matchAll(/import\s+type\s+\{([^}]*)\}\s*from\s*"([^"]+)"/g)].map((m) => {
    const names = new Set<string>();
    for (const clause of (m[1] ?? "").split(",")) {
      const cleaned = clause.trim().replace(/^type\s+/, "");
      if (cleaned) names.add(cleaned);
    }
    return { names, specifier: m[2] ?? "" };
  });
}

describe("duckdb consumers import the storage contract owner directly (bd tea-rags-mcp-89k7k.25)", () => {
  for (const [file, names] of Object.entries(STORAGE_OWNED)) {
    it(`${file} imports its storage vocabulary from contracts/types/codegraph-storage.js`, () => {
      const text = readFileSync(join(ROOT, file), "utf-8");
      const fromStorage = namedImports(text).filter((s) =>
        s.specifier.endsWith("contracts/types/codegraph-storage.js"),
      );
      const storageNames = new Set(fromStorage.flatMap((s) => [...s.names]));
      const missing = names.filter((name) => !storageNames.has(name));
      expect(missing, `${file} must take storage-owned names from the owner, not the barrel`).toEqual([]);
    });

    it(`${file} keeps no storage-owned name on the codegraph barrel`, () => {
      const text = readFileSync(join(ROOT, file), "utf-8");
      const fromBarrel = namedImports(text).filter((s) => s.specifier.endsWith("contracts/types/codegraph.js"));
      const barrelNames = new Set(fromBarrel.flatMap((s) => [...s.names]));
      const drifted = names.filter((name) => barrelNames.has(name));
      expect(drifted, `storage-owned names must not ride the barrel in ${file}`).toEqual([]);
    });
  }
});
