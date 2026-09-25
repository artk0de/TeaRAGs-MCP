/**
 * Every native language reaches its extraction through the pass-runner (bd
 * tea-rags-mcp-zhetx, E1 seam 0), and with an EMPTY pass list that composition
 * is a relocation: `composeExtractionWalker(...).walk(input)` hands the native
 * monolith's own object straight back.
 *
 * Two claims per language, because neither alone is the guarantee:
 *
 *  - IDENTITY, with the language's real exported pass list. The native walker
 *    allocates a fresh `FileExtraction` per call, so `toBe` across two calls can
 *    never hold; what the composer promises is that it returns what `walk`
 *    returned, unwrapped and unmerged. Stubbing `walk` with a sentinel — the
 *    native extraction of the same fixture — states exactly that, and the
 *    assertion goes red the day the language adds a pass, which is the day its
 *    output can move.
 *  - PARITY through the factory: the walker a consumer actually gets from
 *    `LanguageFactory` produces what calling `extractFrom<Lang>File` directly
 *    produces. That is what catches a mis-wired `walk` in `<lang>/index.ts`.
 *
 * Python is absent by design: `PYTHON_EXTRACTION_PASSES` carries the annotation
 * type-fact facet, so identity does NOT hold there — the merge is the point.
 * Go left the identity set the same way when `GO_EXTRACTION_PASSES` gained the
 * struct-field facet (bd tea-rags-mcp-e6xx); its wiring is pinned below as
 * "the native extraction plus exactly that facet's channel". TypeScript,
 * JavaScript, Java and Rust left it when they gained the declared-visibility
 * facet (bd tea-rags-mcp-jwjyr.1): a case carrying `visibilityFacet` is pinned
 * as "the native extraction plus exactly those chunks' `visibility`", which
 * is the same claim — nothing else moves — for a language with a pass.
 *
 * INVARIANT CHANGED (bd tea-rags-mcp-r8hme.8): every language with types gained
 * the type-abstractness census facet, so "plus its facets" now includes the
 * file's `typeAbstractness` — each fixture declares one concrete type and no
 * abstraction. Bash declares no types, so it gains no census.
 *
 * Bash, the last member, left it when it gained the identifier-declaration
 * facet (bd tea-rags-mcp-4p3sb.6). Every language here now carries that facet
 * too; each fixture declares no parameter or local inside a symbol. Since bd
 * tea-rags-mcp-4p3sb.21 a function's return annotation is a `return`
 * declaration, so a fixture whose method states its return type is pinned as
 * the merge plus exactly that one declaration (`declarationFacet`). The
 * identity branch stays for a language that joins with an empty pass list.
 */

import Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageWalker, WalkInput } from "../../../../../src/core/contracts/types/language.js";
import { BASH_EXTRACTION_PASSES } from "../../../../../src/core/domains/language/bash/walker/passes.js";
import { extractFromBashFile } from "../../../../../src/core/domains/language/bash/walker/walker.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { GO_EXTRACTION_PASSES } from "../../../../../src/core/domains/language/go/walker/passes.js";
import { extractFromGoFile } from "../../../../../src/core/domains/language/go/walker/walker.js";
import { JAVA_EXTRACTION_PASSES } from "../../../../../src/core/domains/language/java/walker/passes.js";
import { extractFromJavaFile } from "../../../../../src/core/domains/language/java/walker/walker.js";
import { JAVASCRIPT_EXTRACTION_PASSES } from "../../../../../src/core/domains/language/javascript/walker/passes.js";
import { extractFromJavascriptFile } from "../../../../../src/core/domains/language/javascript/walker/walker.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import {
  composeExtractionWalker,
  type ExtractionFacetPass,
} from "../../../../../src/core/domains/language/kernel/extraction-passes.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RUST_EXTRACTION_PASSES } from "../../../../../src/core/domains/language/rust/walker/passes.js";
import { extractFromRustFile } from "../../../../../src/core/domains/language/rust/walker/walker.js";
import { TYPESCRIPT_EXTRACTION_PASSES } from "../../../../../src/core/domains/language/typescript/walker/passes.js";
import { extractFromTypescriptFile } from "../../../../../src/core/domains/language/typescript/walker/walker.js";
import { materializeTree } from "../../../../../src/core/infra/materialize.js";

