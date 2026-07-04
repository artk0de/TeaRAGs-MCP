import { describe, expect, it } from "vitest";

import { VcsAdapterUnavailableError } from "../../../../src/core/adapters/vcs/errors.js";

describe("VcsAdapterUnavailableError", () => {
  it.each([
    ["darwin", "rustup-init"],
    ["linux", "build-essential"],
    ["win32", "Visual Studio Build Tools"],
  ] as const)("renders the %s install hint", (platform, marker) => {
    const err = new VcsAdapterUnavailableError("es-git", "Cannot find module 'es-git'", platform);
    expect(err.code).toBe("INFRA_VCS_ADAPTER_UNAVAILABLE");
    expect(err.message).toContain("GIT_ADAPTER=es-git");
    expect(err.message).toContain("Cannot find module 'es-git'");
    expect(err.hint).toContain("npm install -g es-git");
    expect(err.hint).toContain(marker);
    expect(err.hint).toContain("GIT_ADAPTER=git");
  });

  it("prints only the running platform's hint", () => {
    const err = new VcsAdapterUnavailableError("es-git", "load failed", "darwin");
    expect(err.hint).not.toContain("Visual Studio");
    expect(err.hint).not.toContain("build-essential");
  });

  it("defaults the platform to process.platform", () => {
    const err = new VcsAdapterUnavailableError("es-git", "load failed");
    expect(err.hint.length).toBeGreaterThan(0);
  });

  it("falls back to the linux hint on unknown platforms", () => {
    const err = new VcsAdapterUnavailableError("es-git", "load failed", "freebsd");
    expect(err.hint).toContain("build-essential");
  });
});
