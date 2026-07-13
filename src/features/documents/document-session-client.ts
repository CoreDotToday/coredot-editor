import type {
  AiProposalRecord,
  DocumentMetadata,
  DocumentReadiness,
  TiptapJson,
} from "@/db/schema";
import type { ProposalApplyMode } from "@/features/proposals/proposal-transaction";

export type DocumentSessionDraft = {
  title: string;
  contentJson: TiptapJson;
  metadataJson: DocumentMetadata;
  readiness: DocumentReadiness;
};

export type DocumentSessionDocument = DocumentSessionDraft & {
  id: string;
  revision: number;
};

export type DocumentSessionChange = {
  id: string;
  documentId: string;
  kind: "single" | "batch";
  batchId: string | null;
  afterRevision: number;
  createdAt: string;
  undoneAt: string | null;
};

export type DocumentSessionProposal = Pick<
  AiProposalRecord,
  | "appliedMode"
  | "command"
  | "defaultApplyMode"
  | "explanation"
  | "id"
  | "occurrenceIndex"
  | "replacementText"
  | "source"
  | "status"
  | "targetFrom"
  | "targetText"
  | "targetTo"
>;

export type DocumentSessionChangeResponse = {
  change: DocumentSessionChange;
  document: DocumentSessionDocument;
  proposals: DocumentSessionProposal[];
};

export type DocumentSessionHistoryChange = DocumentSessionChange & {
  proposals: Array<{
    id: string;
    targetText: string;
    replacementText: string;
    appliedMode: ProposalApplyMode;
    ordinal: number;
  }>;
};

export type DocumentSaveResult =
  | { kind: "saved"; document: DocumentSessionDocument }
  | {
      kind: "conflict";
      localDraft: DocumentSessionDraft;
      serverDocument: DocumentSessionDocument;
    }
  | { kind: "failed"; status: number | null };

export type ProposalApplyPayload = {
  appliedMode: ProposalApplyMode;
  document: DocumentSessionDraft & { id: string };
  expectedRevision: number;
};

export type ProposalBatchApplyPayload = {
  document: DocumentSessionDraft & { id: string };
  expectedRevision: number;
  proposals: Array<{ appliedMode: ProposalApplyMode; id: string }>;
};

type RequestFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class DocumentSessionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super("Document session request failed");
    this.name = "DocumentSessionRequestError";
  }
}

export class DocumentSessionConflictError extends DocumentSessionRequestError {
  constructor(
    status: number,
    body: Record<string, unknown>,
    readonly serverDocument: DocumentSessionDocument,
  ) {
    super(status, body);
    this.name = "DocumentSessionConflictError";
  }
}

