/**
 * The incremental-run repair (bd tea-rags-mcp-znxg8): a run whose batch holds
 * three files still resolves against a PROJECT-wide registry, because the
 * pass-1→pass-2 barrier absorbs the persisted per-file aggregate slices of every
 * file it did NOT walk.
 *
 * The two properties that make the repair safe are the ones asserted here, and
 * neither is visible from a green resolve:
 *
 *  - a walked file's persisted row is SKIPPED, so a class the file just renamed
 *    away cannot be resurrected under a key indistinguishable from the fresh one;
 *  - a hydrated key never DISPLACES a walked one, so the fresh extraction stays
 *    authoritative regardless of merge order.
 *
 * Absorbed AT the barrier, before the hierarchy view and the include-by index
 * are built — so the assertions read those derived structures too, not just the
 * raw maps.
 */

import { describe, expect, it } from "vitest";

import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type {
  CodegraphPass1FileAggregates,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

/** The barrier resolves a table only for schema columns / self-dispatch; neither is in play here. */
const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();

function walkedFile(relPath: string, extra: Partial<FileExtraction> = {}): FileExtraction {
  return {
    relPath,
    language: "python",
    imports: [],
    fileScope: [],
    chunks: [],
    ...extra,
  } as unknown as FileExtraction;
}

/** One persisted row for a file this run did not walk. */
function persistedSlice(
  relPath: string,
  fields: Omit<CodegraphPass1FileAggregates, "relPath" | "language">,
): CodegraphPass1FileAggregates {
  return { relPath, language: "python", ...fields };
}

describe("CodegraphRunState.seal hydrates the pass-1 aggregates of files this run did not walk", () => {
  it("absorbs ancestry, prepends, extends and compact-class facts from an unwalked file", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(walkedFile("app/views.py"), []);

    await runState.seal(noopTable, async () => [
      persistedSlice("app/models.py", {
        classAncestors: { "app/models.py::Site": ["NetBoxModel"] },
        classPrependedAncestors: { "app/models.py::Site": ["Auditable"] },
        classExtends: { Site: "NetBoxModel" },
        compactDeclaredClasses: ["app.models.Site"],
      }),
    ]);

    expect(runState.ancestors).toEqual({ "app/models.py::Site": ["NetBoxModel"] });
    expect(runState.prependedAncestors).toEqual({ "app/models.py::Site": ["Auditable"] });
    expect(runState.classExtends).toEqual({ Site: "NetBoxModel" });
    expect(runState.compactClasses.has("app.models.Site")).toBe(true);
    // Hydration is a real contribution: pass-2 chooses the run-global map over
    // the per-file fallback on exactly this flag.
    expect(runState.hasRunGlobalEntries("ancestors")).toBe(true);
    expect(runState.hasRunGlobalEntries("prependedAncestors")).toBe(true);
    expect(runState.hasRunGlobalEntries("classExtends")).toBe(true);
  });

  it("never lets a hydrated fact displace the one this run walked", async () => {
    const runState = new CodegraphRunState();
    // The fresh walk says Site now extends AbstractModel.
    runState.absorb(
      walkedFile("app/models.py", {
        classAncestors: { "app/models.py::Site": ["AbstractModel"] },
        classExtends: { Site: "AbstractModel" },
      } as Partial<FileExtraction>),
      [],
    );

    // A DIFFERENT file's persisted row carries the same keys with stale values.
    await runState.seal(noopTable, async () => [
      persistedSlice("app/legacy.py", {
        classAncestors: { "app/models.py::Site": ["NetBoxModel"] },
        classExtends: { Site: "NetBoxModel" },
      }),
    ]);

    expect(runState.ancestors).toEqual({ "app/models.py::Site": ["AbstractModel"] });
    expect(runState.classExtends).toEqual({ Site: "AbstractModel" });
  });

  it("skips the persisted row of a file this run re-walked, so a renamed-away class stays gone", async () => {
    const runState = new CodegraphRunState();
    // The file was walked and now declares nothing — the class was deleted.
    runState.absorb(walkedFile("app/models.py"), []);

    await runState.seal(noopTable, async () => [
      persistedSlice("app/models.py", {
        classAncestors: { "app/models.py::Ghost": ["NetBoxModel"] },
        compactDeclaredClasses: ["app.models.Ghost"],
      }),
    ]);

    expect(runState.ancestors).toEqual({});
    expect(runState.compactClasses.has("app.models.Ghost")).toBe(false);
    expect(runState.hasRunGlobalEntries("ancestors")).toBe(false);
  });

  it("does not count a hydrated file as extracted", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(walkedFile("app/views.py"), []);

    await runState.seal(noopTable, async () => [
      persistedSlice("app/models.py", { classAncestors: { "app/models.py::Site": ["NetBoxModel"] } }),
    ]);

    expect(runState.extractedFilesByLanguage.get("python")).toBe(1);
    expect(runState.extractedRelPathsByLanguage.get("python")).toEqual(["app/views.py"]);
  });

  it("degrades to a batch-scoped registry rather than aborting when the persisted rows cannot be read", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(
      walkedFile("app/models.py", {
        classAncestors: { "app/models.py::Site": ["NetBoxModel"] },
      } as Partial<FileExtraction>),
      [],
    );

    await expect(
      runState.seal(noopTable, async () => {
        throw new Error("duckdb unavailable");
      }),
    ).resolves.toBeUndefined();

    // The run keeps what it walked; only the repair is lost.
    expect(runState.ancestors).toEqual({ "app/models.py::Site": ["NetBoxModel"] });
    expect(runState.hierarchyView).toBeDefined();
  });
});

