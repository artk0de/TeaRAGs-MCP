/**
 * A built `TypeFactStore` → the `Partial<FileExtraction>` PYTHON publishes
 * (E2 seam 2, bd tea-rags-mcp-9fgdi).
 *
 * `typeFactChannels` renders a store as four channels in the shape RUBY reads.
 * Two of them are wrong for Python and one is a trap, so this wraps it:
 *
 *   - `ivarTypes` → `classFieldTypes`. `PythonSelfFieldSymbolResolutionStrategy`
 *     reads `ctx.classFieldTypes?.[enclosing]?.[field]` where `enclosing` is the
 *     class SHORT name off `callerScope` (`python-self-field.ts:34`), and no
 *     Python strategy reads `ivarTypes` at all — Python has no `@ivar` receiver.
 *   - `structuredReturnTypes` keys move from Ruby's `::` join to Python's
 *     symbolId spelling, so a CLASS member's key IS the callee's id as
 *     `pyNameOf` and `DefaultSymbolIdComposer` compose it (`python/kernel.ts:41`
 *     sets `scopeSeparator: "."`). A MODULE-LEVEL def has no owner to
 *     disambiguate it, so the FILE does — see {@link pythonModuleReturnKey}.
 *   - `functionReturnTypes` is DROPPED. It is keyed by bare method name and
 *     absorbed run-global with last-write-wins
 *     (`trajectory/codegraph/symbols/run-state.ts:1068`); at Python's annotation
 *     density one `def get(self) -> Foo` would speak for every `get` in the
 *     corpus (`kernel/type-fact-store.ts:30`, bd h4hxh). The owner-qualified
 *     channel says the same thing without the collision.
 *
 * Emit-only-non-empty is preserved end to end: a channel the kernel helper left
 * absent stays absent here.
 */
import { createIdentifierRecord } from "../../../../../contracts/identifier-record.js";
import type { FileExtraction, LocalBinding } from "../../../../../contracts/types/codegraph.js";
import type { TypeRef, WalkContext } from "../../../../../contracts/types/language.js";
import { typeFactChannels, typeRefReceiverForm, type TypeFactStore } from "../../../kernel/index.js";

/**
 * The run-global address of a MODULE-LEVEL return fact — `<relPath>::<name>`
 * (bd tea-rags-mcp-1v12o.1.7, E5.1c).
 *
 * The same shape, for the same reason, as the class address `pythonClassKey`
 * composes: the channel is folded run-global, so a bare name cannot be the key.
 * polar declares `get_client` in six files with three different return
 * annotations, and one bare `get_client` entry made whichever file was walked
 * first speak for all of them. A CLASS member keeps its class-key form
 * (`Cls#m` / `Cls.m`) — the owner already disambiguates it.
 */
export function pythonModuleReturnKey(relPath: string, name: string): string {
  return `${relPath}::${name}`;
}

/**
 * The run-global address of a CLASS MEMBER's return fact — `<relPath>::<memberFq>`,
 * i.e. the member spelled on its class key (`pkg/svc.py::Svc#run`; bd
 * tea-rags-mcp-m99j1.1.35).
 *
 * The bare `Svc#run` stays published too — per-file readers key it by the
 * callee's symbolId — but the run-global fold keeps its FIRST writer, so a bare
 * key names no file once two files declare the class: django declares
 * `DatabaseWrapper` in every backend, only oracle's `create_cursor` returns a
 * typed cursor, and every other backend's receiver read oracle's answer. This
 * twin is what a reader narrows by once it knows the receiver's class key.
 */
export function pythonMemberReturnKey(relPath: string, memberFq: string): string {
  return `${relPath}::${memberFq}`;
}

/**
 * The run-global address of a MODULE-SCOPE value — `<relPath>::<name>` (P4, bd
 * tea-rags-mcp-m99j1.1.15). Same shape as {@link pythonModuleReturnKey} and for
 * the same reason; a separate name because a value and a def return are two
 * channels a reader must not confuse.
 */
export function pythonModuleValueKey(relPath: string, name: string): string {
  return `${relPath}::${name}`;
}

/** The kernel spells a module-level def with an empty scope, its member separator leading. */
function isPythonModuleLevelReturnKey(kernelKey: string): boolean {
  return kernelKey.startsWith("#") || kernelKey.startsWith(".");
}

