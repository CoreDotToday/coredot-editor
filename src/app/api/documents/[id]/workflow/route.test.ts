import { beforeEach, describe, expect, it, vi } from "vitest";

import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import {
  DocumentWorkflowServiceError,
  executeDocumentWorkflowCommand,
  readDocumentWorkflowState,
} from "@/features/documents/document-workflow-service";
import { enforceRequestBudget } from "@/features/security/request-budget";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";

import { GET, OPTIONS, POST, runtime } from "./route";

vi.mock("@/features/documents/document-workflow-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/features/documents/document-workflow-service")>();
  return {
    ...original,
    executeDocumentWorkflowCommand: vi.fn(),
    readDocumentWorkflowState: vi.fn(),
  };
});
vi.mock("@/features/security/request-budget", () => ({
  enforceRequestBudget: vi.fn(async () => null),
}));

const workflow = {
  collaboration: { generation: 3, headSeq: 9 },
  documentId: "document-a",
  readiness: "ready" as const,
  revision: 4,
};

describe("/api/documents/[id]/workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("reads an uncached authoritative workflow state through protected context", async () => {
    vi.mocked(readDocumentWorkflowState).mockResolvedValueOnce(workflow);

    const response = await GET(
      new Request("http://localhost/api/documents/document-a/workflow"),
      { params: Promise.resolve({ id: "document-a" }) },
    );

    expect(runtime).toBe("nodejs");
    expect(readDocumentWorkflowState).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "document-a");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ workflow });
  });

  it("uses a separate bounded write budget before Workspace bootstrap", async () => {
    const order: string[] = [];
    vi.mocked(enforceRequestBudget).mockImplementationOnce(async () => {
      order.push("budget");
      return null;
    });
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => { order.push("bootstrap"); },
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
    vi.mocked(executeDocumentWorkflowCommand).mockResolvedValueOnce({
      workflow: { ...workflow, readiness: "approved", revision: 5 },
    });

    const response = await POST(jsonRequest({
      expectedReadiness: "ready",
      nextReadiness: "approved",
      observedHeadSeq: 9,
    }), { params: Promise.resolve({ id: "document-a" }) });

    expect(order).toEqual(["budget", "bootstrap"]);
    expect(enforceRequestBudget).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "documents.workflow");
    expect(executeDocumentWorkflowCommand).toHaveBeenCalledWith(
      TEST_REQUEST_CONTEXT,
      "document-a",
      { expectedReadiness: "ready", nextReadiness: "approved", observedHeadSeq: 9 },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    [{ expectedReadiness: "ready", nextReadiness: "approved" }],
    [{ expectedReadiness: "ready", nextReadiness: "approved", observedHeadSeq: -1 }],
    [{ expectedReadiness: "draft", nextReadiness: "approved", observedHeadSeq: 0 }],
    [{ expectedReadiness: "draft", nextReadiness: "needs_review", extra: "leak" }],
    [{ expectedReadiness: "approved", nextReadiness: "approved", observedHeadSeq: 0 }],
  ])("strictly rejects malformed or over-posted commands", async (body) => {
    const response = await POST(jsonRequest(body), {
      params: Promise.resolve({ id: "document-a" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid document workflow request",
      reason: "invalid_request",
    });
    expect(executeDocumentWorkflowCommand).not.toHaveBeenCalled();
  });

  it("rejects oversized workflow bodies before parsing", async () => {
    const json = vi.fn();
    const request = {
      body: {},
      headers: new Headers({ "content-length": "2049" }),
      json,
      signal: new AbortController().signal,
    } as unknown as Request;

    const response = await POST(request, { params: Promise.resolve({ id: "document-a" }) });

    expect(response.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(executeDocumentWorkflowCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["expected_readiness_conflict", 409, "expected_readiness_conflict"],
    ["head_conflict", 409, "head_conflict"],
    ["legacy_approval_unsupported", 409, "legacy_approval_unsupported"],
    ["forbidden", 403, "forbidden"],
    ["not_found", 404, "not_found"],
    ["unavailable", 503, "unavailable"],
  ] as const)("maps %s to a bounded public response", async (category, status, reason) => {
    vi.mocked(executeDocumentWorkflowCommand).mockRejectedValueOnce(
      new DocumentWorkflowServiceError(category, category.includes("conflict") ? workflow : undefined),
    );

    const response = await POST(jsonRequest({
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    }), { params: Promise.resolve({ id: "document-a" }) });
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.reason).toBe(reason);
    expect(JSON.stringify(body)).not.toMatch(/stateVector|contentHash|token|principal/iu);
    if (category.includes("conflict")) expect(body.workflow).toEqual(workflow);
    if (status === 503) expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("returns a bounded Project Profile violation without document content", async () => {
    vi.mocked(executeDocumentWorkflowCommand).mockRejectedValueOnce(
      new DocumentWorkflowServiceError(
        "invalid_project_profile",
        workflow,
        { fieldId: "owner", ok: false, reason: "required" },
      ),
    );

    const response = await POST(jsonRequest({
      expectedReadiness: "draft",
      nextReadiness: "needs_review",
    }), { params: Promise.resolve({ id: "document-a" }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Document violates active Project Profile",
      reason: "invalid_project_profile",
      violation: { fieldId: "owner", ok: false, reason: "required" },
      workflow,
    });
  });

  it("advertises GET and POST without spending write budget on OPTIONS", async () => {
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, POST, OPTIONS");
    expect(enforceRequestBudget).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/documents/document-a/workflow", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}
