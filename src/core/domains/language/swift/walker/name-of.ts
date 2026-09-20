/**
 * Swift `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor for
 * codegraph symbol extraction, the tier-2 half of the Swift vertical. Mirrors
 * `javaNameOf` in shape: one self-contained `NamedSymbol | null`, no helper web.
 *
 * Every Swift declaration this reads exposes its own identifier on the `name`
 * FIELD, including the two that look like they would not:
 *   - `init_declaration` — the `init` keyword IS the name field, so the id
 *     composes as `Invoice#init` without a hardcoded literal here;
 *   - `class_declaration` under the `extension` keyword — the name field is a
 *     `user_type` rather than a `type_identifier`, and its text is the EXTENDED
 *     type, which is exactly the attribution Swift's own semantics demand
 *     (`extension Vehicle { func honk() }` declares `Vehicle#honk`).
 *
 * The text is read VERBATIM, generics included. That is deliberate: the chunker
 * names the same nodes through the generic engine's `extractName`, which is
 * `childForFieldName("name")` text with no stripping, and the two halves must
 * spell an id identically or the edges point at ids no chunk carries. Rust
 * needs a `nameExtractor` precisely because its chunker DOES strip an impl
 * block's generics; Swift's does not, so neither does this.
 *
 * `function_declaration` / `protocol_function_declaration` route through
 * `methodKindFromClassify` (the kernel wrapper over `classifyMethod` in
 * `infra/symbolid`), which already carries Swift's branches: a `static` or
 * `class` modifier is class-level (`.`), otherwise instance (`#`), and
 * `init_declaration` is always instance-bound — it initializes an instance,
 * like the Java constructor (`.claude/rules/symbolid-convention.md`).
 *
 * `class_declaration` (class / struct / enum / extension / actor — one node
 * type, the keyword is an anonymous child) and `protocol_declaration` are scope
 * containers (`descendsInto: true`), composed with the `.` `scopeSeparator` the
 * kernel declares.
 *
 * Not named here, matching the tier-1 chunker's scope: `property_declaration`,
 * `subscript_declaration` (whose `name` field points at the RETURN type),
 * `deinit_declaration` (no name field), `typealias_declaration`,
 * `associatedtype_declaration`, `enum_entry`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { methodKindFromClassify } from "../../kernel/method-kind.js";

export function swiftNameOf(node: AstNode): NamedSymbol | null {
  if (node.type === "class_declaration" || node.type === "protocol_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "init_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: "instance" };
  }
  return null;
}
