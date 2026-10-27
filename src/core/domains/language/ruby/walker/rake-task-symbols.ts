/**
 * Rake tasks as codegraph symbols (bd tea-rags-mcp-k0602).
 *
 * Ruby's symbol collection (`rbNameOf`) names classes, modules, defs and the
 * methods DSL macros declare — a Rake `task` is none of those, so the calls in
 * a task body landed on no symbol. In a `.rake` file every task becomes a
 * `function` symbol whose id and lines are its chunk's: `rakeTaskRanges` reads
 * them through the chunker's own Rake reader, so the two ids agree by
 * construction (`.claude/rules/symbolid-convention.md`). A leaf already named by
 * the symbol collection — a namespace `def` — keeps its own symbol and kind.
 */

import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import { rakeTaskRanges } from "../chunking/rake-scope-chunker.js";
import type { RubyExtractInput } from "./shared/index.js";

export interface RubyInputWithRakeTasks {
  readonly input: RubyExtractInput;
  /** The declaration kind of each chunk of `input.chunks`, in order. */
  readonly symbolKinds: (SymbolDefinitionKind | undefined)[];
}

/** `input` with one chunk per Rake task its symbol collection did not name; unchanged outside `.rake`. */
export function withRakeTaskSymbols(
  input: RubyExtractInput,
  symbolKinds: (SymbolDefinitionKind | undefined)[],
): RubyInputWithRakeTasks {
  const named = new Set(input.chunks.map((c) => c.symbolId));
  const tasks = rakeTaskRanges(input.tree.rootNode, input.code, input.relPath).filter((t) => !named.has(t.symbolId));
  if (tasks.length === 0) return { input, symbolKinds };
  return {
    input: {
      ...input,
      chunks: [...input.chunks, ...tasks.map((t) => ({ ...t, scope: [] }))],
    },
    symbolKinds: [...symbolKinds, ...tasks.map((): SymbolDefinitionKind => "function")],
  };
}
