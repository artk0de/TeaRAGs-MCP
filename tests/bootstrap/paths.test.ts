import { describe, expect, it } from "vitest";

import { calibrationCachePath, daemonPidFile, daemonSocketPath } from "../../src/bootstrap/config/paths.js";

describe("daemon paths", () => {
  it("should return socket path in app data dir", () => {
    expect(daemonSocketPath()).toMatch(/onnx\.sock$/);
  });

  it("should return PID file path in app data dir", () => {
    expect(daemonPidFile()).toMatch(/onnx-daemon\.pid$/);
  });

  it("should return calibration cache path in app data dir", () => {
    expect(calibrationCachePath()).toMatch(/onnx-calibration\.json$/);
  });
});
