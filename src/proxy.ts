import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextMiddleware, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assertProductionAuthConfigured } from "@/features/auth/production-auth-config.mjs";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);
const isApiRoute = createRouteMatcher(["/api(.*)"]);

export function shouldProtectWithClerk(request: NextRequest) {
  return !isPublicRoute(request) && !isApiRoute(request);
}

const clerkProxy = clerkMiddleware(async (auth, request) => {
  if (shouldProtectWithClerk(request)) {
    await auth.protect();
  }
});

const testProxy: NextMiddleware = () => {
  assertProductionAuthConfigured(process.env);

  return NextResponse.next();
};

export default process.env.AUTH_MODE === "test" ? testProxy : clerkProxy;

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
