import { NextResponse } from "next/server";
import { z } from "zod";
import { createDocumentDraft, listDocuments } from "@/features/documents/document-repository";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";

const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(500).default("Untitled document"),
});

const optionsHandler = createProtectedOptionsHandler(["GET", "POST"]);
const getHandler = createProtectedRouteHandler(async (context) => {
  const documents = await listDocuments(context);
  return NextResponse.json({ documents });
});

const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  const budgetResponse = await enforceRequestBudget(context, "documents.create");
  if (budgetResponse) return budgetResponse;

  const result = createDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const body = result.data;
  const document = await createDocumentDraft(context, body.title);
  return NextResponse.json({ document }, { status: 201 });
});

export async function GET() {
  return getHandler();
}

export async function POST(request: Request) {
  return postHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}
