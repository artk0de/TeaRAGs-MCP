/**
 * Pure renderer for `tea-rags llama-server command`: the copy-paste sheet an
 * operator runs on a REMOTE GPU host to serve embeddings with llama-server.
 *
 * Nothing here executes anything — the sheet is text. One sheet covers ONE
 * llama-server build (`bin`); hosts with GPUs that need different builds
 * (ROCm, Vulkan, CUDA) get one sheet per build, and the operator joins the
 * printed endpoint lists.
 *
 * Every launch is held as an argv token list and rendered per consumer, since
 * each one quotes differently: PowerShell, a POSIX shell, the `.cmd` launcher
 * a Windows scheduled task runs, a systemd `ExecStart=`, and a launchd plist.
 */

import type { OllamaRegistryGgufSource } from "../../core/api/public/index.js";

export type LlamaServerTargetOs = "windows" | "linux" | "macos";

export interface LlamaServerCommandOptions {
  os: LlamaServerTargetOs;
  /** The llama-server binary on the target host — one build per sheet. */
  bin: string;
  /** `--device` ids from `<bin> --list-devices`; empty prints one default line plus that hint. */
  devices: string[];
  /** Bind address; `0.0.0.0` exposes the server on the LAN. */
  host: string;
  /** Port of the first launch line; each further device takes the next port. */
  port: number;
  /** Parallel sequences per server (`-np`); the context grows by 8192 per slot. */
  slots: number;
  /** GGUF path on the target host, in that OS's path syntax. */
  modelPath: string;
  /** Address the client dials; defaults to `host`. */
  advertise?: string;
  apiKey?: string;
  autostart: boolean;
  /** When set, the sheet starts with downloading this GGUF to `modelPath`. */
  gguf?: OllamaRegistryGgufSource;
  /** The OS tea-rags itself runs on — named in the local-fallback hint. */
  localOs?: LlamaServerTargetOs;
}

export interface LlamaServerCommandSection {
  title: string;
  lines: string[];
}

export interface LlamaServerCommandSheet {
  sections: LlamaServerCommandSection[];
  /** Env for the tea-rags client that embeds through the printed servers. */
  clientEnv: Record<string, string>;
}

/** Context tokens each llama-server slot gets. */
const CONTEXT_PER_SLOT = 8192;

// ── quoting ──────────────────────────────────────────────────────────────

const POWERSHELL_BARE = /^[A-Za-z0-9_\-.:\\/=,+]+$/;
const POSIX_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellToken(value: string): string {
  return POWERSHELL_BARE.test(value) ? value : powershellQuote(value);
}

