import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDaemonPaths,
  incrementRefs,
  decrementRefs,
  readRefs,
} from "../../../../src/core/adapters/codegraph-daemon/lifecycle.js";

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("codegraph daemon lifecycle refcount", () => {
  it("paths include socket + pid + refs + lock under the storage dir", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    expect(p.socketPath.endsWith("codegraph-daemon.sock")).toBe(true);
    expect(p.refsFile.endsWith("codegraph-daemon.refs")).toBe(true);
    expect(p.lockFile.endsWith("codegraph-daemon.lock")).toBe(true);
  });

  it("increment/decrement refs are symmetric and floored at 0", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    expect(incrementRefs(p)).toBe(1);
    expect(incrementRefs(p)).toBe(2);
    expect(decrementRefs(p)).toBe(1);
    expect(decrementRefs(p)).toBe(0);
    expect(decrementRefs(p)).toBe(0); // floored
    expect(readRefs(p)).toBe(0);
  });
});
