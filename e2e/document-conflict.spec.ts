import { expect, test } from "@playwright/test";

test("preserves both drafts across a two-tab revision conflict and can save the local draft as new", async ({ page }) => {
  const baseTitle = `Conflict base ${Date.now()}`;
  const writerATitle = `${baseTitle} writer A`;
  const writerBTitle = `${baseTitle} writer B`;
  const baseBody = "Shared base body for revision conflict coverage.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await expect(page).toHaveURL(/\/documents\/[^/]+$/, { timeout: 15_000 });
  await page.getByRole("textbox", { name: "문서 제목" }).fill(baseTitle);
  await page.getByRole("textbox", { name: "문서 본문" }).fill(baseBody);
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("status", { name: "문서 저장 상태" })).toHaveText("저장됨");
  const originalUrl = page.url();

  const stalePage = await page.context().newPage();
  await stalePage.goto(originalUrl);
  await expect(stalePage.getByRole("textbox", { name: "문서 제목" })).toHaveValue(baseTitle);

  await page.getByRole("textbox", { name: "문서 제목" }).fill(writerATitle);
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("status", { name: "문서 저장 상태" })).toHaveText("저장됨");

  await stalePage.getByRole("textbox", { name: "문서 제목" }).fill(writerBTitle);
  await stalePage.getByRole("button", { name: "저장" }).click();
  await expect(stalePage.locator('section[role="alert"]')).toContainText("다른 곳에서 문서가 변경되었습니다.");
  await expect(stalePage.getByRole("textbox", { name: "문서 제목" })).toHaveValue(writerBTitle);

  const observerPage = await page.context().newPage();
  await observerPage.goto(originalUrl);
  await expect(observerPage.getByRole("textbox", { name: "문서 제목" })).toHaveValue(writerATitle);
  await expect(observerPage.getByRole("textbox", { name: "문서 본문" })).toContainText(baseBody);

  await stalePage.getByRole("button", { name: "새 문서로 저장" }).click();
  await expect.poll(() => stalePage.url(), { timeout: 15_000 }).not.toBe(originalUrl);
  await expect(stalePage).toHaveURL(/\/documents\/[^/]+$/);
  await expect(stalePage.getByRole("textbox", { name: "문서 제목" })).toHaveValue(writerBTitle);
  await expect(stalePage.getByRole("textbox", { name: "문서 본문" })).toContainText(baseBody);

  await observerPage.reload();
  await expect(observerPage.getByRole("textbox", { name: "문서 제목" })).toHaveValue(writerATitle);
});