/** A quoted first token is a string in PowerShell; `&` makes it a command. */
function powershellCommand(argv: string[]): string {
  const [bin, ...rest] = argv.map(powershellToken);
  return [bin.startsWith("'") ? `& ${bin}` : bin, ...rest].join(" ");
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quotes only what needs it, and leaves a leading `~/` outside the quotes so it still expands. */
function posixToken(value: string): string {
  if (value.startsWith("~/")) return `~/${posixToken(value.slice(2))}`;
  return POSIX_BARE.test(value) ? value : posixQuote(value);
}

function posixCommand(argv: string[]): string {
  return argv.map(posixToken).join(" ");
}

/** A line in a `.cmd` file: cmd metacharacters stay inside quotes, `%` is doubled. */
function batchCommandLine(argv: string[]): string {
  return argv
    .map((raw) => {
      const t = raw.replace(/%/g, "%%");
      return /[\s"&|<>^]/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
    })
    .join(" ");
}

/** systemd expands `%h` (the user's home), never `~`; `%` itself must be doubled. */
function systemdExec(argv: string[]): string {
  return argv
    .map((raw) => {
      const escaped = raw.replace(/%/g, "%%");
      const token = escaped.startsWith("~/") ? `%h/${escaped.slice(2)}` : escaped;
      return /[\s"'\\]/.test(token) ? `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : token;
    })
    .join(" ");
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shellCommand(os: LlamaServerTargetOs, argv: string[]): string {
  return os === "windows" ? powershellCommand(argv) : posixCommand(argv);
}

function parentDir(os: LlamaServerTargetOs, path: string): string {
  const cut = os === "windows" ? Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) : path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : path;
}

// ── launches ─────────────────────────────────────────────────────────────

interface LlamaServerLaunch {
  port: number;
  device?: string;
  argv: string[];
}

function buildLaunches(o: LlamaServerCommandOptions): LlamaServerLaunch[] {
  const devices: (string | undefined)[] = o.devices.length > 0 ? o.devices : [undefined];
  return devices.map((device, i) => {
    const port = o.port + i;
    const argv = [
      o.bin,
      "-m",
      o.modelPath,
      "--embedding",
      "-ngl",
      "999",
      "-fa",
      "on",
      "-np",
      String(o.slots),
      "-c",
      String(o.slots * CONTEXT_PER_SLOT),
      "-b",
      String(CONTEXT_PER_SLOT),
      "-ub",
      String(CONTEXT_PER_SLOT),
      ...(device === undefined ? [] : ["--device", device]),
      "--host",
      o.host,
      "--port",
      String(port),
      ...(o.apiKey === undefined ? [] : ["--api-key", o.apiKey]),
    ];
    return { port, device, argv };
  });
}

function portRange(launches: LlamaServerLaunch[], separator: string): string {
  const first = launches[0].port;
  const last = launches[launches.length - 1].port;
  return first === last ? String(first) : `${first}${separator}${last}`;
}

// ── sections ─────────────────────────────────────────────────────────────

function downloadSection(o: LlamaServerCommandOptions, gguf: OllamaRegistryGgufSource): LlamaServerCommandSection {
  const dir = parentDir(o.os, o.modelPath);
  if (o.os === "windows") {
    const path = powershellQuote(o.modelPath);
    return {
      title: "Download the model (PowerShell)",
      lines: [
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(dir)} | Out-Null`,
        "$ProgressPreference = 'SilentlyContinue'",
        `Invoke-WebRequest -Uri ${powershellQuote(gguf.blobUrl)} -OutFile ${path}`,
        `(Get-FileHash ${path} -Algorithm SHA256).Hash -eq '${gguf.sha256}'`,
        "# The last line must print True.",
      ],
    };
  }
  const path = posixToken(o.modelPath);
  const verify = o.os === "macos" ? "shasum -a 256 -c -" : "sha256sum -c -";
  return {
    title: "Download the model (shell)",
    lines: [
      `mkdir -p ${posixToken(dir)}`,
      `curl -L -o ${path} ${posixToken(gguf.blobUrl)}`,
      `printf '%s  %s\\n' ${gguf.sha256} ${path} | ${verify}`,
    ],
  };
}

function launchSection(o: LlamaServerCommandOptions, launches: LlamaServerLaunch[]): LlamaServerCommandSection {
  const lines = launches.map((l) => shellCommand(o.os, l.argv));
  if (o.devices.length === 0) {
    lines.push(
      `# Pick GPUs: run ${shellCommand(o.os, [o.bin, "--list-devices"])}, then re-run this command with --device <id> per GPU (one port each).`,
    );
  }
  return { title: `Launch llama-server (${o.os === "windows" ? "PowerShell" : "shell"})`, lines };
}

function firewallSection(o: LlamaServerCommandOptions, launches: LlamaServerLaunch[]): LlamaServerCommandSection {
  if (o.os === "windows") {
    const ports = portRange(launches, "-");
    return {
      title: "Open the firewall (elevated PowerShell)",
      lines: [
        `netsh advfirewall firewall add rule name="tea-rags llama-server ${ports}" dir=in action=allow protocol=TCP localport=${ports}`,
      ],
    };
  }
  if (o.os === "linux") {
    return { title: "Open the firewall (shell)", lines: [`sudo ufw allow ${portRange(launches, ":")}/tcp`] };
  }
  return {
    title: "Open the firewall (note)",
    lines: [
      `# macOS: nothing to run. When the application firewall asks on first launch, allow incoming connections for ${o.bin}.`,
    ],
  };
}

function keepAwakeSection(o: LlamaServerCommandOptions): LlamaServerCommandSection {
  if (o.os === "windows") {
    return {
      title: "Keep the host awake (elevated PowerShell)",
      lines: ["powercfg /change standby-timeout-ac 0", "powercfg /change hibernate-timeout-ac 0"],
    };
  }
  if (o.os === "linux") {
    return {
      title: "Keep the host awake (note)",
      lines: [
        "# A suspended host drops every request. Prefix each launch line with:",
        '#   systemd-inhibit --what=sleep --who=tea-rags --why="llama-server embeddings" <launch line>',
      ],
    };
  }
  return {
    title: "Keep the host awake (note)",
    lines: [
      "# A sleeping Mac drops every request. On AC power, prefix each launch line with:",
      "#   caffeinate -s <launch line>",
    ],
  };
}

/**
 * A `.cmd` launcher per port, next to the model, and a scheduled task that runs
 * it. The full launch line does not fit the 261 chars schtasks allows in `/TR`;
 * the launcher path does. `--%` hands the rest of the line to schtasks verbatim,
 * so the `\"` quoting is the same on Windows PowerShell 5.1 and PowerShell 7.
 */
function windowsAutostart(o: LlamaServerCommandOptions, launches: LlamaServerLaunch[]): string[] {
  const dir = parentDir(o.os, o.modelPath);
  const lines: string[] = [];
  for (const l of launches) {
    const launcher = `${dir}\\tea-rags-llama-server-${l.port}.cmd`;
    const task = `"tea-rags llama-server ${l.port}"`;
    lines.push(
      `Set-Content -Path ${powershellQuote(launcher)} -Encoding ASCII -Value '@echo off', ${powershellQuote(batchCommandLine(l.argv))}`,
      `schtasks --% /Create /TN ${task} /SC ONSTART /RL HIGHEST /RU SYSTEM /TR "\\"${launcher}\\""`,
      "# Optional, start it now:",
      `schtasks /Run /TN ${task}`,
    );
  }
  return lines;
}

function linuxAutostart(launches: LlamaServerLaunch[]): string[] {
  const lines = ["mkdir -p ~/.config/systemd/user"];
  for (const l of launches) {
    lines.push(
      `cat > ~/.config/systemd/user/tea-rags-llama-server-${l.port}.service <<'EOF'`,
      "[Unit]",
      `Description=tea-rags llama-server ${l.port}${l.device === undefined ? "" : ` (${l.device})`}`,
      "After=network-online.target",
      "",
      "[Service]",
      `ExecStart=${systemdExec(l.argv)}`,
      "Restart=on-failure",
      "",
      "[Install]",
      "WantedBy=default.target",
      "EOF",
    );
  }
  lines.push("systemctl --user daemon-reload");
  for (const l of launches) lines.push(`systemctl --user enable --now tea-rags-llama-server-${l.port}.service`);
  lines.push("# User units start at boot only with lingering enabled:", 'sudo loginctl enable-linger "$USER"');
  return lines;
}

function macosAutostart(launches: LlamaServerLaunch[]): string[] {
  const lines = ["mkdir -p ~/Library/LaunchAgents"];
  for (const l of launches) {
    const label = `com.tea-rags.llama-server.${l.port}`;
    const plist = `~/Library/LaunchAgents/${label}.plist`;
    lines.push(
      `cat > ${plist} <<'EOF'`,
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${label}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      "    <string>/bin/sh</string>",
      "    <string>-c</string>",
      `    <string>${xmlEscape(`exec ${posixCommand(l.argv)}`)}</string>`,
      "  </array>",
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      "</dict>",
      "</plist>",
      "EOF",
      `launchctl bootstrap gui/$(id -u) ${plist}`,
    );
  }
  return lines;
}

function autostartSection(o: LlamaServerCommandOptions, launches: LlamaServerLaunch[]): LlamaServerCommandSection {
  if (o.os === "windows") return { title: "Start at boot (elevated PowerShell)", lines: windowsAutostart(o, launches) };
  if (o.os === "linux") return { title: "Start at boot (shell)", lines: linuxAutostart(launches) };
  return { title: "Start at boot (shell)", lines: macosAutostart(launches) };
}

function buildClientEnv(o: LlamaServerCommandOptions, launches: LlamaServerLaunch[]): Record<string, string> {
  const address = o.advertise ?? o.host;
  const env: Record<string, string> = {
    EMBEDDING_PROVIDER: "llama-server",
    EMBEDDING_BASE_URL: launches.map((l) => `http://${address}:${l.port}`).join(","),
  };
  if (o.apiKey !== undefined) env.EMBEDDING_API_KEY = o.apiKey;
  return env;
}

function clientSection(o: LlamaServerCommandOptions, clientEnv: Record<string, string>): LlamaServerCommandSection {
  const lines = Object.entries(clientEnv).map(([key, value]) => `${key}=${value}`);
  if (o.advertise === undefined && (o.host === "0.0.0.0" || o.host === "::")) {
    lines.push(`# ${o.host} is a bind address, not one a client can dial: re-run with --advertise <lan-ip>.`);
  }
  lines.push(
    "# GPUs that need another llama-server build: run this command once per --bin, with --port past this range, and join the EMBEDDING_BASE_URL lists with commas.",
    `# Local fallback tier: run tea-rags llama-server command --os ${o.localOs ?? "<local-os>"} --host 127.0.0.1 --bin <local llama-server> and put its URL into EMBEDDING_FALLBACK_URL.`,
  );
  return { title: "Client configuration (tea-rags host)", lines };
}

/** Build the operator sheet. Pure: same options, same text. */
export function renderLlamaServerCommands(o: LlamaServerCommandOptions): LlamaServerCommandSheet {
  const launches = buildLaunches(o);
  const clientEnv = buildClientEnv(o, launches);
  const sections = [
    ...(o.gguf === undefined ? [] : [downloadSection(o, o.gguf)]),
    launchSection(o, launches),
    firewallSection(o, launches),
    keepAwakeSection(o),
    ...(o.autostart ? [autostartSection(o, launches)] : []),
    clientSection(o, clientEnv),
  ];
  return {
    sections: sections.map((s, i) => ({ title: `${i + 1}. ${s.title}`, lines: s.lines })),
    clientEnv,
  };
}

/** `## <title>` blocks separated by blank lines, newline-terminated. */
export function formatLlamaServerCommandSheet(sheet: LlamaServerCommandSheet): string {
  return `${sheet.sections.map((s) => [`## ${s.title}`, ...s.lines].join("\n")).join("\n\n")}\n`;
}
