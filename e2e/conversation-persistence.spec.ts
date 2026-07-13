import { expect, test } from "@playwright/test";

test("persists, reloads, shares, and archives an AI conversation", async ({ browser, page }) => {
  const title = `Conversation persistence ${Date.now()}`;
  const body = "This conversation must survive reloads and a fresh browser context.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await expect(page).toHaveURL(/\/documents\/[^/]+$/, { timeout: 15_000 });
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);
  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.fill(body);
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("status", { name: "문서 저장 상태" })).toHaveText("저장됨");
  const documentUrl = page.url();

  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  await page.route("**/api/documents/*/conversations", async (route) => {
    if (route.request().method() === "POST") await createGate;
    await route.continue();
  });

  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "한국어로 번역" }).click();

  const workspace = page.getByRole("complementary", { name: "AI 작업 영역" });
  await workspace.getByRole("tab", { name: "대화" }).click();
  await expect(workspace.getByRole("tab", { name: "한국어로 번역" })).toBeVisible();
  await expect(workspace.getByText(/대화 저장 중/)).toBeVisible();
  await expect(workspace.getByText("이 문서에 저장됨")).toHaveCount(0);

  releaseCreate();
  await expect(workspace.getByText(`Stub rewrite: ${body}`)).toBeVisible({ timeout: 15_000 });
  await expect(workspace.getByText("이 문서에 저장됨")).toBeVisible();

  await page.reload();
  const reloadedWorkspace = page.getByRole("complementary", { name: "AI 작업 영역" });
  await reloadedWorkspace.getByRole("tab", { name: "대화" }).click();
  await expect(reloadedWorkspace.getByRole("tab", { name: "한국어로 번역" })).toBeVisible();
  await expect(reloadedWorkspace.getByText(`Stub rewrite: ${body}`)).toBeVisible();

  const observerContext = await browser.newContext();
  const observer = await observerContext.newPage();
  try {
    await observer.goto(documentUrl);
    const observerWorkspace = observer.getByRole("complementary", { name: "AI 작업 영역" });
    await observerWorkspace.getByRole("tab", { name: "대화" }).click();
    await expect(observerWorkspace.getByRole("tab", { name: "한국어로 번역" })).toBeVisible();
    await expect(observerWorkspace.getByText(`Stub rewrite: ${body}`)).toBeVisible();

    const archived = observer.waitForResponse((response) =>
      response.request().method() === "PATCH" && /\/api\/conversations\/[^/]+$/.test(response.url())
    );
    await observerWorkspace.getByRole("button", { name: "대화 숨기기" }).click();
    expect((await archived).ok()).toBe(true);
    await observer.reload();
    const archivedWorkspace = observer.getByRole("complementary", { name: "AI 작업 영역" });
    await archivedWorkspace.getByRole("tab", { name: "대화" }).click();
    await expect(archivedWorkspace.getByRole("tab", { name: "한국어로 번역" })).toHaveCount(0);
    await expect(archivedWorkspace.getByText(`Stub rewrite: ${body}`)).toHaveCount(0);
  } finally {
    await observerContext.close();
  }
});
