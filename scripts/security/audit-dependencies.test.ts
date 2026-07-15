import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_ENDPOINT,
  MAX_RESPONSE_BYTES,
  awaitCancellation,
  classifyFindings,
  formatAuditReport,
  npmBulkAdvisoryResponseSchema,
  parsePnpmLockfile,
  requestAdvisories,
  runAudit,
  validateAdvisoryResponse,
  type AuditFinding,
} from "./audit-dependencies";

const inventory = { alpha: ["1.0.0"] };
const require = createRequire(import.meta.url);

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

async function runAuditCli(
  lockfileSource: string,
  advisoryResponse: unknown,
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "coredot-audit-cli-"));
  const preloadPath = join(temporaryDirectory, "mock-fetch.mjs");
  const scriptPath = resolve(import.meta.dirname, "audit-dependencies.ts");
  const tsxLoaderPath = require.resolve("tsx");

  try {
    await writeFile(join(temporaryDirectory, "pnpm-lock.yaml"), lockfileSource, "utf8");
    await writeFile(preloadPath, `
const endpoint = ${JSON.stringify(AUDIT_ENDPOINT)};
const responseBody = JSON.parse(process.env.AUDIT_TEST_RESPONSE ?? "{}");
globalThis.fetch = async (input, init) => {
  if (String(input) !== endpoint) throw new Error("Unexpected audit endpoint");
  if (new Headers(init?.headers).has("authorization")) throw new Error("Unexpected authorization header");
  return new Response(JSON.stringify(responseBody), { status: 200 });
};
`, "utf8");

    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        "--import",
        tsxLoaderPath,
        "--import",
        pathToFileURL(preloadPath).href,
        scriptPath,
      ], {
        cwd: temporaryDirectory,
        env: {
          ...process.env,
          AUDIT_TEST_RESPONSE: JSON.stringify(advisoryResponse),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let stdout = "";
      const timeout = setTimeout(() => {
        child.kill();
        rejectRun(new Error("Dependency audit CLI test timed out"));
      }, 10_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectRun(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        resolveRun({ exitCode, stderr, stdout });
      });
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
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
    [
      "lockfileVersion: '9.0'\npackages:\n  \"bad\\u007fname@1.0.0\":\n    resolution: {integrity: sha512-one}\n",
      "package key",
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
  it("rejects an own __proto__ package key before schema transformation", () => {
    const body = JSON.parse(
      `{"__proto__":${JSON.stringify([advisory()])}}`,
    ) as Record<string, unknown>;
    const requestedPackages = Object.create(null) as Record<string, string[]>;
    requestedPackages.__proto__ = ["1.0.0"];

    expect(Object.hasOwn(body, "__proto__")).toBe(true);
    expect(() => validateAdvisoryResponse(body, requestedPackages))
      .toThrow("package name");
  });

  it.each(["constructor", "prototype"])(
    "preserves the safely handled prototype-sensitive package key %s",
    (packageName) => {
      const body = JSON.parse(JSON.stringify({
        [packageName]: [advisory()],
      })) as Record<string, unknown>;
      const requestedPackages = Object.create(null) as Record<string, string[]>;
      requestedPackages[packageName] = ["1.0.0"];

      expect(Object.hasOwn(body, packageName)).toBe(true);
      expect(validateAdvisoryResponse(body, requestedPackages)).toEqual([
        advisory({ name: packageName }),
      ]);
    },
  );

  it("uses a noncoercing Zod boundary and strips legitimate npm metadata", () => {
    const base = {
      id: 123,
      severity: "low",
      title: "Example advisory",
      url: "https://github.com/advisories/GHSA-example",
      vulnerable_versions: "<1.0.1",
    };

    expect(npmBulkAdvisoryResponseSchema.safeParse({
      alpha: [{ ...base, id: "123" }],
    }).success).toBe(false);
    expect(npmBulkAdvisoryResponseSchema.parse({
      alpha: [{
        ...base,
        cvss: { score: 3.1, vectorString: "CVSS:3.1/example" },
        cwe: ["CWE-79"],
      }],
    })).toEqual({ alpha: [base] });
  });

  it.each([
    [{ alpha: [advisory({ id: "123" })] }, "id"],
    [{ alpha: [advisory({ title: 123 })] }, "title"],
    [{ alpha: [advisory({ url: null })] }, "URL"],
    [{ alpha: [advisory({ vulnerable_versions: ["<1.0.1"] })] }, "vulnerable_versions"],
    [{ alpha: [advisory({ severity: 1 })] }, "severity"],
    [{ alpha: [null] }, "entry"],
    [{ alpha: null }, "bucket"],
  ])("rejects wrong boundary field and bucket types", (body, safeField) => {
    expect(() => validateAdvisoryResponse(body, inventory)).toThrow(safeField);
  });

  it("accepts empty and valid requested advisory buckets", () => {
    const registryAdvisory: Record<string, unknown> = { ...advisory() };
    delete registryAdvisory.name;

    expect(validateAdvisoryResponse({}, inventory)).toEqual([]);
    expect(validateAdvisoryResponse({ alpha: [registryAdvisory] }, inventory)).toEqual([
      advisory(),
    ]);
  });

  it("keeps ordinary Unicode titles valid", () => {
    expect(validateAdvisoryResponse({
      alpha: [advisory({ title: "일반 취약점 – café" })],
    }, inventory)).toEqual([
      advisory({ title: "일반 취약점 – café" }),
    ]);
  });

  it.each([
    ["line feed", "Unsafe title\n::error file=secret::injected"],
    ["carriage return", "Unsafe title\rinjected"],
    ["escape", "Unsafe title\u001b[31mred"],
    ["C0 control", "Unsafe title\u0000hidden"],
    ["C1 control", "Unsafe title\u0085hidden"],
    ["Unicode line separator", "Unsafe title\u2028injected"],
  ])("rejects %s in advisory output fields", (_label, title) => {
    expect(() => validateAdvisoryResponse({ alpha: [advisory({ title })] }, inventory))
      .toThrow("title");
  });

  it("rejects controls in URL, vulnerable range, and package name fields", () => {
    expect(() => validateAdvisoryResponse({
      alpha: [advisory({ url: "https://example.com/\u001binjected" })],
    }, inventory)).toThrow("URL");
    expect(() => validateAdvisoryResponse({
      alpha: [advisory({ vulnerable_versions: "<1.0.1\n::error::injected" })],
    }, inventory)).toThrow("vulnerable_versions");
    expect(() => validateAdvisoryResponse({
      "alpha\u007f": [advisory()],
    }, { "alpha\u007f": ["1.0.0"] })).toThrow("package name");
  });

  it.each([
    [null, "top-level"],
    [[], "top-level"],
    [{ alpha: {} }, "bucket"],
    [{ unexpected: [] }, "requested"],
    [{ alpha: [advisory({ id: Number.NaN })] }, "id"],
    [{ alpha: [advisory({ id: 0 })] }, "id"],
    [{ alpha: [advisory({ id: -1 })] }, "id"],
    [{ alpha: [advisory({ id: 1.5 })] }, "id"],
    [{ alpha: [advisory({ id: Number.MAX_SAFE_INTEGER + 1 })] }, "id"],
    [{ alpha: [advisory({ title: undefined })] }, "title"],
    [{ alpha: [advisory({ title: "" })] }, "title"],
    [{ alpha: [advisory({ url: "file:///tmp/advisory" })] }, "URL"],
    [{ alpha: [advisory({ vulnerable_versions: "" })] }, "vulnerable_versions"],
    [{ alpha: [advisory({ vulnerable_versions: "not a semver range" })] }, "semver range"],
    [{ alpha: [advisory({ vulnerable_versions: ">=2.0.0" })] }, "submitted version"],
    [{ alpha: [advisory({ severity: "urgent" })] }, "severity"],
    [{ alpha: [advisory({ severity: "toString" })] }, "severity"],
    [{ alpha: [advisory({ severity: "constructor" })] }, "severity"],
  ])("rejects malformed advisory data", (body, message) => {
    expect(() => validateAdvisoryResponse(body, inventory)).toThrow(message);
  });

  it("rejects duplicate advisory IDs within a package", () => {
    expect(() => validateAdvisoryResponse({
      alpha: [advisory(), advisory({ title: "Duplicate copy" })],
    }, inventory)).toThrow("duplicate");
  });

  it("intentionally includes prerelease package versions when checking vulnerable ranges", () => {
    expect(validateAdvisoryResponse({
      alpha: [advisory({ vulnerable_versions: "<1.0.0" })],
    }, { alpha: ["1.0.0-beta.1"] })).toEqual([
      advisory({ vulnerable_versions: "<1.0.0" }),
    ]);
  });
});

describe("requestAdvisories", () => {
  it("cannot miss an abort between checking and registering its cleanup listener", async () => {
    let abortListener: (() => void) | undefined;
    let firstAbortedRead = true;
    const signal = {
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        abortListener = typeof listener === "function"
          ? () => listener(new Event("abort"))
          : () => listener.handleEvent(new Event("abort"));
      },
      get aborted() {
        if (firstAbortedRead) {
          firstAbortedRead = false;
          abortListener?.();
          return false;
        }
        return true;
      },
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const neverSettles = new Promise<void>(() => undefined);

    const outcome = await Promise.race([
      awaitCancellation(neverSettles, signal).then(() => "completed"),
      new Promise<string>((resolveStalled) => {
        setTimeout(() => resolveStalled("stalled"), 0);
      }),
    ]);

    expect(outcome).toBe("completed");
  });

  it("posts only the deterministic package inventory and accepts no Content-Type response", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.body).toBe(JSON.stringify(inventory));
      expect(init?.redirect).toBe("manual");
      return responseBody({ alpha: [advisory()] });
    });

    await expect(requestAdvisories(inventory, { fetchImpl })).resolves.toEqual([advisory()]);
    expect(fetchImpl).toHaveBeenCalledWith(
      AUDIT_ENDPOINT,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([408, 429, 500, 503, 599])("retries retryable HTTP %i responses", async (status) => {
    const delay = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("retry", { status }))
      .mockResolvedValueOnce(responseBody({}));

    await expect(requestAdvisories(inventory, { delay, fetchImpl })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
  });

  it("treats redirects as nonretryable protocol failures without forwarding the body", async () => {
    const delay = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        headers: { location: "https://untrusted.example/redirect" },
        status: 307,
      });
    });

    await expect(requestAdvisories(inventory, { delay, fetchImpl })).rejects.toThrow("HTTP 307");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("does not retry status codes above the HTTP 5xx range", async () => {
    const delay = vi.fn(async () => undefined);
    const response = { body: null, ok: false, status: 600 } as Response;
    const fetchImpl = vi.fn(async () => response);

    await expect(requestAdvisories(inventory, { delay, fetchImpl })).rejects.toThrow("HTTP 600");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("waits for response cancellation before retrying", async () => {
    const events: string[] = [];
    let finishCancellation: (() => void) | undefined;
    let markCancellationStarted: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolveStarted) => {
      markCancellationStarted = resolveStarted;
    });
    const stream = new ReadableStream({
      cancel: () => {
        events.push("cancel-start");
        markCancellationStarted?.();
        return new Promise<void>((resolveCancellation) => {
          let finished = false;
          finishCancellation = () => {
            if (finished) return;
            finished = true;
            events.push("cancel-end");
            resolveCancellation();
          };
        });
      },
    });
    const fetchImpl = vi
      .fn(async () => {
        events.push(`fetch-${fetchImpl.mock.calls.length}`);
        return fetchImpl.mock.calls.length === 1
          ? new Response(stream, { status: 503 })
          : responseBody({});
      });
    const pending = requestAdvisories(inventory, {
      delay: async () => undefined,
      fetchImpl,
    });

    try {
      await cancellationStarted;
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchImpl).toHaveBeenCalledOnce();
      finishCancellation?.();
      await expect(pending).resolves.toEqual([]);
    } finally {
      finishCancellation?.();
      await pending.catch(() => undefined);
    }

    expect(events).toEqual(["fetch-1", "cancel-start", "cancel-end", "fetch-2"]);
  });

  it("awaits oversized-body reader cancellation and releases its lock", async () => {
    let finishCancellation: (() => void) | undefined;
    let markCancellationStarted: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolveStarted) => {
      markCancellationStarted = resolveStarted;
    });
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
      },
      cancel: () => {
        markCancellationStarted?.();
        return new Promise<void>((resolveCancellation) => {
          finishCancellation = resolveCancellation;
        });
      },
    });
    const pending = requestAdvisories(inventory, {
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    }).catch(() => undefined);

    try {
      await cancellationStarted;
      await Promise.resolve();
      expect(settled).toBe(false);
      finishCancellation?.();
      await expect(pending).rejects.toThrow("5 MiB");
    } finally {
      finishCancellation?.();
      await pending.catch(() => undefined);
    }

    expect(stream.locked).toBe(false);
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
    const streams: ReadableStream[] = [];
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream({ pull: () => undefined });
      streams.push(stream);
      return new Response(stream, { status: 200 });
    });

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
      expect(streams.every((stream) => !stream.locked)).toBe(true);
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

  it("fails closed when preconstructed findings bypass severity validation", () => {
    expect(() => classifyFindings([
      advisory({ severity: "constructor" }),
    ])).toThrow("severity");
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

  it("defensively rejects controls when formatting preconstructed findings", () => {
    expect(() => formatAuditReport([
      advisory({ title: "Unsafe\n::error::injected" }),
    ])).toThrow("title");
    expect(() => formatAuditReport([
      advisory({ name: "alpha\u007f" }),
    ])).toThrow("package name");
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

  it.each([
    ["log controls", { alpha: [advisory({ title: "Unsafe\n::error::injected" })] }],
    ["an invalid range", { alpha: [advisory({ vulnerable_versions: "invalid range" })] }],
    ["an irrelevant range", { alpha: [advisory({ vulnerable_versions: ">=2.0.0" })] }],
    ["a duplicate advisory", { alpha: [advisory(), advisory()] }],
  ])("returns operational exit 2 without findings for %s", async (_label, body) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const source = "lockfileVersion: '9.0'\npackages:\n  alpha@1.0.0:\n    resolution: {integrity: sha512-one}\n";

    await expect(runAudit({
      fetchImpl: async () => responseBody(body),
      lockfileSource: source,
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([expect.stringContaining("Dependency audit failed")]);
    expect(stderr.join("\n")).not.toContain("::error");
  });

  it("rejects a controlled lockfile package name without reflecting it to stderr", async () => {
    const stderr: string[] = [];
    const controlledName = "alpha\u007f";
    const source = `lockfileVersion: '9.0'\npackages:\n  "${controlledName}@1.0.0":\n    resolution: {integrity: sha512-one}\n`;

    await expect(runAudit({
      fetchImpl: async () => responseBody({}),
      lockfileSource: source,
      stderr: (line) => stderr.push(line),
      stdout: () => undefined,
    })).resolves.toBe(2);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain(controlledName);
    expect(stderr[0]).not.toContain("\u007f");
  });

  it.each([
    ["wrong field type", { alpha: [advisory({ id: "123\n::error::secret" })] }],
    ["array top level", ["secret\n::error::injected"]],
    ["null top level", null],
    ["bad bucket", { alpha: { secret: "\n::error::injected" } }],
    ["controlled package path", { "secret\n::error::injected": null }],
  ])("returns exit 2 for Zod boundary failure without reflecting %s payloads", async (
    _label,
    body,
  ) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const source = "lockfileVersion: '9.0'\npackages:\n  alpha@1.0.0:\n    resolution: {integrity: sha512-one}\n";

    await expect(runAudit({
      fetchImpl: async () => responseBody(body),
      lockfileSource: source,
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr.join("\n")).not.toMatch(/secret|injected|::error/);
  });

  it("fails closed when Zod would drop an own __proto__ response bucket", async () => {
    const hostileAdvisory = {
      id: 123,
      severity: "low",
      title: "secret\n::error::injected",
      url: "https://github.com/advisories/GHSA-example",
      vulnerable_versions: "<1.0.1",
    };
    const body = JSON.parse(`{"__proto__":[${JSON.stringify(hostileAdvisory)}]}`) as unknown;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const source = "lockfileVersion: '9.0'\npackages:\n  alpha@1.0.0:\n    resolution: {integrity: sha512-one}\n";

    expect(Object.hasOwn(body as object, "__proto__")).toBe(true);
    await expect(runAudit({
      fetchImpl: async () => responseBody(body),
      lockfileSource: source,
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr.join("\n")).not.toMatch(/__proto__|secret|injected|::error/);
  });
});

describe("dependency audit CLI entrypoint", () => {
  const validLockfile = "lockfileVersion: '9.0'\npackages:\n  alpha@1.0.0:\n    resolution: {integrity: sha512-one}\n";

  it.each([
    ["no release-blocking findings", validLockfile, {}, 0],
    [
      "a moderate finding",
      validLockfile,
      { alpha: [advisory({ severity: "moderate" })] },
      1,
    ],
    ["an invalid lockfile", "not a pnpm lockfile", {}, 2],
  ])("sets the expected process exit code for %s", async (_label, lockfile, body, expectedExitCode) => {
    const result = await runAuditCli(lockfile, body);

    expect(result.exitCode).toBe(expectedExitCode);
    if (expectedExitCode === 2) {
      expect(result.stderr).toContain("Dependency audit failed");
    } else {
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Release threshold: moderate or higher.");
    }
  });
});
