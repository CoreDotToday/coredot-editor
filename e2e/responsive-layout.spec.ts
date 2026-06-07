import { expect, test } from "@playwright/test";

test("document editor keeps a usable canvas on narrow mobile viewports", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.fill("모바일 레이아웃에서도 문서 본문이 충분한 폭으로 보여야 합니다.");

  const metrics = await page.evaluate(() => {
    const editorElement = document.querySelector<HTMLElement>('[contenteditable="true"]');
    const editorRect = editorElement?.getBoundingClientRect();
    const visibleSidebars = Array.from(document.querySelectorAll("aside")).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.display !== "none" && rect.width > 0 && rect.right > 0 && rect.left < window.innerWidth;
    });

    return {
      editorLeft: editorRect?.left ?? 0,
      editorRight: editorRect?.right ?? 0,
      editorWidth: editorRect?.width ?? 0,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      visibleSidebarCount: visibleSidebars.length,
    };
  });

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.visibleSidebarCount).toBe(0);
  expect(metrics.editorLeft).toBeGreaterThanOrEqual(0);
  expect(metrics.editorRight).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.editorWidth).toBeGreaterThanOrEqual(320);

  await page.getByRole("button", { name: "검토" }).click();
  const aiWorkspace = page.getByRole("complementary", { name: "AI 작업 영역" });
  await expect(aiWorkspace.getByRole("tabpanel", { name: "검토" })).toBeVisible();
  await expect(aiWorkspace.getByRole("heading", { name: "AI 검토" })).toBeVisible();
  await aiWorkspace.getByRole("button", { name: "AI 작업 영역 닫기" }).click();
  await expect(page.getByRole("tabpanel", { name: "검토" })).toHaveCount(0);

  await page.getByRole("button", { name: "사이드바 열기" }).click();
  await expect(page.getByRole("button", { name: "새로 만들기" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "템플릿" })).toBeVisible();
  await page.getByRole("button", { name: "사이드바 닫기" }).first().click();
  await expect(page.getByRole("button", { name: "새로 만들기" })).toHaveCount(0);
});

test("document editor avoids horizontal overflow on tablet width", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await expect(editor).toBeVisible({ timeout: 15_000 });

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
});
