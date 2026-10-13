/**
 * Change-reason extraction (B1, bd tea-rags-mcp-psh3j) — SRP as a
 * measurement: the distinct reasons a module has historically changed for.
 *
 * Owner decision 2026-10-13: a ticket's DOMAIN is derived from code, never
 * from ticket naming — the dominant component of every file its commits
 * touched, the module under measurement excluded from the vote. A module's
 * change reasons are the distinct domains of the tickets that changed it.
 *
 * Rules an edit must keep:
 *   - the vote counts DISTINCT files per component over ALL of the ticket's
 *     commits, not only the ones that touched the module — the ticket's work,
 *     not its footprint in the module;
 *   - a tie puts the ticket under EVERY tied component: a ticket spread evenly
 *     over two components is evidence for both, and a name-order pick would
 *     invent a preference the history does not hold;
 *   - a ticket that touched nothing outside the module (or only files outside
 *     the partition) is a reason of the module's OWN domain, voted over its
 *     files inside the module;
 *   - files outside the partition (tests, docs, non-production) neither vote
 *     nor form a module;
 *   - a commit naming no ticket is `untracked` — counted, never a reason;
 *   - below {@link CHANGE_REASON_MIN_TASK_ID_COMMIT_SHARE} the extraction is
 *     unavailable and names the share, rather than a confident reason set
 *     read off a minority of the history.
 *
 * Key-prefix, label and external-tracker strategies are later pluggable
 * strategies; this one reads only commits and the partition.
 */

import type {
  ChangeReason,
  ChangeReasonsUnavailable,
  ModuleChangeReasons,
  RelPath,
} from "../../../../../contracts/types/codegraph.js";

/**
 * Minimum share of commits naming a task id. Below half, the untracked
 * commits — whose reasons are invisible — outnumber the tracked ones, so any
 * reason set would describe the minority of the history as if it were all.
 */
export const CHANGE_REASON_MIN_TASK_ID_COMMIT_SHARE = 0.5;

/** One commit as the extraction reads it: the tickets its message names and the files it touched. */
export interface ChangeReasonCommit {
  taskIds: readonly string[];
  files: readonly RelPath[];
}

export interface ChangeReasonInput {
  commits: readonly ChangeReasonCommit[];
  /** The component partition — which component holds each file; a file absent from it is ignored. */
  componentOf: ReadonlyMap<RelPath, string>;
}

export type ChangeReasonExtraction =
  | { available: true; taskIdCommitShare: number; modules: ModuleChangeReasons[] }
  | { available: false; unavailable: ChangeReasonsUnavailable };

/** A ticket's work: distinct partitioned files per component, and the commits naming it. */
interface TicketWork {
  filesByComponent: Map<string, Set<RelPath>>;
  commitIndexes: number[];
}

/** One module's accumulators while the reasons are collected. */
interface ModuleAccumulator {
  ticketsByDomain: Map<string, Set<string>>;
  commitsByDomain: Map<string, Set<number>>;
  untrackedCommits: number;
  commits: number;
}

