import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import { aiProposals, documents, type AiProposalRecord, type DocumentRecord } from "@/db/schema";
import { retrySqliteContention } from "@/db/sqlite-contention";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { extractPlainTextFromTiptap } from "@/features/documents/tiptap-text";
import {
  applyProposalToTiptapDraft,
  createProposalContentSignature,
  type ProposalApplyMode,
} from "./proposal-transaction";

type ProposalApplicationDatabase = typeof db;

export type ProposalApplicationDraft = {
  id: string;
};

export type ProposalApplicationInput = {
  appliedMode: ProposalApplyMode;
  draft: ProposalApplicationDraft;
  expectedDocumentContentSignature: string;
  expectedStatus?: "pending";
  proposalId: string;
};

export type ProposalApplicationResult =
  | {
      document: DocumentRecord;
      ok: true;
      proposal: AiProposalRecord;
    }
  | {
      applyFailureReason?: "empty_target" | "target_not_found" | "ambiguous_target" | "stale_selection";
      document?: DocumentRecord;
      error:
        | "proposal_not_found"
        | "document_not_found"
        | "document_mismatch"
        | "document_changed"
        | "proposal_status_changed"
        | "proposal_apply_failed";
      ok: false;
      proposal?: AiProposalRecord;
    };

class ProposalDocumentCasRollback extends Error {
  documentId: string;
  proposal: AiProposalRecord;

  constructor(documentId: string, proposal: AiProposalRecord) {
    super("Proposal document update lost its revision compare-and-swap");
    this.name = "ProposalDocumentCasRollback";
    this.documentId = documentId;
    this.proposal = proposal;
  }
}

export function createProposalApplicationService(database: ProposalApplicationDatabase = db) {
  return {
    async applyProposalToDocumentDraft(
      scope: WorkspaceScope,
      input: ProposalApplicationInput,
    ): Promise<ProposalApplicationResult> {
      try {
        return await withSerializedDocumentWrite(scope, input.draft.id, () => retrySqliteContention(
          () => database.transaction(async (transaction) => {
          const [proposal] = await transaction
            .select()
            .from(aiProposals)
            .where(
              and(
                eq(aiProposals.workspaceId, scope.workspaceId),
                eq(aiProposals.id, input.proposalId),
              ),
            )
            .limit(1);

          if (!proposal) {
            return { error: "proposal_not_found", ok: false };
          }

          const expectedStatus = input.expectedStatus ?? "pending";
          if (proposal.status !== expectedStatus) {
            return { error: "proposal_status_changed", ok: false, proposal };
          }

          if (input.draft.id !== proposal.documentId) {
            return { error: "document_mismatch", ok: false, proposal };
          }

          const [document] = await transaction
            .select()
            .from(documents)
            .where(
              and(
                eq(documents.workspaceId, scope.workspaceId),
                eq(documents.id, proposal.documentId),
                eq(documents.status, "draft"),
              ),
            )
            .limit(1);

          if (!document) {
            return { error: "document_not_found", ok: false, proposal };
          }

          if (input.expectedDocumentContentSignature !== createProposalContentSignature(document.contentJson)) {
            return {
              document,
              error: "document_changed",
              ok: false,
              proposal,
            };
          }

          const appliedDraft = applyProposalToTiptapDraft(document.contentJson, proposal, undefined, input.appliedMode);
          if (!appliedDraft.ok) {
            return {
              applyFailureReason: appliedDraft.reason,
              error: "proposal_apply_failed",
              ok: false,
              proposal,
            };
          }

          const now = new Date();
          const [updatedProposal] = await transaction
            .update(aiProposals)
            .set({
              appliedMode: input.appliedMode,
              status: "accepted",
              updatedAt: now,
            })
            .where(
              and(
                eq(aiProposals.workspaceId, scope.workspaceId),
                eq(aiProposals.id, input.proposalId),
                eq(aiProposals.status, expectedStatus),
              ),
            )
            .returning();

          if (!updatedProposal) {
            const [currentProposal] = await transaction
              .select()
              .from(aiProposals)
              .where(
                and(
                  eq(aiProposals.workspaceId, scope.workspaceId),
                  eq(aiProposals.id, input.proposalId),
                ),
              )
              .limit(1);

            return {
              error: "proposal_status_changed",
              ok: false,
              proposal: currentProposal ?? proposal,
            };
          }

          const [updatedDocument] = await transaction
            .update(documents)
            .set({
              contentJson: appliedDraft.contentJson,
              plainText: extractPlainTextFromTiptap(appliedDraft.contentJson),
              revision: document.revision + 1,
              updatedAt: now,
            })
            .where(
              and(
                eq(documents.workspaceId, scope.workspaceId),
                eq(documents.id, proposal.documentId),
                eq(documents.status, "draft"),
                eq(documents.revision, document.revision),
              ),
            )
            .returning();

          if (!updatedDocument) {
            throw new ProposalDocumentCasRollback(proposal.documentId, proposal);
          }

          return {
            document: updatedDocument,
            ok: true,
            proposal: updatedProposal,
          };
          }),
        ));
      } catch (error) {
        if (error instanceof ProposalDocumentCasRollback) {
          const [latestDocument] = await retrySqliteContention(async () => database
            .select()
            .from(documents)
            .where(
              and(
                eq(documents.workspaceId, scope.workspaceId),
                eq(documents.id, error.documentId),
                eq(documents.status, "draft"),
              ),
            )
            .limit(1));

          return latestDocument
            ? {
                document: latestDocument,
                error: "document_changed",
                ok: false,
                proposal: error.proposal,
              }
            : { error: "document_not_found", ok: false, proposal: error.proposal };
        }

        throw error;
      }
    },
  };
}

const defaultService = createProposalApplicationService();

export const applyProposalToDocumentDraft = defaultService.applyProposalToDocumentDraft;
