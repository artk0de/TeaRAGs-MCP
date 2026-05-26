import type { ComposeSymbolIdOptions, SymbolIdComposer } from "../../../contracts/types/language.js";
import { INSTANCE_METHOD_SEPARATOR } from "../../../infra/symbolid/classify.js";

/**
 * Default `SymbolIdComposer` — the cross-language symbolId mapper at the core
 * (kernel) of the language domain. Behaviour-preserving unification of the two
 * pre-existing builders (spec §1a):
 *   - chunker `tree-sitter.ts:buildSymbolId(name, parentName, isStatic)`
 *   - codegraph `provider.ts:joinSymbol(composed, child, scopeSeparator)`
 *
 * Pure and stateless. It never inspects an AST node — callers resolve the
 * `methodKind` / `scopeSeparator` / `absolute` flags and this maps them to the
 * `#` (instance) / `.` (static) / `<scopeSeparator>` (namespace) string rule.
 * Injected into every symbolId-building consumer via `api/internal/` DI.
 */
export class DefaultSymbolIdComposer implements SymbolIdComposer {
  compose(prefix: string, localName: string, opts: ComposeSymbolIdOptions = {}): string {
    if (opts.absolute) return localName;
    if (prefix.length === 0) return localName;
    const sep =
      opts.methodKind === "instance"
        ? INSTANCE_METHOD_SEPARATOR
        : opts.methodKind === "static"
          ? "."
          : (opts.scopeSeparator ?? ".");
    return `${prefix}${sep}${localName}`;
  }
}
