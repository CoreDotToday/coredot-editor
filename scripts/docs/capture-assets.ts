import { randomBytes } from "node:crypto";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  chromium,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import sharp from "sharp";
import { createToolEnvironment } from "./verify-quick-start-shared";
import { createMixedFidelityDocx } from "./fixtures/mixed-fidelity-docx";
import {
  acquireInterruptibleResource,
  createManagedCommandOwner,
  interruptExitCode,
  resolvePnpmInvocation,
  runInterruptibleTask,
  spawnManagedProcess,
  stopManagedProcess,
  waitForPortRelease,
  type ManagedProcess,
  type PnpmInvocation,
} from "./managed-process";

export const DOCS_VIEWPORT = { width: 1440, height: 1000 } as const;
export const DOCS_LANGUAGE_STORAGE_KEY = "coredot-editor-language";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const REQUIRE = createRequire(import.meta.url);
const SCREENSHOTS_ROOT = resolve(APP_ROOT, "docs/assets/screenshots");
const CAPTURE_NAMES = ["workspace", "proposal-review", "docx-fidelity"] as const;
const WEBP_QUALITY_STEPS = [88, 82, 76, 70, 64, 58, 52] as const;
const DEFAULT_WEBP_MAX_BYTES = 350 * 1024;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const CAPTURE_LOCK_LEASE_MS = 10 * 60_000;
const CAPTURE_OWNER_TOKEN_PATTERN = /^[a-f0-9]{48}$/;
export const CAPTURE_TRANSACTION_VERSION = 1 as const;
export const NEXT_FONT_GOOGLE_URLS = [
  "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap",
  "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap",
] as const;
export const NEXT_CAPTURE_BUNDLER_ARGUMENT = "--webpack" as const;
const FIXED_CAPTURE_ENVIRONMENT = {
  AI_PROVIDER: "stub",
  AUTH_MODE: "test",
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
  DATABASE_AUTH_TOKEN: "",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "development",
  OPENAI_API_KEY: "",
  OPENAI_MODEL: "docs-capture-unused",
  PROJECT_PROFILE_ID: "default",
  TEST_PRINCIPAL_ID: "test:principal:docs-capture",
  TEST_WORKSPACE_ID: "test:workspace:docs-capture",
  __NEXT_PROCESSED_ENV: "true",
} as const;
export const DOCS_CAPTURE_STYLE = `
  *, *::before, *::after {
    animation-delay: 0s !important;
    animation-duration: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
    scrollbar-width: none !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
  }
  *::-webkit-scrollbar {
    display: none !important;
    height: 0 !important;
    width: 0 !important;
  }
  *:focus { box-shadow: none !important; outline: none !important; }
  [data-block-gutter="true"] { display: none !important; }
  nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }
  time { visibility: hidden !important; }
`;

type CaptureName = (typeof CAPTURE_NAMES)[number];
export type CaptureLockMetadata = {
  createdAt: number;
  leaseExpiresAt: number;
  ownerToken: string;
  pid: number;
  version: typeof CAPTURE_TRANSACTION_VERSION;
};
type CaptureOutputLock = {
  handle: FileHandle;
  metadata: CaptureLockMetadata;
  previousOwnerToken?: string;
};
type CapturePhase =
  | "browser startup"
  | "database migration"
  | "document API creation"
  | "DOCX import"
  | "editor load"
  | "fidelity screenshot"
  | "import page load"
  | "output write"
  | "proposal screenshot"
  | "review finding"
  | "review pending status"
  | "review response"
  | "review settled"
  | "review trigger"
  | "server startup"
  | "workspace screenshot"
  | "workspace bootstrap";

type CaptureServer = {
  baseUrl: string;
  managed: ManagedProcess;
  port: number;
};

export function createCaptureEnvironment(
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  options: {
    databaseUrl: string;
    fontMockPath: string;
    port: number;
    runNonce: string;
  },
): NodeJS.ProcessEnv {
  validateDatabaseUrl(options.databaseUrl);
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535 ||
    (!isAbsolute(options.fontMockPath) &&
      !win32.isAbsolute(options.fontMockPath)) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(options.runNonce)
  ) {
    throw new Error("Docs capture environment failed");
  }

  return {
    ...createToolEnvironment(baseEnvironment as NodeJS.ProcessEnv),
    ...FIXED_CAPTURE_ENVIRONMENT,
    COREDOT_TOOL_RUN_NONCE: options.runNonce,
    DATABASE_URL: options.databaseUrl,
    HOSTNAME: "127.0.0.1",
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: options.fontMockPath,
    PORT: String(options.port),
  };
}

export function isCaptureNetworkAllowed(candidate: string, baseUrl: string) {
  try {
    const target = new URL(candidate);
    const base = new URL(baseUrl);
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      !base.port ||
      base.username ||
      base.password
    ) {
      return false;
    }
    const expectedProtocol = target.protocol === "ws:" ? "ws:" : "http:";
    return (
      target.protocol === expectedProtocol &&
      (target.protocol === "http:" || target.protocol === "ws:") &&
      target.hostname === base.hostname &&
      target.port === base.port &&
      !target.username &&
      !target.password
    );
  } catch {
    return false;
  }
}

