/**
 * The provider config a working-tree graph build runs with (bd s3i8m.6 R2b):
 * the index run's config bound to the build's output, with rust-analyzer
 * narrowed to the SCIP cache — the build's wall budget cannot host a spawn.
 */
import { describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../../__helpers__/collection-identity.js";
import {
  treeBuildProviderConfig,
  type WorkingTreeGraphProviderConfig,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-build.js";

const BASE: WorkingTreeGraphProviderConfig = {
  languageModulePath: "/lang.js",
  migrationsModulePath: "/migrations.js",
  customExcludePatterns: [],
};
const PHYSICAL = fixturePhysicalCollectionName("code_x__wt");

describe("treeBuildProviderConfig (bd s3i8m.6 R2b)", () => {
  it("binds the build's output root and collection", () => {
    const config = treeBuildProviderConfig({
      providerConfig: BASE,
      outputRoot: "/out",
      physicalCollectionName: PHYSICAL,
    });

    expect(config).toEqual({ ...BASE, rootDir: "/out", collectionName: PHYSICAL });
  });

  it("forces spawn: never on the rust-analyzer slot, keeping the rest of it", () => {
    const rustAnalyzer = { enabled: true, exec: false, timeoutSec: 900, maxRssMb: 4096, spawn: "allowed" as const };
    const config = treeBuildProviderConfig({
      providerConfig: { ...BASE, rustAnalyzer },
      outputRoot: "/out",
      physicalCollectionName: PHYSICAL,
    });

    expect(config.rustAnalyzer).toEqual({ ...rustAnalyzer, spawn: "never" });
  });

  it("forces spawn: never on the rustc driver slot too (bd s3i8m T8): no cargo check under the wall budget", () => {
    const rustDriver = { enabled: true, timeoutSec: 3600, maxRssMb: 12_288, spawn: "allowed" as const };
    const config = treeBuildProviderConfig({
      providerConfig: { ...BASE, rustDriver },
      outputRoot: "/out",
      physicalCollectionName: PHYSICAL,
    });

    expect(config.rustDriver).toEqual({ ...rustDriver, spawn: "never" });
  });
});
