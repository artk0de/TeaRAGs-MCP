/**
 * Rake Scope Chunker — Rake is its own DSL (bd tea-rags-mcp-k0602), chunked on
 * the principle of test chunks: a `namespace` call is read into the kernel's
 * scope tree by the shared Ruby DSL reader (`dsl-scope-tree.ts`, RSpec's too)
 * and emitted by `produceTestScopeChunks` under the Rake vocabulary. No
 * bespoke emission lives here — only Rake's reading:
 *
 *   - containers `namespace`; leaves `task`, `multitask`, `file`, `rule`;
 *     no setup; a `desc` opens the leaf right after it.
 *   - a leaf is addressed by its Rake name — the namespace path joined by `:`
 *     (`namespace :billing do task :sync` → `billing:sync`, nested
 *     namespaces compose). `file` tasks and rules are not scoped by a
 *     namespace in Rake, so their id is their own name (`billing.csv`).
 *   - a task is PRODUCTION code: chunkType `function` (a callable body, the
 *     population churn and size signals compare it with), its namespace's own
 *     lines `block`, and never the test parentType — `testFile`, test-scope
 *     stats and the test outline never see a `.rake` file.
 *   - every task is its own chunk, however small: a task is an entry point
 *     `rake billing:sync` invokes, so it is addressed alone, never packed.
 *
 * A top-level task outside any namespace is no container, so this hook never
 * sees it: `RubyChunkClassifier` names it from the same `rakeTaskNameOf`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook } from "../../../../contracts/types/chunker.js";
import { produceTestScopeChunks, type ScopeChunkVocabulary } from "../../kernel/index.js";
import { readRubyDslScopeTree, type RubyDslScopeVocabulary } from "./dsl-scope-tree.js";
import { isRakeFile, RAKE_CONTAINER_METHODS, RAKE_TASK_METHODS, rakeCallName } from "./rake-filter.js";

/** The Rake name a symbol / string / hash-key argument spells. */
function rakeNameOfArgument(arg: AstNode): string {
  switch (arg.type) {
    case "simple_symbol":
      return arg.text.replace(/^:/, "");
    case "string":
    case "delimited_symbol":
      return arg.namedChildren.find((c) => c.type === "string_content")?.text ?? "";
    case "pair": {
      // `task sync: :environment`, `task :reconcile, [:id] => :env` is not this
      // (its first argument is the symbol), `file "out" => ["in"]` is.
      const key = arg.childForFieldName("key") ?? arg.namedChildren[0];
      return key === null || key === undefined ? arg.text : rakeNameOfArgument(key);
    }
    default:
      // `hash_key_symbol` (`seed:` → `seed`), a rule's regex — the text as written.
      return arg.text;
  }
}

/**
 * The name a Rake call gives its task or namespace: its first argument —
 * `task :sync`, `task "seed"`, `task sync: :environment`,
 * `task :sync, [:arg] => :environment`, `namespace :billing`.
 */
export function rakeTaskNameOf(node: AstNode): string | undefined {
  const first = node.childForFieldName("arguments")?.namedChildren[0];
  return first === undefined ? undefined : rakeNameOfArgument(first);
}

const RAKE_DESCRIPTION_METHODS: ReadonlySet<string> = new Set(["desc"]);

/**
 * The first `desc` call right above a top-level task — the row its chunk and
 * its codegraph symbol open at. Undefined when no `desc` precedes it.
 */
export function rakeDescriptionStart(node: AstNode): AstNode | undefined {
  let first: AstNode | undefined;
  for (let prev = node.previousNamedSibling; prev !== null; prev = prev.previousNamedSibling) {
    const name = rakeCallName(prev);
    if (name === null || !RAKE_DESCRIPTION_METHODS.has(name)) break;
    first = prev;
  }
  return first;
}

