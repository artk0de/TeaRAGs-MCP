import {
  pickSingleCandidate,
  type CallContext,
  type RelPath,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../../contracts/types/language.js";
import { isPythonPlacedClassKey, pythonClassKey } from "../python-class-key.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { resolveTypeFile } from "./python-local-binding.js";
import { lastSegment, lookupPythonSymbolsByShortName, type ResolverConfig } from "./shared.js";

/**
 * Python specifics for the generic `ConeDispatchResolver` (bd tea-rags-mcp-f10y,
 * N=2). Supplies the two language-specific cone primitives:
 *
 *   - `resolveTypeFile` — Python module/type resolution. Reuses the same
 *     `resolveTypeFile` helper the `python-local-binding` strategy uses
 *     (symbol-table lookup → import-set disambiguation → import-path fallback),
 *     reduced to the bare class name first (`lastSegment` strips a qualified
 *     `module.ClassName`).
 *   - `findDirectMethod` — scope-tail match against the symbol table using
 *     Python's `.` scope separator (a method-level override pin on the type's
 *     own file). Mirrors `RubyConeTypeLocator` but with Python conventions:
 *     scope tails are bare class names (the walker scopes methods by class
 *     name), so the override check is the same candidate filter the
 *     `python-local-binding` strategy applies for the direct-method case.
 *
 * The CHA algorithm itself (descendants ∩ override, K-threshold, cone /
 * poly-base policy, confidence) lives in the language-neutral engine; this
 * locator carries ONLY the Python naming/resolution conventions.
 */
export class PythonConeTypeLocator implements ConeTypeLocator {
  /**
   * `mapper` is the resolver's shared `PythonImportFileMapper` — the cone
   * reaches `resolveTypeFile`, so it asks the same import question the chain
   * does and must read the same memo (bd tea-rags-mcp-9fgdi). A caller with no
   * other consumer omits it and gets a private one.
   */
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
  ) {}

  /** Resolve a (possibly qualified) Python type name to its declaring file, or null. */
  resolveTypeFile(typeName: string, ctx: CallContext): RelPath | null {
    return resolveTypeFile(lastSegment(typeName), ctx, this.mapper);
  }

  /**
   * Method-level pin of `<typeName>.<member>` declared DIRECTLY on `typeName`'s
   * own file (no ancestor walk — an override is a direct redefinition).
   * `null` when the type's file is unknown or the method isn't declared there.
   */
  findDirectMethod(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const bareType = lastSegment(typeName);
    const file = resolveTypeFile(bareType, ctx, this.mapper);
    if (!file) return null;
    const candidates = lookupPythonSymbolsByShortName(ctx, member, { role: "callee" }).filter((def) => {
      if (def.relPath !== file) return false;
      const tail = def.scope[def.scope.length - 1];
      return tail === typeName || tail === bareType;
    });
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
  }

  /**
   * A class is a runtime dispatch target unless it is a `typing.Protocol` —
   * a structural contract nothing instantiates, whose member is a stub (bd
   * tea-rags-mcp-m99j1.1.84). Python requires every Protocol to list
   * `Protocol` among its OWN bases (a subclass that omits it is a concrete
   * class), so the direct `classAncestors` spellings decide. A class whose
   * bases are unknown is a runtime class: the stub case needs evidence.
   */
  isRuntimeDispatchClass(typeName: string, ctx: CallContext): boolean {
    const classKey = isPythonPlacedClassKey(typeName) ? typeName : this.classKeyOf(typeName, ctx);
    const bases = classKey === null ? undefined : ctx.classAncestors?.[classKey];
    return !(bases ?? []).some(namesTypingProtocol);
  }

  private classKeyOf(typeName: string, ctx: CallContext): string | null {
    const file = resolveTypeFile(lastSegment(typeName), ctx, this.mapper);
    return file ? pythonClassKey(file, typeName) : null;
  }
}

const PROTOCOL_MODULES: ReadonlySet<string> = new Set(["typing", "typing_extensions"]);

/**
 * Does one `classAncestors` base spelling name `typing.Protocol`? Spellings are
 * `module::Name` (`typing::Protocol`), a dotted name off a module import
 * (`typing::typing.Protocol`), or a `|`-joined star-import disjunction; a
 * generic argument list is stripped.
 */
function namesTypingProtocol(spelling: string): boolean {
  return spelling.split("|").some((alternative) => {
    const sep = alternative.lastIndexOf("::");
    const module = sep < 0 ? null : alternative.slice(0, sep);
    const name = (sep < 0 ? alternative : alternative.slice(sep + 2)).replace(/\[.*$/s, "");
    const dot = name.lastIndexOf(".");
    const head = dot < 0 ? module : name.slice(0, dot);
    const tail = dot < 0 ? name : name.slice(dot + 1);
    return tail === "Protocol" && head !== null && PROTOCOL_MODULES.has(head);
  });
}
