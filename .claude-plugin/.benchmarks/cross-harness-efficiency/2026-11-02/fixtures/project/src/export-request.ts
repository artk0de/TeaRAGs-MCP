export interface ExportRequest {
  documentId: string;
  connectionId: string;
}

export function validateExport(request: ExportRequest): string[] {
  const errors: string[] = [];
  if (!request.documentId) errors.push('missing_document');
  if (!request.connectionId) errors.push('missing_connection');
  return errors;
}
