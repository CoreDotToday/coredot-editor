export type CoreTodayProviderName = "coredot" | "anthropic" | "gemini";

export const DEFAULT_COREDOT_BASE_URL = "https://api.core.today/llm/openai/v1";
export const DEFAULT_COREDOT_ANTHROPIC_BASE_URL = "https://api.core.today/llm/anthropic/v1";
export const DEFAULT_COREDOT_GEMINI_BASE_URL = "https://api.core.today/llm/gemini/v1beta";

const allowedCoreTodayPaths: Record<CoreTodayProviderName, string> = {
  anthropic: "/llm/anthropic/v1",
  coredot: "/llm/openai/v1",
  gemini: "/llm/gemini/v1beta",
};

const defaultCoreTodayBaseUrls: Record<CoreTodayProviderName, string> = {
  anthropic: DEFAULT_COREDOT_ANTHROPIC_BASE_URL,
  coredot: DEFAULT_COREDOT_BASE_URL,
  gemini: DEFAULT_COREDOT_GEMINI_BASE_URL,
};

export function normalizeCoreTodayBaseUrl(provider: CoreTodayProviderName, baseUrl: string | null | undefined) {
  const candidate = baseUrl?.trim() || defaultCoreTodayBaseUrls[provider];

  if (hasExplicitPort(candidate)) {
    throw new Error("Invalid Core.Today base URL");
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Invalid Core.Today base URL");
  }

  const normalizedPathname = url.pathname.replace(/\/+$/, "");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.core.today" ||
    url.port !== "" ||
    normalizedPathname !== allowedCoreTodayPaths[provider] ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid Core.Today base URL");
  }

  return `${url.origin}${normalizedPathname}`;
}

function hasExplicitPort(value: string) {
  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i)?.[1] ?? "";
  return /:\d+$/.test(authority);
}