export function createCaptureDocumentRequest(
  request: APIRequestContext,
  baseUrl: string,
  data: object,
  headers?: Record<string, string>,
): Promise<APIResponse> {
  const endpoint = new URL("/api/documents", baseUrl);
  if (
    endpoint.pathname !== "/api/documents" ||
    endpoint.search !== "" ||
    !isCaptureNetworkAllowed(endpoint.href, baseUrl)
  ) {
    throw new Error("Docs capture document request failed");
  }
  return request.post(endpoint.href, { data, headers, maxRedirects: 0 });
}

export function createNextFontMockResponses(options: {
  geistFontPath: string;
  geistMonoFontPath: string;
  platform?: NodeJS.Platform;
}): Record<(typeof NEXT_FONT_GOOGLE_URLS)[number], string> {
  const geistFontPath = toNextFontMockFilePath(
    options.geistFontPath,
    options.platform,
  );
  const geistMonoFontPath = toNextFontMockFilePath(
    options.geistMonoFontPath,
    options.platform,
  );
  // Next 16's line extractor needs an unquoted path to read local bytes, while
  // the rewritten CSS URL must retain quotes for the bundler's module syntax.
  return {
    [NEXT_FONT_GOOGLE_URLS[0]]:
      `/*font-probe src: url(${geistFontPath})*/\n@font-face { font-family: 'Geist'; font-style: normal; font-weight: 100 900; src:\n url('${geistFontPath}') format('woff2'); }`,
    [NEXT_FONT_GOOGLE_URLS[1]]:
      `/*font-probe src: url(${geistMonoFontPath})*/\n@font-face { font-family: 'Geist Mono'; font-style: normal; font-weight: 100 900; src:\n url('${geistMonoFontPath}') format('woff2'); }`,
  };
}

export function toNextFontMockFilePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (
    path.includes("\0") ||
    path.includes("\n") ||
    path.includes("\r") ||
    path.includes(")") ||
    path.includes("'") ||
    path.includes('"')
  ) {
    throw new Error("Docs capture font mock failed");
  }
  if (platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(path) || !win32.isAbsolute(path)) {
      throw new Error("Docs capture font mock failed");
    }
    return `/${path.replaceAll("\\", "/")}`;
  }
  if (!isAbsolute(path)) throw new Error("Docs capture font mock failed");
  return path;
}

export function screenshotPath(name: CaptureName): string {
  if (!CAPTURE_NAMES.includes(name)) {
    throw new Error("Docs screenshot path failed");
  }
  return resolve(SCREENSHOTS_ROOT, `${name}.webp`);
}

export async function encodeWebpWithinBudget(
  sourcePng: Buffer,
  options: { maxBytes?: number } = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_WEBP_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Docs screenshot encoding failed");
  }

  try {
    const source = sharp(sourcePng, {
      failOn: "error",
      limitInputPixels: DOCS_VIEWPORT.width * DOCS_VIEWPORT.height,
    });
    for (const quality of WEBP_QUALITY_STEPS) {
      const encoded = await source
        .clone()
        .webp({ effort: 6, quality, smartSubsample: true })
        .toBuffer();
      if (encoded.byteLength <= maxBytes) return encoded;
    }
  } catch {
    throw new Error("Docs screenshot encoding failed");
  }
  throw new Error("Docs screenshot encoding failed");
}

export async function runCaptureCleanup(
  steps: readonly (() => Promise<void>)[],
): Promise<void> {
  const results = await Promise.allSettled(
    steps.map((step) => Promise.resolve().then(step)),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Docs capture cleanup failed");
  }
}

