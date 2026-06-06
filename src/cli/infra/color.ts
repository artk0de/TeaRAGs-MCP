/**
 * Minimal truecolor ANSI styling for CLI output.
 *
 * No external dependency: emits 24-bit foreground escapes directly. Honors the
 * `NO_COLOR` / `FORCE_COLOR` standards and TTY detection, and adapts the palette
 * to the terminal background via `COLORFGBG`. When disabled, every styling
 * function is identity so callers render the same text monochrome.
 *
 * Palette mirrors the docs theme (`website/src/css/custom.css`): tea-gold brand
 * with explicit light/dark variants; ok/warn/alert use Docusaurus defaults.
 */

export type TerminalBackground = "light" | "dark";

export type ColorRole = "brand" | "ok" | "warn" | "alert";

type Rgb = readonly [number, number, number];

/** Per-role RGB, selected by detected background for contrast. */
const PALETTE: Record<ColorRole, Record<TerminalBackground, Rgb>> = {
  brand: { dark: [0xd1, 0xba, 0x83], light: [0x91, 0x78, 0x38] },
  ok: { dark: [0x00, 0xa4, 0x00], light: [0x00, 0x80, 0x00] },
  warn: { dark: [0xff, 0xba, 0x00], light: [0xb0, 0x7d, 0x00] },
  alert: { dark: [0xfa, 0x38, 0x3e], light: [0xd1, 0x1a, 0x20] },
};

const RESET = "\x1b[0m";

export interface Colorizer {
  readonly enabled: boolean;
  readonly background: TerminalBackground;
  readonly brand: (s: string) => string;
  readonly ok: (s: string) => string;
  readonly warn: (s: string) => string;
  readonly alert: (s: string) => string;
  readonly dim: (s: string) => string;
  readonly bold: (s: string) => string;
}

export interface ColorizerOptions {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

/**
 * Resolve whether color output is enabled.
 * Priority: NO_COLOR (off) > FORCE_COLOR (on) > isTTY.
 */
export function colorsEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return true;
  return Boolean(isTTY);
}

/**
 * Detect terminal background from COLORFGBG (set by iTerm2 and many terminals).
 * Format is `"fg;bg"` or `"fg;default;bg"`; the background is the last field.
 * The field is an ANSI color index: 0-6 and 8 are dark colors (black/dim) →
 * dark background; 7 and 9-15 are light colors (greys/white) → light background.
 * Missing / unparseable → dark (the safe default for terminals).
 */
export function detectBackground(env: NodeJS.ProcessEnv): TerminalBackground {
  const raw = env.COLORFGBG;
  if (!raw) return "dark";
  const fields = raw.split(";");
  const bg = Number.parseInt(fields[fields.length - 1] ?? "", 10);
  if (Number.isNaN(bg)) return "dark";
  return (bg >= 0 && bg <= 6) || bg === 8 ? "dark" : "light";
}

function truecolor(rgb: Rgb, s: string): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${RESET}`;
}

export function createColorizer(opts: ColorizerOptions = {}): Colorizer {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  const enabled = colorsEnabled(env, isTTY);
  const background = detectBackground(env);

  if (!enabled) {
    const identity = (s: string): string => s;
    return {
      enabled,
      background,
      brand: identity,
      ok: identity,
      warn: identity,
      alert: identity,
      dim: identity,
      bold: identity,
    };
  }

  const role =
    (r: ColorRole) =>
    (s: string): string =>
      truecolor(PALETTE[r][background], s);

  return {
    enabled,
    background,
    brand: role("brand"),
    ok: role("ok"),
    warn: role("warn"),
    alert: role("alert"),
    dim: (s) => `\x1b[2m${s}${RESET}`,
    bold: (s) => `\x1b[1m${s}${RESET}`,
  };
}
