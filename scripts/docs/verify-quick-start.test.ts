import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  assertQuickStartResponse,
  createQuickStartEnvironment,
  listTrackedWorkingFiles,
  runCleanupSteps,
} from "./verify-quick-start";
import {
  assertHttpContracts,
  copyDocumentedEnvironmentTemplate,
  copyTrackedWorkingFiles,
  resolvePnpmInvocation,
  runCleanupWorker,
  startQuickStartServerWithRetry,
  waitForReadiness,
} from "./verify-quick-start-internal";
import {
  createCleanupWorkerEnvironment,
  createToolEnvironment,
} from "./verify-quick-start-shared";
import { copyTrackedWorkingFilesWithHooks } from "./verify-quick-start-snapshot";

const execFileAsync = promisify(execFile);

async function createTemporaryRepository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "coredot-quick-start-test-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });

  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  await execFileAsync("git", ["add", "--all"], { cwd: root });
  return root;
}

describe("quick-start environment", () => {
  it("inherits only tool paths and replaces every application value with an isolated test value", () => {
    const environment = createQuickStartEnvironment(
      {
        AI_PROVIDER: "openai",
        AUTH_MODE: "clerk",
        AWS_SECRET_ACCESS_KEY: "real-aws-secret",
        CI: "true",
        CLERK_SECRET_KEY: "real-clerk-secret",
        DATABASE_AUTH_TOKEN: "real-database-secret",
        DATABASE_URL: "libsql://private.example",
        HOME: "/tmp/quick-start-home",
        HTTPS_PROXY: "https://proxy.example/secret-token",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "real-publishable-key",
        NEXT_PUBLIC_PRIVATE_CONFIG: "private-next-config",
        NODE_ENV: "production",
        NODE_OPTIONS: "--require=/tmp/secret-hook.cjs",
        OPENAI_API_KEY: "real-openai-secret",
        PATH: "/usr/bin:/bin",
        PNPM_HOME: "/tmp/pnpm-home",
        TEST_PRINCIPAL_ID: "ambient-principal",
        TEST_WORKSPACE_ID: "ambient-workspace",
        TURSO_AUTH_TOKEN: "real-turso-secret",
      },
      {
        databaseUrl: "file:/tmp/coredot-quick-start/database.sqlite",
        port: 43123,
      },
    );

    expect(environment).toEqual({
      AI_PROVIDER: "stub",
      AUTH_MODE: "test",
      CI: "true",
      DATABASE_URL: "file:/tmp/coredot-quick-start/database.sqlite",
      HOME: "/tmp/quick-start-home",
      HOSTNAME: "127.0.0.1",
      PATH: "/usr/bin:/bin",
      PNPM_HOME: "/tmp/pnpm-home",
      PORT: "43123",
      TEST_PRINCIPAL_ID: "test:principal:docs-quick-start",
      TEST_WORKSPACE_ID: "test:workspace:docs-quick-start",
    });
    expect(JSON.stringify(environment)).not.toMatch(
      /(?:real-|private-next|ambient-|proxy\.example|secret-hook)/,
    );
  });
});

describe("pnpm invocation", () => {
  it("uses Node with a verified JavaScript CLI on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "coredot-pnpm-cli-test-"));
    const pnpmCli = join(root, "pnpm.cjs");
    await writeFile(pnpmCli, "// test pnpm CLI\n", "utf8");

    try {
      const invocation = await resolvePnpmInvocation(
        "win32",
        { npm_execpath: pnpmCli },
        "C:\\Program Files\\nodejs\\node.exe",
      );

      expect(invocation).toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        prefixArguments: [await realpath(pnpmCli)],
      });
      expect(invocation.command.toLowerCase()).not.toMatch(/\.cmd$/);
      expect(invocation).not.toHaveProperty("shell");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails generically on Windows when no safe JavaScript CLI is available", async () => {
    await expect(
      resolvePnpmInvocation("win32", {}, "C:\\Program Files\\nodejs\\node.exe"),
    ).rejects.toThrow("Quick-start package runner failed");
  });
});

