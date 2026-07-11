import { auth } from "@clerk/nextjs/server";

import type { ClerkIdentity } from "./request-context";

export async function readClerkIdentity(): Promise<ClerkIdentity> {
  const { orgId, orgRole, userId } = await auth();

  return {
    orgId,
    orgRole,
    userId,
  };
}
