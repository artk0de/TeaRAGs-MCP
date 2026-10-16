import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";

import type { RustOracleRange, RustOracleSourceProvenance } from "./rust-codegraph-oracle.js";

export interface RustInventoryCfg {
  status: "unconditional" | "unknown" | "active" | "inactive";
  attributes: string[];
}
export interface RustInventoryInput {
  source: string;
  relPath: string;
  workspaceRoot: string;
  cfgPolicy?: (attributes: readonly string[], range: RustOracleRange) => "unknown" | "active" | "inactive";
}
export interface RustInventoryCallee {
  kind: "name" | "qualified" | "method" | "dereference" | "callResult" | "closure" | "callableField" | "expression";
  name?: string;
  uncertainty: string[];
  unsupportedReason?: string;
}
export interface RustInventorySite {
  key: string;
  relPath: string;
  expressionRange: RustOracleRange;
  tokenRange?: RustOracleRange;
  provenance: RustOracleSourceProvenance;
  cfg: RustInventoryCfg;
  ownerKey: string | null;
  callee: RustInventoryCallee;
}
export interface RustInventoryMacro {
  key: string;
  relPath: string;
  expressionRange: RustOracleRange;
  tokenRange?: RustOracleRange;
  provenance: RustOracleSourceProvenance;
  cfg: RustInventoryCfg;
  ownerKey: string | null;
  uncertainty: string[];
}
export interface RustInventorySymbol {
  key: string;
  uri: string;
  name: string;
  symbolId: string | null;
  candidateSymbolId: string | null;
  range: RustOracleRange;
  selectionRange: RustOracleRange;
  provenance: RustOracleSourceProvenance;
  cfg: RustInventoryCfg;
  declarationOnly: boolean;
  traitDeclaration: boolean;
  traitImpl: boolean;
  traitName: string | null;
  uncertainty: string[];
}
export interface RustSourceInventory {
  sites: RustInventorySite[];
  macros: RustInventoryMacro[];
  symbols: RustInventorySymbol[];
  parseErrors: { kind: "error" | "missing"; nodeType: string; range: RustOracleRange }[];
  limitations: string[];
}

/**
 * Native syntax only: no production walker, chunk ownership, target edges or
 * semantic oracle. Names locate tokens, not functions: a path may denote a
 * callable value and method syntax says nothing about dynamic dispatch.
 * Node's native tree-sitter binding reports UTF-16 indices and columns (pinned
 * by the Unicode fixture); do not convert these coordinates as UTF-8 bytes.
 */
