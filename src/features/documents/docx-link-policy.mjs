const DOCX_EXTERNAL_LINK_PROTOCOLS = new Set(["ftp:", "http:", "https:", "mailto:", "tel:"]);

export function normalizeDocxExternalLinkHref(value) {
  if (typeof value !== "string") return null;
  const href = value.trim();
  if (!href) return null;
  try {
    const url = new URL(href);
    return DOCX_EXTERNAL_LINK_PROTOCOLS.has(url.protocol.toLowerCase()) ? href : null;
  } catch {
    return null;
  }
}
