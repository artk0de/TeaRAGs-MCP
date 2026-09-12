/**
 * `NAME = <callee>(…)` sites the Python walker records for the resolver to fold
 * (E2 seam 5 / R1b, bd tea-rags-mcp-z68v9).
 *
 * The walker records the callee SPELLING only. Every judgement about what the
 * callee RETURNS belongs to the resolver, which is the one layer where another
 * file's `structuredReturnTypes` and the callee's MRO are both in scope.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { afterEach, describe, expect, it } from "vitest";

import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

/** One chunk covering the whole file, which is what every case but the attribution one wants. */
function bindingsOf(src: string, startLine = 1, endLine = 1000) {
  const tree = parse(src);
  const out = extractFromPythonFile({
    tree,
    code: src,
    relPath: "app/use.py",
    language: "python",
    chunks: [{ symbolId: "run", startLine, endLine, scope: [] }],
  });
  return out.chunks[0].callResultBindings;
}

afterEach(() => {
  delete process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING;
});

describe("extractFromPythonFile — callResultBindings", () => {
  it("records a dotted class-method callee", () => {
    const src = [
      "def run(session):",
      "    repository = SubscriptionRepository.from_session(session)",
      "    return repository",
      "",
    ].join("\n");
    expect(bindingsOf(src)).toEqual({ repository: [{ line: 2, callee: "SubscriptionRepository.from_session" }] });
  });

  it("records a bare callee", () => {
    const src = ["def run():", "    client = build_client()", ""].join("\n");
    expect(bindingsOf(src)).toEqual({ client: [{ line: 2, callee: "build_client" }] });
  });

  it("records a `self.<attr>.<member>` callee verbatim so the fold can chain it", () => {
    const src = ["class Svc:", "    def run(self):", "        thing = self.factory.build()", ""].join("\n");
    expect(bindingsOf(src)).toEqual({ thing: [{ line: 3, callee: "self.factory.build" }] });
  });

  it("unwraps `await <call>`", () => {
    const src = ["async def run(session):", "    repo = await Repo.load(session)", ""].join("\n");
    expect(bindingsOf(src)).toEqual({ repo: [{ line: 2, callee: "Repo.load" }] });
  });

  it("keeps every binding of one name, sorted by line", () => {
    const src = ["def run():", "    x = make_a()", "    x.run()", "    x = make_b()", ""].join("\n");
    expect(bindingsOf(src)).toEqual({
      x: [
        { line: 2, callee: "make_a" },
        { line: 4, callee: "make_b" },
      ],
    });
  });

  it("declines tuple unpacking — no single target to bind", () => {
    const src = ["def run():", "    a, b = split()", ""].join("\n");
    expect(bindingsOf(src)).toBeUndefined();
  });

  it("declines a chained callee — the spelling would have to be re-parsed", () => {
    const src = ["def run():", "    x = make().build()", ""].join("\n");
    expect(bindingsOf(src)).toBeUndefined();
  });

  // bd tea-rags-mcp-1v12o.4 — ugnest's dominant residual shape. The spine is
  // rendered from the AST with ARGUMENTS ELIDED, so it stays a foldable
  // receiver spelling rather than a slab of source text.
  it("records a chain ROOTED AT A NAME, with call arguments elided", () => {
    const src = ["def run(ticket_id):", "    ticket = Ticket.objects.select_for_update().get(id=ticket_id)", ""].join(
      "\n",
    );
    expect(bindingsOf(src)).toEqual({ ticket: [{ line: 2, callee: "Ticket.objects.select_for_update().get" }] });
  });

  it("elides a MULTI-LINE argument list rather than recording its text", () => {
    const src = [
      "def run(user_id):",
      "    existing = Reaction.objects.filter(",
      "        user_id=user_id,",
      "        target_type='post',",
      "    ).first()",
      "",
    ].join("\n");
    expect(bindingsOf(src)).toEqual({ existing: [{ line: 2, callee: "Reaction.objects.filter().first" }] });
  });

  it("declines a chain longer than the fold's hop cap", () => {
    const src = ["def run():", "    x = A.b().c().d().e().f()", ""].join("\n");
    expect(bindingsOf(src)).toBeUndefined();
  });

  it("declines a subscripted callee", () => {
    const src = ["def run(registry):", "    x = registry['a'].build()", ""].join("\n");
    expect(bindingsOf(src)).toBeUndefined();
  });

  it("declines a non-call RHS", () => {
    const src = ["def run():", "    x = 1", "    y = [1, 2]", ""].join("\n");
    expect(bindingsOf(src)).toBeUndefined();
  });

  it("declines a MODULE-level assignment — only a function body has locals", () => {
    const src = ["settings = load_settings()", ""].join("\n");
    expect(bindingsOf(src)).toBeUndefined();
  });

  it("records a binding inside a nested def", () => {
    const src = ["def outer():", "    def inner():", "        x = Repo.load()", ""].join("\n");
    expect(bindingsOf(src)).toEqual({ x: [{ line: 3, callee: "Repo.load" }] });
  });

  it("attributes a binding to the chunk whose line range contains it", () => {
    const src = ["def a():", "    x = make_a()", "", "def b():", "    y = make_b()", ""].join("\n");
    const tree = parse(src);
    const out = extractFromPythonFile({
      tree,
      code: src,
      relPath: "app/use.py",
      language: "python",
      chunks: [
        { symbolId: "a", startLine: 1, endLine: 2, scope: [] },
        { symbolId: "b", startLine: 4, endLine: 5, scope: [] },
      ],
    });
    expect(out.chunks[0].callResultBindings).toEqual({ x: [{ line: 2, callee: "make_a" }] });
    expect(out.chunks[1].callResultBindings).toEqual({ y: [{ line: 5, callee: "make_b" }] });
  });

  it("emits nothing when local type tracking is off", () => {
    process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING = "false";
    const src = ["def run():", "    x = make_a()", ""].join("\n");
    expect(bindingsOf(src)).toBeUndefined();
  });
});
