import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import {
  aiProposals,
  documentChangeProposals,
  documentChanges,
  documents,
  type AiProposalRecord,
  type DocumentChangeRecord,
  type DocumentChangeSnapshot,
  type DocumentMetadata,
  type DocumentReadiness,
  type DocumentRecord,
} from "@/db/schema";
import { retrySqliteContention } from "@/db/sqlite-contention";
import type { RequestContext } from "@/features/auth/request-context";
import {
  DOCUMENT_REQUEST_BODY_BYTES,
  RESOURCE_LIMITS,
  validateTiptapResource,
} from "@/features/security/resource-policy";
import { documentReadinessValues } from "./document-metadata";
import { extractPlainTextFromTiptap } from "./tiptap-text";
import {
  applyProposalToTiptapDraft,
  getProposalApplicationOrder,
  type ProposalApplyMode,
} from "@/features/proposals/proposal-transaction";

type DocumentChangeDatabase = typeof db;
type DraftValidationLimit =
  | "documentDepth"
  | "documentJsonBytes"
  | "documentNodes"
  | "malformed"
  | "metadata"
  | "readiness"
  | "snapshotBytes"
  | "title";

export type DocumentChangeDraft = DocumentChangeSnapshot;
export type ProposalChangeInput = { mode: ProposalApplyMode; proposalId: string };
export type ApplyProposalInput = {
  documentId: string;
  draft: DocumentChangeDraft;
  expectedRevision: number;
  mode: ProposalApplyMode;
  proposalId: string;
};
export type ApplyProposalBatchInput = {
  documentId: string;
  draft: DocumentChangeDraft;
  expectedRevision: number;
  proposals: ProposalChangeInput[];
};
export type UndoDocumentChangeInput = { changeId: string; expectedRevision: number };

export type DocumentChangeResult =
  | {
      change: DocumentChangeRecord;
      document: DocumentRecord;
      ok: true;
      proposals: AiProposalRecord[];
    }
  | {
      applyFailureReason?: "empty_target" | "target_not_found" | "ambiguous_target" | "stale_selection";
      document?: DocumentRecord;
      limit?: DraftValidationLimit;
      ok: false;
      proposals?: AiProposalRecord[];
      reason:
        | "invalid_batch"
        | "invalid_draft"
        | "invalid_revision"
        | "not_found"
        | "proposal_apply_failed"
        | "revision_conflict"
        | "status_conflict";
    };

class DocumentChangeCasRollback extends Error {
  constructor(readonly documentId: string) {
    super("Document change lost its document revision compare-and-swap");
    this.name = "DocumentChangeCasRollback";
  }
}

class DocumentChangeStatusRollback extends Error {
  constructor() {
    super("Document change status precondition changed");
    this.name = "DocumentChangeStatusRollback";
  }
}