interface LanguageCase {
  readonly language: string;
  readonly relPath: string;
  readonly code: string;
  readonly passes: readonly ExtractionFacetPass[];
  readonly native: (input: WalkInput) => FileExtraction;
  /** symbolId → the `visibility` the declared-visibility facet adds. Absent ⇒ no visibility facet. */
  readonly visibilityFacet?: Readonly<Record<string, string>>;
  /** The `identifierDeclarations` the identifier-declaration facet adds. Absent ⇒ none. */
  readonly declarationFacet?: FileExtraction["identifierDeclarations"];
}

/** Each fixture declares exactly one concrete type (class / struct) and no abstraction. */
const ONE_CONCRETE_TYPE = { typeAbstractness: { abstractTypeCount: 0, concreteTypeCount: 1 } };

/** The native extraction with exactly the facet's `visibility` added to its chunks. */
function withVisibility(native: FileExtraction, facet: Readonly<Record<string, string>>): FileExtraction {
  return {
    ...native,
    chunks: native.chunks.map((chunk) => {
      const visibility = facet[chunk.symbolId] as FileExtraction["chunks"][number]["visibility"];
      return visibility === undefined ? chunk : { ...chunk, visibility };
    }),
  };
}

/** The extraction with exactly the facet's declarations added; absent adds nothing. */
function withDeclarations(
  extraction: FileExtraction,
  facet: FileExtraction["identifierDeclarations"] | undefined,
): FileExtraction {
  return facet === undefined ? extraction : { ...extraction, identifierDeclarations: facet };
}

/** The one `return` declaration a fixture's `run` method states. */
function returnOf(ownerSymbolId: string, name: string, line: number, typeName: string) {
  return [{ name, kind: "return" as const, line, ownerSymbolId, typeName, typeSource: "annotation" as const }];
}

/**
 * One fixture per language, each carrying an import, a container and a call, so
 * the compared extraction is non-empty on every channel the monolith fills —
 * comparing two empty extractions would pass whatever the wiring did.
 */
const CASES: readonly LanguageCase[] = [
  {
    language: "typescript",
    relPath: "svc.ts",
    code: 'import { helper } from "./helper.js";\n\nexport class Svc {\n  run(): string {\n    return helper();\n  }\n}\n',
    passes: TYPESCRIPT_EXTRACTION_PASSES,
    native: extractFromTypescriptFile,
    visibilityFacet: { "Svc#run": "public" },
    declarationFacet: returnOf("Svc#run", "run", 4, "string"),
  },
  {
    language: "javascript",
    relPath: "svc.js",
    code: 'const { helper } = require("./helper.js");\n\nclass Svc {\n  run() {\n    return helper();\n  }\n}\n\nmodule.exports = { Svc };\n',
    passes: JAVASCRIPT_EXTRACTION_PASSES,
    native: extractFromJavascriptFile,
    visibilityFacet: { "Svc#run": "public" },
  },
  {
    language: "java",
    relPath: "Svc.java",
    code: "import java.util.List;\n\npublic class Svc {\n  public String run() {\n    return List.of().toString();\n  }\n}\n",
    passes: JAVA_EXTRACTION_PASSES,
    native: extractFromJavaFile,
    visibilityFacet: { Svc: "public", "Svc#run": "public" },
    declarationFacet: returnOf("Svc#run", "run", 4, "String"),
  },
  {
    language: "rust",
    relPath: "svc.rs",
    code: 'use std::fmt;\n\npub struct Svc;\n\nimpl Svc {\n    pub fn run(&self) -> String {\n        fmt::format(format_args!("x"))\n    }\n}\n',
    passes: RUST_EXTRACTION_PASSES,
    native: extractFromRustFile,
    visibilityFacet: { Svc: "public", "Svc#run": "public" },
    declarationFacet: returnOf("Svc#run", "run", 6, "String"),
  },
  {
    language: "bash",
    relPath: "svc.sh",
    code: 'source ./helper.sh\n\nrun() {\n  helper "$1"\n}\n\nrun x\n',
    passes: BASH_EXTRACTION_PASSES,
    native: extractFromBashFile,
  },
];

const factory = new LanguageFactory();
const inputs = new Map<string, WalkInput>();

/**
 * The production extraction input, built the way `extractFile` builds it: a
 * materialized tree plus the symbols `collectSymbols` derives through the
 * language's own `nameOf`.
 */
