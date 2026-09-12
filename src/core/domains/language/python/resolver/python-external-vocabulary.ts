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
import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
} from "../../../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../contracts/types/language.js";
import { PYTHON_BUILTINS } from "../vocabulary/builtins.js";
import { PYTHON_CORE_MEMBERS } from "../vocabulary/core-members.js";
import { PYTHON_STDLIB_MODULES } from "../vocabulary/stdlib-modules.js";
import type { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import { PythonExternalDefinitionProbe } from "./python-external-definition-probe.js";
import { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { mapPythonImportToFile } from "./python-path-mapper.js";

export class PythonExternalVocabulary implements ExternalVocabulary {
  /**
   * The resolver's ONE mapper, injected (bd tea-rags-mcp-9fgdi, E2.6). The
   * vocabulary and the chain answer the same import question, so a second
   * instance would be a second memo and a licence to disagree. A caller with no
   * chain to share with omits it and gets a private one.
   */
  /**
   * The type-and-hierarchy half of the same decision (bd tea-rags-mcp-1v12o.3).
   * Built only when the caller has an ancestor-linearizer cache to lend: every
   * arm of it is an MRO question, and a vocabulary with no linearizer answers
   * exactly what it answered before the probe existed.
   */
  private readonly definitionProbe: PythonExternalDefinitionProbe | undefined;

  constructor(
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    linearizers?: PythonAncestorLinearizerCache,
    mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  ) {
    this.definitionProbe =
      linearizers === undefined
        ? undefined
        : new PythonExternalDefinitionProbe(mapper, linearizers, mode, {
            isBareCallExternal: (member, ctx) => this.isBareCallExternal(member, ctx),
            isRootExternalImport: (root, ctx, atLine) => this.rootIsExternalImport(root, ctx, atLine),
          });
  }

  /**
   * bd tea-rags-mcp-1v12o.3 — the receiver's TYPE, not its text, puts the
   * definition outside the project. Delegated whole to
   * {@link PythonExternalDefinitionProbe}; absent a linearizer it is inert.
   */
  isReceiverDefinitionExternal(call: CallRef, ctx: CallContext): boolean {
    return this.definitionProbe?.targetsExternalDefinition(call, ctx) ?? false;
  }

  /**
   * A bare call naming a builtin — bound by the interpreter, never a project
   * def — or a name an import BOUND from an external module:
   * `from json import loads` then `loads(x)` (bd tea-rags-mcp-9fgdi).
   *
   * The second arm must agree with
   * `PythonImportedNameSymbolResolutionStrategy`, which DROPS exactly that
   * shape. A drop the vocabulary does not classify is counted as an in-project
   * miss, so the two answers are one decision made twice. `ctx` is optional on
   * the contract; without it only the builtin arm can answer.
   */
  isBareCallExternal(member: string, ctx?: CallContext): boolean {
    if (PYTHON_BUILTINS.has(member)) return true;
    if (ctx === undefined) return false;
    for (const imp of ctx.imports) {
      const bound = imp.importedBindings?.[member] ?? (imp.importedNames?.includes(member) ? member : undefined);
      if (bound === undefined) continue;
      if (this.mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx).kind === "external") return true;
    }
    return false;
  }

  /**
   * A dotted receiver whose ROOT segment is bound by a non-relative import that
   * does not land in this project.
   *
   * Three guards, each holding a case the corpora produce:
   *
   *   - SINGLE-SEGMENT receivers are never claimed. The guard predates the
   *     removal of `importMatch` (bd tea-rags-mcp-rw1qk), which used to answer
   *     `os.getcwd()` with a file-only edge so it never arrived here at all;
   *     the guard stays because claiming a bare module receiver here is a
   *     denominator change nothing has measured. Pinned by
   *     `python-resolver-external-import.test.ts`.
   *   - A RELATIVE import is in-project by construction.
   *   - An ABSOLUTE import that maps into the symbol table is FIRST-PARTY. This
   *     is the branch `hasFile` / `hasFilesUnder` added: netbox, flask and
   *     polar all import their own packages absolutely, and calling those
   *     external removes real recall holes from the denominator.
   */
  isQualifiedReceiverExternal(receiver: string, ctx: CallContext, atLine?: number): boolean {
    if (!receiver.includes(".")) return false;
    return this.rootIsExternalImport(receiver.slice(0, receiver.indexOf(".")), ctx, atLine);
  }

  /**
   * The import question {@link isQualifiedReceiverExternal} is made of, asked
   * of a receiver ROOT. Split out so the definition probe can ask it of a
   * SINGLE-SEGMENT receiver (`httpx.post(...)`) — the same fact, one dot short
   * — without the dotted guard above moving.
   */
  private rootIsExternalImport(root: string, ctx: CallContext, atLine?: number): boolean {
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
    // The stdlib check stays AHEAD of the mapper. The mapper probes the
    // caller's ancestor directories before it consults the stdlib snapshot, so
    // `import json` from `src/flask/tag.py` would land on flask's own
    // `src/flask/json/__init__.py`. Which module the interpreter really binds
    // is a sys.path question no static root inference answers; the vocabulary
    // keeps its measured answer (bd tea-rags-mcp-mmckn).
    if (PYTHON_STDLIB_MODULES.has(importText.split(".")[0])) return false;
    const mapped = this.mapper.mapImportToFile(importText, ctx.callerFile, ctx);
    if (mapped.kind === "project") return true;
    if (mapped.kind === "external") return false;
    // `unknown` covers a PEP 420 namespace package — ours, but with no
    // `__init__.py` for the mapper to name, and a directory is not a legal
    // file-edge target (decision 4 of the plan). It is still first-party for
    // THIS question, so the directory probe stays.
    const synthesised = mapPythonImportToFile(importText, ctx.callerFile);
    return synthesised !== null && ctx.symbolTable.hasFilesUnder(synthesised.replace(/\.py$/, ""));
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
