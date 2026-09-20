/**
 * Quick/Nimble's DSL vocabulary — WHAT the DSL is. The SHAPE it chunks into is
 * `./quick-scope-chunker.ts`, and which Swift declarations are a Quick suite is
 * `./suite-recognition.ts`.
 *
 * `.claude/rules/test-spec-chunking.md` prescribes this module as a
 * `filterNode` hook, because in Ruby and TypeScript the DSL's container is a
 * CALL — `describe(…)` — so `call` / `call_expression` has to be added to the
 * language's chunkable types before the engine will hand the scope chunker a
 * context for it, and a filter is then what keeps every other call in the
 * project out of the chunk set.
 *
 * Swift needs no such node. Quick's DSL is legal only inside a `QuickSpec`
 * subclass's `spec()` method, so its container is a `class_declaration` — a
 * type the Swift chunker already treats as a top-level chunkable node. The
 * scope chunker claims THAT, walks down to `spec()` itself, and never needs a
 * call to be chunkable. Adding `call_expression` to `childChunkTypes` would
 * buy nothing: the engine stops traversing at `spec()` (an accepted child), so
 * the DSL calls inside it are never reached from the class, and the only calls
 * a filter would ever judge are property initialisers it must reject.
 *
 * What survives of the canonical split is the split itself — vocabulary here,
 * tree-building next door — because the scope walk asks "is this callee a
 * container / an example / setup" on every statement it visits, and that
 * question is worth answering in one place.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import { isSwiftTestFile } from "./suite-recognition.js";

/** Calls whose trailing closure opens a new scope. */
export const QUICK_CONTAINER_METHODS: ReadonlySet<string> = new Set([
  "describe",
  "context",
  "xdescribe",
  "fdescribe",
  "xcontext",
  "fcontext",
  "sharedExamples",
]);

/** Calls that declare one example — the leaf unit a scenario is addressed by. */
export const QUICK_EXAMPLE_METHODS: ReadonlySet<string> = new Set([
  "it",
  "xit",
  "fit",
  "itBehavesLike",
  "xitBehavesLike",
  "fitBehavesLike",
]);

/** Calls that prepare state for the examples of their scope and its descendants. */
export const QUICK_SETUP_METHODS: ReadonlySet<string> = new Set([
  "beforeEach",
  "justBeforeEach",
  "afterEach",
  "aroundEach",
  "beforeSuite",
  "afterSuite",
]);

/** Every recognized Quick call. */
export const QUICK_DSL_METHODS: ReadonlySet<string> = new Set([
  ...QUICK_CONTAINER_METHODS,
  ...QUICK_EXAMPLE_METHODS,
  ...QUICK_SETUP_METHODS,
]);

/**
 * Quick's own file conventions on top of the shared Swift test-file layout: a
 * `*Spec.swift` / `*Specs.swift` suffix, or a `Spec/` / `Specs/` directory.
 * Case-sensitive like `isSwiftTestFile` — `Latest.swift` is production code.
 */
const QUICK_FILE_CONVENTION = /Specs?\.swift$|(^|[/\\])Specs?[/\\]/;

/**
 * The path gate `.claude/rules/test-spec-chunking.md` requires. `isQuickSuite`
 * is the stronger evidence and could stand alone, so this gate exists to BOUND
 * the blast radius rather than to identify anything: a spec in an unconventional
 * path keeps chunking exactly as it does today, which is a graceful loss, while
 * a production file can never be re-shaped by the scope chunker at all.
 */
export function isQuickSpecFile(filePath: string): boolean {
  return isSwiftTestFile(filePath) || QUICK_FILE_CONVENTION.test(filePath);
}

/**
 * The callee name of a Swift call, or null.
 *
 * tree-sitter-swift gives `call_expression` NO field names: the callee is
 * simply the first named child, followed by a `call_suffix` holding the
 * parenthesised arguments and the trailing closure. A qualified callee parses
 * as `navigation_expression` (`Quick.describe(…)`) and returns null — Quick's
 * DSL is global and the qualified form is vanishingly rare, so it is a
 * documented v1 limitation rather than a member-chain walk.
 */
export function getSwiftCallName(node: AstNode, code: string): string | null {
  if (node.type !== "call_expression") return null;
  const callee = node.namedChildren[0];
  if (callee?.type !== "simple_identifier") return null;
  return code.substring(callee.startIndex, callee.endIndex);
}
