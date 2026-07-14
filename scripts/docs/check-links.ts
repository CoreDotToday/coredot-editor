import { lookup } from "node:dns/promises";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export type LinkCheckMode = "internal" | "external";

export type LinkIssue = {
  file: string;
  href: string;
  message: string;
};

const DEFAULT_EXTERNAL_TIMEOUT_MS = 5_000;
const MAX_EXTERNAL_CONCURRENCY = 4;
const MAX_REDIRECTS = 5;
const ROOT_DOCUMENTATION_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
];

class UnsafeTargetError extends Error {}

type ValidatedAddress = {
  address: string;
  family: number;
};

type ExternalHttpResponse = {
  location?: string;
  status: number;
};

const markdownParser = new MarkdownIt({ html: true, linkify: true });

type RawHtmlLink = {
  attribute: "href" | "src";
  href: string;
  tagName: "a" | "img";
};

function extractRawHtmlLinks(markdown: string): RawHtmlLink[] {
  const links: RawHtmlLink[] = [];
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "html_block" || token.type === "html_inline") {
        const html = token.content.replace(/<!--[\s\S]*?-->/gu, "");
        const tags = html.matchAll(/<(a|img)\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu);
        for (const match of tags) {
          const tagName = match[1].toLowerCase() as RawHtmlLink["tagName"];
          const attribute: RawHtmlLink["attribute"] = tagName === "a" ? "href" : "src";
          const attributeMatch = match[0].match(new RegExp(
            `\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`,
            "iu",
          ));
          const href = attributeMatch?.[1] ?? attributeMatch?.[2] ?? attributeMatch?.[3];
          if (href !== undefined) {
            links.push({ attribute, href, tagName });
          }
        }
      }
      if (token.children) {
        visit(token.children);
      }
    }
  };
  visit(markdownParser.parse(markdown, {}));
  return links;
}

function shouldCollectLink(tokens: Token[], index: number): boolean {
  const token = tokens[index];
  if (token.markup === "linkify") {
    const label = tokens[index + 1];
    if (label?.type !== "text" || !/^https?:\/\//iu.test(label.content)) {
      return false;
    }
  }
  const previous = tokens[index - 1];
  return token.markup === ""
    || previous?.type !== "text"
    || !previous.content.endsWith("](");
}

type LinkOccurrence = {
  href: string;
  provenance: "markdown" | "raw-html";
  rawTagName?: RawHtmlLink["tagName"];
};

function normalizeExtractedHref(href: string | null): string | undefined {
  const normalized = href ? decodeHtmlEntities(href.trim()) : undefined;
  return !normalized || /^(?:mailto|tel):/iu.test(normalized)
    ? undefined
    : normalized;
}

function extractLinkOccurrences(markdown: string): LinkOccurrence[] {
  const links: LinkOccurrence[] = [];
  const seen = new Set<string>();
  const add = (
    href: string | null,
    provenance: LinkOccurrence["provenance"],
    rawTagName?: RawHtmlLink["tagName"],
  ) => {
    const normalized = normalizeExtractedHref(href);
    if (!normalized) {
      return;
    }
    const key = `${provenance}\u0000${rawTagName ?? ""}\u0000${normalized}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    links.push({ href: normalized, provenance, rawTagName });
  };

  const visit = (tokens: Token[]) => {
    for (const [index, token] of tokens.entries()) {
      if (token.type === "link_open" && shouldCollectLink(tokens, index)) {
        add(token.attrGet("href"), "markdown");
      } else if (token.type === "image") {
        add(token.attrGet("src"), "markdown");
      }
      if (token.children) {
        visit(token.children);
      }
    }
  };
  visit(markdownParser.parse(markdown, {}));
  for (const { href, tagName } of extractRawHtmlLinks(markdown)) {
    add(href, "raw-html", tagName);
  }

  return links;
}

export function extractMarkdownLinks(markdown: string): string[] {
  return [...new Set(extractLinkOccurrences(markdown).map(({ href }) => href))];
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/giu,
    (_entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (decimal) {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      }
      if (hexadecimal) {
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      }
      return ({ amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' })[
        named?.toLowerCase() ?? ""
      ] ?? "";
    },
  );
}

export function normalizeHeadingAnchor(heading: string): string {
  return decodeHtmlEntities(heading)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/(`+)(.*?)\1/gu, "$2")
    .replace(/[\\*~]/gu, "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/gu, "")
    .toLowerCase()
    .replace(/[^\w\s-]/gu, "")
    .trim()
    .replace(/[-\s]+/gu, "-");
}

