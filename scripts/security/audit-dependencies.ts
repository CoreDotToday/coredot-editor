import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { parse as parseYaml } from "yaml";

export const AUDIT_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
} as const;

type Severity = keyof typeof severityRank;
export type PackageInventory = Record<string, string[]>;

export type AuditFinding = {
  id: number;
  name: string;
  title: string;
  url: string;
  vulnerable_versions: string;
  severity: Severity;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type RequestOptions = {
  delay?: (milliseconds: number) => Promise<void>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

type RunAuditOptions = RequestOptions & {
  lockfilePath?: string;
  lockfileSource?: string;
  stderr?: (line: string) => void;
  stdout?: (line: string) => void;
};

class AuditOperationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditOperationalError";
  }
}

class RetryableAuditRequestError extends Error {
  constructor(readonly detail?: string) {
    super("Dependency advisory request can be retried");
    this.name = "RetryableAuditRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parsePackageKey(key: string): { name: string; version: string } {
  const versionDelimiter = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  if (versionDelimiter <= 0) {
    throw new AuditOperationalError(`Dependency lockfile package key is invalid: ${key}`);
  }

  const name = key.slice(0, versionDelimiter);
  const versionWithPeerContext = key.slice(versionDelimiter + 1);
  const peerContextStart = versionWithPeerContext.indexOf("(");
  const version = peerContextStart === -1
    ? versionWithPeerContext
    : versionWithPeerContext.slice(0, peerContextStart);
  const peerContext = peerContextStart === -1 ? "" : versionWithPeerContext.slice(peerContextStart);

  if (!/^(?:@[^/@\s]+\/)?[^/@\s]+$/.test(name) || !version) {
    throw new AuditOperationalError(`Dependency lockfile package key is invalid: ${key}`);
  }
  if (semver.valid(version) !== version) {
    throw new AuditOperationalError(`Dependency lockfile package does not use an exact version: ${key}`);
  }
  if (peerContext) {
    let depth = 0;
    for (const character of peerContext) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth < 0) break;
    }
    if (!peerContext.startsWith("(") || depth !== 0) {
      throw new AuditOperationalError(`Dependency lockfile package peer context is invalid: ${key}`);
    }
  }

  return { name, version };
}

export function parsePnpmLockfile(source: string): PackageInventory {
  let document: unknown;
  try {
    document = parseYaml(source, { maxAliasCount: 100, uniqueKeys: true });
  } catch {
    throw new AuditOperationalError("Dependency lockfile YAML is invalid");
  }

  if (!isRecord(document)) {
    throw new AuditOperationalError("Dependency lockfile must contain a YAML object");
  }
  if (String(document.lockfileVersion) !== "9.0") {
    throw new AuditOperationalError("Dependency lockfile must use pnpm lockfile version 9.0");
  }
  if (!isRecord(document.packages)) {
    throw new AuditOperationalError("Dependency lockfile packages map is missing or invalid");
  }

  const collected = new Map<string, Set<string>>();
  for (const key of Object.keys(document.packages).sort(compareText)) {
    const entry = document.packages[key];
    if (!isRecord(entry) || !isRecord(entry.resolution)
      || typeof entry.resolution.integrity !== "string"
      || entry.resolution.integrity.trim() === "") {
      throw new AuditOperationalError(`Dependency lockfile registry resolution is invalid: ${key}`);
    }

    const { name, version } = parsePackageKey(key);
    const versions = collected.get(name) ?? new Set<string>();
    versions.add(version);
    collected.set(name, versions);
  }

  return Object.fromEntries(
    [...collected.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, versions]) => [name, [...versions].sort(compareText)]),
  );
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AuditOperationalError(`Dependency advisory ${field} is invalid`);
  }
  return value;
}

