import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";
import { setProtectedRequestContextDependenciesForTests } from "@/features/auth/route-context";
import { REQUEST_BUDGET_POLICIES, setRequestBudgetForTests } from "@/features/security/request-budget";
import { TEST_REQUEST_CONTEXT } from "./auth-context";

beforeEach(() => {
  setProtectedRequestContextDependenciesForTests({
    ensureWorkspaceBootstrap: async () => undefined,
    getRequestContext: async () => TEST_REQUEST_CONTEXT,
  });
  setRequestBudgetForTests({
    consume: async ({ policyId }) => ({
      allowed: true,
      limit: REQUEST_BUDGET_POLICIES[policyId].limit,
      remaining: REQUEST_BUDGET_POLICIES[policyId].limit - 1,
      retryAt: new Date(Date.now() + REQUEST_BUDGET_POLICIES[policyId].windowMs),
    }),
  });
});
