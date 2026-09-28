/**
 * Bash extraction walker. Relocated from
 * `domains/ingest/pipeline/chunker/extraction/bash-walker.ts` into the native
 * Bash language provider per the `domains/language` consolidation (spec §3; bd
 * tea-rags-mcp-cen6, the eighth and LAST source-language vertical after ruby +
 * typescript + javascript + python + go + java + rust). Behaviour-preserving.
 *
 * Bash has two "import" equivalents:
 *   source ./other.sh
 *   . ./other.sh           # POSIX-style alias
 *
 * Both load the named file into the current shell. Tree-sitter-bash
 * parses these as `command` nodes with name = "source" or "." and a
 * single word/string argument.
 *
 * Calls in Bash are also `command` nodes (every line invokes a
 * command). For codegraph purposes, walker only captures named
 * function definitions as symbols + their internal calls — most
 * Bash commands are external binaries (no in-project edges) and
 * adding them as call sites would drown the graph in noise.
 */

import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks, symbolIdNames } from "../../kernel/index.js";
import { bashNameOf } from "./name-of.js";
import { symbolKindOf } from "./symbol-kind.js";

export interface BashExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromBashFile(input: BashExtractInput): FileExtraction {
  const imports = collectBashImports(input.tree.rootNode);
  const defined = collectBashDefinedFunctions(input.tree.rootNode);
  const { calls, symbolKinds } = collectBashCallsAndSymbolKinds(input.tree.rootNode, defined);
  // bd tea-rags-mcp-f11nz — ONE owning chunk per call site: the smallest
  // containing range, ties broken by deeper scope (python bd tea-rags-mcp-invuy).
  // The pure-containment filter this replaces gave a call to EVERY chunk spanning
  // its line, so any enclosing chunk produced a second copy. `bashNameOf` marks
  // every function `descendsInto: false`, so today's chunk set never nests and
  // the emitted call set is unmoved — the kernel call makes that a property of
  // the walker rather than of the current nameOf.
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    // bd tea-rags-mcp-vi0wx — a chunk carries no node, only the range and id
    // `collectSymbols` built from the same `bashNameOf` reading, so the kind
    // joins back on (start line, id names the reading's name) — nested
    // functions on distinct lines (`outer`/`inner`) are told apart by name.
    const symbolKind = symbolKinds.get(c.startLine)?.find((k) => symbolIdNames(c.symbolId, k.name))?.kind;
    if (symbolKind !== undefined) base.symbolKind = symbolKind;
    return base;
  });
  return {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
}

function collectBashImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "command") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const name = nameNode.text;
    if (name !== "source" && name !== ".") return;
    // First argument carries the path.
    const argNode = node.namedChildren.find((c) => c !== nameNode);
    if (!argNode) return;
    const literal = argNode.text.replace(/^["']|["']$/g, "");
    out.push({ importText: literal, startLine: node.startPosition.row + 1 });
  });
  return out;
}

interface BashSymbolKindReading {
  readonly name: string;
  readonly kind: SymbolDefinitionKind;
}

/**
 * Calls AND symbol kinds (bd tea-rags-mcp-vi0wx) in ONE walk over the tree —
 * folded together rather than added as a second full traversal, since this walk
 * already visits every node to find call sites. `defined` is computed once by
 * the caller and threaded in, so the file is walked exactly as many times as
 * before this change.
 */
function collectBashCallsAndSymbolKinds(
  root: AstNode,
  defined: ReadonlySet<string>,
): { calls: CallRef[]; symbolKinds: Map<number, BashSymbolKindReading[]> } {
  const calls: CallRef[] = [];
  const symbolKinds = new Map<number, BashSymbolKindReading[]>();
  walk(root, (node) => {
    const member = bashCalledFunction(node, defined);
    if (member !== null) {
      calls.push({ callText: node.text, receiver: null, member, startLine: node.startPosition.row + 1 });
    }
    const named = bashNameOf(node);
    if (named === null) return;
    const kind = symbolKindOf(node.type);
    if (kind === undefined) return;
    const line = node.startPosition.row + 1;
    const reading: BashSymbolKindReading = { name: named.name, kind };
    const onLine = symbolKinds.get(line);
    if (onLine === undefined) symbolKinds.set(line, [reading]);
    else onLine.push(reading);
  });
  return { calls, symbolKinds };
}

/**
 * The set of function names DEFINED in this file, which is what tells an
 * "internal call" from an "external binary invocation".
 */
export function collectBashDefinedFunctions(root: AstNode): Set<string> {
  const defined = new Set<string>();
  walk(root, (node) => {
    if (node.type === "function_definition") {
      const id = node.childForFieldName("name");
      if (id) defined.add(id.text);
    }
  });
  return defined;
}

/**
 * The function a `command` node calls — the `CallRef` member
 * {@link collectBashCallsAndSymbolKinds} emits for it — or null: `source` / `.` are
 * imports, and only a name defined in the file is a call. Read by the
 * identifier-declaration pass so a declaration's bound callee matches that
 * `CallRef` by construction (bd tea-rags-mcp-4p3sb.16).
 */
export function bashCalledFunction(node: AstNode, defined: ReadonlySet<string>): string | null {
  if (node.type !== "command") return null;
  const name = node.childForFieldName("name")?.text;
  if (name === undefined || name === "source" || name === ".") return null;
  return defined.has(name) ? name : null;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
