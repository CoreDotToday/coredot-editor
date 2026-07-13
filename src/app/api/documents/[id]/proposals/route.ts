import { NextResponse } from "next/server";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { InvalidCollectionCursorError } from "@/features/pagination/collection-cursor";
import { listProposalSummariesPage } from "@/features/proposals/proposal-repository";

type RouteContext = { params: Promise<{ id: string }> };

const optionsHandler = createProtectedOptionsHandler(["GET"]);
const getHandler = createProtectedRouteHandler(async (scope, request: Request, context: RouteContext) => {
  const { id } = await context.params;
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return NextResponse.json({ error: "Invalid collection query" }, { status: 400 });
  }
  try {
    const page = await listProposalSummariesPage(scope, id, {
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit,
    });
    return NextResponse.json({ proposals: page.items, nextCursor: page.nextCursor });
  } catch (error) {
    if (error instanceof InvalidCollectionCursorError) {
      return NextResponse.json({ error: "Invalid collection cursor" }, { status: 400 });
    }
    throw error;
  }
});

export async function GET(request: Request, context: RouteContext) {
  return getHandler(request, context);
}

export async function OPTIONS() {
  return optionsHandler();
}
