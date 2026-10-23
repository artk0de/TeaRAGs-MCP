import type { App, CollectionEntry, IndexMetrics, LanguageCapability } from "../../../../src/core/api/public/index.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

export const NOW = new Date("2026-10-23T12:00:00Z");
export const THREE_DAYS_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
export const PRIMARIES = ["ruby", "typescript", "python", "go"] as const;

const SIGNAL_NAMES = [
  "git.file.commitCount",
  "git.file.ageDays",
  "git.file.bugFixRate",
  "git.file.churnVolatility",
  "git.file.relativeChurn",
  "git.file.recencyWeightedFreq",
  "git.file.changeDensity",
  "git.file.blameDominantAuthorPct",
  "git.chunk.commitCount",
  "git.chunk.ageDays",
  "git.chunk.bugFixRate",
  "git.chunk.churnRatio",
  "codegraph.chunk.pageRank",
  "codegraph.chunk.fanIn",
  "codegraph.chunk.fanOut",
  "codegraph.file.fanIn",
  "methodLines",
  "methodDensity",
  "moduleLines",
  "memberCount",
];

function scope(offset: number): IndexMetrics["signals"][string][string][string] {
  return {
    min: 0,
    max: 100,
    count: 1000,
    labelMap: { low: 0, typical: 2 + offset, high: 7 + offset, extreme: 21 + offset },
  };
}

/** Every primary language carries a full per-language thresholds bucket (source + test). */
export function fixtureMetrics(): IndexMetrics {
  const signals: IndexMetrics["signals"] = {};
  PRIMARIES.forEach((language, index) => {
    signals[language] = Object.fromEntries(
      SIGNAL_NAMES.map((name) => [name, { source: scope(index), test: scope(index + 1) }]),
    );
  });
  return {
    collection: "code_fixture",
    totalChunks: 4000,
    totalFiles: 400,
    distributions: {
      totalFiles: 400,
      language: { ruby: 1600, typescript: 1200, python: 700, go: 400, markdown: 100 },
      chunkType: {},
      documentation: { docs: 10, code: 390 },
      topAuthors: [],
      topBlameAuthors: [],
      othersCount: 0,
    },
    signals,
  };
}

function capability(language: string): LanguageCapability {
  return {
    language,
    languageVersion: { policy: "unversioned", evidence: "fixture", limitations: "fixture only" },
    ast: { tier: "full", engine: "e" },
    tests: { tier: "high", detection: "d", tech: "t" },
    codegraph: { tier: "high", tech: "t", symbolKindRoles: { callee: new Set(), receiver: new Set() } },
    versions: { chunking: 1, walker: 1, codegraphSchema: 1 },
  };
}

export function fixtureCapabilities(languages: readonly string[]): Map<string, LanguageCapability> {
  return new Map(languages.map((language) => [language, capability(language)]));
}

export const FIXTURE_ENTRY = {
  name: "fixture",
  path: "/repo/fixture",
  collectionName: "code_fixture",
  codegraphEnabled: true,
  env: { TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12" },
} as unknown as CollectionEntry;

export function fixtureData(overrides: Partial<ProjectDigestData> = {}): ProjectDigestData {
  const metrics = fixtureMetrics();
  return {
    path: "/repo/fixture",
    projectName: "fixture",
    registry: FIXTURE_ENTRY,
    status: {
      isIndexed: true,
      status: "indexed",
      collectionName: "code_fixture",
      filesCount: 400,
      chunksCount: 4000,
      lastUpdated: THREE_DAYS_AGO,
      codegraphResolve: {
        inProjectEdgeRecall: 0.9,
        callsUnnarrowedTemplate: 0,
        byLanguage: PRIMARIES.map((language) => ({
          language,
          inProjectEdgeRecall: 0.9,
          callsUnnarrowedTemplate: language === "ruby" ? 7 : 0,
        })),
      },
    } as ProjectDigestData["status"],
    metrics,
    drift: "3 files changed since index · Run: index_codebase",
    memory: null,
    languageCapabilities: fixtureCapabilities(Object.keys(metrics.distributions.language)),
    ...overrides,
  };
}

/** A stub App answering every read the project resources fan out to. */
export function fixtureApp(): App {
  const data = fixtureData();
  return {
    listProjects: async () => Promise.resolve({ projects: [FIXTURE_ENTRY] }),
    getIndexStatus: async () => Promise.resolve(data.status),
    getIndexMetrics: async () => Promise.resolve(data.metrics),
    checkIndexDrift: async () => Promise.resolve(data.drift),
    getCollectionMemory: async () => Promise.resolve(null),
    resolveLanguageCapabilities: (languages: readonly string[]) => fixtureCapabilities(languages),
    getSchemaDescriptors: () => ({
      presetNames: {},
      presetDetails: {},
      signalDescriptors: [],
      payloadSignals: [],
    }),
    renderLanguageCapabilityGuide: () => "",
    listCollections: async () => Promise.resolve([]),
  } as unknown as App;
}
