/**
 * Setting a project's env from configuration (bd tea-rags-mcp-5uk75).
 *
 * `register` accepts an env, and `editEnv` edits (sets / unsets) it on an
 * existing entry. Keys are validated against the registry's own env
 * vocabulary (`REGISTRY_ENV_ALLOWLIST`) — an unknown key is a typed input
 * error, never a silent accept — and every write goes through the registry's
 * CAS flush, so a FRESH registry instance reads it back from disk.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InvalidParameterError,
  ProjectEnvKeyUnknownError,
  ProjectNotRegisteredError,
} from "../../../../../src/core/api/errors.js";
import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { ConfigValueInvalidError } from "../../../../../src/core/infra/errors.js";

describe("ProjectRegistryOps — project env", () => {
  let dir: string;
  let repo: string;
  let ops: ProjectRegistryOps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pro-env-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    ops = new ProjectRegistryOps({ registry: new CollectionRegistry(dir) });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** What a brand-new process would read — proves the write went through the flush. */
  function onDisk(name: string) {
    return new CollectionRegistry(dir).findByName(name);
  }

  describe("register({ env })", () => {
    it("persists the env, canonicalized, together with the alias", async () => {
      await ops.register({
        path: repo,
        name: "alpha",
        env: { CODE_CHUNK_SIZE: "2500", CODEGRAPH_ENABLED: "true" },
      });
      const entry = onDisk("alpha");
      expect(entry?.env).toEqual({ INGEST_CHUNK_SIZE: "2500" });
      expect(entry?.codegraphEnabled).toBe(true);
    });

    it("rejects an unknown key before registering anything", async () => {
      await expect(ops.register({ path: repo, name: "alpha", env: { NOT_A_KEY: "1" } })).rejects.toThrow(
        ProjectEnvKeyUnknownError,
      );
      expect(onDisk("alpha")).toBeNull();
    });
  });

  describe("editEnv", () => {
    beforeEach(async () => {
      await ops.register({ path: repo, name: "alpha" });
    });

    it("sets keys on an existing entry and persists them", () => {
      const updated = ops.editEnv({ name: "alpha", set: { GIT_ADAPTER: "git", OLLAMA_URL: "http://gpu:11434" } });
      expect(updated.env).toEqual({ GIT_ADAPTER: "git" });
      expect(updated.embeddingBaseUrl).toBe("http://gpu:11434");
      const entry = onDisk("alpha");
      expect(entry?.env).toEqual({ GIT_ADAPTER: "git" });
      expect(entry?.embeddingBaseUrl).toBe("http://gpu:11434");
    });

    it("unsets keys and persists the removal", () => {
      ops.editEnv({ name: "alpha", set: { GIT_ADAPTER: "git", INGEST_CHUNK_SIZE: "2000", CODEGRAPH_ENABLED: "1" } });
      ops.editEnv({ name: "alpha", unset: ["CODE_CHUNK_SIZE", "CODEGRAPH_ENABLED"] });
      const entry = onDisk("alpha");
      expect(entry?.env).toEqual({ GIT_ADAPTER: "git" });
      expect(entry?.codegraphEnabled).toBeUndefined();
    });

    it("keeps the alias and every other field of the entry", () => {
      const before = onDisk("alpha");
      ops.editEnv({ name: "alpha", set: { GIT_ADAPTER: "git" } });
      const after = onDisk("alpha");
      expect(after?.name).toBe("alpha");
      expect(after?.collectionName).toBe(before?.collectionName);
      expect(after?.path).toBe(before?.path);
    });

    it("throws ProjectNotRegisteredError for an unknown alias", () => {
      expect(() => ops.editEnv({ name: "ghost", set: { GIT_ADAPTER: "git" } })).toThrow(ProjectNotRegisteredError);
    });

    it("throws ProjectEnvKeyUnknownError for a key outside the registry env vocabulary, on set and on unset", () => {
      expect(() => ops.editEnv({ name: "alpha", set: { OPENAI_API_KEY: "sk" } })).toThrow(ProjectEnvKeyUnknownError);
      expect(() => ops.editEnv({ name: "alpha", unset: ["DEBUG"] })).toThrow(ProjectEnvKeyUnknownError);
      expect(onDisk("alpha")?.env).toBeUndefined();
    });

    it("rejects the keys the index run records about the indexed data", () => {
      expect(() => ops.editEnv({ name: "alpha", set: { EMBEDDING_MODEL: "other" } })).toThrow(InvalidParameterError);
      expect(() => ops.editEnv({ name: "alpha", unset: ["QDRANT_URL"] })).toThrow(InvalidParameterError);
    });

    it("rejects an empty value and a non-boolean CODEGRAPH_ENABLED", () => {
      expect(() => ops.editEnv({ name: "alpha", set: { GIT_ADAPTER: "" } })).toThrow(InvalidParameterError);
      expect(() => ops.editEnv({ name: "alpha", set: { CODEGRAPH_ENABLED: "yes" } })).toThrow(InvalidParameterError);
    });

    it("rejects an edit with nothing to set or unset", () => {
      expect(() => ops.editEnv({ name: "alpha" })).toThrow(InvalidParameterError);
    });

    it("turns a value the config schema refuses into InvalidParameterError naming the key", () => {
      const strict = new ProjectRegistryOps({
        registry: new CollectionRegistry(dir),
        validateEnvValue: (key, value) => {
          if (key === "INGEST_CHUNK_SIZE" && !/^\d+$/.test(value)) {
            throw new ConfigValueInvalidError("ingest", "invalid", "chunkSize: expected number");
          }
        },
      });
      expect(() => strict.editEnv({ name: "alpha", set: { INGEST_CHUNK_SIZE: "abc" } })).toThrow(/INGEST_CHUNK_SIZE/);
      expect(() => strict.editEnv({ name: "alpha", set: { INGEST_CHUNK_SIZE: "abc" } })).toThrow(InvalidParameterError);
      expect(onDisk("alpha")?.env).toBeUndefined();
    });
  });
});