async function captureDocsAssets() {
  let temporaryRoot: string | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let server: CaptureServer | undefined;
  let phase: CapturePhase = "database migration";
  const commandOwner = createManagedCommandOwner();

  try {
    return await runInterruptibleTask({
      cleanup: async (cleanupSignal) => {
        const stopServerThenRemoveTemporaryRoot = async () => {
          let failed = false;
          try {
            await commandOwner.settle();
          } catch {
            failed = true;
          }
          try {
            if (server) await disposeCaptureServer(server, cleanupSignal);
          } catch {
            failed = true;
          }
          try {
            if (temporaryRoot) {
              await rm(temporaryRoot, { force: true, recursive: true });
            }
          } catch {
            failed = true;
          }
          if (failed) throw new Error("Docs capture cleanup failed");
        };
        await runCaptureCleanup([
          async () => {
            await browser?.close();
          },
          stopServerThenRemoveTemporaryRoot,
        ]);
      },
      cleanupTimeoutMs: 15_000,
      execute: async (signal) => {
        try {
          await acquireInterruptibleResource({
            acquire: () =>
              mkdtemp(join(tmpdir(), "coredot-docs-capture-")),
            adopt: (root) => {
              temporaryRoot = root;
            },
            dispose: (root) => rm(root, { force: true, recursive: true }),
            signal,
          });
          const root = temporaryRoot!;
          const runNonce = randomBytes(32).toString("base64url");
          const fontMockPath = await writeNextFontMock(root, signal);
          const databaseUrl = `file:${join(root, "capture.sqlite")}`;
          const pnpm = await resolvePnpmInvocation();
          const databaseEnvironment = createCaptureEnvironment(process.env, {
            databaseUrl,
            fontMockPath,
            port: 1,
            runNonce,
          });
          await commandOwner.run({
            arguments: [...pnpm.prefixArguments, "db:migrate"],
            command: pnpm.command,
            cwd: APP_ROOT,
            environment: databaseEnvironment,
            signal,
            timeoutMs: 60_000,
          });
          phase = "workspace bootstrap";
          await commandOwner.run({
            arguments: [
              ...pnpm.prefixArguments,
              "exec",
              "tsx",
              SCRIPT_PATH,
              "--bootstrap",
            ],
            command: pnpm.command,
            cwd: APP_ROOT,
            environment: databaseEnvironment,
            signal,
            timeoutMs: 30_000,
          });

          phase = "server startup";
          await acquireInterruptibleResource({
            acquire: () =>
              startCaptureServer({
                databaseUrl,
                fontMockPath,
                pnpm,
                runNonce,
                signal,
              }),
            adopt: (captureServer) => {
              server = captureServer;
            },
            dispose: (captureServer) =>
              disposeCaptureServer(captureServer),
            signal,
          });
          phase = "browser startup";
          await acquireInterruptibleResource({
            acquire: () => chromium.launch({ headless: true }),
            adopt: (launchedBrowser) => {
              browser = launchedBrowser;
            },
            dispose: (launchedBrowser) => launchedBrowser.close(),
            signal,
          });
          await acquireInterruptibleResource({
            acquire: () =>
              browser!.newContext({
                baseURL: server!.baseUrl,
                colorScheme: "light",
                deviceScaleFactor: 1,
                locale: "en-US",
                reducedMotion: "reduce",
                serviceWorkers: "block",
                timezoneId: "UTC",
                viewport: DOCS_VIEWPORT,
              }),
            adopt: (browserContext) => {
              context = browserContext;
            },
            dispose: (browserContext) => browserContext.close(),
            signal,
          });
          await installCaptureNetworkBoundary(context!, server!.baseUrl);
          await installDeterministicPageState(context!);

          phase = "document API creation";
          const captures = await captureProductStates(
            context!,
            server!.baseUrl,
            (nextPhase) => {
              phase = nextPhase;
            },
          );
          phase = "output write";
          await writeCapturesAtomically(captures, { signal });
          for (const name of CAPTURE_NAMES) {
            console.log(`${name}.webp ${captures.get(name)!.byteLength} bytes`);
          }
        } catch {
          throw new Error(`Docs capture failed during ${phase}`);
        }
      },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Managed process cleanup failed"
    ) {
      throw new Error("Docs capture cleanup failed");
    }
    throw error;
  }
}

async function bootstrapCaptureWorkspace() {
  const [{ sqliteClient }, { ensureWorkspaceBootstrap }] = await Promise.all([
    import("../../src/db/client"),
    import("../../src/features/workspaces/workspace-bootstrap"),
  ]);
  try {
    await ensureWorkspaceBootstrap({
      workspaceId: FIXED_CAPTURE_ENVIRONMENT.TEST_WORKSPACE_ID,
    });
  } finally {
    sqliteClient.close();
  }
}

async function captureProductStates(
  context: BrowserContext,
  baseUrl: string,
  setPhase: (phase: CapturePhase) => void,
): Promise<Map<CaptureName, Buffer>> {
  const page = await context.newPage();
  const captures = new Map<CaptureName, Buffer>();
  setPhase("document API creation");
  const response = await createCaptureDocumentRequest(
    context.request,
    baseUrl,
    {
      contentJson: {
        content: [
          {
            attrs: { level: 1 },
            content: [{ text: "Decision brief", type: "text" }],
            type: "heading",
          },
          {
            content: [
              {
                text: "Retention improved, but the evidence behind the result is not yet clear.",
                type: "text",
              },
            ],
            type: "paragraph",
          },
          {
            attrs: { level: 2 },
            content: [{ text: "Decision needed", type: "text" }],
            type: "heading",
          },
          {
            content: [
              {
                text: "Validate the source metric and assign an accountable owner before approval.",
                type: "text",
              },
            ],
            type: "paragraph",
          },
        ],
        type: "doc",
      },
      title: "Quarterly Product Strategy Brief",
    },
    { "Idempotency-Key": "docs_capture_product_brief_v1" },
  );
  const documentId = await readCreatedDocumentId(response);

  setPhase("editor load");
  await page.goto(`${baseUrl}/documents/${encodeURIComponent(documentId)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("textbox", { name: "Document title" }).waitFor();
  await page
    .getByRole("complementary", { name: "AI workspace" })
    .waitFor({ state: "visible" });
  setPhase("workspace screenshot");
  captures.set("workspace", await capturePage(page));

  setPhase("review trigger");
  const reviewResponsePromise = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === "/api/ai/review",
  );
  await page
    .getByRole("button", { exact: true, name: "Review document" })
    .click();
  setPhase("review response");
  const reviewResponse = await reviewResponsePromise;
  if (!reviewResponse.ok()) {
    console.error(`Docs review response status ${reviewResponse.status()}`);
    throw new Error("Docs capture failed");
  }
  setPhase("review finding");
  await page.getByText("Stub review finding").waitFor();
  setPhase("review pending status");
  await page.getByText("Pending", { exact: true }).first().waitFor();
  setPhase("review settled");
  await page
    .getByRole("button", { exact: true, name: "Review document" })
    .waitFor();
  setPhase("proposal screenshot");
  captures.set("proposal-review", await capturePage(page));

  setPhase("import page load");
  await page.goto(`${baseUrl}/documents`, { waitUntil: "domcontentloaded" });
  const docx = await createMixedFidelityDocx();
  setPhase("DOCX import");
  await page.getByLabel("Choose DOCX file").setInputFiles({
    buffer: docx,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    name: "Mixed-Fidelity Product Brief.docx",
  });
  const importReview = page.getByRole("dialog", { name: "Review import result" });
  await importReview.waitFor();
  await importReview
    .getByText("Other DOCX formatting (review required): Approximated", {
      exact: true,
    })
    .waitFor();
  await importReview.getByText("Image: Removed", { exact: true }).waitFor();
  setPhase("fidelity screenshot");
  captures.set(
    "docx-fidelity",
    await capturePage(page, { opaqueModalBackdrop: true }),
  );

  if (captures.size !== CAPTURE_NAMES.length) {
    throw new Error("Docs capture failed");
  }
  return captures;
}

async function capturePage(
  page: Page,
  options: { opaqueModalBackdrop?: boolean } = {},
) {
  await settlePage(page);
  const screenshotStyle = options.opaqueModalBackdrop
    ? `${DOCS_CAPTURE_STYLE}\n[data-modal-surface-overlay] { background: #f4f4f5 !important; }`
    : DOCS_CAPTURE_STYLE;
  const sourcePng = await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    style: screenshotStyle,
    type: "png",
  });
  return encodeWebpWithinBudget(sourcePng);
}

async function settlePage(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
    );
  });
  await page.mouse.move(
    Math.floor(DOCS_VIEWPORT.width / 2),
    Math.floor(DOCS_VIEWPORT.height / 2),
  );
  await page.waitForTimeout(100);
  for (const transientText of ["Importing...", "Reviewing...", "Working..."]) {
    const transient = page.getByText(transientText, { exact: true });
    for (let index = 0; index < (await transient.count()); index += 1) {
      if (await transient.nth(index).isVisible()) {
        throw new Error("Docs capture failed");
      }
    }
  }
}

