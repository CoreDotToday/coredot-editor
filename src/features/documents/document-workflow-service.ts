import { createHash } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";

import { db } from "@/db/client";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import {
  COLLABORATION_STORAGE_LIMITS,
  collaborationDocuments,
  documentApprovals,
  documents,
  type DocumentReadiness,
  type DocumentRecord,
} from "@/db/schema";
import type { RequestContext, WorkspaceScope } from "@/features/auth/request-context";
import type { CollaborationDocumentCodec } from "@/features/collaboration/contracts";
import { createCollaborationDocumentCodec } from "@/features/collaboration/document-codec";
import {
  CollaborationPersistenceError,
  createCollaborationPersistence,
  type CollaborationPersistence,
  type CollaborationSnapshot,
} from "@/features/collaboration/persistence";
import {
  createCollaborationRepository,
  type CollaborationDatabase,
  type CollaborationTransaction,
} from "@/features/collaboration/repository";
import {
  createDocumentWorkflowNotificationOutbox,
  type DocumentWorkflowNotificationDelivery,
  type DocumentWorkflowNotificationGateway,
} from "@/features/documents/document-workflow-notification-outbox";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";
import {
  validateProjectDocumentState,
  type ProjectProfile,
  type ProjectProfileViolation,
} from "@/features/projects/project-profile";

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

export type DocumentWorkflowState = {
  collaboration: null | { generation: number; headSeq: number };
  documentId: string;
  readiness: DocumentReadiness;
  revision: number;
};

export type DocumentWorkflowResult = { workflow: DocumentWorkflowState };

export type DocumentWorkflowServiceCategory =
  | "expected_readiness_conflict"
  | "forbidden"
  | "head_conflict"
  | "invalid_project_profile"
  | "invalid_request"
  | "legacy_approval_unsupported"
  | "not_found"
  | "unavailable";

const WORKFLOW_ERROR_MESSAGES: Record<DocumentWorkflowServiceCategory, string> = {
  expected_readiness_conflict: "Document workflow state changed",
  forbidden: "Document workflow permission was denied",
  head_conflict: "Document collaboration state changed",
  invalid_project_profile: "Document violates the active Project Profile",
  invalid_request: "Document workflow request is invalid",
  legacy_approval_unsupported: "Legacy document approval requires collaboration initialization",
  not_found: "Document was not found",
  unavailable: "Document workflow is temporarily unavailable",
};

export class DocumentWorkflowServiceError extends Error {
  override readonly name = "DocumentWorkflowServiceError";

  constructor(
    readonly category: DocumentWorkflowServiceCategory,
    readonly workflow?: DocumentWorkflowState,
    readonly violation?: ProjectProfileViolation,
  ) {
    super(WORKFLOW_ERROR_MESSAGES[category]);
  }
}

export type AuthorizeDocumentWorkflow = (
  context: RequestContext,
  document: DocumentRecord,
  command: DocumentWorkflowCommand,
) => boolean | Promise<boolean>;

type WorkflowServiceOptions = {
  authorizeWorkflow?: AuthorizeDocumentWorkflow;
  codec?: CollaborationDocumentCodec;
  database?: CollaborationDatabase;
  now?: () => Date;
  persistence?: Pick<CollaborationPersistence, "load" | "withInitializedWrite">;
  projectProfile?: ProjectProfile;
  workflowNotificationGateway?: DocumentWorkflowNotificationGateway;
};

type WorkflowOutcome =
  | {
      notification?: DocumentWorkflowNotificationDelivery;
      ok: true;
      value: DocumentWorkflowResult;
    }
  | {
      category: Exclude<DocumentWorkflowServiceCategory, "invalid_request">;
      ok: false;
      violation?: ProjectProfileViolation;
      workflow?: DocumentWorkflowState;
    };

const RETRY_COLLABORATIVE_WRITE = Symbol("retry-collaborative-write");

export function authorizeWorkspaceMemberWorkflow(
  context: RequestContext,
) {
  return context.role === "member" || context.role === "admin" || context.role === "owner";
}

