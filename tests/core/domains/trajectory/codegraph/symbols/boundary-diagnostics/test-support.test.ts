/**
 * Test support derived from the import relation (bd tea-rags-mcp-89k7k.35.3):
 * a walked file every importer of which is a test file or test support is
 * itself test support, whatever its name — `X.spec.presets.tsx`, a helper
 * under `specs/`, a fixture builder. The codegraph never walks test files (nor
 * generated or policy-excluded ones), so their imports arrive as payload
 * specifiers resolved against the walked files.
 */
import { describe, expect, it } from "vitest";

import type { FileDependencyGraph } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  classifyTestSupportFiles,
  resolveUnwalkedImportEdges,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(sourceRelPath: string, targetRelPath: string) {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

function testImport(sourceRelPath: string, targetRelPath: string) {
  return { sourceRelPath, targetRelPath, sourceIsTest: true };
}

function generatedImport(sourceRelPath: string, targetRelPath: string) {
  return { sourceRelPath, targetRelPath, sourceIsTest: false };
}

function testFile(...specifiers: string[]) {
  return { isTest: true, specifiers };
}

const MODAL = "app/modal/Modal.tsx";
const PRESETS = "app/modal/specs/Modal.spec.presets.tsx";
const SPEC = "app/modal/specs/Modal.spec.tsx";
const FACADE = "app/modal/public/Modal.ts";

describe("classifyTestSupportFiles", () => {
  it("names a file imported only by a test as test support, and leaves the production file it imports alone", () => {
    const graph: FileDependencyGraph = {
      files: [file(FACADE), file(MODAL), file(PRESETS)],
      edges: [edge(FACADE, MODAL), edge(PRESETS, MODAL)],
    };

    const support = classifyTestSupportFiles(graph, [testImport(SPEC, PRESETS), testImport(SPEC, MODAL)]);

    expect([...support]).toEqual([PRESETS]);
  });

  it("names a file only tests and their support import as test support, whatever it is named", () => {
    // The rule reads the import relation alone: a component no production
    // file imports is indistinguishable from a fixture.
    const graph: FileDependencyGraph = { files: [file(MODAL), file(PRESETS)], edges: [edge(PRESETS, MODAL)] };

    const support = classifyTestSupportFiles(graph, [testImport(SPEC, PRESETS)]);

    expect([...support].sort()).toEqual([MODAL, PRESETS]);
  });

  it("follows a helper chain: support imported only by support imported only by a test", () => {
    const builder = "app/modal/specs/builders/modalBuilder.ts";
    const graph: FileDependencyGraph = {
      files: [file(FACADE), file(MODAL), file(PRESETS), file(builder)],
      edges: [edge(FACADE, MODAL), edge(PRESETS, builder), edge(builder, MODAL), edge(PRESETS, MODAL)],
    };

    const support = classifyTestSupportFiles(graph, [testImport(SPEC, PRESETS)]);

    expect([...support].sort()).toEqual([builder, PRESETS].sort());
  });

  it("keeps a file imported by both a test and production code in production", () => {
    const page = "app/pages/Page.tsx";
    const shared = "app/modal/useModal.ts";
    const graph: FileDependencyGraph = {
      files: [file(page), file(shared), file(MODAL)],
      edges: [edge(page, shared), edge(shared, MODAL), edge(page, MODAL)],
    };

    const support = classifyTestSupportFiles(graph, [testImport(SPEC, shared)]);

    expect(support.size).toBe(0);
  });

  it("keeps an entry point nothing imports in production", () => {
    const main = "app/main.tsx";
    const graph: FileDependencyGraph = { files: [file(main), file(MODAL)], edges: [edge(main, MODAL)] };

    const support = classifyTestSupportFiles(graph, []);

    expect(support.size).toBe(0);
  });

  it("keeps a support chain in production once one link is also imported by production code", () => {
    const builder = "app/modal/specs/builders/modalBuilder.ts";
    const page = "app/pages/Page.tsx";
    const graph: FileDependencyGraph = {
      files: [file(PRESETS), file(builder), file(page)],
      edges: [edge(PRESETS, builder), edge(page, builder)],
    };

    const support = classifyTestSupportFiles(graph, [testImport(SPEC, PRESETS)]);

    expect([...support]).toEqual([PRESETS]);
  });

  it("names a cycle of helpers reached from a test as test support", () => {
    const a = "app/specs/helperA.ts";
    const b = "app/specs/helperB.ts";
    const graph: FileDependencyGraph = { files: [file(a), file(b)], edges: [edge(a, b), edge(b, a)] };

    const support = classifyTestSupportFiles(graph, [testImport(SPEC, a)]);

    expect([...support].sort()).toEqual([a, b]);
  });

  it("keeps a cycle no test reaches in production — importers alone do not ground it", () => {
    const main = "app/main.ts";
    const app = "app/app.ts";
    const graph: FileDependencyGraph = { files: [file(main), file(app)], edges: [edge(main, app), edge(app, main)] };

    const support = classifyTestSupportFiles(graph, []);

    expect(support.size).toBe(0);
  });

  it("keeps a file reached by a test through support but also imported by an ungrounded cycle in production", () => {
    const main = "app/main.ts";
    const app = "app/app.ts";
    const graph: FileDependencyGraph = {
      files: [file(main), file(app), file(PRESETS), file(MODAL)],
      edges: [edge(main, app), edge(app, main), edge(app, MODAL), edge(PRESETS, MODAL)],
    };

    const support = classifyTestSupportFiles(graph, [testImport(SPEC, PRESETS)]);

    expect([...support]).toEqual([PRESETS]);
  });

  it("ignores a self-edge when reading a file's importers", () => {
    const graph: FileDependencyGraph = { files: [file(PRESETS)], edges: [edge(PRESETS, PRESETS)] };

    expect([...classifyTestSupportFiles(graph, [testImport(SPEC, PRESETS)])]).toEqual([PRESETS]);
    expect(classifyTestSupportFiles(graph, []).size).toBe(0);
  });

  it("counts an unwalked importer that is not a test — a generated client, say — as production", () => {
    const helper = "app/api/helpers/getNextPageParam.ts";
    const graph: FileDependencyGraph = { files: [file(helper)], edges: [] };

    const support = classifyTestSupportFiles(graph, [
      testImport("app/api/helpers/getNextPageParam.test.ts", helper),
      generatedImport("app/api/__generated__/hooks/useThings.ts", helper),
    ]);

    expect(support.size).toBe(0);
  });
});

describe("resolveUnwalkedImportEdges", () => {
  const ALIASED = "app/javascript/react-app/modal/specs/Modal.spec.presets.tsx";
  const files = [ALIASED, MODAL, PRESETS, "app/modal/index.ts", "lib/util.ts", "other/lib/util.ts", "src/core/a.ts"];

  it("resolves a relative specifier against the test file's directory, with or without an extension", () => {
    const edges = resolveUnwalkedImportEdges(
      new Map([
        [SPEC, testFile("./Modal.spec.presets", "../Modal")],
        ["tests/core/a.test.ts", testFile("../../src/core/a.js")],
      ]),
      files,
    );

    expect(edges).toEqual([
      testImport(SPEC, PRESETS),
      testImport(SPEC, MODAL),
      testImport("tests/core/a.test.ts", "src/core/a.ts"),
    ]);
  });

  it("resolves a non-relative path specifier by its unique path suffix, including a directory's index", () => {
    const edges = resolveUnwalkedImportEdges(
      new Map([[SPEC, testFile("react-app/modal/specs/Modal.spec.presets", "modal")]]),
      files,
    );

    expect(edges).toEqual([testImport(SPEC, ALIASED)]);
  });

  it("resolves a directory specifier to its index file", () => {
    expect(resolveUnwalkedImportEdges(new Map([[SPEC, testFile("app/modal")]]), files)).toEqual([
      testImport(SPEC, "app/modal/index.ts"),
    ]);
  });

  it("drops a bare package name, a specifier escaping the repo root, and an ambiguous suffix", () => {
    const edges = resolveUnwalkedImportEdges(
      new Map([[SPEC, testFile("react", "@scope/pkg/x", "../../../../outside", "lib/util")]]),
      files,
    );

    expect(edges).toEqual([]);
  });

  it("marks a non-test importer's edges as production, and skips a walked importer — the graph owns its edges", () => {
    const edges = resolveUnwalkedImportEdges(
      new Map([
        ["app/__generated__/client.ts", { isTest: false, specifiers: ["../modal/Modal"] }],
        [PRESETS, testFile("../Modal")],
      ]),
      files,
    );

    expect(edges).toEqual([generatedImport("app/__generated__/client.ts", MODAL)]);
  });
});
