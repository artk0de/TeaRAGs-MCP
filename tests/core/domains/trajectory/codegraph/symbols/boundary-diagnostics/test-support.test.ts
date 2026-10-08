/**
 * Test support derived from the import relation (bd tea-rags-mcp-89k7k.35.3):
 * a walked file every importer of which is a test file or test support, AND
 * which carries positive evidence — it imports a test-only dependency (one
 * tests import and no production file does) or another test-support file — is
 * itself test support, whatever its name. The codegraph never walks test files
 * (nor generated or policy-excluded ones), so their imports arrive as payload
 * specifiers resolved against the indexed files.
 */
import { describe, expect, it } from "vitest";

import type { FileDependencyGraph } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  classifyTestSupportFiles,
  deriveTestOnlyDependencies,
  resolveExternalImports,
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

/** `sourceRelPath` imports `dependency` — a package, or a file the codegraph does not walk. */
function testUses(sourceRelPath: string, dependency: string) {
  return { sourceRelPath, dependency, sourceIsTest: true };
}

function uses(sourceRelPath: string, dependency: string) {
  return { sourceRelPath, dependency, sourceIsTest: false };
}

function testFile(...specifiers: string[]) {
  return { isTest: true, specifiers };
}

const MODAL = "app/modal/Modal.tsx";
const PRESETS = "app/modal/specs/Modal.spec.presets.tsx";
const SPEC = "app/modal/specs/Modal.spec.tsx";
const FACADE = "app/modal/public/Modal.ts";

/** The support files the classification names. */
function supportOf(...args: Parameters<typeof classifyTestSupportFiles>) {
  return classifyTestSupportFiles(...args).files;
}

/** The spec and its presets both import a mocking package no production file imports. */
const MSW = [testUses(SPEC, "msw"), uses(PRESETS, "msw")];

