/**
 * Swift tier 2 end to end, at the unit seam: the fixture `.swift` files go
 * through the REAL `CODEGRAPH_LANGUAGES[".swift"]` row (grammar, scope
 * separator, overload disambiguation), the REAL `LanguageFactory`-built
 * provider (so the walker and resolver are the ones production wires), the
 * REAL `collectSymbols` + `DefaultSymbolIdComposer`, and the REAL
 * `InMemoryGlobalSymbolTable` keyed by production's own `lastSegment`.
 *
 * What it guards is the WIRING, which the strategy-level specs cannot see: a
 * walker and a resolver that both pass their own tests still produce nothing if
 * the extension has no row in the codegraph language table or the factory hands
 * the provider out without a mode. Both were one-line changes; both are silent
 * when wrong.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageProvider } from "../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CODEGRAPH_LANGUAGES } from "../../../../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js";
import { lastSegment } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-name.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const FIXTURES = join("tests/__fixtures__/sample-swift");
const INVOICE = "Sources/Payables/Invoice.swift";
const LEDGER = "Sources/Payables/Ledger.swift";

const swiftRow = CODEGRAPH_LANGUAGES[".swift"];
const provider: LanguageProvider = new LanguageFactory().create("swift");
const composer = new DefaultSymbolIdComposer();

/** Parse + walk one fixture exactly as `CodegraphFileExtractor.parse` does. */
function extractFixture(fileName: string, relPath: string) {
  const code = readFileSync(join(FIXTURES, fileName), "utf8");
  const parser = new Parser();
  parser.setLanguage(swiftRow.loadParser());
  const tree = { rootNode: parser.parse(code).rootNode };
  const { walker } = provider;
  if (!walker) throw new Error("swift provider has no walker");
  const chunks = collectSymbols(
    tree,
    (node) => walker.nameOf(node),
    swiftRow.scopeSeparator,
    swiftRow.disambiguateOverloads ?? false,
    composer,
  );
  return walker.walk({ tree, code, relPath, language: "swift", chunks });
}

const extractions = [extractFixture("Invoice.swift", INVOICE), extractFixture("Ledger.swift", LEDGER)];

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  for (const extraction of extractions) {
    const defs: SymbolDefinition[] = extraction.chunks.map((c) => ({
      symbolId: c.symbolId,
      fqName: c.symbolId,
      shortName: lastSegment(c.symbolId),
      relPath: extraction.relPath,
      scope: c.scope,
    }));
    t.upsertFile(extraction.relPath, defs);
  }
  return t;
})();

const classFieldTypes = Object.assign({}, ...extractions.map((e) => e.classFieldTypes ?? {})) as Record<
  string,
  Record<string, string>
>;

/** Resolve the call named `member` inside the chunk `callerSymbolId`, through the provider's own resolver. */
function resolveCallFrom(callerSymbolId: string, member: string) {
  for (const extraction of extractions) {
    const chunk = extraction.chunks.find((c) => c.symbolId === callerSymbolId);
    if (!chunk) continue;
    const call: CallRef | undefined = chunk.calls.find((c) => c.member === member);
    if (!call) throw new Error(`no call to ${member} inside ${callerSymbolId}`);
    const ctx: CallContext = {
      callerFile: extraction.relPath,
      callerScope: chunk.scope,
      callerSymbolId: chunk.symbolId,
      imports: extraction.imports,
      symbolTable,
      classFieldTypes,
      ...(chunk.localBindings ? { localBindings: chunk.localBindings } : {}),
    };
    return provider.resolver?.resolve(call, ctx) ?? null;
  }
  throw new Error(`no chunk ${callerSymbolId}`);
}

describe("swift tier 2 — the codegraph language table", () => {
  it("walks `.swift` as swift, joins nested types with `.`, and disambiguates overloads", () => {
    expect(swiftRow).toBeDefined();
    expect(swiftRow.language).toBe("swift");
    expect(swiftRow.scopeSeparator).toBe(".");
    // Swift methods and inits overload on their parameter lists, and the
    // chunker already suffixes duplicates `~N`. Without this the two halves
    // collapse `Ledger#balance(of:)` and `Ledger#balance(of:in:)` differently.
    expect(swiftRow.disambiguateOverloads).toBe(true);
  });
});

