import type {
  AiProposalRecord,
  DocumentMetadata,
  DocumentReadiness,
  TiptapJson,
} from "@/db/schema";
import { z } from "zod";
import type { ProposalApplyMode } from "@/features/proposals/proposal-transaction";
import type { ProjectProfileViolation } from "@/features/projects/project-profile";

export type DocumentSessionDraft = {
  title: string;
  contentJson: TiptapJson;
  metadataJson: DocumentMetadata;
  readiness: DocumentReadiness;
};

export type DocumentSessionSaveDraft = Omit<DocumentSessionDraft, "readiness">;

export type DocumentWorkflowState = Readonly<{
  collaboration: Readonly<{
    generation: number;
    headSeq: number;
  }> | null;
  documentId: string;
  readiness: DocumentReadiness;
  revision: number;
}>;

export type DocumentWorkflowCommand =
  | {
      expectedReadiness: DocumentReadiness;
      nextReadiness: Exclude<DocumentReadiness, "approved">;
    }
  | {
      expectedReadiness: "ready";
      nextReadiness: "approved";
      observedHeadSeq: number;
    };

export type DocumentWorkflowResult = Readonly<{
  workflow: DocumentWorkflowState;
}>;

export type DocumentWorkflowErrorReason =
  | "aborted"
  | "collaboration_unavailable"
  | "expected_readiness_conflict"
  | "forbidden"
  | "head_conflict"
  | "invalid_project_profile"
  | "legacy_approval_unsupported"
  | "malformed_response"
  | "network_error"
  | "not_found"
  | "timeout"
  | "unknown"
  | "workflow_unavailable";

export type DocumentWorkflowRequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export const DOCUMENT_WORKFLOW_CLIENT_TIMEOUT_MS = 15_000;

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

