import { parseArgs } from "node:util";

import { autoUpdateLogPath } from "../../bootstrap/auto-update/updater-log.js";
import {
  appDataDir,
  buildPrimeAgentAutoUpdateTrigger,
  formatAgentDigest,
  resolvePrimeAgentProject,
  type AutoUpdateTriggerOutcome,
  type CollectionEntry,
  type PrimeAgentProject,
} from "../../bootstrap/prime-agent.js";
import { readClientAutoUpdateSetting } from "../client-update/settings.js";
import { spawnDetachedClientUpdate } from "../client-update/spawner.js";
import { clientUpdateStatePath, ClientUpdateStateStore } from "../client-update/state-store.js";
import { ClientUpdateTrigger } from "../client-update/trigger.js";
import { formatPrime } from "../prime/format.js";

export interface PrimeAgentArgs {
  path?: string;
  project?: string;
}
export interface PrimeAgentDeps {
  resolveProject: (input: PrimeAgentArgs) => PrimeAgentProject | null;
  clientUpdate: { maybeSpawn: () => unknown; manualUpdateHint: () => string | null };
  autoUpdate: (entry: CollectionEntry) => AutoUpdateTriggerOutcome;
}

function primeAgentDeps(): PrimeAgentDeps {
  const dataDir = appDataDir();
  return {
    resolveProject: (input) => resolvePrimeAgentProject(input, dataDir),
    clientUpdate: new ClientUpdateTrigger({
      setting: () => readClientAutoUpdateSetting(dataDir, process.env),
      store: new ClientUpdateStateStore(clientUpdateStatePath(dataDir)),
      spawn: () => {
        spawnDetachedClientUpdate({ dataDir });
      },
      clock: () => Date.now(),
    }),
    autoUpdate: (entry) => buildPrimeAgentAutoUpdateTrigger(entry, dataDir).maybeSpawn(entry.collectionName),
  };
}

/** Registry addressing is available even when backend readiness cannot be checked. */
export async function runPrimeAgent(args: PrimeAgentArgs, deps: PrimeAgentDeps = primeAgentDeps()): Promise<number> {
  deps.clientUpdate.maybeSpawn();
  const path = args.path || (args.project ? undefined : process.cwd());
  const input = { ...(path !== undefined ? { path } : {}), ...(args.project ? { project: args.project } : {}) };
  const writePrime = (output: Parameters<typeof formatPrime>[0]): void => {
    process.stdout.write(formatPrime({ ...output, clientUpdateHint: deps.clientUpdate.manualUpdateHint() }));
  };
  const found = deps.resolveProject(input);
  if (!found) {
    writePrime(
      args.project
        ? { kind: "path-not-found", path: `(project '${args.project}' not registered)` }
        : { kind: "status-failed", path: path ?? process.cwd(), message: "No local registry binding found." },
    );
    return 0;
  }
  writePrime({
    digest: formatAgentDigest(
      {
        path: found.path,
        projectName: found.entry.name ?? null,
        registry: found.entry,
        status: null,
        metrics: null,
        drift: null,
      },
      new Date(),
    ),
    registry: found.entry,
    update: null,
    agent: true,
    autoUpdateOutcome: deps.autoUpdate(found.entry),
    autoUpdateLogPath: autoUpdateLogPath(appDataDir(), found.entry.name ?? found.entry.collectionName),
  });
  return 0;
}

/** Only the agent/no-full route is selected before yargs; human/full/help stay unchanged. */
export async function runPrimeAgentArgv(argv: readonly string[], deps?: PrimeAgentDeps): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        agent: { type: "boolean" },
        project: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (!values.agent || positionals.length > 1) return 2;
    return runPrimeAgent(
      {
        ...(positionals[0] !== undefined ? { path: positionals[0] } : {}),
        ...(values.project !== undefined ? { project: values.project } : {}),
      },
      deps,
    );
  } catch {
    return 2;
  }
}
