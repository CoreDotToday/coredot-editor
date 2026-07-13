import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound } from "next/navigation";
import { getProtectedPageContext } from "@/features/auth/route-context";
import { listAiRunsForDocument } from "@/features/ai/ai-run-repository";
import {
  getDocumentById,
  listDocumentReferenceCandidates,
  listDocuments,
} from "@/features/documents/document-repository";
import { listProposalsForDocument } from "@/features/proposals/proposal-repository";
import { listActivePromptTemplates, listPromptTemplates } from "@/features/templates/template-repository";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import DocumentsPage from "./documents/page";
import DocumentPage from "./documents/[id]/page";
import TemplatesPage from "./templates/page";

const workspaceBContext = {
  ...TEST_REQUEST_CONTEXT,
  principalId: "principal-b",
  requestId: "request-b",
  workspaceId: "workspace-b",
};

vi.mock("@/features/auth/route-context", () => ({
  getProtectedPageContext: vi.fn(async () => workspaceBContext),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND_TEST");
  }),
  redirect: vi.fn(),
}));

vi.mock("@/features/documents/document-repository", () => ({
  createDocumentDraft: vi.fn(),
  getDocumentById: vi.fn(async (_scope, id) => ({
    id,
    workspaceId: "workspace-b",
    creationKey: "internal-recovery-key-123456",
    title: "Workspace B memo",
    contentJson: { type: "doc" },
    plainText: "Private",
    status: "draft",
    readiness: "draft",
    metadataJson: {},
    revision: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })),
  listDocumentReferenceCandidates: vi.fn(async () => []),
  listDocuments: vi.fn(async () => []),
}));

vi.mock("@/features/templates/template-repository", () => ({
  listActivePromptTemplates: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
}));

vi.mock("@/features/ai/ai-run-repository", () => ({
  listAiRunsForDocument: vi.fn(async () => []),
}));

vi.mock("@/features/proposals/proposal-repository", () => ({
  listProposalsForDocument: vi.fn(async () => []),
}));