export function buildRustSourceInventory(input: RustInventoryInput): RustSourceInventory {
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const tree = parser.parse(input.source);
  const result: RustSourceInventory = {
    sites: [],
    macros: [],
    symbols: [],
    parseErrors: [],
    limitations: ["syntaxInventoryNotSemanticOracle", "macroExpansionNotInventoried", "cfgNotEvaluatedWithoutPolicy"],
  };
  const uri = pathToFileURL(resolve(input.workspaceRoot, input.relPath)).href;
  const enclosingSymbols = new Map<string, string | null>();
  const rootScope: RustInventoryScope = { path: [], owner: null, callableKey: null, attributes: [] };
  const stack: { node: Parser.SyntaxNode; scope: RustInventoryScope }[] = [{ node: tree.rootNode, scope: rootScope }];
  while (stack.length) {
    const next = stack.pop();
    if (!next) break;
    const { node, scope } = next;
    const attributes = [...scope.attributes, ...attachedCfgAttributes(node)];
    let childScope: RustInventoryScope = { ...scope, attributes };
    if (node.type === "ERROR" || node.isMissing) {
      result.parseErrors.push({
        kind: node.isMissing ? "missing" : "error",
        nodeType: node.type,
        range: nodeRange(node),
      });
    }
    if (node.type === "mod_item") {
      const name = node.childForFieldName("name");
      childScope = { ...childScope, path: name ? [...scope.path, name.text] : scope.path, owner: null };
    } else if (node.type === "impl_item" || node.type === "trait_item") {
      const isTrait = node.type === "trait_item";
      const ownerNode = node.childForFieldName(isTrait ? "name" : "type");
      const ownerName = declarationOwnerName(ownerNode);
      const trait = node.childForFieldName("trait");
      childScope = {
        ...childScope,
        owner: {
          name: ownerName === null ? null : [...scope.path, ownerName].join("::"),
          traitDeclaration: isTrait,
          traitImpl: trait !== null,
          traitName: trait?.text ?? null,
          uncertain: node.hasError || ownerName === null,
        },
      };
    } else if (node.type === "function_item" || node.type === "function_signature_item") {
      const symbol = inventorySymbol(node, childScope, uri, input);
      if (symbol) {
        result.symbols.push(symbol);
        enclosingSymbols.set(symbol.key, scope.callableKey);
        childScope = {
          ...childScope,
          path: symbol.candidateSymbolId ? [symbol.candidateSymbolId] : scope.path,
          owner: null,
          callableKey: symbol.key,
        };
      }
    } else if (node.type === "call_expression") {
      const expressionRange = nodeRange(node);
      const cfg = inventoryCfg(attributes, expressionRange, input);
      const { token, callee } = inventoryCallee(node.childForFieldName("function"));
      if (node.hasError) callee.uncertainty.push("parseRecovery");
      result.sites.push({
        key: inventoryKey(input.relPath, expressionRange),
        relPath: input.relPath,
        expressionRange,
        ...(token ? { tokenRange: nodeRange(token) } : {}),
        provenance: cfg.status === "inactive" ? "inactiveCfg" : "source",
        cfg,
        ownerKey: scope.callableKey,
        callee,
      });
    } else if (node.type === "macro_invocation") {
      const expressionRange = nodeRange(node);
      const cfg = inventoryCfg(attributes, expressionRange, input);
      const token = syntaxNameToken(node.childForFieldName("macro"));
      result.macros.push({
        key: inventoryKey(input.relPath, expressionRange),
        relPath: input.relPath,
        expressionRange,
        ...(token ? { tokenRange: nodeRange(token) } : {}),
        provenance: cfg.status === "inactive" ? "inactiveCfg" : "source",
        cfg,
        ownerKey: scope.callableKey,
        uncertainty: ["expansionUnknown"],
      });
    }
    // Walk all native children, including anonymous missing nodes. Token trees
    // remain token trees: never reparse macro bodies as executable Rust.
    for (let index = node.childCount - 1; index >= 0; index--) {
      const child = node.child(index);
      if (child) stack.push({ node: child, scope: childScope });
    }
  }
  const candidateCounts = new Map<string, number>();
  const symbolsByKey = new Map(result.symbols.map((symbol) => [symbol.key, symbol]));
  for (const symbol of result.symbols) {
    if (symbol.candidateSymbolId !== null) {
      candidateCounts.set(symbol.candidateSymbolId, (candidateCounts.get(symbol.candidateSymbolId) ?? 0) + 1);
    }
  }
  // Native preorder places enclosing declarations first. Propagate ambiguity
  // after collision detection, including collisions found later in the file.
  for (const symbol of result.symbols) {
    if (symbol.candidateSymbolId !== null && (candidateCounts.get(symbol.candidateSymbolId) ?? 0) > 1) {
      symbol.symbolId = null;
      symbol.uncertainty.push("ambiguousSymbolId");
    }
    const enclosingKey = enclosingSymbols.get(symbol.key);
    if (enclosingKey && symbolsByKey.get(enclosingKey)?.symbolId === null) {
      symbol.symbolId = null;
      symbol.uncertainty.push("enclosingIdentityUnknown");
    }
  }
  result.sites.sort((a, b) => compareRanges(a.expressionRange, b.expressionRange));
  result.macros.sort((a, b) => compareRanges(a.expressionRange, b.expressionRange));
  result.symbols.sort((a, b) => compareRanges(a.range, b.range));
  result.parseErrors.sort((a, b) => compareRanges(a.range, b.range));
  return result;
}

interface RustInventoryScope {
  path: string[];
  owner: {
    name: string | null;
    traitDeclaration: boolean;
    traitImpl: boolean;
    traitName: string | null;
    uncertain: boolean;
  } | null;
  callableKey: string | null;
  attributes: string[];
}

function nodeRange(node: Parser.SyntaxNode): RustOracleRange {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}

function inventoryKey(relPath: string, range: RustOracleRange): string {
  return JSON.stringify([relPath, range.start.line, range.start.character, range.end.line, range.end.character]);
}

function compareRanges(left: RustOracleRange, right: RustOracleRange): number {
  return (
    left.start.line - right.start.line ||
    left.start.character - right.start.character ||
    left.end.line - right.end.line ||
    left.end.character - right.end.character
  );
}

function syntaxNameToken(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  if (!node || node.hasError || node.isMissing) return null;
  if (["identifier", "field_identifier", "type_identifier"].includes(node.type)) return node;
  if (["scoped_identifier", "scoped_type_identifier"].includes(node.type)) {
    return syntaxNameToken(node.childForFieldName("name"));
  }
  return null;
}

