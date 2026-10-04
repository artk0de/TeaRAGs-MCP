/**
 * The one place the TS call resolver obtains the `typescript` runtime module.
 *
 * `typescript` is ~9MB of CommonJS and costs ~100-300ms to load. A static
 * `import ts from "typescript"` anywhere under the resolver made every importer
 * of the language domain pay that — the whole test suite, and the chunker
 * worker on every fork, which never resolves a call (bd tea-rags-mcp-bbo1h.2).
 * Resolver modules therefore hold only `import type ts from "typescript"` and
 * call `loadTypeScriptCompiler()` at use time; the package is required on the
 * first call and memoized.
 *
 * `createRequire` keeps the load synchronous, so the resolver API stays sync.
 */
import { createRequire } from "node:module";

import type ts from "typescript";

type TypeScriptCompiler = typeof ts;

let compiler: TypeScriptCompiler | undefined;

export function loadTypeScriptCompiler(): TypeScriptCompiler {
  compiler ??= createRequire(import.meta.url)("typescript") as TypeScriptCompiler;
  return compiler;
}
