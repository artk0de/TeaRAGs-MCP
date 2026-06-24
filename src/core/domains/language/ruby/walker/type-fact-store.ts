import type { LocalBinding } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import type { RubyTypeFact } from "./type-sources/types.js";

/** Flatten a RubyTypeRef to the bare class name today's LocalBinding.type holds (Incr 0 parity). */
function refToName(ref: RubyTypeRef): string | undefined {
  if (ref.form === "class" || ref.form === "instance") return ref.name;
  if (ref.form === "container") return refToName(ref.element); // element wins (today's Array<Post> -> Post)
  return undefined; // union: deferred to Incr 1 (no single name)
}

export class RubyTypeFactStore {
  private constructor(private readonly facts: readonly RubyTypeFact[]) {}

  static fromFacts(facts: RubyTypeFact[]): RubyTypeFactStore {
    return new RubyTypeFactStore(facts);
  }

  localBindingsForChunk(startLine: number, endLine: number): Record<string, LocalBinding[]> {
    const out: Record<string, LocalBinding[]> = {};
    for (const f of this.facts) {
      if (f.kind !== "param" && f.kind !== "local") continue;
      if (f.line === undefined || f.line < startLine || f.line > endLine) {
        continue;
      }
      const { name } = f;
      const type = refToName(f.type);
      if (!name || type === undefined) continue;
      const binding: LocalBinding = { line: f.line, type };
      if (f.type.form === "class") binding.valueKind = "class";
      (out[name] ??= []).push(binding);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.line - b.line);
    return out;
  }

  returnTypeByMethod(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.facts) {
      if (f.kind !== "return" || !f.methodName) continue;
      const type = refToName(f.type);
      if (type !== undefined) out[f.methodName] = type;
    }
    return out;
  }
}
