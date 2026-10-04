import { describe, expect, it } from "vitest";

import {
  formatLlamaServerCommandSheet,
  renderLlamaServerCommands,
  type LlamaServerCommandOptions,
  type LlamaServerCommandSheet,
} from "../../../src/cli/commands/llama-server-command-format.js";
import type { OllamaRegistryGgufSource } from "../../../src/core/api/public/index.js";

const SHA = "0123456789abcdef".repeat(4);

const GGUF: OllamaRegistryGgufSource = {
  reference: "unclemusclez/jina-embeddings-v2-base-code:latest",
  blobUrl: `https://registry.ollama.ai/v2/unclemusclez/jina-embeddings-v2-base-code/blobs/sha256:${SHA}`,
  sha256: SHA,
  size: 323_000_000,
  fileName: `jina-embeddings-v2-base-code@latest-${SHA.slice(0, 12)}.gguf`,
};

function options(overrides: Partial<LlamaServerCommandOptions>): LlamaServerCommandOptions {
  return {
    os: "linux",
    bin: "/opt/llama/llama-server",
    devices: [],
    host: "0.0.0.0",
    port: 8081,
    slots: 4,
    modelPath: `~/llama-models/${GGUF.fileName}`,
    autostart: false,
    ...overrides,
  };
}

function section(sheet: LlamaServerCommandSheet, titleStart: string): string[] {
  const found = sheet.sections.find((s) => s.title.startsWith(titleStart));
  if (!found) throw new Error(`no section "${titleStart}" in ${sheet.sections.map((s) => s.title).join(" | ")}`);
  return found.lines;
}

const WIN_BIN = "C:\\llama\\rocm\\llama-server.exe";
const WIN_MODEL = `C:\\llama-models\\${GGUF.fileName}`;

