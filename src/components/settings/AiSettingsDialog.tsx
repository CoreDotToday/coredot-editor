"use client";

import { Settings, X } from "lucide-react";
import { useCallback, useState } from "react";

type AiProvider = "stub" | "openai" | "coredot" | "anthropic" | "gemini";
type AiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type AiSettingsForm = {
  aiBaseUrl: string | null;
  aiMaxCompletionTokens: number | null;
  aiModel: string;
  aiProvider: AiProvider;
  aiReasoningEffort: AiReasoningEffort | null;
};

type AiSettingsResponse = {
  settings: AiSettingsForm & { id: string };
  secrets: {
    coredotConfigured: boolean;
    openaiConfigured: boolean;
  };
};

const defaultCoreDotSettings: AiSettingsForm = {
  aiBaseUrl: "https://api.core.today/llm/openai/v1",
  aiMaxCompletionTokens: 32768,
  aiModel: "gpt-5-nano",
  aiProvider: "coredot",
  aiReasoningEffort: null,
};

const providerDefaults: Record<AiProvider, AiSettingsForm> = {
  anthropic: {
    aiBaseUrl: "https://api.core.today/llm/anthropic/v1",
    aiMaxCompletionTokens: 32768,
    aiModel: "claude-sonnet-4.5",
    aiProvider: "anthropic",
    aiReasoningEffort: null,
  },
  coredot: defaultCoreDotSettings,
  gemini: {
    aiBaseUrl: "https://api.core.today/llm/gemini/v1beta",
    aiMaxCompletionTokens: 32768,
    aiModel: "gemini-2.5-flash",
    aiProvider: "gemini",
    aiReasoningEffort: null,
  },
  openai: {
    aiBaseUrl: null,
    aiMaxCompletionTokens: null,
    aiModel: "gpt-4.1-mini",
    aiProvider: "openai",
    aiReasoningEffort: null,
  },
  stub: {
    aiBaseUrl: null,
    aiMaxCompletionTokens: null,
    aiModel: "stub-editor",
    aiProvider: "stub",
    aiReasoningEffort: null,
  },
};

const providerLabels: Record<AiProvider, string> = {
  anthropic: "Anthropic (Core.Today)",
  coredot: "Core.Today",
  gemini: "Gemini (Core.Today)",
  openai: "OpenAI",
  stub: "로컬 Stub",
};

