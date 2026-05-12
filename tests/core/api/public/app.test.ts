import { describe, expect, it } from "vitest";

import type { App } from "../../../../src/core/api/public/app.js";

describe("App interface — project registry methods", () => {
  it("declares registerProject, listProjects, unregisterProject", () => {
    const stub: Pick<App, "registerProject" | "listProjects" | "unregisterProject"> = {
      registerProject: async () => ({
        collectionName: "x",
        alreadyIndexed: false,
      }),
      listProjects: async () => ({ projects: [] }),
      unregisterProject: async () => ({ removed: false }),
    };
    expect(typeof stub.registerProject).toBe("function");
    expect(typeof stub.listProjects).toBe("function");
    expect(typeof stub.unregisterProject).toBe("function");
  });
});