describe("renderLlamaServerCommands — windows (ROCm build, --device ROCm0)", () => {
  const sheet = renderLlamaServerCommands(
    options({
      os: "windows",
      bin: WIN_BIN,
      devices: ["ROCm0"],
      modelPath: WIN_MODEL,
      advertise: "192.168.1.71",
      autostart: true,
      gguf: GGUF,
    }),
  );

  it("orders the sections download → launch → firewall → keep-awake → autostart → client", () => {
    expect(sheet.sections.map((s) => s.title.split(" ")[0])).toEqual(["1.", "2.", "3.", "4.", "5.", "6."]);
    expect(sheet.sections.map((s) => s.title)).toEqual([
      "1. Download the model (PowerShell)",
      "2. Launch llama-server (PowerShell)",
      "3. Open the firewall (elevated PowerShell)",
      "4. Keep the host awake (elevated PowerShell)",
      "5. Start at boot (elevated PowerShell)",
      "6. Client configuration (tea-rags host)",
    ]);
  });

  it("downloads from the registry blob URL with Invoke-WebRequest and verifies with Get-FileHash", () => {
    const lines = section(sheet, "1.");
    expect(lines).toContain(`Invoke-WebRequest -Uri '${GGUF.blobUrl}' -OutFile '${WIN_MODEL}'`);
    expect(lines).toContain(`(Get-FileHash '${WIN_MODEL}' -Algorithm SHA256).Hash -eq '${SHA}'`);
    expect(lines).toContain("New-Item -ItemType Directory -Force -Path 'C:\\llama-models' | Out-Null");
  });

  it("prints one launch line for the device with the fixed embedding flags", () => {
    const launches = section(sheet, "2.").filter((l) => !l.startsWith("#"));
    expect(launches).toEqual([
      `${WIN_BIN} -m '${WIN_MODEL}' --embedding -ngl 999 -fa on -np 4 -c 32768 -b 8192 -ub 8192 --device ROCm0 --host 0.0.0.0 --port 8081`,
    ]);
  });

  it("opens the port range with netsh", () => {
    expect(section(sheet, "3.")).toContain(
      'netsh advfirewall firewall add rule name="tea-rags llama-server 8081" dir=in action=allow protocol=TCP localport=8081',
    );
  });

  it("disables standby on AC power", () => {
    expect(section(sheet, "4.")).toContain("powercfg /change standby-timeout-ac 0");
  });

  it("writes a .cmd launcher next to the model and registers it as an ONSTART scheduled task", () => {
    const launcher = "C:\\llama-models\\tea-rags-llama-server-8081.cmd";
    expect(section(sheet, "5.")).toEqual([
      `Set-Content -Path '${launcher}' -Encoding ASCII -Value '@echo off', '${WIN_BIN} -m ${WIN_MODEL} --embedding -ngl 999 -fa on -np 4 -c 32768 -b 8192 -ub 8192 --device ROCm0 --host 0.0.0.0 --port 8081'`,
      `schtasks --% /Create /TN "tea-rags llama-server 8081" /SC ONSTART /RL HIGHEST /RU SYSTEM /TR "\\"${launcher}\\""`,
      "# Optional, start it now:",
      'schtasks /Run /TN "tea-rags llama-server 8081"',
    ]);
  });

  it("keeps the schtasks /TR value within its 261-char limit for a long launch line", () => {
    const long = renderLlamaServerCommands(
      options({
        os: "windows",
        bin: WIN_BIN,
        devices: ["ROCm0", "Vulkan1"],
        modelPath: WIN_MODEL,
        apiKey: "a-long-enough-api-key-0123456789",
        autostart: true,
      }),
    );
    const lines = section(long, "4.");
    const launchers = lines.filter((l) => l.startsWith("Set-Content"));
    expect(launchers).toHaveLength(2);
    expect(launchers[1]).toContain(
      "--device Vulkan1 --host 0.0.0.0 --port 8082 --api-key a-long-enough-api-key-0123456789'",
    );
    const trValues = lines
      .filter((l) => l.startsWith("schtasks --% /Create"))
      .map((l) => /\/TR "(.*)"$/.exec(l)?.[1] ?? "");
    expect(trValues).toHaveLength(2);
    expect(trValues.every((v) => v.length > 0 && v.length <= 261)).toBe(true);
    expect(lines.some((l) => l.startsWith("REM"))).toBe(false);
  });

  it("advertises the LAN address, not 0.0.0.0, to the client", () => {
    expect(sheet.clientEnv).toEqual({
      EMBEDDING_PROVIDER: "llama-server",
      EMBEDDING_BASE_URL: "http://192.168.1.71:8081",
    });
    const client = section(sheet, "6.");
    expect(client).toContain("EMBEDDING_PROVIDER=llama-server");
    expect(client).toContain("EMBEDDING_BASE_URL=http://192.168.1.71:8081");
    expect(client.some((l) => l.includes("--host 127.0.0.1") && l.includes("EMBEDDING_FALLBACK_URL"))).toBe(true);
    expect(client.some((l) => l.includes("once per") && l.includes("--bin"))).toBe(true);
  });
});

describe("renderLlamaServerCommands — Vulkan build, --device Vulkan1", () => {
  it("prints the Vulkan device line on its own (one --bin per run)", () => {
    const sheet = renderLlamaServerCommands(
      options({
        os: "windows",
        bin: "C:\\llama\\vulkan\\llama-server.exe",
        devices: ["Vulkan1"],
        modelPath: WIN_MODEL,
        port: 8082,
        advertise: "192.168.1.71",
      }),
    );
    const launches = section(sheet, "1.").filter((l) => !l.startsWith("#"));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain("--device Vulkan1 --host 0.0.0.0 --port 8082");
    expect(sheet.clientEnv.EMBEDDING_BASE_URL).toBe("http://192.168.1.71:8082");
  });
});

