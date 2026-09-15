/**
 * Child process for `collection-indexing-lock-processes.test.ts` — one claimant of
 * a collection's indexing lock, in a process of its own.
 *
 * Protocol over stdio, so the parent decides when both claimants race:
 *   stdout `ready`                       — started, waiting for the signal
 *   stdin  any line                      — claim now
 *   stdout `{"acquired":bool,"pid":n}`   — the claim's outcome
 *   stdin  end                           — release (if held) and exit
 */

import { createInterface } from "node:readline";

import { CollectionIndexingLock } from "../../../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";

const [lockDir, collectionName] = process.argv.slice(2);
if (lockDir === undefined || collectionName === undefined) {
  throw new Error("usage: claim-indexing-lock <lockDir> <collectionName>");
}

const commands = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
process.stdout.write("ready\n");
await commands.next();

const held = await new CollectionIndexingLock({ lockDir }).tryAcquire(collectionName, "index-codebase");
process.stdout.write(`${JSON.stringify({ acquired: held !== undefined, pid: process.pid })}\n`);

await commands.next();
await held?.release();
