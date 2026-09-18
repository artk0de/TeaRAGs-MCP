/**
 * `JavascriptImportFileMapper` (bd tea-rags-mcp-x9qsh). A JavaScript specifier
 * does not always name its file: `./config` is `config.js` in one project and
 * `config/index.js` in the next, and `./styles.scss` is not a code file at all.
 * The mapper answers from symbol-table MEMBERSHIP, so a target is `project`
 * only when the index holds that file — never a path synthesised from the
 * specifier alone. No disk in this test, and none in the implementation.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavascriptImportFileMapper } from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctxWith(projectFiles: readonly string[]): CallContext {
  const table = new InMemoryGlobalSymbolTable();
  table.hydrateFiles(projectFiles);
  return { callerFile: "src/main.js", callerScope: [], imports: [], symbolTable: table };
}

const mapper = new JavascriptImportFileMapper();

describe("JavascriptImportFileMapper", () => {
  it("maps an extensionless specifier to the .js file the index holds", () => {
    const ctx = ctxWith(["src/config.js"]);
    expect(mapper.mapImportToFile("./config", "src/main.js", ctx)).toEqual({
      kind: "project",
      relPath: "src/config.js",
    });
  });

  it("maps an extensionless specifier to its directory's index module when that is the file", () => {
    const ctx = ctxWith(["src/config/index.js"]);
    expect(mapper.mapImportToFile("./config", "src/main.js", ctx)).toEqual({
      kind: "project",
      relPath: "src/config/index.js",
    });
  });

  it("prefers the file over the directory index, the order Node resolves them in", () => {
    const ctx = ctxWith(["src/config.js", "src/config/index.js"]);
    expect(mapper.mapImportToFile("./config", "src/main.js", ctx)).toEqual({
      kind: "project",
      relPath: "src/config.js",
    });
  });

  it("falls back to .jsx, then to a TypeScript source, only when the index holds no .js", () => {
    expect(mapper.mapImportToFile("./Button", "src/main.js", ctxWith(["src/Button.jsx"]))).toEqual({
      kind: "project",
      relPath: "src/Button.jsx",
    });
    expect(mapper.mapImportToFile("./util", "src/main.js", ctxWith(["src/util.ts"]))).toEqual({
      kind: "project",
      relPath: "src/util.ts",
    });
    expect(mapper.mapImportToFile("./util", "src/main.js", ctxWith(["src/util.ts", "src/util.js"]))).toEqual({
      kind: "project",
      relPath: "src/util.js",
    });
  });

  it("treats a dotted basename as extensionless, so it still reaches its .js file", () => {
    const ctx = ctxWith(["src/foo.service.js"]);
    expect(mapper.mapImportToFile("./foo.service", "src/main.js", ctx)).toEqual({
      kind: "project",
      relPath: "src/foo.service.js",
    });
  });

  it("maps a specifier that writes its extension to exactly that file", () => {
    const ctx = ctxWith(["scripts/lib/render-changelog.js", "scripts/worker.ts"]);
    expect(mapper.mapImportToFile("./lib/render-changelog.js", "scripts/retro-changelog.js", ctx)).toEqual({
      kind: "project",
      relPath: "scripts/lib/render-changelog.js",
    });
    expect(mapper.mapImportToFile("./worker.ts", "scripts/boot.js", ctx)).toEqual({
      kind: "project",
      relPath: "scripts/worker.ts",
    });
  });

  it("answers unknown for a relative specifier the index holds no file for", () => {
    // `config.js` would be a dangling edge: the old mapper named it from the
    // specifier alone, and no file row could ever match it.
    expect(mapper.mapImportToFile("./config", "src/main.js", ctxWith([]))).toEqual({ kind: "unknown" });
    expect(mapper.mapImportToFile("../build/core/factory.js", "scripts/verify.js", ctxWith([]))).toEqual({
      kind: "unknown",
    });
  });

  it("answers unknown for a stylesheet import, which is not a code file the index holds", () => {
    const ctx = ctxWith(["app/javascript/static/index.js"]);
    expect(mapper.mapImportToFile("./styles/static.scss", "app/javascript/static/index.js", ctx)).toEqual({
      kind: "unknown",
    });
  });

  it("answers external for a bare package specifier", () => {
    const ctx = ctxWith(["lodash.js"]);
    expect(mapper.mapImportToFile("lodash", "src/main.js", ctx)).toEqual({ kind: "external" });
    expect(mapper.mapImportToFile("node:path", "src/main.js", ctx)).toEqual({ kind: "external" });
  });

  it("treats only `.` / `..` and what follows them as relative, never a dot-named directory", () => {
    const ctx = ctxWith(["src/index.js", "src/.storybook/x.js"]);
    expect(mapper.mapImportToFile(".storybook/x", "src/main.js", ctx)).toEqual({ kind: "external" });
    expect(mapper.mapImportToFile(".", "src/main.js", ctx)).toEqual({ kind: "project", relPath: "src/index.js" });
    expect(mapper.mapImportToFile("..", "src/lib/util.js", ctx)).toEqual({ kind: "project", relPath: "src/index.js" });
  });
});
