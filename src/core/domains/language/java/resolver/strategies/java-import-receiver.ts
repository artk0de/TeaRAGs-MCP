import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Well-known `java.lang` public top-level classes/interfaces. The JLS
 * auto-imports every type in `java.lang` into every compilation unit, so a
 * static call like `Character.isWhitespace(c)` or `Math.max(a, b)` carries NO
 * `import` statement. Without this whitelist the resolver cannot distinguish a
 * java.lang static receiver from a genuinely-unknown capitalized identifier and
 * drops the edge. Membership here authorizes emitting an EXTERNAL
 * type-qualified target (`Type.method`) for such receivers; everything NOT
 * listed still drops, so the whitelist never devolves into "any capitalized
 * receiver" (the false-positive guard).
 *
 * Curated to the common public top-level java.lang types. Exotic / rarely
 * statically-called types are intentionally trimmed.
 */
const JAVA_LANG_AUTO_IMPORTED_TYPES: ReadonlySet<string> = new Set([
  "String",
  "Integer",
  "Long",
  "Double",
  "Float",
  "Boolean",
  "Byte",
  "Short",
  "Character",
  "Math",
  "System",
  "Object",
  "Thread",
  "Runtime",
  "Class",
  "Number",
  "StringBuilder",
  "StringBuffer",
  "Iterable",
  "Comparable",
  "Runnable",
  "CharSequence",
  "Throwable",
  "Exception",
  "RuntimeException",
  "Error",
  "Void",
  "Enum",
  "Record",
  "Process",
  "ClassLoader",
]);

/**
 * The receiver-present resolution pass — the one **guard** strategy. When
 * `call.receiver` is set (and earlier this/field/local-binding passes did not
 * claim it) this pass owns the call and is TERMINAL: it either resolves or
 * DROPS, never falls through to the bare-call / global short-name passes. That
 * guard is load-bearing — falling through would let `random().nextBytes()`,
 * `Helper.compute()`, or `cs.charAt()` misroute to a same-class short-name
 * match and fabricate a false-positive edge.
 *
 * Resolution order inside the pass:
 *   1. import match → map import to file, pin the member there (symbol or
 *      file-only `targetSymbolId: null`).
 *   2. wildcard / no-import salvage → scope-filtered short-name (candidate's
 *      owning class name equals the receiver).
 *   3. java.lang whitelist → EXTERNAL type-qualified static target.
 *   4. otherwise DROP (receiver present, unresolvable — no fall-through).
 */
export class JavaImportReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importReceiver";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const { receiver } = call;

    const match = ctx.imports.find((imp) => javaImportMatchesReceiver(imp.importText, receiver));
    if (match) {
      const targetFile = mapJavaImportToFile(match.importText);
      if (targetFile) {
        const candidates = ctx.symbolTable
          .lookupByShortName(call.member)
          .filter((def) => def.relPath === targetFile || def.relPath.endsWith(`/${targetFile}`));
        const target = pickSingleCandidate(candidates, this.cfg.mode);
        if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
        return resolved({ targetRelPath: targetFile, targetSymbolId: null });
      }
    }
    // No import matched. Salvage one safe case: wildcard imports
    // (`import com.foo.*`) bring all classes from a package into scope without a
    // per-class import line. We can still resolve `Bar.method()` IF some
    // candidate's owning class name equals the receiver. This filter also
    // rejects the false-positive cases that motivated the bug:
    // `Character.isWhitespace` against `StringUtils.isWhitespace`
    // (scope=[StringUtils] != "Character"), `cs.charAt` against
    // `StrBuilder#charAt` (scope=[StrBuilder] != "cs"), `random().nextBytes()`
    // against `RandomUtils.nextBytes` (scope=[RandomUtils] != "random()").
    const filteredByScope = ctx.symbolTable
      .lookupByShortName(call.member)
      .filter((def) => def.scope[def.scope.length - 1] === receiver);
    const target = pickSingleCandidate(filteredByScope, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    // bd tea-rags-mcp — java.lang implicit static-call resolution. The receiver
    // matched no import, no local/field binding, and no scoped symbol.
    // `java.lang` types (`Character`, `Math`, `Integer`, …) are auto-imported
    // with NO `import` line, so `Character.isWhitespace(c)` reaches here
    // unresolved and would be dropped. When the receiver is a known java.lang
    // public top-level type, emit an EXTERNAL type-qualified target — mirroring
    // `resolveByLocalType`'s external anchoring for CharSequence. STATIC form
    // (`Type.method` with a dot) because the receiver is a TYPE name, not a
    // variable. Restricted to the WHITELIST so a genuinely-unknown capitalized
    // receiver (`Foo.bar`) still drops — no false-positive edge storm.
    if (JAVA_LANG_AUTO_IMPORTED_TYPES.has(receiver)) {
      return resolved({ targetRelPath: receiver, targetSymbolId: `${receiver}.${call.member}` });
    }
    // Receiver present but unresolvable — TERMINAL drop. Must NOT fall through
    // to the bare-call / global short-name passes (false-positive guard).
    return DROP;
  }
}

export function mapJavaImportToFile(importText: string): string | null {
  // Strip wildcards — they point at directories, not specific files.
  if (importText.endsWith(".*")) return null;
  // Static import: drop trailing `.methodName` (the part after the
  // last segment whose first letter is uppercase signifies the class).
  const segments = importText.split(".");
  // Find the class segment (first uppercase-leading segment).
  let classIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] ?? "";
    if (s.length > 0 && s[0] >= "A" && s[0] <= "Z") {
      classIdx = i;
      break;
    }
  }
  if (classIdx === -1) return null;
  const pathSegments = segments.slice(0, classIdx + 1);
  return `${pathSegments.join("/")}.java`;
}

function javaImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Wildcard imports — receiver might match any class in that package
  // but we can't pin a specific one here. Reject so caller falls
  // through to global lookup.
  if (importText.endsWith(".*")) return false;
  const segments = importText.split(".");
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
