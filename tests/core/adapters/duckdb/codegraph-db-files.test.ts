import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEGRAPH_DB_ARTIFACT_TAXONOMY,
  CodegraphDbFiles,
  compactionStagingPath,
  type CodegraphDbArtifactDescriptor,
  type CodegraphDbArtifactId,
  type CodegraphDbArtifactOperation,
} from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";
import { CodegraphShadowDatabaseRefusedError } from "../../../../src/core/adapters/duckdb/errors.js";
import type { PhysicalCollectionName } from "../../../../src/core/contracts/types/collection-identity.js";

describe("CodegraphDbFiles", () => {
  let root: string;
  let codegraphDir: string;
  let files: CodegraphDbFiles;

  function seed(name: string, contents = "db"): void {
    writeFileSync(join(codegraphDir, `${name}.duckdb`), contents);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cg-files-"));
    codegraphDir = join(root, "codegraph");
    mkdirSync(codegraphDir, { recursive: true });
    files = new CodegraphDbFiles(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("constructing it does not create or wipe anything under the root", () => {
    const fresh = mkdtempSync(join(tmpdir(), "cg-untouched-"));
    try {
      const spill = join(fresh, "codegraph", ".spill");
      mkdirSync(spill, { recursive: true });
      writeFileSync(join(spill, "in-flight.ndjson"), "x");

      new CodegraphDbFiles(fresh);

      // A concurrent index owns that spill file — pool CONSTRUCTION wipes it,
      // which is exactly why the purge path may not construct a pool.
      expect(existsSync(join(spill, "in-flight.ndjson"))).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("lists the unversioned DB and every _vN generation, and nothing else", () => {
    seed("code_a");
    seed("code_a_v1");
    seed("code_a_v12");
    seed("code_ab_v1");
    seed("code_a_worktree_v1");
    writeFileSync(join(codegraphDir, "code_a_v1.duckdb.wal"), "wal");

    expect(files.listCollectionDbNames("code_a").sort()).toEqual(["code_a", "code_a_v1", "code_a_v12"]);
  });

  it("returns an empty list when the codegraph directory does not exist", () => {
    const missing = new CodegraphDbFiles(join(root, "nope"));
    expect(missing.listCollectionDbNames("code_a")).toEqual([]);
  });

  it("removes the DB and its WAL sidecar together", async () => {
    seed("code_a_v1");
    writeFileSync(join(codegraphDir, "code_a_v1.duckdb.wal"), "wal");

    await files.removeCollection("code_a_v1");

    expect(existsSync(join(codegraphDir, "code_a_v1.duckdb"))).toBe(false);
    expect(existsSync(join(codegraphDir, "code_a_v1.duckdb.wal"))).toBe(false);
  });

  describe("cross-pass input spill (.xpass)", () => {
    function seedSpill(name: string): string {
      const xpass = join(codegraphDir, ".xpass");
      mkdirSync(xpass, { recursive: true });
      const path = join(xpass, `${name}.ndjson`);
      writeFileSync(path, "{}\n");
      return path;
    }

    it("resolves the spill path under .xpass, keyed by the physical generation", () => {
      expect(files.inputSpillPathFor("code_a_v3")).toBe(join(codegraphDir, ".xpass", "code_a_v3.ndjson"));
    });

    it("removing a generation removes its spill with it", async () => {
      seed("code_a_v1");
      const spill = seedSpill("code_a_v1");
      const other = seedSpill("code_a_v2");

      await files.removeCollection("code_a_v1");

      expect(existsSync(spill)).toBe(false);
      expect(existsSync(other)).toBe(true);
    });

    it("removes a spill whose generation has no database at all", async () => {
      const spill = seedSpill("code_a_v7");

      await files.removeCollection("code_a_v7");

      expect(existsSync(spill)).toBe(false);
    });

    it("lists spill-only generations beside database generations, scoped to the base", () => {
      seed("code_a_v1");
      seedSpill("code_a_v1");
      seedSpill("code_a_v5");
      seedSpill("code_ab_v1");
      seedSpill("code_a_worktree_v1");

      expect(files.listCollectionGenerationNames("code_a").sort()).toEqual(["code_a_v1", "code_a_v5"]);
      // The DB listing stays database-only: a spill is not a graph.
      expect(files.listCollectionDbNames("code_a")).toEqual(["code_a_v1"]);
    });

    it("lists generations when only the database directory exists", () => {
      seed("code_a_v2");
      expect(files.listCollectionGenerationNames("code_a")).toEqual(["code_a_v2"]);
    });
  });

  it("is idempotent — removing an absent collection resolves", async () => {
    await expect(files.removeCollection("code_never")).resolves.not.toThrow();
  });

  it("copies the DB and its WAL sidecar on clone", async () => {
    seed("code_src", "payload");
    writeFileSync(join(codegraphDir, "code_src.duckdb.wal"), "walbytes");

    await files.cloneDatabase("code_src", "code_dst");

    expect(readFileSync(join(codegraphDir, "code_dst.duckdb"), "utf-8")).toBe("payload");
    expect(readFileSync(join(codegraphDir, "code_dst.duckdb.wal"), "utf-8")).toBe("walbytes");
  });

  it("drops a stale target WAL when the source has none", async () => {
    seed("code_src", "payload");
    seed("code_dst", "old");
    writeFileSync(join(codegraphDir, "code_dst.duckdb.wal"), "previous tenant");

    await files.cloneDatabase("code_src", "code_dst");

    expect(existsSync(join(codegraphDir, "code_dst.duckdb.wal"))).toBe(false);
  });

  it("clone is a no-op when the source DB is absent", async () => {
    await files.cloneDatabase("code_missing", "code_dst");
    expect(existsSync(join(codegraphDir, "code_dst.duckdb"))).toBe(false);
  });

  describe("artifact taxonomy — the on-disk set equals exactly what the taxonomy predicts", () => {
    const STEMS: readonly PhysicalCollectionName[] = [
      "code_a",
      "code_a_v1",
      "code_a_v2",
      "code_b",
      "code_b_v1",
      "code_ab_v1",
    ];
    const BASES = ["code_a", "code_b"] as const;

    /** Taxonomy lookup that fails loudly rather than returning undefined. */
    function artifact(id: CodegraphDbArtifactId): CodegraphDbArtifactDescriptor {
      const row = CODEGRAPH_DB_ARTIFACT_TAXONOMY.find((candidate) => candidate.id === id);
      if (!row) throw new Error(`taxonomy row ${id} is missing`);
      return row;
    }

    const databaseArtifact = artifact("database");
    const walSidecarArtifact = artifact("wal-sidecar");
    const spillArtifact = artifact("cross-pass-input-spill");

    /** Root-relative predicted path of one artifact of one stem. */
    function predictedPath(stem: string, descriptor: CodegraphDbArtifactDescriptor): string {
      const leaf = descriptor.filenamePattern.replace("<stem>", stem);
      return ["codegraph", descriptor.directory, leaf].filter((part) => part !== ".").join("/");
    }

    /** Absolute path of one artifact of one stem — the REAL location, driven by the table. */
    function artifactPath(stem: string, descriptor: CodegraphDbArtifactDescriptor): string {
      return join(root, predictedPath(stem, descriptor));
    }

    /** Every file currently under the scenario root (mirrors daemon/single-instance.test.ts). */
    function diskFiles(): string[] {
      return readdirSync(root, { recursive: true, encoding: "utf-8" })
        .filter((entry) => statSync(join(root, entry)).isFile())
        .sort();
    }

    function stemBelongsToBase(stem: string, base: string): boolean {
      return stem === base || new RegExp(`^${base}_v\\d+$`).test(stem);
    }

    async function runScenario(seedValue: number, opCount: number): Promise<void> {
      // Deterministic LCG: op sequences are arbitrary yet reproducible per seed.
      let rngState = seedValue >>> 0;
      const rng = (): number => {
        rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
        return rngState / 2 ** 32;
      };
      const pickStem = (): PhysicalCollectionName => STEMS[Math.floor(rng() * STEMS.length)];

      const predicted = new Set<string>();
      const hasDb = (stem: string): boolean => predicted.has(predictedPath(stem, databaseArtifact));
      const hasWal = (stem: string): boolean => predicted.has(predictedPath(stem, walSidecarArtifact));
      const removeByLifecycle = (stem: string, operation: CodegraphDbArtifactOperation): void => {
        for (const row of CODEGRAPH_DB_ARTIFACT_TAXONOMY) {
          if (row.removedBy.includes(operation)) predicted.delete(predictedPath(stem, row));
        }
      };

      /** The clone contract the table states: kept rows untouched, the rest
       *  cleared, the database republished, the WAL travelling with it. */
      const applyCloneToPredicted = (source: string, target: string): void => {
        const sourceHasWal = hasWal(source);
        for (const row of CODEGRAPH_DB_ARTIFACT_TAXONOMY) {
          if (row.keptAcrossClone) continue;
          predicted.delete(predictedPath(target, row));
        }
        predicted.add(predictedPath(target, databaseArtifact));
        if (sourceHasWal) predicted.add(predictedPath(target, walSidecarArtifact));
      };

      const assertDiskEqualsPrediction = (step: number, what: string): void => {
        const actual = new Set(diskFiles());
        const orphans = [...actual].filter((path) => !predicted.has(path)).sort();
        const stragglers = [...predicted].filter((path) => !actual.has(path)).sort();
        expect(orphans, `step ${step} (${what}) — files on disk the taxonomy does not predict`).toEqual([]);
        expect(stragglers, `step ${step} (${what}) — files the taxonomy predicts that are missing`).toEqual([]);
      };

      const assertListingsEqualPrediction = (): void => {
        for (const base of BASES) {
          const expectedDbNames = STEMS.filter(
            (stem) => predicted.has(predictedPath(stem, databaseArtifact)) && stemBelongsToBase(stem, base),
          ).sort();
          expect(files.listCollectionDbNames(base).sort(), `listCollectionDbNames(${base})`).toEqual(expectedDbNames);
          const expectedGenerationNames = STEMS.filter(
            (stem) =>
              (predicted.has(predictedPath(stem, databaseArtifact)) ||
                predicted.has(predictedPath(stem, spillArtifact))) &&
              stemBelongsToBase(stem, base),
          ).sort();
          expect(files.listCollectionGenerationNames(base).sort(), `listCollectionGenerationNames(${base})`).toEqual(
            expectedGenerationNames,
          );
        }
      };

      for (let step = 0; step < opCount; step += 1) {
        const stem = pickStem();
        const op = Math.floor(rng() * 8);
        switch (op) {
          // The DuckDB driver materialises a generation database.
          case 0:
            writeFileSync(files.pathFor(stem), "db");
            predicted.add(predictedPath(stem, databaseArtifact));
            break;
          // The driver leaves a WAL tail beside it — including the "kept
          // writing after the database was unlinked" shape (amh78).
          case 1:
            writeFileSync(artifactPath(stem, walSidecarArtifact), "wal");
            predicted.add(predictedPath(stem, walSidecarArtifact));
            break;
          // The pipeline appends the generation's cross-pass input spill.
          case 2:
            mkdirSync(files.inputSpillDir, { recursive: true });
            writeFileSync(files.inputSpillPathFor(stem), "{}\n");
            predicted.add(predictedPath(stem, spillArtifact));
            break;
          // A SIGKILL between copyFile and rename left clone staging behind.
          case 3: {
            writeFileSync(artifactPath(stem, artifact("clone-staging-database")), "half");
            predicted.add(predictedPath(stem, artifact("clone-staging-database")));
            if (rng() < 0.5) {
              writeFileSync(artifactPath(stem, artifact("clone-staging-wal")), "half");
              predicted.add(predictedPath(stem, artifact("clone-staging-wal")));
            }
            break;
          }
          // An interrupted compaction left its staging behind.
          case 4: {
            writeFileSync(compactionStagingPath(files.pathFor(stem)), "half");
            predicted.add(predictedPath(stem, artifact("compaction-staging-database")));
            if (rng() < 0.5) {
              writeFileSync(`${compactionStagingPath(files.pathFor(stem))}.wal`, "half");
              predicted.add(predictedPath(stem, artifact("compaction-staging-wal")));
            }
            break;
          }
          // cloneDatabase — no-op without a source database, refused for a
          // shadow base, otherwise publishing per the table's clone column.
          case 5: {
            const source = pickStem();
            const target = pickStem();
            const shadowRefusal =
              hasDb(source) &&
              !hasDb(target) &&
              STEMS.some(
                (candidate) => candidate !== target && stemBelongsToBase(candidate, target) && hasDb(candidate),
              );
            if (shadowRefusal) {
              await expect(files.cloneDatabase(source, target)).rejects.toBeInstanceOf(
                CodegraphShadowDatabaseRefusedError,
              );
            } else {
              await files.cloneDatabase(source, target);
              if (hasDb(source)) applyCloneToPredicted(source, target);
            }
            break;
          }
          // removeCollection — the remove-files lifecycle column of the table.
          case 6:
            await files.removeCollection(stem);
            removeByLifecycle(stem, "remove-files");
            break;
          // discardOrphanedWal — takes the sidecar only when its database is gone.
          default:
            await files.discardOrphanedWal(stem);
            if (!hasDb(stem)) predicted.delete(predictedPath(stem, walSidecarArtifact));
            break;
        }
        assertDiskEqualsPrediction(step, `op ${op} on ${stem}`);
        assertListingsEqualPrediction();
      }
    }

    it.each([0x5eed01, 0x5eed02, 0x5eed03])(
      "seed %i: after every op of a 60-op sequence the disk set equals the taxonomy",
      async (seedValue: number) => {
        await runScenario(seedValue, 60);
      },
    );

    it("removeFiles reclaims the compaction staging pair and the clone staging pair alike", async () => {
      seed("code_a_v1");
      writeFileSync(compactionStagingPath(join(codegraphDir, "code_a_v1.duckdb")), "half");
      writeFileSync(join(codegraphDir, "code_a_v1.duckdb.clone-tmp"), "half");
      writeFileSync(join(codegraphDir, "code_a_v1.duckdb.clone-tmp.wal"), "half");

      await files.removeCollection("code_a_v1");

      // A purge takes both staging pairs: an interrupted clone's leftovers are
      // this database's files too, not something to leave for the next clone
      // (bd tea-rags-mcp-0qaht.26).
      expect(existsSync(join(codegraphDir, "code_a_v1.duckdb.compact-tmp"))).toBe(false);
      expect(existsSync(join(codegraphDir, "code_a_v1.duckdb.clone-tmp"))).toBe(false);
      expect(existsSync(join(codegraphDir, "code_a_v1.duckdb.clone-tmp.wal"))).toBe(false);
    });

    it("a shadow-refused clone leaves the disk untouched", async () => {
      seed("code_a_v1");

      await expect(files.cloneDatabase("code_a_v1", "code_a")).rejects.toBeInstanceOf(
        CodegraphShadowDatabaseRefusedError,
      );

      expect(diskFiles()).toEqual(["codegraph/code_a_v1.duckdb"]);
    });
  });
});
