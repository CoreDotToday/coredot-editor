import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptTemplate, listPromptTemplates } from "@/features/templates/template-repository";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { GET, POST } from "./route";

vi.mock("@/features/templates/template-repository", () => ({
  createPromptTemplate: vi.fn(async (input) => ({
    id: "tpl_created",
    ...input,
    isDefault: false,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })),
  listPromptTemplates: vi.fn(),
}));

const validBody = {
  name: "Strategy Review",
  description: "Review strategy",
  category: "strategy_review",
  systemPrompt: "You are a strategy editor.",
  variableSchemaJson: {
    fields: [{ name: "audience", label: "Audience", type: "text", required: true }],
    required: ["audience"],
  },
};

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function useRequestContext(context = TEST_REQUEST_CONTEXT) {
  setProtectedRequestContextDependenciesForTests({
    ensureWorkspaceBootstrap: async () => undefined,
    getRequestContext: async () => context,
  });
}

describe("POST /api/templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRequestContext();
  });

  it("returns 400 for an invalid variable schema", async () => {
    const response = await POST(
      createJsonRequest({
        ...validBody,
        variableSchemaJson: {
          fields: [{ name: "tone", label: "Tone", type: "select", required: false }],
          required: ["missing"],
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(createPromptTemplate).not.toHaveBeenCalled();
  });

  it("allows members to read templates but forbids template creation before parsing", async () => {
    const memberContext = { ...TEST_REQUEST_CONTEXT, principalId: "member-a", role: "member" as const };
    useRequestContext(memberContext);

    const readResponse = await GET();
    const createResponse = await POST(new Request("http://localhost/api/templates", { body: "{", method: "POST" }));

    expect(readResponse.status).toBe(200);
    expect(listPromptTemplates).toHaveBeenCalledWith(memberContext);
    expect(createResponse.status).toBe(403);
    expect(await createResponse.json()).toEqual({ error: "Forbidden" });
    expect(createPromptTemplate).not.toHaveBeenCalled();
  });

  it("passes a second principal's workspace to template creation", async () => {
    const workspaceBContext = {
      ...TEST_REQUEST_CONTEXT,
      principalId: "principal-b",
      requestId: "request-b",
      workspaceId: "workspace-b",
    };
    useRequestContext(workspaceBContext);

    const response = await POST(createJsonRequest(validBody));

    expect(response.status).toBe(201);
    expect(createPromptTemplate).toHaveBeenCalledWith(workspaceBContext, validBody);
  });
});
