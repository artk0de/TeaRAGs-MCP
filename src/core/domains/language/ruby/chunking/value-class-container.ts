/**
 * A constant bound to a value-class builder with a block is a chunk container
 * (bd tea-rags-mcp-0td4h):
 *
 *   Billing::Entry = Data.define(:name, :kind) do
 *     def gate? = kind == 'gate'
 *     ...
 *   end
 *
 * The block body is a class body — the walker counts it as one — but the
 * builder is a `call`, and the RSpec filter rejects every `call` outside spec
 * files. The engine then descended through it and emitted only the `def`s long
 * enough to be chunks, under bare ids (`problem`, not `Billing::Entry#problem`),
 * while the assignment row, the short endless `def`s and
 * `private_class_method :new` landed in no chunk. Accepted here, the call is
 * extracted like a `class`: its defs compose under the constant, and its other
 * rows reach the class-body hook, whose sub-floor fold keeps them.
 *
 * Spec and Rake files are left to their own filters: their scope chunkers own
 * every container there.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook, HookContext } from "../../../../contracts/types/chunker.js";
import { attachedBlockOf, valueClassMemberNames } from "../walker/shared/index.js";
import { isRakeFile } from "./rake-filter.js";
import { isRspecFile } from "./rspec-filter.js";

const CONSTANT_TARGET_TYPES: ReadonlySet<string> = new Set(["constant", "scope_resolution"]);

/**
 * The constant a `X = Struct.new(…) do … end` / `X = Data.define(…) do … end`
 * call is bound to (`X`, `Billing::Entry`), or undefined for any other node —
 * an unassigned builder, one without a block, one bound to a local.
 */
export function valueClassContainerName(node: AstNode): string | undefined {
  if (valueClassMemberNames(node) === null || attachedBlockOf(node) === undefined) return undefined;
  const assignment = node.parent;
  if (assignment?.type !== "assignment" || assignment.childForFieldName("right")?.startIndex !== node.startIndex) {
    return undefined;
  }
  const target = assignment.childForFieldName("left");
  return target && CONSTANT_TARGET_TYPES.has(target.type) ? target.text : undefined;
}

/**
 * The header row of a value-class container — its whole assignment row
 * (`Row = Struct.new(:a) do`), not the builder call's own text from `Struct`
 * on (bd tea-rags-mcp-mfnvp) — or undefined for any other node.
 */
export function valueClassContainerHeader(node: AstNode, code: string): string | undefined {
  if (valueClassContainerName(node) === undefined) return undefined;
  return code.split("\n")[node.startPosition.row]?.trim();
}

/** The block body of a value-class container — the statements a `class` body would hold. */
export function valueClassContainerBody(node: AstNode): AstNode | null {
  if (valueClassContainerName(node) === undefined) return null;
  return attachedBlockOf(node)?.childForFieldName("body") ?? null;
}

export const valueClassFilterHook: ChunkingHook = {
  name: "value-class-filter",

  filterNode(node: AstNode, _code: string, filePath: string): boolean | undefined {
    if (node.type !== "call" || isRspecFile(filePath) || isRakeFile(filePath)) return undefined;
    return valueClassContainerName(node) === undefined ? undefined : true;
  },

  process(_ctx: HookContext): void {
    // No-op — filterNode admits the container; the class-body hook chunks its body.
  },
};
