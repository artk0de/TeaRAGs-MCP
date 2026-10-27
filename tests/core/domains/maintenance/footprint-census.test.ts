import { describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import {
  classifyCollectionFootprints,
  type FootprintInventory,
} from "../../../../src/core/domains/maintenance/footprint/census.js";

type InventoryInput = Partial<Omit<FootprintInventory, "physicalCollections" | "codegraphGenerations">> & {
  physicalCollections?: string[];
  codegraphGenerations?: string[];
};

function inventory(over: InventoryInput = {}): FootprintInventory {
  const { physicalCollections = [], codegraphGenerations = [], ...rest } = over;
  return {
    aliases: [],
    registrations: [],
    storeLogicals: [],
    inUse: new Map(),
    ...rest,
    physicalCollections: physicalCollections.map(fixturePhysicalCollectionName),
    codegraphGenerations: codegraphGenerations.map(fixturePhysicalCollectionName),
  };
}

/** A registered project whose directory exists, alias `code_live` → `code_live_v2`. */
const liveProject: InventoryInput = {
  physicalCollections: ["code_live_v2"],
  aliases: [{ aliasName: "code_live", collectionName: "code_live_v2" }],
  registrations: [{ collectionName: "code_live", name: "live", path: "/repo", pathExists: true }],
  codegraphGenerations: ["code_live_v2"],
  storeLogicals: ["code_live"],
};

describe("classifyCollectionFootprints", () => {
  it("reports nothing for a live registered project", () => {
    expect(classifyCollectionFootprints(inventory(liveProject))).toEqual([]);
  });

  it("classifies a registration with an empty path as dead and purges the whole collection", () => {
    const findings = classifyCollectionFootprints(
      inventory({
        physicalCollections: ["code_gone_v1"],
        aliases: [{ aliasName: "code_gone", collectionName: "code_gone_v1" }],
        registrations: [{ collectionName: "code_gone", name: null, path: "", pathExists: false }],
        codegraphGenerations: ["code_gone_v1"],
      }),
    );

    expect(findings).toEqual([
      {
        findingClass: "dead-registration",
        logicalName: "code_gone",
        physicalName: "code_gone_v1",
        reason: "registry entry has no project path",
        action: { kind: "collection", logicalName: "code_gone", registryEntry: "code_gone" },
      },
    ]);
  });

  it("classifies a registration whose directory is gone, and keeps a named one with a hint", () => {
    const findings = classifyCollectionFootprints(
      inventory({
        registrations: [
          { collectionName: "code_a", name: null, path: "/gone/a", pathExists: false },
          { collectionName: "code_b", name: "bee", path: "/gone/b", pathExists: false },
        ],
      }),
    );

    expect(findings.map((f) => [f.logicalName, f.reason, f.blockedBy])).toEqual([
      ["code_a", "project directory /gone/a is gone", undefined],
      [
        "code_b",
        "project directory /gone/b is gone",
        "named 'bee' — re-register it to adopt, or 'tea-rags projects unregister --name bee --purge'",
      ],
    ]);
    expect(findings[0]?.action).toEqual({
      kind: "collection",
      logicalName: "code_a",
      path: "/gone/a",
      registryEntry: "code_a",
    });
  });

  it("classifies an alias with no registry entry", () => {
    const findings = classifyCollectionFootprints(
      inventory({
        physicalCollections: ["code_x_v1", "code_x_v2"],
        aliases: [{ aliasName: "code_x", collectionName: "code_x_v2" }],
      }),
    );

    expect(findings.map((f) => [f.findingClass, f.physicalName, f.action.kind])).toEqual([
      ["unregistered-alias", "code_x_v2", "collection"],
    ]);
  });

  it("addresses an orphan generation of a live project by its physical name only", () => {
    const findings = classifyCollectionFootprints(
      inventory({ ...liveProject, physicalCollections: ["code_live_v1", "code_live_v2"] }),
    );

    expect(findings).toEqual([
      {
        findingClass: "orphan-generation",
        logicalName: "code_live",
        physicalName: "code_live_v1",
        reason: "alias 'code_live' points at code_live_v2",
        action: { kind: "generation", logicalName: "code_live", physicalName: "code_live_v1" },
      },
    ]);
  });

  it("never plans a collection-level purge for a logical name with a live registration", () => {
    const findings = classifyCollectionFootprints(
      inventory({
        ...liveProject,
        physicalCollections: ["code_live_v1", "code_live_v2"],
        codegraphGenerations: ["code_live_v1", "code_live_v2"],
      }),
    );

    const collectionPurges = findings.filter((f) => f.action.kind === "collection");
    expect(collectionPurges).toEqual([]);
    expect(findings.map((f) => f.findingClass)).toEqual(["orphan-generation"]);
  });

  it("classifies an unaliased, unregistered collection as an orphan collection", () => {
    const findings = classifyCollectionFootprints(inventory({ physicalCollections: ["code_lost_v1"] }));

    expect(findings.map((f) => [f.findingClass, f.physicalName, f.action])).toEqual([
      ["orphan-collection", "code_lost_v1", { kind: "collection", logicalName: "code_lost" }],
    ]);
  });

  it("classifies a codegraph generation with no Qdrant collection behind it", () => {
    const findings = classifyCollectionFootprints(
      inventory({ ...liveProject, codegraphGenerations: ["code_live_v1", "code_live_v2", "code_dead_v4"] }),
    );

    expect(findings.map((f) => [f.findingClass, f.physicalName, f.action])).toEqual([
      [
        "orphan-codegraph",
        "code_live_v1",
        { kind: "generation", logicalName: "code_live", physicalName: "code_live_v1" },
      ],
      ["orphan-codegraph", "code_dead_v4", { kind: "collection", logicalName: "code_dead" }],
    ]);
  });

  it("classifies alias-keyed stores nothing else claims", () => {
    const findings = classifyCollectionFootprints(
      inventory({ ...liveProject, storeLogicals: ["code_live", "code_old"] }),
    );

    expect(findings.map((f) => [f.findingClass, f.logicalName, f.physicalName])).toEqual([
      ["store-leftover", "code_old", null],
    ]);
  });

  it("reports a footprint once, under the class that purges it", () => {
    const findings = classifyCollectionFootprints(
      inventory({
        physicalCollections: ["code_x_v1", "code_x_v2"],
        aliases: [{ aliasName: "code_x", collectionName: "code_x_v2" }],
        codegraphGenerations: ["code_x_v1", "code_x_v0"],
        storeLogicals: ["code_x"],
      }),
    );

    expect(findings.map((f) => f.findingClass)).toEqual(["unregistered-alias"]);
  });

  it("blocks a finding whose collection is in use", () => {
    const findings = classifyCollectionFootprints(
      inventory({
        physicalCollections: ["code_x_v1"],
        aliases: [{ aliasName: "code_x", collectionName: "code_x_v1" }],
        inUse: new Map([["code_x", "indexing lock held by a live run"]]),
      }),
    );

    expect(findings[0]?.blockedBy).toBe("in use: indexing lock held by a live run");
  });
});
