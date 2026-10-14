/**
 * JavaScript field accesses (bd tea-rags-mcp-p1w1c, zy6hx follow-up) — the
 * shared ECMAScript field-access collector (`ecmascriptFieldAccessFacetPass`,
 * whose docblock owns the site table and the read / write rules), driven by a
 * JavaScript parameter reader. JavaScript writes no type annotations, so every
 * parameter it names is untyped and its fields land as `unknown` with the
 * receiver; JSDoc `@param` types are not read. A parameter is a receiver when
 * written as a bare `identifier` or a default-valued `assignment_pattern`
 * (`order = {}`); a destructured or rest parameter names none.
 *
 * Only class methods, constructors and accessors open a scope — reading and
 * writing ES2022 fields (`x = 1`, `#priv`), constructor `this.x =`
 * assignments, `this.#x` reads and writes. A class-field arrow
 * (`onClick = (e) => …`) owns no chunk in JavaScript, so its accesses are not
 * recorded rather than guessed onto the class. A
 * constructor-function / `Foo.prototype.m = function` class is not read: the
 * TypeScript pass it shares has no such shape, and its `this` is bound by the
 * call, not declared by a class.
 */

import type { ExtractionFacetPass } from "../../../kernel/index.js";
import {
  ecmascriptFieldAccessFacetPass,
  type EcmascriptParameterTypeReader,
} from "../../../typescript/walker/passes/field-accesses.js";

const readJavascriptParameterType: EcmascriptParameterTypeReader = () => (param) => {
  if (param.type === "identifier") return { name: param.text, type: null };
  if (param.type !== "assignment_pattern") return undefined;
  const pattern = param.childForFieldName("left");
  return pattern?.type === "identifier" ? { name: pattern.text, type: null } : undefined;
};

export const javascriptFieldAccessFacetPass: ExtractionFacetPass =
  ecmascriptFieldAccessFacetPass(readJavascriptParameterType);