async function installDeterministicPageState(context: BrowserContext) {
  await context.addInitScript(
    ({ css, languageKey }) => {
      window.localStorage.setItem(languageKey, "en");
      const installStyle = () => {
        if (document.getElementById("docs-capture-style")) return;
        const style = document.createElement("style");
        style.id = "docs-capture-style";
        style.textContent = css;
        (document.head ?? document.documentElement).append(style);
      };
      if (document.documentElement) installStyle();
      else document.addEventListener("DOMContentLoaded", installStyle, { once: true });
    },
    { css: DOCS_CAPTURE_STYLE, languageKey: DOCS_LANGUAGE_STORAGE_KEY },
  );
}

async function installCaptureNetworkBoundary(
  context: BrowserContext,
  baseUrl: string,
) {
  await context.route("**/*", async (route) => {
    if (isCaptureNetworkAllowed(route.request().url(), baseUrl)) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await context.routeWebSocket(/.*/, async (route) => {
    if (isCaptureNetworkAllowed(route.url(), baseUrl)) {
      route.connectToServer();
    } else {
      await route.close({ code: 1008, reason: "blocked" });
    }
  });
}

async function writeNextFontMock(
  temporaryRoot: string,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error("Docs capture font mock failed");
  const nextRoot = dirname(await realpath(REQUIRE.resolve("next/package.json")));
  const responses = createNextFontMockResponses({
    geistFontPath: await realpath(
      join(nextRoot, "dist/next-devtools/server/font/geist-latin.woff2"),
    ),
    geistMonoFontPath: await realpath(
      join(nextRoot, "dist/next-devtools/server/font/geist-mono-latin.woff2"),
    ),
  });
  const fontMockPath = join(temporaryRoot, "next-font-responses.cjs");
  await writeFile(
    fontMockPath,
    `module.exports = ${JSON.stringify(responses)};\n`,
    { flag: "wx", signal },
  );
  return fontMockPath;
}

async function readCreatedDocumentId(response: APIResponse) {
  if (response.status() !== 201) throw new Error("Docs capture API failed");
  const bytes = await response.body();
  if (bytes.byteLength > MAX_API_RESPONSE_BYTES) {
    throw new Error("Docs capture API failed");
  }
  try {
    const body = JSON.parse(bytes.toString("utf8")) as {
      document?: { id?: unknown };
    };
    const id = body.document?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error("Docs capture API failed");
    }
    return id;
  } catch {
    throw new Error("Docs capture API failed");
  }
}

export async function writeCapturesAtomically(
  captures: Map<CaptureName, Buffer>,
  options: {
    onStep?: (
      step: "backed-up" | "cleanup" | "committed" | "rollback" | "staged",
    ) => Promise<unknown>;
    outputRoot?: string;
    signal?: AbortSignal;
  } = {},
) {
  const outputRoot = options.outputRoot ?? SCREENSHOTS_ROOT;
  if (!isAbsolute(outputRoot) && !win32.isAbsolute(outputRoot)) {
    throw new Error("Docs capture output failed");
  }
  for (const name of CAPTURE_NAMES) {
    const contents = captures.get(name);
    if (!Buffer.isBuffer(contents) || contents.byteLength < 1) {
      throw new Error("Docs capture output failed");
    }
  }
  if (captures.size !== CAPTURE_NAMES.length) {
    throw new Error("Docs capture output failed");
  }

  const parent = dirname(outputRoot);
  const directoryName = basename(outputRoot);
  const lockPath = join(parent, `.${directoryName}.capture.lock`);
  const backupPrefix = `.${directoryName}.capture-backup-`;
  const stagePrefix = `.${directoryName}.capture-stage-`;
  const manifestPrefix = `.${directoryName}.capture-transaction-`;
  await mkdir(parent, { recursive: true });
  const lock = await acquireCaptureOutputLock(lockPath);
  const backupPath = join(parent, `${backupPrefix}${lock.metadata.ownerToken}`);
  const stagePath = join(parent, `${stagePrefix}${lock.metadata.ownerToken}`);
  const manifestPath = join(
    parent,
    `${manifestPrefix}${lock.metadata.ownerToken}.json`,
  );
  let committed = false;
  let manifestCreated = false;
  let movedOldSet = false;
  let operationFailed = false;
  let preserveLockForRecovery = false;

  try {
    await recoverCaptureOutput({
      backupPrefix,
      directoryName,
      manifestPrefix,
      outputRoot,
      parent,
      previousOwnerToken: lock.previousOwnerToken,
      stagePrefix,
    });
    if (await pathExists(outputRoot)) {
      await assertApprovedCaptureDirectory(outputRoot);
    }
    if (options.signal?.aborted) throw new Error("interrupted");
    await renewCaptureOutputLock(lock);
    await writeFile(
      manifestPath,
      JSON.stringify(createCaptureTransactionManifest(directoryName, lock.metadata.ownerToken)),
      { flag: "wx" },
    );
    manifestCreated = true;

    await mkdir(stagePath, { recursive: false });
    for (const name of CAPTURE_NAMES) {
      await writeFile(join(stagePath, `${name}.webp`), captures.get(name)!, {
        flag: "wx",
        signal: options.signal,
      });
    }
    await assertApprovedCaptureDirectory(stagePath);
    await options.onStep?.("staged");

    if (await pathExists(outputRoot)) {
      await renewCaptureOutputLock(lock);
      await rename(outputRoot, backupPath);
      movedOldSet = true;
    }
    await options.onStep?.("backed-up");
    if (options.signal?.aborted) throw new Error("interrupted");
    await renewCaptureOutputLock(lock);
    await rename(stagePath, outputRoot);
    committed = true;
    await options.onStep?.("committed");
  } catch {
    operationFailed = true;
    if (
      !committed &&
      movedOldSet &&
      !(await pathExists(outputRoot)) &&
      (await isOwnedCaptureTransaction(
        manifestPath,
        directoryName,
        lock.metadata.ownerToken,
      ))
    ) {
      try {
        await options.onStep?.("rollback");
        await assertApprovedCaptureDirectory(backupPath);
        await rename(backupPath, outputRoot);
        movedOldSet = false;
      } catch {
        // The tokenized backup and manifest remain for verified stale recovery.
      }
    }
  } finally {
    if (manifestCreated) {
      const cleaned = await cleanupOwnedCaptureTransaction({
        backupPath,
        committed,
        directoryName,
        manifestPath,
        movedOldSet,
        ownerToken: lock.metadata.ownerToken,
        stagePath,
        beforeCleanup: () => options.onStep?.("cleanup"),
      });
      if (!cleaned) {
        operationFailed = true;
        preserveLockForRecovery = true;
      }
    }
    try {
      if (preserveLockForRecovery) {
        await preserveExpiredCaptureOutputLock(lock);
      } else {
        await releaseCaptureOutputLock(lockPath, lock);
      }
    } catch {
      operationFailed = true;
    }
  }
  if (operationFailed) throw new Error("Docs capture output failed");
}

async function acquireCaptureOutputLock(
  lockPath: string,
): Promise<CaptureOutputLock> {
  const ownerToken = randomBytes(24).toString("hex");
  let previousOwnerToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      const createdAt = Date.now();
      const metadata: CaptureLockMetadata = {
        createdAt,
        leaseExpiresAt: createdAt + CAPTURE_LOCK_LEASE_MS,
        ownerToken,
        pid: process.pid,
        version: CAPTURE_TRANSACTION_VERSION,
      };
      try {
        await writeCaptureLockMetadata(handle, metadata);
      } catch {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw new Error("Docs capture output failed");
      }
      return { handle, metadata, previousOwnerToken };
    } catch (error) {
      if (attempt !== 0 || !hasErrorCode(error, "EEXIST")) {
        throw new Error("Docs capture output failed");
      }
      const staleOwner = await readStaleCaptureLockOwner(lockPath);
      if (!staleOwner.stale) throw new Error("Docs capture output failed");
      const stalePath = `${lockPath}.stale-${randomBytes(12).toString("hex")}`;
      try {
        await rename(lockPath, stalePath);
        const movedOwner = await readStaleCaptureLockOwner(stalePath);
        if (
          !movedOwner.stale ||
          movedOwner.ownerToken !== staleOwner.ownerToken
        ) {
          await rename(stalePath, lockPath).catch(() => undefined);
          throw new Error("Docs capture output failed");
        }
        previousOwnerToken = movedOwner.ownerToken;
        await rm(stalePath, { force: true });
      } catch {
        throw new Error("Docs capture output failed");
      }
    }
  }
  throw new Error("Docs capture output failed");
}

