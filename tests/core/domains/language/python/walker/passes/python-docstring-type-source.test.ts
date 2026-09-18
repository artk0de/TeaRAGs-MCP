/**
 * The `docstring` type source — Google `Args:` / `Returns:` and Sphinx
 * `:type:` / `:rtype:` (E2 seam 2, bd tea-rags-mcp-9fgdi).
 *
 * The negative rows carry as much weight as the positive ones. Two dialects are
 * in scope because two are what the corpora carry; numpydoc must stay silent
 * rather than half-parse. And the disjointness gate — no fact for an annotated
 * parameter, none for a def that already declares `return_type` — is what keeps
 * this source from ever racing the `annotations` source in production.
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../../src/core/contracts/types/ast.js";
import type { TypeFact } from "../../../../../../../src/core/domains/language/kernel/type-facts.js";
import {
  PYTHON_DOCSTRING_SOURCE,
  pythonDocstringText,
  pythonDocstringTypeSource,
} from "../../../../../../../src/core/domains/language/python/walker/passes/python-docstring-type-source.js";
import { materializeTree } from "../../../../../../../src/core/infra/materialize.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return materializeTree(parser.parse(src).rootNode, src);
}

function facts(src: string, trackLocalTypes = true): TypeFact[] {
  return pythonDocstringTypeSource.extract({ root: parse(src), trackLocalTypes });
}

const GOOGLE_PARAM = `def f(req):\n    """Do it.\n\n    Args:\n        req (Request): the request\n    """\n    pass\n`;

describe("pythonDocstringTypeSource — Google dialect", () => {
  it("files a param fact for an un-annotated parameter documented in Args:", () => {
    expect(facts(GOOGLE_PARAM)).toEqual([
      {
        kind: "param",
        source: PYTHON_DOCSTRING_SOURCE,
        symbolScope: [],
        methodName: "f",
        name: "req",
        line: 1,
        type: { form: "instance", name: "Request" },
      },
    ]);
  });

  it("stays silent when the parameter already carries an annotation", () => {
    expect(facts(GOOGLE_PARAM.replace("def f(req):", "def f(req: Request):"))).toEqual([]);
  });

  it("files a return fact from the first line of Returns:", () => {
    const out = facts(`def f():\n    """Open it.\n\n    Returns:\n        Session: the session\n    """\n    pass\n`);
    expect(out).toEqual([
      {
        kind: "return",
        source: PYTHON_DOCSTRING_SOURCE,
        symbolScope: [],
        methodName: "f",
        type: { form: "instance", name: "Session" },
      },
    ]);
  });

  it("stays silent when the def already declares a return annotation", () => {
    const src = `def f() -> Session:\n    """Open it.\n\n    Returns:\n        Session: the session\n    """\n    pass\n`;
    expect(facts(src)).toEqual([]);
  });

  it("declines a Returns: body that is prose rather than a type token", () => {
    const src = `def f():\n    """Open it.\n\n    Returns:\n        The open session, if any.\n    """\n    pass\n`;
    expect(facts(src)).toEqual([]);
  });

  it("declines a container type — the single-arm gate rejects the flattened element", () => {
    const src = `def f(xs):\n    """Do it.\n\n    Args:\n        xs (list[Foo]): the items\n    """\n    pass\n`;
    expect(facts(src)).toEqual([]);
  });

  it("never binds self or cls, however they are documented", () => {
    const src = `class C:\n    def m(self):\n        """Do it.\n\n        Args:\n            self (Foo): the receiver\n        """\n        pass\n`;
    expect(facts(src)).toEqual([]);
  });

  it("carries the enclosing class chain and the classmethod form on a decorated def", () => {
    const src = `class C:\n    @classmethod\n    def build(cls):\n        """Build.\n\n        Returns:\n            C: the built value\n        """\n        pass\n`;
    expect(facts(src)).toEqual([
      {
        kind: "return",
        source: PYTHON_DOCSTRING_SOURCE,
        symbolScope: ["C"],
        methodName: "build",
        classForm: true,
        type: { form: "instance", name: "C" },
      },
    ]);
  });
});

describe("pythonDocstringTypeSource — Sphinx dialect", () => {
  it("reads :type: and :rtype: off one docstring", () => {
    const src = `def f(req):\n    """Do it.\n\n    :type req: Request\n    :rtype: Session\n    """\n    pass\n`;
    expect(facts(src)).toEqual([
      {
        kind: "param",
        source: PYTHON_DOCSTRING_SOURCE,
        symbolScope: [],
        methodName: "f",
        name: "req",
        line: 1,
        type: { form: "instance", name: "Request" },
      },
      {
        kind: "return",
        source: PYTHON_DOCSTRING_SOURCE,
        symbolScope: [],
        methodName: "f",
        type: { form: "instance", name: "Session" },
      },
    ]);
  });

  it("collapses Optional[...] to its one reachable arm", () => {
    const src = `def f(req):\n    """Do it.\n\n    :type req: Optional[Request]\n    """\n    pass\n`;
    expect(facts(src)).toEqual([
      expect.objectContaining({
        kind: "param",
        name: "req",
        type: { form: "union", members: [{ form: "instance", name: "Request" }, { form: "nil" }] },
      }),
    ]);
  });
});

describe("pythonDocstringTypeSource — out of scope and empty", () => {
  it("files nothing for numpydoc", () => {
    const src = `def f(req):\n    """Do it.\n\n    Parameters\n    ----------\n    req : Request\n    """\n    pass\n`;
    expect(facts(src)).toEqual([]);
  });

  it("files no param fact when local type tracking is off, but still files the return", () => {
    const src = `def f(req):\n    """Do it.\n\n    :type req: Request\n    :rtype: Session\n    """\n    pass\n`;
    expect(facts(src, false)).toEqual([expect.objectContaining({ kind: "return", methodName: "f" })]);
  });

  it("files nothing for a def with no docstring", () => {
    expect(facts(`def f(req):\n    pass\n`)).toEqual([]);
  });
});

describe("pythonDocstringText", () => {
  function defNode(src: string): AstNode {
    const node = parse(src).namedChild(0);
    if (node === null) throw new Error("no def parsed");
    return node;
  }

  it("strips the triple quotes and returns the body", () => {
    expect(pythonDocstringText(defNode(`def f():\n    """Do it."""\n`))).toBe("Do it.");
  });

  it("strips a prefixed raw string's quotes too", () => {
    expect(pythonDocstringText(defNode(`def f():\n    r"""Do \\it."""\n`))).toBe("Do \\it.");
  });

  it("returns undefined when the def has no docstring", () => {
    expect(pythonDocstringText(defNode(`def f():\n    pass\n`))).toBeUndefined();
  });
});
