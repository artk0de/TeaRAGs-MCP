import Parser from "tree-sitter";
import JavaLang from "tree-sitter-java";
import { describe, expect, it } from "vitest";

import { extractFromJavaFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/java-walker.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(JavaLang as unknown as Parser.Language);
  return p.parse(src);
}

describe("extractFromJavaFile — imports", () => {
  it("captures `import com.foo.Bar;`", () => {
    const src = "import com.foo.Bar;\nclass X {}\n";
    const r = extractFromJavaFile({ tree: parse(src), code: src, relPath: "X.java", language: "java", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["com.foo.Bar"]);
  });

  it("captures wildcard `import com.foo.*;`", () => {
    const src = "import com.foo.*;\nclass X {}\n";
    const r = extractFromJavaFile({ tree: parse(src), code: src, relPath: "X.java", language: "java", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["com.foo.*"]);
  });

  it("captures `import static com.foo.Bar.method;`", () => {
    const src = "import static com.foo.Bar.method;\nclass X {}\n";
    const r = extractFromJavaFile({ tree: parse(src), code: src, relPath: "X.java", language: "java", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["com.foo.Bar.method"]);
  });

  it("captures multiple imports", () => {
    const src = "import com.a.A;\nimport com.b.B;\nclass X {}\n";
    const r = extractFromJavaFile({ tree: parse(src), code: src, relPath: "X.java", language: "java", chunks: [] });
    expect(r.imports.map((i) => i.importText).sort()).toEqual(["com.a.A", "com.b.B"]);
  });
});

describe("extractFromJavaFile — calls", () => {
  it("captures `obj.method()`", () => {
    const src = "class X { void go() { obj.method(); } }\n";
    const r = extractFromJavaFile({
      tree: parse(src),
      code: src,
      relPath: "X.java",
      language: "java",
      chunks: [{ symbolId: "X.go", scope: ["X"], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBe("obj");
    expect(c.member).toBe("method");
  });

  it("captures bare method calls", () => {
    const src = "class X { void go() { doThing(); } }\n";
    const r = extractFromJavaFile({
      tree: parse(src),
      code: src,
      relPath: "X.java",
      language: "java",
      chunks: [{ symbolId: "X.go", scope: ["X"], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBeNull();
    expect(c.member).toBe("doThing");
  });
});

describe("extractFromJavaFile — edge cases", () => {
  it("empty file returns empty extraction", () => {
    const r = extractFromJavaFile({ tree: parse(""), code: "", relPath: "x.java", language: "java", chunks: [] });
    expect(r.imports).toEqual([]);
  });

  it("ignores comments", () => {
    const src = "// import com.fake.X;\nimport com.real.Y;\nclass X {}\n";
    const r = extractFromJavaFile({ tree: parse(src), code: src, relPath: "X.java", language: "java", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["com.real.Y"]);
  });
});

// Co-locates wildcard, static, and plain imports so the walker's strip
// regex (handling both `static` and bare forms) is exercised in the same
// extraction. Also pins startLine accuracy across mixed forms.
describe("extractFromJavaFile — mixed import forms", () => {
  it("captures wildcard + static + plain imports together with correct lines", () => {
    const src = ["import com.a.*;", "import static com.b.B.helper;", "import com.c.C;", "class X {}", ""].join("\n");
    const r = extractFromJavaFile({ tree: parse(src), code: src, relPath: "X.java", language: "java", chunks: [] });
    const map = new Map(r.imports.map((i) => [i.importText, i.startLine]));
    expect(map.get("com.a.*")).toBe(1);
    expect(map.get("com.b.B.helper")).toBe(2);
    expect(map.get("com.c.C")).toBe(3);
  });
});

// method_invocation with vs without `object` field — both shapes coexist
// in real Java; the walker must dispatch on `node.childForFieldName("object")`.
describe("extractFromJavaFile — call shapes coexisting", () => {
  it("captures both `obj.method()` and bare `helper()` in the same body", () => {
    const src = "class X {\n  void go() {\n    helper();\n    obj.method();\n  }\n}\n";
    const r = extractFromJavaFile({
      tree: parse(src),
      code: src,
      relPath: "X.java",
      language: "java",
      chunks: [{ symbolId: "X.go", scope: ["X"], startLine: 2, endLine: 5 }],
    });
    const { calls } = r.chunks[0];
    const helper = calls.find((c) => c.member === "helper");
    const method = calls.find((c) => c.member === "method");
    expect(helper?.receiver).toBeNull();
    expect(method?.receiver).toBe("obj");
  });
});
