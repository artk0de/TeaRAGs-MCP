/**
 * The `docstring` type source: Google `Args:` / `Returns:` and Sphinx
 * `:type:` / `:rtype:` (E2 seam 2, bd tea-rags-mcp-9fgdi). Two dialects,
 * because two are what the corpora carry — ugnest documents 252 defs in Google
 * style, flask 230 in Sphinx. numpydoc and epytext file nothing.
 *
 * Ranked BELOW `annotations` in `PYTHON_TYPE_SOURCE_ORDER`, and disjoint from it
 * by construction: a param fact needs a parameter with no annotation node, a
 * return fact needs a def with no `return_type`. A def that satisfies neither
 * never has its docstring read at all, which is what keeps this off the hot
 * path on the annotated corpora.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { InlineTypeSource, TypeFact } from "../../../kernel/type-facts.js";
import type { PythonTypeSourceInput } from "./python-annotation-type-source.js";
import { isPythonClassFormDef, walkPythonScopes } from "./python-def-scope-walk.js";
import { pythonNominalReceiverName, pythonTypeRefFromText } from "./python-type-annotation.js";

export const PYTHON_DOCSTRING_SOURCE = "docstring";

const GOOGLE_ARGS_HEADER = /^\s*(?:Args|Arguments|Parameters)\s*:\s*$/;
const GOOGLE_RETURNS_HEADER = /^\s*(?:Returns|Yields)\s*:\s*$/;
const GOOGLE_ANY_HEADER = /^\s*[A-Z][A-Za-z ]*:\s*$/;
const GOOGLE_ARG_ENTRY = /^\s*(\*{0,2}[A-Za-z_]\w*)\s*\(([^)]+)\)\s*:/;
const GOOGLE_RETURN_ENTRY = /^\s*([^:]+?)\s*:/;
const SPHINX_TYPE = /^\s*:type\s+(\*{0,2}[A-Za-z_]\w*)\s*:\s*(.+?)\s*$/;
const SPHINX_RTYPE = /^\s*:rtype\s*:\s*(.+?)\s*$/;

/**
 * A type token, not prose. Bracketed groups are removed first, then what is left
 * must be dotted names joined by `|` — so `Optional[Foo]`, `dict[str, Foo]` and
 * `Foo | None` pass while `The open session, if any` does not.
 */
function isDocstringTypeToken(text: string): boolean {
  const outsideBrackets = text.replace(/\[[^\]]*\]/g, "").trim();
  return /^[\w.]+(?:\s*\|\s*[\w.]+)*$/.test(outsideBrackets);
}

function acceptedType(text: string): string | undefined {
  const trimmed = text.trim();
  return isDocstringTypeToken(trimmed) ? trimmed : undefined;
}

