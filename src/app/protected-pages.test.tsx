import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/features/documents/document-repository", () => ({
  createDocumentDraft: vi.fn(),
  getDocumentById: vi.fn(async (_scope, id) => ({
    id,
    workspaceId: "workspace-b",
    title: "Workspace B memo",
    contentJson: { type: "doc" },
    plainText: "Private",
    status: "draft",
    readiness: "draft",
    metadataJson: {},
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

  it("returns 404-shaped data access for a direct id only within the authenticated workspace", async () => {
    await DocumentPage({ params: Promise.resolve({ id: "workspace-b-document" }) });

    expect(getProtectedPageContext).toHaveBeenCalledWith("/documents/workspace-b-document");
    expect(getDocumentById).toHaveBeenCalledWith(workspaceBContext, "workspace-b-document");
    expect(listActivePromptTemplates).toHaveBeenCalledWith(workspaceBContext);
    expect(listAiRunsForDocument).toHaveBeenCalledWith(workspaceBContext, "workspace-b-document");
    expect(listProposalsForDocument).toHaveBeenCalledWith(workspaceBContext, "workspace-b-document");
    expect(listDocumentReferenceCandidates).toHaveBeenCalledWith(workspaceBContext, {
      excludeDocumentId: "workspace-b-document",
      limit: 24,
    });
  });
});