/**
 * `#run` → `pkg/svc.py::run`; `Svc#run` → `Svc#run`; `Outer::Inner#run` →
 * `Outer.Inner#run`.
 *
 * An empty scope leaves the member separator leading, and that IS the
 * module-level case — the file qualifies it (see {@link pythonModuleReturnKey}).
 */
export function pythonStructuredReturnKey(kernelKey: string, relPath: string): string {
  if (isPythonModuleLevelReturnKey(kernelKey)) {
    return pythonModuleReturnKey(relPath, kernelKey.slice(1));
  }
  return kernelKey.split("::").join(".");
}

/**
 * A binding whose ref is a union of two or more reachable arms (`x: A | B`, bd
 * tea-rags-mcp-m99j1.1.30) carries NO name: the kernel store fills `type` with
 * the first arm as a best-effort string, and every reader that reads `type`
 * would then type the receiver as that one arm — a confident edge for half the
 * sites. The arms travel in `typeRef` only, and an empty `type` is what every
 * `type` reader already treats as "nothing to name". `Optional[A]` collapses to
 * one arm and keeps its name.
 */
function blankUnionBindingNames(localBindings: Record<string, LocalBinding[]> | undefined): void {
  if (localBindings === undefined) return;
  for (const bindings of Object.values(localBindings)) {
    for (const binding of bindings) {
      if (typeRefReceiverForm(binding.typeRef)?.form === "union") binding.type = "";
    }
  }
}

export function pythonTypeChannels(
  store: TypeFactStore,
  ctx: Pick<WalkContext, "chunks" | "relPath">,
): Partial<FileExtraction> {
  const kernel = typeFactChannels(store, ctx.chunks);
  const out: Partial<FileExtraction> = {};
  if (kernel.chunks !== undefined) {
    for (const chunk of kernel.chunks) blankUnionBindingNames(chunk.localBindings);
    out.chunks = kernel.chunks;
  }

  if (kernel.structuredReturnTypes !== undefined) {
    const rekeyed: Record<string, TypeRef> = createIdentifierRecord();
    for (const [key, ref] of Object.entries(kernel.structuredReturnTypes)) {
      const rekey = pythonStructuredReturnKey(key, ctx.relPath);
      rekeyed[rekey] = ref;
      // A class member also lands on its declaring file (bd tea-rags-mcp-m99j1.1.35).
      if (!isPythonModuleLevelReturnKey(key)) rekeyed[pythonMemberReturnKey(ctx.relPath, rekey)] = ref;
    }
    out.structuredReturnTypes = rekeyed;
  }

  if (kernel.ivarTypes !== undefined) {
    const classFieldTypes: Record<string, Record<string, string>> = createIdentifierRecord();
    const classFieldTypesByClassKey: Record<string, Record<string, string>> = createIdentifierRecord();
    for (const [fqClass, fields] of Object.entries(kernel.ivarTypes)) {
      const segments = fqClass.split("::");
      const shortName = segments[segments.length - 1];
      // Last write wins across same-short-named nested classes, exactly as
      // `collectPythonClassFieldTypes` merges them (`walker/walker.ts:256`).
      classFieldTypes[shortName] = { ...(classFieldTypes[shortName] ?? {}), ...fields };
      // The run-global address (bd tea-rags-mcp-f0xaa). Same facts, keyed as
      // `classAncestors` keys a class, so the MRO fold reads a base's fields
      // from a subclass's file. The kernel joins a scope with `::`; a Python
      // class FQ spells it with a dot, as `pythonDeclaredClassFq` does.
      const key = `${ctx.relPath}::${segments.join(".")}`;
      classFieldTypesByClassKey[key] = { ...(classFieldTypesByClassKey[key] ?? {}), ...fields };
    }
    out.classFieldTypes = classFieldTypes;
    out.classFieldTypesByClassKey = classFieldTypesByClassKey;
  }

  // Module-scope values (P4, bd tea-rags-mcp-m99j1.1.15), under the same
  // `<relPath>::<name>` address a module-level return fact uses — the channel
  // is folded run-global, so the file is what keeps two modules' `client`
  // apart.
  const moduleValues = store.moduleValueTypesMap();
  if (Object.keys(moduleValues).length > 0) {
    const moduleValueTypes: Record<string, TypeRef> = createIdentifierRecord();
    for (const [name, ref] of Object.entries(moduleValues)) {
      moduleValueTypes[pythonModuleValueKey(ctx.relPath, name)] = ref;
    }
    out.moduleValueTypes = moduleValueTypes;
  }

  return out;
}