describe("renderLlamaServerCommands — linux", () => {
  const sheet = renderLlamaServerCommands(
    options({ devices: ["ROCm0", "ROCm1"], advertise: "192.168.1.71", autostart: true, gguf: GGUF }),
  );

  it("downloads with curl and verifies with sha256sum", () => {
    const lines = section(sheet, "1.");
    expect(lines).toContain("mkdir -p ~/llama-models");
    expect(lines).toContain(`curl -L -o ~/llama-models/${GGUF.fileName} ${GGUF.blobUrl}`);
    expect(lines).toContain(`printf '%s  %s\\n' ${SHA} ~/llama-models/${GGUF.fileName} | sha256sum -c -`);
  });

  it("increments the port per device", () => {
    const launches = section(sheet, "2.").filter((l) => !l.startsWith("#"));
    expect(launches).toEqual([
      `/opt/llama/llama-server -m ~/llama-models/${GGUF.fileName} --embedding -ngl 999 -fa on -np 4 -c 32768 -b 8192 -ub 8192 --device ROCm0 --host 0.0.0.0 --port 8081`,
      `/opt/llama/llama-server -m ~/llama-models/${GGUF.fileName} --embedding -ngl 999 -fa on -np 4 -c 32768 -b 8192 -ub 8192 --device ROCm1 --host 0.0.0.0 --port 8082`,
    ]);
    expect(sheet.clientEnv.EMBEDDING_BASE_URL).toBe("http://192.168.1.71:8081,http://192.168.1.71:8082");
  });

  it("opens the port range with ufw", () => {
    expect(section(sheet, "3.")).toContain("sudo ufw allow 8081:8082/tcp");
  });

  it("points at systemd-inhibit for keep-awake", () => {
    expect(section(sheet, "4.").some((l) => l.includes("systemd-inhibit --what=sleep"))).toBe(true);
  });

  it("writes a systemd user unit per port and enables it", () => {
    const lines = section(sheet, "5.");
    expect(lines).toContain("cat > ~/.config/systemd/user/tea-rags-llama-server-8081.service <<'EOF'");
    expect(lines).toContain(
      `ExecStart=/opt/llama/llama-server -m %h/llama-models/${GGUF.fileName} --embedding -ngl 999 -fa on -np 4 -c 32768 -b 8192 -ub 8192 --device ROCm0 --host 0.0.0.0 --port 8081`,
    );
    expect(lines).toContain("systemctl --user enable --now tea-rags-llama-server-8081.service");
    expect(lines).toContain("systemctl --user enable --now tea-rags-llama-server-8082.service");
  });
});

describe("renderLlamaServerCommands — macos", () => {
  const sheet = renderLlamaServerCommands(
    options({
      os: "macos",
      bin: "/opt/homebrew/bin/llama-server",
      devices: ["MTL0"],
      autostart: true,
      gguf: GGUF,
      advertise: "mac.local",
    }),
  );

  it("verifies the download with shasum -a 256", () => {
    const lines = section(sheet, "1.");
    expect(lines).toContain(`curl -L -o ~/llama-models/${GGUF.fileName} ${GGUF.blobUrl}`);
    expect(lines).toContain(`printf '%s  %s\\n' ${SHA} ~/llama-models/${GGUF.fileName} | shasum -a 256 -c -`);
  });

  it("prints a note for the firewall and caffeinate -s for keep-awake", () => {
    expect(section(sheet, "3.").every((l) => l.startsWith("#"))).toBe(true);
    expect(section(sheet, "4.").some((l) => l.includes("caffeinate -s"))).toBe(true);
  });

  it("writes a launchd plist and bootstraps it", () => {
    const lines = section(sheet, "5.");
    const plist = "~/Library/LaunchAgents/com.tea-rags.llama-server.8081.plist";
    expect(lines).toContain(`cat > ${plist} <<'EOF'`);
    expect(lines).toContain(`launchctl bootstrap gui/$(id -u) ${plist}`);
    expect(lines.some((l) => l.includes("<string>com.tea-rags.llama-server.8081</string>"))).toBe(true);
  });
});

