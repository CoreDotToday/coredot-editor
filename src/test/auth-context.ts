import type { RequestContext } from "@/features/auth/request-context";

export const TEST_REQUEST_CONTEXT: RequestContext = {
  authMode: "test",
  principalId: "vitest-principal",
  requestId: "vitest-request",
  role: "owner",
  workspaceId: "vitest-workspace",
};