export function createDocumentWorkflowService(options: WorkflowServiceOptions = {}) {
  const database = options.database ?? db;
  const projectProfile = options.projectProfile ?? resolveActiveProjectProfile();
  const codec = options.codec ?? createCollaborationDocumentCodec(projectProfile);
  const persistence = options.persistence ?? createCollaborationPersistence(database, {
    codec,
    projectProfile,
  });
  const authorizeWorkflow = options.authorizeWorkflow ?? authorizeWorkspaceMemberWorkflow;
  const now = options.now ?? (() => new Date());
  const repository = createCollaborationRepository(database);
  const workflowNotificationOutbox = createDocumentWorkflowNotificationOutbox({
    database,
    gateway: options.workflowNotificationGateway,
    now,
  });

  const read = async (
    context: RequestContext,
    documentId: string,
  ): Promise<DocumentWorkflowState> => executeBounded(async () => {
    validateContextAndDocument(context, documentId);
    const [document] = await database
      .select({ id: documents.id, readiness: documents.readiness, revision: documents.revision })
      .from(documents)
      .where(and(
        eq(documents.workspaceId, context.workspaceId),
        eq(documents.id, documentId),
        eq(documents.status, "draft"),
      ))
      .limit(1);
    if (!document) throw new DocumentWorkflowServiceError("not_found");
    const collaborationHistory = await database
      .select({
        generation: collaborationDocuments.generation,
        headSeq: collaborationDocuments.headSeq,
        isCurrent: collaborationDocuments.isCurrent,
      })
      .from(collaborationDocuments)
      .where(and(
        eq(collaborationDocuments.workspaceId, context.workspaceId),
        eq(collaborationDocuments.documentId, documentId),
      ))
      .orderBy(desc(collaborationDocuments.generation))
      .limit(2);
    const current = collaborationHistory.filter((row) => row.isCurrent);
    if (
      current.length > 1
      || (collaborationHistory.length > 0 && current.length !== 1)
      || (current[0] && current[0].generation !== collaborationHistory[0]?.generation)
    ) {
      throw new DocumentWorkflowServiceError("unavailable");
    }
    const collaboration = current[0];
    return {
      collaboration: collaboration
        ? { generation: collaboration.generation, headSeq: collaboration.headSeq }
        : null,
      documentId: document.id,
      readiness: document.readiness,
      revision: document.revision,
    };
  });

  const execute = async (
    context: RequestContext,
    documentId: string,
    command: DocumentWorkflowCommand,
  ): Promise<DocumentWorkflowResult> => executeBounded(async () => {
    validateContextAndDocument(context, documentId);
    validateCommand(command);
    const scope = { workspaceId: context.workspaceId };
    const [collaboration] = await database
      .select({ generation: collaborationDocuments.generation })
      .from(collaborationDocuments)
      .where(and(
        eq(collaborationDocuments.workspaceId, scope.workspaceId),
        eq(collaborationDocuments.documentId, documentId),
      ))
      .limit(1);

    if (collaboration) {
      return completeCollaborativeWorkflow(await executeCollaborativeWorkflow({
        authorizeWorkflow,
        codec,
        command,
        context,
        documentId,
        now,
        persistence,
        projectProfile,
        scope,
        workflowNotificationOutbox,
      }), workflowNotificationOutbox);
    }

    const legacyOutcome = await withSerializedDocumentWrite(scope, documentId, () =>
      repository.write(async (transaction) => {
        const [becameCollaborative] = await transaction
          .select({ generation: collaborationDocuments.generation })
          .from(collaborationDocuments)
          .where(and(
            eq(collaborationDocuments.workspaceId, scope.workspaceId),
            eq(collaborationDocuments.documentId, documentId),
          ))
          .limit(1);
        if (becameCollaborative) return RETRY_COLLABORATIVE_WRITE;
        return executeWorkflowTransaction({
          authorizeWorkflow,
          codec,
          command,
          context,
          documentId,
          now,
        projectProfile,
        scope,
        snapshot: null,
        transaction,
        workflowNotificationOutbox,
      });
      }));
    if (legacyOutcome === RETRY_COLLABORATIVE_WRITE) {
      return completeCollaborativeWorkflow(await executeCollaborativeWorkflow({
        authorizeWorkflow,
        codec,
        command,
        context,
        documentId,
        now,
        persistence,
        projectProfile,
        scope,
        workflowNotificationOutbox,
      }), workflowNotificationOutbox);
    }
    return unwrapOutcome(legacyOutcome);
  });

  return { execute, read };
}

async function executeCollaborativeWorkflow(options: {
  authorizeWorkflow: AuthorizeDocumentWorkflow;
  codec: CollaborationDocumentCodec;
  command: DocumentWorkflowCommand;
  context: RequestContext;
  documentId: string;
  now: () => Date;
  persistence: Pick<CollaborationPersistence, "withInitializedWrite">;
  projectProfile: ProjectProfile;
  scope: WorkspaceScope;
  workflowNotificationOutbox: Pick<
    ReturnType<typeof createDocumentWorkflowNotificationOutbox>,
    "enqueue"
  >;
}) {
  return options.persistence.withInitializedWrite(
    options.scope,
    options.documentId,
    async (transaction, snapshot) => {
      try {
        return await executeWorkflowTransaction({
          ...options,
          snapshot,
          transaction,
        });
      } finally {
        snapshot.document.destroy();
      }
    },
  );
}

