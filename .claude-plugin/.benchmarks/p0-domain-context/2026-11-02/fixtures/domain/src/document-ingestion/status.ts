export type ProcessingState = "received" | "processing" | "indexed" | "failed";

export interface RecordState {
  documentId: string;
  processingState: ProcessingState;
}

/** Document ingestion processing updates published to the upload dashboard. */
export function applyProcessingState(
  record: RecordState,
  state: ProcessingState,
  publish: (frame: object) => void,
): void {
  record.processingState = state;
  publish({
    resource: { id: record.documentId, processing_status: record.processingState },
    type: "ingested_document",
    event: "status_changed",
  });
}