/**
 * The two Python channels bd tea-rags-mcp-4yvms added to the slice, measured on
 * netbox (`classFieldTypesByClassKey`, 9 edges) and polar (`moduleReexports`,
 * 118 edges) with `scripts/spikes/incremental-runglobal-delta.ts`.
 *
 * They need their own assertions because their merge grains differ from the
 * ancestry channels' and from each other's: one is a two-level map skipped at
 * the CLASS KEY, the other a list REPLACED at the declaring relPath.
 */
describe("CodegraphRunState.seal hydrates the Python run-global channels", () => {
  it("absorbs an unwalked file's class-key field types so a subclass sees a base's fields", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(walkedFile("app/services.py"), []);

    await runState.seal(noopTable, async () => [
      persistedSlice("app/models.py", {
        classFieldTypesByClassKey: { "app/models.py::SyncServiceBase": { client: "HttpClient" } },
      }),
    ]);

    expect(runState.classFieldTypesByClassKey).toEqual({
      "app/models.py::SyncServiceBase": { client: "HttpClient" },
    });
  });

  it("never lets a hydrated class key displace a walked one, and never merges into it", async () => {
    const runState = new CodegraphRunState();
    // The fresh walk retyped `client` and dropped `legacy` entirely.
    runState.absorb(
      walkedFile("app/models.py", {
        classFieldTypesByClassKey: { "app/models.py::SyncServiceBase": { client: "AsyncClient" } },
      } as Partial<FileExtraction>),
      [],
    );

    // A DIFFERENT file's row carries the SAME class key with stale content. The
    // key prefix makes this unreachable in production — a key names its own
    // declaring file, and that file's row is skipped when walked — so the guard
    // is pinned here rather than left to the SKIP filter to imply.
    await runState.seal(noopTable, async () => [
      persistedSlice("app/legacy.py", {
        classFieldTypesByClassKey: {
          "app/models.py::SyncServiceBase": { client: "HttpClient", legacy: "LegacyClient" },
        },
      }),
    ]);

    expect(runState.classFieldTypesByClassKey).toEqual({
      "app/models.py::SyncServiceBase": { client: "AsyncClient" },
    });
  });

  it("skips the row of a re-walked file, so a field the class no longer has stays gone", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(walkedFile("app/models.py"), []);

    await runState.seal(noopTable, async () => [
      persistedSlice("app/models.py", {
        classFieldTypesByClassKey: { "app/models.py::SyncServiceBase": { client: "HttpClient" } },
        moduleReexports: [{ exportedName: "Site", sourceModule: ".site", sourceName: "Site" }],
      }),
    ]);

    expect(runState.classFieldTypesByClassKey).toEqual({});
    expect(runState.moduleReexports).toEqual({});
  });

  it("absorbs an unwalked package's re-export list, keyed by the file that declared it", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(walkedFile("dcim/views.py"), []);
    const reexports = [{ exportedName: "ObjectType", sourceModule: ".object_types", sourceName: "ObjectType" }];

    await runState.seal(noopTable, async () => [
      persistedSlice("core/models/__init__.py", { moduleReexports: reexports }),
    ]);

    expect(runState.moduleReexports).toEqual({ "core/models/__init__.py": reexports });
  });

  it("guards the re-export merge on the declaring relPath, not on an exported name", async () => {
    const runState = new CodegraphRunState();
    const walked = [{ exportedName: "Site", sourceModule: ".site", sourceName: "Site" }];
    runState.absorb(walkedFile("core/models/__init__.py", { moduleReexports: walked } as Partial<FileExtraction>), []);

    // Same relPath, stale content. The SKIP filter already drops a walked file's
    // own row; the guard is what makes "the walked list is the whole truth"
    // independent of that filter rather than a consequence of it.
    await runState.seal(noopTable, async () => [
      persistedSlice("core/models/__init__.py", {
        moduleReexports: [
          { exportedName: "Site", sourceModule: ".site", sourceName: "Site" },
          { exportedName: "Removed", sourceModule: ".removed", sourceName: "Removed" },
        ],
      }),
    ]);

    expect(runState.moduleReexports).toEqual({ "core/models/__init__.py": walked });
  });
});

