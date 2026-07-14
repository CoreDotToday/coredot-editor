import { relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { documentInterchange } from "../../src/features/documents/document-interchange";
import {
  DOCS_CAPTURE_STYLE,
  DOCS_LANGUAGE_STORAGE_KEY,
  DOCS_VIEWPORT,
  createCaptureEnvironment,
  encodeWebpWithinBudget,
  runCaptureCleanup,
  screenshotPath,
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
        port: 43123,
      },
    );

    expect(environment).toEqual({
      AI_PROVIDER: "stub",
      AUTH_MODE: "test",
      CI: "true",
      DATABASE_URL: "file:/tmp/coredot-docs-capture/database.sqlite",
      HOME: "/tmp/docs-home",
      HOSTNAME: "127.0.0.1",
      LANG: "en_US.UTF-8",
      NEXT_TELEMETRY_DISABLED: "1",
      PATH: "/usr/bin:/bin",
      PNPM_HOME: "/tmp/pnpm-home",
      PORT: "43123",
      TEST_PRINCIPAL_ID: "test:principal:docs-capture",
      TEST_WORKSPACE_ID: "test:workspace:docs-capture",
    });
    expect(JSON.stringify(environment)).not.toMatch(
      /(?:real-|private-next|ambient-|proxy\.example|secret-hook)/,
    );
  });

  it("rejects relative database paths and invalid ports without reflecting input", () => {
    expect(() =>
      createCaptureEnvironment({ NODE_ENV: "test" }, {
        databaseUrl: "file:relative/private.sqlite",
        port: 43123,
      }),
    ).toThrow(/^Docs capture environment failed$/);
    expect(() =>
      createCaptureEnvironment({ NODE_ENV: "test" }, {
        databaseUrl: "file:/tmp/private.sqlite",
        port: 70_000,
      }),
    ).toThrow(/^Docs capture environment failed$/);
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