export function extractChangeReasons(input: ChangeReasonInput): ChangeReasonExtraction {
  const { commits, componentOf } = input;
  const ticketed = commits.filter((c) => c.taskIds.length > 0).length;
  const taskIdCommitShare = commits.length === 0 ? 0 : ticketed / commits.length;
  if (commits.length === 0 || taskIdCommitShare < CHANGE_REASON_MIN_TASK_ID_COMMIT_SHARE) {
    return {
      available: false,
      unavailable: {
        reason: "noTicketDiscipline",
        taskIdCommitShare,
        minTaskIdCommitShare: CHANGE_REASON_MIN_TASK_ID_COMMIT_SHARE,
      },
    };
  }

  const modulesOfCommit = commits.map((c) => partitionedComponents(c.files, componentOf));
  const tickets = collectTicketWork(commits, componentOf);
  const modules = new Map<string, ModuleAccumulator>();
  const accumulatorOf = (module: string): ModuleAccumulator => {
    let acc = modules.get(module);
    if (!acc) {
      acc = { ticketsByDomain: new Map(), commitsByDomain: new Map(), untrackedCommits: 0, commits: 0 };
      modules.set(module, acc);
    }
    return acc;
  };

  commits.forEach((c, index) => {
    for (const module of modulesOfCommit[index]) {
      const acc = accumulatorOf(module);
      acc.commits += 1;
      if (c.taskIds.length === 0) acc.untrackedCommits += 1;
    }
  });

  for (const [ticket, work] of tickets) {
    const touchedModules = new Set(work.commitIndexes.flatMap((i) => [...modulesOfCommit[i]]));
    for (const module of touchedModules) {
      const acc = accumulatorOf(module);
      const moduleCommits = work.commitIndexes.filter((i) => modulesOfCommit[i].has(module));
      for (const domain of dominantDomains(work.filesByComponent, module)) {
        addTo(acc.ticketsByDomain, domain, ticket);
        for (const i of moduleCommits) addTo(acc.commitsByDomain, domain, i);
      }
    }
  }

  return {
    available: true,
    taskIdCommitShare,
    modules: [...modules].map(([module, acc]) => toModuleChangeReasons(module, acc)).sort(compareModules),
  };
}

/** The components a commit touched through partitioned files. */
function partitionedComponents(files: readonly RelPath[], componentOf: ReadonlyMap<RelPath, string>): Set<string> {
  const components = new Set<string>();
  for (const file of files) {
    const component = componentOf.get(file);
    if (component !== undefined) components.add(component);
  }
  return components;
}

function collectTicketWork(
  commits: readonly ChangeReasonCommit[],
  componentOf: ReadonlyMap<RelPath, string>,
): Map<string, TicketWork> {
  const tickets = new Map<string, TicketWork>();
  commits.forEach((c, index) => {
    for (const ticket of new Set(c.taskIds)) {
      let work = tickets.get(ticket);
      if (!work) {
        work = { filesByComponent: new Map(), commitIndexes: [] };
        tickets.set(ticket, work);
      }
      work.commitIndexes.push(index);
      for (const file of c.files) {
        const component = componentOf.get(file);
        if (component !== undefined) addTo(work.filesByComponent, component, file);
      }
    }
  });
  return tickets;
}

/**
 * The ticket's domain(s) as seen from `module`: the components holding the
 * most of its distinct files with `module` excluded, every tied one; the
 * module itself when nothing outside it was touched.
 */
function dominantDomains(filesByComponent: ReadonlyMap<string, ReadonlySet<RelPath>>, module: string): string[] {
  let best = 0;
  let domains: string[] = [];
  for (const [component, files] of filesByComponent) {
    if (component === module) continue;
    if (files.size > best) {
      best = files.size;
      domains = [component];
    } else if (files.size === best) {
      domains.push(component);
    }
  }
  return domains.length > 0 ? domains : [module];
}

function addTo<V>(map: Map<string, Set<V>>, key: string, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function toModuleChangeReasons(module: string, acc: ModuleAccumulator): ModuleChangeReasons {
  const reasons: ChangeReason[] = [...acc.ticketsByDomain].map(([domain, tickets]) => ({
    domain,
    tickets: tickets.size,
    commits: acc.commitsByDomain.get(domain)?.size ?? 0,
  }));
  reasons.sort((a, b) => b.tickets - a.tickets || b.commits - a.commits || compareCodePoints(a.domain, b.domain));
  return { module, reasons, untrackedCommits: acc.untrackedCommits, commits: acc.commits };
}

/** Most distinct reasons first, then most commits, then name — deterministic. */
function compareModules(a: ModuleChangeReasons, b: ModuleChangeReasons): number {
  return b.reasons.length - a.reasons.length || b.commits - a.commits || compareCodePoints(a.module, b.module);
}

function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
