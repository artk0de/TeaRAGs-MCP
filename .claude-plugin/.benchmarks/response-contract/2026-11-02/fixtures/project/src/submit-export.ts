import { rejectReason, storageBackend, type ExportInput, type ExportPolicy } from "./export-policy.js";

export interface QueueRecord { id: string; state: "queued" | "running" | "delivered"; backend: string; }
export interface ExportQueue {
  findByReplayKey(key: string): QueueRecord | undefined;
  insert(values: { documentId: string; backend: string; replayKey?: string }): QueueRecord;
}

export function submitExport(input: ExportInput, policy: ExportPolicy, queue: ExportQueue) {
  const rejected = rejectReason(input, policy);
  if (rejected) return { state: "rejected", reason: rejected };

  if (input.replayKey) {
    const existing = queue.findByReplayKey(input.replayKey);
    if (existing) return { state: existing.state, record: existing, reused: true };
  }

  const record = queue.insert({
    documentId: input.documentId!, backend: storageBackend(input), replayKey: input.replayKey,
  });
  return { state: record.state, record, reused: false };
}
