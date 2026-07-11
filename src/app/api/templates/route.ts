import { NextResponse } from "next/server";
import { createPromptTemplate, listPromptTemplates } from "@/features/templates/template-repository";
import { promptTemplatePayloadSchema } from "@/features/templates/template-validation";
import { createProtectedRouteHandler, requireWorkspaceAdministrator } from "@/features/auth/route-context";

const getHandler = createProtectedRouteHandler(async (context) => {
  const templates = await listPromptTemplates(context);
  return NextResponse.json({ templates });
});

const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  requireWorkspaceAdministrator(context);
  const result = promptTemplatePayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const template = await createPromptTemplate(context, result.data);
  return NextResponse.json({ template }, { status: 201 });
});

export async function GET() {
  return getHandler();
}

export async function POST(request: Request) {
  return postHandler(request);
}
