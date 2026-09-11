/**
 * SPIKE (bd tea-rags-mcp-w205u, E4.0.1) — site enumeration + a jedi reference
 * answer set, from ONE corpus walk.
 *
 * The LSP probe must ask about exactly the sites the jedi host enumerates, so
 * the enumeration is REUSED (`walkCorpus`) rather than re-parsed. This driver
 * writes three artefacts from a single walk:
 *
 *   <out>-degraded-sites.ndjson    sites in files parso 0.8.7 cannot read
 *   <out>-agreement-sites.ndjson   seeded sample from files parso reads cleanly
 *   <out>-jedi-agreement.ndjson    jedi's answer for each agreement site
 *
 * Usage:
 *   npx tsx scripts/spikes/py-site-dump.ts --corpus polar \
 *     --degraded-files /tmp/e4/polar-degraded.txt --out /tmp/e4/polar \
 *     [--sample 500] [--seed 20260910] [--workers 8]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { mulberry32 } from "../lib/py-oracle-core.js";
import { askOracle, buildRows, parseArgs, walkCorpus } from "../py-codegraph-jedi-oracle.js";

interface SpikeSite {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  receiverKind: string;
}

const read = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const writeNdjson = (path: string, rows: readonly unknown[]): void => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const out = read("--out") ?? "/tmp/e4/corpus";
  const sampleSize = Number(read("--sample") ?? 500);
  const seed = Number(read("--seed") ?? 20260910);
  const degradedPaths = new Set(
    readFileSync(read("--degraded-files") ?? "", "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.split("\t")[0]),
  );

  const walk = await walkCorpus(options.corpusRoot, options.limit, true);
  const asSite = (index: number): SpikeSite => {
    const site = walk.sites[index];
    return {
      relPath: site.relPath,
      startLine: site.call.startLine,
      callText: site.call.callText,
      receiver: site.call.receiver,
      member: site.call.member,
      receiverKind: site.receiverKind,
    };
  };

  const degradedIndexes: number[] = [];
  const cleanIndexes: number[] = [];
  for (let index = 0; index < walk.sites.length; index++) {
    (degradedPaths.has(walk.sites[index].relPath) ? degradedIndexes : cleanIndexes).push(index);
  }

  // Fisher-Yates over the INDEX list, exactly as `samplePyRows` draws, so the
  // sample depends only on the seed and the pool size.
  const random = mulberry32(seed);
  const shuffled = [...cleanIndexes];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const agreementIndexes = shuffled.slice(0, sampleSize).sort((a, b) => a - b);

  writeNdjson(`${out}-degraded-sites.ndjson`, degradedIndexes.map(asSite));
  writeNdjson(`${out}-agreement-sites.ndjson`, agreementIndexes.map(asSite));

  const degradedFiles = new Set(degradedIndexes.map((index) => walk.sites[index].relPath));
  process.stdout.write(
    [
      `walk files ${String(walk.files)} · sites ${String(walk.sites.length)} · chainDrift ${String(walk.chainDrift)}`,
      `degraded files walked ${String(degradedFiles.size)} of ${String(degradedPaths.size)} parso-degraded`,
      `degraded sites ${String(degradedIndexes.length)} · clean sites ${String(cleanIndexes.length)}`,
      `agreement sample ${String(agreementIndexes.length)} seed ${String(seed)}`,
      "",
    ].join("\n"),
  );

  const agreementSites = agreementIndexes.map((index) => walk.sites[index]);
  const replies = await askOracle(agreementSites, {
    corpusRoot: options.corpusRoot,
    python: options.pythonArgv,
    venvPython: options.venvPython,
    roots: options.roots,
    workers: options.workers,
  });
  const rows = buildRows(agreementSites, replies);
  // Same per-file CURSOR `buildRows` joins on: the Nth site of a file matches
  // the Nth answer, so the raw target is read back in the host's own order.
  const cursor = new Map<string, number>();
  writeNdjson(
    `${out}-jedi-agreement.ndjson`,
    rows.map((row) => {
      const index = cursor.get(row.relPath) ?? 0;
      cursor.set(row.relPath, index + 1);
      const answer = replies.get(row.relPath)?.answers[index];
      const target = answer?.outcome.targets?.[0];
      return {
        relPath: row.relPath,
        startLine: row.startLine,
        callText: row.callText,
        receiver: row.receiver,
        member: row.member,
        oracleKind: answer?.outcome.kind ?? "unknown",
        oracleOrigin: row.origin ?? null,
        oracleTargetRelPath: target?.relPath ?? null,
        oracleTargetSymbolId: target?.symbolId ?? null,
        oracleDegraded: row.oracleDegraded,
        verdict: row.verdict,
      };
    }),
  );
  process.stdout.write(`jedi answers written for ${String(rows.length)} agreement sites\n`);
}

await main();
