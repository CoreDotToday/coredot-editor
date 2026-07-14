import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  chromium,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import sharp from "sharp";
import { createToolEnvironment } from "./verify-quick-start-shared";
import { createMixedFidelityDocx } from "./fixtures/mixed-fidelity-docx";

export const DOCS_VIEWPORT = { width: 1440, height: 1000 } as const;
export const DOCS_LANGUAGE_STORAGE_KEY = "coredot-editor-language";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const SCREENSHOTS_ROOT = resolve(APP_ROOT, "docs/assets/screenshots");
const CAPTURE_NAMES = ["workspace", "proposal-review", "docx-fidelity"] as const;
const WEBP_QUALITY_STEPS = [88, 82, 76, 70, 64, 58, 52] as const;
const DEFAULT_WEBP_MAX_BYTES = 350 * 1024;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const FIXED_CAPTURE_ENVIRONMENT = {
  AI_PROVIDER: "stub",
  AUTH_MODE: "test",
  NEXT_TELEMETRY_DISABLED: "1",
  TEST_PRINCIPAL_ID: "test:principal:docs-capture",
  TEST_WORKSPACE_ID: "test:workspace:docs-capture",
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

type ChildExit = {
  code: number | null;
  error: boolean;
  signal: NodeJS.Signals | null;
};

type CaptureServer = {
  baseUrl: string;
  child: ChildProcess;
  exit: Promise<ChildExit>;
};

export function createCaptureEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  options: { databaseUrl: string; port: number },
): NodeJS.ProcessEnv {
  validateDatabaseUrl(options.databaseUrl);
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535
  ) {
    throw new Error("Docs capture environment failed");
  }

  return {
    ...createToolEnvironment(baseEnvironment),
    ...FIXED_CAPTURE_ENVIRONMENT,
    DATABASE_URL: options.databaseUrl,
    HOSTNAME: "127.0.0.1",
    PORT: String(options.port),
  };
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
  let failed = false;
  for (const step of steps) {
    try {
      await step();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Docs capture cleanup failed");
}

async function captureDocsAssets() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "coredot-docs-capture-"));
  const databasePath = join(temporaryRoot, "capture.sqlite");
  const databaseUrl = `file:${databasePath}`;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let server: CaptureServer | undefined;
  let captureFailed = false;
  let cleanupFailed = false;
  let phase: CapturePhase = "database migration";

  try {
    const databaseEnvironment = createCaptureEnvironment(process.env, {
      databaseUrl,
      port: 1,
    });
    await runCommand("pnpm", ["db:migrate"], databaseEnvironment, 60_000);
    phase = "workspace bootstrap";
    await runCommand(
      "pnpm",
      ["exec", "tsx", SCRIPT_PATH, "--bootstrap"],
      databaseEnvironment,
      30_000,
    );

    phase = "server startup";
    server = await startCaptureServer(databaseUrl);
    phase = "browser startup";
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      baseURL: server.baseUrl,
      colorScheme: "light",
      deviceScaleFactor: 1,
      locale: "en-US",
      reducedMotion: "reduce",
      timezoneId: "UTC",
      viewport: DOCS_VIEWPORT,
    });
    await installDeterministicPageState(context);

    phase = "document API creation";
    const captures = await captureProductStates(
      context,
      server.baseUrl,
      (nextPhase) => {
        phase = nextPhase;
      },
    );
    phase = "output write";
    await writeCapturesAtomically(captures);
    for (const name of CAPTURE_NAMES) {
      console.log(`${name}.webp ${captures.get(name)!.byteLength} bytes`);
    }
  } catch {
    captureFailed = true;
  } finally {
    try {
      await runCaptureCleanup([
        async () => {
          await context?.close();
        },
        async () => {
          await browser?.close();
        },
        async () => {
          if (server) await stopManagedChild(server.child, server.exit);
        },
        async () => {
          await rm(temporaryRoot, { force: true, recursive: true });
        },
      ]);
    } catch {
      cleanupFailed = true;
    }
  }

  if (captureFailed) throw new Error(`Docs capture failed during ${phase}`);
  if (cleanupFailed) throw new Error("Docs capture cleanup failed");
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
  const response = await context.request.post("/api/documents", {
    data: {
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
    headers: { "Idempotency-Key": "docs_capture_product_brief_v1" },
  });
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
  const privateIdentity = page.getByText("Kyunghoon K...", { exact: true });
  if ((await privateIdentity.count()) > 0) {
    await privateIdentity.evaluateAll((elements) => {
      for (const element of elements) {
        (element as HTMLElement).style.visibility = "hidden";
      }
    });
  }
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

async function writeCapturesAtomically(captures: Map<CaptureName, Buffer>) {
  await mkdir(SCREENSHOTS_ROOT, { recursive: true });
  for (const name of CAPTURE_NAMES) {
    const contents = captures.get(name);
    if (!contents) throw new Error("Docs capture output failed");
    const target = screenshotPath(name);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: "wx" });
      await rename(temporary, target);
    } catch {
      throw new Error("Docs capture output failed");
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function startCaptureServer(databaseUrl: string): Promise<CaptureServer> {
  const deadline = Date.now() + 90_000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await reserveLoopbackPort();
    const environment = createCaptureEnvironment(process.env, {
      databaseUrl,
      port,
    });
    const child = spawn(
      "pnpm",
      ["exec", "next", "dev", "-H", "127.0.0.1", "-p", String(port)],
      {
        cwd: APP_ROOT,
        detached: process.platform !== "win32",
        env: environment,
        stdio: "ignore",
      },
    );
    const exit = observeChildExit(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForReadiness(baseUrl, child, deadline);
      return { baseUrl, child, exit };
    } catch {
      await stopManagedChild(child, exit).catch(() => undefined);
    }
  }
  throw new Error("Docs capture server failed");
}

