import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(GoLang as unknown as Parser.Language);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the facet is exercised where production runs it. */
function fieldsOf(src: string, relPath = "gin.go") {
  return new GoLanguage().walker.walk({ tree: parse(src), code: src, relPath, language: "go", chunks: [] })
    .classFieldTypesByClassKey;
}

// bd tea-rags-mcp-e6xx — struct field facts. gin's `Engine` embeds
// `RouterGroup`, so `engine.GET(...)` / `engine.combineHandlers(...)` dispatch
// to `RouterGroup#GET` / `RouterGroup#combineHandlers` through Go's method
// promotion, and `c.writermem.reset(w)` types its receiver through the named
// field `writermem responseWriter`. The walker records every top-level struct's
// fields under the run-global `<relPath>::<Type>` class key; an EMBEDDED field
// is recorded twice — under its implicit field name (the type's bare name, so
// `engine.RouterGroup.X` still reads as a field) and under an `embedded:` key
// no Go identifier can spell, which is what marks it as a promotion source.
describe("Go walker — struct field types (classFieldTypesByClassKey)", () => {
  it("records named fields and marks embedded ones, pointers and generics unwrapped", () => {
    const src = [
      "package gin",
      "type Engine struct {",
      "\tRouterGroup",
      "\t*Box[int]",
      "\tpool  sync.Pool",
      "\ta, b  *Context",
      '\ttrees methodTrees `json:"trees"`',
      "}",
      "",
    ].join("\n");
    expect(fieldsOf(src)).toEqual({
      "gin.go::Engine": {
        RouterGroup: "RouterGroup",
        "embedded:RouterGroup": "RouterGroup",
        Box: "Box",
        "embedded:Box": "Box",
        pool: "sync.Pool",
        a: "Context",
        b: "Context",
        trees: "methodTrees",
      },
    });
  });

  it("keeps a package-qualified type qualified, embedded or named", () => {
    const src = ["package gin", "type Guarded struct {", "\t*sync.Mutex", "\treq *http.Request", "}", ""].join("\n");
    expect(fieldsOf(src)).toEqual({
      "gin.go::Guarded": { Mutex: "sync.Mutex", "embedded:Mutex": "sync.Mutex", req: "http.Request" },
    });
  });

  it("records a field whose type names no single type with an EMPTY type, so it still shadows", () => {
    // `Keys map[any]any` is a real field: a promoted `Keys` from an embedded
    // struct must not be selected past it. The empty string says "a field of
    // this name exists, its type is not nominal".
    const src = [
      "package gin",
      "type Context struct {",
      "\tKeys     map[any]any",
      "\thandlers []HandlerFunc",
      "}",
      "",
    ].join("\n");
    expect(fieldsOf(src)).toEqual({ "gin.go::Context": { Keys: "", handlers: "" } });
  });

  it("emits an EMPTY map for a field-less struct, so its method set reads as complete", () => {
    const src = ["package gin", "type Empty struct{}", ""].join("\n");
    expect(fieldsOf(src)).toEqual({ "gin.go::Empty": {} });
  });

  it("covers every spec of a grouped type declaration and skips non-struct types", () => {
    const src = [
      "package gin",
      "type (",
      "\tA struct { b B }",
      "\tB struct{}",
      "\tHandlersChain []HandlerFunc",
      "\tIRoutes interface { Use() }",
      "\tAlias = A",
      ")",
      "",
    ].join("\n");
    expect(fieldsOf(src)).toEqual({ "gin.go::A": { b: "B" }, "gin.go::B": {} });
  });

  it("ignores a struct declared inside a function body (not a symbol, not addressable)", () => {
    const src = ["package gin", "func f() {", "\ttype local struct { x X }", "}", ""].join("\n");
    expect(fieldsOf(src)).toBeUndefined();
  });

  it("tolerates a broken struct body without throwing", () => {
    const src = ["package gin", "type Broken struct {", "\tRouterGroup", "\tpool sync.", ""].join("\n");
    expect(() => fieldsOf(src)).not.toThrow();
  });
});
