/**
 * Integration test: Python local-binding type inference end-to-end.
 *
 * Reproduces the ugnest false positive (serializer.is_valid() →
 * ConfirmationCode#is_valid) in a controlled fixture and verifies the
 * walker + resolver combination correctly DROPS the bogus method edge
 * while preserving file-level attribution.
 *
 * Path exercised:
 *   synthetic Python sources → tree-sitter-python → extractFromPythonFile
 *   → JSON.stringify (simulating NDJSON spill) → JSON.parse →
 *   PythonCallResolver → resolved targets
 *
 * The JSON round-trip is the critical step — it verifies localBindings
 * survives the spill as a plain Record (Map would serialize to {} and
 * silently break the resolver).
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parsePy(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

function roundTripExtraction(extraction: FileExtraction): FileExtraction {
  // Simulates the NDJSON spill path: walker emits → JSON.stringify
  // writes one line → resolver pass-2 reads + JSON.parse.
  return JSON.parse(JSON.stringify(extraction)) as FileExtraction;
}

function makeCtx(
  callerFile: string,
  callerScope: string[],
  imports: { importText: string; startLine: number }[],
  symbolTable: GlobalSymbolTable,
  localBindings?: Record<string, string>,
): CallContext {
  return { callerFile, callerScope, imports, symbolTable, localBindings };
}

describe("Python local-binding integration", () => {
  it("drops false positive: serializer.is_valid() NOT attributed to ConfirmationCode#is_valid", () => {
    // Mirror the ugnest setup:
    //   - Project has ONE symbol named `is_valid` (on ConfirmationCode).
    //   - DRF Serializer (where the actual is_valid lives) is excluded
    //     via venv filter — not in symbol table.
    //   - A view file constructs ToggleReactionSerializer and calls
    //     `.is_valid()` on it.
    const viewSrc = [
      "from engagement.serializers.reaction import ToggleReactionSerializer",
      "",
      "class ReactionViewSet:",
      "    def post(self, request):",
      "        serializer = ToggleReactionSerializer(data=request.data)",
      "        if serializer.is_valid():",
      "            return Response()",
      "",
    ].join("\n");
    const tree = parsePy(viewSrc);
    const extraction = extractFromPythonFile({
      tree,
      code: viewSrc,
      relPath: "engagement/views.py",
      language: "python",
      chunks: [{ symbolId: "ReactionViewSet#post", scope: ["ReactionViewSet"], startLine: 4, endLine: 7 }],
    });

    // Sanity: walker emitted the binding before the spill.
    expect(extraction.chunks[0].localBindings?.serializer).toBe("ToggleReactionSerializer");

    // Critical: round-trip through JSON to simulate the NDJSON spill.
    // Map would die here; Record survives.
    const roundTripped = roundTripExtraction(extraction);
    expect(roundTripped.chunks[0].localBindings?.serializer).toBe("ToggleReactionSerializer");

    // Symbol table — ConfirmationCode is the ONLY is_valid in the project.
    // ToggleReactionSerializer exists but inherits is_valid from DRF
    // (not in table).
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("domains/identity/models/confirmation.py", [
      {
        symbolId: "ConfirmationCode",
        fqName: "ConfirmationCode",
        shortName: "ConfirmationCode",
        relPath: "domains/identity/models/confirmation.py",
        scope: [],
      },
      {
        symbolId: "ConfirmationCode#is_valid",
        fqName: "ConfirmationCode#is_valid",
        shortName: "is_valid",
        relPath: "domains/identity/models/confirmation.py",
        scope: ["ConfirmationCode"],
      },
    ]);
    table.upsertFile("engagement/serializers/reaction.py", [
      {
        symbolId: "ToggleReactionSerializer",
        fqName: "ToggleReactionSerializer",
        shortName: "ToggleReactionSerializer",
        relPath: "engagement/serializers/reaction.py",
        scope: [],
      },
    ]);

    const resolver = new PythonCallResolver();
    const isValidCall = roundTripped.chunks[0].calls.find((c) => c.member === "is_valid");
    expect(isValidCall).toBeDefined();
    const target = resolver.resolve(
      isValidCall!,
      makeCtx(
        roundTripped.relPath,
        roundTripped.chunks[0].scope,
        roundTripped.imports,
        table,
        roundTripped.chunks[0].localBindings,
      ),
    );
    // The edge MUST NOT target ConfirmationCode#is_valid. File-level
    // attribution to the serializer file is acceptable; method-level
    // attribution to the unrelated model is the exact bug being
    // prevented.
    expect(target?.targetSymbolId).not.toBe("ConfirmationCode#is_valid");
    expect(target?.targetRelPath).toBe("engagement/serializers/reaction.py");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("preserves correct resolution when method IS defined on the bound type", () => {
    const viewSrc = [
      "from services.reaction.toggle import ToggleReactionService",
      "",
      "class ReactionViewSet:",
      "    def post(self, request):",
      "        service = ToggleReactionService()",
      "        return service.execute(payload=request.data)",
      "",
    ].join("\n");
    const tree = parsePy(viewSrc);
    const extraction = extractFromPythonFile({
      tree,
      code: viewSrc,
      relPath: "engagement/views.py",
      language: "python",
      chunks: [{ symbolId: "ReactionViewSet#post", scope: ["ReactionViewSet"], startLine: 4, endLine: 6 }],
    });
    const roundTripped = roundTripExtraction(extraction);

    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("services/reaction/toggle.py", [
      {
        symbolId: "ToggleReactionService",
        fqName: "ToggleReactionService",
        shortName: "ToggleReactionService",
        relPath: "services/reaction/toggle.py",
        scope: [],
      },
      {
        symbolId: "ToggleReactionService#execute",
        fqName: "ToggleReactionService#execute",
        shortName: "execute",
        relPath: "services/reaction/toggle.py",
        scope: ["ToggleReactionService"],
      },
    ]);

    const resolver = new PythonCallResolver();
    const executeCall = roundTripped.chunks[0].calls.find((c) => c.member === "execute");
    expect(executeCall).toBeDefined();
    const target = resolver.resolve(
      executeCall!,
      makeCtx(
        roundTripped.relPath,
        roundTripped.chunks[0].scope,
        roundTripped.imports,
        table,
        roundTripped.chunks[0].localBindings,
      ),
    );
    expect(target?.targetSymbolId).toBe("ToggleReactionService#execute");
    expect(target?.targetRelPath).toBe("services/reaction/toggle.py");
  });

  it("function-arg type hint resolves request.json() on HttpRequest type", () => {
    const viewSrc = [
      "from http import HttpRequest",
      "",
      "class ApiView:",
      "    def handle(self, request: HttpRequest):",
      "        return request.json()",
      "",
    ].join("\n");
    const tree = parsePy(viewSrc);
    const extraction = extractFromPythonFile({
      tree,
      code: viewSrc,
      relPath: "views/api.py",
      language: "python",
      chunks: [{ symbolId: "ApiView#handle", scope: ["ApiView"], startLine: 4, endLine: 5 }],
    });
    expect(extraction.chunks[0].localBindings?.request).toBe("HttpRequest");

    const roundTripped = roundTripExtraction(extraction);

    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("http.py", [
      { symbolId: "HttpRequest", fqName: "HttpRequest", shortName: "HttpRequest", relPath: "http.py", scope: [] },
      {
        symbolId: "HttpRequest#json",
        fqName: "HttpRequest#json",
        shortName: "json",
        relPath: "http.py",
        scope: ["HttpRequest"],
      },
    ]);

    const resolver = new PythonCallResolver();
    const jsonCall = roundTripped.chunks[0].calls.find((c) => c.member === "json");
    expect(jsonCall).toBeDefined();
    const target = resolver.resolve(
      jsonCall!,
      makeCtx(
        roundTripped.relPath,
        roundTripped.chunks[0].scope,
        roundTripped.imports,
        table,
        roundTripped.chunks[0].localBindings,
      ),
    );
    expect(target?.targetSymbolId).toBe("HttpRequest#json");
  });
});