function extractHeadingAnchors(markdown: string): Set<string> {
  const headings: Array<{ explicitId?: string; text: string }> = [];

  const tokens = markdownParser.parse(markdown, {});
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type === "heading_open" && tokens[index + 1]?.type === "inline") {
      const text = tokens[index + 1].content;
      const explicit = text.match(/\s+\{#([^\s}]+)(?:\s+[^}]*)?\}\s*$/u);
      headings.push({
        explicitId: explicit?.[1],
        text: explicit ? text.slice(0, explicit.index).trim() : text,
      });
    }
  }

  const anchors = new Set<string>();
  for (const heading of headings) {
    const base = heading.explicitId ?? normalizeHeadingAnchor(heading.text);
    if (!base) {
      continue;
    }
    let anchor = base;
    let suffix = 1;
    while (anchors.has(anchor)) {
      anchor = `${base}_${suffix}`;
      suffix += 1;
    }
    anchors.add(anchor);
  }
  return anchors;
}

function toRepositoryPath(root: string, path: string): string {
  const repositoryPath = relative(root, path).split(sep).join("/");
  return repositoryPath || ".";
}

function isInsideRoot(root: string, path: string): boolean {
  const repositoryPath = relative(root, path);
  return repositoryPath === ""
    || (!repositoryPath.startsWith(`..${sep}`) && repositoryPath !== ".." && !isAbsolute(repositoryPath));
}

function splitHref(href: string): { fragment: string; path: string } {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  return {
    fragment: hashIndex === -1 ? "" : href.slice(hashIndex + 1),
    path: queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex),
  };
}

function isInternalHref(href: string): boolean {
  return href.startsWith("#")
    || (!href.startsWith("//") && !/^[a-z][a-z\d+.-]*:/iu.test(href));
}

type ResolvedInternalTarget =
  | { status: "found"; path: string; realPath: string }
  | { status: "missing" }
  | { status: "outside" };

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === code;
}

function isUnavailableLinkTargetError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}

async function resolveInternalTarget(
  path: string,
  realRepositoryRoot: string,
): Promise<ResolvedInternalTarget> {
  try {
    const metadata = await stat(path);
    let targetPath: string;
    if (metadata.isDirectory()) {
      const indexPath = resolve(path, "index.md");
      const indexMetadata = await stat(indexPath);
      if (!indexMetadata.isFile()) {
        return { status: "missing" };
      }
      targetPath = indexPath;
    } else if (metadata.isFile()) {
      targetPath = path;
    } else {
      return { status: "missing" };
    }
    const realTargetPath = await realpath(targetPath);
    if (!isInsideRoot(realRepositoryRoot, realTargetPath)) {
      return { status: "outside" };
    }
    return { path: targetPath, realPath: realTargetPath, status: "found" };
  } catch (error) {
    if (isUnavailableLinkTargetError(error)) {
      return { status: "missing" };
    }
    throw error;
  }
}