export type DocumentSessionCollaborativeChangeResponse = DocumentSessionChangeResponse & {
  collaboration: { generation: number; headSeq: number };
  replayed: boolean;
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
  | { kind: "invalid_profile"; status: number; violation: ProjectProfileViolation }
  | { kind: "failed"; status: number | null };

export type ProposalApplyPayload = {
  appliedMode: ProposalApplyMode;
  document: DocumentSessionSaveDraft & { id: string };
  expectedRevision: number;
};

export type ProposalBatchApplyPayload = {
  document: DocumentSessionSaveDraft & { id: string };
  expectedRevision: number;
  proposals: Array<{ appliedMode: ProposalApplyMode; id: string }>;
};

export type CollaborativeProposalApplyPayload = {
  commandId: string;
  mode: ProposalApplyMode;
  observedHeadSeq: number;
};

export type CollaborativeProposalBatchApplyPayload = {
  commandId: string;
  items: Array<{ mode: ProposalApplyMode; proposalId: string }>;
  observedHeadSeq: number;
};

export type CollaborativeProposalRequestOptions = Readonly<{
  expectedDocumentId: string;
  expectedGeneration: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type CollaborativeProposalErrorReason =
  | "aborted"
  | "idempotency_conflict"
  | "invalid_request"
  | "malformed_response"
  | "network_error"
  | "not_found"
  | "proposal_overlap_conflict"
  | "proposal_status_conflict"
  | "proposal_target_conflict"
  | "timeout"
  | "unavailable"
  | "unknown";

export const COLLABORATIVE_PROPOSAL_CLIENT_TIMEOUT_MS = 15_000;

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

export class DocumentSessionInvalidProfileError extends DocumentSessionRequestError {
  constructor(
    status: number,
    body: Record<string, unknown>,
    readonly violation: ProjectProfileViolation,
  ) {
    super(status, body);
    this.name = "DocumentSessionInvalidProfileError";
  }
}

export class DocumentCollaborativeProposalRequestError extends DocumentSessionRequestError {
  constructor(
    status: number,
    body: Record<string, unknown>,
    readonly reason: CollaborativeProposalErrorReason,
  ) {
    super(status, body);
    this.name = "DocumentCollaborativeProposalRequestError";
  }
}

export class DocumentWorkflowRequestError extends DocumentSessionRequestError {
  constructor(
    status: number,
    body: Record<string, unknown>,
    readonly reason: DocumentWorkflowErrorReason,
    readonly workflow: DocumentWorkflowState | null = null,
    readonly violation: ProjectProfileViolation | null = null,
  ) {
    super(status, body);
    this.name = "DocumentWorkflowRequestError";
  }
}

class DocumentWorkflowTimeoutError extends Error {
  constructor() {
    super("Document workflow request timed out");
    this.name = "DocumentWorkflowTimeoutError";
  }
}

const documentReadinessSchema = z.enum(["draft", "needs_review", "ready", "approved"]);
const proposalApplyModeSchema = z.enum(["replace", "insert_below"]);
const tiptapJsonSchema = z.object({
  content: z.array(z.unknown()).optional(),
  type: z.literal("doc"),
}).strict();
const documentMetadataValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.string()),
  z.null(),
]);
const collaborativeDocumentSchema = z.object({
  contentJson: tiptapJsonSchema,
  createdAt: z.string().optional(),
  id: z.string().min(1),
  metadataJson: z.record(z.string(), documentMetadataValueSchema),
  plainText: z.string().optional(),
  readiness: documentReadinessSchema,
  revision: z.number().int().nonnegative(),
  status: z.enum(["draft", "archived"]).optional(),
  title: z.string(),
  updatedAt: z.string().optional(),
  workspaceId: z.string().optional(),
}).strict();
const collaborativeChangeSchema = z.object({
  afterRevision: z.number().int().nonnegative(),
  batchId: z.string().nullable(),
  createdAt: z.string(),
  documentId: z.string().min(1),
  id: z.string().min(1),
  kind: z.enum(["single", "batch"]),
  undoneAt: z.string().nullable(),
}).strict();
const collaborativeProposalSchema = z.object({
  aiRunId: z.string().optional(),
  appliedMode: proposalApplyModeSchema.nullable(),
  command: z.string().nullable(),
  createdAt: z.string().optional(),
  defaultApplyMode: proposalApplyModeSchema,
  documentId: z.string().min(1),
  explanation: z.string(),
  id: z.string().min(1),
  occurrenceIndex: z.number().int().nullable(),
  replacementText: z.string(),
  resultOrdinal: z.number().int().nonnegative().nullable().optional(),
  source: z.enum(["review", "selection"]),
  status: z.enum(["pending", "accepted", "rejected"]),
  targetFrom: z.number().int().nullable(),
  targetText: z.string(),
  targetTo: z.number().int().nullable(),
  updatedAt: z.string().optional(),
  workspaceId: z.string().optional(),
}).strict();
const collaborationPositionSchema = z.object({
  generation: z.number().int().positive(),
  headSeq: z.number().int().nonnegative(),
}).strict();
const collaborativeSingleResponseSchema = z.object({
  change: collaborativeChangeSchema,
  collaboration: collaborationPositionSchema,
  document: collaborativeDocumentSchema,
  proposal: collaborativeProposalSchema,
  replayed: z.boolean(),
}).strict();
const collaborativeBatchResponseSchema = z.object({
  change: collaborativeChangeSchema,
  collaboration: collaborationPositionSchema,
  document: collaborativeDocumentSchema,
  proposals: z.array(collaborativeProposalSchema),
  replayed: z.boolean(),
}).strict();
const collaborativeProposalServerReasonSchema = z.enum([
  "idempotency_conflict",
  "invalid_request",
  "not_found",
  "proposal_overlap_conflict",
  "proposal_status_conflict",
  "proposal_target_conflict",
  "unavailable",
]);
const collaborativeProposalErrorBodySchema = z.object({
  error: z.string(),
  reason: collaborativeProposalServerReasonSchema,
}).strict();

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
    const profileViolation = !response.ok ? parseProjectProfileViolation(body.violation) : null;
    if (!response.ok && body.reason === "invalid_project_profile" && profileViolation) {
      throw new DocumentSessionInvalidProfileError(response.status, body, profileViolation);
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

  async function requestCollaborativeChange(
    url: string,
    payload: unknown,
    proposalShape: "single" | "plural",
    expectedProposals: ReadonlyArray<{ mode: ProposalApplyMode; proposalId: string }>,
    observedHeadSeq: number,
    options: CollaborativeProposalRequestOptions,
  ): Promise<DocumentSessionCollaborativeChangeResponse> {
    let exchange: { body: Record<string, unknown>; response: Response };
    try {
      exchange = await requestWithWorkflowDeadline(request, url, {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: options.signal,
      }, async (response) => ({ body: await readBody(response), response }),
      options.timeoutMs ?? COLLABORATIVE_PROPOSAL_CLIENT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof DocumentWorkflowTimeoutError) {
        throw new DocumentCollaborativeProposalRequestError(0, {}, "timeout");
      }
      if (options.signal?.aborted) {
        throw new DocumentCollaborativeProposalRequestError(0, {}, "aborted");
      }
      throw new DocumentCollaborativeProposalRequestError(0, {}, "network_error");
    }

    const { body, response } = exchange;
    if (!response.ok) {
      const parsedError = collaborativeProposalErrorBodySchema.safeParse(body);
      throw new DocumentCollaborativeProposalRequestError(
        response.status,
        body,
        parsedError.success ? parsedError.data.reason : "unknown",
      );
    }

    const parsed = proposalShape === "single"
      ? collaborativeSingleResponseSchema.safeParse(body)
      : collaborativeBatchResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new DocumentCollaborativeProposalRequestError(response.status, body, "malformed_response");
    }
    const parsedBody = parsed.data;
    const proposals = "proposal" in parsedBody ? [parsedBody.proposal] : parsedBody.proposals;
    const expectedKind = expectedProposals.length === 1 ? "single" : "batch";
    const expectedBatchIdentity = expectedKind === "batch"
      ? parsedBody.change.batchId !== null
      : parsedBody.change.batchId === null;
    const collaborationPositionIsValid = parsedBody.collaboration.generation === options.expectedGeneration
      ? parsedBody.collaboration.headSeq >= observedHeadSeq
      : parsedBody.collaboration.generation === options.expectedGeneration + 1;
    if (
      parsedBody.document.id !== options.expectedDocumentId
      || parsedBody.change.documentId !== options.expectedDocumentId
      || parsedBody.change.kind !== expectedKind
      || !expectedBatchIdentity
      || parsedBody.change.afterRevision !== parsedBody.document.revision
      || !collaborationPositionIsValid
      || proposals.length !== expectedProposals.length
      || proposals.some((proposal, index) => {
        const expected = expectedProposals[index];
        return !expected
          || proposal.id !== expected.proposalId
          || proposal.status !== "accepted"
          || proposal.appliedMode !== expected.mode
          || proposal.documentId !== options.expectedDocumentId;
      })
    ) {
      throw new DocumentCollaborativeProposalRequestError(response.status, body, "malformed_response");
    }

    return {
      change: parsedBody.change,
      collaboration: parsedBody.collaboration,
      document: parsedBody.document,
      proposals,
      replayed: parsedBody.replayed,
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
          {
            contentJson: localDraft.contentJson,
            expectedRevision,
            metadataJson: localDraft.metadataJson,
            title: localDraft.title,
          },
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
      const profileViolation = !response.ok ? parseProjectProfileViolation(body.violation) : null;
      if (!response.ok && body.reason === "invalid_project_profile" && profileViolation) {
        return { kind: "invalid_profile", status: response.status, violation: profileViolation };
      }
      return { kind: "failed", status: response.status };
    },

    applyProposal(proposalId: string, payload: ProposalApplyPayload) {
      return requestChange(
        `/api/proposals/${encodeURIComponent(proposalId)}/apply`,
        { ...payload, document: legacyWriterDocument(payload.document) },
        "single",
      );
    },

    applyProposalBatch(payload: ProposalBatchApplyPayload) {
      return requestChange(
        "/api/proposals/bulk-apply",
        { ...payload, document: legacyWriterDocument(payload.document) },
        "plural",
      );
    },

    applyCollaborativeProposal(
      proposalId: string,
      payload: CollaborativeProposalApplyPayload,
      options: CollaborativeProposalRequestOptions,
    ) {
      return requestCollaborativeChange(
        `/api/proposals/${encodeURIComponent(proposalId)}/apply`,
        { ...payload, proposalId },
        "single",
        [{ mode: payload.mode, proposalId }],
        payload.observedHeadSeq,
        options,
      );
    },

    applyCollaborativeProposalBatch(
      payload: CollaborativeProposalBatchApplyPayload,
      options: CollaborativeProposalRequestOptions,
    ) {
      return requestCollaborativeChange(
        "/api/proposals/bulk-apply",
        payload,
        "plural",
        payload.items,
        payload.observedHeadSeq,
        options,
      );
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
      draft: DocumentSessionSaveDraft,
      creationKey: string,
    ): Promise<{ document: DocumentSessionDocument; replayed: boolean }> {
      const response = await request("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": creationKey,
        },
        body: JSON.stringify(legacyWriterDraft(draft)),
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

    async readWorkflow(
      documentId: string,
      options: DocumentWorkflowRequestOptions = {},
    ): Promise<DocumentWorkflowResult> {
      return requestWorkflow(documentId, "GET", undefined, options);
    },

    async updateWorkflow(
      documentId: string,
      command: DocumentWorkflowCommand,
      options: DocumentWorkflowRequestOptions = {},
    ): Promise<DocumentWorkflowResult> {
      return requestWorkflow(documentId, "POST", command, options);
    },
  };

  async function requestWorkflow(
    documentId: string,
    method: "GET" | "POST",
    payload: DocumentWorkflowCommand | undefined,
    options: DocumentWorkflowRequestOptions,
  ): Promise<DocumentWorkflowResult> {
    const url = `/api/documents/${encodeURIComponent(documentId)}/workflow`;
    let exchange: { body: Record<string, unknown>; response: Response };
    try {
      exchange = await requestWithWorkflowDeadline(request, url, {
        ...(payload === undefined ? {} : {
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
        }),
        method,
        signal: options.signal,
      }, async (response) => ({ body: await readBody(response), response }),
      options.timeoutMs ?? DOCUMENT_WORKFLOW_CLIENT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof DocumentWorkflowTimeoutError) {
        throw new DocumentWorkflowRequestError(0, {}, "timeout");
      }
      if (options.signal?.aborted) {
        throw new DocumentWorkflowRequestError(0, {}, "aborted");
      }
      throw new DocumentWorkflowRequestError(0, {}, "network_error");
    }

    const { body, response } = exchange;
    const workflow = isDocumentWorkflowState(body.workflow, documentId)
      ? body.workflow
      : null;
    if (response.ok) {
      if (!workflow) {
        throw new DocumentWorkflowRequestError(response.status, body, "malformed_response");
      }
      return { workflow };
    }

    const reason = parseWorkflowErrorReason(body.reason);
    const violation = reason === "invalid_project_profile"
      ? parseProjectProfileViolation(body.violation)
      : null;
    throw new DocumentWorkflowRequestError(response.status, body, reason, workflow, violation);
  }
}