async function buildInput(testCase: LanguageCase): Promise<WalkInput> {
  const { kernel, walker } = factory.create(testCase.language);
  const mod = await kernel.loadModule();
  const parser = new Parser();
  parser.setLanguage((kernel.extractLanguage?.(mod ?? {}) ?? mod) as Parser.Language);
  const tree = { rootNode: materializeTree(parser.parse(testCase.code).rootNode, testCase.code) };
  const chunks = collectSymbols(
    tree,
    (node) => (walker as LanguageWalker).nameOf(node),
    kernel.scopeSeparator ?? ".",
    false,
    new DefaultSymbolIdComposer(),
  );
  return { tree, code: testCase.code, relPath: testCase.relPath, language: testCase.language, chunks };
}

describe("native walkers composed through the extraction pass-runner", () => {
  beforeAll(async () => {
    for (const testCase of CASES) inputs.set(testCase.language, await buildInput(testCase));
  });

  for (const testCase of CASES) {
    const { language, passes, native, visibilityFacet, declarationFacet } = testCase;

    if (passes.length === 0) {
      it(`${language}: the composer returns the native extraction BY IDENTITY under its own pass list`, () => {
        const input = inputs.get(language) as WalkInput;
        const sentinel = native(input);
        const composed = composeExtractionWalker({ walk: () => sentinel, nameOf: () => null, passes });

        expect(composed.walk(input)).toBe(sentinel);
      });
    } else {
      it(`${language}: the composer merges its facets onto the native extraction and nothing else`, () => {
        const input = inputs.get(language) as WalkInput;
        const sentinel = native(input);
        const composed = composeExtractionWalker({ walk: () => sentinel, nameOf: () => null, passes });

        expect(composed.walk(input)).toEqual({
          ...withDeclarations(withVisibility(sentinel, visibilityFacet ?? {}), declarationFacet),
          ...(visibilityFacet === undefined ? {} : ONE_CONCRETE_TYPE),
        });
      });
    }

    it(`${language}: the factory's walker extracts what the native monolith extracts, plus its facets`, () => {
      const input = inputs.get(language) as WalkInput;
      const viaFactory = factory.create(language).walker.walk(input);

      expect(viaFactory).toEqual({
        ...withDeclarations(withVisibility(native(input), visibilityFacet ?? {}), declarationFacet),
        ...(visibilityFacet === undefined ? {} : ONE_CONCRETE_TYPE),
      });
      expect(viaFactory.chunks.length).toBeGreaterThan(0);
    });
  }
});

/**
 * Go carries two facets, so the composed extraction is the monolith's PLUS those
 * facets' channels and nothing else: a pass that touched any other channel, or a
 * `walk` wired to something other than `extractFromGoFile`, fails here.
 */
describe("go walker composed through the extraction pass-runner", () => {
  const GO_CASE: LanguageCase = {
    language: "go",
    relPath: "svc.go",
    code: 'package main\n\nimport "fmt"\n\ntype Svc struct{}\n\nfunc (s Svc) Run() string {\n\treturn fmt.Sprint("x")\n}\n',
    passes: GO_EXTRACTION_PASSES,
    native: extractFromGoFile,
  };
  const STRUCT_FACET = { classFieldTypesByClassKey: { "svc.go::Svc": {} } };
  const VISIBILITY_FACET = { Svc: "public", "Svc#Run": "public" };
  const DECLARATION_FACET = { identifierDeclarations: returnOf("Svc#Run", "Run", 7, "string") };
  let input: WalkInput;

  beforeAll(async () => {
    input = await buildInput(GO_CASE);
  });

  it("go: the composer merges the struct-field and visibility facets onto the native extraction and nothing else", () => {
    const sentinel = extractFromGoFile(input);
    const composed = composeExtractionWalker({
      walk: () => sentinel,
      nameOf: () => null,
      passes: GO_EXTRACTION_PASSES,
    });

    expect(composed.walk(input)).toEqual({
      ...withVisibility(sentinel, VISIBILITY_FACET),
      ...STRUCT_FACET,
      ...ONE_CONCRETE_TYPE,
      ...DECLARATION_FACET,
    });
  });

  it("go: the factory's walker extracts the native monolith's output plus the struct-field and visibility facets", () => {
    const viaFactory = factory.create("go").walker.walk(input);

    expect(viaFactory).toEqual({
      ...withVisibility(extractFromGoFile(input), VISIBILITY_FACET),
      ...STRUCT_FACET,
      ...ONE_CONCRETE_TYPE,
      ...DECLARATION_FACET,
    });
    expect(viaFactory.chunks.length).toBeGreaterThan(0);
  });
});
