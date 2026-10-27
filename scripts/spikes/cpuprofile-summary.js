#!/usr/bin/env node
// Spike (bd tea-rags-mcp-o4p5l): summarise a V8 .cpuprofile — self time by
// package/file bucket and the top self-time functions. Idle/GC/program shown.
// Usage: node scripts/spikes/cpuprofile-summary.js <file.cpuprofile> [topN]
import { readFileSync } from "node:fs";

const [file, topArg] = process.argv.slice(2);
const top = Number(topArg ?? 25);
const prof = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const dt = new Map();
for (let i = 0; i < prof.samples.length; i++) {
  const id = prof.samples[i];
  dt.set(id, (dt.get(id) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000);
}
const bucket = (url) => {
  if (!url) return "(native)";
  const nm = url.lastIndexOf("node_modules/");
  if (nm >= 0) {
    const rest = url.slice(nm + 13).split("/");
    return `npm:${rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]}`;
  }
  const b = url.indexOf("/build/");
  if (b >= 0) {
    return `build:${url
      .slice(b + 7)
      .split("/")
      .slice(0, 3)
      .join("/")}`;
  }
  if (url.startsWith("node:")) return "node-internal";
  return url.slice(-60);
};
const buckets = new Map();
const fns = new Map();
let total = 0;
for (const [id, ms] of dt) {
  const n = byId.get(id);
  const cf = n.callFrame;
  total += ms;
  const b = cf.functionName.startsWith("(") ? cf.functionName : bucket(cf.url);
  buckets.set(b, (buckets.get(b) ?? 0) + ms);
  const key = `${cf.functionName || "(anon)"} ${bucket(cf.url)}:${cf.lineNumber}`;
  fns.set(key, (fns.get(key) ?? 0) + ms);
}
const wall = (prof.endTime - prof.startTime) / 1000;
console.log(`wall=${wall.toFixed(0)}ms sampled=${total.toFixed(0)}ms`);
console.log("-- buckets --");
for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${v.toFixed(0).padStart(7)} ${k}`);
}
console.log("-- functions --");
for (const [k, v] of [...fns].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${v.toFixed(0).padStart(7)} ${k}`);
}