export function createDocumentChangeService(database: DocumentChangeDatabase = db) {
  async function applyProposalOperation(
    context: RequestContext,
    input: ApplyProposalBatchInput,
    operationKind: "single" | "batch",
  ): Promise<DocumentChangeResult> {
    const draftValidation = validateDocumentChangeDraft(input.draft);
    if (!draftValidation.ok) {
      return { limit: draftValidation.limit, ok: false, reason: "invalid_draft" };
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      return { ok: false, reason: "invalid_revision" };
    }
    if (
      input.proposals.length === 0 || input.proposals.length > RESOURCE_LIMITS.proposalBatchItems ||
      new Set(input.proposals.map(({ proposalId }) => proposalId)).size !== input.proposals.length
    ) {
      return { ok: false, reason: "invalid_batch" };
    }

    try {
      return await withSerializedDocumentWrite(context, input.documentId, () =>
        retrySqliteContention(() => database.transaction(async (transaction) => {
          const [document] = await transaction
            .select()
            .from(documents)
            .where(and(
              eq(documents.workspaceId, context.workspaceId),
              eq(documents.id, input.documentId),
              eq(documents.status, "draft"),
            ))
            .limit(1);
          if (!document) return { ok: false, reason: "not_found" } as const;

          const proposalIds = input.proposals.map(({ proposalId }) => proposalId);
          const foundProposals = await transaction
            .select()
            .from(aiProposals)
            .where(and(
              eq(aiProposals.workspaceId, context.workspaceId),
              eq(aiProposals.documentId, input.documentId),
              inArray(aiProposals.id, proposalIds),
            ));
          const proposalsById = new Map(foundProposals.map((proposal) => [proposal.id, proposal]));
          const requested = input.proposals.flatMap((request, ordinal) => {
            const proposal = proposalsById.get(request.proposalId);
            return proposal ? [{ mode: request.mode, ordinal, proposal }] : [];
          });
          if (requested.length !== input.proposals.length) return { ok: false, reason: "not_found" } as const;
          if (requested.some(({ proposal }) => proposal.status !== "pending")) {
            return { ok: false, proposals: requested.map(({ proposal }) => proposal), reason: "status_conflict" } as const;
          }
          if (document.revision !== input.expectedRevision) {
            return { document, ok: false, reason: "revision_conflict" } as const;
          }

          const ordered = getProposalApplicationOrder(
            requested.map((item) => ({ ...item.proposal, changeItem: item })),
            {},
          );
          let nextContentJson = input.draft.contentJson;
          for (const orderedProposal of ordered) {
            const application = applyProposalToTiptapDraft(
              nextContentJson,
              orderedProposal,
              undefined,
              orderedProposal.changeItem.mode,
            );
            if (!application.ok) {
              return {
                applyFailureReason: application.reason,
                ok: false,
                proposals: requested.map(({ proposal }) => proposal),
                reason: "proposal_apply_failed",
              } as const;
            }
            nextContentJson = application.contentJson;
          }

          const now = new Date();
          const [updatedDocument] = await transaction
            .update(documents)
            .set({
              title: input.draft.title,
              contentJson: nextContentJson,
              metadataJson: input.draft.metadataJson,
              plainText: extractPlainTextFromTiptap(nextContentJson),
              readiness: input.draft.readiness,
              revision: input.expectedRevision + 1,
              updatedAt: now,
            })
            .where(and(
              eq(documents.workspaceId, context.workspaceId),
              eq(documents.id, input.documentId),
              eq(documents.status, "draft"),
              eq(documents.revision, input.expectedRevision),
            ))
            .returning();
          if (!updatedDocument) throw new DocumentChangeCasRollback(input.documentId);

          const updatedProposals: AiProposalRecord[] = [];
          for (const item of requested) {
            const [updatedProposal] = await transaction
              .update(aiProposals)
              .set({ appliedMode: item.mode, status: "accepted", updatedAt: now })
              .where(and(
                eq(aiProposals.workspaceId, context.workspaceId),
                eq(aiProposals.documentId, input.documentId),
                eq(aiProposals.id, item.proposal.id),
                eq(aiProposals.status, "pending"),
              ))
              .returning();
            if (!updatedProposal) throw new DocumentChangeStatusRollback();
            updatedProposals.push(updatedProposal);
          }

          const isBatch = operationKind === "batch";
          const [change] = await transaction
            .insert(documentChanges)
            .values({
              workspaceId: context.workspaceId,
              documentId: input.documentId,
              principalId: context.principalId,
              requestId: context.requestId,
              kind: isBatch ? "batch" : "single",
              batchId: isBatch ? nanoid() : null,
              beforeSnapshotJson: input.draft,
              afterRevision: updatedDocument.revision,
              createdAt: now,
            })
            .returning();
          if (!change) throw new Error("Document change audit insert returned no row");
          await transaction.insert(documentChangeProposals).values(requested.map((item) => ({
            workspaceId: context.workspaceId,
            changeId: change.id,
            documentId: input.documentId,
            proposalId: item.proposal.id,
            appliedMode: item.mode,
            ordinal: item.ordinal,
          })));

          return { change, document: updatedDocument, ok: true, proposals: updatedProposals } as const;
        })),
      );
    } catch (error) {
      if (error instanceof DocumentChangeCasRollback) {
        return latestRevisionConflict(database, context, error.documentId);
      }
      if (error instanceof DocumentChangeStatusRollback) {
        return { ok: false, reason: "status_conflict" };
      }
      throw error;
    }
  }

  return {
    applyProposal(context: RequestContext, input: ApplyProposalInput) {
      return applyProposalOperation(context, {
        documentId: input.documentId,
        draft: input.draft,
        expectedRevision: input.expectedRevision,
        proposals: [{ mode: input.mode, proposalId: input.proposalId }],
      }, "single");
    },

    applyProposalBatch(context: RequestContext, input: ApplyProposalBatchInput) {
      return applyProposalOperation(context, input, "batch");
    },

    async undo(context: RequestContext, input: UndoDocumentChangeInput): Promise<DocumentChangeResult> {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        return { ok: false, reason: "invalid_revision" };
      }
      const [observedChange] = await retrySqliteContention(async () => database
        .select()
        .from(documentChanges)
        .where(and(
          eq(documentChanges.workspaceId, context.workspaceId),
          eq(documentChanges.id, input.changeId),
        ))
        .limit(1));
      if (!observedChange) return { ok: false, reason: "not_found" };

      try {
        return await withSerializedDocumentWrite(context, observedChange.documentId, () =>
          retrySqliteContention(() => database.transaction(async (transaction) => {
            const [change] = await transaction
              .select()
              .from(documentChanges)
              .where(and(
                eq(documentChanges.workspaceId, context.workspaceId),
                eq(documentChanges.id, input.changeId),
                eq(documentChanges.documentId, observedChange.documentId),
              ))
              .limit(1);
            if (!change) return { ok: false, reason: "not_found" } as const;
            if (change.undoneAt) return { ok: false, reason: "status_conflict" } as const;

            const [document] = await transaction
              .select()
              .from(documents)
              .where(and(
                eq(documents.workspaceId, context.workspaceId),
                eq(documents.id, change.documentId),
                eq(documents.status, "draft"),
              ))
              .limit(1);
            if (!document) return { ok: false, reason: "not_found" } as const;
            if (document.revision !== input.expectedRevision || input.expectedRevision !== change.afterRevision) {
              return { document, ok: false, reason: "revision_conflict" } as const;
            }

            const links = await transaction
              .select()
              .from(documentChangeProposals)
              .where(and(
                eq(documentChangeProposals.workspaceId, context.workspaceId),
                eq(documentChangeProposals.changeId, change.id),
                eq(documentChangeProposals.documentId, change.documentId),
              ));
            const proposalIds = links.map(({ proposalId }) => proposalId);
            const linkedProposals = proposalIds.length === 0 ? [] : await transaction
              .select()
              .from(aiProposals)
              .where(and(
                eq(aiProposals.workspaceId, context.workspaceId),
                eq(aiProposals.documentId, change.documentId),
                inArray(aiProposals.id, proposalIds),
              ));
            const proposalById = new Map(linkedProposals.map((proposal) => [proposal.id, proposal]));
            if (
              links.length === 0 ||
              linkedProposals.length !== links.length ||
              links.some((link) => {
                const proposal = proposalById.get(link.proposalId);
                return proposal?.status !== "accepted" || proposal.appliedMode !== link.appliedMode;
              })
            ) {
              return { ok: false, reason: "status_conflict" } as const;
            }
            if (!validateDocumentChangeDraft(change.beforeSnapshotJson).ok) {
              return { ok: false, reason: "status_conflict" } as const;
            }

            const now = new Date();
            const [restoredDocument] = await transaction
              .update(documents)
              .set({
                title: change.beforeSnapshotJson.title,
                contentJson: change.beforeSnapshotJson.contentJson,
                metadataJson: change.beforeSnapshotJson.metadataJson,
                plainText: extractPlainTextFromTiptap(change.beforeSnapshotJson.contentJson),
                readiness: change.beforeSnapshotJson.readiness,
                revision: input.expectedRevision + 1,
                updatedAt: now,
              })
              .where(and(
                eq(documents.workspaceId, context.workspaceId),
                eq(documents.id, change.documentId),
                eq(documents.status, "draft"),
                eq(documents.revision, input.expectedRevision),
              ))
              .returning();
            if (!restoredDocument) throw new DocumentChangeCasRollback(change.documentId);

            const resetProposals: AiProposalRecord[] = [];
            for (const link of links.sort((left, right) => left.ordinal - right.ordinal)) {
              const [resetProposal] = await transaction
                .update(aiProposals)
                .set({ appliedMode: null, status: "pending", updatedAt: now })
                .where(and(
                  eq(aiProposals.workspaceId, context.workspaceId),
                  eq(aiProposals.documentId, change.documentId),
                  eq(aiProposals.id, link.proposalId),
                  eq(aiProposals.status, "accepted"),
                  eq(aiProposals.appliedMode, link.appliedMode),
                ))
                .returning();
              if (!resetProposal) throw new DocumentChangeStatusRollback();
              resetProposals.push(resetProposal);
            }

            const [undoneChange] = await transaction
              .update(documentChanges)
              .set({ undoneAt: now })
              .where(and(
                eq(documentChanges.workspaceId, context.workspaceId),
                eq(documentChanges.id, change.id),
                eq(documentChanges.documentId, change.documentId),
                eq(documentChanges.afterRevision, input.expectedRevision),
                isNull(documentChanges.undoneAt),
              ))
              .returning();
            if (!undoneChange) throw new DocumentChangeStatusRollback();

            return { change: undoneChange, document: restoredDocument, ok: true, proposals: resetProposals } as const;
          })),
        );
      } catch (error) {
        if (error instanceof DocumentChangeCasRollback) {
          return latestRevisionConflict(database, context, error.documentId);
        }
        if (error instanceof DocumentChangeStatusRollback) {
          return { ok: false, reason: "status_conflict" };
        }
        throw error;
      }
    },
  };
}

