import type { RequestContext } from "./request-context";

const DEFAULT_TEST_PRINCIPAL_ID = "test:principal:local";
const DEFAULT_TEST_WORKSPACE_ID = "test:workspace:local";

export function createTestRequestContext(
  env: NodeJS.ProcessEnv = process.env,
): RequestContext {
  return {
    authMode: "test",
    principalId: env.TEST_PRINCIPAL_ID || DEFAULT_TEST_PRINCIPAL_ID,
    requestId: crypto.randomUUID(),
    role: "owner",
    workspaceId: env.TEST_WORKSPACE_ID || DEFAULT_TEST_WORKSPACE_ID,
  };
}
