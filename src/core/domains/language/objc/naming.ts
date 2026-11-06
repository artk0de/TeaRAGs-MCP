/**
 * Objective-C names shared by the walker and the chunker.
 *
 * `tree-sitter-objc@3.0.2` does not put a `name` field on a class or a method.
 * The class identifier is the first `identifier` child of `class_interface` /
 * `class_implementation` that is not the `superclass` or `category` field.
 * A method's selector is its direct `identifier` children (the keywords), with
 * a `:` appended for each following `method_parameter`. Parameter names live
 * inside `method_parameter` and are not keywords.
 *
 *   `- (void)draw`                         → `draw`
 *   `- (void)setName:(NSString *)name`     → `setName:`
 *   `- (void)setName:(id)n age:(int)age`   → `setName:age:`
 *   `+ (instancetype)widget`               → `widget`
 *
 * `nameOf` emits that selector as the local name plus `methodKind`. The
 * composer then joins the enclosing class with `#` for an instance method
 * (`-`) and `.` for a class method (`+`): `Widget#setName:`, `Widget.widget`.
 * The kernel `scopeSeparator` is `.` and is only the non-method join (a class
 * has no nested class). It is not a space, and the selector is not spelled
 * `-[Widget setName:]`.
 *
 * A message send (`message_expression`) has one `receiver` field and one
 * `method` field per keyword. Materialization keeps only the first child of a
 * repeated field name, so the selector is read from child order: the first
 * identifier after the receiver is a keyword, and a later identifier is the
 * next keyword only when the next token is `:`. Arguments, including a
 * comma-separated list after one colon, are not keywords.
 */

import type { AstNode } from "../../../contracts/types/ast.js";

const CLASS_NODES = new Set(["class_interface", "class_implementation"]);
const METHOD_NODES = new Set(["method_definition", "method_declaration"]);

function sameNode(a: AstNode, b: AstNode | null): boolean {
  return b !== null && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

/** `-` instance or `+` class, from the method's anonymous sign token. */
export function methodSign(node: AstNode): "-" | "+" | null {
  if (!METHOD_NODES.has(node.type)) return null;
  for (const child of node.children) {
    if (!child.isNamed && (child.text === "-" || child.text === "+")) return child.text;
  }
  return null;
}

/** Class name of an `@interface` or `@implementation`, category excluded. */
export function classNameOf(node: AstNode): string | null {
  if (!CLASS_NODES.has(node.type)) return null;
  const superclass = node.childForFieldName("superclass");
  const category = node.childForFieldName("category");
  for (const child of node.namedChildren) {
    if (child.type !== "identifier") continue;
    if (sameNode(child, superclass) || sameNode(child, category)) continue;
    return child.text;
  }
  return null;
}

/** Selector of a method definition or declaration, or null when it has none. */
export function selectorOf(node: AstNode): string | null {
  if (!METHOD_NODES.has(node.type)) return null;
  const parts: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "identifier") {
      parts.push(child.text);
      continue;
    }
    if (child.type === "method_parameter" && parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}:`;
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

export interface ObjcMessageSend {
  readonly receiver: string;
  readonly member: string;
}

/**
 * Receiver text and selector of a `message_expression`, or null.
 * `[self foo]` → `self` / `foo`. `[self foo:x bar:y]` → `self` / `foo:bar:`.
 */
export function messageSendOf(node: AstNode): ObjcMessageSend | null {
  if (node.type !== "message_expression") return null;
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return null;
  const parts: string[] = [];
  let phase: "keyword" | "after" | "args" = "keyword";
  const { children } = node;
  let index = 0;
  while (index < children.length && !sameNode(children[index], receiver)) index += 1;
  for (index += 1; index < children.length; index += 1) {
    const child = children[index];
    if (!child.isNamed && child.text === "]") break;
    const next = children[index + 1];
    const nextIsColon = next !== undefined && !next.isNamed && next.text === ":";
    if (phase === "keyword" && child.type === "identifier") {
      parts.push(child.text);
      phase = "after";
      continue;
    }
    if (phase === "after" && !child.isNamed && child.text === ":") {
      parts[parts.length - 1] = `${parts[parts.length - 1]}:`;
      phase = "args";
      continue;
    }
    if (phase === "args" && child.type === "identifier" && nextIsColon) {
      parts.push(child.text);
      phase = "after";
    }
  }
  if (parts.length === 0) return null;
  return { receiver: receiver.text, member: parts.join("") };
}

/** Name the generic chunker would otherwise miss: class name or full selector. */
export function objcChunkName(node: AstNode): string | undefined {
  return classNameOf(node) ?? selectorOf(node) ?? undefined;
}