export async function checkInternalLinks(
  root: string,
  files: string[],
): Promise<LinkIssue[]> {
  const repositoryRoot = resolve(root);
  const realRepositoryRoot = await realpath(repositoryRoot);
  const issues: LinkIssue[] = [];
  const anchorCache = new Map<string, Promise<Set<string>>>();
  const readAnchors = (path: string) => {
    let cached = anchorCache.get(path);
    if (!cached) {
      cached = readFile(path, "utf8").then(extractHeadingAnchors);
      anchorCache.set(path, cached);
    }
    return cached;
  };

  for (const file of files) {
    const sourcePath = isAbsolute(file) ? resolve(file) : resolve(repositoryRoot, file);
    const sourceFile = toRepositoryPath(repositoryRoot, sourcePath);
    let markdown: string;
    try {
      const realSourcePath = await realpath(sourcePath);
      if (
        !isInsideRoot(repositoryRoot, sourcePath)
        || !isInsideRoot(realRepositoryRoot, realSourcePath)
      ) {
        issues.push({ file: sourceFile, href: file, message: "Link target leaves repository root" });
        continue;
      }
      markdown = await readFile(realSourcePath, "utf8");
    } catch (error) {
      if (!isUnavailableLinkTargetError(error)) {
        throw error;
      }
      issues.push({
        file: sourceFile,
        href: file,
        message: `Missing file: ${sourceFile}`,
      });
      continue;
    }

    for (const occurrence of extractLinkOccurrences(markdown)) {
      const { href } = occurrence;
      if (!isInternalHref(href)) {
        continue;
      }
      const parts = splitHref(href);
      let decodedPath: string;
      let decodedFragment: string;
      try {
        decodedPath = decodeURIComponent(parts.path);
        decodedFragment = decodeURIComponent(parts.fragment);
      } catch {
        issues.push({ file: sourceFile, href, message: "Invalid URL encoding" });
        continue;
      }

      if (
        sourceFile.startsWith("docs/")
        && occurrence.provenance === "raw-html"
        && occurrence.rawTagName === "a"
        && decodedPath.toLowerCase().endsWith(".md")
      ) {
        issues.push({
          file: sourceFile,
          href,
          message: "Raw HTML local .md links are not rewritten by MkDocs; use the rendered clean URL",
        });
        continue;
      }

      const isRawMkDocsLink = sourceFile.startsWith("docs/")
        && occurrence.provenance === "raw-html";
      const renderedPageDirectory = sourceFile === "docs/index.md"
        ? dirname(sourcePath)
        : sourcePath.slice(0, -extname(sourcePath).length);
      const candidatePath = decodedPath === ""
        ? sourcePath
        : decodedPath.startsWith("/")
          ? resolve(isRawMkDocsLink ? resolve(repositoryRoot, "docs") : repositoryRoot, `.${decodedPath}`)
          : resolve(isRawMkDocsLink ? renderedPageDirectory : dirname(sourcePath), decodedPath);
      if (!isInsideRoot(repositoryRoot, candidatePath)) {
        issues.push({ file: sourceFile, href, message: "Link target leaves repository root" });
        continue;
      }

      let target = await resolveInternalTarget(candidatePath, realRepositoryRoot);
      if (
        target.status === "missing"
        && isRawMkDocsLink
        && decodedPath.endsWith("/")
        && decodedPath !== "/"
      ) {
        target = await resolveInternalTarget(`${candidatePath}.md`, realRepositoryRoot);
      }
      if (target.status === "outside") {
        issues.push({ file: sourceFile, href, message: "Link target leaves repository root" });
        continue;
      }
      if (target.status === "missing") {
        issues.push({
          file: sourceFile,
          href,
          message: `Missing file: ${toRepositoryPath(repositoryRoot, candidatePath)}`,
        });
        continue;
      }
      if (!decodedFragment || extname(target.path).toLowerCase() !== ".md") {
        continue;
      }

      const anchors = await readAnchors(target.realPath);
      if (!anchors.has(decodedFragment)) {
        issues.push({
          file: sourceFile,
          href,
          message: `Missing anchor "#${decodedFragment}" in ${toRepositoryPath(repositoryRoot, target.path)}`,
        });
      }
    }
  }

  return issues;
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce(
    (value, octet) => value * 256 + Number.parseInt(octet, 10),
    0,
  );
}

function ipv4Matches(address: number, network: number, prefixLength: number): boolean {
  const divisor = 2 ** (32 - prefixLength);
  return Math.floor(address / divisor) === Math.floor(network / divisor);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const blockedRanges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blockedRanges.some(([network, prefixLength]) => (
    ipv4Matches(value, ipv4ToNumber(network), prefixLength)
  ));
}

