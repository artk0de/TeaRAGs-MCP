/**
 * Bash extraction walker.
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

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface BashExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromBashFile(input: BashExtractInput): FileExtraction {
  const imports = collectBashImports(input.tree.rootNode);
  const calls = collectBashFunctionCalls(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => ({
    symbolId: c.symbolId,
    scope: c.scope,
    startLine: c.startLine,
    endLine: c.endLine,
    calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
  }));
  return {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope: [],
  };
}

function collectBashImports(root: Parser.SyntaxNode): ImportRef[] {
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

function collectBashFunctionCalls(root: Parser.SyntaxNode): CallRef[] {
  // Collect the set of function names DEFINED in this file so we can
  // distinguish "internal call" from "external binary invocation".
  const defined = new Set<string>();
  walk(root, (node) => {
    if (node.type === "function_definition") {
      const id = node.childForFieldName("name");
      if (id) defined.add(id.text);
    }
  });
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "command") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const name = nameNode.text;
    // Skip source/. — they're imports.
    if (name === "source" || name === ".") return;
    // Only emit if the name is one we know was defined in the file.
    if (!defined.has(name)) return;
    out.push({ callText: node.text, receiver: null, member: name, startLine: node.startPosition.row + 1 });
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
