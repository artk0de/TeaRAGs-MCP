/**
 * Throwaway probe: does `ts.createProgram` include files BEYOND its rootNames?
 *
 * `TSProgramCache` caps the ROOT set at `maxRootFiles=200` and the closure walk
 * at `maxImportDepth=2`, then hands those roots to `ts.createProgram`. The open
 * question is whether that cap bounds the Program at all — the compiler runs its
 * own unbounded `processImportedModules` walk over every root, so the SourceFile
 * population it actually binds may be far larger than the root set.
 *
 * Writes a synthetic import CHAIN of configurable depth into a scratch dir,
 * builds a Program from ONE root, and reports roots vs included files.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

const ROOT = "/tmp/ts-inclusion-probe";
const DEPTH = 40;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "src"), { recursive: true });

// a0 imports a1 imports a2 … a{DEPTH-1}: a single unbranched chain, so the only
// thing that can pull aN into a Program rooted at a0 is the compiler's own walk.
for (let i = 0; i < DEPTH; i++) {
  const next = i + 1;
  const body =
    i < DEPTH - 1
      ? `import { f${next} } from "./a${next}.js";\nexport function f${i}(): number { return f${next}(); }\n`
      : `export function f${i}(): number { return 1; }\n`;
  writeFileSync(join(ROOT, "src", `a${i}.ts`), body);
}
writeFileSync(join(ROOT, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }));

const options = {
  allowJs: true,
  noEmit: true,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  types: [],
};

// Exactly what TSProgramCache does: ONE root (the entry file), nothing else.
const rootNames = [join(ROOT, "src", "a0.ts")];
const host = ts.createCompilerHost(options, true);
const program = ts.createProgram({ rootNames, options, host });

const all = program.getSourceFiles();
const project = all.filter((f) => f.fileName.startsWith(ROOT));
const lib = all.length - project.length;

console.log(
  JSON.stringify(
    {
      chainDepth: DEPTH,
      rootNames: rootNames.length,
      includedTotal: all.length,
      includedProject: project.length,
      includedLib: lib,
    },
    null,
    2,
  ),
);
console.log(
  "project files pulled in:",
  project
    .map((f) => f.fileName.replace(`${ROOT}/src/`, ""))
    .sort()
    .join(" "),
);
