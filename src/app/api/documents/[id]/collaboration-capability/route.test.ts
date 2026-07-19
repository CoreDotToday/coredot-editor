import { beforeEach, describe, expect, it, vi } from "vitest";

import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import {
  CollaborationCapabilityServiceError,
  issueCollaborationCapabilityForDocument,
} from "@/features/collaboration/capability-service";
import { enforceRequestBudget } from "@/features/security/request-budget";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { OPTIONS, POST, runtime } from "./route";

vi.mock("@/features/collaboration/capability-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/features/collaboration/capability-service")>();
  return { ...original, issueCollaborationCapabilityForDocument: vi.fn() };
});
vi.mock("@/features/security/request-budget", () => ({
  enforceRequestBudget: vi.fn(async () => null),
}));

function request(body?: unknown) {
  return new Request("http://localhost/api/documents/document-a/collaboration-capability", {
    ...(body === undefined ? {} : {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    method: "POST",
  });
}

describe("POST /api/documents/[id]/collaboration-capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
  });

  it("uses the Node runtime, protected request context, and rate budget to issue a capability", async () => {
    const order: string[] = [];
    vi.mocked(enforceRequestBudget).mockImplementationOnce(async () => {
      order.push("budget");
      return null;
    });
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => {
        order.push("bootstrap");
      },
      getRequestContext: async () => TEST_REQUEST_CONTEXT,
    });
    vi.mocked(issueCollaborationCapabilityForDocument).mockResolvedValueOnce({
      expiresInSeconds: 60,
      room: "collab:v1:vitest-workspace:document-a:g1",
      token: "signed-token",
    });

    const response = await POST(request(), {
      params: Promise.resolve({ id: "document-a" }),
    });

    expect(runtime).toBe("nodejs");
    expect(enforceRequestBudget).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "collaboration.capability");
    expect(order).toEqual(["budget", "bootstrap"]);
    expect(issueCollaborationCapabilityForDocument).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, {
      documentId: "document-a",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      expiresInSeconds: 60,
      room: "collab:v1:vitest-workspace:document-a:g1",
      token: "signed-token",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns the standard protected OPTIONS response", async () => {
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
    expect(enforceRequestBudget).not.toHaveBeenCalled();
  });

  it("rejects client-supplied session identity because session ids are server-issued", async () => {
    const body = { sessionId: "client-controlled-session" };
    const response = await POST(request(body), { params: Promise.resolve({ id: "document-a" }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid collaboration capability request" });
    expect(issueCollaborationCapabilityForDocument).not.toHaveBeenCalled();
  });

  it("returns 404 without revealing archived or cross-Workspace document state", async () => {
    vi.mocked(issueCollaborationCapabilityForDocument).mockRejectedValueOnce(
      new CollaborationCapabilityServiceError("not_found"),
    );

    const response = await POST(request(), {
      params: Promise.resolve({ id: "known-other-workspace-document" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Document not found" });
  });

  it("fails closed with a bounded 503 when signing configuration or storage is unavailable", async () => {
    vi.mocked(issueCollaborationCapabilityForDocument).mockRejectedValueOnce(
      new CollaborationCapabilityServiceError("unavailable"),
    );

    const response = await POST(request(), {
      params: Promise.resolve({ id: "document-a" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Collaboration capability unavailable" });
    expect(response.headers.get("Retry-After")).toBe("1");
  });
});
