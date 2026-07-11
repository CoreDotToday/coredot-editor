import { assertProductionAuthConfigured } from "@/features/auth/production-auth-config";

export function register(): void {
  assertProductionAuthConfigured(process.env);
}