/**
 * bd tea-rags-mcp-39xca.9 measured the Ruby `self.table_name` overrides on
 * taxdome with `scripts/spikes/incremental-runglobal-delta.ts`. When the model
 * files were not walked, 1182 of 3351 column-accessor edges disappeared, and
 * handing the full run's overrides to the incremental run brought the loss to 0.
 * The schema-column pre-pass reads this map at the barrier, so it has to hold
 * the project's overrides, not only the batch's.
 */
describe("CodegraphRunState.seal hydrates the Ruby schema-table overrides", () => {
  const rubyFile = (relPath: string, extra: Partial<FileExtraction> = {}): FileExtraction =>
    walkedFile(relPath, { language: "ruby", ...extra } as Partial<FileExtraction>);

  const rubySlice = (relPath: string, classSchemaTables: Record<string, string>): CodegraphPass1FileAggregates => ({
    relPath,
    language: "ruby",
    classSchemaTables,
  });

  it("absorbs an override declared only in a file this run did not walk", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(rubyFile("app/services/report.rb"), []);

    await runState.seal(noopTable, async () => [
      rubySlice("app/models/tax_preparation/juno/client.rb", { "TaxPreparation::Juno::Client": "juno_clients" }),
    ]);

    expect(runState.schemaTables).toEqual({ "TaxPreparation::Juno::Client": "juno_clients" });
  });

  it("never lets a hydrated override displace the one this run walked", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(
      rubyFile("app/models/firm.rb", { classSchemaTables: { Firm: "companies" } } as Partial<FileExtraction>),
      [],
    );

    await runState.seal(noopTable, async () => [rubySlice("app/models/legacy.rb", { Firm: "firms" })]);

    expect(runState.schemaTables).toEqual({ Firm: "companies" });
  });

  it("skips the row of a re-walked file, so a removed override stays gone", async () => {
    const runState = new CodegraphRunState();
    runState.absorb(rubyFile("app/models/firm.rb"), []);

    await runState.seal(noopTable, async () => [rubySlice("app/models/firm.rb", { Firm: "companies" })]);

    expect(runState.schemaTables).toEqual({});
  });
});

describe("CodegraphRunState.absorb collects the Python run-global channels", () => {
  it("unions class-key-addressed field types across files without conflating same-named classes", () => {
    const runState = new CodegraphRunState();

    runState.absorb(
      walkedFile("app/models.py", {
        classFieldTypesByClassKey: { "app/models.py::Site": { objects: "SiteQuerySet" } },
      } as Partial<FileExtraction>),
      [],
    );
    runState.absorb(
      walkedFile("core/models.py", {
        classFieldTypesByClassKey: {
          // Same short class name, different file — must stay apart.
          "core/models.py::Site": { objects: "CoreQuerySet" },
          // Same key as above, a second field — must merge, not replace.
          "app/models.py::Site": { tags: "TagManager" },
        },
      } as Partial<FileExtraction>),
      [],
    );

    expect(runState.classFieldTypesByClassKey).toEqual({
      "app/models.py::Site": { objects: "SiteQuerySet", tags: "TagManager" },
      "core/models.py::Site": { objects: "CoreQuerySet" },
    });
  });

  it("assigns a file's re-export statements under its own path so a re-walk cannot resurrect a removed one", () => {
    const runState = new CodegraphRunState();
    const reexports = [{ exportedName: "*", sourceModule: ".object_types" }];

    runState.absorb(
      walkedFile("core/models/__init__.py", { moduleReexports: reexports } as Partial<FileExtraction>),
      [],
    );
    expect(runState.moduleReexports).toEqual({ "core/models/__init__.py": reexports });

    // The file is re-walked and now re-exports only one module.
    const narrowed = [{ exportedName: "*", sourceModule: ".jobs" }];
    runState.absorb(
      walkedFile("core/models/__init__.py", { moduleReexports: narrowed } as Partial<FileExtraction>),
      [],
    );

    expect(runState.moduleReexports).toEqual({ "core/models/__init__.py": narrowed });
  });
});