describe("quick-start port candidates", () => {
  it("retries a fresh candidate within one start deadline after the first server exits", async () => {
    const candidates = [43_101, 43_102];
    const startedPorts: number[] = [];
    const stoppedPorts: number[] = [];
    const readinessDeadlines: number[] = [];
    const deadline = Date.now() + 60_000;

    const result = await startQuickStartServerWithRetry({
      deadline,
      findPortCandidate: async () => {
        const candidate = candidates.shift();
        if (candidate === undefined) throw new Error("no candidate");
        return candidate;
      },
      startServer: (port) => {
        startedPorts.push(port);
        return {
          server: { port },
          serverExit:
            port === 43_101
              ? Promise.resolve({ code: 1, error: false, signal: null })
              : new Promise<never>(() => undefined),
        };
      },
      stopServer: async (server) => {
        stoppedPorts.push(server.port);
      },
      waitForReady: async (baseUrl, serverExit, absoluteDeadline) => {
        readinessDeadlines.push(absoluteDeadline);
        if (baseUrl.endsWith(":43101")) {
          await serverExit;
          throw new Error("first candidate was lost");
        }
      },
    });

    expect(result.port).toBe(43_102);
    expect(result.baseUrl).toBe("http://127.0.0.1:43102");
    expect(startedPorts).toEqual([43_101, 43_102]);
    expect(stoppedPorts).toEqual([43_101]);
    expect(readinessDeadlines).toEqual([deadline, deadline]);
  });
});

