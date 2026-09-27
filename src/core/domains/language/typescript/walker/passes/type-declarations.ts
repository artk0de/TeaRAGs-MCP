/**
 * ECMAScript type and constant declarations (bd tea-rags-mcp-vi0wx, spec §1b)
 * — fills `FileExtraction.typeDeclarations` with one fact per declaration the
 * file makes at module level, whether or not it is a chunk:
 *
 *   | declaration                                           | symbolKind |
 *   | ----------------------------------------------------- | ---------- |
 *   | `class` / `abstract class`, const-bound class expr    | class      |
 *   | `interface`                                           | interface  |
 *   | `type T = …`                                          | type_alias |
 *   | `enum` / `const enum`                                 | enum       |
 *   | `namespace` / `module` (identifier-named)             | module     |
 *   | const-object namespace (`const X = { m() {} }`)       | module     |
 *   | any other `const` declarator bound to a name          | constant   |
 *
 * A `const` the language's `nameOf` names as a FUNCTION (an arrow, a function
 * expression, a wrapper-exported component) is a function symbol already, so
 * it is no fact. `let` / `var` are not constants. Only module level counts:
 * the walk descends through `export`, `declare` and namespace bodies and never
 * into a function or class body, so a local is never reached. That also keeps
 * the walk to the statement lists — it is not a second full traversal.
 *
 * `typeId` is the declaration's name as its symbol id composes it: `tsNameOf`
 * names no `namespace` / `module`, so nothing enclosing one prefixes it
 * (`namespace A { class B }` → module `A`, class `B`). An ambient module named
 * by a string (`declare module "pkg"`) names a package, not a project type, so
 * it is no fact itself; what it declares still is, unprefixed. `declare global
 * { … }` is walked the same way. `conforms` lists `extends` then `implements` (an interface: its `extends`),
 * generic arguments dropped; a heritage expression that names no type (a
 * mixin call) is skipped. Every fact is the declaration itself, so `reopens`
 * is `false` — TypeScript declaration merging is not told apart here.
 *
 * TypeScript and JavaScript share the pass, each with its own `nameOf`;
 * JavaScript's grammar has no interface, alias, enum or namespace node, so its
 * row is the subset by construction. The facts are naming data only: neither
 * capability sets `resolverReadsTypeDeclarations`.
 *
 * The same walk takes the member census (`typeMemberCensus`, bd
 * tea-rags-mcp-ffxfc) of every class, interface and object-type alias it
 * records — how `type-member-census.ts` reads a member is documented there.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../../contracts/types/codegraph-symbols.js";
import type {
  FileExtraction,
  NamedSymbol,
  TypeDeclarationFact,
  TypeMemberCensus,
} from "../../../../../contracts/types/codegraph.js";
import { constObjectNamespaceName, unwrapTypeAssertions } from "../../../../../infra/symbolid/index.js";
import type { ExtractionFacetPass } from "../../../kernel/index.js";
import { classBodyMemberCounts, objectTypeMemberCounts, type EcmascriptMemberCounts } from "./type-member-census.js";

type NameOf = (node: AstNode) => NamedSymbol | NamedSymbol[] | null;

/** What the walk collects: the facts, and the member census of those whose members it reads. */
interface TypeDeclarationSink {
  facts: TypeDeclarationFact[];
  census: TypeMemberCensus[];
}

function recordCensus(sink: TypeDeclarationSink, fact: TypeDeclarationFact, counts: EcmascriptMemberCounts): void {
  sink.census.push({ typeId: fact.typeId, line: fact.line, ...counts });
}

/**
 * The member census of a module-level declaration whose members it writes: a
 * class, an interface, a type alias bound to an object type. Anything else — a
 * union or mapped alias, an enum, a namespace — writes none, so it has no
 * census (unknown), not an empty one.
 */
function declarationMemberCounts(declaration: AstNode): EcmascriptMemberCounts | null {
  switch (declaration.type) {
    case "class_declaration":
    case "abstract_class_declaration":
      return classBodyMemberCounts(declaration.childForFieldName("body"));
    case "interface_declaration":
      return objectTypeMemberCounts(declaration.childForFieldName("body"));
    case "type_alias_declaration": {
      const value = declaration.childForFieldName("value");
      return value?.type === "object_type" ? objectTypeMemberCounts(value) : null;
    }
    default:
      return null;
  }
}

const KIND_BY_DECLARATION: ReadonlyMap<string, SymbolDefinitionKind> = new Map<string, SymbolDefinitionKind>([
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["type_alias_declaration", "type_alias"],
  ["enum_declaration", "enum"],
]);

const NAMESPACE_TYPES: ReadonlySet<string> = new Set(["internal_module", "module"]);

/** Heritage node → the type name it denotes, generic arguments dropped; null when it names none. */
function heritageTypeName(node: AstNode): string | null {
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "member_expression":
    case "nested_type_identifier":
      return node.text;
    case "generic_type": {
      const base = node.namedChildren.find((c) => c.type !== "type_arguments");
      return base === undefined ? null : heritageTypeName(base);
    }
    default:
      return null;
  }
}

