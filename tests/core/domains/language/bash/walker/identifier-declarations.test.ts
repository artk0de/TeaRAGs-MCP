import Parser from "tree-sitter";
import BashLang from "tree-sitter-bash";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { BashLanguage } from "../../../../../../src/core/domains/language/bash/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(BashLang);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function extractionOf(src: string, chunks: WalkInput["chunks"]) {
  return new BashLanguage().walker.walk({
    tree: parse(src),
    code: src,
    relPath: "deploy.sh",
    language: "bash",
    chunks,
  });
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return extractionOf(src, chunks).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.6 — the naming lexicon's syntactic half for Bash.
describe("Bash walker — identifier declarations", () => {
  it("records a function's assignments, declaration builtins and loop variables, untyped", () => {
    const src = [
      "TOP=1",
      "deploy() {",
      '  local target="$1" count',
      "  declare -a items=(a b)",
      "  readonly mode=fast",
      "  name=value",
      "  name=other",
      "  export PATH_X=1",
      "  export HOME",
      "  arr[1]=x",
      '  for f in *.txt; do echo "$f"; done',
      "}",
    ].join("\n");
    const chunks = [
      { symbolId: "TOP", startLine: 1, endLine: 1, scope: [] },
      { symbolId: "deploy", startLine: 2, endLine: 12, scope: [] },
    ];
    const owner = { ownerSymbolId: "deploy" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "target", kind: "local", line: 3, ...owner },
      { name: "count", kind: "local", line: 3, ...owner },
      { name: "items", kind: "local", line: 4, ...owner },
      { name: "mode", kind: "local", line: 5, ...owner },
      { name: "name", kind: "local", line: 6, ...owner },
      { name: "PATH_X", kind: "local", line: 8, ...owner },
      { name: "f", kind: "local", line: 11, ...owner },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.16 — the row builder finds the CallRef by (startLine, member, receiver).
  it("binds a local / field to the outermost call, as the CallRef the walker emits on that line", () => {
    const code = [
      "g() { echo x; }",
      "f() {",
      "  a=$(g arg)",
      '  local b="$(g)"',
      "  c=$(date +%s)",
      "  d=$(g | tr a b)",
      "  e=plain",
      "}",
    ].join("\n");
    const extraction = extractionOf(code, [
      { symbolId: "g", startLine: 1, endLine: 1, scope: [] },
      { symbolId: "f", startLine: 2, endLine: 8, scope: [] },
    ]);
    const bound = Object.fromEntries((extraction.identifierDeclarations ?? []).map((d) => [d.name, d.boundCallee]));
    expect(bound).toEqual({
      a: { member: "g" },
      b: { member: "g" },
      // An external binary is no call edge; a pipeline has no single callee.
      c: undefined,
      d: undefined,
      e: undefined,
    });
    for (const declaration of extraction.identifierDeclarations ?? []) {
      if (declaration.boundCallee === undefined) continue;
      const onLine = extraction.chunks
        .flatMap((chunk) => chunk.calls)
        .filter((call) => call.startLine === declaration.line)
        .map((call) =>
          call.receiver === null ? { member: call.member } : { member: call.member, receiver: call.receiver },
        );
      expect(onLine).toContainEqual(declaration.boundCallee);
    }
  });
});
