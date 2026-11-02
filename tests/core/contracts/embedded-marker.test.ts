import { describe, expect, it } from "vitest";

import { EMBEDDED_MARKER as daemonMarker } from "../../../src/core/adapters/qdrant/embedded/daemon.js";
import * as registry from "../../../src/core/contracts/types/registry.js";

describe("registry embedded-backend protocol marker", () => {
  it("preserves the legacy daemon export and the exact persisted value through the shared contract", () => {
    const contract = registry as typeof registry & { EMBEDDED_MARKER?: string };
    expect(contract.EMBEDDED_MARKER).toBe("embedded");
    expect(daemonMarker).toBe(contract.EMBEDDED_MARKER);
  });
});
