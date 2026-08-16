import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-w65s7 — a BARE call whose callee is a binding an import
 * introduced. The chain had no pass for it: the receiver-gated passes all
 * decline, and `globalShortName` looks the CALLEE TEXT up in the symbol table,
 * which for `import { create as createAction }` is a name no file declares.
 *
 * Measured with the type-checker oracle on taxdome (2026-08-16): 632 of 645
 * cross-file class-B misses were this shape, all bareCall.
 */
describe("TSCallResolver — imported-callee bare calls (bd tea-rags-mcp-w65s7)", () => {
  function resolverFor(): TSCallResolver {
    return new TSCallResolver({ baseUrl: ".", paths: {} });
  }

  function bareCall(member: string, startLine = 5): CallRef {
    return { callText: `${member}(x)`, receiver: null, member, startLine };
  }

  function contextFor(callerFile: string, imports: ImportRef[], symbolTable: InMemoryGlobalSymbolTable): CallContext {
    return { callerFile, callerScope: [], imports, symbolTable };
  }

  it("resolves a renamed named import to the symbol the module EXPORTS, not the local alias", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/repositories/ArchiveRepository.ts", [
      {
        symbolId: "create",
        fqName: "create",
        shortName: "create",
        relPath: "src/repositories/ArchiveRepository.ts",
        scope: [],
      },
    ]);
    const result = resolverFor().resolve(
      bareCall("createAction"),
      contextFor(
        "src/actions/ArchiveActions.ts",
        [
          {
            importText: "../repositories/ArchiveRepository",
            startLine: 1,
            importedNames: ["createAction"],
            importedBindings: { createAction: "create" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toEqual({
      targetRelPath: "src/repositories/ArchiveRepository.ts",
      targetSymbolId: "create",
    });
  });

  it("prefers the import's module over a same-named symbol elsewhere in the project", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/repositories/BlobRepository.ts", [
      {
        symbolId: "create",
        fqName: "create",
        shortName: "create",
        relPath: "src/repositories/BlobRepository.ts",
        scope: [],
      },
    ]);
    // A decoy the global short-name pass would have matched had the callee not
    // been aliased — and would still match if this pass keyed on the alias.
    symbolTable.upsertFile("src/other/create.ts", [
      {
        symbolId: "createAction",
        fqName: "createAction",
        shortName: "createAction",
        relPath: "src/other/create.ts",
        scope: [],
      },
    ]);
    const result = resolverFor().resolve(
      bareCall("createAction"),
      contextFor(
        "src/actions/BlobActions.ts",
        [
          {
            importText: "../repositories/BlobRepository",
            startLine: 1,
            importedNames: ["createAction"],
            importedBindings: { createAction: "create" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toEqual({ targetRelPath: "src/repositories/BlobRepository.ts", targetSymbolId: "create" });
  });

  it("hops a barrel to the file that DECLARES the binding (destructured dynamic import)", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/bootstrap/config/app-config.ts", [
      {
        symbolId: "parseAppConfig",
        fqName: "parseAppConfig",
        shortName: "parseAppConfig",
        relPath: "src/bootstrap/config/app-config.ts",
        scope: [],
      },
    ]);
    symbolTable.upsertFile("src/bootstrap/config/index.ts", []);
    const result = resolverFor().resolve(
      bareCall("parseAppConfig"),
      contextFor(
        "src/cli/commands/doctor.ts",
        [
          {
            importText: "../../bootstrap/config/index.js",
            startLine: 187,
            importedNames: ["parseAppConfig"],
            importedBindings: { parseAppConfig: "parseAppConfig" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toEqual({
      targetRelPath: "src/bootstrap/config/app-config.ts",
      targetSymbolId: "parseAppConfig",
    });
  });

  it("resolves a member destructured off an imported namespace object", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/helpers/DirectoryHelper.ts", [
      {
        symbolId: "DirectoryHelper",
        fqName: "DirectoryHelper",
        shortName: "DirectoryHelper",
        relPath: "src/helpers/DirectoryHelper.ts",
        scope: [],
      },
      {
        symbolId: "pathIds",
        fqName: "pathIds",
        shortName: "pathIds",
        relPath: "src/helpers/DirectoryHelper.ts",
        scope: [],
      },
    ]);
    const result = resolverFor().resolve(
      bareCall("pathIds"),
      contextFor(
        "src/helpers/Directory.ts",
        [
          {
            importText: "./DirectoryHelper",
            startLine: 4,
            importedNames: ["DirectoryHelper"],
            importedBindings: { DirectoryHelper: "DirectoryHelper", pathIds: "pathIds" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toEqual({ targetRelPath: "src/helpers/DirectoryHelper.ts", targetSymbolId: "pathIds" });
  });

  it("prefers a top-level export over a same-named method inside the target file", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/repositories/UserRepository.ts", [
      {
        symbolId: "update",
        fqName: "update",
        shortName: "update",
        relPath: "src/repositories/UserRepository.ts",
        scope: [],
      },
      {
        symbolId: "Cache#update",
        fqName: "Cache#update",
        shortName: "update",
        relPath: "src/repositories/UserRepository.ts",
        scope: ["Cache"],
      },
    ]);
    const result = resolverFor().resolve(
      bareCall("updateAction"),
      contextFor(
        "src/actions/UserActions.ts",
        [
          {
            importText: "../repositories/UserRepository",
            startLine: 1,
            importedNames: ["updateAction"],
            importedBindings: { updateAction: "update" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toEqual({ targetRelPath: "src/repositories/UserRepository.ts", targetSymbolId: "update" });
  });

  // Chain-order regression. `sameFile` matches a bare callee against every
  // short name the caller's file declares, its own METHODS included, so an
  // adapter method delegating to the free function it imports resolved to
  // ITSELF. Measured on this repo: 18 bareCall wrongFile rows, all this shape.
  it("beats sameFile when a method of the caller's own file shares the imported name", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/adapters/git/client.ts", [
      {
        symbolId: "getHead",
        fqName: "getHead",
        shortName: "getHead",
        relPath: "src/adapters/git/client.ts",
        scope: [],
      },
    ]);
    symbolTable.upsertFile("src/adapters/git/adapter.ts", [
      {
        symbolId: "GitCliAdapter#getHead",
        fqName: "GitCliAdapter#getHead",
        shortName: "getHead",
        relPath: "src/adapters/git/adapter.ts",
        scope: ["GitCliAdapter"],
      },
    ]);
    const result = resolverFor().resolve(
      bareCall("getHead"),
      contextFor(
        "src/adapters/git/adapter.ts",
        [
          {
            importText: "./client.js",
            startLine: 1,
            importedNames: ["getHead"],
            importedBindings: { getHead: "getHead" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toEqual({ targetRelPath: "src/adapters/git/client.ts", targetSymbolId: "getHead" });
  });

  it("declines a bare package specifier — an npm import maps to no project file", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    // A project symbol shares the exported name; without the mapping gate the
    // pass would fabricate an edge into it for a call that leaves the project.
    symbolTable.upsertFile("src/state/store.ts", [
      { symbolId: "useStore", fqName: "useStore", shortName: "useStore", relPath: "src/state/store.ts", scope: [] },
    ]);
    const result = resolverFor().resolve(
      bareCall("useStore"),
      contextFor(
        "src/app/Widget.ts",
        [
          {
            importText: "zustand",
            startLine: 1,
            importedNames: ["useStore"],
            importedBindings: { useStore: "useStore" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toBeNull();
  });

  it("leaves a call whose callee no import binds to the rest of the chain", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/util/helpers.ts", [
      { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "src/util/helpers.ts", scope: [] },
    ]);
    const result = resolverFor().resolve(
      bareCall("helper"),
      contextFor(
        "src/app/main.ts",
        [{ importText: "./other", startLine: 1, importedNames: ["Other"], importedBindings: { Other: "Other" } }],
        symbolTable,
      ),
    );
    // globalShortName still answers it — this pass must not shadow the chain.
    expect(result).toEqual({ targetRelPath: "src/util/helpers.ts", targetSymbolId: "helper" });
  });

  it("does not answer a call that HAS a receiver", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/repositories/ArchiveRepository.ts", [
      {
        symbolId: "create",
        fqName: "create",
        shortName: "create",
        relPath: "src/repositories/ArchiveRepository.ts",
        scope: [],
      },
    ]);
    const result = resolverFor().resolve(
      { callText: "obj.createAction(x)", receiver: "obj", member: "createAction", startLine: 5 },
      contextFor(
        "src/actions/ArchiveActions.ts",
        [
          {
            importText: "../repositories/ArchiveRepository",
            startLine: 1,
            importedNames: ["createAction"],
            importedBindings: { createAction: "create" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toBeNull();
  });

  it("declines when the exported name is ambiguous inside the target file", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/repositories/AmbiguousRepository.ts", [
      {
        symbolId: "A#run",
        fqName: "A#run",
        shortName: "run",
        relPath: "src/repositories/AmbiguousRepository.ts",
        scope: ["A"],
      },
      {
        symbolId: "B#run",
        fqName: "B#run",
        shortName: "run",
        relPath: "src/repositories/AmbiguousRepository.ts",
        scope: ["B"],
      },
    ]);
    const result = resolverFor().resolve(
      bareCall("runAction"),
      contextFor(
        "src/actions/Runner.ts",
        [
          {
            importText: "../repositories/AmbiguousRepository",
            startLine: 1,
            importedNames: ["runAction"],
            importedBindings: { runAction: "run" },
          },
        ],
        symbolTable,
      ),
    );
    expect(result).toBeNull();
  });
});
