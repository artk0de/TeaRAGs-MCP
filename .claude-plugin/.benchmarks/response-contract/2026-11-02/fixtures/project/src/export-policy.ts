export interface ExportInput {
  archived: boolean;
  documentId?: string;
  destinationConnected: boolean;
  partnerDestination: boolean;
  itemCount: number;
  replayKey?: string;
}

export interface ExportPolicy {
  partnerItemLimit: number;
}

export function rejectReason(input: ExportInput, policy: ExportPolicy): string | null {
  if (input.archived) return "archived";
  if (!input.documentId) return "document-missing";
  if (!input.destinationConnected) return "destination-disconnected";
  if (input.partnerDestination && input.itemCount > policy.partnerItemLimit) return "partner-limit";
  return null;
}

export function storageBackend(input: ExportInput): string {
  return input.partnerDestination ? "partner-export" : "documents";
}