function legacyWriterDraft(draft: DocumentSessionSaveDraft): DocumentSessionSaveDraft {
  return {
    title: draft.title,
    contentJson: draft.contentJson,
    metadataJson: draft.metadataJson,
  };
}

function legacyWriterDocument(
  document: DocumentSessionSaveDraft & { id: string },
): DocumentSessionSaveDraft & { id: string } {
  return { id: document.id, ...legacyWriterDraft(document) };
}

async function requestWithWorkflowDeadline<T>(
  request: RequestFunction,
  input: RequestInfo | URL,
  init: RequestInit,
  consumeResponse: (response: Response) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  let rejectCallerAbort!: (reason: unknown) => void;
  const callerAbort = new Promise<never>((_resolve, reject) => {
    rejectCallerAbort = reject;
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;
  const handleCallerAbort = () => {
    const reason = callerSignal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    controller.abort(reason);
    rejectCallerAbort(reason);
  };
  callerSignal?.addEventListener("abort", handleCallerAbort, { once: true });
  if (callerSignal?.aborted) handleCallerAbort();

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      const error = new DocumentWorkflowTimeoutError();
      controller.abort(error);
      reject(error);
    }, Math.max(0, timeoutMs));
  });

  try {
    const requestAndConsume = (async () => {
      const response = await request(input, { ...init, signal: controller.signal });
      return consumeResponse(response);
    })();
    return await Promise.race([
      requestAndConsume,
      timeout,
      callerAbort,
    ]);
  } catch (error) {
    if (didTimeout) throw new DocumentWorkflowTimeoutError();
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", handleCallerAbort);
  }
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

