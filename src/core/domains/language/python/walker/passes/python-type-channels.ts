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
 *     symbolId spelling, so a key IS the callee's id as `pyNameOf` and
 *     `DefaultSymbolIdComposer` compose it (`python/kernel.ts:41` sets
 *     `scopeSeparator: "."`).
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
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { TypeRef, WalkContext } from "../../../../../contracts/types/language.js";
import { typeFactChannels } from "../../../kernel/type-fact-channels.js";
import type { TypeFactStore } from "../../../kernel/type-fact-store.js";

/**
 * `#run` → `run`; `Svc#run` → `Svc#run`; `Outer::Inner#run` → `Outer.Inner#run`.
 * An empty scope leaves the member separator leading, and a top-level def's id is
 * its bare name (`compose` returns `localName` for an empty prefix).
 */
export function pythonStructuredReturnKey(kernelKey: string): string {
  if (kernelKey.startsWith("#") || kernelKey.startsWith(".")) return kernelKey.slice(1);
  return kernelKey.split("::").join(".");
}

export function pythonTypeChannels(store: TypeFactStore, chunks: WalkContext["chunks"]): Partial<FileExtraction> {
  const kernel = typeFactChannels(store, chunks);
  const out: Partial<FileExtraction> = {};
  if (kernel.chunks !== undefined) out.chunks = kernel.chunks;

  if (kernel.structuredReturnTypes !== undefined) {
    const rekeyed: Record<string, TypeRef> = {};
    for (const [key, ref] of Object.entries(kernel.structuredReturnTypes)) {
      rekeyed[pythonStructuredReturnKey(key)] = ref;
    }
    out.structuredReturnTypes = rekeyed;
  }

  if (kernel.ivarTypes !== undefined) {
    const classFieldTypes: Record<string, Record<string, string>> = {};
    for (const [fqClass, fields] of Object.entries(kernel.ivarTypes)) {
      const segments = fqClass.split("::");
      const shortName = segments[segments.length - 1];
      // Last write wins across same-short-named nested classes, exactly as
      // `collectPythonClassFieldTypes` merges them (`walker/walker.ts:256`).
      classFieldTypes[shortName] = { ...(classFieldTypes[shortName] ?? {}), ...fields };
    }
    out.classFieldTypes = classFieldTypes;
  }

  return out;
}
