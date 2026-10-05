/**
 * Python walker type and constant declarations (bd tea-rags-mcp-vi0wx, spec
 * §1b). Every class, type alias and module-level constant becomes one
 * `TypeDeclarationFact` on `FileExtraction.typeDeclarations`: a class whose
 * bases name `Enum` / `IntEnum` / `StrEnum` / `Flag` is an `enum`, a `Protocol`
 * subclass an `interface`; `X: TypeAlias = …`, PEP 695 `type X = …` and
 * `X = NewType(…)` are `type_alias`; a module-level UPPER_CASE assignment or a
 * `Final`-annotated one is a `constant`. The facts are naming data only, so the
 * chunk set, symbols and CallRefs must not move — pinned against a golden taken
 * before the channel existed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { readPythonTypeAbstractness } from "../../../../../../src/core/domains/language/python/walker/passes/type-abstractness.js";
import { extractFileInMemory } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/in-memory-extraction.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__");
const ORACLE_PKG = join(HERE, "../../../../../fixtures/py-oracle/pkg");

/** The `FileExtraction` of `src` through the seam production runs: materialize, `collectSymbols`, `walker.walk`. */
function extract(src: string, relPath = "app/a.py"): FileExtraction {
  const language = new PythonLanguage();
  const parser = new Parser();
  parser.setLanguage(PyLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath, language: "python", chunks });
}

const FIXTURE_SOURCE = readFileSync(join(FIXTURES, "type-declarations.py"), "utf8");

function factsOf(src: string): Record<string, { kind: string; line: number; conforms?: readonly string[] }> {
  const out: Record<string, { kind: string; line: number; conforms?: readonly string[] }> = {};
  for (const fact of extract(src).typeDeclarations ?? []) {
    expect(fact.reopens).toBe(false);
    out[fact.typeId] = {
      kind: fact.symbolKind,
      line: fact.line,
      ...(fact.conforms === undefined ? {} : { conforms: fact.conforms }),
    };
  }
  return out;
}

