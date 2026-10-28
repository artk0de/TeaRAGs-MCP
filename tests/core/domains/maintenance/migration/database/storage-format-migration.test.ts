import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterEach, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { createDatabaseMigrationApplier } from "../../../../../../src/core/domains/maintenance/migration/database/index.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const faults = vi.hoisted(() => ({ publish: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (faults.publish) throw new Error("injected before swap");
      actual.renameSync(from, to);
    },
  };
});

afterEach(() => {
  faults.publish = false;
  vi.restoreAllMocks();
});

it("converts an old file and preserves its data and migration ledger, then does not swap it again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-format-migration-"));
  const path = join(dir, "graph.duckdb");
  const instance = await DuckDBInstance.create(path, { storage_compatibility_version: "v0.10.2" });
  const conn = await instance.connect();
  await conn.run("CREATE TABLE sample (id INTEGER PRIMARY KEY)");
  await conn.run("INSERT INTO sample VALUES (1), (2)");
  await conn.run(
    "CREATE TABLE schema_migrations (filename VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
  for (const migration of DATABASE_MIGRATIONS) {
    await conn.run(`INSERT INTO schema_migrations(filename) VALUES ('${migration.filename.replace(/'/g, "''")}')`);
  }
  await conn.run("CHECKPOINT");
  const ledger = (await conn.runAndReadAll("SELECT * FROM schema_migrations ORDER BY filename")).getRowObjectsJson();
  conn.closeSync();
  instance.closeSync();
  expect(Number(readFileSync(path).readBigUInt64LE(12))).toBe(64);
  const db = new DuckDbGraphClient({ path });
  try {
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    expect(Number(readFileSync(path).readBigUInt64LE(12))).toBe(999);
    expect(await db.queryAll("SELECT * FROM schema_migrations ORDER BY filename")).toEqual(ledger);
    expect(Number((await db.queryAll<{ n: bigint }>("SELECT count(*) AS n FROM sample"))[0].n)).toBe(2);
    const inode = statSync(path).ino;
    await runMigrations(db, DATABASE_MIGRATIONS);
    expect(statSync(path).ino).toBe(inode);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function oldDatabase(path: string): Promise<void> {
  const instance = await DuckDBInstance.create(path, { storage_compatibility_version: "v0.10.2" });
  const conn = await instance.connect();
  try {
    await conn.run("CREATE TABLE sample (id INTEGER PRIMARY KEY, value VARCHAR)");
    await conn.run(
      "CREATE TABLE schema_migrations (filename VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    );
    await conn.run("INSERT INTO schema_migrations(filename) VALUES ('fixture-completed.ts')");
    await conn.run("CREATE INDEX sample_value ON sample(value)");
    await conn.run("INSERT INTO sample VALUES (1, 'one'), (2, 'two')");
    await conn.run("CHECKPOINT");
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

it.each(["export", "import", "swap", "verify", "ledger"])(
  "failure at %s leaves the original usable and permits a retry",
  async (stage) => {
    const dir = mkdtempSync(join(tmpdir(), "cg-format-failure-"));
    const path = join(dir, "graph.duckdb");
    await oldDatabase(path);
    const inode = statSync(path).ino;
    const db = new DuckDbGraphClient({ path });
    await db.init();
    try {
      const original = DuckDBConnection.prototype.run;
      vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (
        this: DuckDBConnection,
        ...args: Parameters<typeof original>
      ) {
        const result = await original.apply(this, args);
        if (
          (stage === "export" && args[0].startsWith("EXPORT DATABASE")) ||
          (stage === "import" && args[0].startsWith("IMPORT DATABASE"))
        ) {
          throw new Error(`injected after ${stage}`);
        }
        if (stage === "verify" && args[0].startsWith("IMPORT DATABASE")) {
          await original.call(this, "DELETE FROM sample WHERE id = 2");
        }
        if (stage === "ledger" && args[0].startsWith("IMPORT DATABASE")) {
          await original.call(this, "UPDATE schema_migrations SET filename = 'tampered.ts'");
        }
        return result;
      });
      faults.publish = stage === "swap";
      await expect(createDatabaseMigrationApplier()(db)).rejects.toMatchObject({
        code: "INFRA_CODEGRAPH_STORAGE_CONVERSION_FAILED",
      });
      expect(statSync(path).ino).toBe(inode);
      expect(Number(readFileSync(path).readBigUInt64LE(12))).toBe(64);
      expect(await db.queryAll("SELECT * FROM sample ORDER BY id")).toEqual([
        { id: 1, value: "one" },
        { id: 2, value: "two" },
      ]);
      expect(readdirSync(dir).filter((name) => /compact-tmp|storage-export/.test(name))).toEqual([]);
      await db.close();
      const reopened = new DuckDbGraphClient({ path });
      try {
        await reopened.init();
        expect(await reopened.queryAll("SELECT * FROM sample ORDER BY id")).toEqual([
          { id: 1, value: "one" },
          { id: 2, value: "two" },
        ]);
        vi.restoreAllMocks();
        faults.publish = false;
        await createDatabaseMigrationApplier()(reopened);
        expect(Number(readFileSync(path).readBigUInt64LE(12))).toBe(999);
      } finally {
        await reopened.close();
      }
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("a second session holding the file blocks conversion through the native writer lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-format-lock-"));
  const path = join(dir, "graph.duckdb");
  await oldDatabase(path);
  const modulePath = import.meta.resolve("@duckdb/node-api");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DuckDBInstance } from ${JSON.stringify(modulePath)};
    const instance = await DuckDBInstance.create(process.argv[1]);
    const conn = await instance.connect();
    process.send('ready');
    process.on('message', () => { conn.closeSync(); instance.closeSync(); process.exit(0); });
  `,
      path,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const db = new DuckDbGraphClient({ path });
  try {
    await once(child, "message");
    await expect(db.init()).rejects.toThrow(/lock/i);
    expect(Number(readFileSync(path).readBigUInt64LE(12))).toBe(64);
  } finally {
    const exited = once(child, "exit");
    child.send("close");
    await exited;
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("records the storage migration in the startup ledger and checkpoints it for a read-only opener", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-format-startup-"));
  const path = join(dir, "graph.duckdb");
  await oldDatabase(path);
  const db = new DuckDbGraphClient({ path });
  try {
    await db.init();
    await createDatabaseMigrationApplier()(db);
    expect(
      await db.queryAll("SELECT filename FROM schema_migrations WHERE filename = '069-cg-storage-format-2.ts'"),
    ).toEqual([{ filename: "069-cg-storage-format-2.ts" }]);
    const inode = statSync(path).ino;
    await createDatabaseMigrationApplier()(db);
    expect(statSync(path).ino).toBe(inode);
    await db.close();
    const reader = new DuckDbGraphClient({ path, accessMode: "READ_ONLY" });
    try {
      await reader.init();
      expect(await reader.queryAll("SELECT * FROM sample ORDER BY id")).toHaveLength(2);
      expect(
        await reader.queryAll("SELECT filename FROM schema_migrations WHERE filename = '069-cg-storage-format-2.ts'"),
      ).toHaveLength(1);
    } finally {
      await reader.close();
    }
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("conversion and its idempotent rerun retain the native writer lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-format-retain-lock-"));
  const path = join(dir, "graph.duckdb");
  await oldDatabase(path);
  const db = new DuckDbGraphClient({ path });
  try {
    await db.init();
    for (let attempt = 0; attempt < 2; attempt++) {
      await createDatabaseMigrationApplier()(db);
      // Do not open/close another fd to this inode in the writer process:
      // POSIX would release DuckDB's fcntl locks, even for a header-only read.
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { DuckDBInstance } from ${JSON.stringify(import.meta.resolve("@duckdb/node-api"))};
        try {
          const instance = await DuckDBInstance.create(process.argv[1]);
          instance.closeSync();
          process.exit(0);
        } catch (err) {
          process.stderr.write(String(err));
          process.exit(1);
        }
      `,
          path,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      expect(child.status).toBe(1);
      expect(child.stderr).toMatch(/lock/i);
    }
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
