/**
 * Terminal colors and formatting utilities
 */

export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgRed: "\x1b[41m",
};

export function bar(current, best, width = 20) {
  const ratio = Math.min(current / best, 1);
  const filled = Math.round(ratio * width);
  const clr = ratio >= 0.95 ? c.green : ratio >= 0.8 ? c.yellow : c.gray;
  return `${clr}${"█".repeat(filled)}${"░".repeat(width - filled)}${c.reset}`;
}

export function formatRate(value, unit) {
  const clr = value >= 1000 ? c.green : value >= 500 ? c.yellow : c.gray;
  return `${clr}${c.bold}${value}${c.reset} ${c.dim}${unit}${c.reset}`;
}

export function printHeader(title, subtitle = "") {
  console.log();
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}${title}${c.reset}`);
  if (subtitle) console.log(`${c.dim}${subtitle}${c.reset}`);
  console.log(`${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log();
}

export function printBox(title, subtitle = "") {
  console.log();
  console.log(`${c.cyan}${c.bold}╔══════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.cyan}${c.bold}║${c.reset}     ${c.bold}${title.padEnd(50)}${c.reset}${c.cyan}${c.bold}║${c.reset}`);
  if (subtitle) {
    console.log(`${c.cyan}${c.bold}║${c.reset}     ${c.dim}${subtitle.padEnd(50)}${c.reset}${c.cyan}${c.bold}║${c.reset}`);
  }
  console.log(`${c.cyan}${c.bold}╚══════════════════════════════════════════════════════════╝${c.reset}`);
  console.log();
}
