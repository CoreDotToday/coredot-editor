import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { documentInterchange } from "../../src/features/documents/document-interchange";
import {
  NEXT_FONT_GOOGLE_URLS,
  DOCS_CAPTURE_STYLE,
  DOCS_LANGUAGE_STORAGE_KEY,
  DOCS_VIEWPORT,
  createCaptureEnvironment,
  createNextFontMockResponses,
  encodeWebpWithinBudget,
  isCaptureNetworkAllowed,
  runCaptureCleanup,
  screenshotPath,
  toNextFontMockFilePath,
  writeCapturesAtomically,
} from "./capture-assets";
import { createMixedFidelityDocx } from "./fixtures/mixed-fidelity-docx";

function createDeterministicPng() {
  const width = 720;
  const height = 450;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (index * 37 + Math.floor(index / 17) * 13) % 256;
  }
  return sharp(pixels, { raw: { channels: 3, height, width } }).png().toBuffer();
}

describe("docs capture constants", () => {
  it("uses the approved deterministic browser settings", () => {
    expect(DOCS_VIEWPORT).toEqual({ height: 1000, width: 1440 });
    expect(DOCS_LANGUAGE_STORAGE_KEY).toBe("coredot-editor-language");
  });

  it("suppresses native scrollbars so pointer timing cannot change pixels", () => {
    expect(DOCS_CAPTURE_STYLE).toContain("scrollbar-width: none !important");
    expect(DOCS_CAPTURE_STYLE).toContain("*::-webkit-scrollbar");
    expect(DOCS_CAPTURE_STYLE).toContain("height: 0 !important");
    expect(DOCS_CAPTURE_STYLE).toContain("width: 0 !important");
  });
});

