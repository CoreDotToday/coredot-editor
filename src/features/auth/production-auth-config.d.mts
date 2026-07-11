export const CLERK_NOT_CONFIGURED_ERROR: string;
export const TEST_AUTH_IN_PRODUCTION_ERROR: string;

export function assertProductionAuthConfigured(env: NodeJS.ProcessEnv): void;
