#!/usr/bin/env node
// Host facts for the install skill. Prints one JSON object to stdout.
// Usage: node detect.mjs [projectDir]   (projectDir defaults to cwd; used for the `registered` lookup)
import { execFileSync } from "node:child_process";
import { arch, platform, totalmem } from "node:os";
import { resolve } from "node:path";

const NODE_MIN_MAJOR = 22;
const NODE_MAX_MAJOR_EXCLUSIVE = 26;

/** Run a command, return trimmed stdout or null on any failure (missing binary, non-zero exit). */
function tryRun(command, args) {
  try {
    const [file, fileArgs] =
      platform() === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command, ...args]] : [command, args];
    return execFileSync(file, fileArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

function detectGpuBackend() {
  if (platform() === "darwin") return arch() === "arm64" ? "metal" : "cpu";
  if (tryRun("nvidia-smi", ["-L"])) return "cuda";
  if (tryRun("rocm-smi", ["--showid"]) || tryRun("rocminfo", [])) return "rocm";
  if (tryRun("vulkaninfo", ["--summary"])) return "vulkan";
  if (platform() === "win32") {
    const names =
      tryRun("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"]) ?? "";
    if (/nvidia/i.test(names)) return "cuda";
    if (/radeon|amd|intel.*arc/i.test(names)) return "vulkan";
  }
  return "cpu";
}

function detectHarness(env) {
  if (env.CODEX_HOME || env.CODEX_SANDBOX) return "codex";
  if (env.CURSOR_AGENT) return "cursor";
  if (env.CLAUDECODE) return "claude";
  return "unknown";
}

function nodeFacts() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  return { version, ok: major >= NODE_MIN_MAJOR && major < NODE_MAX_MAJOR_EXCLUSIVE };
}

function teaRagsVersion() {
  const out = tryRun("tea-rags", ["--version"]);
  const match = out?.match(/\d+\.\d+\.\d+\S*/);
  return match ? { version: match[0] } : null;
}

function registeredProject(projectDir) {
  const out = tryRun("tea-rags", ["projects", "list", "--json"]);
  if (!out) return null;
  try {
    const entries = JSON.parse(out);
    const entry = entries.find((e) => resolve(e.path) === projectDir);
    return entry ? { name: entry.name ?? entry.collectionName } : null;
  } catch {
    return null;
  }
}

function main() {
  const projectDir = resolve(process.argv[2] ?? process.cwd());
  const teaRags = teaRagsVersion();
  const facts = {
    os: platform(),
    arch: arch(),
    ramGb: Math.round(totalmem() / 2 ** 30),
    gpuBackend: detectGpuBackend(),
    node: nodeFacts(),
    teaRags,
    harness: detectHarness(process.env),
    registered: teaRags ? registeredProject(projectDir) : null,
  };
  process.stdout.write(`${JSON.stringify(facts)}\n`);
}

try {
  main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
  process.exit(1);
}