describe("classifyTestSupportFiles", () => {
  it("names a file imported only by a test and importing a test-only package as test support, and leaves the production file it imports alone", () => {
    const graph: FileDependencyGraph = {
      files: [file(FACADE), file(MODAL), file(PRESETS)],
      edges: [edge(FACADE, MODAL), edge(PRESETS, MODAL)],
    };

    const support = supportOf(graph, [testImport(SPEC, PRESETS), testImport(SPEC, MODAL)], MSW);

    expect([...support]).toEqual([PRESETS]);
  });

  it("keeps a file only tests and their support import in production when it carries no test-only import", () => {
    // Positive evidence (89k7k.35.3 owner decision): having no production
    // importer is shared by fixtures and by entry points loaded by module
    // path, so it alone never makes support.
    const graph: FileDependencyGraph = { files: [file(MODAL), file(PRESETS)], edges: [edge(PRESETS, MODAL)] };

    const support = supportOf(graph, [testImport(SPEC, PRESETS)], MSW);

    expect([...support]).toEqual([PRESETS]);
  });

  it("names a helper that imports only another test-support file as test support", () => {
    const builder = "app/modal/specs/builders/modalBuilder.ts";
    const graph: FileDependencyGraph = {
      files: [file(FACADE), file(MODAL), file(PRESETS), file(builder)],
      edges: [edge(FACADE, MODAL), edge(PRESETS, builder), edge(builder, MODAL), edge(PRESETS, MODAL)],
    };

    const support = supportOf(
      graph,
      [testImport(SPEC, PRESETS)],
      [testUses(SPEC, "@faker-js/faker"), uses(builder, "@faker-js/faker")],
    );

    expect([...support].sort()).toEqual([builder, PRESETS].sort());
  });

  it("keeps a worker imported only by a test in production when it imports only production modules and packages", () => {
    const worker = "src/chunker/infra/worker.ts";
    const pool = "src/chunker/pool.ts";
    const parser = "src/chunker/parser.ts";
    const graph: FileDependencyGraph = {
      files: [file(worker), file(pool), file(parser)],
      edges: [edge(worker, parser), edge(pool, parser)],
    };

    const support = supportOf(
      graph,
      [testImport("tests/chunker/worker.test.ts", worker)],
      [
        testUses("tests/chunker/worker.test.ts", "vitest"),
        uses(worker, "node:worker_threads"),
        uses(pool, "node:worker_threads"),
      ],
    );

    expect(support.size).toBe(0);
  });

  it("does not pull in the chain only a worker reaches when the chain imports production packages", () => {
    const worker = "src/chunker/infra/worker.ts";
    const treeSitter = "src/chunker/tree-sitter.ts";
    const base = "src/chunker/base.ts";
    const pool = "src/chunker/pool.ts";
    const main = "src/main.ts";
    const graph: FileDependencyGraph = {
      files: [file(worker), file(treeSitter), file(base), file(pool), file(main)],
      edges: [edge(worker, treeSitter), edge(treeSitter, base), edge(main, pool)],
    };

    const support = supportOf(
      graph,
      [testImport("tests/chunker/worker.test.ts", worker), testImport("tests/chunker/base.test.ts", base)],
      [
        testUses("tests/chunker/worker.test.ts", "vitest"),
        testUses("tests/chunker/base.test.ts", "web-tree-sitter"),
        uses(treeSitter, "web-tree-sitter"),
        uses(pool, "web-tree-sitter"),
      ],
    );

    expect(support.size).toBe(0);
  });

  it("keeps a file importing a package production also imports in production, though tests import it too", () => {
    const page = "app/pages/Page.tsx";
    const router = "app/router.tsx";
    const graph: FileDependencyGraph = {
      files: [file(PRESETS), file(page), file(router)],
      edges: [edge(router, page)],
    };

    const support = supportOf(
      graph,
      [testImport(SPEC, PRESETS)],
      [testUses(SPEC, "react"), uses(PRESETS, "react"), uses(page, "react")],
    );

    expect(support.size).toBe(0);
  });

  it("names a file importing an unwalked file only tests import as test support", () => {
    const mocks = "app/modal/specs/Modal.mocks.test.ts";

    const support = supportOf(
      { files: [file(PRESETS)], edges: [] },
      [testImport(SPEC, PRESETS)],
      [testUses(SPEC, mocks), uses(PRESETS, mocks)],
    );

    expect([...support]).toEqual([PRESETS]);
  });

  it("drops a dependency from the test-only set once a file importing it turns out production", () => {
    // P imports U, so U is production; V is then imported by production U
    // and is production too; V imports chokidar, so chokidar is not
    // test-only and W, whose only evidence it was, is production.
    const p = "src/p.ts";
    const u = "src/u.ts";
    const v = "src/v.ts";
    const w = "src/w.ts";
    const graph: FileDependencyGraph = {
      files: [file("src/main.ts"), file(p), file(u), file(v), file(w)],
      edges: [edge("src/main.ts", p), edge(p, u), edge(u, v)],
    };

    const support = supportOf(
      graph,
      [testImport(SPEC, u), testImport(SPEC, v), testImport(SPEC, w)],
      [testUses(SPEC, "chokidar"), uses(v, "chokidar"), uses(w, "chokidar")],
    );

    expect(support.size).toBe(0);
  });

  it("keeps a file imported by both a test and production code in production", () => {
    const page = "app/pages/Page.tsx";
    const shared = "app/modal/useModal.ts";
    const graph: FileDependencyGraph = {
      files: [file(page), file(shared), file(MODAL)],
      edges: [edge(page, shared), edge(shared, MODAL), edge(page, MODAL)],
    };

    const support = supportOf(graph, [testImport(SPEC, shared)], [testUses(SPEC, "msw"), uses(shared, "msw")]);

    expect(support.size).toBe(0);
  });

  it("keeps an entry point nothing imports in production", () => {
    const main = "app/main.tsx";
    const graph: FileDependencyGraph = { files: [file(main), file(MODAL)], edges: [edge(main, MODAL)] };

    const support = supportOf(graph, [], [testUses(SPEC, "msw"), uses(main, "msw")]);

    expect(support.size).toBe(0);
  });

  it("keeps a support chain in production once one link is also imported by production code", () => {
    const builder = "app/modal/specs/builders/modalBuilder.ts";
    const page = "app/pages/Page.tsx";
    const graph: FileDependencyGraph = {
      files: [file(PRESETS), file(builder), file(page)],
      edges: [edge(PRESETS, builder), edge(page, builder)],
    };

    const support = supportOf(graph, [testImport(SPEC, PRESETS)], MSW);

    expect([...support]).toEqual([PRESETS]);
  });

  it("names a cycle of helpers reached from a test as test support when one of them imports a test-only package", () => {
    const a = "app/specs/helperA.ts";
    const b = "app/specs/helperB.ts";
    const graph: FileDependencyGraph = { files: [file(a), file(b)], edges: [edge(a, b), edge(b, a)] };

    const support = supportOf(graph, [testImport(SPEC, a)], [testUses(SPEC, "msw"), uses(b, "msw")]);

    expect([...support].sort()).toEqual([a, b]);
  });

  it("keeps a cycle of helpers no test-only dependency grounds in production — a cycle is not evidence", () => {
    const a = "app/specs/helperA.ts";
    const b = "app/specs/helperB.ts";
    const graph: FileDependencyGraph = { files: [file(a), file(b)], edges: [edge(a, b), edge(b, a)] };

    expect(supportOf(graph, [testImport(SPEC, a)], [testUses(SPEC, "msw")]).size).toBe(0);
  });

  it("keeps a cycle no test reaches in production — importers alone do not ground it", () => {
    const main = "app/main.ts";
    const app = "app/app.ts";
    const graph: FileDependencyGraph = { files: [file(main), file(app)], edges: [edge(main, app), edge(app, main)] };

    const support = supportOf(graph, [], [testUses(SPEC, "msw"), uses(app, "msw")]);

    expect(support.size).toBe(0);
  });

  it("keeps a file reached by a test through support but also imported by an ungrounded cycle in production", () => {
    const main = "app/main.ts";
    const app = "app/app.ts";
    const graph: FileDependencyGraph = {
      files: [file(main), file(app), file(PRESETS), file(MODAL)],
      edges: [edge(main, app), edge(app, main), edge(app, MODAL), edge(PRESETS, MODAL)],
    };

    const support = supportOf(
      graph,
      [testImport(SPEC, PRESETS)],
      [...MSW, testUses(SPEC, "@testing-library/react"), uses(MODAL, "@testing-library/react")],
    );

    expect([...support]).toEqual([PRESETS]);
  });

  it("ignores a self-edge when reading a file's importers", () => {
    const graph: FileDependencyGraph = { files: [file(PRESETS)], edges: [edge(PRESETS, PRESETS)] };

    expect([...supportOf(graph, [testImport(SPEC, PRESETS)], MSW)]).toEqual([PRESETS]);
    expect(supportOf(graph, [], MSW).size).toBe(0);
  });

  it("counts an unwalked importer that is not a test — a generated client, say — as production", () => {
    const helper = "app/api/helpers/getNextPageParam.ts";
    const graph: FileDependencyGraph = { files: [file(helper)], edges: [] };

    const support = supportOf(
      graph,
      [
        testImport("app/api/helpers/getNextPageParam.test.ts", helper),
        generatedImport("app/api/__generated__/hooks/useThings.ts", helper),
      ],
      [testUses("app/api/helpers/getNextPageParam.test.ts", "msw"), uses(helper, "msw")],
    );

    expect(support.size).toBe(0);
  });
  it("counts a file a file nothing imports keeps out of support as production evidence against its imports", () => {
    // ClientTodos presets is imported by a test and by an unused presets file
    // nothing imports, so (a) keeps it out of support, and it stays a
    // production importer of the page type: neutrality is never transitive,
    // or a worker loaded by module path would hand its whole subtree to tests.
    const unused = "app/todos/units/specs/Unused.spec.presets.tsx";
    const todos = "app/todos/specs/ClientTodos.spec.presets.tsx";
    const pageType = "app/tests/types/Page.ts";
    const graph: FileDependencyGraph = {
      files: [file(PRESETS), file(todos), file(unused)],
      edges: [edge(unused, todos)],
    };

    const classification = classifyTestSupportFiles(
      graph,
      [testImport(SPEC, PRESETS), testImport("app/todos/specs/ClientTodos.spec.tsx", todos)],
      [testUses(SPEC, pageType), uses(PRESETS, pageType), uses(todos, pageType)],
    );

    expect(classification.files.size).toBe(0);
    expect(classification.testOnlyDependencies.size).toBe(0);
  });

  it("keeps a dependency test-only when its only other importer is a file nothing imports", () => {
    // A file with no importer at all (an unused fixture, a tool config) is
    // evidence for neither side, so it does not take msw out of the set.
    const orphan = "app/other/specs/Unused.spec.presets.tsx";
    const graph: FileDependencyGraph = { files: [file(PRESETS), file(orphan)], edges: [] };

    const classification = classifyTestSupportFiles(graph, [testImport(SPEC, PRESETS)], [...MSW, uses(orphan, "msw")]);

    expect([...classification.files]).toEqual([PRESETS]);
    expect([...classification.testOnlyDependencies]).toEqual(["msw"]);
  });
});