/** The docstring body with its quotes and any prefix removed; `undefined` when there is none. */
export function pythonDocstringText(fn: AstNode): string | undefined {
  const first = fn.childForFieldName("body")?.namedChild(0);
  if (first === null || first === undefined) return undefined;
  const literal = first.type === "string" ? first : first.type === "expression_statement" ? first.namedChild(0) : null;
  if (literal?.type !== "string") return undefined;
  const raw = literal.text;
  const quoteAt = raw.search(/["']/);
  if (quoteAt === -1) return undefined;
  const body = raw.slice(quoteAt);
  for (const quote of ['"""', "'''", '"', "'"]) {
    if (!body.startsWith(quote)) continue;
    const inner = body.slice(quote.length);
    return inner.endsWith(quote) ? inner.slice(0, -quote.length) : inner;
  }
  return body;
}

interface DocstringTypes {
  readonly params: Map<string, string>;
  readonly returnType: string | undefined;
}

function parseDocstringTypes(doc: string): DocstringTypes {
  const params = new Map<string, string>();
  let returnType: string | undefined;
  let section: "args" | "returns" | null = null;
  const addParam = (name: string, text: string): void => {
    if (name.startsWith("*")) return; // a splat binds a tuple / dict, not the type
    const accepted = acceptedType(text);
    if (accepted !== undefined && !params.has(name)) params.set(name, accepted);
  };
  for (const line of doc.split(/\r?\n/)) {
    const sphinxParam = SPHINX_TYPE.exec(line);
    if (sphinxParam !== null) {
      addParam(sphinxParam[1], sphinxParam[2]);
      continue;
    }
    const sphinxReturn = SPHINX_RTYPE.exec(line);
    if (sphinxReturn !== null) {
      returnType ??= acceptedType(sphinxReturn[1]);
      continue;
    }
    if (GOOGLE_ARGS_HEADER.test(line)) {
      section = "args";
      continue;
    }
    if (GOOGLE_RETURNS_HEADER.test(line)) {
      section = "returns";
      continue;
    }
    if (GOOGLE_ANY_HEADER.test(line)) {
      section = null;
      continue;
    }
    if (section === "args") {
      const entry = GOOGLE_ARG_ENTRY.exec(line);
      if (entry !== null) addParam(entry[1], entry[2]);
      continue;
    }
    if (section === "returns") {
      const entry = GOOGLE_RETURN_ENTRY.exec(line);
      // The FIRST non-blank line of `Returns:` carries the type; the rest is prose.
      if (entry !== null) {
        returnType ??= acceptedType(entry[1]);
        section = null;
      } else if (line.trim().length > 0) {
        section = null;
      }
    }
  }
  return { params, returnType };
}

/** Parameter names the signature leaves untyped — `self` / `cls` never bind. */
function unannotatedParameterNames(fn: AstNode): Set<string> {
  const out = new Set<string>();
  const params = fn.childForFieldName("parameters");
  if (params === null) return out;
  for (const param of params.namedChildren) {
    if (param.type === "identifier") out.add(param.text);
    else if (param.type === "default_parameter") {
      const name = param.childForFieldName("name");
      if (name !== null && name.type === "identifier") out.add(name.text);
    }
  }
  out.delete("self");
  out.delete("cls");
  return out;
}

function extractPythonDocstringFacts(input: PythonTypeSourceInput): TypeFact[] {
  const facts: TypeFact[] = [];
  walkPythonScopes(input.root, {
    onDef: (site) => {
      const needsReturn = site.node.childForFieldName("return_type") === null;
      const openParams = input.trackLocalTypes ? unannotatedParameterNames(site.node) : new Set<string>();
      if (!needsReturn && openParams.size === 0) return;
      const doc = pythonDocstringText(site.node);
      if (doc === undefined) return;
      const parsed = parseDocstringTypes(doc);
      const selfClass = site.classChain[site.classChain.length - 1];
      for (const [name, text] of parsed.params) {
        if (!openParams.has(name)) continue;
        const ref = pythonTypeRefFromText(text, selfClass);
        if (ref === undefined || pythonNominalReceiverName(ref) === undefined) continue;
        facts.push({
          kind: "param",
          source: PYTHON_DOCSTRING_SOURCE,
          symbolScope: [...site.classChain],
          methodName: site.name,
          name,
          line: site.line,
          type: ref,
        });
      }
      if (!needsReturn || parsed.returnType === undefined) return;
      const ref = pythonTypeRefFromText(parsed.returnType, selfClass);
      if (ref === undefined || ref.form === "nil") return;
      const fact: TypeFact = {
        kind: "return",
        source: PYTHON_DOCSTRING_SOURCE,
        symbolScope: [...site.classChain],
        methodName: site.name,
        type: ref,
      };
      if (isPythonClassFormDef(site.decorators)) fact.classForm = true;
      facts.push(fact);
    },
  });
  return facts;
}

export const pythonDocstringTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_DOCSTRING_SOURCE,
  extract: extractPythonDocstringFacts,
};