function ipv6ToBigInt(address: string): bigint {
  let normalized = address.toLowerCase().split("%")[0];
  const ipv4Match = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u);
  if (ipv4Match) {
    const ipv4 = ipv4ToNumber(ipv4Match[1]);
    normalized = `${normalized.slice(0, -ipv4Match[1].length)}${(
      (ipv4 >>> 16) & 0xffff
    ).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const [leftValue, rightValue] = normalized.split("::");
  const left = leftValue ? leftValue.split(":").filter(Boolean) : [];
  const right = rightValue ? rightValue.split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  const groups = normalized.includes("::")
    ? [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    : left;
  return groups.reduce(
    (value, group) => (value << BigInt(16)) + BigInt(Number.parseInt(group || "0", 16)),
    BigInt(0),
  );
}

function ipv6Matches(address: bigint, network: bigint, prefixLength: number): boolean {
  const shift = BigInt(128 - prefixLength);
  return address >> shift === network >> shift;
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  const mappedIpv4Prefix = BigInt(0xffff);
  if (value >> BigInt(32) === mappedIpv4Prefix) {
    const mapped = Number(value & BigInt(0xffff_ffff));
    const addressText = [24, 16, 8, 0]
      .map((shift) => String((mapped >>> shift) & 255))
      .join(".");
    return isPublicIpv4(addressText);
  }
  if (!ipv6Matches(value, ipv6ToBigInt("2000::"), 3)) {
    return false;
  }
  const nonGlobalRanges: Array<[string, number]> = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3ffe::", 16],
    ["3fff::", 20],
  ];
  return !nonGlobalRanges.some(([network, prefixLength]) => (
    ipv6Matches(value, ipv6ToBigInt(network), prefixLength)
  ));
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPublicIpv4(address);
  }
  if (family === 6) {
    return isPublicIpv6(address);
  }
  return false;
}

async function withDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("External request timed out");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("External request timed out")), remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function validateExternalTarget(url: URL, deadline: number): Promise<ValidatedAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeTargetError();
  }
  if (url.username || url.password) {
    throw new UnsafeTargetError();
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new UnsafeTargetError();
  }

  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new UnsafeTargetError();
    }
    return [{ address: hostname, family: isIP(hostname) }];
  }

  const addresses = await withDeadline(
    lookup(hostname, { all: true, verbatim: true }),
    deadline,
  );
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new UnsafeTargetError();
  }
  return [...new Map(addresses.map(({ address }) => [address, {
    address,
    family: isIP(address),
  }])).values()];
}

async function requestPinnedAddress(
  url: URL,
  method: "GET" | "HEAD",
  deadline: number,
  validatedAddress: ValidatedAddress,
): Promise<ExternalHttpResponse> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("External request timed out");
  }
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [validatedAddress]);
      return;
    }
    callback(null, validatedAddress.address, validatedAddress.family);
  };
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<ExternalHttpResponse>((resolveRequest, rejectRequest) => {
    let settled = false;
    const timer: { value?: NodeJS.Timeout } = {};
    const settle = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer.value) {
        clearTimeout(timer.value);
      }
      complete();
    };
    const clientRequest = request(url, {
      lookup: pinnedLookup,
      method,
      servername: url.protocol === "https:" && !isIP(hostname) ? hostname : undefined,
    }, (response) => {
      const header = response.headers.location;
      const location = Array.isArray(header) ? header[0] : header;
      const status = response.statusCode ?? 0;
      response.destroy();
      settle(() => resolveRequest({ location, status }));
    });
    clientRequest.once("error", () => {
      settle(() => rejectRequest(new Error("External request failed")));
    });
    timer.value = setTimeout(() => {
      settle(() => rejectRequest(new Error("External request timed out")));
      clientRequest.destroy();
    }, remainingMs);
    clientRequest.end();
  });
}

async function requestWithDeadline(
  url: URL,
  method: "GET" | "HEAD",
  deadline: number,
  validatedAddresses: ValidatedAddress[],
): Promise<ExternalHttpResponse> {
  let lastError: unknown;
  for (const [index, validatedAddress] of validatedAddresses.entries()) {
    const now = Date.now();
    const remainingMs = deadline - now;
    if (remainingMs <= 0) {
      break;
    }
    const remainingAddresses = validatedAddresses.length - index;
    const attemptDeadline = Math.min(
      deadline,
      now + Math.max(1, Math.floor(remainingMs / remainingAddresses)),
    );
    try {
      return await requestPinnedAddress(url, method, attemptDeadline, validatedAddress);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("External request failed");
}

function isRedirect(response: ExternalHttpResponse): boolean {
  return [301, 302, 303, 307, 308].includes(response.status);
}

function isSuccessful(response: ExternalHttpResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

async function followExternalRequest(
  initialUrl: URL,
  method: "GET" | "HEAD",
  deadline: number,
): Promise<{ response: ExternalHttpResponse; url: URL }> {
  let url = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const validatedAddresses = await validateExternalTarget(url, deadline);
    const response = await requestWithDeadline(url, method, deadline, validatedAddresses);
    if (!isRedirect(response)) {
      return { response, url };
    }
    const location = response.location;
    if (!location || redirectCount === MAX_REDIRECTS) {
      throw new Error("External redirect failed");
    }
    url = new URL(location, url);
  }
  throw new Error("External redirect failed");
}

function sanitizeExternalHref(href: string): string {
  const withoutSuffix = href.split(/[?#]/u, 1)[0];
  const authority = withoutSuffix.match(
    /^([a-z][a-z\d+.-]*:\/\/|\/\/)([^/]*)([\s\S]*)$/iu,
  );
  if (authority) {
    const at = authority[2].lastIndexOf("@");
    return at === -1
      ? withoutSuffix
      : `${authority[1]}${authority[2].slice(at + 1)}${authority[3]}`;
  }

  try {
    const url = new URL(href);
    return url.username || url.password
      ? `${url.protocol}//${url.host}${url.pathname}`
      : withoutSuffix;
  } catch {
    return withoutSuffix.replace(
      /^([a-z][a-z\d+.-]*:)(?:\/\/)?[^/@\s]*@/iu,
      "$1//",
    );
  }
}