async function writeCaptureLockMetadata(
  handle: FileHandle,
  metadata: CaptureLockMetadata,
) {
  const contents = Buffer.from(JSON.stringify(metadata), "utf8");
  await handle.write(contents, 0, contents.byteLength, 0);
  await handle.truncate(contents.byteLength);
  await handle.sync();
}

async function renewCaptureOutputLock(lock: CaptureOutputLock) {
  lock.metadata.leaseExpiresAt = Date.now() + CAPTURE_LOCK_LEASE_MS;
  await writeCaptureLockMetadata(lock.handle, lock.metadata);
}

async function releaseCaptureOutputLock(
  lockPath: string,
  lock: CaptureOutputLock,
) {
  let owned = false;
  try {
    const metadata = parseCaptureLockMetadata(
      JSON.parse(await readFile(lockPath, "utf8")),
    );
    owned = metadata?.ownerToken === lock.metadata.ownerToken;
  } finally {
    await lock.handle.close();
  }
  if (!owned) throw new Error("Docs capture output failed");
  await rm(lockPath, { force: true });
}

async function preserveExpiredCaptureOutputLock(lock: CaptureOutputLock) {
  try {
    lock.metadata.createdAt = 0;
    lock.metadata.leaseExpiresAt = 1;
    await writeCaptureLockMetadata(lock.handle, lock.metadata);
  } finally {
    await lock.handle.close();
  }
}

