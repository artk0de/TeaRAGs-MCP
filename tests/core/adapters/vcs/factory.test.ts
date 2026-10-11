import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { VcsAdapterUnavailableError } from "../../../../src/core/adapters/vcs/errors.js";
import { VcsAdapterFactory } from "../../../../src/core/adapters/vcs/factory.js";
import { GitCliAdapter } from "../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import { ConfigValueInvalidError } from "../../../../src/core/primitives/errors/tea-rags-error.js";

// The es-git binding IS installed on dev machines (optionalDependency), so a
// missing binding is SIMULATED: the factory's dynamic import of the es-git
// adapter module is mocked to throw the loader error the binding-less
// environment would produce. `vi.doMock` intercepts dynamic imports at call
// time without resetting modules, so error-class identity is preserved.
const ES_GIT_ADAPTER_MODULE = "../../../../src/core/adapters/vcs/git/es-git/adapter.js";

const mockEsGitBindingAbsent = (): void => {
  vi.doMock(ES_GIT_ADAPTER_MODULE, () => {
    throw new Error("Cannot find module 'es-git'");
  });
};

describe("VcsAdapterFactory", () => {
  afterEach(() => {
    vi.doUnmock(ES_GIT_ADAPTER_MODULE);
  });

  it("git → GitCliAdapter bound to the repo root", async () => {
    const adapter = await VcsAdapterFactory.create("git", process.cwd());
    expect(adapter).toBeInstanceOf(GitCliAdapter);
    expect(adapter.repoRoot).toBe(process.cwd());
  });

  it("es-git without the binding → fail-loud VcsAdapterUnavailableError", async () => {
    mockEsGitBindingAbsent();
    await expect(VcsAdapterFactory.create("es-git", process.cwd())).rejects.toThrow(VcsAdapterUnavailableError);
  });

  it("es-git failure carries the install hint, not a bare module error", async () => {
    mockEsGitBindingAbsent();
    const err = await VcsAdapterFactory.create("es-git", process.cwd()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VcsAdapterUnavailableError);
    expect((err as VcsAdapterUnavailableError).hint).toContain("npm install -g es-git");
    expect((err as VcsAdapterUnavailableError).message).toContain("GIT_ADAPTER=es-git");
  });

  it("unknown adapter value → ConfigValueInvalidError naming GIT_ADAPTER", async () => {
    const err = await VcsAdapterFactory.create("svn" as never, process.cwd()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigValueInvalidError);
    expect((err as ConfigValueInvalidError).message).toContain("svn");
  });

  it("resolveRepoRoot → the git toplevel of a path inside the repo", () => {
    expect(VcsAdapterFactory.resolveRepoRoot(path.join(process.cwd(), "src"))).toBe(
      VcsAdapterFactory.resolveRepoRoot(process.cwd()),
    );
  });

  it("resolveRepoRoot → the input path when it is not inside a git repo", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "vcs-no-repo-"));
    try {
      expect(VcsAdapterFactory.resolveRepoRoot(outside)).toBe(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