/** The Rake roles of the shared Ruby DSL scope-tree reader. */
const RAKE_SCOPE_VOCABULARY: RubyDslScopeVocabulary = {
  containerMethods: RAKE_CONTAINER_METHODS,
  leafMethods: RAKE_TASK_METHODS,
  setupMethods: new Set(),
  delegatingSetupMethods: new Set(),
  descriptionMethods: RAKE_DESCRIPTION_METHODS,
  unscopedLeafMethods: new Set(["file", "rule"]),
  // A `def` inside a namespace is still a Ruby method: its own chunk under its
  // own name, as it is outside a .rake file.
  leafNodeTypes: new Set(["method"]),
  // A namespace's leading comment is kept (bd tea-rags-mcp-6xdwe).
  collectRowsAboveBody: true,
  idNameOf: (node) => (node.type === "method" ? node.childForFieldName("name")?.text : rakeTaskNameOf(node)),
};

/** A Rake task as the chunker addresses it: its Rake name and the lines its chunk spans. */
export interface RakeTaskRange {
  readonly symbolId: string;
  readonly startLine: number;
  readonly endLine: number;
}

function namespaceTaskRanges(namespaceNode: AstNode, code: string): RakeTaskRange[] {
  const tree = readRubyDslScopeTree(namespaceNode, code, RAKE_SCOPE_VOCABULARY);
  // Ids and ranges do not depend on the size cap: Rake never packs leaves.
  const chunks = produceTestScopeChunks(
    tree,
    tree.idName ?? tree.name,
    { maxChunkSize: Number.MAX_SAFE_INTEGER },
    RAKE_SCOPE_CHUNK_VOCABULARY,
  );
  return chunks
    .filter((c) => c.chunkType === RAKE_SCOPE_CHUNK_VOCABULARY.leafChunkType && c.symbolId !== undefined)
    .map((c) => ({ symbolId: c.symbolId as string, startLine: c.startLine, endLine: c.endLine }));
}

/**
 * Every leaf chunk of a `.rake` file, addressed exactly as the chunker
 * addresses it: the namespace leaves through the same reader and emission
 * vocabulary the scope chunker uses, the top-level tasks by `rakeTaskNameOf`
 * from their `desc`. A namespace `def` is among the leaves under its own
 * name, which is the id Ruby's symbol collection already gives it.
 */
export function rakeTaskRanges(root: AstNode, code: string, filePath: string): RakeTaskRange[] {
  if (!isRakeFile(filePath)) return [];
  const ranges: RakeTaskRange[] = [];
  for (const child of root.namedChildren) {
    const methodName = rakeCallName(child);
    if (methodName === null) continue;
    if (RAKE_CONTAINER_METHODS.has(methodName)) {
      ranges.push(...namespaceTaskRanges(child, code));
    } else if (RAKE_TASK_METHODS.has(methodName)) {
      const name = rakeTaskNameOf(child);
      if (name === undefined || name === "") continue;
      const start = rakeDescriptionStart(child) ?? child;
      ranges.push({ symbolId: name, startLine: start.startPosition.row + 1, endLine: child.endPosition.row + 1 });
    }
  }
  return ranges;
}

/** How the kernel names and types Rake's chunks: production code under `:`-joined namespace paths. */
const RAKE_SCOPE_CHUNK_VOCABULARY: ScopeChunkVocabulary = {
  idSeparator: ":",
  idPath: "namespace",
  leafChunkType: "function",
  setupChunkType: "block",
  packLeaves: false,
  // Every line of a namespace lands in a chunk (bd tea-rags-mcp-6xdwe).
  minSetupContent: 0,
};

export const rakeScopeChunkerHook: ChunkingHook = {
  name: "rake-scope-chunker",

  process(ctx) {
    if (!isRakeFile(ctx.filePath)) return;
    const methodName = rakeCallName(ctx.containerNode);
    if (methodName === null || !RAKE_CONTAINER_METHODS.has(methodName)) return;

    const tree = readRubyDslScopeTree(ctx.containerNode, ctx.code, RAKE_SCOPE_VOCABULARY);
    const chunks = produceTestScopeChunks(tree, tree.idName ?? tree.name, ctx.config, RAKE_SCOPE_CHUNK_VOCABULARY);

    if (chunks.length > 0) {
      ctx.bodyChunks = chunks;
      ctx.skipChildren = true;
    }
  },
};