describe("protected server pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the authenticated workspace to the documents and templates pages", async () => {
    await DocumentsPage({ searchParams: Promise.resolve({}) });
    await TemplatesPage();

    expect(getProtectedPageContext).toHaveBeenCalledWith("/documents");
    expect(listDocuments).toHaveBeenCalledWith(workspaceBContext);
    expect(getProtectedPageContext).toHaveBeenCalledWith("/templates");
    expect(listPromptTemplates).toHaveBeenCalledWith(workspaceBContext);
  });

  it("passes the authenticated workspace to every direct-id page query", async () => {
    const referenceUpdatedAt = new Date("2026-01-02T00:00:00.000Z");
    const aiRunCreatedAt = new Date("2026-01-03T00:00:00.000Z");
    vi.mocked(listActivePromptTemplates).mockResolvedValueOnce([{
      id: "template_1",
      workspaceId: "workspace-b-must-not-leak",
      builtinKey: "builtin-must-not-leak",
      name: "Review",
      description: "description-must-not-leak",
      category: "review",
      systemPrompt: "system-prompt-must-not-leak",
      variableSchemaJson: { fields: [], required: [] },
      isDefault: false,
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }] as never);
    vi.mocked(listAiRunsForDocument).mockResolvedValueOnce([{
      id: "run_1",
      workspaceId: "workspace-b-must-not-leak",
      documentId: "workspace-b-document",
      promptTemplateId: "template-must-not-leak",
      commandType: "document_review",
      provider: "provider-must-not-leak",
      model: "model-must-not-leak",
      idempotencyKey: "idempotency-key-must-not-leak",
      operationFingerprint: "fingerprint-must-not-leak",
      retryNotBeforeAt: new Date("2026-01-03T00:02:00.000Z"),
      inputSummaryJson: { prompt: "input-must-not-leak" },
      outputText: "output-must-not-leak",
      status: "completed",
      wasApplied: false,
      errorMessage: null,
      createdAt: aiRunCreatedAt,
      updatedAt: new Date("2026-01-03T00:01:00.000Z"),
    }] as never);
    vi.mocked(listProposalsForDocument).mockResolvedValueOnce([{
      id: "proposal_1",
      workspaceId: "workspace-b-must-not-leak",
      aiRunId: "run-must-not-leak",
      documentId: "document-must-not-leak",
      targetText: "Private",
      replacementText: "Clearer private text",
      explanation: "Clearer wording.",
      source: "review",
      command: null,
      occurrenceIndex: 0,
      targetFrom: null,
      targetTo: null,
      defaultApplyMode: "replace",
      resultOrdinal: 0,
      appliedMode: null,
      status: "pending",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    }] as never);
    vi.mocked(listDocumentReferenceCandidates).mockResolvedValueOnce([{
      id: "reference-document",
      workspaceId: "workspace-b",
      creationKey: "internal-reference-key-123456",
      title: "Reference memo",
      contentJson: { type: "doc" },
      plainText: "Reference text",
      status: "draft",
      readiness: "draft",
      metadataJson: {},
      revision: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: referenceUpdatedAt,
    }] as never);
    const page = await DocumentPage({ params: Promise.resolve({ id: "workspace-b-document" }) });

    expect(getProtectedPageContext).toHaveBeenCalledWith("/documents/workspace-b-document");
    expect(getDocumentById).toHaveBeenCalledWith(workspaceBContext, "workspace-b-document");
    expect(listActivePromptTemplates).toHaveBeenCalledWith(workspaceBContext);
    expect(listAiRunsForDocument).toHaveBeenCalledWith(workspaceBContext, "workspace-b-document");
    expect(listProposalsForDocument).toHaveBeenCalledWith(workspaceBContext, "workspace-b-document");
    expect(listDocumentReferenceCandidates).toHaveBeenCalledWith(workspaceBContext, {
      excludeDocumentId: "workspace-b-document",
      limit: 24,
    });
    expect(page.props.document).not.toHaveProperty("creationKey");
    expect(page.props.aiRuns).toEqual([{
      commandType: "document_review",
      createdAt: aiRunCreatedAt,
      id: "run_1",
      status: "completed",
    }]);
    expect(JSON.stringify(page.props.aiRuns)).not.toMatch(
      /must-not-leak|idempotencyKey|operationFingerprint|retryNotBeforeAt|inputSummaryJson|workspaceId/,
    );
    expect(page.props.proposals).toEqual([{
      appliedMode: null,
      command: null,
      defaultApplyMode: "replace",
      explanation: "Clearer wording.",
      id: "proposal_1",
      occurrenceIndex: 0,
      replacementText: "Clearer private text",
      source: "review",
      status: "pending",
      targetFrom: null,
      targetText: "Private",
      targetTo: null,
    }]);
    expect(JSON.stringify(page.props.proposals)).not.toMatch(
      /must-not-leak|workspaceId|aiRunId|documentId|resultOrdinal/,
    );
    expect(page.props.referenceDocuments).toEqual([{
      id: "reference-document",
      plainText: "Reference text",
      title: "Reference memo",
      updatedAt: referenceUpdatedAt,
    }]);
    expect(page.props.templates).toEqual([{
      category: "review",
      id: "template_1",
      name: "Review",
      variableSchemaJson: { fields: [], required: [] },
    }]);
    expect(JSON.stringify(page.props.templates)).not.toMatch(/must-not-leak|systemPrompt|workspaceId/);
  });

  it("invokes notFound and skips downstream queries for a cross-workspace document id", async () => {
    vi.mocked(getDocumentById).mockResolvedValueOnce(null as never);

    await expect(
      DocumentPage({ params: Promise.resolve({ id: "workspace-a-document" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND_TEST");

    expect(getProtectedPageContext).toHaveBeenCalledWith("/documents/workspace-a-document");
    expect(getDocumentById).toHaveBeenCalledWith(workspaceBContext, "workspace-a-document");
    expect(notFound).toHaveBeenCalledOnce();
    expect(listActivePromptTemplates).not.toHaveBeenCalled();
    expect(listAiRunsForDocument).not.toHaveBeenCalled();
    expect(listProposalsForDocument).not.toHaveBeenCalled();
    expect(listDocumentReferenceCandidates).not.toHaveBeenCalled();
  });
});