describe("Python walker — type and constant declarations", () => {
  it("emits every class, type alias and module-level constant of the fixture, and nothing else", () => {
    expect(factsOf(FIXTURE_SOURCE)).toEqual({
      MAX_RETRIES: { kind: "constant", line: 6 },
      _DEFAULT_TIMEOUT: { kind: "constant", line: 7 },
      TIMEOUT: { kind: "constant", line: 8 },
      limit: { kind: "constant", line: 9 },
      UserId: { kind: "type_alias", line: 12 },
      Json: { kind: "type_alias", line: 13 },
      Headers: { kind: "type_alias", line: 14 },
      Pair: { kind: "type_alias", line: 15 },
      A: { kind: "constant", line: 16 },
      B: { kind: "constant", line: 16 },
      GUARDED: { kind: "constant", line: 19 },
      Color: { kind: "enum", line: 22, conforms: ["Enum"] },
      Level: { kind: "enum", line: 26, conforms: ["IntEnum"] },
      Mode: { kind: "enum", line: 30, conforms: ["StrEnum"] },
      Perm: { kind: "enum", line: 34, conforms: ["Flag"] },
      Readable: { kind: "interface", line: 38, conforms: ["Protocol"] },
      Box: { kind: "interface", line: 42, conforms: ["Protocol"] },
      Service: { kind: "class", line: 47, conforms: ["Base", "Loggable", "Generic"] },
      "Service.Alias": { kind: "type_alias", line: 49 },
      "Service.Inner": { kind: "class", line: 51, conforms: ["Base"] },
      "Service.Inner.Deep": { kind: "class", line: 52 },
    });
  });

  it("does not emit a lower-case module assignment, a dunder, a class-body constant or a function local", () => {
    const ids = Object.keys(factsOf(FIXTURE_SOURCE));
    for (const absent of ["retries", "__all__", "Service.LIMIT", "LIMIT", "Color.RED", "RED", "LOCAL_CONST", "INNER"]) {
      expect(ids).not.toContain(absent);
    }
    expect(ids.some((id) => id.endsWith("LocalType"))).toBe(false);
  });

  it("emits the declarations in source order", () => {
    const lines = (extract(FIXTURE_SOURCE).typeDeclarations ?? []).map((fact) => fact.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it("keeps the first of two module-level declarations of one name, as collectSymbols keeps the first symbol", () => {
    const src = ["try:", "    MODE = 1", "except ImportError:", "    MODE = 2", ""].join("\n");
    expect(factsOf(src)).toEqual({ MODE: { kind: "constant", line: 2 } });
  });

  it("does not read a type variable as a constant", () => {
    const src = [
      "from typing import ParamSpec, TypeVar, TypeVarTuple",
      "T = TypeVar('T')",
      "P = ParamSpec('P')",
      "Ts = TypeVarTuple('Ts')",
      "K = typing.TypeVar('K')",
      "",
    ].join("\n");
    expect(extract(src).typeDeclarations).toBeUndefined();
  });

  it("leaves the channel absent for a file declaring no type and no constant", () => {
    expect(extract(["def f():", "    X = 1", "    return X", ""].join("\n")).typeDeclarations).toBeUndefined();
  });

  describe("an INERT module (no def, class, call or import) — the pre-materialization fast path", () => {
    const deps = { languageFactory: new LanguageFactory(), collectSymbols, composer: new DefaultSymbolIdComposer() };
    const CONSTANTS_ONLY = [
      "MAX_RETRIES = 3",
      "TIMEOUT: Final = 10",
      "retries = 4",
      "A = B = 7",
      "if DEBUG:",
      "    GUARDED = 1",
      "else:",
      "    GUARDED = 2",
      "try:",
      "    FALLBACK = 1",
      "except ImportError:",
      "    OTHER = 2",
      "CODES = {'AD': 'Andorra', 'AE': 'United Arab Emirates'}",
      "",
    ].join("\n");
    const TYPE_ALIAS_ONLY = ["type Pair = tuple[int, int]", "type Box[T] = list[T]", ""].join("\n");

    it("publishes a constants-only module's facts through the production extraction path", () => {
      expect(extractFileInMemory(deps, "pkg/settings.py", CONSTANTS_ONLY)).toEqual({
        relPath: "pkg/settings.py",
        language: "python",
        imports: [],
        chunks: [],
        fileScope: [],
        typeDeclarations: [
          { typeId: "MAX_RETRIES", symbolKind: "constant", line: 1, reopens: false },
          { typeId: "TIMEOUT", symbolKind: "constant", line: 2, reopens: false },
          { typeId: "A", symbolKind: "constant", line: 4, reopens: false },
          { typeId: "B", symbolKind: "constant", line: 4, reopens: false },
          { typeId: "GUARDED", symbolKind: "constant", line: 6, reopens: false },
          { typeId: "FALLBACK", symbolKind: "constant", line: 10, reopens: false },
          { typeId: "OTHER", symbolKind: "constant", line: 12, reopens: false },
          { typeId: "CODES", symbolKind: "constant", line: 13, reopens: false },
        ],
        typeAbstractness: { abstractTypeCount: 0, concreteTypeCount: 0 },
      });
    });

    it("publishes a bare `type X = …` module's aliases through the production extraction path", () => {
      expect(extractFileInMemory(deps, "pkg/types.py", TYPE_ALIAS_ONLY)?.typeDeclarations).toEqual([
        { typeId: "Pair", symbolKind: "type_alias", line: 1, reopens: false },
        { typeId: "Box", symbolKind: "type_alias", line: 2, reopens: false },
      ]);
    });

    it("gives a module with no module-level declaration the empty inert result plus the 0/0 census", () => {
      const extraction = extractFileInMemory(deps, "pkg/data.py", "codes = {'AD': 'Andorra'}\n");
      expect(extraction).toEqual({
        relPath: "pkg/data.py",
        language: "python",
        imports: [],
        chunks: [],
        fileScope: [],
        typeAbstractness: { abstractTypeCount: 0, concreteTypeCount: 0 },
      });
      expect(extraction).not.toHaveProperty("typeDeclarations");
    });

    it("answers from the native root the WHOLE extraction the full walk answers from the materialized tree", () => {
      for (const src of [CONSTANTS_ONLY, TYPE_ALIAS_ONLY, "codes = {'AD': 'Andorra'}\n", ""]) {
        expect(extractFileInMemory(deps, "pkg/m.py", src)).toEqual(extract(src, "pkg/m.py"));
      }
    });

    it("counts a type in the abstractness census only on a node type that makes a file walked", () => {
      // The inert path answers the census 0/0 without a traversal; that holds only
      // while the census reader answers on extraction-bearing node types alone.
      const bearing = new Set(new PythonLanguage().walker.extractionBearingNodeTypes);
      const grammarTypes = (
        JSON.parse(
          readFileSync(join(HERE, "../../../../../../node_modules/tree-sitter-python/src/node-types.json"), "utf8"),
        ) as { type: string; named: boolean }[]
      )
        .filter((t) => t.named)
        .map((t) => t.type);
      expect(grammarTypes.length).toBeGreaterThan(50);
      const counted = grammarTypes.filter((type) => {
        const node = { type, childForFieldName: () => null, namedChildren: [] } as unknown as AstNode;
        return readPythonTypeAbstractness(node) !== null;
      });
      expect(counted.length).toBeGreaterThan(0);
      expect(counted.filter((type) => !bearing.has(type))).toEqual([]);
    });
  });

  it("keeps the chunk set, symbols and CallRefs byte-identical to the pre-channel golden", () => {
    const golden = JSON.parse(readFileSync(join(FIXTURES, "extraction-golden.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const sources: Record<string, string> = { "type-declarations.py": FIXTURE_SOURCE };
    for (const file of Object.keys(golden)) {
      if (file in sources) continue;
      sources[file] = readFileSync(join(ORACLE_PKG, file), "utf8");
    }
    const actual: Record<string, unknown> = {};
    for (const [file, src] of Object.entries(sources)) {
      const { typeDeclarations: _facts, ...rest } = extract(src, `pkg/${file}`);
      // `assignedLocals` (bd tea-rags-mcp-m99j1.1.57) is a later per-chunk
      // channel the golden predates; everything it does not add stays pinned.
      const chunks = rest.chunks.map(({ assignedLocals: _assigned, ...chunk }) => chunk);
      // The declaring-file twin of a member return key (bd
      // tea-rags-mcp-m99j1.1.35) is a later key the golden predates likewise.
      const twin = `pkg/${file}::`;
      const returns = Object.entries(rest.structuredReturnTypes ?? {}).filter(
        ([key]) => !key.startsWith(twin) || !/[#.]/.test(key.slice(twin.length)),
      );
      const pinned =
        rest.structuredReturnTypes === undefined
          ? rest
          : { ...rest, structuredReturnTypes: Object.fromEntries(returns) };
      actual[file] = JSON.parse(JSON.stringify({ ...pinned, chunks }));
    }
    expect(actual).toEqual(golden);
  });
});
