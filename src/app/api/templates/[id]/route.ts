import { NextResponse } from "next/server";
import { z } from "zod";
import { updatePromptTemplate } from "@/features/templates/template-repository";

const variableFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "textarea", "select"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  systemPrompt: z.string().min(1),
  variableSchemaJson: z.object({
    fields: z.array(variableFieldSchema),
    required: z.array(z.string()),
  }),
  isActive: z.boolean(),
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const result = updateTemplateSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const template = await updatePromptTemplate(id, result.data);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  return NextResponse.json({ template });
}