async function executeWorkflowTransaction(options: {
  authorizeWorkflow: AuthorizeDocumentWorkflow;
  codec: CollaborationDocumentCodec;
  command: DocumentWorkflowCommand;
  context: RequestContext;
  documentId: string;
  now: () => Date;
  projectProfile: ProjectProfile;
  scope: WorkspaceScope;
  snapshot: CollaborationSnapshot | null;
  transaction: CollaborationTransaction;
  workflowNotificationOutbox: Pick<
    ReturnType<typeof createDocumentWorkflowNotificationOutbox>,
    "enqueue"
  >;
}): Promise<WorkflowOutcome> {
  const {
    authorizeWorkflow,
    codec,
    command,
    context,
    documentId,
    now,
    projectProfile,
    scope,
    snapshot,
    transaction,
    workflowNotificationOutbox,
  } = options;
  const [document] = await transaction
    .select()
    .from(documents)
    .where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, documentId),
      eq(documents.status, "draft"),
    ))
    .limit(1);
  if (!document) return { category: "not_found", ok: false };
  if (!(await authorizeWorkflow(context, document, command))) {
    return { category: "forbidden", ok: false };
  }

  const collaboration = snapshot
    ? { generation: snapshot.generation, headSeq: snapshot.headSeq }
    : null;
  const currentWorkflow = workflowState(document, collaboration);
  if (document.readiness !== command.expectedReadiness) {
    return {
      category: "expected_readiness_conflict",
      ok: false,
      workflow: currentWorkflow,
    };
  }
  if (command.nextReadiness === "approved" && snapshot === null) {
    return {
      category: "legacy_approval_unsupported",
      ok: false,
      workflow: currentWorkflow,
    };
  }
  if (
    command.nextReadiness === "approved"
    && snapshot
    && command.observedHeadSeq !== snapshot.headSeq
  ) {
    return { category: "head_conflict", ok: false, workflow: currentWorkflow };
  }

  let metadataJson = document.metadataJson;
  let materialization: ReturnType<CollaborationDocumentCodec["materialize"]> | null = null;
  if (snapshot) {
    materialization = codec.validate(snapshot.document, projectProfile);
    metadataJson = materialization.metadataJson;
  }
  const profileResult = validateProjectDocumentState(projectProfile, {
    metadataJson,
    readiness: command.nextReadiness,
  }, {
    metadataJson,
    readiness: document.readiness,
  });
  if (!profileResult.ok) {
    return {
      category: "invalid_project_profile",
      ok: false,
      violation: profileResult.violation,
      workflow: currentWorkflow,
    };
  }

  const timestamp = now();
  let approvalValues: typeof documentApprovals.$inferInsert | null = null;
  let revokeActiveApproval = false;
  if (command.nextReadiness === "approved" && snapshot && materialization) {
    const stateVector = Y.encodeStateVector(snapshot.document);
    if (
      stateVector.byteLength < 1
      || stateVector.byteLength > COLLABORATION_STORAGE_LIMITS.stateVectorBytes
    ) {
      return { category: "unavailable", ok: false };
    }
    const [activeApproval] = await transaction
      .select({ id: documentApprovals.id })
      .from(documentApprovals)
      .where(and(
        eq(documentApprovals.workspaceId, scope.workspaceId),
        eq(documentApprovals.documentId, documentId),
        isNull(documentApprovals.invalidatedAt),
        isNull(documentApprovals.revokedAt),
      ))
      .limit(1);
    if (activeApproval) {
      return {
        category: "expected_readiness_conflict",
        ok: false,
        workflow: currentWorkflow,
      };
    }
    approvalValues = {
      approvedAt: timestamp,
      approvedContentHash: hashCanonicalMaterialization(materialization),
      approvedHeadSeq: snapshot.headSeq,
      approvedStateVector: Buffer.from(stateVector),
      documentId,
      generation: snapshot.generation,
      principalId: context.principalId,
      requestId: context.requestId,
      workspaceId: scope.workspaceId,
    };
  }
  if (snapshot && document.readiness === "approved" && command.nextReadiness !== "approved") {
    const activeApprovals = await transaction
      .select({ id: documentApprovals.id })
      .from(documentApprovals)
      .where(and(
        eq(documentApprovals.workspaceId, scope.workspaceId),
        eq(documentApprovals.documentId, documentId),
        isNull(documentApprovals.invalidatedAt),
        isNull(documentApprovals.revokedAt),
      ))
      .limit(2);
    if (activeApprovals.length !== 1) {
      return { category: "unavailable", ok: false };
    }
    revokeActiveApproval = true;
  }

  const [updated] = await transaction
    .update(documents)
    .set({
      readiness: command.nextReadiness,
      revision: sql`${documents.revision} + 1`,
      updatedAt: timestamp,
    })
    .where(and(
      eq(documents.workspaceId, scope.workspaceId),
      eq(documents.id, documentId),
      eq(documents.status, "draft"),
      eq(documents.readiness, command.expectedReadiness),
    ))
    .returning();
  if (!updated) {
    return {
      category: "expected_readiness_conflict",
      ok: false,
      workflow: currentWorkflow,
    };
  }
  if (revokeActiveApproval) {
    const [revoked] = await transaction
      .update(documentApprovals)
      .set({
        revokedAt: timestamp,
        revokedPrincipalId: context.principalId,
        revokedRequestId: context.requestId,
      })
      .where(and(
        eq(documentApprovals.workspaceId, scope.workspaceId),
        eq(documentApprovals.documentId, documentId),
        isNull(documentApprovals.invalidatedAt),
        isNull(documentApprovals.revokedAt),
      ))
      .returning({ id: documentApprovals.id });
    if (!revoked) throw new WorkflowTransactionInvariantError();
  }
  if (approvalValues) {
    await transaction.insert(documentApprovals).values(approvalValues);
  }
  const notification = snapshot
    ? await workflowNotificationOutbox.enqueue(transaction, {
        documentId,
        generation: snapshot.generation,
        timestamp,
        workflowRevision: updated.revision,
        workspaceId: scope.workspaceId,
      })
    : undefined;
  return {
    notification,
    ok: true,
    value: { workflow: workflowState(updated, collaboration) },
  };
}