describe("swift tier 2 — extraction over the real fixtures", () => {
  it("extracts the module import, symbols and calls from each fixture", () => {
    for (const extraction of extractions) {
      expect(extraction.imports.map((i) => i.importText)).toContain("Foundation");
      expect(extraction.chunks.length).toBeGreaterThan(0);
      expect(extraction.chunks.some((c) => c.calls.length > 0)).toBe(true);
    }
  });

  it("composes the same nested-type and overload ids the chunker does", () => {
    const ids = extractions.flatMap((e) => e.chunks.map((c) => c.symbolId));
    expect(ids).toContain("Ledger.Account#post");
    expect(ids).toContain("Ledger.Account.opening");
    expect(ids).toContain("Invoice#init");
    expect(ids).toContain("Invoice#init~2");
    expect(ids).toContain("Invoice.empty");
    // The extension's method attributes to the EXTENDED type, in the same file.
    expect(ids).toContain("Invoice#totalsByQuantity");
    expect(ids).toContain("formatDecimal");
  });

  it("records a stored property's declared type under its owning type", () => {
    expect(classFieldTypes.Ledger?.accounts).toBeUndefined(); // [String: Account] — a dictionary, not an Account
    expect(classFieldTypes["Ledger.Account"]).toBeUndefined(); // keyed by the type's own short name
    expect(classFieldTypes.Account?.balance).toBe("Decimal");
    expect(classFieldTypes.Invoice?.state).toBe("InvoiceState");
  });
});

describe("swift tier 2 — resolution through the provider's own resolver", () => {
  it("resolves a delegating `self.init(...)` to the designated initializer", () => {
    expect(resolveCallFrom("Invoice#init~2", "init")).toEqual({
      targetRelPath: INVOICE,
      targetSymbolId: "Invoice#init",
    });
  });

  it("resolves an implicit-self overload call to the sibling overload", () => {
    // `Ledger#balance(of:in:)` calls the bare `balance(of:)` — the
    // enclosing-type pass has to beat the terminal short-name fallback, which
    // would see both overloads and drop on ambiguity.
    expect(resolveCallFrom("Ledger#balance~2", "balance")).toEqual({
      targetRelPath: LEDGER,
      targetSymbolId: "Ledger#balance",
    });
  });

  it("resolves a construction expression to the constructed TYPE", () => {
    // `Account(name:balance:)` inside `Ledger.Account.opening` is recorded as a
    // bare call named `Account`. The type declares an explicit init, but the
    // call names the TYPE, and the type's own symbol is the edge that exists.
    expect(resolveCallFrom("Ledger.Account.opening", "Account")).toEqual({
      targetRelPath: LEDGER,
      targetSymbolId: "Ledger.Account",
    });
  });

  it("resolves a construction of a type RE-OPENED by a same-file extension", () => {
    // `Invoice()` inside `Invoice.empty`. `extension Invoice` is a second
    // `class_declaration` carrying the same name, so `collectSymbols` composes
    // `Invoice` and `Invoice~2` — and `lastSegment` strips `~N`, so BOTH answer
    // the short name `Invoice`.
    //
    // INVARIANT CHANGED (bd tea-rags-mcp-sg35c, `.claude/rules/test-invariants.md`
    // §4): this used to pin `toBeNull()` — the strict cardinality gate saw two
    // candidates and emitted no edge. It was pinned on the belief that telling a
    // re-opened type from a genuine method overload needs a container marker on
    // `SymbolDefinition`, i.e. a cross-language shape change. It does not: the
    // COMPOSED ID already says it. `Invoice#init` / `Invoice#init~2` are
    // `#`-form members and stay two symbols; `Invoice` / `Invoice~2` are two
    // declarations of ONE top-level UpperCamelCase type, which the Swift-scoped
    // short-name lookup now folds back to the base declaration. Same-file
    // conformance extensions are idiomatic Swift, so this buys real construction
    // edges.
    expect(resolveCallFrom("Invoice.empty", "Invoice")).toEqual({
      targetRelPath: INVOICE,
      targetSymbolId: "Invoice",
    });
  });

  it("resolves a NESTED type's short-name receiver against the enclosing scope", () => {
    // `Ledger#open` calls `Account.opening(name)`. The receiver is the nested
    // type's SHORT name while its symbol composes as `Ledger.Account.opening`.
    //
    // INVARIANT CHANGED (bd tea-rags-mcp-sg35c, `.claude/rules/test-invariants.md`
    // §4): this used to pin `toBeNull()` because no pass re-qualified a bare
    // type name against the caller's scope. `scopedTypeReceiver` now does, by
    // probing `<enclosing scope>.<receiver>` outward-in and requiring the probe
    // to land on a DECLARED symbol — so it answers only where the nested type
    // demonstrably exists, and stays silent otherwise.
    expect(resolveCallFrom("Ledger#open", "opening")).toEqual({
      targetRelPath: LEDGER,
      targetSymbolId: "Ledger.Account.opening",
    });
  });
});