describe("tracked working-file snapshot", () => {
  it("copies current tracked contents and the two public environment examples only", async () => {
    const root = await createTemporaryRepository({
      ".env.docker.example": "PUBLIC_DOCKER=true\n",
      ".env.example": "PUBLIC_LOCAL=true\n",
      "src/app.ts": "export const version = 'indexed';\n",
    });
    const destination = await mkdtemp(join(tmpdir(), "coredot-quick-start-copy-"));

    try {
      await writeFile(join(root, "src/app.ts"), "export const version = 'working';\n");
      await writeFile(join(root, ".env.local"), "OPENAI_API_KEY=private\n");

      expect(await listTrackedWorkingFiles(root)).toEqual([
        ".env.docker.example",
        ".env.example",
        "src/app.ts",
      ]);
      await copyTrackedWorkingFiles(root, destination);

      await expect(readFile(join(destination, "src/app.ts"), "utf8")).resolves.toBe(
        "export const version = 'working';\n",
      );
      await expect(readFile(join(destination, ".env.local"), "utf8")).rejects.toThrow();

      await copyDocumentedEnvironmentTemplate(destination);
      expect(await readFile(join(destination, ".env.local"))).toEqual(
        await readFile(join(destination, ".env.example")),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(destination, { force: true, recursive: true });
    }
  });

  it("keeps dirty blobs out of real and ambient Git object directories", async () => {
    const root = await createTemporaryRepository({
      ".env.example": "PUBLIC_LOCAL=true\n",
      "src/app.ts": "export const value = 'indexed';\n",
    });
    const destination = await mkdtemp(join(tmpdir(), "coredot-quick-start-copy-"));
    const ambientObjects = await mkdtemp(join(tmpdir(), "coredot-ambient-objects-"));
    const ambientAlternates = await mkdtemp(
      join(tmpdir(), "coredot-ambient-alternates-"),
    );
    const secretContent = "export const value = 'unique-dirty-secret-9f3d2a';\n";
    const gitEnvironment = createToolEnvironment(process.env);
    const ambientIndex = join(root, "ambient-index");
    const snapshotDirectoryNames = async () =>
      (await readdir(tmpdir()))
        .filter((name) =>
          /^coredot-quick-start-(?:index|snapshot)-/.test(name),
        )
        .sort();
    const originalGitEnvironment = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES:
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
    };

    try {
      await mkdir(join(ambientObjects, "info"), { recursive: true });
      await mkdir(join(ambientObjects, "pack"), { recursive: true });
      await mkdir(join(ambientAlternates, "info"), { recursive: true });
      await mkdir(join(ambientAlternates, "pack"), { recursive: true });
      await writeFile(join(root, "src/app.ts"), secretContent, "utf8");
      const { stdout } = await execFileAsync(
        "git",
        ["hash-object", "--", "src/app.ts"],
        { cwd: root, env: gitEnvironment },
      );
      const dirtyObjectId = stdout.trim();
      const assertRealObjectMissing = () =>
        expect(
          execFileAsync("git", ["cat-file", "-e", dirtyObjectId], {
            cwd: root,
            env: gitEnvironment,
          }),
        ).rejects.toThrow();
      const snapshotDirectoriesBefore = await snapshotDirectoryNames();

      await assertRealObjectMissing();
      process.env.GIT_OBJECT_DIRECTORY = ambientObjects;
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = ambientAlternates;
      process.env.GIT_INDEX_FILE = ambientIndex;
      try {
        await expect(listTrackedWorkingFiles(root)).resolves.toContain(
          "src/app.ts",
        );
        await copyTrackedWorkingFiles(root, destination);
      } finally {
        for (const [name, value] of Object.entries(originalGitEnvironment)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }

      await assertRealObjectMissing();
      await expect(readFile(join(destination, "src/app.ts"), "utf8")).resolves.toBe(
        secretContent,
      );
      await expect(
        readFile(
          join(ambientObjects, dirtyObjectId.slice(0, 2), dirtyObjectId.slice(2)),
        ),
      ).rejects.toThrow();
      await expect(
        readFile(
          join(
            ambientAlternates,
            dirtyObjectId.slice(0, 2),
            dirtyObjectId.slice(2),
          ),
        ),
      ).rejects.toThrow();
      await expect(readFile(ambientIndex)).rejects.toThrow();
      expect(await snapshotDirectoryNames()).toEqual(snapshotDirectoriesBefore);
    } finally {
      for (const [name, value] of Object.entries(originalGitEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { force: true, recursive: true });
      await rm(destination, { force: true, recursive: true });
      await rm(ambientObjects, { force: true, recursive: true });
      await rm(ambientAlternates, { force: true, recursive: true });
    }
  });

  it("rejects a repository that does not track the documented environment template", async () => {
    const root = await createTemporaryRepository({ "safe.txt": "safe\n" });
    try {
      await expect(listTrackedWorkingFiles(root)).rejects.toThrow(
        "Quick-start snapshot failed",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a working tree where the tracked environment template was deleted", async () => {
    const root = await createTemporaryRepository({
      ".env.example": "PUBLIC_LOCAL=true\n",
      "safe.txt": "safe\n",
    });
    try {
      await unlink(join(root, ".env.example"));

      await expect(listTrackedWorkingFiles(root)).rejects.toThrow(
        "Quick-start snapshot failed",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    "nested/.env.production",
    "data/local.db",
    "data/local.sqlite.backup",
    "node_modules/pkg/index.js",
    ".next/server/app.js",
    "site/index.html",
    ".superpowers/private-plan.md",
    "docs/superpowers/private-plan.md",
  ])("rejects a tracked private or generated path: %s", async (file) => {
    const root = await createTemporaryRepository({ "safe.txt": "safe\n" });
    try {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "private\n", "utf8");
      await execFileAsync("git", ["add", "--force", "--", file], { cwd: root });

      await expect(listTrackedWorkingFiles(root)).rejects.toThrow(
        "Quick-start snapshot failed",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects tracked symlinks instead of following them", async () => {
    const root = await createTemporaryRepository({ "safe.txt": "safe\n" });
    const outside = await mkdtemp(join(tmpdir(), "coredot-quick-start-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "private\n", "utf8");
      await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
      await execFileAsync("git", ["add", "--", "escape.txt"], { cwd: root });

      await expect(listTrackedWorkingFiles(root)).rejects.toThrow(
        "Quick-start snapshot failed",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects a tracked file whose working parent was replaced by a path escape", async () => {
    const root = await createTemporaryRepository({
      ".env.example": "PUBLIC_LOCAL=true\n",
      "linked/file.txt": "indexed\n",
    });
    const outside = await mkdtemp(join(tmpdir(), "coredot-quick-start-outside-"));
    try {
      await writeFile(join(outside, "file.txt"), "private\n", "utf8");
      await unlink(join(root, "linked/file.txt"));
      await rm(join(root, "linked"), { recursive: true });
      await symlink(outside, join(root, "linked"));

      await expect(listTrackedWorkingFiles(root)).rejects.toThrow(
        "Quick-start snapshot failed",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects a parent symlink swapped in after alternate-index population", async () => {
    const root = await createTemporaryRepository({
      ".env.example": "PUBLIC_LOCAL=true\n",
      "linked/file.txt": "indexed\n",
    });
    const destination = await mkdtemp(join(tmpdir(), "coredot-quick-start-copy-"));
    const outside = await mkdtemp(join(tmpdir(), "coredot-quick-start-outside-"));
    try {
      await writeFile(join(outside, "file.txt"), "private\n", "utf8");

      await expect(
        copyTrackedWorkingFilesWithHooks(root, destination, {
          afterIndexPopulation: async () => {
            await rm(join(root, "linked"), { recursive: true });
            await symlink(outside, join(root, "linked"));
          },
        }),
      ).rejects.toThrow("Quick-start snapshot failed");
      await expect(
        readFile(join(destination, "linked/file.txt"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(destination, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("copies regular tracked files when O_NOFOLLOW is unavailable", async () => {
    const root = await createTemporaryRepository({
      ".env.example": "PUBLIC_LOCAL=true\n",
      "src/app.ts": "export const portable = true;\n",
    });
    const destination = await mkdtemp(join(tmpdir(), "coredot-quick-start-copy-"));
    const openedFiles: string[] = [];
    try {
      await copyTrackedWorkingFilesWithHooks(root, destination, {
        afterSafeOpen: async (file) => {
          openedFiles.push(file);
        },
        noFollowFlag: null,
      });

      await expect(readFile(join(destination, "src/app.ts"), "utf8")).resolves.toBe(
        "export const portable = true;\n",
      );
      expect(openedFiles).toEqual([".env.example", "src/app.ts"]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(destination, { force: true, recursive: true });
    }
  });

  it("rejects a final symlink race without relying on O_NOFOLLOW", async () => {
    const root = await createTemporaryRepository({
      ".env.example": "PUBLIC_LOCAL=true\n",
      "file.txt": "indexed\n",
    });
    const destination = await mkdtemp(join(tmpdir(), "coredot-quick-start-copy-"));
    const outside = await mkdtemp(join(tmpdir(), "coredot-quick-start-outside-"));
    const openedFiles: string[] = [];
    try {
      await writeFile(join(outside, "file.txt"), "private\n", "utf8");

      await expect(
        copyTrackedWorkingFilesWithHooks(root, destination, {
          afterIndexPopulation: async () => {
            await unlink(join(root, "file.txt"));
            await symlink(join(outside, "file.txt"), join(root, "file.txt"));
          },
          afterSafeOpen: async (file) => {
            openedFiles.push(file);
          },
          noFollowFlag: null,
        }),
      ).rejects.toThrow("Quick-start snapshot failed");
      expect(openedFiles).toContain("file.txt");
      await expect(readFile(join(destination, "file.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(destination, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects a parent symlink without relying on O_NOFOLLOW", async () => {
    const root = await createTemporaryRepository({
      ".env.example": "PUBLIC_LOCAL=true\n",
      "linked/file.txt": "indexed\n",
    });
    const destination = await mkdtemp(join(tmpdir(), "coredot-quick-start-copy-"));
    const outside = await mkdtemp(join(tmpdir(), "coredot-quick-start-outside-"));
    const openedFiles: string[] = [];
    try {
      await writeFile(join(outside, "file.txt"), "private\n", "utf8");

      await expect(
        copyTrackedWorkingFilesWithHooks(root, destination, {
          afterIndexPopulation: async () => {
            await rm(join(root, "linked"), { recursive: true });
            await symlink(outside, join(root, "linked"));
          },
          afterSafeOpen: async (file) => {
            openedFiles.push(file);
          },
          noFollowFlag: null,
        }),
      ).rejects.toThrow("Quick-start snapshot failed");
      expect(openedFiles).not.toContain("linked/file.txt");
      await expect(
        readFile(join(destination, "linked/file.txt"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(destination, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });
});

describe("quick-start HTTP contract", () => {
  it("accepts a bounded generic 2xx documents response without UI-copy coupling", async () => {
    await expect(
      assertQuickStartResponse(
        new Response("<html><body><h1>Documents</h1></body></html>", {
          status: 200,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not treat the root redirect as a successful documents response", async () => {
    await expect(
      assertQuickStartResponse(
        new Response(null, {
          headers: { Location: "/documents" },
          status: 307,
        }),
      ),
    ).rejects.toThrow("Quick-start HTTP contract failed");
  });

  it("uses a bounded body and generic errors that do not echo response content", async () => {
    const privateBody = "libsql://user:secret-token@private.example";
    await expect(
      assertQuickStartResponse(new Response(privateBody, { status: 503 })),
    ).rejects.toThrow("Quick-start HTTP contract failed");

    const oversized = `${"x".repeat(2 * 1024 * 1024)}<h1>문서</h1>`;
    await expect(
      assertQuickStartResponse(
        new Response(oversized, {
          headers: { "Content-Type": "text/html" },
          status: 200,
        }),
      ),
    ).rejects.toThrow("Quick-start HTTP contract failed");
  });

  it("shares one absolute five-second budget across root and documents requests", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let callCount = 0;
    let failure: unknown;
    let settledAt: number | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolveResponse, reject) => {
          callCount += 1;
          const currentCall = callCount;
          const timer = setTimeout(() => {
            removeAbortListener();
            resolveResponse(
              currentCall === 1
                ? new Response(null, {
                    headers: { Location: "/documents" },
                    status: 307,
                  })
                : new Response("generic documents page", { status: 200 }),
            );
          }, 3_000);
          const signal = init?.signal;
          const handleAbort = () => {
            clearTimeout(timer);
            removeAbortListener();
            reject(new Error("request aborted"));
          };
          const removeAbortListener = () =>
            signal?.removeEventListener("abort", handleAbort);
          signal?.addEventListener("abort", handleAbort, { once: true });
        }),
    );

    const pending = assertHttpContracts("http://127.0.0.1:43123")
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settledAt = Date.now();
      });

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(failure).toEqual(new Error("Quick-start HTTP request failed"));
      expect(settledAt).toBe(startedAt + 5_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe("quick-start cleanup", () => {
  it("spawns cleanup workers with only the explicit platform environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "coredot-cleanup-env-test-"));
    const output = join(root, "environment.json");
    const baseEnvironment = {
      CLERK_SECRET_KEY: "private-clerk",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      DATABASE_URL: "libsql://private.example",
      HOME: "/private/home",
      HTTPS_PROXY: "https://private-proxy.example",
      NEXT_PUBLIC_PRIVATE_CONFIG: "private-public-config",
      NODE_OPTIONS: "--require=/private/hook.cjs",
      OPENAI_API_KEY: "private-openai",
      PATH: "/private/bin",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Tmp",
      TMPDIR: "/safe/tmp",
      TURSO_AUTH_TOKEN: "private-turso",
    } as unknown as NodeJS.ProcessEnv;
    const expectedEnvironment = {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Tmp",
      TMPDIR: "/safe/tmp",
    };

    try {
      expect(createCleanupWorkerEnvironment(baseEnvironment)).toEqual(
        expectedEnvironment,
      );
      await runCleanupWorker(
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env));",
          output,
        ],
        new AbortController().signal,
        undefined,
        baseEnvironment,
      );

      const workerEnvironment = JSON.parse(await readFile(output, "utf8")) as
        Record<string, string>;
      // macOS injects this locale value after spawn even when env is explicit.
      delete workerEnvironment.__CF_USER_TEXT_ENCODING;
      expect(workerEnvironment).toEqual(expectedEnvironment);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("attempts every cleanup action and reports only a generic failure", async () => {
    const calls: string[] = [];

    await expect(
      runCleanupSteps([
        async () => {
          calls.push("process");
          throw new Error("private process detail");
        },
        async () => {
          calls.push("repository");
        },
        async () => {
          calls.push("database");
        },
      ]),
    ).rejects.toThrow("Quick-start cleanup failed");

    expect(calls).toEqual(["process", "repository", "database"]);
  });

  it("runs independent six-second cleanup steps concurrently and clears the phase timer", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const attempts: string[] = [];
    const completions: string[] = [];
    let failure: unknown;
    let settledAt: number | undefined;
    const step = (name: string) => async () => {
      attempts.push(name);
      await new Promise<void>((resolveStep) => {
        setTimeout(resolveStep, 6_000);
      });
      completions.push(name);
    };

    const pending = runCleanupSteps([step("process"), step("files")])
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settledAt = Date.now();
      });

    try {
      await vi.advanceTimersByTimeAsync(6_000);

      expect(failure).toBeUndefined();
      expect(settledAt).toBe(startedAt + 6_000);
      expect(attempts).toEqual(["process", "files"]);
      expect(completions).toEqual(["process", "files"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      vi.useRealTimers();
    }
  });

  it("attempts every cleanup step and fails generically at the shared ten-second deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const attempts: string[] = [];
    let failure: unknown;
    let settledAt: number | undefined;
    let abortedStepSettled = false;
    const pending = runCleanupSteps([
      async (signal) => {
        attempts.push("never-settles");
        await new Promise<void>((resolveStep) => {
          const handleAbort = () => {
            signal.removeEventListener("abort", handleAbort);
            resolveStep();
          };
          signal.addEventListener("abort", handleAbort, { once: true });
        });
        abortedStepSettled = true;
      },
      async () => {
        attempts.push("fast");
      },
    ])
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settledAt = Date.now();
      });

    try {
      await vi.advanceTimersByTimeAsync(10_000);

      expect(failure).toEqual(new Error("Quick-start cleanup failed"));
      expect(settledAt).toBe(startedAt + 10_000);
      expect(attempts).toEqual(["never-settles", "fast"]);
      expect(abortedStepSettled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await pending;
      vi.useRealTimers();
    }
  });

  it("aborts a real cleanup worker without a timer, worker, or process tail", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const tsxCommand = resolve(root, "node_modules/.bin/tsx");
    const program = [
      "import { runCleanupSteps } from './scripts/docs/verify-quick-start.ts';",
      "import { runCleanupWorker } from './scripts/docs/verify-quick-start-internal.ts';",
      "const startedAt = Date.now();",
      "let workerPid = 0;",
      "runCleanupSteps([(signal) => runCleanupWorker(",
      "  ['-e', 'setInterval(() => undefined, 1000)'],",
      "  signal,",
      "  (pid) => { workerPid = pid; },",
      ")])",
      "  .then(() => { process.exitCode = 2; })",
      "  .catch(async (error) => {",
      "    await new Promise((resolve) => setTimeout(resolve, 0));",
      "    process.stdout.write(JSON.stringify({",
      "    activeResources: process.getActiveResourcesInfo().filter(",
      "      (resource) => resource === 'Timeout' || resource === 'ProcessWrap',",
      "    ),",
      "    elapsedMs: Date.now() - startedAt,",
      "    message: error instanceof Error ? error.message : 'unknown',",
      "    workerPid,",
      "    }));",
      "  });",
    ].join("\n");

    const { stderr, stdout } = await execFileAsync(
      tsxCommand,
      ["-e", program],
      { cwd: root, timeout: 20_000 },
    );
    const result = JSON.parse(stdout) as {
      activeResources: string[];
      elapsedMs: number;
      message: string;
      workerPid: number;
    };

    expect(stderr).toBe("");
    expect(result.message).toBe("Quick-start cleanup failed");
    expect(result.activeResources).toEqual([]);
    expect(result.workerPid).toBeGreaterThan(0);
    expect(() => process.kill(result.workerPid, 0)).toThrow();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(9_500);
    expect(result.elapsedMs).toBeLessThan(15_000);
  }, 20_000);
});

describe("quick-start readiness", () => {
  it("warms the documents route before reporting development readiness", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith("/api/ready")) {
          return Response.json({ status: "ready" }, { status: 200 });
        }
        if (url.endsWith("/documents")) {
          return new Response("generic documents page", { status: 200 });
        }
        throw new Error("unexpected request");
      },
    );

    try {
      await waitForReadiness(
        "http://127.0.0.1:43123",
        new Promise<never>(() => undefined),
      );

      expect(requestedUrls).toEqual([
        "http://127.0.0.1:43123/api/ready",
        "http://127.0.0.1:43123/documents",
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses only the remaining absolute sixty-second budget for stalled fetches", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let failure: unknown;
    let settledAt: number | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolveResponse, reject) => {
          const signal = init?.signal;
          const handleAbort = () => {
            signal?.removeEventListener("abort", handleAbort);
            reject(new Error("request aborted"));
          };
          signal?.addEventListener("abort", handleAbort, { once: true });
        }),
    );
    const serverExit = new Promise<never>(() => undefined);
    const pending = waitForReadiness(
      "http://127.0.0.1:43123",
      serverExit,
    )
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settledAt = Date.now();
      });

    try {
      await vi.advanceTimersByTimeAsync(60_000);

      expect(failure).toEqual(new Error("Quick-start readiness timed out"));
      expect(settledAt).toBe(startedAt + 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(12);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe("quick-start documentation wiring", () => {
  it("exports only the four supported runtime helpers", async () => {
    const quickStartModule = await import("./verify-quick-start");

    expect(Object.keys(quickStartModule).sort()).toEqual([
      "assertQuickStartResponse",
      "createQuickStartEnvironment",
      "listTrackedWorkingFiles",
      "runCleanupSteps",
    ]);
  });

  it("loads through the direct tsx runtime used by the package command", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const tsxCommand = resolve(root, "node_modules/.bin/tsx");

    await expect(
      execFileAsync(
        tsxCommand,
        ["-e", "import('./scripts/docs/verify-quick-start.ts')"],
        { cwd: root, timeout: 10_000 },
      ),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("keeps package, docs CI, and contributor commands aligned", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const workflow = await readFile(
      resolve(root, ".github/workflows/docs.yml"),
      "utf8",
    );
    const contributing = await readFile(resolve(root, "CONTRIBUTING.md"), "utf8");

    expect(packageJson.scripts["docs:verify-quick-start"]).toBe(
      "tsx scripts/docs/verify-quick-start.ts",
    );
    expect(workflow).toContain("run: pnpm docs:verify-quick-start");
    expect(workflow.indexOf("run: pnpm install --frozen-lockfile")).toBeLessThan(
      workflow.indexOf("run: pnpm docs:verify-quick-start"),
    );
    expect(workflow.indexOf("run: pnpm docs:verify-quick-start")).toBeLessThan(
      workflow.indexOf("run: pnpm docs:check-links"),
    );
    expect(workflow.indexOf("run: pnpm docs:check-links")).toBeLessThan(
      workflow.indexOf("run: pnpm docs:build"),
    );

    expect(contributing).toContain(
      "pnpm install\ncp .env.example .env.local\npnpm db:setup\npnpm dev",
    );
    expect(contributing).toContain("pnpm docs:verify-quick-start");
    expect(contributing).toContain("pnpm release:check");
    expect(contributing).toContain("AUTH_MODE=clerk");
    expect(contributing).toContain("CLERK_SECRET_KEY=sk_test_ci_build");
    expect(contributing).toContain(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
    );
    expect(contributing).toContain(
      "pnpm docs:check-links && pnpm docs:build",
    );
    expect(contributing).toMatch(/test-shaped verification values/i);
    expect(contributing).toMatch(/never production credentials/i);
  });
});
