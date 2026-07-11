import { NextResponse } from "next/server";
import { getAiSettings } from "@/features/ai/ai-settings-repository";

const localWorkspace = { workspaceId: "local" };
import { createAiProvider } from "@/features/ai/providers";

export async function POST() {
  try {
    const settings = await getAiSettings(localWorkspace);
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
}