export function createDocumentSessionClient(request: RequestFunction = fetch) {
  async function readBody(response: Response): Promise<Record<string, unknown>> {
    const body = await response.json().catch(() => ({}));
    return isRecord(body) ? body : {};
  }

  async function requestChange(
    url: string,
    payload: unknown,
    proposalShape: "single" | "plural",
  ): Promise<DocumentSessionChangeResponse> {
    const response = await requestJson(request, url, "POST", payload);
    const body = await readBody(response);
    if (
      response.status === 409 &&
      body.reason === "revision_conflict" &&
      isDocumentSessionDocument(body.document)
    ) {
      throw new DocumentSessionConflictError(response.status, body, body.document);
    }
    if (!response.ok) throw new DocumentSessionRequestError(response.status, body);

    const document = body.document;
    const change = body.change;
    const proposals = proposalShape === "single" ? [body.proposal] : body.proposals;
    if (
      !isDocumentSessionDocument(document) ||
      !isDocumentSessionChange(change) ||
      !Array.isArray(proposals) ||
      proposals.some((proposal) => !isDocumentSessionProposal(proposal))
    ) {
      throw new DocumentSessionRequestError(response.status, body);
    }

    return {
      change,
      document,
      proposals: proposals as DocumentSessionProposal[],
    };
  }

  return {
    async save(
      documentId: string,
      localDraft: DocumentSessionDraft,
      expectedRevision: number,
    ): Promise<DocumentSaveResult> {
      let response: Response;
      try {
        response = await requestJson(
          request,
          `/api/documents/${encodeURIComponent(documentId)}`,
          "PUT",
          { ...localDraft, expectedRevision },
        );
      } catch {
        return { kind: "failed", status: null };
      }
      const body = await readBody(response);
      if (response.ok && isDocumentSessionDocument(body.document)) {
        return { kind: "saved", document: body.document };
      }
      if (
        response.status === 409 &&
        body.reason === "revision_conflict" &&
        isDocumentSessionDocument(body.document)
      ) {
        return { kind: "conflict", localDraft, serverDocument: body.document };
      }
      return { kind: "failed", status: response.status };
    },

    applyProposal(proposalId: string, payload: ProposalApplyPayload) {
      return requestChange(
        `/api/proposals/${encodeURIComponent(proposalId)}/apply`,
        payload,
        "single",
      );
    },

    applyProposalBatch(payload: ProposalBatchApplyPayload) {
      return requestChange("/api/proposals/bulk-apply", payload, "plural");
    },

    undoChange(changeId: string, expectedRevision: number) {
      return requestChange(
        `/api/document-changes/${encodeURIComponent(changeId)}/undo`,
        { expectedRevision },
        "plural",
      );
    },

    async listChanges(
      documentId: string,
      input: { cursor?: string; limit?: number } = {},
    ): Promise<{ changes: DocumentSessionHistoryChange[]; nextCursor: string | null }> {
      const query = new URLSearchParams({ documentId });
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.cursor !== undefined) query.set("cursor", input.cursor);
      const response = await request(`/api/document-changes?${query.toString()}`, { method: "GET" });
      const body = await readBody(response);
      if (
        !response.ok ||
        !Array.isArray(body.changes) ||
        body.changes.some((item) => !isDocumentSessionHistoryChange(item)) ||
        !(body.nextCursor === null || typeof body.nextCursor === "string")
      ) {
        throw new DocumentSessionRequestError(response.status, body);
      }
      return {
        changes: body.changes as DocumentSessionHistoryChange[],
        nextCursor: body.nextCursor,
      };
    },

    async createFromDraft(
      draft: DocumentSessionDraft,
      creationKey: string,
    ): Promise<{ document: DocumentSessionDocument; replayed: boolean }> {
      const response = await request("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": creationKey,
        },
        body: JSON.stringify(draft),
      });
      const body = await readBody(response);
      if (
        !response.ok ||
        !isDocumentSessionDocument(body.document) ||
        typeof body.replayed !== "boolean"
      ) {
        throw new DocumentSessionRequestError(response.status, body);
      }
      return { document: body.document, replayed: body.replayed };
    },
  };
}

async function requestJson(
  request: RequestFunction,
  url: string,
  method: "POST" | "PUT",
  payload: unknown,
) {
  return request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function isDocumentSessionDocument(value: unknown): value is DocumentSessionDocument {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    typeof value.title === "string" &&
    isRecord(value.contentJson) &&
    value.contentJson.type === "doc" &&
    isRecord(value.metadataJson) &&
    typeof value.readiness === "string" &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0;
}

function isDocumentSessionChange(value: unknown): value is DocumentSessionChange {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    typeof value.documentId === "string" &&
    (value.kind === "single" || value.kind === "batch") &&
    (value.batchId === null || typeof value.batchId === "string") &&
    Number.isSafeInteger(value.afterRevision) &&
    Number(value.afterRevision) >= 0 &&
    typeof value.createdAt === "string" &&
    (value.undoneAt === null || typeof value.undoneAt === "string");
}

function isDocumentSessionProposal(value: unknown): value is DocumentSessionProposal {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    typeof value.targetText === "string" &&
    typeof value.replacementText === "string" &&
    typeof value.explanation === "string" &&
    (value.source === "review" || value.source === "selection") &&
    (value.command === null || typeof value.command === "string") &&
    (value.occurrenceIndex === null || Number.isSafeInteger(value.occurrenceIndex)) &&
    (value.targetFrom === null || Number.isSafeInteger(value.targetFrom)) &&
    (value.targetTo === null || Number.isSafeInteger(value.targetTo)) &&
    (value.defaultApplyMode === "replace" || value.defaultApplyMode === "insert_below") &&
    (value.appliedMode === null || value.appliedMode === "replace" || value.appliedMode === "insert_below") &&
    (value.status === "pending" || value.status === "accepted" || value.status === "rejected");
}

function isDocumentSessionHistoryChange(value: unknown): value is DocumentSessionHistoryChange {
  if (!isRecord(value)) return false;
  const proposals = value.proposals;
  if (!Array.isArray(proposals) || !isDocumentSessionChange(value)) return false;
  return proposals.every((proposal) =>
    isRecord(proposal) &&
    typeof proposal.id === "string" &&
    typeof proposal.targetText === "string" &&
    typeof proposal.replacementText === "string" &&
    (proposal.appliedMode === "replace" || proposal.appliedMode === "insert_below") &&
    Number.isSafeInteger(proposal.ordinal) &&
    Number(proposal.ordinal) >= 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
