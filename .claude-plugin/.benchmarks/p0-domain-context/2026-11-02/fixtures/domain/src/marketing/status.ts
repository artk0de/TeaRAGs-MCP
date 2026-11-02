export type ProcessingState = "draft" | "scheduled" | "sending" | "complete";

export interface RecordState {
  campaignId: string;
  processingState: ProcessingState;
}

/** Marketing automation processing updates published to the campaign dashboard. */
export function applyProcessingState(
  record: RecordState,
  state: ProcessingState,
  publish: (frame: object) => void,
): void {
  record.processingState = state;
  publish({
    resource: { id: record.campaignId, processing_status: record.processingState },
    type: "marketing_campaign",
    event: "status_changed",
  });
}

