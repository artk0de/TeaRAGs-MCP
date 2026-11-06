import type { AstNode } from "../../../../../contracts/types/ast.js";
import type {
  DeclaredIdentifierSite,
  IdentifierDeclarationSyntax,
  IdentifierSyntacticType,
} from "../../../kernel/index.js";

function annotationType(node: AstNode): IdentifierSyntacticType | undefined {
  const typeName = node.namedChildren.find((child) => child.type === "type_name");
  const id =
    typeName?.namedChildren.find((child) => child.type === "type_identifier" || child.type === "primitive_type") ??
    typeName?.namedChildren[0];
  const text = (id?.text ?? node.text).replace(/[()*]/g, "").trim().split(/\s+/)[0];
  if (!text || text === "void") return undefined;
  return { typeName: text };
}

const methodParameterRule = {
  nodeType: "method_parameter",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const nameNode = node.namedChildren.find((child) => child.type === "identifier");
    const typeNode = node.namedChildren.find((child) => child.type === "method_type");
    return nameNode ? [{ nameNode, kind: "param", typeNode }] : [];
  },
};

const returnRule = {
  nodeType: "method_definition",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const nameNode = node.namedChildren.find((child) => child.type === "identifier");
    const typeNode = node.namedChildren.find((child) => child.type === "method_type");
    return nameNode && typeNode ? [{ nameNode, kind: "return", typeNode }] : [];
  },
};

export const OBJC_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [methodParameterRule, returnRule],
  annotationType,
  constructorType: () => undefined,
};
