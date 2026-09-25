import { describe, expect, it } from "vitest";

import { createColorizer } from "../../../src/cli/infra/color.js";
import { statusTag, type StatusLevel } from "../../../src/cli/infra/status-tag.js";

const plain = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });
const colored = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });

describe("statusTag", () => {
  describe("layout (color off)", () => {
    it.each<[StatusLevel, string]>([
      ["ok", "[OK]  "],
      ["warn", "[WARN]"],
      ["fail", "[FAIL]"],
      ["kill", "[KILL]"],
      ["dry", "[DRY] "],
    ])("renders %s as a fixed-width bracketed label", (level, expected) => {
      expect(statusTag(level, plain)).toBe(expected);
    });
  });

  describe("roles (color on)", () => {
    it.each<[StatusLevel, string, (s: string) => string]>([
      ["ok", "[OK]", colored.ok],
      ["warn", "[WARN]", colored.warn],
      ["fail", "[FAIL]", colored.alert],
      ["kill", "[KILL]", colored.warn],
      ["dry", "[DRY]", colored.dim],
    ])("paints %s with its role and pads outside the escape", (level, label, paint) => {
      const tag = statusTag(level, colored);
      expect(tag.startsWith(paint(label))).toBe(true);
      expect(tag.slice(paint(label).length)).toBe(" ".repeat(6 - label.length));
    });
  });
});
