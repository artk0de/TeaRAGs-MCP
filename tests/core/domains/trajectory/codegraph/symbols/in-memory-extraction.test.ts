/**
 * A naming review over a diff judges files the index has not seen yet (bd
 * tea-rags-mcp-fdef2), so it extracts them from their TEXT with the same
 * parse → materialize → collect → walk path pass 1 runs on a file from disk.
 */
import { describe, expect, it } from "vitest";

import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { extractFileInMemory } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/in-memory-extraction.js";

const deps = {
  languageFactory: new LanguageFactory(),
  collectSymbols,
  composer: new DefaultSymbolIdComposer(),
};

const SOURCE = [
  "export class LedgerPoster {",
  "  post(entry: LedgerEntry, retries: number): Receipt {",
  "    const receipt = new Receipt(entry);",
  "    return receipt;",
  "  }",
  "}",
  "",
].join("\n");

describe("extractFileInMemory", () => {
  it("walks the text of a codegraph-language file into its chunks and identifier declarations", () => {
    const extraction = extractFileInMemory(deps, "src/ledger/poster.ts", SOURCE);

    expect(extraction?.language).toBe("typescript");
    expect(extraction?.relPath).toBe("src/ledger/poster.ts");
    expect(extraction?.chunks.map((chunk) => chunk.symbolId)).toEqual(
      expect.arrayContaining(["LedgerPoster", "LedgerPoster#post"]),
    );
    expect(extraction?.identifierDeclarations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "entry", kind: "param", typeName: "LedgerEntry" }),
        expect.objectContaining({ name: "retries", kind: "param" }),
        expect.objectContaining({ name: "receipt", kind: "local", typeName: "Receipt" }),
        expect.objectContaining({ name: "post", kind: "return", typeName: "Receipt" }),
      ]),
    );
  });

  it("returns null for a path no codegraph language walks", () => {
    expect(extractFileInMemory(deps, "docs/guide.md", "# Guide\n")).toBeNull();
    expect(extractFileInMemory(deps, "package.json", "{}\n")).toBeNull();
  });
});