async function checkOneExternalLink(href: string, timeoutMs: number): Promise<LinkIssue | undefined> {
  const reportedHref = sanitizeExternalHref(href);
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { file: "", href: reportedHref, message: "External link target is not allowed" };
  }

  try {
    const deadline = Date.now() + timeoutMs;
    let getUrl = url;
    try {
      const head = await followExternalRequest(url, "HEAD", deadline);
      if (isSuccessful(head.response)) {
        return undefined;
      }
      getUrl = head.url;
    } catch (error) {
      if (error instanceof UnsafeTargetError) {
        throw error;
      }
    }
    const get = await followExternalRequest(getUrl, "GET", deadline);
    if (isSuccessful(get.response)) {
      return undefined;
    }
    return {
      file: "",
      href: reportedHref,
      message: `External link returned HTTP ${get.response.status}`,
    };
  } catch (error) {
    return {
      file: "",
      href: reportedHref,
      message: error instanceof UnsafeTargetError
        ? "External link target is not allowed"
        : "External link check failed",
    };
  }
}

type ExternalLinkCheckResult = {
  issue?: LinkIssue;
  rawHref: string;
};

type ExternalLinkCheckOptions = {
  concurrency?: number;
  timeoutMs?: number;
};

async function checkExternalLinkResults(
  links: string[],
  options: ExternalLinkCheckOptions = {},
): Promise<ExternalLinkCheckResult[]> {
  const uniqueLinks = [...new Set(links)];
  if (uniqueLinks.length === 0) {
    return [];
  }
  const requestedConcurrency = Number.isFinite(options.concurrency)
    ? Math.max(1, Math.floor(options.concurrency ?? MAX_EXTERNAL_CONCURRENCY))
    : MAX_EXTERNAL_CONCURRENCY;
  const concurrency = Math.min(MAX_EXTERNAL_CONCURRENCY, requestedConcurrency);
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Math.floor(options.timeoutMs as number)
    : DEFAULT_EXTERNAL_TIMEOUT_MS;
  const results = new Array<ExternalLinkCheckResult>(uniqueLinks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < uniqueLinks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const rawHref = uniqueLinks[index];
      results[index] = {
        issue: await checkOneExternalLink(rawHref, timeoutMs),
        rawHref,
      };
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, uniqueLinks.length) },
    worker,
  ));
  return results;
}

