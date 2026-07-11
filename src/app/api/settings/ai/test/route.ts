import { NextResponse } from "next/server";
import { getAiSettings } from "@/features/ai/ai-settings-repository";
import { createAiProvider } from "@/features/ai/providers";
import { createProtectedRouteHandler, requireWorkspaceAdministrator } from "@/features/auth/route-context";

const postHandler = createProtectedRouteHandler(async (context) => {
  requireWorkspaceAdministrator(context);
  try {
    const settings = await getAiSettings(context);
    const provider = createAiProvider(settings);
    await provider.generateText({
      messages: [
        { role: "system", content: "Respond with only OK." },
        { role: "user", content: "Return OK." },
      ],
    });

    return NextResponse.json({ ok: true, provider: provider.name, model: provider.model });
  } catch {
    return NextResponse.json({ ok: false, error: "LLM 설정을 확인해 주세요." }, { status: 400 });
  }
});

export async function POST() {
  return postHandler();
}