function inventoryCallee(node: Parser.SyntaxNode | null): {
  token: Parser.SyntaxNode | null;
  callee: RustInventoryCallee;
} {
  let expression = node;
  let parenthesized = false;
  while (expression && ["generic_function", "parenthesized_expression"].includes(expression.type)) {
    if (expression.type === "parenthesized_expression") {
      parenthesized = true;
      expression = expression.namedChildCount === 1 ? expression.namedChild(0) : null;
    } else expression = expression.childForFieldName("function");
  }
  const unsupported = (kind: RustInventoryCallee["kind"], reason: string) => ({
    token: null,
    callee: { kind, uncertainty: ["unsupportedCallee"], unsupportedReason: reason },
  });
  if (!expression || expression.hasError || expression.isMissing) {
    return unsupported("expression", "missingOrMalformedCallee");
  }
  if (expression.type === "identifier") {
    return { token: expression, callee: { kind: "name", name: expression.text, uncertainty: ["valueOrFunction"] } };
  }
  if (expression.type === "scoped_identifier") {
    const token = syntaxNameToken(expression);
    if (!token) return unsupported("expression", "unsupportedQualifiedName");
    return {
      token,
      callee: {
        kind: "qualified",
        name: token.text,
        uncertainty: [
          "qualifiedValueOrFunction",
          ...(expression.descendantsOfType("qualified_type").length ? ["traitDispatchUnknown"] : []),
        ],
      },
    };
  }
  if (expression.type === "field_expression") {
    if (parenthesized) return unsupported("callableField", "functionValuedFieldHasNoCallableNameToken");
    const token = expression.childForFieldName("field");
    if (token?.type === "field_identifier") {
      return { token, callee: { kind: "method", name: token.text, uncertainty: ["dispatchUnknown"] } };
    }
  }
  if (expression.type === "unary_expression") {
    return unsupported("dereference", "dereferencedValueHasNoCallableNameToken");
  }
  if (expression.type === "call_expression") return unsupported("callResult", "callResultHasNoCallableNameToken");
  if (expression.type === "closure_expression") return unsupported("closure", "closureHasNoCallableNameToken");
  return unsupported("expression", `unsupportedCalleeNode:${expression.type}`);
}

function declarationOwnerName(node: Parser.SyntaxNode | null): string | null {
  if (!node || node.hasError) return null;
  if (node.type === "generic_type") return declarationOwnerName(node.childForFieldName("type"));
  if (node.type === "type_identifier") return node.text;
  // A path may be imported or alias-qualified. Do not claim it is the local
  // module path simply because the final identifier matches a declaration.
  return null;
}

function inventorySymbol(
  node: Parser.SyntaxNode,
  scope: RustInventoryScope,
  uri: string,
  input: RustInventoryInput,
): RustInventorySymbol | null {
  const name = node.childForFieldName("name");
  if (!name || name.isMissing) return null;
  const { owner } = scope;
  const parameters = node.childForFieldName("parameters");
  const hasSelf =
    parameters?.namedChildren.some(
      (parameter) => parameter.type === "self_parameter" || parameter.childForFieldName("pattern")?.type === "self",
    ) ?? false;
  const candidateSymbolId = owner
    ? owner.name === null
      ? null
      : `${owner.name}${hasSelf ? "#" : "."}${name.text}`
    : [...scope.path, name.text].join("::");
  const uncertainty: string[] = [];
  if (owner?.traitImpl) uncertainty.push("traitImplementationIdentity");
  if (owner?.uncertain || candidateSymbolId === null) uncertainty.push("unsupportedOwnerIdentity");
  if (node.hasError) uncertainty.push("parseRecovery");
  const range = nodeRange(node);
  const cfg = inventoryCfg(scope.attributes, range, input);
  return {
    key: inventoryKey(input.relPath, range),
    uri,
    name: name.text,
    symbolId: uncertainty.length ? null : candidateSymbolId,
    candidateSymbolId,
    range,
    selectionRange: nodeRange(name),
    provenance: cfg.status === "inactive" ? "inactiveCfg" : "source",
    cfg,
    declarationOnly: node.type === "function_signature_item",
    traitDeclaration: owner?.traitDeclaration ?? false,
    traitImpl: owner?.traitImpl ?? false,
    traitName: owner?.traitName ?? null,
    uncertainty,
  };
}

function attachedCfgAttributes(node: Parser.SyntaxNode): string[] {
  const attributes: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling && ["attribute_item", "line_comment", "block_comment"].includes(sibling.type)) {
    if (sibling.type === "attribute_item" && isCfgAttribute(sibling)) attributes.unshift(sibling.text);
    sibling = sibling.previousNamedSibling;
  }
  for (const child of node.namedChildren) {
    if (child.type === "inner_attribute_item" && isCfgAttribute(child)) attributes.push(child.text);
  }
  return attributes;
}

function isCfgAttribute(node: Parser.SyntaxNode): boolean {
  const attribute = node.namedChildren.find((child) => child.type === "attribute");
  const name = attribute?.namedChild(0);
  return name?.type === "identifier" && ["cfg", "cfg_attr"].includes(name.text);
}

function inventoryCfg(attributes: string[], range: RustOracleRange, input: RustInventoryInput): RustInventoryCfg {
  return {
    status: attributes.length ? (input.cfgPolicy?.([...attributes], range) ?? "unknown") : "unconditional",
    attributes: [...attributes],
  };
}
