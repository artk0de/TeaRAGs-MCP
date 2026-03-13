import { describe, expect, it } from "vitest";

describe("coreSchema qdrantUrl", () => {
  it("accepts 'embedded' as valid value", async () => {
    const { coreSchema } = await import("../../../src/bootstrap/config/schemas.js");
    const result = coreSchema.safeParse({
      qdrantUrl: "embedded",
      transportMode: "stdio",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.qdrantUrl).toBe("embedded");
  });

  it("defaults to undefined when not set", async () => {
    const { coreSchema } = await import("../../../src/bootstrap/config/schemas.js");
    const result = coreSchema.safeParse({ transportMode: "stdio" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.qdrantUrl).toBeUndefined();
  });
});
