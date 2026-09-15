import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { fixtureCollectionAlias } from "../__helpers__/collection-identity.js";
import {
  collectionAliasEntryFromQdrant,
  physicalCollectionNameFromDaemonRequest,
  resolveCollectionName,
  validatePath,
  versionedPhysicalCollectionName,
} from "../../../src/core/infra/collection-name.js";

describe("collection-name utilities", () => {
  describe("resolveCollectionName", () => {
    it("generates deterministic name from path", () => {
      const name = resolveCollectionName("/tmp/test-project");
      expect(name).toMatch(/^code_[a-f0-9]{8}$/);
    });

    it("returns same name for same path", () => {
      const a = resolveCollectionName("/tmp/test-project");
      const b = resolveCollectionName("/tmp/test-project");
      expect(a).toBe(b);
    });

    it("returns different names for different paths", () => {
      const a = resolveCollectionName("/tmp/project-a");
      const b = resolveCollectionName("/tmp/project-b");
      expect(a).not.toBe(b);
    });
  });

  describe("validatePath", () => {
    it("resolves existing path", async () => {
      const expected = await realpath("/tmp");
      const result = await validatePath("/tmp");
      expect(result).toBe(expected);
    });

    it("returns absolute path for non-existent path", async () => {
      const result = await validatePath("/nonexistent/path");
      expect(result).toBe("/nonexistent/path");
    });
  });

  describe("versionedPhysicalCollectionName (39xca.1)", () => {
    it("names generation N of a logical collection <alias>_v<N>", () => {
      expect(versionedPhysicalCollectionName(fixtureCollectionAlias("code_8b243ffe"), 3)).toBe("code_8b243ffe_v3");
    });

    it.each([0, -1, 1.5, Number.NaN])("refuses version %s — generations are numbered from 1", (version) => {
      expect(() => versionedPhysicalCollectionName(fixtureCollectionAlias("code_x"), version)).toThrow(RangeError);
    });
  });

  describe("physicalCollectionNameFromDaemonRequest (39xca.1)", () => {
    it("reads the collection a daemon request names", () => {
      expect(physicalCollectionNameFromDaemonRequest("code_x_v3")).toBe("code_x_v3");
    });

    it.each([undefined, 42, ""])("rejects a request whose collection is %s", (value) => {
      // Matched on the field it names: a bare `TypeError` would also be satisfied
      // by calling a function that does not exist.
      expect(() => physicalCollectionNameFromDaemonRequest(value)).toThrow(/collection/);
    });
  });

  describe("collectionAliasEntryFromQdrant (39xca.1)", () => {
    it("maps Qdrant's alias description onto the logical name and the physical collection it targets", () => {
      expect(collectionAliasEntryFromQdrant({ alias_name: "code_x", collection_name: "code_x_v4" })).toEqual({
        aliasName: "code_x",
        collectionName: "code_x_v4",
      });
    });
  });
});
