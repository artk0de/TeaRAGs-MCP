/**
 * Document domain DTOs — document add/delete types.
 */

export interface AddDocumentsRequest {
  collection: string;
  documents: {
    id: string | number;
    text: string;
    metadata?: Record<string, unknown>;
  }[];
}

export interface DeleteDocumentsRequest {
  collection: string;
  ids: (string | number)[];
}
