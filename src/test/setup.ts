import "@testing-library/jest-dom/vitest";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { TEST_REQUEST_CONTEXT } from "./auth-context";

setProtectedRequestContextDependenciesForTests({
  ensureWorkspaceBootstrap: async () => undefined,
  getRequestContext: async () => TEST_REQUEST_CONTEXT,
});