async function waitForReadiness(
  baseUrl: string,
  child: ChildProcess,
  deadline: number,
) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Docs capture server failed");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`${baseUrl}/documents`, {
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      });
      const ready = response.status === 200;
      await response.body?.cancel().catch(() => undefined);
      if (ready) return;
    } catch {
      // The reserved port is expected to refuse connections until Next is ready.
    } finally {
      clearTimeout(timeout);
    }
    await delay(250);
  }
  throw new Error("Docs capture server failed");
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

async function runCommand(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  const child = spawn(command, arguments_, {
    cwd: APP_ROOT,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "ignore",
  });
  const exit = observeChildExit(child);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
  });
  const result = await Promise.race([exit, timedOut]);
  if (timeout) clearTimeout(timeout);
  if (result === "timeout") {
    await stopManagedChild(child, exit).catch(() => undefined);
    throw new Error("Docs capture command failed");
  }
  if (result.error || result.signal !== null || result.code !== 0) {
    throw new Error("Docs capture command failed");
  }
}

function observeChildExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      error: false,
      signal: child.signalCode,
    });
  }
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (result: ChildExit) => {
      if (settled) return;
      settled = true;
      resolveExit(result);
    };
    child.once("error", () =>
      finish({ code: null, error: true, signal: null }),
    );
    child.once("close", (code, signal) =>
      finish({ code, error: false, signal }),
    );
  });
}

async function stopManagedChild(child: ChildProcess, exit: Promise<ChildExit>) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exit;
    return;
  }
  signalProcessTree(child, "SIGTERM");
  if (await waitForExitWithin(exit, 5_000)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForExitWithin(exit, 5_000))) {
    throw new Error("Docs capture cleanup failed");
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // A process may exit between the state check and signal delivery.
  }
}

async function waitForExitWithin(exit: Promise<ChildExit>, timeoutMs: number) {
  return Promise.race([
    exit.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
  await captureDocsAssets();
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