describe("docs capture environment", () => {
  it("inherits only minimal tool values and replaces application settings", () => {
    const environment = createCaptureEnvironment(
      {
        AI_PROVIDER: "openai",
        AUTH_MODE: "clerk",
        AWS_SECRET_ACCESS_KEY: "real-aws-secret",
        CI: "true",
        CLERK_SECRET_KEY: "real-clerk-secret",
        DATABASE_AUTH_TOKEN: "real-database-secret",
        DATABASE_URL: "libsql://private.example",
        HOME: "/tmp/docs-home",
        HTTPS_PROXY: "https://proxy.example/secret-token",
        LANG: "en_US.UTF-8",
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
        databaseUrl: "file:/tmp/coredot-docs-capture/database.sqlite",
        fontMockPath: "/tmp/coredot-docs-capture/fonts.cjs",
        port: 43123,
        runNonce: "capture_nonce_123456789012345678901234567890",
      },
    );

    expect(environment).toEqual({
      AI_PROVIDER: "stub",
      AUTH_MODE: "test",
      CI: "true",
      CLERK_SECRET_KEY: "",
      CONVERSATION_STORAGE: "database",
      COREDOT_ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      COREDOT_ANTHROPIC_MODEL: "docs-capture-unused",
      COREDOT_API_KEY: "",
      COREDOT_BASE_URL: "http://127.0.0.1:1",
      COREDOT_GEMINI_BASE_URL: "http://127.0.0.1:1",
      COREDOT_GEMINI_MODEL: "docs-capture-unused",
      COREDOT_MAX_COMPLETION_TOKENS: "1",
      COREDOT_MODEL: "docs-capture-unused",
      COREDOT_TOOL_RUN_NONCE: "capture_nonce_123456789012345678901234567890",
      DATABASE_AUTH_TOKEN: "",
      DATABASE_URL: "file:/tmp/coredot-docs-capture/database.sqlite",
      HOME: "/tmp/docs-home",
      HOSTNAME: "127.0.0.1",
      LANG: "en_US.UTF-8",
      NEXT_FONT_GOOGLE_MOCKED_RESPONSES:
        "/tmp/coredot-docs-capture/fonts.cjs",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
      NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "development",
      OPENAI_API_KEY: "",
      OPENAI_MODEL: "docs-capture-unused",
      PATH: "/usr/bin:/bin",
      PNPM_HOME: "/tmp/pnpm-home",
      PORT: "43123",
      PROJECT_PROFILE_ID: "default",
      TEST_PRINCIPAL_ID: "test:principal:docs-capture",
      TEST_WORKSPACE_ID: "test:workspace:docs-capture",
      __NEXT_PROCESSED_ENV: "true",
    });
    expect(JSON.stringify(environment)).not.toMatch(
      /(?:real-|private-next|ambient-|proxy\.example|secret-hook)/,
    );
  });

  it("rejects relative database paths and invalid ports without reflecting input", () => {
    expect(() =>
      createCaptureEnvironment({ NODE_ENV: "test" }, {
        databaseUrl: "file:relative/private.sqlite",
        fontMockPath: "/tmp/coredot-docs-capture/fonts.cjs",
        port: 43123,
        runNonce: "capture_nonce_123456789012345678901234567890",
      }),
    ).toThrow(/^Docs capture environment failed$/);
    expect(() =>
      createCaptureEnvironment({ NODE_ENV: "test" }, {
        databaseUrl: "file:/tmp/private.sqlite",
        fontMockPath: "/tmp/coredot-docs-capture/fonts.cjs",
        port: 70_000,
        runNonce: "capture_nonce_123456789012345678901234567890",
      }),
    ).toThrow(/^Docs capture environment failed$/);
  });

  it("pins every documented application knob instead of inheriting host values", () => {
    const environment = createCaptureEnvironment(
      {},
      {
        databaseUrl: "file:/tmp/coredot-docs-capture/database.sqlite",
        fontMockPath: "/tmp/coredot-docs-capture/fonts.cjs",
        port: 43123,
        runNonce: "capture_nonce_123456789012345678901234567890",
      },
    );
    const documentedNames = [
      "DATABASE_URL",
      "DATABASE_AUTH_TOKEN",
      "AUTH_MODE",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "NEXT_PUBLIC_CLERK_SIGN_IN_URL",
      "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
      "TEST_PRINCIPAL_ID",
      "TEST_WORKSPACE_ID",
      "PROJECT_PROFILE_ID",
      "CONVERSATION_STORAGE",
      "AI_PROVIDER",
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "COREDOT_API_KEY",
      "COREDOT_MODEL",
      "COREDOT_BASE_URL",
      "COREDOT_ANTHROPIC_MODEL",
      "COREDOT_ANTHROPIC_BASE_URL",
      "COREDOT_GEMINI_MODEL",
      "COREDOT_GEMINI_BASE_URL",
      "COREDOT_MAX_COMPLETION_TOKENS",
    ];

    for (const name of documentedNames) {
      expect(environment).toHaveProperty(name);
    }
  });
});

