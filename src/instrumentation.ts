import { assertProductionAuthConfigured } from "@/features/auth/production-auth-config.mjs";

export function register(): void {
  assertProductionAuthConfigured(process.env);
}
