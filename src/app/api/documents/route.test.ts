import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentDraft,
  createDocumentFromDraft,
  createDocumentFromDraftIdempotently,
  listDocuments,
} from "@/features/documents/document-repository";
import { setRequestBudgetForTests } from "@/features/security/request-budget";
import { GET, POST } from "./route";

vi.mock("@/features/documents/document-repository", () => ({
  createDocumentDraft: vi.fn(),
  createDocumentFromDraft: vi.fn(),
  createDocumentFromDraftIdempotently: vi.fn(),
  listDocuments: vi.fn(),
}));

describe("POST /api/documents", () => {
  beforeEach(() => vi.clearAllMocks());

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
      readiness: "needs_review" as const,
    };
    vi.mocked(createDocumentFromDraft).mockResolvedValueOnce({
      id: "doc_recovered",
      workspaceId: "vitest-workspace",
      creationKey: null,
      ...draft,
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

  it.each([
    [false, 201],
    [true, 200],
  ])("idempotently creates or replays a recovery draft (replayed=%s)", async (replayed, status) => {
    const draft = {
      title: "Recovered local draft",
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      metadataJson: {},
      readiness: "draft" as const,
    };
    vi.mocked(createDocumentFromDraftIdempotently).mockResolvedValueOnce({
      document: {
        id: "doc_recovered",
        workspaceId: "vitest-workspace",
        ...draft,
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
    vi.mocked(listDocuments).mockResolvedValueOnce([{
      id: "doc_recovered",
      workspaceId: "vitest-workspace",
      creationKey: "internal-recovery-key-123456",
      title: "Recovered local draft",
      contentJson: { type: "doc" },
      metadataJson: {},
      plainText: "",
      readiness: "draft",
      revision: 0,
      status: "draft",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }]);

    const responseBody = await (await GET()).json();

    expect(responseBody.documents).toHaveLength(1);
    expect(responseBody.documents[0]).not.toHaveProperty("creationKey");
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
