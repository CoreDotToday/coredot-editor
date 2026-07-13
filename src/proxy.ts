import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextMiddleware, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { PUBLIC_API_ROUTES } from "@/features/auth/public-api-routes";
import { assertProductionAuthConfigured } from "@/features/auth/production-auth-config.mjs";

const isPublicPageRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);
const isPublicApiRoute = createRouteMatcher([...PUBLIC_API_ROUTES]);
const isApiRoute = createRouteMatcher(["/api(.*)"]);

export function shouldProtectWithClerk(request: NextRequest) {
  if (isPublicPageRoute(request) || isPublicApiRoute(request)) return false;

  return !isApiRoute(request);
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