describe("docs capture offline boundary", () => {
  const baseUrl = "http://127.0.0.1:43123";

  it("allows only the exact HTTP origin and its exact WebSocket peer", () => {
    expect(isCaptureNetworkAllowed(`${baseUrl}/documents`, baseUrl)).toBe(true);
    expect(isCaptureNetworkAllowed("ws://127.0.0.1:43123/_next/webpack-hmr", baseUrl)).toBe(true);
    for (const candidate of [
      "http://localhost:43123/documents",
      "http://127.0.0.1:43124/documents",
      "http://[::1]:43123/documents",
      "https://127.0.0.1:43123/documents",
      "http://127.0.0.1.evil.example:43123/documents",
      "https://fonts.googleapis.com/css2?family=Geist",
      "wss://127.0.0.1:43123/_next/webpack-hmr",
    ]) {
      expect(isCaptureNetworkAllowed(candidate, baseUrl)).toBe(false);
    }
  });

  it("maps the exact Next Google font requests to bundled absolute WOFF2 files", () => {
    const responses = createNextFontMockResponses({
      geistFontPath: "/tmp/fonts/geist-latin.woff2",
      geistMonoFontPath: "/tmp/fonts/geist-mono-latin.woff2",
    });

    expect(Object.keys(responses)).toEqual([...NEXT_FONT_GOOGLE_URLS]);
    expect(responses[NEXT_FONT_GOOGLE_URLS[0]]).toContain(
      "url('/tmp/fonts/geist-latin.woff2')",
    );
    expect(responses[NEXT_FONT_GOOGLE_URLS[1]]).toContain(
      "url('/tmp/fonts/geist-mono-latin.woff2')",
    );
  });

  it("converts Windows drive paths to Next's slash-prefixed local-file form", () => {
    expect(
      toNextFontMockFilePath(
        "C:\\repo\\node_modules\\next\\font\\geist-latin.woff2",
        "win32",
      ),
    ).toBe("/C:/repo/node_modules/next/font/geist-latin.woff2");
    expect(
      createNextFontMockResponses({
        geistFontPath: "C:\\fonts\\geist-latin.woff2",
        geistMonoFontPath: "D:\\fonts\\geist-mono-latin.woff2",
        platform: "win32",
      })[NEXT_FONT_GOOGLE_URLS[0]],
    ).toContain("url('/C:/fonts/geist-latin.woff2')");
  });

  it("rejects non-absolute or CSS-breaking local font paths generically", () => {
    for (const path of [
      "relative/geist.woff2",
      "/tmp/geist'bad.woff2",
      '/tmp/geist"bad.woff2',
      "/tmp/geist\nbad.woff2",
      "/tmp/geist\rbad.woff2",
      "/tmp/geist\0bad.woff2",
    ]) {
      expect(() => toNextFontMockFilePath(path, "linux")).toThrow(
        /^Docs capture font mock failed$/,
      );
    }
  });
});

describe("docs screenshot paths", () => {
  it("allows exactly the three approved names beneath the screenshots directory", () => {
    const paths = [
      screenshotPath("workspace"),
      screenshotPath("proposal-review"),
      screenshotPath("docx-fidelity"),
    ];
    const screenshotsRoot = resolve(process.cwd(), "docs/assets/screenshots");

    expect(paths.map((path) => path.slice(path.lastIndexOf(sep) + 1))).toEqual([
      "workspace.webp",
      "proposal-review.webp",
      "docx-fidelity.webp",
    ]);
    for (const path of paths) {
      const child = relative(screenshotsRoot, path);
      expect(child).not.toBe("");
      expect(child).not.toMatch(/^\.\.(?:[/\\]|$)/);
    }
    expect(() => screenshotPath("other" as "workspace")).toThrow(
      /^Docs screenshot path failed$/,
    );
  });
});

