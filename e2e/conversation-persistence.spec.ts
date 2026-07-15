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
  const chatTab = workspace.getByRole("tab", { name: "대화", exact: true });
  await chatTab.click();
  await expect(chatTab).toHaveAttribute("aria-selected", "true");
  await expect(workspace.getByRole("tab", { name: "한국어로 번역" })).toBeVisible();
  await expect(workspace.getByText(/대화 저장 중/)).toBeVisible();
  await expect(workspace.getByText("이 문서에 저장됨")).toHaveCount(0);

  const createdResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/documents\/[^/]+\/conversations$/.test(response.url())
  );
  releaseCreate();
  const createdResponse = await createdResponsePromise;
  const createdPayload = await createdResponse.json() as { conversation: { id: string } };
  await expect(workspace.getByText(`Stub rewrite: ${body}`)).toBeVisible({ timeout: 15_000 });
  await expect(workspace.getByText("이 문서에 저장됨")).toBeVisible();

  const documentId = new URL(documentUrl).pathname.split("/").at(-1)!;
  const summaryResponse = await page.request.get(`/api/documents/${documentId}/conversations?limit=1`);
  expect(summaryResponse.ok()).toBe(true);
  const summaryPayload = await summaryResponse.json() as {
    conversations: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };
  expect(summaryPayload.conversations[0]?.id).toBe(createdPayload.conversation.id);
  expect(summaryPayload.conversations[0]).not.toHaveProperty("messages");
  expect(summaryPayload).toHaveProperty("nextCursor");

  const detailResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    response.url().endsWith(`/api/conversations/${createdPayload.conversation.id}`)
  );
  await page.reload();
  const detailResponse = await detailResponsePromise;
  expect(detailResponse.ok()).toBe(true);
  expect(await detailResponse.json()).toMatchObject({
    conversation: { id: createdPayload.conversation.id, messages: { length: 2 } },
  });
  const reloadedWorkspace = page.getByRole("complementary", { name: "AI 작업 영역" });
  const reloadedChatTab = reloadedWorkspace.getByRole("tab", { name: "대화", exact: true });
  await reloadedChatTab.click();
  await expect(reloadedChatTab).toHaveAttribute("aria-selected", "true");
  await expect(reloadedWorkspace.getByRole("tab", { name: "한국어로 번역" })).toBeVisible();
  await expect(reloadedWorkspace.getByText(`Stub rewrite: ${body}`)).toBeVisible();

  const observerContext = await browser.newContext();
  const observer = await observerContext.newPage();
  const observerPageErrors: string[] = [];
  const observerHydrationErrors: string[] = [];
  observer.on("pageerror", (error) => observerPageErrors.push(error.message));
  observer.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|hydrated|server rendered|did(?: not|n't) match/i.test(message.text())
    ) {
      observerHydrationErrors.push(message.text());
    }
  });
  try {
    await observer.goto(documentUrl);
    const observerWorkspace = observer.getByRole("complementary", { name: "AI 작업 영역" });
    const observerChatTab = observerWorkspace.getByRole("tab", { name: "대화", exact: true });
    await observerChatTab.click();
    await expect(observerChatTab).toHaveAttribute("aria-selected", "true");
    await expect(
      observerWorkspace.getByRole("alert").filter({ hasText: "대화를 불러오거나 저장하지 못했습니다." }),
    ).toHaveCount(0);
    await expect(observerWorkspace.getByRole("tab", { name: "한국어로 번역" })).toBeVisible();
    await expect(observerWorkspace.getByText(`Stub rewrite: ${body}`)).toBeVisible();
    expect(observerPageErrors).toEqual([]);
    expect(observerHydrationErrors).toEqual([]);

    const archived = observer.waitForResponse((response) =>
      response.request().method() === "PATCH" && /\/api\/conversations\/[^/]+$/.test(response.url())
    );
    await observerWorkspace.getByRole("button", { name: "대화 숨기기" }).click();
    expect((await archived).ok()).toBe(true);
    await observer.reload();
    const archivedWorkspace = observer.getByRole("complementary", { name: "AI 작업 영역" });
    const archivedChatTab = archivedWorkspace.getByRole("tab", { name: "대화", exact: true });
    await archivedChatTab.click();
    await expect(archivedChatTab).toHaveAttribute("aria-selected", "true");
    await expect(archivedWorkspace.getByRole("tab", { name: "한국어로 번역" })).toHaveCount(0);
    await expect(archivedWorkspace.getByText(`Stub rewrite: ${body}`)).toHaveCount(0);
    expect(observerPageErrors).toEqual([]);
    expect(observerHydrationErrors).toEqual([]);
  } finally {
    await observerContext.close();
  }
});