function namesIn(clause: AstNode | undefined): string[] {
  if (clause === undefined) return [];
  const names: string[] = [];
  for (const child of clause.namedChildren) {
    const name = heritageTypeName(child);
    if (name !== null) names.push(name);
  }
  return names;
}

/**
 * Supertypes in clause order. TypeScript wraps a class's heritage in
 * `extends_clause` / `implements_clause`; JavaScript's `class_heritage` holds
 * the superclass expression directly.
 */
function supertypesOf(declaration: AstNode): string[] {
  if (declaration.type === "interface_declaration") {
    return namesIn(declaration.namedChildren.find((c) => c.type === "extends_type_clause"));
  }
  const heritage = declaration.namedChildren.find((c) => c.type === "class_heritage");
  if (heritage === undefined) return [];
  const clauses = heritage.namedChildren.filter((c) => c.type === "extends_clause" || c.type === "implements_clause");
  if (clauses.length === 0) return namesIn(heritage);
  return clauses.flatMap((clause) => namesIn(clause));
}

function fact(
  name: string,
  symbolKind: SymbolDefinitionKind,
  node: AstNode,
  conforms: readonly string[] = [],
): TypeDeclarationFact {
  const out: TypeDeclarationFact = {
    typeId: name,
    symbolKind,
    line: node.startPosition.row + 1,
    reopens: false,
  };
  return conforms.length > 0 ? { ...out, conforms } : out;
}

function isConstDeclaration(node: AstNode): boolean {
  return node.type === "lexical_declaration" && node.children[0]?.type === "const";
}

function namesAFunction(declarator: AstNode, nameOf: NameOf): boolean {
  return nameOf(declarator) !== null && constObjectNamespaceName(declarator) === null;
}

function collectConstDeclarators(declaration: AstNode, nameOf: NameOf, sink: TypeDeclarationSink): void {
  for (const declarator of declaration.namedChildren) {
    if (declarator.type !== "variable_declarator") continue;
    const id = declarator.childForFieldName("name");
    if (id?.type !== "identifier") continue;
    const value = declarator.childForFieldName("value");
    const bound = value ? unwrapTypeAssertions(value) : undefined;
    if (bound?.type === "class") {
      const classFact = fact(id.text, "class", declarator, supertypesOf(bound));
      sink.facts.push(classFact);
      recordCensus(sink, classFact, classBodyMemberCounts(bound.childForFieldName("body")));
    } else if (constObjectNamespaceName(declarator) !== null) {
      sink.facts.push(fact(id.text, "module", declarator));
    } else if (!namesAFunction(declarator, nameOf)) {
      sink.facts.push(fact(id.text, "constant", declarator));
    }
  }
}

/** A namespace's identifier name; null for a string-named ambient module (a package, not a project type). */
function namespaceName(node: AstNode): string | null {
  const name = node.childForFieldName("name") ?? node.namedChildren[0];
  return name?.type === "identifier" || name?.type === "nested_identifier" ? name.text : null;
}

/** One module-level statement: record what it declares, descend only into a namespace-like body. */
function collectStatement(node: AstNode, nameOf: NameOf, sink: TypeDeclarationSink): void {
  switch (node.type) {
    case "export_statement":
    case "ambient_declaration":
    case "expression_statement":
      for (const child of node.namedChildren) collectStatement(child, nameOf, sink);
      return;
    case "statement_block":
      // `declare global { … }` — the only block reached here.
      collectStatements(node, nameOf, sink);
      return;
    case "lexical_declaration":
      if (isConstDeclaration(node)) collectConstDeclarators(node, nameOf, sink);
      return;
    default:
      break;
  }
  if (NAMESPACE_TYPES.has(node.type)) {
    const name = namespaceName(node);
    if (name !== null) sink.facts.push(fact(name, "module", node));
    const body = node.childForFieldName("body") ?? node.namedChildren.find((c) => c.type === "statement_block");
    if (body) collectStatements(body, nameOf, sink);
    return;
  }
  const kind = KIND_BY_DECLARATION.get(node.type);
  const name = kind === undefined ? undefined : node.childForFieldName("name")?.text;
  if (kind === undefined || name === undefined) return;
  const declared = fact(name, kind, node, supertypesOf(node));
  sink.facts.push(declared);
  const counts = declarationMemberCounts(node);
  if (counts !== null) recordCensus(sink, declared, counts);
}

function collectStatements(container: AstNode, nameOf: NameOf, sink: TypeDeclarationSink): void {
  for (const statement of container.namedChildren) collectStatement(statement, nameOf, sink);
}

export function ecmascriptTypeDeclarationFacetPass(nameOf: NameOf): ExtractionFacetPass {
  return {
    run: (root): Partial<FileExtraction> => {
      const sink: TypeDeclarationSink = { facts: [], census: [] };
      collectStatements(root, nameOf, sink);
      return {
        ...(sink.facts.length > 0 ? { typeDeclarations: sink.facts } : {}),
        ...(sink.census.length > 0 ? { typeMemberCensus: sink.census } : {}),
      };
    },
  };
}
