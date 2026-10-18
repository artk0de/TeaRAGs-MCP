import { z } from "zod";

import type { OracleAnswer } from "./codegraph-oracle-core.js";
import type { TallyEdgeDumpRow } from "./tally-edge-dump.js";

const count = z.number().int().nonnegative();
const cost = z.number().finite().nonnegative();
const text = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const targetSchema = z.object({ targetRelPath: text, targetSymbolId: text.nullable() }).strict();
const siteSchema = z
  .object({ relPath: text, line: count.min(1), callText: text, startColumn: count.optional() })
  .strict();
const edgeKinds =
  /^(exact|fileOnly|none|dispatchTable|runner:(exact|cone|poly-base|dynamic|registry)(@(0(\.\d+)?|1(\.0+)?))?)$/;
const rowSchema = siteSchema
  .extend({
    receiverKind: text,
    targetRelPath: text.nullable(),
    targetSymbolId: text.nullable(),
    edgeKind: z.string().regex(edgeKinds),
  })
  .strict()
  .superRefine((row, ctx) => {
    const confidence = row.edgeKind.split("@")[1];
    if (confidence !== undefined && Number(confidence) <= 0) {
      ctx.addIssue({ code: "custom", message: "edge confidence must be in (0,1]" });
    }
    if (
      (row.edgeKind.startsWith("runner:") || row.edgeKind === "exact" || row.edgeKind === "fileOnly") &&
      row.targetRelPath === null
    ) {
      ctx.addIssue({ code: "custom", message: "edge requires target path" });
    }
  });
const oracleSiteSchema = siteSchema
  .extend({
    classification: z.enum(["inProject", "external", "unknown", "inactive-cfg", "generated"]),
    expected: z.array(targetSchema),
  })
  .strict()
  .superRefine((site, ctx) => {
    if ((site.classification === "inProject") !== site.expected.length > 0) {
      ctx.addIssue({ code: "custom", message: "only inProject sites carry a nonempty complete expected target set" });
    }
  });
const oracleSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-run"), reason: text }).strict(),
  z
    .object({
      status: z.literal("ingested"),
      source: text,
      identityScheme: z.literal("tally-line-callText-startColumn-v1"),
      sites: z.array(oracleSiteSchema).superRefine((sites, ctx) => {
        const seen = new Set<string>();
        for (const site of sites) {
          const key = rustTallySiteKey(site);
          if (seen.has(key)) ctx.addIssue({ code: "custom", message: `duplicate oracle site: ${key}` });
          seen.add(key);
        }
      }),
    })
    .strict(),
]);
const timingSchema = z.object({ pass1Ms: cost, pass2Ms: cost, totalMs: cost, peakRssMb: cost }).strict();
export const rustCodegraphArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpus: z
      .object({
        alias: text,
        commit: sha,
        config: text,
        options: z
          .object({
            timeOnly: z.boolean().optional(),
            timing: z.boolean().optional(),
            kindStats: z.boolean().optional(),
            persisted: z.boolean().optional(),
            edgeDump: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    engine: z.object({ commit: sha, dirty: z.boolean() }).strict(),
    workload: z
      .object({
        files: count,
        sites: count,
        symbols: count,
        loc: count,
        siteDigest: z.string().regex(/^[a-f0-9]{64}$/),
        dispatch: z.boolean(),
      })
      .strict(),
    environment: z
      .object({
        node: text,
        platform: text,
        arch: text,
        cpuModel: text,
        cpuCount: count.min(1),
        nodeOptions: z.string(),
        resolverEnv: z.record(z.string(), z.string()).optional(),
        loadMonitoring: z
          .object({ status: z.enum(["sampled", "insufficient"]), samples: count, maxLoadPerCpu: cost })
          .strict()
          .optional(),
        loadPerCpu: cost,
      })
      .strict(),
    identityScheme: z.literal("tally-line-callText-startColumn-v1"),
    measurementScope: z.literal("fresh-extraction-and-production-resolver"),
    chainDrift: z.object({ status: z.literal("not-run"), reason: text }).strict(),
    oracle: oracleSchema,
    timing: timingSchema,
    kindStats: z.record(z.string(), z.record(z.string(), cost)).optional(),
    rows: z.array(rowSchema).superRefine((rows, ctx) => {
      const seen = new Set<string>();
      for (const row of rows) {
        const kind = channel(row);
        if (kind === null) continue;
        const key = `${kind}:${edgeKey(row)}`;
        if (seen.has(key)) ctx.addIssue({ code: "custom", message: `duplicate prediction: ${key}` });
        seen.add(key);
      }
    }),
  })
  .strict();
export type RustCodegraphArtifact = z.infer<typeof rustCodegraphArtifactSchema>;

const policySchema = z
  .object({
    adjudications: z
      .array(z.object({ edge: rowSchema, verdict: z.enum(["valid", "incorrect"]), reason: text }).strict())
      .default([]),
    maxValidEdgeLoss: count.optional(),
    maxFalseEdgeGain: count.optional(),
    maxCostRatio: z
      .object({
        pass1Ms: cost.positive().optional(),
        pass2Ms: cost.positive().optional(),
        totalMs: cost.positive().optional(),
        peakRssMb: cost.positive().optional(),
      })
      .strict()
      .default({}),
    maxLoadPerCpu: cost.positive().default(2),
  })
  .strict();

/**
 * Legacy tally coordinates with the one span the walker proves: a walker that
 * records `startColumn` (Rust today) keys two identical calls on one line
 * apart; an absent column keys as null, so older shapes stay comparable.
 */
export function rustTallySiteKey(site: {
  relPath: string;
  line: number;
  callText: string;
  startColumn?: number;
}): string {
  return JSON.stringify([site.relPath, site.line, site.callText.replace(/[\t\r\n]/g, " "), site.startColumn ?? null]);
}
function targetKey(target: OracleAnswer): string {
  return JSON.stringify([target.targetRelPath, target.targetSymbolId]);
}
function edgeKey(row: TallyEdgeDumpRow): string {
  return JSON.stringify([rustTallySiteKey(row), row.targetRelPath, row.targetSymbolId]);
}
function channel(row: TallyEdgeDumpRow): "exact" | "candidate" | null {
  if (!row.edgeKind.startsWith("runner:")) return null;
  return row.edgeKind.split("@")[0] === "runner:exact" ? "exact" : "candidate";
}
function predictions(artifact: RustCodegraphArtifact, kind: "exact" | "candidate") {
  return new Map(artifact.rows.filter((row) => channel(row) === kind).map((row) => [edgeKey(row), row]));
}
function diffEdges(before: Map<string, TallyEdgeDumpRow>, after: Map<string, TallyEdgeDumpRow>) {
  const sorted = (rows: TallyEdgeDumpRow[]) => rows.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  return {
    lost: sorted([...before].filter(([key]) => !after.has(key)).map(([, row]) => row)),
    gained: sorted([...after].filter(([key]) => !before.has(key)).map(([, row]) => row)),
    retained: [...before.keys()].filter((key) => after.has(key)).length,
    provenanceChanged: [...before].flatMap(([key, row]) => {
      const next = after.get(key);
      return next !== undefined && row.edgeKind !== next.edgeKind ? [{ before: row, after: next }] : [];
    }),
  };
}

/** Independent input seam only: no Rust oracle transport or external classifier. */
function oracleMetrics(artifact: RustCodegraphArtifact) {
  const buckets = { inProject: 0, external: 0, unknown: 0, generated: 0, "inactive-cfg": 0 };
  const empty = {
    exactRecall: null as number | null,
    candidateRecall: null as number | null,
    exactPrecision: null as number | null,
    candidatePrecision: null as number | null,
  };
  if (artifact.oracle.status === "not-run") {
    return { ...empty, status: "not-run", buckets, classifiedSites: 0, expectedTargets: 0, source: null };
  }
  const known = new Map<string, Set<string>>();
  for (const site of artifact.oracle.sites) {
    const key = rustTallySiteKey(site);
    if (known.has(key)) throw new Error(`duplicate oracle site: ${key}`);
    // Unknown, cfg and generated are not negative truth.
    buckets[site.classification]++;
    known.set(key, new Set(site.expected.map(targetKey)));
  }
  const scored = new Map(
    artifact.oracle.sites
      .filter((s) => s.classification === "inProject" || s.classification === "external")
      .map((s) => [rustTallySiteKey(s), new Set(s.expected.map(targetKey))]),
  );
  const expectedTargets = artifact.oracle.sites
    .filter((s) => s.classification === "inProject")
    .reduce((n, s) => n + new Set(s.expected.map(targetKey)).size, 0);
  const rate = (n: number, d: number) => (d === 0 ? null : n / d);
  const metrics = (kind: "exact" | "candidate") => {
    let correct = 0;
    let predicted = 0;
    for (const row of predictions(artifact, kind).values()) {
      const targets = scored.get(rustTallySiteKey(row));
      if (targets === undefined) continue;
      predicted++;
      if (
        row.targetRelPath !== null &&
        targets.has(targetKey({ targetRelPath: row.targetRelPath, targetSymbolId: row.targetSymbolId }))
      ) {
        correct++;
      }
    }
    return { recall: rate(correct, expectedTargets), precision: rate(correct, predicted) };
  };
  const exact = metrics("exact");
  const candidate = metrics("candidate");
  return {
    status: "ingested",
    source: artifact.oracle.source,
    buckets,
    classifiedSites: known.size,
    expectedTargets,
    exactRecall: exact.recall,
    candidateRecall: candidate.recall,
    exactPrecision: exact.precision,
    candidatePrecision: candidate.precision,
  };
}

/** Compare artifacts only; configured gates never substitute resolve rate for recall. */
export function compareRustCodegraphArtifacts(beforeInput: unknown, afterInput: unknown, policyInput: unknown = {}) {
  const before = rustCodegraphArtifactSchema.parse(beforeInput);
  const after = rustCodegraphArtifactSchema.parse(afterInput);
  const policy = policySchema.parse(policyInput);
  const { options: beforeOptions, ...beforeCorpus } = before.corpus;
  const { options: afterOptions, ...afterCorpus } = after.corpus;
  if (JSON.stringify(beforeCorpus) !== JSON.stringify(afterCorpus)) throw new Error("corpus pin/config mismatch");
  const knownTruth = new Map<string, Set<string>>();
  const sources = new Set<string>();
  const classifications = new Map<string, string>();
  for (const artifact of [before, after]) {
    if (artifact.oracle.status !== "ingested") continue;
    sources.add(artifact.oracle.source);
    for (const site of artifact.oracle.sites) {
      if (site.classification === "unknown") continue;
      const key = rustTallySiteKey(site);
      const classification = classifications.get(key);
      if (classification !== undefined && classification !== site.classification) {
        throw new Error(`incomparable contradictory oracle classification: ${key}`);
      }
      classifications.set(key, site.classification);
      if (site.classification !== "inProject" && site.classification !== "external") continue;
      const targets = new Set(site.expected.map(targetKey));
      const previous = knownTruth.get(key);
      if (previous !== undefined && (previous.size !== targets.size || [...previous].some((t) => !targets.has(t)))) {
        throw new Error(`incomparable contradictory oracle truth: ${key}`);
      }
      knownTruth.set(key, targets);
    }
  }
  if (sources.size > 1) throw new Error("incomparable oracle source mismatch");
  const edges = {
    exact: diffEdges(predictions(before, "exact"), predictions(after, "exact")),
    candidate: diffEdges(predictions(before, "candidate"), predictions(after, "candidate")),
  };
  const adjudications = new Map<string, string>();
  for (const item of policy.adjudications) {
    const kind = channel(item.edge);
    if (kind === null) throw new Error("adjudication must name a runner edge");
    const key = `${kind}:${edgeKey(item.edge)}`;
    if (adjudications.has(key)) throw new Error("duplicate edge adjudication");
    adjudications.set(key, item.verdict);
  }
  const oracleTruth = (row: TallyEdgeDumpRow): string | undefined => {
    const targets = knownTruth.get(rustTallySiteKey(row));
    if (targets === undefined) return undefined;
    return targets.has(JSON.stringify([row.targetRelPath, row.targetSymbolId])) ? "valid" : "incorrect";
  };
  let validEdgeLoss = 0;
  let falseEdgeGain = 0;
  let unjudgedEdgeLoss = 0;
  let unjudgedEdgeGain = 0;
  for (const kind of ["exact", "candidate"] as const) {
    const truth = (row: TallyEdgeDumpRow) => {
      const adjudicated = adjudications.get(`${kind}:${edgeKey(row)}`);
      const independent = oracleTruth(row);
      if (adjudicated !== undefined && independent !== undefined && adjudicated !== independent) {
        throw new Error("adjudication contradicts independent oracle truth");
      }
      return adjudicated ?? independent;
    };
    for (const row of edges[kind].lost) {
      const verdict = truth(row);
      if (verdict === "valid") validEdgeLoss++;
      else if (verdict === undefined) unjudgedEdgeLoss++;
    }
    for (const row of edges[kind].gained) {
      const verdict = truth(row);
      if (verdict === "incorrect") falseEdgeGain++;
      else if (verdict === undefined) unjudgedEdgeGain++;
    }
  }
  const comparableWorkload = JSON.stringify(before.workload) === JSON.stringify(after.workload);
  const environmentIdentity = ({
    loadPerCpu: _load,
    loadMonitoring: _monitoring,
    ...identity
  }: RustCodegraphArtifact["environment"]) => identity;
  const stableJson = (value: Record<string, unknown>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const comparableConfiguration =
    beforeOptions !== undefined &&
    afterOptions !== undefined &&
    stableJson(beforeOptions) === stableJson(afterOptions) &&
    before.environment.resolverEnv !== undefined &&
    after.environment.resolverEnv !== undefined &&
    stableJson(before.environment.resolverEnv) === stableJson(after.environment.resolverEnv);
  const comparableEnvironment =
    JSON.stringify(environmentIdentity(before.environment)) ===
      JSON.stringify(environmentIdentity(after.environment)) &&
    [before.environment, after.environment].every(
      (env) =>
        env.loadMonitoring?.status === "sampled" &&
        env.loadMonitoring.samples >= 3 &&
        Math.max(env.loadPerCpu, env.loadMonitoring.maxLoadPerCpu) <= policy.maxLoadPerCpu,
    );
  const comparable = comparableWorkload && comparableEnvironment && comparableConfiguration;
  const deltas = Object.fromEntries(
    (Object.keys(before.timing) as (keyof typeof before.timing)[]).map((key) => [
      key,
      {
        before: before.timing[key],
        after: after.timing[key],
        ratio: comparable && before.timing[key] > 0 ? after.timing[key] / before.timing[key] : null,
      },
    ]),
  );
  const failures: string[] = [];
  if (policy.maxValidEdgeLoss !== undefined && unjudgedEdgeLoss > 0) {
    failures.push(`valid-edge-loss-unmeasured:${unjudgedEdgeLoss}`);
  }
  if (policy.maxFalseEdgeGain !== undefined && unjudgedEdgeGain > 0) {
    failures.push(`false-edge-gain-unmeasured:${unjudgedEdgeGain}`);
  }
  if (policy.maxValidEdgeLoss !== undefined && validEdgeLoss > policy.maxValidEdgeLoss) {
    failures.push(`valid-edge-loss:${validEdgeLoss}>${policy.maxValidEdgeLoss}`);
  }
  if (policy.maxFalseEdgeGain !== undefined && falseEdgeGain > policy.maxFalseEdgeGain) {
    failures.push(`false-edge-gain:${falseEdgeGain}>${policy.maxFalseEdgeGain}`);
  }
  for (const [key, threshold] of Object.entries(policy.maxCostRatio)) {
    if (!comparable) {
      failures.push(`cost-unmeasured:incomparable-${comparableWorkload ? "environment" : "workload"}`);
      break;
    }
    const { ratio } = deltas[key];
    if (ratio === null) failures.push(`cost-unmeasured:zero-baseline:${key}`);
    else if (ratio > threshold) failures.push(`cost-regression:${key}`);
  }
  return {
    exitCode: failures.length > 0 ? 1 : 0,
    failures,
    gate: {
      status:
        policy.maxValidEdgeLoss !== undefined ||
        policy.maxFalseEdgeGain !== undefined ||
        Object.keys(policy.maxCostRatio).length > 0
          ? "enforced"
          : "report-only",
      enforced:
        policy.maxValidEdgeLoss !== undefined ||
        policy.maxFalseEdgeGain !== undefined ||
        Object.keys(policy.maxCostRatio).length > 0,
    },
    oracleComparison: { source: [...sources][0] ?? null, truth: "merged-known-sites", knownSites: knownTruth.size },
    edges,
    validEdgeLoss,
    falseEdgeGain,
    unjudgedEdgeLoss,
    unjudgedEdgeGain,
    oracle: { before: oracleMetrics(before), after: oracleMetrics(after) },
    receiverKindStats: {
      before: before.kindStats ?? null,
      after: after.kindStats ?? null,
      denominatorContract: "production tallyCallSiteVerdict counters; resolveSuccessRate is not target recall",
    },
    chainDrift: { before: before.chainDrift, after: after.chainDrift },
    extractionCoverage: null,
    denominatorContract:
      "legacy extracted tally sites only; independent complete expected target sets for recall; predictions at inProject/external oracle sites for precision; unknown/generated/inactive-cfg excluded",
    cost: {
      status: comparable ? "comparable" : "incomparable",
      deltas,
      scope:
        "pass1=walk/extract/table/type channels; pass2=resolve; total=harness internal, not process wall; RSS=in-process sampled, not process-tree",
    },
    unmeasured: [
      "pre-extraction/source-span coverage",
      "resolver-only iteration",
      "parse/chunk/apply/embedding/backpressure isolation",
      "process-tree RSS",
      "endpoint identity (no embedding endpoint used)",
    ],
  };
}

export function parseRustTallyDump(tsv: string): TallyEdgeDumpRow[] {
  const marker = tsv.indexOf("#kind-stats\n");
  if (marker < 0) throw new Error("missing tally kind-stats boundary");
  return tsv
    .slice(0, marker)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const cells = line.split("\t");
      if (cells.length !== 8) throw new Error("tally row requires eight TSV cells");
      const [relPath, startLine, callText, startColumn, receiverKind, targetRelPath, targetSymbolId, edgeKind] = cells;
      return rowSchema.parse({
        relPath,
        line: Number(startLine),
        callText,
        startColumn: startColumn === "-" ? undefined : Number(startColumn),
        receiverKind,
        targetRelPath: targetRelPath === "-" ? null : targetRelPath,
        targetSymbolId: targetSymbolId === "-" ? null : targetSymbolId,
        edgeKind,
      });
    });
}
