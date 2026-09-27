/**
 * bd tea-rags-mcp-s9b0d — `payload.imports` for an ECMAScript file is read off
 * the AST the chunker already parsed, not off a line-bound regex. The regex
 * harvest lost every multi-line `import { … } from`, every `export … from`
 * re-export, bare side-effect imports and dynamic `import()`: the codegraph
 * resolution runner declared 10 imports and was recorded with 7.
 *
 * The AST keeps the mjq5n guarantee by construction — a comment or a string
 * literal is its own node, so import-shaped text inside one names nothing.
 */
import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";

const chunker = new TreeSitterChunker(
  { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
  new DefaultSymbolIdComposer(),
  new LanguageFactory(),
);

const ESM_MODULE = [
  `import { identifierEntry } from "./a.js";`,
  `import {`,
  `  first,`,
  `  second,`,
  `} from "./b.js";`,
  `import "./side-effect.js";`,
  `export { third } from "./c.js";`,
  `export * from "./d.js";`,
  `export * as ns from "./e.js";`,
  `/**`,
  ` * import { ghost } from "./comment-ghost.js";`,
  ` */`,
  `// const phantom = require("./line-comment-ghost.js");`,
  `const probe = "import x from './string-ghost.js'";`,
  `const fixture = \`import y from "./template-ghost.js"\`;`,
  `const fs = require("node:fs");`,
  `export async function load(): Promise<unknown> {`,
  `  const { lazy } = await import("./f.js");`,
  `  return lazy(first, second, third, fs, probe, fixture);`,
  `}`,
].join("\n");

const EXPECTED = ["./a.js", "./b.js", "./side-effect.js", "./c.js", "./d.js", "./e.js", "node:fs", "./f.js"];

describe("ECMAScript import specifiers from the chunk parse (bd tea-rags-mcp-s9b0d)", () => {
  it.each([
    ["typescript", "src/loader.ts"],
    ["javascript", "src/loader.js"],
  ])("%s: every module reference in code, in source order, none from comments or strings", async (language, path) => {
    const code = language === "javascript" ? ESM_MODULE.replace(": Promise<unknown>", "") : ESM_MODULE;

    const { imports } = await chunker.chunkWithTree(code, path, language);

    expect(imports).toEqual(EXPECTED);
  });

  it("keeps a statement-level `import type` as a declared dependency", async () => {
    const code = [`import type {`, `  Shape,`, `} from "./shape.js";`, `export const area = (s: Shape) => s;`].join(
      "\n",
    );

    const { imports } = await chunker.chunkWithTree(code, "src/area.ts", "typescript");

    expect(imports).toEqual(["./shape.js"]);
  });

  it("ignores a non-literal specifier", async () => {
    const code = [`export async function load(name: string) {`, "  return import(`./` + name);", `}`].join("\n");

    const { imports } = await chunker.chunkWithTree(code, "src/dynamic.ts", "typescript");

    expect(imports).toEqual([]);
  });

  it("reports no AST specifiers for a language with no reader, so ingest keeps its regex harvest", async () => {
    const { imports } = await chunker.chunkWithTree(
      "import os\n\ndef f():\n    return os.getcwd()\n",
      "a.py",
      "python",
    );

    expect(imports).toBeUndefined();
  });
});
