import { describe, expect, it } from "vitest";

import { VcsAdapterUnavailableError } from "../../../../src/core/adapters/vcs/errors.js";
import { VcsAdapterFactory } from "../../../../src/core/adapters/vcs/factory.js";
import { GitCliAdapter } from "../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import { ConfigValueInvalidError } from "../../../../src/core/infra/errors.js";

describe("VcsAdapterFactory", () => {
  it("git → GitCliAdapter bound to the repo root", async () => {
    const adapter = await VcsAdapterFactory.create("git", process.cwd());
    expect(adapter).toBeInstanceOf(GitCliAdapter);
    expect(adapter.repoRoot).toBe(process.cwd());
  });

  it("es-git without the binding → fail-loud VcsAdapterUnavailableError", async () => {
    // The es-git binding is not installed in the unit-test environment.
    await expect(VcsAdapterFactory.create("es-git", process.cwd())).rejects.toThrow(VcsAdapterUnavailableError);
  });

  it("es-git failure carries the install hint, not a bare module error", async () => {
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
});