describe("deriveTestOnlyDependencies", () => {
  it("ignores the imports of a test-side file — one nothing imports is neither test nor production evidence", () => {
    const orphan = "playwright-ct.config.ts";
    const dependencies = deriveTestOnlyDependencies(
      [testUses(SPEC, "gonMock"), uses(orphan, "gonMock"), testUses(SPEC, "react"), uses(MODAL, "react")],
      new Set([orphan]),
    );

    expect([...dependencies]).toEqual(["gonMock"]);
  });

  it("keeps what a test imports and no file outside the support set imports — an unwalked non-test importer is production", () => {
    const generated = "app/__generated__/client.ts";
    const dependencies = deriveTestOnlyDependencies(
      [
        testUses(SPEC, "msw"),
        uses(PRESETS, "msw"),
        testUses(SPEC, "react"),
        uses(MODAL, "react"),
        testUses(SPEC, "axios"),
        uses(generated, "axios"),
        uses(PRESETS, "lodash"),
      ],
      new Set([PRESETS]),
    );

    expect([...dependencies]).toEqual(["msw"]);
  });
});

describe("resolveExternalImports", () => {
  const MOCKS = "app/modal/specs/Modal.mocks.test.ts";
  const walked = [MODAL, PRESETS, "lib/util.ts", "other/lib/util.ts"];

  it("names each package by its name and each unwalked indexed file by its path; walked targets belong to the graph", () => {
    const imports = resolveExternalImports(
      new Map([
        [
          SPEC,
          testFile(
            "@testing-library/react/pure",
            "msw/node",
            "react",
            "./Modal.spec.presets",
            "./Modal.mocks.test",
            "../../../../outside",
            "./missing",
            "lib/util",
            "/abs/path",
          ),
        ],
        [PRESETS, { isTest: false, specifiers: ["msw", "../Modal", "./Modal.mocks.test.js", "msw/browser"] }],
        [MOCKS, testFile("vitest")],
      ]),
      walked,
    );

    expect(imports).toEqual([
      testUses(SPEC, "@testing-library/react"),
      testUses(SPEC, "msw"),
      testUses(SPEC, "react"),
      testUses(SPEC, MOCKS),
      uses(PRESETS, "msw"),
      uses(PRESETS, MOCKS),
      testUses(MOCKS, "vitest"),
    ]);
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
