import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentDraft,
  createDocumentFromDraft,
  createDocumentFromDraftIdempotently,
  listDocumentSummaries,
} from "@/features/documents/document-repository";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { GET, POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  createDocumentDraft: vi.fn(),
  createDocumentFromDraft: vi.fn(),
  createDocumentFromDraftIdempotently: vi.fn(),
  emptyDocument: { type: "doc", content: [{ type: "paragraph" }] },
  listDocumentSummaries: vi.fn(),
}));

describe("POST /api/documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PROJECT_PROFILE_ID;
  });

  it("rejects client-owned readiness during document creation", async () => {
    const response = await POST(new Request("http://localhost/api/documents", {
      method: "POST",
      body: JSON.stringify({ title: "Smuggled approval", readiness: "approved" }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
    expect(createDocumentDraft).not.toHaveBeenCalled();
    expect(createDocumentFromDraft).not.toHaveBeenCalled();
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
  });

  it("rejects creation metadata outside the active Project Profile", async () => {
    process.env.PROJECT_PROFILE_ID = "legal-review";
    const response = await POST(new Request("http://localhost/api/documents", {
      method: "POST",
      body: JSON.stringify({
        title: "Contract",
        contentJson: { type: "doc", content: [] },
        metadataJson: { researchQuestion: "Not a legal field" },
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Document violates active Project Profile",
      reason: "invalid_project_profile",
    });
    expect(createDocumentFromDraft).not.toHaveBeenCalled();
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
  });

  it("returns 429 before parsing or persistence when the budget is exhausted", async () => {
    setRequestBudgetForTests({
      consume: vi.fn(async () => ({
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAt: new Date(Date.now() + 5_000),
      })),
    });
    const request = { json: vi.fn() } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(request.json).not.toHaveBeenCalled();
    expect(createDocumentDraft).not.toHaveBeenCalled();
  });

  it("rejects an unbounded title before persistence", async () => {
    const response = await POST(
      new Request("http://localhost/api/documents", {
        method: "POST",
        body: JSON.stringify({ title: "x".repeat(501) }),
      }),
    );

    expect(response.status).toBe(400);
    expect(createDocumentDraft).not.toHaveBeenCalled();
  });

  it("creates a full conflict-recovery draft in one persistence call", async () => {
    const draft = {
      title: "Recovered local draft",
      contentJson: {
        type: "doc" as const,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Local work" }] }],
      },
      metadataJson: { owner: "Legal" },
    };
    vi.mocked(createDocumentFromDraft).mockResolvedValueOnce({
      id: "doc_recovered",
      workspaceId: "vitest-workspace",
      creationKey: null,
      ...draft,
      readiness: "draft" as const,
      plainText: "Local work",
      status: "draft",
      revision: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await POST(new Request("http://localhost/api/documents", {
      method: "POST",
      body: JSON.stringify(draft),
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ document: { id: "doc_recovered", revision: 0 } });
    expect(createDocumentFromDraft).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "vitest-workspace",
    }), draft);
    expect(createDocumentDraft).not.toHaveBeenCalled();
  });

  it("preserves metadata and uses initial readiness when contentJson is omitted", async () => {
    const emptyContent = { type: "doc" as const, content: [{ type: "paragraph" }] };
    vi.mocked(createDocumentFromDraft).mockResolvedValueOnce({
      id: "doc_profiled",
      workspaceId: "vitest-workspace",
      creationKey: null,
      title: "Profiled draft",
      contentJson: emptyContent,
      metadataJson: { owner: "Legal" },
      plainText: "",
      readiness: "draft",
      status: "draft",
      revision: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await POST(new Request("http://localhost/api/documents", {
      method: "POST",
      body: JSON.stringify({
        title: "Profiled draft",
        metadataJson: { owner: "Legal" },
      }),
    }));

    expect(response.status).toBe(201);
    expect(createDocumentFromDraft).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "vitest-workspace" }),
      {
        title: "Profiled draft",
        contentJson: emptyContent,
        metadataJson: { owner: "Legal" },
      },
    );
    expect(createDocumentDraft).not.toHaveBeenCalled();
  });

  it("keeps title-only creation on the simple draft path", async () => {
    vi.mocked(createDocumentDraft).mockResolvedValueOnce({
      id: "doc_simple",
      workspaceId: "vitest-workspace",
      creationKey: null,
      title: "Simple draft",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      metadataJson: {},
      plainText: "",
      readiness: "draft",
      status: "draft",
      revision: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await POST(new Request("http://localhost/api/documents", {
      method: "POST",
      body: JSON.stringify({ title: "Simple draft" }),
    }));

    expect(response.status).toBe(201);
    expect(createDocumentDraft).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "vitest-workspace" }),
      "Simple draft",
    );
    expect(createDocumentFromDraft).not.toHaveBeenCalled();
  });

  it.each([
    [false, 201],
    [true, 200],
  ])("idempotently creates or replays a recovery draft (replayed=%s)", async (replayed, status) => {
    const draft = {
      title: "Recovered local draft",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      metadataJson: {},
    };
    vi.mocked(createDocumentFromDraftIdempotently).mockResolvedValueOnce({
      document: {
        id: "doc_recovered",
        workspaceId: "vitest-workspace",
        ...draft,
        readiness: "draft" as const,
        creationKey: "recovery-key-123456",
        plainText: "",
        status: "draft",
        revision: 0,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      replayed,
    });

    const response = await POST(new Request("http://localhost/api/documents", {
      method: "POST",
      headers: { "Idempotency-Key": "recovery-key-123456" },
      body: JSON.stringify(draft),
    }));

    expect(response.status).toBe(status);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      document: { id: "doc_recovered" },
      replayed,
    });
    expect(responseBody.document).not.toHaveProperty("creationKey");
    expect(createDocumentFromDraftIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "vitest-workspace" }),
      draft,
      "recovery-key-123456",
    );
    expect(createDocumentFromDraft).not.toHaveBeenCalled();
  });

  it("does not expose internal creation keys when listing documents", async () => {
    vi.mocked(listDocumentSummaries).mockResolvedValueOnce({ items: [{
      id: "doc_recovered",
      title: "Recovered local draft",
      metadataJson: {},
      plainText: "",
      readiness: "draft",
      revision: 0,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }], nextCursor: "next-page" });

    const responseBody = await (await GET(new Request("http://localhost/api/documents"))).json();

    expect(responseBody.documents).toHaveLength(1);
    expect(responseBody.documents[0]).not.toHaveProperty("creationKey");
    expect(responseBody.documents[0]).not.toHaveProperty("contentJson");
    expect(responseBody.nextCursor).toBe("next-page");
  });

  it("rejects invalid profile filters instead of silently listing every document", async () => {
    process.env.PROJECT_PROFILE_ID = "legal-review";

    const response = await GET(new Request(
      "http://localhost/api/documents?metadataKey=counterparty&metadataValue=",
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid document filter" });
    expect(listDocumentSummaries).not.toHaveBeenCalled();
  });

  it("rejects malformed idempotency keys before persistence", async () => {
    const response = await POST(new Request("http://localhost/api/documents", {
      method: "POST",
      headers: { "Idempotency-Key": "short" },
      body: JSON.stringify({
        title: "Recovered local draft",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      }),
    }));

    expect(response.status).toBe(400);
    expect(createDocumentFromDraftIdempotently).not.toHaveBeenCalled();
    expect(createDocumentFromDraft).not.toHaveBeenCalled();
  });
});
