import { NextResponse } from "next/server";
import { z } from "zod";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { listDocumentChanges } from "@/features/documents/document-change-service";

const listDocumentChangesQuerySchema = z.object({
  documentId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

const optionsHandler = createProtectedOptionsHandler(["GET"]);
const getHandler = createProtectedRouteHandler(async (context, request: Request) => {
  const url = new URL(request.url);
  const result = listDocumentChangesQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }

  return NextResponse.json(await listDocumentChanges(context, result.data));
});

export async function GET(request: Request) {
  return getHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}