describe("renderLlamaServerCommands — options", () => {
  it("without devices prints one default launch line and the --list-devices hint", () => {
    const sheet = renderLlamaServerCommands(options({}));
    const lines = section(sheet, "1.");
    const launches = lines.filter((l) => !l.startsWith("#"));
    expect(launches).toEqual([
      `/opt/llama/llama-server -m ~/llama-models/${GGUF.fileName} --embedding -ngl 999 -fa on -np 4 -c 32768 -b 8192 -ub 8192 --host 0.0.0.0 --port 8081`,
    ]);
    expect(lines.some((l) => l.includes("/opt/llama/llama-server --list-devices") && l.includes("--device"))).toBe(
      true,
    );
  });

  it("skips the download section when no GGUF source is given", () => {
    const sheet = renderLlamaServerCommands(options({ devices: ["ROCm0"] }));
    expect(sheet.sections[0].title).toMatch(/^1\. Launch/);
    expect(sheet.sections.some((s) => s.title.includes("Download"))).toBe(false);
    expect(sheet.sections.some((s) => s.title.includes("Start at boot"))).toBe(false);
  });

  it("adds --api-key to every launch line and EMBEDDING_API_KEY to the client env", () => {
    const sheet = renderLlamaServerCommands(options({ devices: ["ROCm0", "ROCm1"], apiKey: "s3cret" }));
    const launches = section(sheet, "1.").filter((l) => !l.startsWith("#"));
    expect(launches.every((l) => l.endsWith("--api-key s3cret"))).toBe(true);
    expect(sheet.clientEnv.EMBEDDING_API_KEY).toBe("s3cret");
    expect(section(sheet, "4.")).toContain("EMBEDDING_API_KEY=s3cret");
  });

  it("uses the bind host in the client URL without --advertise and warns about 0.0.0.0", () => {
    const sheet = renderLlamaServerCommands(options({}));
    expect(sheet.clientEnv.EMBEDDING_BASE_URL).toBe("http://0.0.0.0:8081");
    expect(sheet.sections.at(-1)?.lines.some((l) => l.includes("--advertise"))).toBe(true);
  });

  it("scales the context with the slot count", () => {
    const sheet = renderLlamaServerCommands(options({ slots: 2 }));
    expect(section(sheet, "1.")[0]).toContain("-np 2 -c 16384 -b 8192 -ub 8192");
  });

  it("quotes a Windows path with spaces for PowerShell and for the scheduled-task command line", () => {
    const bin = "C:\\Program Files\\llama\\llama-server.exe";
    const model = `C:\\My Models\\${GGUF.fileName}`;
    const sheet = renderLlamaServerCommands(
      options({ os: "windows", bin, modelPath: model, devices: ["ROCm0"], autostart: true, gguf: GGUF }),
    );
    expect(section(sheet, "1.")).toContain(`Invoke-WebRequest -Uri '${GGUF.blobUrl}' -OutFile '${model}'`);
    expect(section(sheet, "1.")).toContain("New-Item -ItemType Directory -Force -Path 'C:\\My Models' | Out-Null");
    const launch = section(sheet, "2.").find((l) => !l.startsWith("#"));
    expect(launch?.startsWith(`& '${bin}' -m '${model}' --embedding`)).toBe(true);
    const autostart = section(sheet, "5.");
    expect(autostart[0]).toContain(`-Value '@echo off', '"${bin}" -m "${model}" --embedding`);
    expect(autostart[1]).toContain('/TR "\\"C:\\My Models\\tea-rags-llama-server-8081.cmd\\""');
  });

  it("quotes a POSIX path with spaces while keeping ~ expandable", () => {
    const sheet = renderLlamaServerCommands(
      options({ bin: "/opt/my llama/llama-server", modelPath: "~/my models/m.gguf" }),
    );
    expect(section(sheet, "1.").find((l) => !l.startsWith("#"))).toMatch(
      /^'\/opt\/my llama\/llama-server' -m ~\/'my models\/m\.gguf' /,
    );
  });
});

describe("formatLlamaServerCommandSheet", () => {
  it("renders titled sections separated by blank lines", () => {
    const text = formatLlamaServerCommandSheet({
      sections: [
        { title: "1. A", lines: ["a"] },
        { title: "2. B", lines: ["b1", "b2"] },
      ],
      clientEnv: {},
    });
    expect(text).toBe("## 1. A\na\n\n## 2. B\nb1\nb2\n");
  });
});
