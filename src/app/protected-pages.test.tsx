import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { notFound } from "next/navigation";
import { getProtectedPageContext } from "@/features/auth/route-context";
import { listAiRunSummariesPage } from "@/features/ai/ai-run-repository";
import { listConversations } from "@/features/ai/conversation-repository";
import {
  getDocumentById,
  listDocumentReferenceCandidates,
  listDocumentSummaries,
} from "@/features/documents/document-repository";
import { listProposalSummariesPage } from "@/features/proposals/proposal-repository";
import { listActivePromptTemplates, listPromptTemplates } from "@/features/templates/template-repository";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { InvalidCollectionCursorError } from "@/features/pagination/collection-cursor";
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
  listDocumentSummaries: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

vi.mock("@/features/templates/template-repository", () => ({
  listActivePromptTemplates: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
}));

vi.mock("@/features/ai/ai-run-repository", () => ({
  listAiRunSummariesPage: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

vi.mock("@/features/ai/conversation-repository", () => ({
  listConversations: vi.fn(async () => ({ ok: true, value: { items: [], nextCursor: null } })),
}));

vi.mock("@/features/proposals/proposal-repository", () => ({
  listProposalSummariesPage: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

describe("protected server pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CONVERSATION_STORAGE;
    delete process.env.PROJECT_PROFILE_ID;
  });

  it("passes the authenticated workspace to the documents and templates pages", async () => {
    await DocumentsPage({ searchParams: Promise.resolve({}) });
    await TemplatesPage();

    expect(getProtectedPageContext).toHaveBeenCalledWith("/documents");
    expect(listDocumentSummaries).toHaveBeenCalledWith(workspaceBContext, {
      cursor: undefined,
      limit: 20,
      readiness: "all",
      query: undefined,
    });
    expect(getProtectedPageContext).toHaveBeenCalledWith("/templates");
    expect(listPromptTemplates).toHaveBeenCalledWith(workspaceBContext);
  });

  it("renders an explicit empty-page notice for an invalid document cursor", async () => {
    vi.mocked(listDocumentSummaries).mockRejectedValueOnce(new InvalidCollectionCursorError());

    render(await DocumentsPage({ searchParams: Promise.resolve({ cursor: "not-a-cursor" }) }));

    expect(screen.getByRole("alert")).toHaveTextContent("페이지 또는 필터 조건이 올바르지 않습니다");
    expect(screen.getByText("일치하는 문서를 표시하지 않았습니다.")).toBeInTheDocument();
  });

  it("passes the active Project Profile to the template manager", async () => {
    process.env.PROJECT_PROFILE_ID = "research-writing";

    const page = await TemplatesPage();

    expect(page.props.projectProfile.id).toBe("research-writing");
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
    vi.mocked(listAiRunSummariesPage).mockResolvedValueOnce({ items: [{
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
    }], nextCursor: "runs-next" } as never);
    vi.mocked(listProposalSummariesPage).mockResolvedValueOnce({ items: [{
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
      isTruncated: false,
    }], nextCursor: "proposals-next" } as never);
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
    expect(listAiRunSummariesPage).toHaveBeenCalledWith(workspaceBContext, "workspace-b-document", { limit: 20 });
    expect(listConversations).toHaveBeenCalledWith(workspaceBContext, { documentId: "workspace-b-document" });
    expect(listProposalSummariesPage).toHaveBeenCalledWith(workspaceBContext, "workspace-b-document", { limit: 20 });
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
    expect(page.props.aiRunsNextCursor).toBe("runs-next");
    expect(JSON.stringify(page.props.aiRuns)).not.toMatch(
      /must-not-leak|idempotencyKey|operationFingerprint|retryNotBeforeAt|inputSummaryJson|workspaceId/,
    );
    expect(page.props.proposals).toEqual([{
      appliedMode: null,
      command: null,
      defaultApplyMode: "replace",
      explanation: "Clearer wording.",
      id: "proposal_1",
      isTruncated: false,
      occurrenceIndex: 0,
      replacementText: "Clearer private text",
      source: "review",
      status: "pending",
      targetFrom: null,
      targetText: "Private",
      targetTo: null,
    }]);
    expect(page.props.proposalsNextCursor).toBe("proposals-next");
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
    expect(listAiRunSummariesPage).not.toHaveBeenCalled();
    expect(listProposalSummariesPage).not.toHaveBeenCalled();
    expect(listDocumentReferenceCandidates).not.toHaveBeenCalled();
  });

  it("uses browser-local conversation storage only when explicitly configured", async () => {
    process.env.CONVERSATION_STORAGE = "local";
    const page = await DocumentPage({ params: Promise.resolve({ id: "workspace-b-document" }) });

    expect(listConversations).not.toHaveBeenCalled();
    expect(page.props.conversationStorageMode).toBe("local");
    expect(page.props.conversationWorkspaceId).toBe("workspace-b");
  });

  it("keeps the editor available when database conversation prefetch is unavailable", async () => {
    vi.mocked(listConversations).mockRejectedValueOnce(new Error("database unavailable"));

    const page = await DocumentPage({ params: Promise.resolve({ id: "workspace-b-document" }) });

    expect(page.props.document.id).toBe("workspace-b-document");
    expect(page.props.initialConversationLoadFailed).toBe(true);
    expect(page.props.initialConversations).toBeUndefined();
  });

  it("passes the active Project Profile and its built-in template default to the editor", async () => {
    process.env.PROJECT_PROFILE_ID = "legal-review";
    vi.mocked(listActivePromptTemplates).mockResolvedValueOnce([{
      id: "workspace-contract-template",
      workspaceId: "workspace-b",
      builtinKey: "tpl_contract_review",
      name: "Contract Review",
      description: "Contract review",
      category: "contract_review",
      systemPrompt: "Review contracts",
      variableSchemaJson: { fields: [], required: [] },
      isDefault: true,
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }] as never);

    const page = await DocumentPage({ params: Promise.resolve({ id: "workspace-b-document" }) });

    expect(page.props.projectProfile.id).toBe("legal-review");
    expect(page.props.defaultTemplateId).toBe("workspace-contract-template");
  });
});
