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
    // The fixture is not named after its test: the name relation is evidence
    // of its own (89k7k.35.3), and this case pins the package rule alone — so
    // it sits outside the test's directory, whose evidence is its own too
    // (r8hme.52.14 b).
    const fixture = "app/modal/fixtures/modalFixture.tsx";
    const page = "app/pages/Page.tsx";
    const router = "app/router.tsx";
    const graph: FileDependencyGraph = {
      files: [file(fixture), file(page), file(router)],
      edges: [edge(router, page)],
    };

    const support = supportOf(
      graph,
      [testImport(SPEC, fixture)],
      [testUses(SPEC, "react"), uses(fixture, "react"), uses(page, "react")],
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
  it("treats a file nothing imports as test-side when it imports a companion named after the test importing it", () => {
    // tests/types/Page.ts on taxdome (89k7k.35.3): ClientTodos presets is
    // imported by its test and by an unused presets file nothing imports. The
    // unused file imports a name-related companion — evidence independent of
    // the test-only set, so no worker loaded by module path qualifies — and so
    // stops counting as a production importer: the presets become support and
    // the page type, imported only by tests and support, becomes test-only.
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

    expect([...classification.files].sort()).toEqual([PRESETS, todos].sort());
    expect([...classification.testOnlyDependencies]).toEqual([pageType]);
  });

  it("names a file whose name extends the name of the test importing it as test support, with no test-only import", () => {
    // Name relation (89k7k.35.3 owner decision): Modal.spec.presets.tsx is
    // the companion of the Modal.spec.tsx that imports it — positive evidence
    // between two files, not a name pattern.
    const graph: FileDependencyGraph = { files: [file(MODAL), file(PRESETS)], edges: [edge(PRESETS, MODAL)] };

    const support = supportOf(graph, [testImport(SPEC, PRESETS)], [uses(PRESETS, "react"), uses(MODAL, "react")]);

    expect([...support]).toEqual([PRESETS]);
  });

  it("grounds the file importing a name-related companion through the existing reachability", () => {
    const shared = "app/modal/specs/sharedPresets.ts";
    const graph: FileDependencyGraph = {
      files: [file(MODAL), file(PRESETS), file(shared)],
      edges: [edge(shared, PRESETS), edge(PRESETS, MODAL)],
    };

    const support = supportOf(graph, [testImport(SPEC, PRESETS), testImport(SPEC, shared)], []);

    expect([...support].sort()).toEqual([PRESETS, shared].sort());
  });

  it("keeps a worker its test is named after in production — the relation runs the other way", () => {
    const worker = "src/chunker/infra/worker.ts";
    const graph: FileDependencyGraph = { files: [file(worker)], edges: [] };

    const support = supportOf(
      graph,
      [testImport("tests/chunker/infra/worker.test.ts", worker)],
      [testUses("tests/chunker/infra/worker.test.ts", "vitest"), uses(worker, "node:worker_threads")],
    );

    expect(support.size).toBe(0);
  });

  it("does not take a name that merely starts like the test's name, without a separator, as related", () => {
    // Outside the test's directory: this pins the name relation alone (r8hme.52.14 b).
    const presetsLike = "app/modal/specification/Modal.specification.ts";
    const graph: FileDependencyGraph = { files: [file(presetsLike)], edges: [] };

    const support = supportOf(graph, [testImport(SPEC, presetsLike)], []);

    expect(support.size).toBe(0);
  });

  it("adds a package a manifest declares for development only, once a test imports it, even when production imports it too", () => {
    const helper = "app/modal/specs/modalHelper.ts";
    const graph: FileDependencyGraph = {
      files: [file(FACADE), file(MODAL), file(helper)],
      edges: [edge(FACADE, MODAL)],
    };

    const classification = classifyTestSupportFiles(
      graph,
      [testImport("app/modal/specs/Other.test.tsx", helper)],
      [
        testUses("app/modal/specs/Other.test.tsx", "@testing-library/react"),
        uses(helper, "@testing-library/react"),
        uses(MODAL, "@testing-library/react"),
        uses(MODAL, "eslint"),
      ],
      new Set(["@testing-library/react", "eslint"]),
    );

    expect([...classification.files]).toEqual([helper]);
    expect([...classification.testOnlyDependencies]).toEqual(["@testing-library/react"]);
  });

  it("never lets a Node core module into the test-only set, whatever imports or declares it", () => {
    const helper = "tests/support/fsHelper.ts";
    const test = "tests/a.test.ts";

    const classification = classifyTestSupportFiles(
      { files: [file(helper)], edges: [] },
      [testImport(test, helper)],
      [testUses(test, "node:test"), uses(helper, "node:test"), testUses(test, "fs"), uses(helper, "fs")],
      new Set(["fs"]),
    );

    expect(classification.files.size).toBe(0);
    expect(classification.testOnlyDependencies.size).toBe(0);
  });

  it("keeps an unimported file that imports no name-related companion as production evidence in (a)", () => {
    const unused = "app/todos/units/Unused.tsx";
    const todosHelper = "app/todos/specs/todosHelper.ts";
    const graph: FileDependencyGraph = { files: [file(todosHelper), file(unused)], edges: [edge(unused, todosHelper)] };

    const support = supportOf(
      graph,
      [testImport("app/todos/specs/ClientTodos.spec.tsx", todosHelper)],
      [testUses("app/todos/specs/ClientTodos.spec.tsx", "msw"), uses(todosHelper, "msw")],
    );

    expect(support.size).toBe(0);
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

  describe("a file nothing imports that imports a dependency the manifests declare for development only (r8hme.52.14)", () => {
    // taxdome: 519 of 524 *.stories.tsx only `import type { Meta, StoryObj }`
    // from a development-only package and nothing imports them; vite configs
    // import vite. Owner decision (B): any import of a development-only
    // dependency, value or type, makes such a file a non-production root, and
    // what only it reaches follows through (a).
    const STORYBOOK = "@storybook/react-vite";
    const STORY = "app/modal/stories/Modal.stories.tsx";
    const STORY_HELPER = "app/modal/stories/storyArgs.ts";
    const PAGE = "app/pages/Page.tsx";
    const DECLARED = new Set([STORYBOOK]);

    it("names the file and the helper only it reaches as non-production, never what production also reaches", () => {
      const graph: FileDependencyGraph = {
        files: [file(STORY), file(STORY_HELPER), file(MODAL), file(PAGE)],
        edges: [edge(STORY, STORY_HELPER), edge(STORY, MODAL), edge(STORY_HELPER, MODAL), edge(PAGE, MODAL)],
      };

      const classification = classifyTestSupportFiles(
        graph,
        [],
        [uses(STORY, STORYBOOK), uses(PAGE, "react")],
        DECLARED,
      );

      expect([...classification.files].sort()).toEqual([STORY, STORY_HELPER].sort());
      expect([...classification.developmentRoots]).toEqual([STORY]);
    });

    it("keeps a helper the root reaches in production when a production file imports it too", () => {
      const graph: FileDependencyGraph = {
        files: [file(STORY), file(STORY_HELPER), file(PAGE)],
        edges: [edge(STORY, STORY_HELPER), edge(PAGE, STORY_HELPER)],
      };

      const classification = classifyTestSupportFiles(graph, [], [uses(STORY, STORYBOOK)], DECLARED);

      expect([...classification.files]).toEqual([STORY]);
    });

    it("keeps a file nothing imports that imports only runtime dependencies in production, with its subtree", () => {
      // The page imports the development-only package, but it is imported: only a file nothing imports is a root.
      const worker = "app/workers/worker.ts";
      const graph: FileDependencyGraph = {
        files: [file(worker), file(STORY_HELPER), file(PAGE)],
        edges: [edge(worker, STORY_HELPER), edge(worker, PAGE)],
      };

      const classification = classifyTestSupportFiles(
        graph,
        [],
        [uses(worker, "react"), uses(PAGE, STORYBOOK)],
        DECLARED,
      );

      expect(classification.files.size).toBe(0);
      expect(classification.developmentRoots.size).toBe(0);
    });
  });

  describe("a file only tests and their support import, in a directory of tests and test support (r8hme.52.14 b)", () => {
    // taxdome specs/mocks.ts: imported by its directory's spec and the spec's
    // presets companion, importing only production modules — no test-only
    // dependency, no name relation. Owner decision: a directory whose other
    // indexed files are all tests or test support is the positive evidence.
    const MOCKS = "app/modal/specs/mocks.ts";
    const API_MOCKS = "app/api/mocks.ts";
    const INDEXED = new Map([
      [SPEC, testFile("./mocks", "./Modal.spec.presets", "../Modal")],
      [MOCKS, { isTest: false, specifiers: ["../../api/mocks"] }],
      [PRESETS, { isTest: false, specifiers: ["./mocks", "../Modal"] }],
    ]);

    it("names the file test support when every other file in its directory is a test or test support", () => {
      const graph: FileDependencyGraph = {
        files: [file(MOCKS), file(PRESETS), file(MODAL), file(API_MOCKS), file(FACADE)],
        edges: [edge(MOCKS, API_MOCKS), edge(PRESETS, MOCKS), edge(PRESETS, MODAL), edge(FACADE, MODAL)],
      };

      const classification = classifyTestSupportFiles(
        graph,
        [testImport(SPEC, MOCKS), testImport(SPEC, PRESETS), testImport(SPEC, MODAL)],
        [uses(MOCKS, "react"), uses(MODAL, "react")],
        new Set(),
        INDEXED,
      );

      expect([...classification.files].sort()).toEqual([MOCKS, PRESETS].sort());
    });

    it("keeps a file only a test and its companion import in production when a production file shares its directory", () => {
      // The 89k7k.35.3 guard: Foo.tsx imported only by Foo.spec.tsx and
      // Foo.spec.presets.tsx, beside production code, is the code under test.
      const foo = "app/forms/Foo.tsx";
      const fooSpec = "app/forms/Foo.spec.tsx";
      const fooPresets = "app/forms/Foo.spec.presets.tsx";
      const bar = "app/forms/Bar.tsx";
      const graph: FileDependencyGraph = {
        files: [file(foo), file(fooPresets), file(bar), file(FACADE)],
        edges: [edge(fooPresets, foo), edge(FACADE, bar)],
      };

      const classification = classifyTestSupportFiles(
        graph,
        [testImport(fooSpec, foo), testImport(fooSpec, fooPresets)],
        [uses(foo, "react"), uses(bar, "react")],
        new Set(),
        new Map([[fooSpec, testFile("./Foo", "./Foo.spec.presets")]]),
      );

      expect([...classification.files]).toEqual([fooPresets]);
    });

    it("keeps the file a test in its directory is named after in production — it is the code under test", () => {
      const foo = "app/forms/Foo.tsx";
      const fooSpec = "app/forms/Foo.spec.tsx";
      const graph: FileDependencyGraph = { files: [file(foo)], edges: [] };

      const classification = classifyTestSupportFiles(
        graph,
        [testImport(fooSpec, foo)],
        [uses(foo, "react")],
        new Set(),
        new Map([[fooSpec, testFile("./Foo")]]),
      );

      expect(classification.files.size).toBe(0);
    });

    it("keeps the file in production when an indexed sibling is neither a test nor test support", () => {
      const generated = "app/modal/specs/schema.generated.ts";
      const graph: FileDependencyGraph = {
        files: [file(MOCKS), file(API_MOCKS)],
        edges: [edge(MOCKS, API_MOCKS)],
      };

      const classification = classifyTestSupportFiles(
        graph,
        [testImport(SPEC, MOCKS)],
        [uses(MOCKS, "react")],
        new Set(),
        new Map([...INDEXED, [generated, { isTest: false, specifiers: ["zod"] }]]),
      );

      expect(classification.files.size).toBe(0);
    });

    it("keeps a file whose directory holds no test in production — support siblings alone are not evidence", () => {
      const fixtures = "app/modal/fixtures/fixtures.ts";
      const graph: FileDependencyGraph = {
        files: [file(MOCKS), file(PRESETS), file(fixtures)],
        edges: [edge(PRESETS, MOCKS)],
      };

      const classification = classifyTestSupportFiles(
        graph,
        [testImport(SPEC, PRESETS), testImport(SPEC, fixtures)],
        [uses(fixtures, "react")],
        new Set(),
        new Map([[SPEC, testFile("../fixtures/fixtures")]]),
      );

      expect(classification.files.has(fixtures)).toBe(false);
    });
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