async function completeCollaborativeWorkflow(
  outcome: WorkflowOutcome,
  outbox: Pick<ReturnType<typeof createDocumentWorkflowNotificationOutbox>, "deliver">,
) {
  const value = unwrapOutcome(outcome);
  if (outcome.ok && outcome.notification) {
    try {
      await outbox.deliver(outcome.notification);
    } catch {
      // The workflow transaction and durable outbox row already committed.
      // A sidecar reconciler will retry without turning the HTTP success into
      // a misleading workflow failure.
    }
  }
  return value;
}

function workflowState(
  document: Pick<DocumentRecord, "id" | "readiness" | "revision">,
  collaboration: DocumentWorkflowState["collaboration"],
): DocumentWorkflowState {
  return {
    collaboration,
    documentId: document.id,
    readiness: document.readiness,
    revision: document.revision,
  };
}

function unwrapOutcome(outcome: WorkflowOutcome) {
  if (outcome.ok) return outcome.value;
  throw new DocumentWorkflowServiceError(
    outcome.category,
    outcome.workflow,
    outcome.violation,
  );
}

function hashCanonicalMaterialization(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidWorkflowInputError();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new InvalidWorkflowInputError();
}

function validateContextAndDocument(context: RequestContext, documentId: string) {
  validateIdentifier(context.workspaceId);
  validateIdentifier(context.principalId);
  validateIdentifier(context.requestId);
  validateIdentifier(documentId);
}

function validateIdentifier(value: unknown) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > COLLABORATION_STORAGE_LIMITS.correctnessKeyBytes
    || /^[\t\n\v\f\r\u00a0 ]|[\t\n\v\f\r\u00a0 ]$/u.test(value)
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new InvalidWorkflowInputError();
  }
}

function validateCommand(command: DocumentWorkflowCommand) {
  if (!command || typeof command !== "object") throw new InvalidWorkflowInputError();
  if (!isReadiness(command.expectedReadiness) || !isReadiness(command.nextReadiness)) {
    throw new InvalidWorkflowInputError();
  }
  const keys = Object.keys(command).sort();
  if (command.expectedReadiness === command.nextReadiness) {
    throw new InvalidWorkflowInputError();
  }
  if (command.nextReadiness === "approved") {
    if (
      command.expectedReadiness !== "ready"
      || !Number.isSafeInteger(command.observedHeadSeq)
      || command.observedHeadSeq < 0
      || keys.join(",") !== "expectedReadiness,nextReadiness,observedHeadSeq"
    ) {
      throw new InvalidWorkflowInputError();
    }
    return;
  }
  if (keys.join(",") !== "expectedReadiness,nextReadiness") {
    throw new InvalidWorkflowInputError();
  }
}

function isReadiness(value: unknown): value is DocumentReadiness {
  return value === "approved" || value === "draft" || value === "needs_review" || value === "ready";
}

async function executeBounded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DocumentWorkflowServiceError) throw error;
    if (error instanceof InvalidWorkflowInputError) {
      throw new DocumentWorkflowServiceError("invalid_request");
    }
    if (
      error instanceof CollaborationPersistenceError
      && error.category === "not_found"
    ) {
      throw new DocumentWorkflowServiceError("not_found");
    }
    throw new DocumentWorkflowServiceError("unavailable");
  }
}

class InvalidWorkflowInputError extends Error {}
class WorkflowTransactionInvariantError extends Error {}

const defaultService = createDocumentWorkflowService();

export const executeDocumentWorkflowCommand = defaultService.execute;
export const readDocumentWorkflowState = defaultService.read;
