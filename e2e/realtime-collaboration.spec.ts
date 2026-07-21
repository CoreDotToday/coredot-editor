import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { E2E_TEST_IDENTITY_SIGNING_SECRET } from "../playwright.config";
import {
  createSignedTestIdentityHeader,
  TEST_IDENTITY_HEADER,
} from "../src/features/auth/test-request-context";

const WORKSPACE_ID = "e2e-workspace";
const SECOND_PRINCIPAL_ID = "e2e-user-b";
const INTRUDER_WORKSPACE_ID = "e2e-workspace-intruder";
const INTRUDER_PRINCIPAL_ID = "e2e-intruder";

function signIdentity(principalId: string, workspaceId: string) {
  return createSignedTestIdentityHeader(
    {
      expiresAt: new Date(Date.now() + 55_000),
      principalId,
      workspaceId,
    },
    E2E_TEST_IDENTITY_SIGNING_SECRET,
  );
}

async function createIdentityContext(
  browser: Browser,
  principalId: string,
  workspaceId = WORKSPACE_ID,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        [TEST_IDENTITY_HEADER]: signIdentity(principalId, workspaceId),
      },
    });
  });
  return context;
}

async function createCollaborativeDocument(
  page: Page,
  input: { body: string; title: string },
) {
  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await expect(page).toHaveURL(/\/documents\/[^/]+$/, { timeout: 20_000 });
  await page.getByRole("textbox", { name: "문서 제목" }).fill(input.title);
  await page.getByRole("textbox", { name: "문서 본문" }).fill(input.body);

  const documentUrl = page.url();
  const documentId = documentUrl.split("/").at(-1)!;
  // Legacy autosave persists the draft; poll the API instead of racing the
  // manual save button against the autosave debounce.
  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/documents/${encodeURIComponent(documentId)}`,
    );
    if (!response.ok()) return null;
    const payload = await response.json() as {
      document: { plainText: string; title: string };
    };
    return payload.document.title === input.title
      && payload.document.plainText.includes(input.body)
      ? "saved"
      : null;
  }, { timeout: 30_000 }).toBe("saved");
  // The capability issuer reports transient SQLite write contention as a
  // retryable 503 with Retry-After; honor that contract instead of failing on
  // the first busy write from a parallel worker.
  await expect.poll(async () => {
    const capability = await page.request.post(
      `/api/documents/${encodeURIComponent(documentId)}/collaboration-capability`,
    );
    if (capability.ok()) return "issued";
    const body = await capability.text();
    if (capability.status() === 503) return `retryable 503: ${body}`;
    throw new Error(`capability POST failed: ${String(capability.status())} ${body}`);
  }, { timeout: 15_000 }).toBe("issued");

  await page.reload();
  await expect(collaborationStatus(page)).toHaveAttribute(
    "data-collaboration-status",
    "synced",
    { timeout: 30_000 },
  );
  return { documentId, documentUrl };
}

function collaborationStatus(page: Page) {
  return page.locator("[data-collaboration-status]");
}

function bodyEditor(page: Page) {
  return page.getByRole("textbox", { name: "문서 본문" });
}

function titleInput(page: Page) {
  return page.getByRole("textbox", { name: "문서 제목" });
}

async function openSynchronizedPage(context: BrowserContext, documentUrl: string) {
  const page = await context.newPage();
  await page.goto(documentUrl);
  await expect(collaborationStatus(page)).toHaveAttribute(
    "data-collaboration-status",
    "synced",
    { timeout: 30_000 },
  );
  return page;
}

test.describe("real-time collaboration", () => {
  test.beforeEach(() => {
    test.setTimeout(240_000);
  });

  test("two principals converge on body, title, and metadata keys with grouped participants and cursors", async ({ browser, page }) => {
    const title = `Collab convergence ${Date.now()}`;
    const body = "Shared collaborative base body for convergence coverage.";
    const { documentUrl } = await createCollaborativeDocument(page, { body, title });

    const contextB = await createIdentityContext(browser, SECOND_PRINCIPAL_ID);
    try {
      const pageB = await openSynchronizedPage(contextB, documentUrl);
      await expect(bodyEditor(pageB)).toContainText(body, { timeout: 20_000 });

      // Body converges from A to B.
      await bodyEditor(page).click();
      await page.keyboard.type(" alpha-body-edit ");
      await expect(bodyEditor(pageB)).toContainText("alpha-body-edit", { timeout: 20_000 });

      // Title converges from B to A.
      const revisedTitle = `${title} revised-by-b`;
      await titleInput(pageB).fill(revisedTitle);
      await expect(titleInput(page)).toHaveValue(revisedTitle, { timeout: 20_000 });

      // Different metadata keys from different principals both survive.
      await page.getByLabel("소유자").fill("Alice");
      await page.getByLabel("소유자").blur();
      await pageB.getByLabel("분류").fill("Research");
      await pageB.getByLabel("분류").blur();
      await expect(page.getByLabel("분류")).toHaveValue("Research", { timeout: 20_000 });
      await expect(pageB.getByLabel("소유자")).toHaveValue("Alice", { timeout: 20_000 });

      // Two principals group into two participants.
      await expect(
        page.getByRole("button", { name: "참여자 목록 열기 (2명)" }),
      ).toBeVisible({ timeout: 20_000 });

      // A second tab for the same principal groups as one participant with
      // two sessions instead of adding a third participant.
      const secondTab = await openSynchronizedPage(page.context(), documentUrl);
      await expect(
        page.getByRole("button", { name: "참여자 목록 열기 (2명)" }),
      ).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "참여자 목록 열기 (2명)" }).click();
      await expect(
        page
          .getByRole("list", { name: "참여자 세부 목록" })
          .getByRole("listitem")
          .filter({ hasText: "현재 사용자" }),
      ).toContainText("2개 세션", { timeout: 20_000 });
      await secondTab.close();

      // B's caret becomes visible to A.
      await bodyEditor(pageB).click();
      await expect(
        page.locator(".collaboration-carets__caret").first(),
      ).toBeAttached({ timeout: 20_000 });
    } finally {
      await contextB.close();
    }
  });

  test("an open tab keeps offline edits and merges them after reconnecting", async ({ browser, page }) => {
    const title = `Collab offline merge ${Date.now()}`;
    const body = "Offline merge base body.";
    const { documentUrl } = await createCollaborativeDocument(page, { body, title });

    const contextB = await createIdentityContext(browser, SECOND_PRINCIPAL_ID);
    try {
      const pageB = await openSynchronizedPage(contextB, documentUrl);

      await page.context().setOffline(true);
      await bodyEditor(page).click();
      await page.keyboard.type(" offline-only-edit ");
      await expect(collaborationStatus(page)).toHaveAttribute(
        "data-collaboration-status",
        /offline_pending|reconnecting|storage_delayed/,
        { timeout: 30_000 },
      );

      await titleInput(pageB).fill("Offline merge concurrent-online-edit");
      

      await page.context().setOffline(false);
      await expect(collaborationStatus(page)).toHaveAttribute(
        "data-collaboration-status",
        "synced",
        { timeout: 60_000 },
      );
      await expect(titleInput(page)).toHaveValue(
        "Offline merge concurrent-online-edit",
        { timeout: 20_000 },
      );
      await expect(bodyEditor(pageB)).toContainText("offline-only-edit", { timeout: 20_000 });
    } finally {
      await contextB.close();
    }
  });

  test("editing an approved document invalidates approval into needs_review for every context", async ({ browser, page }) => {
    const title = `Collab approval ${Date.now()}`;
    const body = "Approval invalidation base body.";
    const { documentId, documentUrl } = await createCollaborativeDocument(page, { body, title });

    const workflowUrl = `/api/documents/${encodeURIComponent(documentId)}/workflow`;
    const readyResponse = await page.request.post(workflowUrl, {
      data: { expectedReadiness: "draft", nextReadiness: "ready" },
    });
    expect(readyResponse.ok()).toBe(true);
    const currentWorkflow = await page.request.get(workflowUrl);
    expect(currentWorkflow.ok()).toBe(true);
    const workflowBody = await currentWorkflow.json() as {
      workflow: { collaboration: { headSeq: number } | null; readiness: string };
    };
    expect(workflowBody.workflow.collaboration).not.toBeNull();
    const approveResponse = await page.request.post(workflowUrl, {
      data: {
        expectedReadiness: "ready",
        nextReadiness: "approved",
        observedHeadSeq: workflowBody.workflow.collaboration!.headSeq,
      },
    });
    expect(approveResponse.ok()).toBe(true);

    await page.reload();
    await expect(collaborationStatus(page)).toHaveAttribute(
      "data-collaboration-status",
      "synced",
      { timeout: 30_000 },
    );
    await expect(page.getByLabel("준비 상태")).toHaveValue("approved", { timeout: 20_000 });

    const contextB = await createIdentityContext(browser, SECOND_PRINCIPAL_ID);
    try {
      const pageB = await openSynchronizedPage(contextB, documentUrl);
      await bodyEditor(pageB).click();
      await pageB.keyboard.type(" invalidating-edit ");

      await expect.poll(async () => {
        const response = await page.request.get(workflowUrl);
        if (!response.ok()) return "unavailable";
        const state = await response.json() as { workflow: { readiness: string } };
        return state.workflow.readiness;
      }, { timeout: 30_000 }).toBe("needs_review");
      await expect(page.getByLabel("준비 상태")).toHaveValue("needs_review", {
        timeout: 45_000,
      });
    } finally {
      await contextB.close();
    }
  });

  test("an applied AI proposal reaches both contexts and selective undo preserves unrelated edits", async ({ browser, page }) => {
    const title = `Collab AI apply ${Date.now()}`;
    const body = "Revenue retention needs clearer evidence before the executive review.";
    const { documentUrl } = await createCollaborativeDocument(page, { body, title });

    const contextB = await createIdentityContext(browser, SECOND_PRINCIPAL_ID);
    try {
      const pageB = await openSynchronizedPage(contextB, documentUrl);

      await page.getByRole("radio", { name: "Strategy Review" }).click();
      await page.getByLabel("대상 독자").fill("Executive leadership");
      await page.getByLabel("문서 목표").fill("Improve collaborative review readiness.");
      await page.getByLabel("톤").selectOption("analytical");
      await page.getByRole("button", { name: "문서 검토" }).click();
      await expect(page.getByText("Stub review finding")).toBeVisible({ timeout: 60_000 });

      await page.getByRole("button", { name: `${body} 제안으로 교체` }).click();
      await expect(page.getByText("수락됨")).toBeVisible({ timeout: 30_000 });
      await expect(bodyEditor(page)).toContainText(`${body} [reviewed]`, { timeout: 20_000 });
      await expect(bodyEditor(pageB)).toContainText(`${body} [reviewed]`, { timeout: 20_000 });

      // An unrelated concurrent edit from the second principal.
      const unrelatedTitle = `${title} unrelated-edit`;
      await titleInput(pageB).fill(unrelatedTitle);
      await expect(titleInput(page)).toHaveValue(unrelatedTitle, { timeout: 20_000 });

      await page.getByRole("tab", { name: "변경내역" }).click();
      await page.getByRole("button", { name: /변경 되돌리기/ }).first().click();
      await expect(bodyEditor(page)).not.toContainText("[reviewed]", { timeout: 30_000 });
      await expect(bodyEditor(pageB)).not.toContainText("[reviewed]", { timeout: 30_000 });
      await expect(bodyEditor(page)).toContainText(body);
      await expect(bodyEditor(pageB)).toContainText(body);

      // The unrelated edit survives the selective undo in both contexts.
      await expect(titleInput(page)).toHaveValue(unrelatedTitle);
      await expect(titleInput(pageB)).toHaveValue(unrelatedTitle);
    } finally {
      await contextB.close();
    }
  });

  test("an initial connection failure stays read-only without legacy autosave", async ({ page }) => {
    const title = `Collab read-only ${Date.now()}`;
    const body = "Initial connection failure base body.";
    await createCollaborativeDocument(page, { body, title });

    await page.route("**/collaboration-capability", async (route) => {
      await route.fulfill({
        json: { error: "Collaboration capability unavailable" },
        status: 503,
      });
    });
    await page.reload();

    // A retryable capability failure keeps the session in a non-writable
    // connecting/reconnecting loop; an unrecoverable one is fatal. Neither
    // may ever fall back to legacy autosave or writable editing.
    await expect(collaborationStatus(page)).toHaveAttribute(
      "data-collaboration-status",
      /connecting|reconnecting|fatal/,
      { timeout: 30_000 },
    );
    // No writable editor may exist: the body is either absent or read-only.
    await expect(
      page.locator('[aria-label="문서 본문"][contenteditable="true"]'),
    ).toHaveCount(0);
    // The legacy save affordance stays permanently disabled: no fallback to
    // legacy autosave exists for an initialized collaborative document.
    await expect(page.getByRole("button", { exact: true, name: "저장" })).toBeDisabled();
    await expect(collaborationStatus(page)).not.toHaveAttribute(
      "data-collaboration-status",
      "synced",
    );
  });

  test("another workspace cannot open the document or obtain a capability", async ({ browser, page }) => {
    const title = `Collab isolation ${Date.now()}`;
    const body = "Cross-workspace isolation base body.";
    const { documentId, documentUrl } = await createCollaborativeDocument(page, { body, title });

    const intruderContext = await createIdentityContext(
      browser,
      INTRUDER_PRINCIPAL_ID,
      INTRUDER_WORKSPACE_ID,
    );
    try {
      const intruderPage = await intruderContext.newPage();
      const navigation = await intruderPage.goto(documentUrl);
      expect(navigation?.status()).toBe(404);
      await expect(intruderPage.getByRole("textbox", { name: "문서 제목" })).toHaveCount(0);

      const capability = await intruderContext.request.post(
        `/api/documents/${encodeURIComponent(documentId)}/collaboration-capability`,
        {
          headers: {
            [TEST_IDENTITY_HEADER]: signIdentity(
              INTRUDER_PRINCIPAL_ID,
              INTRUDER_WORKSPACE_ID,
            ),
          },
        },
      );
      expect(capability.status()).toBe(404);
    } finally {
      await intruderContext.close();
    }
  });
});