export function isCaptureLockOwnerStale(
  metadata: CaptureLockMetadata,
  options: {
    now?: number;
    probePid?: (pid: number) => unknown;
  } = {},
) {
  if (!parseCaptureLockMetadata(metadata)) return false;
  const now = options.now ?? Date.now();
  if (metadata.leaseExpiresAt <= now) return true;
  try {
    (options.probePid ?? ((pid) => process.kill(pid, 0)))(metadata.pid);
    return false;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return true;
    return false;
  }
}

async function readStaleCaptureLockOwner(lockPath: string) {
  try {
    const metadata = parseCaptureLockMetadata(
      JSON.parse(await readFile(lockPath, "utf8")),
    );
    if (metadata) {
      const stale = isCaptureLockOwnerStale(metadata);
      return {
        ownerToken: stale ? metadata.ownerToken : undefined,
        stale,
      };
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { stale: false };
  }
  return { stale: await captureLockMtimeIsStale(lockPath) };
}

function parseCaptureLockMetadata(value: unknown): CaptureLockMetadata | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== CAPTURE_TRANSACTION_VERSION ||
    !("ownerToken" in value) ||
    typeof value.ownerToken !== "string" ||
    !CAPTURE_OWNER_TOKEN_PATTERN.test(value.ownerToken) ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    !("leaseExpiresAt" in value) ||
    typeof value.leaseExpiresAt !== "number" ||
    !Number.isFinite(value.leaseExpiresAt) ||
    value.leaseExpiresAt <= value.createdAt
  ) {
    return undefined;
  }
  return value as CaptureLockMetadata;
}

async function captureLockMtimeIsStale(lockPath: string) {
  try {
    const metadata = await stat(lockPath);
    return Date.now() - metadata.mtimeMs > 10 * 60_000;
  } catch {
    return false;
  }
}

