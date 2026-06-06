import { describe, expect, it } from "vitest";

import { colorsEnabled, createColorizer, detectBackground } from "../../../src/cli/infra/color.js";

describe("cli/infra/color", () => {
  describe("colorsEnabled", () => {
    it("is OFF when NO_COLOR is set, even on a TTY", () => {
      expect(colorsEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    });

    it("is OFF when NO_COLOR is set to empty string (presence wins)", () => {
      expect(colorsEnabled({ NO_COLOR: "" }, true)).toBe(false);
    });

    it("is ON when FORCE_COLOR is set, even without a TTY", () => {
      expect(colorsEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    });

    it("NO_COLOR wins over FORCE_COLOR", () => {
      expect(colorsEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
    });

    it("follows isTTY when no env override", () => {
      expect(colorsEnabled({}, true)).toBe(true);
      expect(colorsEnabled({}, false)).toBe(false);
    });
  });

  describe("detectBackground", () => {
    it("defaults to dark when COLORFGBG is absent", () => {
      expect(detectBackground({})).toBe("dark");
    });

    it.each(["15;0", "7;0", "1;6", "0;8"])("reads dark background from COLORFGBG=%s", (v) => {
      expect(detectBackground({ COLORFGBG: v })).toBe("dark");
    });

    it.each(["0;15", "0;7", "1;9", "7;15"])("reads light background from COLORFGBG=%s", (v) => {
      expect(detectBackground({ COLORFGBG: v })).toBe("light");
    });

    it("defaults to dark when COLORFGBG is unparseable", () => {
      expect(detectBackground({ COLORFGBG: "default;default" })).toBe("dark");
    });
  });

  describe("createColorizer (enabled)", () => {
    const c = createColorizer({ env: { FORCE_COLOR: "1", COLORFGBG: "15;0" }, isTTY: true });

    it("reports enabled and the detected background", () => {
      expect(c.enabled).toBe(true);
      expect(c.background).toBe("dark");
    });

    it("wraps brand text in a truecolor escape and resets", () => {
      const ESC = String.fromCharCode(27);
      const out = c.brand("X");
      expect(out).toContain(`${ESC}[38;2;`);
      expect(out).toContain("X");
      expect(out.endsWith(`${ESC}[0m`)).toBe(true);
    });

    it("bold uses the bold escape \\x1b[1m", () => {
      expect(c.bold("X")).toContain("\x1b[1m");
      expect(c.bold("X")).toContain("X");
    });

    it("picks different brand RGB for light vs dark background", () => {
      const dark = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });
      const light = createColorizer({ env: { FORCE_COLOR: "1", COLORFGBG: "15;7" }, isTTY: true });
      expect(dark.brand("X")).not.toBe(light.brand("X"));
    });
  });

  describe("createColorizer (disabled)", () => {
    const c = createColorizer({ env: { NO_COLOR: "1" }, isTTY: true });

    it("reports disabled", () => {
      expect(c.enabled).toBe(false);
    });

    it.each(["brand", "ok", "warn", "alert", "dim", "bold"] as const)(
      "%s is identity when disabled (no escape codes)",
      (role) => {
        expect(c[role]("plain")).toBe("plain");
      },
    );
  });
});
