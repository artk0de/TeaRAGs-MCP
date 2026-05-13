import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listProjectNames, maybeCompleteProjectName } from "../../src/cli/completion.js";
import { CollectionRegistry } from "../../src/core/infra/registry/collection-registry.js";

describe("CLI completion helpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-comp-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  describe("listProjectNames", () => {
    it("returns empty array when registry has no entries", () => {
      expect(listProjectNames()).toEqual([]);
    });

    it("returns registered alias names sorted by registry order", () => {
      const repoA = join(dir, "a");
      const repoB = join(dir, "b");
      mkdirSync(repoA);
      mkdirSync(repoB);
      writeFileSync(join(repoA, ".keep"), "");
      writeFileSync(join(repoB, ".keep"), "");
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_a",
        path: repoA,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_a", "alpha");
      reg.record({
        collectionName: "code_b",
        path: repoB,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_b", "bravo");

      expect(listProjectNames().sort()).toEqual(["alpha", "bravo"]);
    });

    it("skips entries with null/empty name (auto-recovered stubs)", () => {
      const repo = join(dir, "repo");
      mkdirSync(repo);
      writeFileSync(join(repo, ".keep"), "");
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_stub",
        path: repo,
        embeddingModel: "",
        embeddingDimensions: 0,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      // No setName → name is null.
      expect(listProjectNames()).toEqual([]);
    });

    it("returns [] when registry directory is unreadable", () => {
      process.env.TEA_RAGS_DATA_DIR = "/proc/0/missing";
      expect(listProjectNames()).toEqual([]);
    });
  });

  describe("maybeCompleteProjectName", () => {
    function seedAlpha(): void {
      const repo = join(dir, "repo");
      mkdirSync(repo);
      writeFileSync(join(repo, ".keep"), "");
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_a",
        path: repo,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_a", "alpha");
    }

    it("completes --project after any command", () => {
      seedAlpha();
      expect(maybeCompleteProjectName(["tune", "--project", ""], ["tune"])).toEqual(["alpha"]);
      expect(maybeCompleteProjectName(["prime", "--project", ""], ["prime"])).toEqual(["alpha"]);
    });

    it("completes -p short alias", () => {
      seedAlpha();
      expect(maybeCompleteProjectName(["tune", "-p", ""], ["tune"])).toEqual(["alpha"]);
    });

    it("completes --name for 'projects unregister' and 'projects info'", () => {
      seedAlpha();
      expect(maybeCompleteProjectName(["projects", "unregister", "--name", ""], ["projects", "unregister"])).toEqual([
        "alpha",
      ]);
      expect(maybeCompleteProjectName(["projects", "info", "--name", ""], ["projects", "info"])).toEqual(["alpha"]);
    });

    it("does NOT complete --name for 'projects register' (new alias being invented)", () => {
      seedAlpha();
      expect(maybeCompleteProjectName(["projects", "register", "--name", ""], ["projects", "register"])).toBeNull();
    });

    it("returns null when previous token is not a name/project flag", () => {
      seedAlpha();
      expect(maybeCompleteProjectName(["tune", "--qdrant-url", ""], ["tune"])).toBeNull();
      expect(maybeCompleteProjectName(["projects", "list"], ["projects", "list"])).toBeNull();
    });

    it("returns null when --name is used outside the projects group", () => {
      seedAlpha();
      // Hypothetical: some other command uses --name. Don't suggest aliases there.
      expect(maybeCompleteProjectName(["server", "--name", ""], ["server"])).toBeNull();
    });
  });
});