async function latestRevisionConflict(
  database: DocumentChangeDatabase,
  context: Pick<RequestContext, "workspaceId">,
  documentId: string,
): Promise<DocumentChangeResult> {
  const [document] = await retrySqliteContention(async () => database
    .select()
    .from(documents)
    .where(and(
      eq(documents.workspaceId, context.workspaceId),
      eq(documents.id, documentId),
      eq(documents.status, "draft"),
    ))
    .limit(1));
  return document
    ? { document, ok: false, reason: "revision_conflict" }
    : { ok: false, reason: "not_found" };
}

function validateDocumentChangeDraft(
  draft: DocumentChangeDraft,
): { ok: true } | { limit: DraftValidationLimit; ok: false } {
  if (typeof draft.title !== "string" || draft.title.trim().length === 0 || draft.title.length > 500) {
    return { limit: "title", ok: false };
  }
  if (!documentReadinessValues.includes(draft.readiness as DocumentReadiness)) {
    return { limit: "readiness", ok: false };
  }
  if (!isDocumentMetadata(draft.metadataJson)) return { limit: "metadata", ok: false };
  const tiptapValidation = validateTiptapResource(draft.contentJson);
  if (!tiptapValidation.ok) return { limit: tiptapValidation.limit, ok: false };
  try {
    if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > DOCUMENT_REQUEST_BODY_BYTES) {
      return { limit: "snapshotBytes", ok: false };
    }
  } catch {
    return { limit: "malformed", ok: false };
  }
  return { ok: true };
}

function isDocumentMetadata(value: unknown): value is DocumentMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!key.trim() || key.startsWith("_")) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    return Array.isArray(item) && item.every((entry) => typeof entry === "string");
  });
}

const defaultService = createDocumentChangeService();

export const applyProposal = defaultService.applyProposal;
export const applyProposalBatch = defaultService.applyProposalBatch;
export const undoDocumentChange = defaultService.undo;
