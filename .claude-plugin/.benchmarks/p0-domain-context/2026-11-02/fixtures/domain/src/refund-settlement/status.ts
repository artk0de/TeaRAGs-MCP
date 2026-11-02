export type ProcessingState = "queued" | "processing" | "settled" | "rejected";

export interface RecordState {
  refundId: string;
  processingState: ProcessingState;
}

/** Refund settlement processing updates published to the operations dashboard. */
export function applyProcessingState(
  record: RecordState,
  state: ProcessingState,
  publish: (frame: object) => void,
): void {
  record.processingState = state;
  publish({
    resource: { id: record.refundId, processing_status: record.processingState },
    type: "refund_settlement",
    event: "status_changed",
  });
}