async function recoverCaptureOutput(options: {
  backupPrefix: string;
  directoryName: string;
  manifestPrefix: string;
  outputRoot: string;
  parent: string;
  previousOwnerToken?: string;
  stagePrefix: string;
}) {
  const legacyBackup = `.${options.directoryName}.capture-backup`;
  const entries = await readdir(options.parent, { withFileTypes: true });
  const transactionEntries = entries.filter(
    (entry) =>
      entry.name === legacyBackup ||
      entry.name.startsWith(options.backupPrefix) ||
      entry.name.startsWith(options.stagePrefix) ||
      entry.name.startsWith(options.manifestPrefix),
  );
  if (transactionEntries.length === 0) return;
  if (!options.previousOwnerToken) throw new Error("Docs capture output failed");

  const backupName = `${options.backupPrefix}${options.previousOwnerToken}`;
  const stageName = `${options.stagePrefix}${options.previousOwnerToken}`;
  const manifestName = `${options.manifestPrefix}${options.previousOwnerToken}.json`;
  const expectedNames = new Set([backupName, manifestName, stageName]);
  if (transactionEntries.some((entry) => !expectedNames.has(entry.name))) {
    throw new Error("Docs capture output failed");
  }

  const backupPath = join(options.parent, backupName);
  const stagePath = join(options.parent, stageName);
  const manifestPath = join(options.parent, manifestName);
  if (
    !(await isOwnedCaptureTransaction(
      manifestPath,
      options.directoryName,
      options.previousOwnerToken,
    ))
  ) {
    throw new Error("Docs capture output failed");
  }

  const hasStage = await pathExists(stagePath);
  const hasBackup = await pathExists(backupPath);
  if (hasStage) await assertOwnedCaptureArtifactDirectory(stagePath);
  if (hasBackup) await assertApprovedCaptureDirectory(backupPath);
  if (hasBackup && (await pathExists(options.outputRoot))) {
    await assertApprovedCaptureDirectory(options.outputRoot);
  }

  if (hasStage) await rm(stagePath, { recursive: true });
  if (hasBackup) {
    if (await pathExists(options.outputRoot)) {
      await rm(backupPath, { recursive: true });
    } else {
      await rename(backupPath, options.outputRoot);
    }
  }
  await rm(manifestPath);
}

function createCaptureTransactionManifest(
  targetName: string,
  ownerToken: string,
) {
  return {
    ownerToken,
    targetName,
    version: CAPTURE_TRANSACTION_VERSION,
  };
}

async function isOwnedCaptureTransaction(
  manifestPath: string,
  targetName: string,
  ownerToken: string,
) {
  try {
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    const value = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    return (
      value.version === CAPTURE_TRANSACTION_VERSION &&
      value.ownerToken === ownerToken &&
      value.targetName === targetName &&
      Object.keys(value).sort().join(",") === "ownerToken,targetName,version"
    );
  } catch {
    return false;
  }
}

async function cleanupOwnedCaptureTransaction(options: {
  backupPath: string;
  beforeCleanup: () => Promise<unknown> | undefined;
  committed: boolean;
  directoryName: string;
  manifestPath: string;
  movedOldSet: boolean;
  ownerToken: string;
  stagePath: string;
}) {
  if (
    !(await isOwnedCaptureTransaction(
      options.manifestPath,
      options.directoryName,
      options.ownerToken,
    ))
  ) {
    return false;
  }
  try {
    await options.beforeCleanup();
    const hasStage = await pathExists(options.stagePath);
    const hasBackup = await pathExists(options.backupPath);
    if (hasStage) await assertOwnedCaptureArtifactDirectory(options.stagePath);
    if (hasBackup) await assertApprovedCaptureDirectory(options.backupPath);
    if (hasStage) await rm(options.stagePath, { recursive: true });
    if (hasBackup && (options.committed || !options.movedOldSet)) {
      await rm(options.backupPath, { recursive: true });
    }
    if (
      !(await pathExists(options.stagePath)) &&
      !(await pathExists(options.backupPath))
    ) {
      await rm(options.manifestPath);
      return true;
    }
  } catch {
    // Preserve any artifact whose exact ownership or contents cannot be proven.
  }
  return false;
}

async function assertOwnedCaptureArtifactDirectory(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Docs capture output failed");
  }
}

