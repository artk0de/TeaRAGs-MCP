/**
 * Recognition of the **class-property function** — a class member declared as a
 * field bound to a function value rather than as a method:
 *
 *   class AdminentrypointPostFetcher {
 *     request = async (url: string) => fetch(url);
 *     static build = () => new AdminentrypointPostFetcher();
 *   }
 *
 * A `public_field_definition`, not a `variable_declarator`, so neither
 * {@link constObjectNamespaceName} nor {@link functionValuedDeclaratorName}
 * reaches it. bd tea-rags-mcp-29m75 named that second shape at any depth and
 * left this one explicitly out of scope pending evidence; the evidence arrived
 * with the same measurement pass. See "What it cost to leave this unnamed".
 *
 * Lives in `infra/symbolid` for the reason its three siblings do: the answer has
 * to be the same for the same physical AST node no matter who asks
 * (`.claude/rules/symbolid-convention.md`). Here the shared half is the KIND —
 * this gate reads `classifyMethod` for it, and so does the chunker's class-body
 * grouper, which buckets a `static` field away from a plain property.
 *
 * ## Why this shape needs a `methodKind` and the const gates do not
 *
 * A module-level `const fn = () => {}` composes as a bare `fn`: there is no
 * enclosing symbol and therefore no separator to choose. A class field always
 * has one, and which separator it takes is not cosmetic — it is how the resolver
 * finds it. `TSLocalBindingSymbolResolutionStrategy#resolveByLocalType` asks the
 * symbol table for `Type#member` and then for `Type.member`; a field composed
 * with the wrong separator is a row nothing looks up, which is strictly worse
 * than no row at all.
 *
 * ## What it cost to leave this unnamed
 *
 * `fetcher.request()` in a generated API client is a `localVar` receiver the
 * walker already types from `const fetcher = new AdminentrypointPostFetcher()`,
 * so pass 4 held the right answer and asked for a row that did not exist. It
 * therefore CONTINUEd, and a later, weaker pass landed the call on a same-named
 * `request` in an unrelated file: 26 production-visible `wrongFile` rows on the
 * taxdome oracle whose true target is an unpinned `PropertyDeclaration`, and the
 * same gap is what let the (now-guarded) global short-name pass fabricate 829
 * `apiClient#request` edges.
 *
 * ## Deliberately out of scope
 *
 * - **A `#private` field** (`#secret = () => 2`, a `private_property_identifier`
 *   name). No call outside the class can reach it, so the only edges naming it
 *   would buy are same-file ones the enclosing class chunk already covers, and
 *   the `Class##secret` id it implies is a shape no resolver composes.
 * - **A COMPUTED name** (`["computed"] = () => 3`). Nothing statically names the
 *   member, which is the same reason a destructuring pattern is declined by the
 *   declarator gate next door.
 * - **JavaScript's `field_definition`.** The JS grammar uses a different node
 *   type AND puts the name on a `property` field rather than a `name` field, so
 *   this gate does not answer for it and `jsNameOf`'s delegation to `tsNameOf`
 *   is unchanged by construction. That is a scope decision, not an oversight:
 *   the measurement behind this bead is a TypeScript corpus, and widening to a
 *   second grammar shape on no evidence is what the const-bound-function
 *   docblock got wrong about THIS shape.
 */

import type { AstNode } from "../../contracts/types/ast.js";
import type { MethodClassification } from "./classify.js";
import { classifyMethod } from "./classify.js";
import { isFunctionValuedExpression } from "./const-bound-function.js";

/** A class field that declares a callable, and the member kind it binds. */
export interface ClassPropertyFunction {
  /** The member's own name — `request`, never the composed id. */
  readonly name: string;
  /** `instance` unless the field carries `static`; decides `#` vs `.`. */
  readonly methodKind: MethodClassification;
}

/**
 * The class-property function a `public_field_definition` declares, or null when
 * the node is not one.
 *
 * Both halves of the gate are narrow on purpose:
 *
 *   - the NAME must be a plain `property_identifier`. A computed name and a
 *     `#private` name are declined above;
 *   - the VALUE must be function-valued by the same predicate the declarator
 *     gate uses, so `retries = 3` (a datum), `translate = useTranslation()` (a
 *     call, whose function is declared wherever the callee is) and
 *     `declare later: () => void` (a TYPE with no value at all — the oracle's
 *     `FunctionType` class) all decline.
 *
 * Reading both through `childForFieldName` rather than by child position is what
 * makes the modifiers free: `private readonly send = () => 1` puts an
 * `accessibility_modifier` and a keyword ahead of the name, and a positional
 * read would name the modifier.
 */
export function classPropertyFunction(node: AstNode): ClassPropertyFunction | null {
  if (node.type !== "public_field_definition") return null;
  const name = node.childForFieldName("name");
  if (name?.type !== "property_identifier") return null;
  const value = node.childForFieldName("value");
  if (!value || !isFunctionValuedExpression(value)) return null;
  const methodKind = classifyMethod(node);
  if (methodKind === null) return null;
  return { name: name.text, methodKind };
}
