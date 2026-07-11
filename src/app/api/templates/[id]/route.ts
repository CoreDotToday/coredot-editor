import { NextResponse } from "next/server";
import { archivePromptTemplate, updatePromptTemplate } from "@/features/templates/template-repository";
import { promptTemplateUpdatePayloadSchema } from "@/features/templates/template-validation";
import { createProtectedRouteHandler, requireWorkspaceAdministrator } from "@/features/auth/route-context";

type Params = {
  params: Promise<{ id: string }>;
};

const putHandler = createProtectedRouteHandler(async (context, request: Request, { params }: Params) => {
  requireWorkspaceAdministrator(context);
  const { id } = await params;
  const result = promptTemplateUpdatePayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const template = await updatePromptTemplate(context, id, result.data);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  return NextResponse.json({ template });
});

const deleteHandler = createProtectedRouteHandler(async (context, _request: Request, { params }: Params) => {
  requireWorkspaceAdministrator(context);
  const { id } = await params;
  const template = await archivePromptTemplate(context, id);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  return NextResponse.json({ template });
});

export async function PUT(request: Request, params: Params) {
  return putHandler(request, params);
}

export async function DELETE(request: Request, params: Params) {
  return deleteHandler(request, params);
}