export async function checkExternalLinks(
  links: string[],
  options: ExternalLinkCheckOptions = {},
): Promise<LinkIssue[]> {
  const results = await checkExternalLinkResults(links, options);
  return results.flatMap(({ issue }) => issue ? [issue] : []);
}

async function collectDocumentationFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const file of ROOT_DOCUMENTATION_FILES) {
    try {
      if ((await stat(resolve(root, file))).isFile()) {
        files.push(file);
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  const visit = async (directory: string) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const repositoryPath = toRepositoryPath(root, path);
      if (
        repositoryPath === "docs/superpowers"
        || repositoryPath.startsWith("docs/superpowers/")
        || repositoryPath === "site"
        || repositoryPath.startsWith("site/")
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(repositoryPath);
      }
    }
  };
  await visit(resolve(root, "docs"));
  return [...new Set(files)].sort();
}

function formatIssue(issue: LinkIssue): string {
  return `${issue.file || "(external)"}: ${issue.href} - ${issue.message}`;
}

function isExternalCandidate(href: string): boolean {
  return href.startsWith("//")
    || (!/^(?:mailto|tel):/iu.test(href) && /^[a-z][a-z\d+.-]*:/iu.test(href));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (isIP(normalized) === 4) {
    return ipv4Matches(ipv4ToNumber(normalized), ipv4ToNumber("127.0.0.0"), 8);
  }
  if (isIP(normalized) !== 6) {
    return false;
  }

  const value = ipv6ToBigInt(normalized);
  if (value === BigInt(1)) {
    return true;
  }
  if (value >> BigInt(32) !== BigInt(0xffff)) {
    return false;
  }
  const mapped = Number(value & BigInt(0xffff_ffff));
  const mappedAddress = [24, 16, 8, 0]
    .map((shift) => String((mapped >>> shift) & 255))
    .join(".");
  return ipv4Matches(ipv4ToNumber(mappedAddress), ipv4ToNumber("127.0.0.0"), 8);
}

function isLocalDocumentationExample(href: string): boolean {
  const candidates = [href];
  try {
    const decoded = decodeURIComponent(href);
    if (decoded !== href) {
      candidates.push(decoded);
    }
  } catch {
    // Keep the original candidate. The request validator will reject malformed links.
  }
  return candidates.some((candidate) => {
    try {
      const url = new URL(candidate.startsWith("//") ? `https:${candidate}` : candidate);
      return (url.protocol === "http:" || url.protocol === "https:")
        && isLoopbackHostname(url.hostname);
    } catch {
      return false;
    }
  });
}

async function runCli(argv: string[]): Promise<number> {
  if (argv.some((argument) => argument !== "--external")) {
    process.stderr.write("Usage: pnpm docs:check-links [--external]\n");
    return 1;
  }
  const mode: LinkCheckMode = argv.includes("--external") ? "external" : "internal";
  const root = process.cwd();
  const files = await collectDocumentationFiles(root);
  const issues = await checkInternalLinks(root, files);

  if (mode === "external") {
    const firstSourceByLink = new Map<string, string>();
    for (const file of files) {
      const markdown = await readFile(resolve(root, file), "utf8");
      for (const href of extractMarkdownLinks(markdown)) {
        if (
          isExternalCandidate(href)
          && !isLocalDocumentationExample(href)
          && !firstSourceByLink.has(href)
        ) {
          firstSourceByLink.set(href, file);
        }
      }
    }
    const externalResults = await checkExternalLinkResults([...firstSourceByLink.keys()]);
    issues.push(...externalResults.flatMap(({ issue, rawHref }) => issue ? [{
      ...issue,
      file: firstSourceByLink.get(rawHref) ?? "",
    }] : []));
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      process.stderr.write(`${formatIssue(issue)}\n`);
    }
    return 1;
  }
  process.stdout.write(`Documentation links are valid (${mode}).\n`);
  return 0;
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write("Documentation link check failed.\n");
    process.exitCode = 1;
  });
}
