import { basename } from "node:path";

import type { AstNode } from "../../../../contracts/types/ast.js";

export interface MigrationChunk {
  chunkType: "migration";
  content: string;
  startLine: number;
  endLine: number;
  symbolId: string;
  version?: string;
  operation: string;
  direction?: string;
  table?: string;
  columns: string[];
}

const MIGRATION_OPERATIONS = new Set([
  "create_table",
  "drop_table",
  "rename_table",
  "change_table",
  "add_column",
  "remove_column",
  "rename_column",
  "change_column",
  "change_column_default",
  "change_column_null",
  "add_index",
  "remove_index",
  "rename_index",
  "execute",
  "add_reference",
  "remove_reference",
]);

function literal(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "simple_symbol") return node.text.slice(1);
  if (node.type === "string" && !node.namedChildren.some((child) => child.type === "interpolation")) {
    return node.text.slice(1, -1);
  }
  return undefined;
}

function argumentsOf(node: AstNode): readonly AstNode[] {
  return node.namedChildren.find((child) => child.type === "argument_list")?.namedChildren ?? [];
}

function methodOf(node: AstNode): string | undefined {
  return (
    node.childForFieldName("method")?.text ?? node.namedChildren.find((child) => child.type === "identifier")?.text
  );
}

function blockColumns(node: AstNode): string[] {
  const operationBlock = node.namedChildren.find((child) => child.type === "do_block" || child.type === "block");
  if (!operationBlock) return [];
  const parameters = operationBlock.namedChildren.find((child) => child.type === "block_parameters");
  const builder = parameters?.namedChildren.find((child) => child.type === "identifier")?.text;
  if (!builder) return [];
  const columns: string[] = [];
  const visit = (child: AstNode): void => {
    if (child.type === "call") {
      const callReceiver = child.childForFieldName("receiver");
      if (callReceiver?.type === "identifier" && callReceiver.text === builder) {
        const name = literal(argumentsOf(child)[0]);
        if (name) columns.push(name);
      }
    }
    child.namedChildren.forEach(visit);
  };
  visit(operationBlock);
  return columns;
}

export function chunkRailsMigration(root: AstNode, code: string, filePath: string): MigrationChunk[] {
  const version = /^(\d+)_/.exec(basename(filePath))?.[1];
  const migrationChunks: MigrationChunk[] = [];
  const visit = (node: AstNode, inheritedDirection?: string): void => {
    let direction = inheritedDirection;
    if (node.type === "method") {
      const name = node.childForFieldName("name")?.text;
      if (name === "change" || name === "up" || name === "down") direction = name;
    }
    if (node.type === "call") {
      const operation = methodOf(node);
      if (
        operation &&
        (MIGRATION_OPERATIONS.has(operation) ||
          (direction && operation !== "reversible" && operation !== "up" && operation !== "down"))
      ) {
        const args = argumentsOf(node);
        const table = operation === "execute" ? undefined : literal(args[0]);
        const columns =
          operation === "create_table" || operation === "change_table"
            ? blockColumns(node)
            : operation === "rename_column"
              ? [literal(args[1]), literal(args[2])].filter((value): value is string => value !== undefined)
              : operation.includes("column") || operation.includes("reference") || operation.includes("index")
                ? (args[1]?.type === "array" ? args[1].namedChildren.map(literal) : [literal(args[1])]).filter(
                    (value): value is string => value !== undefined,
                  )
                : [];
        migrationChunks.push({
          chunkType: "migration",
          content: code.slice(node.startIndex, node.endIndex),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          symbolId: `migration:${filePath}:${operation}:${migrationChunks.length + 1}`,
          ...(version ? { version } : {}),
          operation,
          ...(direction ? { direction } : {}),
          ...(table ? { table } : {}),
          columns,
        });
        return;
      }
      if (operation === "up" || operation === "down") direction = operation;
    }
    node.namedChildren.forEach((child) => {
      visit(child, direction);
    });
  };
  visit(root);
  return migrationChunks;
}
