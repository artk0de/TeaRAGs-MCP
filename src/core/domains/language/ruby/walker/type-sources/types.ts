/**
 * Ruby's names for the kernel type-source contracts (`kernel/type-facts.ts`),
 * kept as a shim by E1 seam 2 so the five inline sources, the source registry
 * and the type-source suite keep their imports. `RubyInlineTypeSource` is the
 * kernel generic bound to Ruby's walker input — the one Ruby-specific fact
 * left in this file.
 */
import type { InlineTypeSource } from "../../../kernel/type-facts.js";
import type { RubyExtractInput } from "../walker.js";

export type {
  ProjectTypeSourceContext,
  SidecarTypeSource as RubySidecarTypeSource,
  TypeFact as RubyTypeFact,
} from "../../../kernel/type-facts.js";

/** A type source colocated in the `.rb` file (YARD comments, Sorbet `sig {}` / `T.let`). */
export type RubyInlineTypeSource = InlineTypeSource<RubyExtractInput>;
