/**
 * Method-body field facts for the two RHS shapes that are not a bare
 * constructor (bd tea-rags-mcp-w205u, E4.6c).
 *
 * Two channels come out of one scan. A guarded FALLBACK form still names a
 * class, so `param or Default()` and `A(x) if p else A(y)` feed the existing
 * type channels. A field assigned from a CALL names no class at all, and the
 * walker cannot know what the callee returns — so the callee SPELLING goes into
 * `classFieldCallResults` for the resolver to fold, which is the same division
 * of labour `callResultBindings` already has for a single-identifier target.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src);
}

function native(lines: readonly string[], relPath = "app/svc.py"): FileExtraction {
  const src = lines.join("\n");
  return extractFromPythonFile({ tree: parse(src), code: src, relPath, language: "python", chunks: [] });
}

/** `class C:` with an `__init__` whose body is `lines`, indented for it. */
function inInit(...lines: readonly string[]): FileExtraction {
  return native(["class C:", "    def __init__(self, ts, params, provider):", ...lines.map((l) => `        ${l}`)]);
}

describe("a guarded fallback RHS still names a class", () => {
  it("types a field from the RIGHT operand of `or` — the `param or Default()` idiom", () => {
    // ugnest: `self._tokens = token_service or ResolveTokenService()`.
    const out = inInit("self._tokens = ts or ResolveTokenService()");
    expect(out.classFieldTypes).toEqual({ C: { _tokens: "ResolveTokenService" } });
    expect(out.classFieldTypesByClassKey).toEqual({ "app/svc.py::C": { _tokens: "ResolveTokenService" } });
  });

  it("types a field from a ternary whose two arms construct the SAME class", () => {
    // httpx: `self.url = URL(url) if params is None else URL(url, params=params)`.
    const out = inInit("self.url = URL(url) if params is None else URL(url, params=params)");
    expect(out.classFieldTypes).toEqual({ C: { url: "URL" } });
  });

  it("declines `a or b` — neither side is a call, so nothing names a class", () => {
    expect(inInit("self.x = ts or params").classFieldTypes).toBeUndefined();
  });

  it("declines `A() or B()` — two constructors is a union, and the engine never widens", () => {
    expect(inInit("self.x = Alpha() or Beta()").classFieldTypes).toBeUndefined();
  });

  it("declines a ternary whose arms construct DIFFERENT classes", () => {
    expect(inInit("self.x = Alpha(1) if ts else Beta(2)").classFieldTypes).toBeUndefined();
  });
});

describe("classFieldCallResults — a field assigned from a CALL", () => {
  it("records a classmethod spelling under the run-global class key", () => {
    // polar: `self.payment_repo = PaymentRepository.from_session(session)`.
    const out = inInit("self.repo = PaymentRepository.from_session(ts)");
    expect(out.classFieldCallResults).toEqual({ "app/svc.py::C": { repo: "PaymentRepository.from_session" } });
    expect(out.classFieldTypes).toBeUndefined();
  });

  it("records a bare function callee", () => {
    expect(inInit("self.f = make_thing()").classFieldCallResults).toEqual({ "app/svc.py::C": { f: "make_thing" } });
  });

  it("records a `self.<method>()` callee verbatim — the receiver IS the class being walked", () => {
    // httpx: `self._transport = self._init_transport(...)`.
    expect(inInit("self._transport = self._init_transport(ts)").classFieldCallResults).toEqual({
      "app/svc.py::C": { _transport: "self._init_transport" },
    });
  });

  it("records the RIGHT operand of an `or` when that operand is the call", () => {
    // ugnest: `self._provider = provider or get_geo_provider()`.
    expect(inInit("self._provider = provider or get_geo_provider()").classFieldCallResults).toEqual({
      "app/svc.py::C": { _provider: "get_geo_provider" },
    });
  });

  it("does NOT record a field that already has a TYPE fact — the type is the better answer", () => {
    const out = inInit("self.client = SlackClient()");
    expect(out.classFieldTypes).toEqual({ C: { client: "SlackClient" } });
    expect(out.classFieldCallResults).toBeUndefined();
  });

  it("does not record a field the class also TYPES in another method", () => {
    const out = native([
      "class C:",
      "    def __init__(self):",
      "        self.repo = make_repo()",
      "    def reset(self):",
      "        self.repo = Repository()",
    ]);
    expect(out.classFieldTypes).toEqual({ C: { repo: "Repository" } });
    expect(out.classFieldCallResults).toBeUndefined();
  });

  it("DROPS a field two methods assign from DIFFERENT callees — a conflict is not a fact", () => {
    const out = native([
      "class C:",
      "    def __init__(self):",
      "        self.repo = make_repo()",
      "    def reset(self):",
      "        self.repo = other_repo()",
    ]);
    expect(out.classFieldCallResults).toBeUndefined();
  });

  it("keeps a field two methods assign from the SAME callee", () => {
    const out = native([
      "class C:",
      "    def __init__(self):",
      "        self.repo = make_repo()",
      "    def reset(self):",
      "        self.repo = make_repo()",
    ]);
    expect(out.classFieldCallResults).toEqual({ "app/svc.py::C": { repo: "make_repo" } });
  });

  it("stays silent on a non-call RHS and on a subscripted callee", () => {
    expect(inInit("self.x = []").classFieldCallResults).toBeUndefined();
    expect(inInit("self.x = handlers[0]()").classFieldCallResults).toBeUndefined();
  });

  it("attributes to the INNERMOST enclosing class, like every other class-key channel", () => {
    const out = native([
      "class Outer:",
      "    class Inner:",
      "        def __init__(self):",
      "            self.f = make_thing()",
    ]);
    expect(out.classFieldCallResults).toEqual({ "app/svc.py::Outer.Inner": { f: "make_thing" } });
  });

  it("emits no channel at all for a file with no such field", () => {
    expect(native(["def top():", "    return 1"]).classFieldCallResults).toBeUndefined();
  });
});
