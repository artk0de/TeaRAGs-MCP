import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";

/** JSX only parses under the `tsx` grammar — the one CODEGRAPH loads for `.tsx`. */
function parseTsx(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage((TsLang as { tsx: Parser.Language }).tsx);
  return parser.parse(code);
}

/** Every call the walker attached to the single whole-file chunk. */
function callsIn(code: string): CallRef[] {
  const tree = parseTsx(code);
  const lineCount = code.split("\n").length;
  const extraction = extractFromTypescriptFile({
    tree,
    code,
    relPath: "src/page.tsx",
    language: "typescript",
    chunks: [{ symbolId: "Page", startLine: 1, endLine: lineCount, scope: [] }],
  });
  return extraction.chunks[0]?.calls ?? [];
}

describe("TypeScript walker emits a call edge for each JSX component tag (bd tea-rags-mcp-b4pvp)", () => {
  it("emits a jsx call for a self-closing component element", () => {
    const calls = callsIn(`function Page() {\n  return <Button label="ok" />;\n}\n`);

    expect(calls).toEqual([
      { callText: '<Button label="ok" />', receiver: null, member: "Button", startLine: 2, jsx: true },
    ]);
  });

  it("emits a jsx call for a paired component element without double-counting the closing tag", () => {
    const calls = callsIn(`function Page() {\n  return <Card>text</Card>;\n}\n`);

    expect(calls).toEqual([{ callText: "<Card>", receiver: null, member: "Card", startLine: 2, jsx: true }]);
  });

  it("splits a qualified tag into receiver and member", () => {
    const calls = callsIn(`function Page() {\n  return <UI.Panel />;\n}\n`);

    expect(calls).toEqual([{ callText: "<UI.Panel />", receiver: "UI", member: "Panel", startLine: 2, jsx: true }]);
  });

  it("ignores lowercase intrinsic host elements", () => {
    const calls = callsIn(`function Page() {\n  return <div className="p"><span /></div>;\n}\n`);

    expect(calls).toEqual([]);
  });

  it("ignores a fragment, which names no component", () => {
    const calls = callsIn(`function Page() {\n  return <><Widget /></>;\n}\n`);

    expect(calls.map((c) => c.member)).toEqual(["Widget"]);
  });

  it("emits one call per component tag when several are nested", () => {
    const code = [
      `function Page() {`,
      `  return (`,
      `    <Layout>`,
      `      <Sidebar />`,
      `      <Content />`,
      `    </Layout>`,
      `  );`,
      `}`,
    ].join("\n");

    expect(callsIn(code).map((c) => `${c.member}@${c.startLine}`)).toEqual(["Layout@3", "Sidebar@4", "Content@5"]);
  });

  it("keeps ordinary calls unflagged so only JSX sites route to the JSX pass", () => {
    const calls = callsIn(`function Page() {\n  init();\n  return <Widget />;\n}\n`);

    expect(calls.map((c) => ({ member: c.member, jsx: c.jsx }))).toEqual([
      { member: "init", jsx: undefined },
      { member: "Widget", jsx: true },
    ]);
  });

  it("still emits calls made inside a component's props", () => {
    const calls = callsIn(`function Page() {\n  return <Widget value={compute()} />;\n}\n`);

    expect(calls.map((c) => c.member).sort()).toEqual(["Widget", "compute"]);
  });
});