export function validateAdvisoryResponse(
  body: unknown,
  requestedPackages: PackageInventory,
): AuditFinding[] {
  if (!isRecord(body)) {
    throw new AuditOperationalError("Dependency advisory response top-level value is invalid");
  }

  const findings: AuditFinding[] = [];
  for (const [packageName, bucket] of Object.entries(body)) {
    if (!Object.hasOwn(requestedPackages, packageName)) {
      throw new AuditOperationalError("Dependency advisory response contains a package that was not requested");
    }
    if (!Array.isArray(bucket)) {
      throw new AuditOperationalError(`Dependency advisory bucket is invalid for ${packageName}`);
    }

    for (const candidate of bucket) {
      if (!isRecord(candidate)) {
        throw new AuditOperationalError(`Dependency advisory entry is invalid for ${packageName}`);
      }
      if (typeof candidate.id !== "number" || !Number.isFinite(candidate.id)) {
        throw new AuditOperationalError(`Dependency advisory id is invalid for ${packageName}`);
      }
      const name = packageName;
      const title = validateNonEmptyString(candidate.title, "title");
      const url = validateNonEmptyString(candidate.url, "URL");
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new AuditOperationalError(`Dependency advisory URL is invalid for ${packageName}`);
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new AuditOperationalError(`Dependency advisory URL is invalid for ${packageName}`);
      }
      const vulnerableVersions = validateNonEmptyString(
        candidate.vulnerable_versions,
        "vulnerable_versions",
      );
      if (typeof candidate.severity !== "string" || !(candidate.severity in severityRank)) {
        throw new AuditOperationalError(`Dependency advisory severity is invalid for ${packageName}`);
      }

      findings.push({
        id: candidate.id,
        name,
        severity: candidate.severity as Severity,
        title,
        url,
        vulnerable_versions: vulnerableVersions,
      });
    }
  }

  return findings;
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw new DOMException("Dependency advisory request timed out", "AbortError");
  }

  return await new Promise((resolveChunk, rejectChunk) => {
    const handleAbort = () => {
      rejectChunk(new DOMException("Dependency advisory request timed out", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    void reader.read().then(resolveChunk, rejectChunk).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  });
}

async function readBoundedResponseBody(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new AuditOperationalError("Dependency advisory response exceeds the 5 MiB limit");
    }
  }
  if (!response.body) {
    throw new AuditOperationalError("Dependency advisory response body is missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  let readAborted = false;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        readAborted = true;
        void reader.cancel().catch(() => undefined);
        throw new AuditOperationalError("Dependency advisory response exceeds the 5 MiB limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (isRetryableNetworkError(error)) {
      readAborted = true;
      void reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    if (!readAborted) reader.releaseLock();
  }
  return text;
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError
    || (isRecord(error)
      && (error.name === "AbortError" || error.name === "TimeoutError"));
}

async function defaultDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function cancelResponse(response: Response): void {
  // The response is discarded before a bounded retry. Never let cancellation delay the next attempt.
  void response.body?.cancel().catch(() => undefined);
}

async function performAuditRequest(
  packages: PackageInventory,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<AuditFinding[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(AUDIT_ENDPOINT, {
      body: JSON.stringify(packages),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });

    if (!response.ok) {
      const retryable = response.status === 408
        || response.status === 429
        || response.status >= 500;
      cancelResponse(response);
      if (retryable) {
        throw new RetryableAuditRequestError(`HTTP ${response.status}`);
      }
      throw new AuditOperationalError(`Dependency advisory request returned HTTP ${response.status}`);
    }

    const responseText = await readBoundedResponseBody(response, controller.signal);
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      throw new AuditOperationalError("Dependency advisory response is not valid JSON");
    }
    return validateAdvisoryResponse(responseBody, packages);
  } catch (error) {
    if (error instanceof AuditOperationalError || error instanceof RetryableAuditRequestError) {
      throw error;
    }
    if (isRetryableNetworkError(error)) {
      throw new RetryableAuditRequestError();
    }
    throw new AuditOperationalError("Dependency advisory request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestAdvisories(
  packages: PackageInventory,
  options: RequestOptions = {},
): Promise<AuditFinding[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.delay ?? defaultDelay;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AuditOperationalError("Dependency advisory request timeout is invalid");
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await performAuditRequest(packages, fetchImpl, timeoutMs);
    } catch (error) {
      if (!(error instanceof RetryableAuditRequestError)) {
        throw error;
      }
      if (attempt === MAX_ATTEMPTS) {
        const detail = error.detail ? ` (${error.detail})` : "";
        throw new AuditOperationalError(
          `Dependency advisory request failed after ${MAX_ATTEMPTS} attempts${detail}`,
        );
      }
      await delay(250 * attempt);
    }
  }

  throw new AuditOperationalError("Dependency advisory request failed");
}

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity]
    || compareText(left.name, right.name)
    || left.id - right.id);
}

export function classifyFindings(findings: AuditFinding[]): 0 | 1 {
  return findings.some((finding) => severityRank[finding.severity] >= severityRank.moderate)
    ? 1
    : 0;
}

export function formatAuditReport(findings: AuditFinding[]): string {
  const sorted = sortFindings(findings);
  const counts: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  const lines = sorted.map((finding) => {
    counts[finding.severity] += 1;
    return `[${finding.severity}] ${finding.name} advisory #${finding.id}: ${finding.title} (vulnerable: ${finding.vulnerable_versions}) ${finding.url}`;
  });
  lines.push(
    `Dependency audit: ${sorted.length} finding(s); info=${counts.info}, low=${counts.low}, moderate=${counts.moderate}, high=${counts.high}, critical=${counts.critical}.`,
  );
  lines.push("Release threshold: moderate or higher.");
  return lines.join("\n");
}

export async function runAudit(options: RunAuditOptions = {}): Promise<0 | 1 | 2> {
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  try {
    const lockfileSource = options.lockfileSource
      ?? await readFile(options.lockfilePath ?? resolve(process.cwd(), "pnpm-lock.yaml"), "utf8");
    const packages = parsePnpmLockfile(lockfileSource);
    const findings = await requestAdvisories(packages, options);
    stdout(formatAuditReport(findings));
    return classifyFindings(findings);
  } catch (error) {
    const message = error instanceof AuditOperationalError
      ? error.message
      : "Unexpected dependency audit failure";
    stderr(`Dependency audit failed: ${message}`);
    return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void runAudit().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
