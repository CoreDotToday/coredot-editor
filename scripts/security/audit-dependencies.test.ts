import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_ENDPOINT,
  MAX_RESPONSE_BYTES,
  classifyFindings,
  formatAuditReport,
  parsePnpmLockfile,
  requestAdvisories,
  runAudit,
  validateAdvisoryResponse,
  type AuditFinding,
} from "./audit-dependencies";

const inventory = { alpha: ["1.0.0"] };

function advisory(overrides: Record<string, unknown> = {}): AuditFinding {
  return {
    id: 123,
    name: "alpha",
    title: "Example advisory",
    url: "https://github.com/advisories/GHSA-example",
    vulnerable_versions: "<1.0.1",
    severity: "low",
    ...overrides,
  } as unknown as AuditFinding;
}

function responseBody(value: unknown): Response {
  const response = new Response(JSON.stringify(value), { status: 200 });
  response.headers.delete("content-type");
  return response;
}

describe("parsePnpmLockfile", () => {
  it("collects scoped and unscoped exact versions and deduplicates peer snapshots", () => {
    const lockfile = `
lockfileVersion: '9.0'
packages:
  '@scope/pkg@1.2.3':
    resolution: {integrity: sha512-one}
  plain@2.0.0:
    resolution: {integrity: sha512-two}
  plain@2.0.0(peer@1.0.0):
    resolution: {integrity: sha512-three}
  plain@2.1.0(peer@2.0.0):
    resolution: {integrity: sha512-four}
`;

    expect(parsePnpmLockfile(lockfile)).toEqual({
      "@scope/pkg": ["1.2.3"],
      plain: ["2.0.0", "2.1.0"],
    });
  });

  it.each([
    ["not YAML", "lockfile"],
    ["lockfileVersion: '9.0'", "packages"],
    [
      "lockfileVersion: '9.0'\npackages:\n  broken:\n    resolution: {integrity: sha512-one}\n",
      "package key",
    ],
    [
      "lockfileVersion: '9.0'\npackages:\n  pkg@latest:\n    resolution: {integrity: sha512-one}\n",
      "exact version",
    ],
    [
      "lockfileVersion: '9.0'\npackages:\n  pkg@1.0.0: {}\n",
      "resolution",
    ],
  ])("fails closed for an uninterpretable lockfile", (lockfile, message) => {
    expect(() => parsePnpmLockfile(lockfile)).toThrow(message);
  });

  it("parses every registry entry in the checked-in lockfile", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const source = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
    const parsed = parseYaml(source) as { packages: Record<string, unknown> };
    const result = parsePnpmLockfile(source);
    const pairCount = Object.values(result).reduce((sum, versions) => sum + versions.length, 0);

    expect(Object.keys(result).length).toBeGreaterThan(0);
    expect(pairCount).toBe(Object.keys(parsed.packages).length);
  });
});

describe("validateAdvisoryResponse", () => {
  it("accepts empty and valid requested advisory buckets", () => {
    const registryAdvisory: Record<string, unknown> = { ...advisory() };
    delete registryAdvisory.name;

    expect(validateAdvisoryResponse({}, inventory)).toEqual([]);
    expect(validateAdvisoryResponse({ alpha: [registryAdvisory] }, inventory)).toEqual([
      advisory(),
    ]);
  });

  it.each([
    [null, "top-level"],
    [[], "top-level"],
    [{ alpha: {} }, "bucket"],
    [{ unexpected: [] }, "requested"],
    [{ alpha: [advisory({ id: Number.NaN })] }, "id"],
    [{ alpha: [advisory({ title: undefined })] }, "title"],
    [{ alpha: [advisory({ title: "" })] }, "title"],
    [{ alpha: [advisory({ url: "file:///tmp/advisory" })] }, "URL"],
    [{ alpha: [advisory({ vulnerable_versions: "" })] }, "vulnerable_versions"],
    [{ alpha: [advisory({ severity: "urgent" })] }, "severity"],
  ])("rejects malformed advisory data", (body, message) => {
    expect(() => validateAdvisoryResponse(body, inventory)).toThrow(message);
  });
});

