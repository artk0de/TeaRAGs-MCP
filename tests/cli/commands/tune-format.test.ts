import { describe, expect, it } from "vitest";

import {
  formatTuneInputError,
  formatTuneRegistryUpdate,
  formatTuneRegistryWriteFailure,
} from "../../../src/cli/commands/tune-format.js";
import { createColorizer } from "../../../src/cli/infra/color.js";

const plain = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });
const colored = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });

describe("tune status lines", () => {
  describe("layout (color off)", () => {
    it("reports the registry env snapshot update with the measured key count", () => {
      expect(formatTuneRegistryUpdate("alpha", 7, plain)).toBe(
        "[tea-rags] registry env snapshot updated for 'alpha' (7 measured keys)",
      );
    });

    it("reports a failed registry write with its reason", () => {
      expect(formatTuneRegistryWriteFailure("disk full", plain)).toBe(
        "[tea-rags] tune registry write failed: disk full",
      );
    });

    it("renders an input error followed by its hint", () => {
      expect(formatTuneInputError("Project 'x' is not registered", "run projects register", plain)).toBe(
        "Project 'x' is not registered\nHint: run projects register",
      );
    });
  });

  describe("roles (color on)", () => {
    it("paints the tag dim and the update as ok", () => {
      const out = formatTuneRegistryUpdate("alpha", 7, colored);
      expect(out.startsWith(colored.dim("[tea-rags]"))).toBe(true);
      expect(out).toContain(colored.ok("registry env snapshot updated"));
    });

    it("paints a failed registry write as alert", () => {
      expect(formatTuneRegistryWriteFailure("disk full", colored)).toBe(
        `${colored.dim("[tea-rags]")} ${colored.alert("tune registry write failed: disk full")}`,
      );
    });

    it("paints the input error as alert and the hint label dim", () => {
      expect(formatTuneInputError("bad", "fix it", colored)).toBe(
        `${colored.alert("bad")}\n${colored.dim("Hint:")} fix it`,
      );
    });
  });
});