describe("docs screenshot set transaction", () => {
  const names = ["workspace", "proposal-review", "docx-fidelity"] as const;

  function captureSet(prefix: string) {
    return new Map(names.map((name) => [name, Buffer.from(`${prefix}-${name}`)]));
  }

  async function writeSet(root: string, prefix: string) {
    await mkdir(root, { recursive: true });
    await Promise.all(
      names.map((name) =>
        writeFile(join(root, `${name}.webp`), `${prefix}-${name}`),
      ),
    );
  }

  async function readSet(root: string) {
    return Promise.all(
      names.map((name) => readFile(join(root, `${name}.webp`), "utf8")),
    );
  }

  it.each(["staged", "backed-up"] as const)(
    "rolls back to the complete old set when the %s step fails",
    async (failureStep) => {
      const parent = await mkdtemp(join(tmpdir(), "coredot-capture-set-"));
      const root = join(parent, "screenshots");
      await writeSet(root, "old");

      try {
        await expect(
          writeCapturesAtomically(captureSet("new"), {
            onStep: async (step) => {
              if (step === failureStep) throw new Error("injected");
            },
            outputRoot: root,
          }),
        ).rejects.toThrow(/^Docs capture output failed$/);
        expect(await readSet(root)).toEqual(
          names.map((name) => `old-${name}`),
        );
      } finally {
        await rm(parent, { force: true, recursive: true });
      }
    },
  );

  it("keeps the complete new set when a failure is observed after the commit point", async () => {
    const parent = await mkdtemp(join(tmpdir(), "coredot-capture-set-"));
    const root = join(parent, "screenshots");
    await writeSet(root, "old");

    try {
      await expect(
        writeCapturesAtomically(captureSet("new"), {
          onStep: async (step) => {
            if (step === "committed") throw new Error("injected");
          },
          outputRoot: root,
        }),
      ).rejects.toThrow(/^Docs capture output failed$/);
      expect(await readSet(root)).toEqual(
        names.map((name) => `new-${name}`),
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rolls back the complete old set when the run signal aborts before commit", async () => {
    const parent = await mkdtemp(join(tmpdir(), "coredot-capture-set-"));
    const root = join(parent, "screenshots");
    const controller = new AbortController();
    await writeSet(root, "old");

    try {
      await expect(
        writeCapturesAtomically(captureSet("new"), {
          onStep: async (step) => {
            if (step === "backed-up") controller.abort();
          },
          outputRoot: root,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/^Docs capture output failed$/);
      expect(await readSet(root)).toEqual(
        names.map((name) => `old-${name}`),
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("recovers a stale lock and interrupted backup before publishing a new set", async () => {
    const parent = await mkdtemp(join(tmpdir(), "coredot-capture-set-"));
    const root = join(parent, "screenshots");
    const base = root.slice(root.lastIndexOf(sep) + 1);
    const backup = join(dirname(root), `.${base}.capture-backup`);
    const lock = join(dirname(root), `.${base}.capture.lock`);
    await writeSet(root, "old");
    await rename(root, backup);
    await writeFile(
      lock,
      JSON.stringify({ createdAt: 0, pid: 2_147_483_647 }),
      "utf8",
    );

    try {
      await writeCapturesAtomically(captureSet("new"), { outputRoot: root });
      expect(await readSet(root)).toEqual(
        names.map((name) => `new-${name}`),
      );
      expect(await readdir(parent)).toEqual(["screenshots"]);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("recovers an old empty lock left before metadata was fully written", async () => {
    const parent = await mkdtemp(join(tmpdir(), "coredot-capture-set-"));
    const root = join(parent, "screenshots");
    const base = root.slice(root.lastIndexOf(sep) + 1);
    const lock = join(dirname(root), `.${base}.capture.lock`);
    await writeSet(root, "old");
    await writeFile(lock, "", "utf8");
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(lock, old, old);

    try {
      await writeCapturesAtomically(captureSet("new"), { outputRoot: root });
      expect(await readSet(root)).toEqual(
        names.map((name) => `new-${name}`),
      );
      expect(await readdir(parent)).toEqual(["screenshots"]);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects an active writer and unrelated output entries without changing them", async () => {
    const parent = await mkdtemp(join(tmpdir(), "coredot-capture-set-"));
    const root = join(parent, "screenshots");
    const base = root.slice(root.lastIndexOf(sep) + 1);
    const lock = join(dirname(root), `.${base}.capture.lock`);
    await writeSet(root, "old");
    await writeFile(join(root, "unrelated.txt"), "keep", "utf8");

    try {
      await expect(
        writeCapturesAtomically(captureSet("new"), { outputRoot: root }),
      ).rejects.toThrow(/^Docs capture output failed$/);
      await rm(join(root, "unrelated.txt"));
      await writeFile(
        lock,
        JSON.stringify({ createdAt: Date.now(), pid: process.pid }),
        "utf8",
      );
      await expect(
        writeCapturesAtomically(captureSet("new"), { outputRoot: root }),
      ).rejects.toThrow(/^Docs capture output failed$/);
      expect(await readSet(root)).toEqual(
        names.map((name) => `old-${name}`),
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});

describe("docs screenshot encoding", () => {
  it("produces deterministic valid WebP within the default 350 KiB budget", async () => {
    const png = await createDeterministicPng();

    const first = await encodeWebpWithinBudget(png);
    const second = await encodeWebpWithinBudget(png);
    const metadata = await sharp(first).metadata();

    expect(first).toEqual(second);
    expect(first.byteLength).toBeLessThanOrEqual(350 * 1024);
    expect(metadata).toMatchObject({ format: "webp", height: 450, width: 720 });
  });

  it("descends through a bounded quality range but never below the readable floor", async () => {
    const png = await createDeterministicPng();
    const highQuality = await sharp(png)
      .webp({ effort: 6, quality: 88, smartSubsample: true })
      .toBuffer();
    const floorQuality = await sharp(png)
      .webp({ effort: 6, quality: 52, smartSubsample: true })
      .toBuffer();

    expect(highQuality.byteLength).toBeGreaterThan(floorQuality.byteLength);
    const encoded = await encodeWebpWithinBudget(png, {
      maxBytes: floorQuality.byteLength,
    });
    expect(encoded.byteLength).toBeLessThanOrEqual(floorQuality.byteLength);
    await expect(
      encodeWebpWithinBudget(png, { maxBytes: floorQuality.byteLength - 1 }),
    ).rejects.toThrow(/^Docs screenshot encoding failed$/);
  });

  it("uses a generic failure for invalid images and impossible budgets", async () => {
    await expect(
      encodeWebpWithinBudget(Buffer.from("/private/path/secret.png"), {
        maxBytes: 1,
      }),
    ).rejects.toThrow(/^Docs screenshot encoding failed$/);
  });
});

describe("mixed-fidelity DOCX fixture", () => {
  it("is deterministic and contains only the fixed local document structure", async () => {
    const first = await createMixedFidelityDocx();
    const second = await createMixedFidelityDocx();
    const archive = await JSZip.loadAsync(first);
    const documentXml = await archive.file("word/document.xml")!.async("string");
    const relationshipsXml = await archive
      .file("word/_rels/document.xml.rels")!
      .async("string");
    const coreXml = await archive.file("docProps/core.xml")!.async("string");
    const files = Object.keys(archive.files);

    expect(first).toEqual(second);
    expect(documentXml).toContain("Mixed-Fidelity Product Brief");
    expect(documentXml).toContain("Executive summary");
    expect(documentXml).toContain("Evidence checklist");
    expect(documentXml).toContain("Unsupported visual construct warning");
    expect(documentXml).toContain("floating SmartArt diagram");
    expect(documentXml).toContain("<w:b/>");
    expect(documentXml).toContain("<w:i/>");
    expect(documentXml).toContain("<w:hyperlink");
    expect(documentXml.match(/<w:numPr>/g)).toHaveLength(4);
    expect(documentXml.match(/<w:tr>/g)).toHaveLength(2);
    expect(documentXml.match(/<w:tc>/g)).toHaveLength(6);
    expect(documentXml).toContain("<w:drawing>");
    expect(documentXml).not.toContain('<w:pStyle w:val="Title"/>');
    expect(relationshipsXml).toContain("https://example.invalid/coredot-guide");
    expect(relationshipsXml).toMatch(/Target="media\/[^"]+\.png"/);
    expect(files).toEqual(expect.arrayContaining([
      expect.stringMatching(/^word\/media\/[^/]+\.png$/),
    ]));
    expect(files).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^word\/fonts\//),
    ]));
    expect(coreXml).not.toMatch(/dcterms:(?:created|modified)/);
    expect(coreXml).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
  });

  it("produces honest importer evidence for the unsupported local visual", async () => {
    const bytes = await createMixedFidelityDocx();
    const result = await documentInterchange.import({
      bytes,
      fileName: "Mixed-Fidelity Product Brief.docx",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected fixture import to succeed");
    expect(result.fidelity.items).toEqual(
      expect.arrayContaining([{ feature: "image", outcome: "removed" }]),
    );
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/paragraph style.*Title/i)]),
    );
  });
});

describe("capture cleanup", () => {
  it("runs every cleanup step and hides individual failure details", async () => {
    const calls: string[] = [];

    await expect(
      runCaptureCleanup([
        async () => {
          calls.push("browser");
          throw new Error("/private/browser-profile");
        },
        async () => {
          calls.push("server");
        },
        async () => {
          calls.push("temp");
        },
      ]),
    ).rejects.toThrow(/^Docs capture cleanup failed$/);
    expect(calls).toEqual(["browser", "server", "temp"]);
  });
});
