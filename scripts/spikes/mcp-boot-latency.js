#!/usr/bin/env node
// Spike (bd tea-rags-mcp-o4p5l): MCP server boot-to-ready latency over stdio.
// Spawns `node <entry> server`, sends initialize → notifications/initialized →
// tools/list, and records wall time from spawn to each answer. Prints one JSON
// line per run plus a p50/p95 summary.
//
// Usage: node scripts/spikes/mcp-boot-latency.js [--runs N] [--entry build/cli/index.js]
//        [--env-from user|<projectDir>]   (copies the tea-rags MCP env from ~/.claude.json)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const runs = Number(opt("runs", "5"));
const entry = resolve(opt("entry", "build/cli/index.js"));
const envFrom = opt("env-from", "user");

function mcpEnv() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.claude.json`, "utf8"));
  const server = envFrom === "user" ? cfg.mcpServers?.["tea-rags"] : cfg.projects?.[envFrom]?.mcpServers?.["tea-rags"];
  return server?.env ?? {};
}

function once() {
  return new Promise((done, fail) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [entry, "server"], {
      env: { ...process.env, ...mcpEnv() },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const marks = {};
    let buf = "";
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("timeout"));
    }, 30000);
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          marks.initializeMs = performance.now() - t0;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2) {
          marks.toolsListMs = performance.now() - t0;
          marks.tools = msg.result?.tools?.length ?? 0;
          clearTimeout(timer);
          child.kill("SIGTERM");
          done(marks);
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "boot-spike", version: "0" } },
    });
  });
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const results = [];
for (let i = 0; i < runs; i++) {
  const r = await once();
  results.push(r);
  console.log(JSON.stringify({ run: i + 1, ...r }));
  await new Promise((r2) => setTimeout(r2, 300));
}
for (const k of ["initializeMs", "toolsListMs"]) {
  const xs = results.map((r) => r[k]);
  console.log(`${k}: p50=${pct(xs, 50).toFixed(0)} p95=${pct(xs, 95).toFixed(0)}`);
}