describe("requestAdvisories", () => {
  it("posts only the deterministic package inventory and accepts no Content-Type response", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.body).toBe(JSON.stringify(inventory));
      return responseBody({ alpha: [advisory()] });
    });

    await expect(requestAdvisories(inventory, { fetchImpl })).resolves.toEqual([advisory()]);
    expect(fetchImpl).toHaveBeenCalledWith(
      AUDIT_ENDPOINT,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([408, 429, 500, 503])("retries retryable HTTP %i responses", async (status) => {
    const delay = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("retry", { status }))
      .mockResolvedValueOnce(responseBody({}));

    await expect(requestAdvisories(inventory, { delay, fetchImpl })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
  });

  it("retries network errors and fails after three attempts", async () => {
    const delay = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network unavailable");
    });

    await expect(requestAdvisories(inventory, { delay, fetchImpl })).rejects.toThrow(
      "after 3 attempts",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("retries request timeouts with an injected deadline", async () => {
    vi.useFakeTimers();
    const delay = vi.fn(async () => undefined);
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "AbortError"));
        });
      }));

    try {
      const pending = requestAdvisories(inventory, { delay, fetchImpl, timeoutMs: 10 });
      let failure: unknown;
      void pending.catch((error: unknown) => {
        failure = error;
      });
      await vi.runAllTimersAsync();
      expect(failure).toEqual(expect.objectContaining({
        message: expect.stringContaining("after 3 attempts"),
      }));
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the injected deadline active while reading the response body", async () => {
    vi.useFakeTimers();
    const delay = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      pull: () => undefined,
    }), { status: 200 }));

    try {
      const pending = requestAdvisories(inventory, { delay, fetchImpl, timeoutMs: 10 });
      let failure: unknown;
      void pending.catch((error: unknown) => {
        failure = error;
      });
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(failure).toEqual(expect.objectContaining({
        message: expect.stringContaining("after 3 attempts"),
      }));
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry nonretryable 4xx responses", async () => {
    const delay = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 }));

    await expect(requestAdvisories(inventory, { delay, fetchImpl })).rejects.toThrow("HTTP 400");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));

    await expect(requestAdvisories(inventory, { fetchImpl })).rejects.toThrow("JSON");
  });

  it("rejects response bodies over the byte limit", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { status: 200 }));

    await expect(requestAdvisories(inventory, { fetchImpl })).rejects.toThrow("5 MiB");
  });
});

describe("audit classification and reporting", () => {
  it.each([
    [[], 0],
    [[advisory({ severity: "info" })], 0],
    [[advisory({ severity: "low" })], 0],
    [[advisory({ severity: "moderate" })], 1],
    [[advisory({ severity: "high" })], 1],
    [[advisory({ severity: "critical" })], 1],
  ] as const)("classifies the moderate release threshold", (findings, exitCode) => {
    expect(classifyFindings([...findings])).toBe(exitCode);
  });

  it("prints findings deterministically by severity, package, and advisory id", () => {
    const findings = [
      advisory({ id: 9, name: "zulu", severity: "low" }),
      advisory({ id: 8, name: "bravo", severity: "critical" }),
      advisory({ id: 2, name: "alpha", severity: "critical" }),
      advisory({ id: 1, name: "alpha", severity: "critical" }),
    ];

    expect(formatAuditReport(findings)).toMatchSnapshot();
  });

  it("returns exit 0 or 1 for valid findings and exit 2 for operational failure", async () => {
    const source = "lockfileVersion: '9.0'\npackages:\n  alpha@1.0.0:\n    resolution: {integrity: sha512-one}\n";
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(runAudit({
      fetchImpl: async () => responseBody({}),
      lockfileSource: source,
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(0);
    await expect(runAudit({
      fetchImpl: async () => responseBody({ alpha: [advisory({ severity: "moderate" })] }),
      lockfileSource: source,
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(1);
    await expect(runAudit({
      fetchImpl: async () => new Response("bad", { status: 400 }),
      lockfileSource: source,
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(2);

    expect(stdout).toHaveLength(2);
    expect(stderr).toEqual([expect.stringContaining("Dependency audit failed")]);
  });
});
