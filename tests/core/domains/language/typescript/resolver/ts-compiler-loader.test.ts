import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The whole language domain, imported for its side effect: what is under test is
// what loading it pulls in. A static import, so the transform of the domain's
// module graph is paid at collection and not against a test's wall-clock budget.
import "../../../../../../src/core/domains/language/index.js";

import { loadTypeScriptCompiler } from "../../../../../../src/core/domains/language/typescript/resolver/ts-compiler-loader.js";

// The `typescript` package is ~9MB of CommonJS. Every importer of the language
// domain — 349 test files, and the chunker worker on each fork, which never
// resolves a call — used to pay ~100-300ms to load it (bd tea-rags-mcp-bbo1h.2).
// Only the TS call resolver needs it, so it is loaded on first use. The cases run
// in order: the first one must observe the package NOT loaded yet.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const TYPESCRIPT_PACKAGE_SEGMENT = `${sep}node_modules${sep}typescript${sep}`;
const requireFromHere = createRequire(import.meta.url);

function typescriptPackageLoaded(): boolean {
  return Object.keys(requireFromHere.cache).some((path) => path.includes(TYPESCRIPT_PACKAGE_SEGMENT));
}

describe("loadTypeScriptCompiler — the typescript package is loaded on first use", () => {
  it("importing the language domain does not load the typescript package", () => {
    expect(typescriptPackageLoaded()).toBe(false);
  });

  it("the first call loads the compiler and later calls return the same module", () => {
    const compiler = loadTypeScriptCompiler();

    expect(typescriptPackageLoaded()).toBe(true);
    expect(typeof compiler.createProgram).toBe("function");
    expect(compiler.SyntaxKind.CallExpression).toBeTypeOf("number");
    expect(loadTypeScriptCompiler()).toBe(compiler);
  });

  it("the compiled language domain the chunker worker loads does not load the typescript package", () => {
    const probe = [
      'import { createRequire } from "node:module";',
      `await import(${JSON.stringify(resolve(REPO_ROOT, "build/core/domains/language/index.js"))});`,
      `const cache = createRequire(${JSON.stringify(resolve(REPO_ROOT, "package.json"))}).cache;`,
      `process.stdout.write(String(Object.keys(cache).some((p) => p.includes(${JSON.stringify(TYPESCRIPT_PACKAGE_SEGMENT)}))));`,
    ].join("\n");

    const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(output).toBe("false");
  });
});
