import { NextResponse } from "next/server";
import { aiSettingsPayloadSchema, getAiSettings, updateAiSettings } from "@/features/ai/ai-settings-repository";
import {
  createProtectedOptionsHandler,
  createProtectedRouteHandler,
  requireWorkspaceAdministrator,
} from "@/features/auth/route-context";

const optionsHandler = createProtectedOptionsHandler(["GET", "PUT"]);
const getHandler = createProtectedRouteHandler(async (context) => {
  const settings = await getAiSettings(context);
  return NextResponse.json({ settings, secrets: getSecretStatus() });
});

const putHandler = createProtectedRouteHandler(async (context, request: Request) => {
  requireWorkspaceAdministrator(context);
  const result = aiSettingsPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const settings = await updateAiSettings(context, result.data);
    return NextResponse.json({ settings, secrets: getSecretStatus() });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
});

export async function GET() {
  return getHandler();
}

export async function PUT(request: Request) {
  return putHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}

function getSecretStatus() {
  return {
    coredotConfigured: Boolean(process.env.COREDOT_API_KEY),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  };
}
