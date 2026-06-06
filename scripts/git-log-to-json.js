// scripts/git-log-to-json.js
// Reads `git log --format=%H%x1f%s%x1f%b%x1e` from stdin, emits JSON array of
// { hash, subject, body }. Fields are \x1f-delimited; records are \x1e-delimited.
import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");
const records = raw
  .split("\x1e")
  .map((r) => r.trim())
  .filter(Boolean);

const out = records.map((r) => {
  const [hash, subject, body = ""] = r.split("\x1f");
  return { hash: hash.slice(0, 7), subject: subject.trim(), body: body.trim() };
});

process.stdout.write(JSON.stringify(out, null, 2));
