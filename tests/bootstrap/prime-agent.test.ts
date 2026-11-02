import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolvePrimeAgentProject } from "../../src/bootstrap/prime-agent.js";
import { CollectionRegistry } from "../../src/core/domains/maintenance/registry/collection-registry.js";
import {
  createGitWorkingTreeFixture,
  prebuildGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../core/__helpers__/git-working-tree-fixture.js";

let fixture: GitWorkingTreeFixture;
let dataDir: string;
let registry: CollectionRegistry;
beforeAll(() => {
  prebuildGitWorkingTreeFixture();
});
beforeEach(() => {
  fixture = createGitWorkingTreeFixture();
  dataDir = mkdtempSync(join(tmpdir(), "prime-agent-"));
  registry = new CollectionRegistry(dataDir);
  registry.record({
    collectionName: "code_original",
    path: fixture.mainRoot,
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "embedded",
    indexedAt: "2000-01-01",
    teaRagsVersion: "1",
    chunksCount: 4,
  });
  registry.setName("code_original", "proj");
});
afterEach(() => {
  fixture.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("lean prime registry binding", () => {
  it("reuses the same repository index for a linked worktree and keeps its actual collection identity", () => {
    const tree = fixture.addWorktree("agent");
    const result = resolvePrimeAgentProject({ path: tree }, dataDir);
    expect(result?.path).toBe(tree);
    expect(result?.entry.name).toBe("proj");
    expect(result?.entry.collectionName).toBe("code_original");
  });
  it("resolves an alias and does not replace an unknown explicit alias with the cwd", () => {
    expect(resolvePrimeAgentProject({ project: "proj" }, dataDir)?.entry.collectionName).toBe("code_original");
    expect(resolvePrimeAgentProject({ project: "missing" }, dataDir)).toBeNull();
  });
});