async function assertApprovedCaptureDirectory(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Docs capture output failed");
  }
  const entries = await readdir(path, { withFileTypes: true });
  const expected = CAPTURE_NAMES.map((name) => `${name}.webp`).sort();
  const actual = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error("Docs capture output failed");
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function startCaptureServer(options: {
  databaseUrl: string;
  fontMockPath: string;
  pnpm: PnpmInvocation;
  runNonce: string;
  signal: AbortSignal;
}): Promise<CaptureServer> {
  const deadline = Date.now() + 90_000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (options.signal.aborted) throw new Error("Docs capture server failed");
    const port = await reserveLoopbackPort();
    const environment = createCaptureEnvironment(process.env, {
      databaseUrl: options.databaseUrl,
      fontMockPath: options.fontMockPath,
      port,
      runNonce: options.runNonce,
    });
    let managed: ManagedProcess | undefined;
    try {
      managed = spawnManagedProcess(
        options.pnpm.command,
        [
          ...options.pnpm.prefixArguments,
          "exec",
          "next",
          "dev",
          NEXT_CAPTURE_BUNDLER_ARGUMENT,
          "-H",
          "127.0.0.1",
          "-p",
          String(port),
        ],
        {
          cwd: APP_ROOT,
          env: environment,
          stdio: "ignore",
        },
      );
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForReadiness({
        baseUrl,
        deadline,
        managed,
        runNonce: options.runNonce,
        signal: options.signal,
      });
      return { baseUrl, managed, port };
    } catch {
      let cleanupFailed = false;
      if (managed) {
        try {
          await stopManagedProcess(managed);
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await waitForPortRelease(port, { timeoutMs: 5_000 });
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed || options.signal.aborted) {
        throw new Error("Docs capture server failed");
      }
    }
  }
  throw new Error("Docs capture server failed");
}

async function waitForReadiness(options: {
  baseUrl: string;
  deadline: number;
  managed: ManagedProcess;
  runNonce: string;
  signal: AbortSignal;
}) {
  const childExited = options.managed.exit.then(() => {
    throw new Error("Docs capture server failed");
  });
  while (Date.now() < options.deadline && !options.signal.aborted) {
    try {
      const ready = await Promise.race([
        fetchOwnedReadiness(
          options.baseUrl,
          options.runNonce,
          options.signal,
        ),
        childExited,
      ]);
      if (ready) return;
    } catch {
      if (
        options.signal.aborted ||
        options.managed.child.exitCode !== null ||
        options.managed.child.signalCode !== null
      ) {
        throw new Error("Docs capture server failed");
      }
      // The reserved port is expected to refuse connections until Next is ready.
    }
    await waitForReadinessRetry(options.managed, options.signal, 250);
  }
  throw new Error("Docs capture server failed");
}

function waitForReadinessRetry(
  managed: ManagedProcess,
  signal: AbortSignal,
  milliseconds: number,
) {
  return new Promise<void>((resolveDelay, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
      if (error) reject(error);
      else resolveDelay();
    };
    const handleAbort = () => finish(new Error("Docs capture server failed"));
    const timeout = setTimeout(() => finish(), milliseconds);
    signal.addEventListener("abort", handleAbort, { once: true });
    void managed.exit.then(() =>
      finish(new Error("Docs capture server failed")),
    );
    if (signal.aborted) handleAbort();
  });
}

async function fetchOwnedReadiness(
  baseUrl: string,
  runNonce: string,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  const handleAbort = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  signal.addEventListener("abort", handleAbort, { once: true });
  if (signal.aborted) handleAbort();
  try {
    const response = await fetch(`${baseUrl}/api/ready`, {
      cache: "no-store",
      headers: { "X-Coredot-Tool-Run-Nonce": runNonce },
      redirect: "manual",
      signal: controller.signal,
    });
    const ready =
      response.status === 200 &&
      response.headers.get("X-Coredot-Tool-Run-Nonce") === runNonce;
    await response.body?.cancel().catch(() => undefined);
    return ready;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", handleAbort);
  }
}

async function disposeCaptureServer(
  server: CaptureServer,
  signal?: AbortSignal,
) {
  let failed = false;
  try {
    await stopManagedProcess(server.managed);
  } catch {
    failed = true;
  }
  try {
    await waitForPortRelease(server.port, { signal, timeoutMs: 5_000 });
  } catch {
    failed = true;
  }
  if (failed) throw new Error("Docs capture cleanup failed");
}

async function reserveLoopbackPort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new Error("Docs capture port failed")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error || port < 1) reject(new Error("Docs capture port failed"));
        else resolvePort(port);
      });
    });
  });
}

function validateDatabaseUrl(databaseUrl: string) {
  if (
    !databaseUrl.startsWith("file:") ||
    databaseUrl.includes("\0") ||
    databaseUrl.includes("\n") ||
    databaseUrl.includes("\r")
  ) {
    throw new Error("Docs capture environment failed");
  }
  const databasePath = databaseUrl.slice("file:".length);
  if (!isAbsolute(databasePath) && !win32.isAbsolute(databasePath)) {
    throw new Error("Docs capture environment failed");
  }
}

async function main() {
  if (process.argv[2] === "--bootstrap") {
    await bootstrapCaptureWorkspace();
    return;
  }
  const outcome = await captureDocsAssets();
  if ("signal" in outcome) {
    process.exitCode = interruptExitCode(outcome.signal);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error &&
      /^Docs capture (?:cleanup failed|failed during (?:browser startup|database migration|document API creation|DOCX import|editor load|fidelity screenshot|import page load|output write|proposal screenshot|review finding|review pending status|review response|review settled|review trigger|server startup|workspace screenshot|workspace bootstrap))$/.test(
        error.message,
      )
        ? error.message
        : "Docs capture failed";
    console.error(message);
    process.exitCode = 1;
  });
}
