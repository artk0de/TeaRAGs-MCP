import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverMigrationFiles } from "../../../../../src/core/domains/ingest/pipeline/migration-files.js";
import { FileScanner } from "../../../../../src/core/domains/ingest/pipeline/scanner.js";

async function loadedScanner(root: string): Promise<FileScanner> {
  const scanner = new FileScanner({ supportedExtensions: [".rb"], ignorePatterns: [] });
  await scanner.loadIgnorePatterns(root);
  return scanner;
}

describe("migration discovery", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("discovers migrations under ignored db directories and nested engines without following symlinks", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-test-"));
    await mkdir(join(root, "db/migrate"), { recursive: true });
    await mkdir(join(root, "engines/sales/db/migrate"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "db/\n");
    await writeFile(join(root, "db/migrate/20261028000000_orders.rb"), "class Orders; end");
    await writeFile(join(root, "db/schema.rb"), "schema");
    await writeFile(join(root, "engines/sales/db/migrate/20261028000001_vendors.rb"), "class Vendors; end");
    await symlink(join(root, "db"), join(root, "linked"));
    expect((await discoverMigrationFiles(root, await loadedScanner(root))).sort()).toEqual([
      join(root, "db/migrate/20261028000000_orders.rb"),
      join(root, "engines/sales/db/migrate/20261028000001_vendors.rb"),
    ]);
  });

  it("skips migrations under directories the project's ignore files exclude from the code index", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-test-"));
    await mkdir(join(root, "db/migrate"), { recursive: true });
    await mkdir(join(root, ".claude/worktrees/a/db/migrate"), { recursive: true });
    await mkdir(join(root, "vendor/gems/billing/db/migrate"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".claude/worktrees/\n");
    await writeFile(join(root, ".contextignore"), "vendor/\n");
    await writeFile(join(root, "db/migrate/20261028000000_orders.rb"), "class Orders; end");
    await writeFile(join(root, ".claude/worktrees/a/db/migrate/20261028000000_orders.rb"), "class Orders; end");
    await writeFile(join(root, "vendor/gems/billing/db/migrate/20261028000002_invoices.rb"), "class Invoices; end");
    expect(await discoverMigrationFiles(root, await loadedScanner(root))).toEqual([
      join(root, "db/migrate/20261028000000_orders.rb"),
    ]);
  });
});
