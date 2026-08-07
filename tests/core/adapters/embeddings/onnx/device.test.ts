import { describe, expect, it } from "vitest";

import { detectDevice } from "../../../../../src/core/adapters/embeddings/onnx/device.js";

describe("detectDevice", () => {
  it("honours an explicitly requested backend verbatim", () => {
    expect(detectDevice("cpu")).toBe("cpu");
    expect(detectDevice("webgpu")).toBe("webgpu");
    expect(detectDevice("cuda")).toBe("cuda");
  });

  it("auto-detects webgpu when nothing is requested", () => {
    expect(detectDevice()).toBe("webgpu");
  });

  it('treats the literal "auto" as a request to auto-detect, not as a backend name', () => {
    expect(detectDevice("auto")).toBe("webgpu");
  });

  it("treats an empty string as unset rather than as an explicit backend", () => {
    expect(detectDevice("")).toBe("webgpu");
  });
});
