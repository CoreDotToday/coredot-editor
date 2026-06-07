import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSettingsDialog } from "./AiSettingsDialog";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSettingsFetch(
  testResponse?: Promise<Response>,
  overrides: {
    secrets?: Partial<{ coredotConfigured: boolean; openaiConfigured: boolean }>;
    settings?: Partial<{
      aiBaseUrl: string | null;
      aiMaxCompletionTokens: number | null;
      aiModel: string;
      aiProvider: "stub" | "openai" | "coredot" | "anthropic" | "gemini";
      aiReasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
      id: string;
    }>;
  } = {},
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input.toString();

    if (url === "/api/settings/ai" && !init) {
      const settings = {
        aiBaseUrl: "https://api.core.today/llm/openai/v1",
        aiMaxCompletionTokens: 32768,
        aiModel: "gpt-5-nano",
        aiProvider: "coredot",
        aiReasoningEffort: null,
        id: "default",
        ...overrides.settings,
      };
      const secrets = {
        coredotConfigured: true,
        openaiConfigured: false,
        ...overrides.secrets,
      };
      return new Response(
        JSON.stringify({
          settings,
          secrets,
        }),
      );
    }

    if (url === "/api/settings/ai" && init?.method === "PUT") {
      return new Response(
        JSON.stringify({
          settings: JSON.parse(init.body?.toString() ?? "{}"),
          secrets: {
            coredotConfigured: true,
            openaiConfigured: false,
          },
        }),
      );
    }

    if (url === "/api/settings/ai/test") {
      if (testResponse) {
        return testResponse;
      }
      return new Response(JSON.stringify({ ok: true, model: "gpt-5-mini", provider: "coredot" }));
    }

    throw new Error(`Unexpected request: ${url}`);
  });
}

function createDeferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolver) => {
    resolve = resolver;
  });

  return { promise, resolve };
}

describe("AiSettingsDialog", () => {
  it("opens Korean LLM settings without exposing API key inputs", async () => {
    const user = userEvent.setup();
    mockSettingsFetch();

    render(<AiSettingsDialog />);

    await user.click(screen.getByRole("button", { name: "LLM 설정" }));

    expect(await screen.findByRole("dialog", { name: "LLM 설정" })).toBeInTheDocument();
    expect(screen.getByLabelText("공급자")).toHaveValue("coredot");
    expect(screen.getByRole("option", { name: "Anthropic (Core.Today)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Gemini (Core.Today)" })).toBeInTheDocument();
    expect(screen.getByLabelText("모델")).toHaveValue("gpt-5-nano");
    expect(screen.getByText("Core.Today API 키: 서버에 설정됨")).toBeInTheDocument();
    expect(screen.queryByLabelText("API 키")).not.toBeInTheDocument();
  });

  it("switches to Anthropic and Gemini defaults from the provider selector", async () => {
    const user = userEvent.setup();
    mockSettingsFetch();

    render(<AiSettingsDialog />);

    await user.click(screen.getByRole("button", { name: "LLM 설정" }));
    await user.selectOptions(await screen.findByLabelText("공급자"), "anthropic");

    expect(screen.getByLabelText("모델")).toHaveValue("claude-sonnet-4.5");
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.core.today/llm/anthropic/v1");
    expect(screen.getByLabelText("추론 강도")).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("공급자"), "gemini");

    expect(screen.getByLabelText("모델")).toHaveValue("gemini-2.5-flash");
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.core.today/llm/gemini/v1beta");
  });

  it("saves model settings without sending browser-side secrets", async () => {
    const user = userEvent.setup();
    const fetchMock = mockSettingsFetch();

    render(<AiSettingsDialog />);

    await user.click(screen.getByRole("button", { name: "LLM 설정" }));
    await user.clear(await screen.findByLabelText("모델"));
    await user.type(screen.getByLabelText("모델"), "gpt-5-mini");
    await user.selectOptions(screen.getByLabelText("추론 강도"), "medium");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/ai",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"aiModel":"gpt-5-mini"'),
        }),
      );
    });
    const saveCall = fetchMock.mock.calls.find((call) => call[0] === "/api/settings/ai" && call[1]?.method === "PUT");
    expect(saveCall?.[1]?.body?.toString()).not.toContain("apiKey");
  });

  it("shows immediate feedback while testing the configured provider", async () => {
    const user = userEvent.setup();
    const deferredTest = createDeferredResponse();
    mockSettingsFetch(deferredTest.promise);

    render(<AiSettingsDialog />);

    await user.click(screen.getByRole("button", { name: "LLM 설정" }));
    await user.click(await screen.findByRole("button", { name: "연결 테스트" }));

    expect(await screen.findByText("연결 테스트 중...")).toBeInTheDocument();
    deferredTest.resolve(new Response(JSON.stringify({ ok: true, model: "gpt-5-mini", provider: "coredot" })));
    expect(await screen.findByText("연결 테스트 성공: coredot / gpt-5-mini")).toBeInTheDocument();
  });

  it("warns clearly when local Stub mode is selected", async () => {
    const user = userEvent.setup();
    mockSettingsFetch(undefined, {
      settings: {
        aiBaseUrl: null,
        aiMaxCompletionTokens: null,
        aiModel: "stub-editor",
        aiProvider: "stub",
        aiReasoningEffort: null,
      },
    });

    render(<AiSettingsDialog />);

    await user.click(screen.getByRole("button", { name: "LLM 설정" }));

    expect(
      await screen.findByText("로컬 Stub은 실제 LLM을 호출하지 않습니다. 운영 문서에는 Core.Today 또는 OpenAI 공급자를 사용하세요."),
    ).toBeInTheDocument();
  });

  it("does not show provider warnings before server secrets load", async () => {
    const user = userEvent.setup();
    const deferredSettings = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();
      if (url === "/api/settings/ai") {
        return deferredSettings.promise;
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    render(<AiSettingsDialog />);

    await user.click(screen.getByRole("button", { name: "LLM 설정" }));

    expect(await screen.findByRole("dialog", { name: "LLM 설정" })).toBeInTheDocument();
    expect(screen.getByText("Core.Today API 키: 확인 중")).toBeInTheDocument();
    expect(screen.queryByText("Core.Today API 키가 서버에 없어 이 공급자는 실제 요청을 처리할 수 없습니다.")).not.toBeInTheDocument();
  });

  it("warns when the selected Core.Today provider does not have a server API key", async () => {
    const user = userEvent.setup();
    mockSettingsFetch(undefined, {
      secrets: {
        coredotConfigured: false,
      },
    });

    render(<AiSettingsDialog />);

    await user.click(screen.getByRole("button", { name: "LLM 설정" }));

    expect(
      await screen.findByText("Core.Today API 키가 서버에 없어 이 공급자는 실제 요청을 처리할 수 없습니다."),
    ).toBeInTheDocument();
  });
});
