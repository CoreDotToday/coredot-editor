"use client";

import { Settings, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  AI_PROVIDER_CATALOG,
  AI_REASONING_EFFORTS,
  getAiProviderDefinition,
  isAiProviderSettingEditable,
  type AiProviderName,
  type AiReasoningEffort,
} from "@/features/ai/provider-catalog";
import {
  DEFAULT_EDITOR_LANGUAGE,
  editorMessages,
  type EditorLanguage,
} from "@/features/i18n/editor-language";
import { PluginRenderedContribution } from "@/plugins/PluginRenderedContribution";
import type { EditorSettingsSection } from "@/plugins/types";

type AiSettingsForm = {
  aiBaseUrl: string | null;
  aiMaxCompletionTokens: number | null;
  aiModel: string;
  aiProvider: AiProviderName;
  aiReasoningEffort: AiReasoningEffort | null;
};

type AiSettingsResponse = {
  settings: AiSettingsForm & { id: string };
  secrets: {
    coredotConfigured: boolean;
    openaiConfigured: boolean;
  };
};

const defaultCoreDotSettings = createProviderDefaults("coredot");

type AiSettingsDialogProps = {
  language?: EditorLanguage;
  pluginSections?: EditorSettingsSection[];
};

export function AiSettingsDialog({
  language = DEFAULT_EDITOR_LANGUAGE,
  pluginSections = [],
}: AiSettingsDialogProps = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<AiSettingsForm>(defaultCoreDotSettings);
  const [secrets, setSecrets] = useState<AiSettingsResponse["secrets"] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const providerWarning = secrets ? getProviderWarning(form.aiProvider, secrets) : "";
  const pluginContext = useMemo(
    () => ({ language, messages: editorMessages[language] }),
    [language],
  );

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

  const updateProvider = useCallback((provider: AiProviderName) => {
    setForm((currentForm) => {
      const defaults = createProviderDefaults(provider);
      const isCurrentProvider = currentForm.aiProvider === provider;
      return {
        aiBaseUrl: isAiProviderSettingEditable(provider, "baseUrl")
          ? isCurrentProvider
            ? currentForm.aiBaseUrl ?? defaults.aiBaseUrl
            : defaults.aiBaseUrl
          : null,
        aiMaxCompletionTokens: isAiProviderSettingEditable(provider, "maxCompletionTokens")
          ? isCurrentProvider
            ? currentForm.aiMaxCompletionTokens ?? defaults.aiMaxCompletionTokens
            : defaults.aiMaxCompletionTokens
          : null,
        aiModel: isAiProviderSettingEditable(provider, "model")
          ? isCurrentProvider
            ? currentForm.aiModel
            : defaults.aiModel
          : defaults.aiModel,
        aiProvider: provider,
        aiReasoningEffort: isAiProviderSettingEditable(provider, "reasoningEffort")
          ? currentForm.aiReasoningEffort
          : null,
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
                  onChange={(event) => updateProvider(event.currentTarget.value as AiProviderName)}
                  value={form.aiProvider}
                >
                  {AI_PROVIDER_CATALOG.map((definition) => (
                    <option key={definition.id} value={definition.id}>
                      {definition.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-zinc-700">모델</span>
                <input
                  aria-label="모델"
                  className="mt-2 h-10 w-full rounded-md border border-zinc-300 px-3 text-sm text-zinc-800 outline-none focus:border-zinc-500 disabled:bg-zinc-100 disabled:text-zinc-500"
                  disabled={!isAiProviderSettingEditable(form.aiProvider, "model")}
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

              {isAiProviderSettingEditable(form.aiProvider, "baseUrl") ? (
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

              {isAiProviderSettingEditable(form.aiProvider, "maxCompletionTokens") ? (
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
                  disabled={!isAiProviderSettingEditable(form.aiProvider, "reasoningEffort")}
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
                  {AI_REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>

              <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm leading-6 text-zinc-600">
                <p>Core.Today API 키: {formatSecretStatus(secrets?.coredotConfigured)}</p>
                <p>Anthropic/Gemini: Core.Today API 키를 사용합니다.</p>
                <p>OpenAI API 키: {formatSecretStatus(secrets?.openaiConfigured)}</p>
              </div>

              {pluginSections.map((section) => (
                <section
                  aria-label={section.label}
                  className="rounded-md border border-zinc-200 px-3 py-3"
                  key={section.id}
                  role="group"
                >
                  <h3 className="text-sm font-semibold text-zinc-900">{section.label}</h3>
                  <div className="mt-2 text-sm text-zinc-700">
                    <PluginSettingsSectionContribution context={pluginContext} section={section} />
                  </div>
                </section>
              ))}

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

function PluginSettingsSectionContribution({
  context,
  section,
}: {
  context: Parameters<EditorSettingsSection["render"]>[0];
  section: EditorSettingsSection;
}) {
  const render = useCallback(() => section.render(context), [context, section]);

  return (
    <PluginRenderedContribution
      contributionId={section.id}
      contributionType="settingsSection"
      render={render}
    />
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
  const definition = getAiProviderDefinition(form.aiProvider);
  return {
    aiBaseUrl: isAiProviderSettingEditable(form.aiProvider, "baseUrl") ? form.aiBaseUrl : null,
    aiMaxCompletionTokens: isAiProviderSettingEditable(form.aiProvider, "maxCompletionTokens")
      ? form.aiMaxCompletionTokens
      : null,
    aiModel: isAiProviderSettingEditable(form.aiProvider, "model") ? form.aiModel : definition.defaultModel,
    aiProvider: form.aiProvider,
    aiReasoningEffort: isAiProviderSettingEditable(form.aiProvider, "reasoningEffort")
      ? form.aiReasoningEffort
      : null,
  };
}

function createProviderDefaults(provider: AiProviderName): AiSettingsForm {
  const definition = getAiProviderDefinition(provider);
  return {
    aiBaseUrl: definition.defaultBaseUrl,
    aiMaxCompletionTokens: definition.defaultMaxCompletionTokens,
    aiModel: definition.defaultModel,
    aiProvider: provider,
    aiReasoningEffort: null,
  };
}

function formatSecretStatus(isConfigured: boolean | undefined) {
  if (isConfigured === undefined) {
    return "확인 중";
  }

  return isConfigured ? "서버에 설정됨" : "서버에 미설정";
}

function getProviderWarning(provider: AiProviderName, secrets: AiSettingsResponse["secrets"]) {
  if (provider === "stub") {
    return "로컬 Stub은 실제 LLM을 호출하지 않습니다. 운영 문서에는 Core.Today 또는 OpenAI 공급자를 사용하세요.";
  }

  if (getAiProviderDefinition(provider).capabilities.coreTodayProxy && !secrets.coredotConfigured) {
    return "Core.Today API 키가 서버에 없어 이 공급자는 실제 요청을 처리할 수 없습니다.";
  }

  if (provider === "openai" && !secrets.openaiConfigured) {
    return "OpenAI API 키가 서버에 없어 이 공급자는 실제 요청을 처리할 수 없습니다.";
  }

  return "";
}
