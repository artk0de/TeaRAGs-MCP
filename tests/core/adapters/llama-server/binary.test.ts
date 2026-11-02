import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLlamaServerBinary } from "../../../../src/core/adapters/llama-server/binary.js";
import { LLAMA_CPP_BUILD } from "../../../../src/core/adapters/llama-server/install/llama-cpp-assets.js";

const DATA_DIR = "/data";
const MANAGED_ROOT = join(DATA_DIR, "llama.cpp");

/** A fake tree: `files` are existing file paths; directories are derived from them. */
function fakeFs(files: string[]) {
  const exists = (p: string): boolean => files.includes(p) || files.some((f) => f.startsWith(`${p}/`));
  const listDir = (p: string): string[] => {
    const names = new Set<string>();
    for (const f of files) if (f.startsWith(`${p}/`)) names.add(f.slice(p.length + 1).split("/")[0]);
    if (names.size === 0) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return [...names];
  };
  return { exists, listDir };
}

describe("resolveLlamaServerBinary", () => {
  const managed = join(MANAGED_ROOT, `${LLAMA_CPP_BUILD}-metal`, `llama-${LLAMA_CPP_BUILD}`, "llama-server");

  it("LLAMA_SERVER_PATH wins over a managed install and PATH", () => {
    const resolved = resolveLlamaServerBinary({
      env: { LLAMA_SERVER_PATH: "/opt/custom/llama-server" },
      dataDir: DATA_DIR,
      ...fakeFs([managed]),
      which: () => "/usr/local/bin/llama-server",
    });

    expect(resolved).toBe("/opt/custom/llama-server");
  });

  it("a managed install wins over PATH", () => {
    const resolved = resolveLlamaServerBinary({
      env: {},
      dataDir: DATA_DIR,
      ...fakeFs([managed]),
      which: () => "/usr/local/bin/llama-server",
    });

    expect(resolved).toBe(managed);
  });

  it("managed picks the directory of the pinned build over other builds", () => {
    const older = join(MANAGED_ROOT, "b11000-metal", "llama-b11000", "llama-server");
    const newer = join(MANAGED_ROOT, "b99999-metal", "llama-b99999", "llama-server");
    const resolved = resolveLlamaServerBinary({
      env: {},
      dataDir: DATA_DIR,
      ...fakeFs([older, newer, managed]),
      which: () => null,
    });

    expect(resolved).toBe(managed);
  });

  it("without the pinned build, picks the newest managed build", () => {
    const older = join(MANAGED_ROOT, "b9000-cpu", "llama-b9000", "llama-server");
    const newer = join(MANAGED_ROOT, "b11000-cpu", "llama-b11000", "llama-server");
    const resolved = resolveLlamaServerBinary({
      env: {},
      dataDir: DATA_DIR,
      ...fakeFs([older, newer]),
      which: () => null,
    });

    expect(resolved).toBe(newer);
  });

  it("finds a Windows llama-server.exe at the install root and ignores a half-extracted .staging dir", () => {
    const winExe = join(MANAGED_ROOT, `${LLAMA_CPP_BUILD}-cuda`, "llama-server.exe");
    const staging = join(MANAGED_ROOT, `${LLAMA_CPP_BUILD}-vulkan.staging`, "llama-server.exe");
    const resolved = resolveLlamaServerBinary({
      env: {},
      dataDir: DATA_DIR,
      ...fakeFs([staging, winExe]),
      which: () => null,
    });

    expect(resolved).toBe(winExe);
  });

  it("falls back to PATH when nothing is managed", () => {
    const resolved = resolveLlamaServerBinary({
      env: {},
      dataDir: DATA_DIR,
      ...fakeFs([]),
      which: (cmd) => (cmd === "llama-server" ? "/usr/local/bin/llama-server" : null),
    });

    expect(resolved).toBe("/usr/local/bin/llama-server");
  });

  it("returns null when no binary is found anywhere", () => {
    expect(resolveLlamaServerBinary({ env: {}, dataDir: DATA_DIR, ...fakeFs([]), which: () => null })).toBeNull();
  });
});
