/**
 * The Rust answer to the facade's `targetsExternalImport` — the miss
 * classifier's first gate (`.claude/rules/resolver-architecture.md`; Python's
 * `PythonExternalVocabulary` is the pilot this follows). A `true` verdict
 * removes the call from the resolve-rate denominator, so every arm is PROOF,
 * never absence: a std-prelude or external-crate reading wins only when a
 * `use` binding or a reserved name carries it, and a project definition of
 * the same name vetoes the std reading — a corpus that declares its own
 * `String` keeps its `String::new()` misses.
 */

import type { CallContext, CallRef } from "../../../../contracts/types/codegraph.js";
import {
  lookupRustSymbolsByShortName,
  parseRustImportPath,
  rustImportBindings,
  rustImportIsExternal,
} from "../resolver/strategies/shared.js";
import { rustTextIsStdMacro, rustTextIsStdPreludeType, rustTextIsStdPreludeVariant } from "./std-prelude.js";

/** The receiver text names a project file, type or macro — any in-project definition vetoes a std reading. */
function projectDeclares(ctx: CallContext, name: string): boolean {
  return lookupRustSymbolsByShortName(ctx, name).length > 0;
}

export class RustExternalVocabulary {
  targetsExternal(call: CallRef, ctx: CallContext): boolean {
    if (call.receiver === null) return this.bareCalleeIsExternal(call, ctx);
    return this.receiverIsExternal(call, ctx);
  }

  /**
   * A receiver bound by an external import is external; an UNBOUND receiver
   * is external only when the prelude spells it (`String::new()` carries no
   * `use`) and no project definition shares the name. A receiver bound by a
   * project import, or spelled by nothing we can prove, is never external.
   */
  private receiverIsExternal(call: CallRef, ctx: CallContext): boolean {
    const { receiver } = call;
    if (receiver === null) return false;
    const head = receiver.split("::")[0] ?? receiver;
    for (const imp of ctx.imports) {
      const parsed = parseRustImportPath(imp.importText, head);
      if (parsed?.receiverMatches && rustImportIsExternal(imp.importText, ctx)) return true;
    }
    const bound = ctx.imports.some((imp) => parseRustImportPath(imp.importText, head)?.receiverMatches);
    if (bound) return false;
    return rustTextIsStdPreludeType(head) && !projectDeclares(ctx, head);
  }

  /**
   * A bare call is external when the name is bound by an external import,
   * when it is a std macro invocation the project does not define
   * (`vec![]` — the walker emits the macro name as the member), or when it
   * is a prelude variant constructor (`Ok(())`, `Some(x)`).
   */
  private bareCalleeIsExternal(call: CallRef, ctx: CallContext): boolean {
    for (const imp of ctx.imports) {
      const bindings = rustImportBindings(imp.importText);
      if (bindings?.some((binding) => binding.localName === call.member && !binding.globImport)) {
        if (rustImportIsExternal(imp.importText, ctx)) return true;
        return false;
      }
    }
    const macroCall = call.callText.startsWith(`${call.member}!`);
    if (macroCall && rustTextIsStdMacro(call.member) && !projectDeclares(ctx, call.member)) return true;
    if (rustTextIsStdPreludeVariant(call.member) && !projectDeclares(ctx, call.member)) return true;
    return false;
  }
}
