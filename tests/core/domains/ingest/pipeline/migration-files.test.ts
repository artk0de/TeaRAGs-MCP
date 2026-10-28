import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverMigrationFiles } from "../../../../../src/core/domains/ingest/pipeline/migration-files.js";

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
    expect((await discoverMigrationFiles(root)).sort()).toEqual([
      join(root, "db/migrate/20261028000000_orders.rb"),
      join(root, "engines/sales/db/migrate/20261028000001_vendors.rb"),
    ]);
  });
});