function isDocumentWorkflowState(
  value: unknown,
  expectedDocumentId: string,
): value is DocumentWorkflowState {
  if (!isRecord(value)) return false;
  if (
    value.documentId !== expectedDocumentId ||
    !isDocumentReadiness(value.readiness) ||
    !isNonNegativeSafeInteger(value.revision)
  ) {
    return false;
  }
  if (value.collaboration === null) return true;
  return isRecord(value.collaboration) &&
    isPositiveSafeInteger(value.collaboration.generation) &&
    isNonNegativeSafeInteger(value.collaboration.headSeq);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseWorkflowErrorReason(value: unknown): DocumentWorkflowErrorReason {
  return value === "collaboration_unavailable" ||
    value === "expected_readiness_conflict" ||
    value === "forbidden" ||
    value === "head_conflict" ||
    value === "invalid_project_profile" ||
    value === "legacy_approval_unsupported" ||
    value === "not_found" ||
    value === "workflow_unavailable"
    ? value
    : "unknown";
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

function parseProjectProfileViolation(value: unknown): ProjectProfileViolation | null {
  if (!isRecord(value)) return null;
  const reason = value.reason;
  if (
    value.ok === false &&
    typeof value.fieldId === "string" &&
    typeof reason === "string" &&
    isProjectMetadataViolationReason(reason)
  ) {
    return { fieldId: value.fieldId, ok: false, reason };
  }
  if (
    reason === "invalid_readiness_transition" &&
    isDocumentReadiness(value.current) &&
    isDocumentReadiness(value.next)
  ) {
    return { current: value.current, next: value.next, reason };
  }
  return null;
}

function isProjectMetadataViolationReason(
  value: string,
): value is "invalid_length" | "invalid_option" | "invalid_type" | "required" | "unknown_field" {
  return value === "invalid_length" ||
    value === "invalid_option" ||
    value === "invalid_type" ||
    value === "required" ||
    value === "unknown_field";
}

function isDocumentReadiness(value: unknown): value is DocumentReadiness {
  return value === "draft" || value === "needs_review" || value === "ready" || value === "approved";
}
