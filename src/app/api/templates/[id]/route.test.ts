import { afterEach, describe, expect, it, vi } from "vitest";
import { archivePromptTemplate, updatePromptTemplate } from "@/features/templates/template-repository";
import { TEST_REQUEST_CONTEXT } from "@/test/auth-context";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { DELETE, PUT } from "./route";

vi.mock("@/features/templates/template-repository", () => ({
  archivePromptTemplate: vi.fn(async (scope, id) => ({
    id,
    workspaceId: scope.workspaceId,
    name: "Strategy Review",
    description: "Review strategy",
    category: "strategy_review",
    systemPrompt: "You are a strategy editor.",
    variableSchemaJson: { fields: [], required: [] },
    isDefault: true,
    isActive: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  })),
  updatePromptTemplate: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  setProtectedRequestContextDependenciesForTests({
    ensureWorkspaceBootstrap: async () => undefined,
    getRequestContext: async () => TEST_REQUEST_CONTEXT,
  });
});

const validUpdateBody = {
  name: "Strategy Review",
  description: "Review strategy",
  category: "strategy_review",
  systemPrompt: "You are a strategy editor.",
  variableSchemaJson: {
    fields: [{ name: "audience", label: "Audience", type: "text", required: true }],
    required: ["audience"],
  },
  isActive: true,
};

function createJsonRequest(body: unknown) {
  return new Request("http://localhost/api/templates/tpl_1", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "tpl_1" }) };

describe("PUT /api/templates/[id]", () => {
  it("returns 400 for an invalid variable schema", async () => {
    const response = await PUT(
      createJsonRequest({
        ...validUpdateBody,
        variableSchemaJson: {
          fields: [
            { name: "audience", label: "Audience", type: "text", required: true },
            { name: "audience", label: "Audience duplicate", type: "textarea", required: false },
          ],
          required: ["audience"],
        },
      }),
      params,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(updatePromptTemplate).not.toHaveBeenCalled();
  });

  it("returns 404 when updating an archived or missing template", async () => {
    vi.mocked(updatePromptTemplate).mockResolvedValueOnce(null as never);

    const response = await PUT(createJsonRequest(validUpdateBody), params);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Template not found" });
  });

  it("returns 404 when updating another workspace's template id", async () => {
    const workspaceBContext = {
      ...TEST_REQUEST_CONTEXT,
      principalId: "principal-b",
      requestId: "request-b",
      workspaceId: "workspace-b",
    };
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => workspaceBContext,
    });
    vi.mocked(updatePromptTemplate).mockResolvedValueOnce(null as never);

    const response = await PUT(createJsonRequest(validUpdateBody), params);

    expect(response.status).toBe(404);
    expect(updatePromptTemplate).toHaveBeenCalledWith(workspaceBContext, "tpl_1", validUpdateBody);
  });
});

describe("DELETE /api/templates/[id]", () => {
  it("returns 404 when archiving an already archived or missing template", async () => {
    vi.mocked(archivePromptTemplate).mockResolvedValueOnce(null as never);

    const response = await DELETE(new Request("http://localhost/api/templates/tpl_1", { method: "DELETE" }), params);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Template not found" });
  });

  it("archives a template instead of deleting the record", async () => {
    const response = await DELETE(new Request("http://localhost/api/templates/tpl_1", { method: "DELETE" }), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ template: { id: "tpl_1", isActive: false } });
    expect(archivePromptTemplate).toHaveBeenCalledWith(TEST_REQUEST_CONTEXT, "tpl_1");
  });

  it("forbids members from updating or archiving templates", async () => {
    setProtectedRequestContextDependenciesForTests({
      ensureWorkspaceBootstrap: async () => undefined,
      getRequestContext: async () => ({ ...TEST_REQUEST_CONTEXT, role: "member" }),
    });

    const updateResponse = await PUT(createJsonRequest(validUpdateBody), params);
    const archiveResponse = await DELETE(
      new Request("http://localhost/api/templates/tpl_1", { method: "DELETE" }),
      params,
    );

    expect(updateResponse.status).toBe(403);
    expect(archiveResponse.status).toBe(403);
    expect(updatePromptTemplate).not.toHaveBeenCalled();
    expect(archivePromptTemplate).not.toHaveBeenCalled();
  });
});
