/**
 * Python's `ExternalVocabulary` (bd tea-rags-mcp-mmckn, E0 of the unification
 * program). Python's denominator has never been honest: with no vocabulary,
 * every Django / DRF / stdlib call whose definition lives in a virtualenv sat
 * in "unresolved", and most of ugnest's 5,899 unresolved sites are
 * structurally external. The first lever is an honest denominator, not recall.
 *
 * Technique precedent: `ruby/resolver/ruby-external-vocabulary.ts`. The engine
 * (`ExternalCallClassifier`) owns the receiver-shape branch; everything here is
 * a language decision.
 *
 * NO FILESYSTEM ACCESS, on any path. The stdlib snapshot is a frozen
 * module-level Set, the builtins list is data, and "is this file ours" is a
 * symbol-table query (`hasFile` / `hasFilesUnder`, bd q9u85). The vocabulary is
 * consulted once per unresolved call on corpora with 80k of them.
 */
import { resolveLocalBindingType } from "../../../../contracts/types/codegraph-local-binding.js";
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../contracts/types/language.js";
import { PYTHON_BUILTINS } from "../vocabulary/builtins.js";
import { PYTHON_CORE_MEMBERS } from "../vocabulary/core-members.js";
import { PYTHON_STDLIB_MODULES } from "../vocabulary/stdlib-modules.js";
import { mapPythonImportToFile } from "./python-path-mapper.js";

export class PythonExternalVocabulary implements ExternalVocabulary {
  /** A bare call naming a builtin: bound by the interpreter, never a project def. */
  isBareCallExternal(member: string): boolean {
    return PYTHON_BUILTINS.has(member);
  }

  /**
   * A dotted receiver whose ROOT segment is bound by a non-relative import that
   * does not land in this project.
   *
   * Three guards, each holding a case the corpora produce:
   *
   *   - SINGLE-SEGMENT receivers are never claimed. `os.getcwd()` resolves
   *     through `importMatch` as a file-only edge and never arrives here
   *     unresolved; claiming it would double-count. Pinned by
   *     `python-resolver-external-import.test.ts`.
   *   - A RELATIVE import is in-project by construction.
   *   - An ABSOLUTE import that maps into the symbol table is FIRST-PARTY. This
   *     is the branch `hasFile` / `hasFilesUnder` added: netbox, flask and
   *     polar all import their own packages absolutely, and calling those
   *     external removes real recall holes from the denominator.
   */
  isQualifiedReceiverExternal(receiver: string, ctx: CallContext, atLine?: number): boolean {
    if (!receiver.includes(".")) return false;
    const root = receiver.slice(0, receiver.indexOf("."));
    // A receiver with a local type at this line is a VALUE, not a module —
    // whatever the imports say about the name.
    if (atLine !== undefined && resolveLocalBindingType(ctx.localBindings, root, atLine) !== undefined) {
      return false;
    }
    for (const imp of ctx.imports) {
      if (imp.importText.startsWith(".")) continue; // relative → in-project
      const head = (imp.importText.split(/\s+as\s+/)[0] ?? "").trim();
      if (head.split(".")[0] !== root) continue;
      if (this.importLandsInProject(head, ctx)) return false;
      // A stdlib root is external even when the mapper's synthesised path
      // happens to collide with a project file name (`json.py`, `types.py`).
      return true;
    }
    return false;
  }

  /** Does this import text name a file or a package directory the table holds? */
  private importLandsInProject(importText: string, ctx: CallContext): boolean {
    if (PYTHON_STDLIB_MODULES.has(importText.split(".")[0])) return false;
    const mapped = mapPythonImportToFile(importText, ctx.callerFile);
    if (mapped === null) return false;
    if (ctx.symbolTable.hasFile(mapped)) return true;
    // PEP 420 namespace packages have no `__init__.py`, so the package is only
    // visible as a DIRECTORY holding files — `hasFile` alone cannot see it.
    return ctx.symbolTable.hasFilesUnder(mapped.replace(/\.py$/, ""));
  }

  /** A dict / list / str / set / bytes / file member name. */
  isCoreAmbiguousMember(member: string): boolean {
    return PYTHON_CORE_MEMBERS.has(member);
  }

  /**
   * Does the receiver have a known static type? `self` / `cls` are
   * structurally self-identifying, a local binding gives a type at a line, and
   * a declared class field gives one by name. Everything else is untyped, which
   * is the only state that admits the `coreAmbiguous` bucket.
   *
   * `classFieldTypes` is the CallContext's two-level `class → field → type`
   * map, so the field axis is checked across every declared class: the
   * vocabulary is not told which class encloses the call, and a receiver named
   * by ANY class's declared field is typed enough to stay a real miss.
   */
  isReceiverTyped(receiver: string, ctx: CallContext, atLine?: number): boolean {
    if (receiver === "self" || receiver === "cls") return true;
    if (atLine !== undefined && resolveLocalBindingType(ctx.localBindings, receiver, atLine) !== undefined) return true;
    if (ctx.classFieldTypes === undefined) return false;
    const field = receiver.startsWith("self.") ? receiver.slice("self.".length) : receiver;
    return Object.values(ctx.classFieldTypes).some((fields) => fields[field] !== undefined);
  }
}
