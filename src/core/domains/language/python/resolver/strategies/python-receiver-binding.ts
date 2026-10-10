/**
 * What a Python call-site receiver denotes before any type is read: the class
 * a call is written inside (the `self` / `cls` origin), whether the receiver
 * was bound from a call the project does not declare, and the module text an
 * imported single-identifier receiver names. Split out of `strategies/shared.ts`
 * by cohesion cluster (bd tea-rags-mcp-0qaht.43); `shared.ts` re-exports every
 * name.
 */

import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import { nearestCallResultBinding, type CallContext } from "../../../../../contracts/types/codegraph.js";
import { pythonClassKey } from "./python-class-key.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { pythonAliasedClassKey, pythonClassKeyIsDeclared, type PythonImportBinding } from "./python-type-addressing.js";
import { lookupPythonSymbolsByShortName } from "./short-name-lookup.js";

/**
 * Was `receiver` assigned, at or above `atLine`, from a call whose CALLEE the
 * project does not declare?
 *
 * The head is what carries the answer, and only the head: `User.objects.get`
 * starts on a project class and its result is overwhelmingly an instance of it,
 * while `authenticate(...)`, `get_object_or_404(...)`, `RQ_Job.fetch` and
 * `logging.getLogger(...)` start outside and their results are library values
 * that happen to be spelled like a project name. Measured on seam 5's A/B:
 * gating on the mere PRESENCE of a call binding removed 7 phantoms (netbox 5,
 * ugnest 2) but cost 12 correct answers, eleven of them ugnest rows bound by
 * `User.objects.get`. Gating on the head's origin removes the same 7 and costs
 * one row, because that is the axis the two populations actually differ on.
 *
 * `self` / `cls` heads are the caller's own object and never foreign. The lookup
 * is a symbol-table short-name probe, so a caller that was already going to weigh
 * the site adds no new scan. A spine ROOTED at a constructor call
 * (`Engine().from_string`, bd tea-rags-mcp-m99j1.1.74) has the CLASS as its
 * head — the walker renders the root's arguments elided, and the `()` is
 * stripped before the probe.
 *
 * A head an import RENAMED is read through its binding (bd
 * tea-rags-mcp-m99j1.1.81): `from app.models import Engine as E2` makes `E2`
 * the project's `Engine`, which no short-name probe of `E2` can see. The
 * binding answers only when its module maps into the project — an alias of a
 * library name stays foreign even when the project declares a namesake of the
 * source name, and an unbound head is probed exactly as before.
 *
 * Two readers, one definition: `namingConvention` guesses a class from the
 * receiver's SPELLING, the untyped-name dispatch component fans over the
 * member's owners — and both are wrong on exactly this shape.
 */
export function pythonBoundToForeignCall(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): boolean {
  const binding = nearestCallResultBinding(ctx.callResultBindings, receiver, atLine);
  if (binding === undefined) return false;
  const spelled = binding.callee.split(".")[0] ?? "";
  const head = spelled.endsWith("()") ? spelled.slice(0, -2) : spelled;
  if (head === "self" || head === "cls" || head.length === 0) return false;
  if (lookupPythonSymbolsByShortName(ctx, head).length > 0) return false;
  return pythonAliasedClassKey(head, ctx, mapper) === null;
}

/** The class a call site is written inside, addressed the way the run keys classes. */
export interface PythonEnclosingClass {
  /** `<relPath>::<dotted class FQ>` — the {@link pythonClassKey} form the MRO walk starts from. */
  readonly key: string;
  /** The dotted FQ alone — what the symbol table composes members under. */
  readonly classFq: string;
  /** The class's OWN short name — the key of the bare-name channels (`classFieldTypes`, `classExtends`). */
  readonly name: string;
}

/**
 * The innermost class enclosing the call site, or `null` when the caller has no
 * scope at all (bd tea-rags-mcp-graiw).
 *
 * `callerScope` is not a list of class containers, and reading it as one is the
 * defect this replaces. Two measured shapes broke on it, in opposite
 * directions:
 *
 *   - polar `server/polar/auth/dependencies.py:207` — `_AuthenticatorSignature`
 *     is declared inside `def Authenticator()`, so the scope is
 *     `["Authenticator", "_AuthenticatorSignature"]` and the class FQ needs
 *     BOTH segments. A key built from the trailing name alone named nothing.
 *   - flask, 10 sites — a call inside `App#template_filter#decorator` carries
 *     the scope `["App", "template_filter"]`, and the class FQ is the FIRST
 *     segment alone. A key built from the whole join named nothing.
 *
 * So the answer is the LONGEST prefix that names a class, tried outward from
 * the call. Two channels of evidence, either sufficient: the run's
 * `classAncestors` keys (authoritative — the walker only ever writes classes
 * there), and a symbol-table definition at the caller's own file whose
 * {@link pythonDeclaredClassFq} is that prefix. The second is what pins a class
 * that declares no base, and it separates a class from a method because a
 * container joins with the scope separator while an instance method joins with
 * `#`: `Outer.Inner` is in the table, `App.template_filter` is not.
 *
 * When no prefix is confirmed the WHOLE scope is returned rather than `null`,
 * which is byte-identically what every caller used to build. A key nothing
 * declares then reads closure `unknown` in `../python-ancestor-policy.ts`, so
 * the miss falls through instead of claiming the member is absent.
 */
export function pythonEnclosingClass(ctx: CallContext): PythonEnclosingClass | null {
  const scope = ctx.callerScope;
  if (scope.length === 0) return null;
  for (let depth = scope.length; depth > 0; depth--) {
    const classFq = scope.slice(0, depth).join(".");
    const key = pythonClassKey(ctx.callerFile, classFq);
    if (identifierEntry(ctx.classAncestors, key) !== undefined || pythonClassKeyIsDeclared(key, ctx)) {
      return { key, classFq, name: scope[depth - 1] };
    }
  }
  const classFq = scope.join(".");
  return { key: pythonClassKey(ctx.callerFile, classFq), classFq, name: scope[scope.length - 1] };
}

export function pythonImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Strip leading dots (relative-import marker) for the comparison —
  // `..foo.bar` should still match `bar` as a receiver. Compare
  // case-sensitively: Python is case-sensitive (User != user).
  const cleaned = importText.replace(/^\.+/, "");
  const segments = cleaned.split(".").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}

/**
 * The module text a single-identifier receiver denotes, from the two shapes
 * `collectPythonImports` records (`walker/walker.ts:499`).
 *
 * `importedBindings[local] === importText` IS the `import_statement` form —
 * there the recorded value is the MODULE PATH. An unaliased `import a.b` binds
 * the top package, so its head denotes `a`, not `a.b`; an aliased one denotes
 * the whole path. Everything else is `from M import name`, where the value is
 * an exported NAME and the receiver denotes the SUBMODULE `M.name` — joined
 * without a separator when `M` already ends in a dot, or `from . import c`
 * would compose `..c` and climb a package.
 */
export function receiverModuleText(binding: PythonImportBinding): string {
  const { importText } = binding.imp;
  if (binding.importedName === importText) {
    const firstSegment = binding.importedName.split(".")[0];
    return binding.localName === firstSegment ? firstSegment : binding.importedName;
  }
  return importText.endsWith(".") ? `${importText}${binding.importedName}` : `${importText}.${binding.importedName}`;
}