export function AiSettingsDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<AiSettingsForm>(defaultCoreDotSettings);
  const [secrets, setSecrets] = useState<AiSettingsResponse["secrets"] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const providerWarning = secrets ? getProviderWarning(form.aiProvider, secrets) : "";

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage("");
    setStatusMessage("");
    setSecrets(null);

    try {
      const response = await fetch("/api/settings/ai");
      if (!response.ok) {
        throw new Error("Failed to load LLM settings");
      }

      const body = (await response.json()) as AiSettingsResponse;
      setForm(toForm(body.settings));
      setSecrets(body.secrets);
    } catch {
      setErrorMessage("LLM 설정을 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    void loadSettings();
  }, [loadSettings]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setErrorMessage("");
    setStatusMessage("");
  }, []);

  const updateProvider = useCallback((provider: AiProvider) => {
    setForm((currentForm) => {
      if (provider === "stub") {
        return providerDefaults.stub;
      }

      if (provider === "openai") {
        return {
          aiBaseUrl: null,
          aiMaxCompletionTokens: null,
          aiModel: currentForm.aiProvider === "openai" ? currentForm.aiModel : "gpt-4.1-mini",
          aiProvider: provider,
          aiReasoningEffort: currentForm.aiReasoningEffort,
        };
      }

      if (provider === "anthropic" || provider === "gemini") {
        return {
          ...providerDefaults[provider],
          aiBaseUrl:
            currentForm.aiProvider === provider
              ? currentForm.aiBaseUrl ?? providerDefaults[provider].aiBaseUrl
              : providerDefaults[provider].aiBaseUrl,
          aiMaxCompletionTokens:
            currentForm.aiProvider === provider
              ? currentForm.aiMaxCompletionTokens ?? providerDefaults[provider].aiMaxCompletionTokens
              : providerDefaults[provider].aiMaxCompletionTokens,
          aiModel: currentForm.aiProvider === provider ? currentForm.aiModel : providerDefaults[provider].aiModel,
        };
      }

      return {
        aiBaseUrl: currentForm.aiBaseUrl ?? defaultCoreDotSettings.aiBaseUrl,
        aiMaxCompletionTokens: currentForm.aiMaxCompletionTokens ?? defaultCoreDotSettings.aiMaxCompletionTokens,
        aiModel: currentForm.aiProvider === "coredot" ? currentForm.aiModel : defaultCoreDotSettings.aiModel,
        aiProvider: provider,
        aiReasoningEffort: currentForm.aiReasoningEffort,
      };
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

  const saveSettings = useCallback(async () => {
    setIsSaving(true);
    setStatusMessage("");
    setErrorMessage("");

    try {
      const response = await fetch("/api/settings/ai", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toPayload(form)),
      });

      if (!response.ok) {
        throw new Error("Failed to save LLM settings");
      }

      const body = (await response.json()) as AiSettingsResponse;
      setForm(toForm(body.settings));
      setSecrets(body.secrets);
      setStatusMessage("저장되었습니다.");
    } catch {
      setErrorMessage("LLM 설정을 저장하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  }, [form]);

  const testConnection = useCallback(async () => {
    setIsTesting(true);
    setStatusMessage("연결 테스트 중...");
    setErrorMessage("");

    try {
      const response = await fetch("/api/settings/ai/test", { method: "POST" });
      const body = (await response.json().catch(() => null)) as { model?: string; ok?: boolean; provider?: string } | null;
      if (!response.ok || !body?.ok) {
        throw new Error("Failed to test LLM settings");
      }

      setStatusMessage(`연결 테스트 성공: ${body.provider} / ${body.model}`);
    } catch {
      setStatusMessage("");
      setErrorMessage("연결 테스트에 실패했습니다. 서버 API 키와 모델 설정을 확인해 주세요.");
    } finally {
      setIsTesting(false);
    }
  }, []);

  return (
    <>
      <button
        aria-label="LLM 설정"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
        onClick={handleOpen}
        type="button"
      >
        <Settings aria-hidden="true" className="size-4" />
        <span className="hidden 2xl:inline">LLM 설정</span>
      </button>

      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/20 px-4">
          <section
            aria-labelledby="ai-settings-title"
            aria-modal="true"
            className="w-full max-w-xl rounded-lg border border-zinc-200 bg-white shadow-xl"
            role="dialog"
          >
            <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-950" id="ai-settings-title">
                  LLM 설정
                </h2>
                <p className="mt-1 text-sm text-zinc-500">모델과 출력 옵션을 설정합니다.</p>
              </div>
              <button
                aria-label="닫기"
                className="inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
                onClick={handleClose}
                type="button"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </header>

            <div className="space-y-4 px-5 py-5">
              {isLoading ? <p className="text-sm text-zinc-500">설정을 불러오는 중...</p> : null}

              <label className="block">
                <span className="text-sm font-medium text-zinc-700">공급자</span>
                <select
                  aria-label="공급자"
                  className="mt-2 h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-800 outline-none focus:border-zinc-500"
                  onChange={(event) => updateProvider(event.currentTarget.value as AiProvider)}
                  value={form.aiProvider}
                >
                  {Object.entries(providerLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-zinc-700">모델</span>
                <input
                  aria-label="모델"
                  className="mt-2 h-10 w-full rounded-md border border-zinc-300 px-3 text-sm text-zinc-800 outline-none focus:border-zinc-500 disabled:bg-zinc-100 disabled:text-zinc-500"
                  disabled={form.aiProvider === "stub"}
                  list="ai-model-suggestions"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setForm((currentForm) => ({ ...currentForm, aiModel: value }));
                  }}
                  value={form.aiModel}
                />
                <datalist id="ai-model-suggestions">
                  <option value="gpt-5-nano" />
                  <option value="gpt-5-mini" />
                  <option value="gpt-5" />
                  <option value="gpt-5.4-mini" />
                  <option value="gpt-4.1-mini" />
                </datalist>
              </label>

              {usesCoreTodayProxy(form.aiProvider) ? (
                <label className="block">
                  <span className="text-sm font-medium text-zinc-700">Base URL</span>
                  <input
                    aria-label="Base URL"
                    className="mt-2 h-10 w-full rounded-md border border-zinc-300 px-3 text-sm text-zinc-800 outline-none focus:border-zinc-500"
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setForm((currentForm) => ({ ...currentForm, aiBaseUrl: value }));
                    }}
                    value={form.aiBaseUrl ?? ""}
                  />
                </label>
              ) : null}

              {usesCoreTodayProxy(form.aiProvider) ? (
                <label className="block">
                  <span className="text-sm font-medium text-zinc-700">최대 출력 토큰</span>
                  <input
                    aria-label="최대 출력 토큰"
                    className="mt-2 h-10 w-full rounded-md border border-zinc-300 px-3 text-sm text-zinc-800 outline-none focus:border-zinc-500"
                    min={1}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setForm((currentForm) => ({
                        ...currentForm,
                        aiMaxCompletionTokens: value ? Number(value) : null,
                      }));
                    }}
                    type="number"
                    value={form.aiMaxCompletionTokens ?? ""}
                  />
                </label>
              ) : null}

              <label className="block">
                <span className="text-sm font-medium text-zinc-700">추론 강도</span>
                <select
                  aria-label="추론 강도"
                  className="mt-2 h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-800 outline-none focus:border-zinc-500 disabled:bg-zinc-100 disabled:text-zinc-500"
                  disabled={!supportsReasoningEffort(form.aiProvider)}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setForm((currentForm) => ({
                      ...currentForm,
                      aiReasoningEffort: value ? (value as AiReasoningEffort) : null,
                    }));
                  }}
                  value={form.aiReasoningEffort ?? ""}
                >
                  <option value="">기본값</option>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="none">none</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </label>

              <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm leading-6 text-zinc-600">
                <p>Core.Today API 키: {formatSecretStatus(secrets?.coredotConfigured)}</p>
                <p>Anthropic/Gemini: Core.Today API 키를 사용합니다.</p>
                <p>OpenAI API 키: {formatSecretStatus(secrets?.openaiConfigured)}</p>
              </div>

              {providerWarning ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
                  {providerWarning}
                </p>
              ) : null}

              {statusMessage ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700" role="status">
                  {statusMessage}
                </p>
              ) : null}
              {errorMessage ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                  {errorMessage}
                </p>
              ) : null}
            </div>

            <footer className="flex items-center justify-between border-t border-zinc-200 px-5 py-4">
              <button
                className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isTesting || isSaving}
                onClick={testConnection}
                type="button"
              >
                {isTesting ? "테스트 중..." : "연결 테스트"}
              </button>
              <div className="flex items-center gap-2">
                <button
                  className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
                  onClick={handleClose}
                  type="button"
                >
                  취소
                </button>
                <button
                  className="inline-flex h-9 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                  disabled={isSaving || isTesting}
                  onClick={saveSettings}
                  type="button"
                >
                  {isSaving ? "저장 중..." : "저장"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function toForm(settings: AiSettingsResponse["settings"]): AiSettingsForm {
  return {
    aiBaseUrl: settings.aiBaseUrl,
    aiMaxCompletionTokens: settings.aiMaxCompletionTokens,
    aiModel: settings.aiModel,
    aiProvider: settings.aiProvider,
    aiReasoningEffort: settings.aiReasoningEffort,
  };
}

function toPayload(form: AiSettingsForm) {
  if (form.aiProvider === "stub") {
    return {
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "stub-editor",
      aiProvider: "stub" satisfies AiProvider,
      aiReasoningEffort: null,
    };
  }

  if (form.aiProvider === "openai") {
    return {
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: form.aiModel,
      aiProvider: "openai" satisfies AiProvider,
      aiReasoningEffort: form.aiReasoningEffort,
    };
  }

  if (form.aiProvider === "anthropic" || form.aiProvider === "gemini") {
    return {
      aiBaseUrl: form.aiBaseUrl,
      aiMaxCompletionTokens: form.aiMaxCompletionTokens,
      aiModel: form.aiModel,
      aiProvider: form.aiProvider,
      aiReasoningEffort: null,
    };
  }

  return form;
}

function usesCoreTodayProxy(provider: AiProvider) {
  return provider === "coredot" || provider === "anthropic" || provider === "gemini";
}

function supportsReasoningEffort(provider: AiProvider) {
  return provider === "coredot" || provider === "openai";
}

function formatSecretStatus(isConfigured: boolean | undefined) {
  if (isConfigured === undefined) {
    return "확인 중";
  }

  return isConfigured ? "서버에 설정됨" : "서버에 미설정";
}

function getProviderWarning(provider: AiProvider, secrets: AiSettingsResponse["secrets"]) {
  if (provider === "stub") {
    return "로컬 Stub은 실제 LLM을 호출하지 않습니다. 운영 문서에는 Core.Today 또는 OpenAI 공급자를 사용하세요.";
  }

  if (usesCoreTodayProxy(provider) && !secrets.coredotConfigured) {
    return "Core.Today API 키가 서버에 없어 이 공급자는 실제 요청을 처리할 수 없습니다.";
  }

  if (provider === "openai" && !secrets.openaiConfigured) {
    return "OpenAI API 키가 서버에 없어 이 공급자는 실제 요청을 처리할 수 없습니다.";
  }

  return "";
}
