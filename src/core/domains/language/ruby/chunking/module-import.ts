import type { AstNode } from "../../../../contracts/types/ast.js";

/** Kernel methods that load another file — Ruby's imports are ordinary calls. */
const LOADING_METHODS = new Set(["require", "require_relative", "load", "autoload"]);

/**
 * `LanguageChunkerHooks.isModuleImport` for Ruby: a top-level receiver-less
 * `require` / `require_relative` / `load` / `autoload` call. The engine keeps
 * these out of the module remainder, as it keeps every grammar's
 * `import_statement` out, so a file's `require` header is not chunked on its own.
 */
export function isRubyModuleImport(node: AstNode): boolean {
  if (node.type !== "call" || node.childForFieldName("receiver") !== null) return false;
  const method = node.childForFieldName("method");
  return method !== null && LOADING_METHODS.has(method.text);
}
