import { describe, expect, it } from "vitest";
import { daemonSocketPath, daemonPidFile } from "../../src/bootstrap/config/paths.js";

describe("daemon paths", () => {
  it("should return socket path in app data dir", () => {
    expect(daemonSocketPath()).toMatch(/\.tea-rags-mcp\/onnx\.sock$/);
  });

  it("should return PID file path in app data dir", () => {
    expect(daemonPidFile()).toMatch(/\.tea-rags-mcp\/onnx-daemon\.pid$/);
  });
});
