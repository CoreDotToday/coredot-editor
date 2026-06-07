import { expect, test } from "@playwright/test";

test("creates a document and accepts a stub AI review proposal", async ({ page }) => {
  const title = `AI workflow ${Date.now()}`;
  const body = "Revenue retention needs clearer evidence before the executive review.";

  await page.goto("/documents");

  await expect(page.getByRole("heading", { exact: true, level: 1, name: "문서" })).toBeVisible();
  await page.getByRole("button", { name: "새 문서" }).click();

  await expect(page.getByRole("textbox", { name: "문서 제목" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);
  await page.getByRole("textbox", { name: "문서 본문" }).fill(body);
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("status", { name: "문서 저장 상태" })).toHaveText("저장됨");

  await page.getByRole("radio", { name: "Strategy Review" }).click();
  await page.getByLabel("대상 독자").fill("Executive leadership");
  await page.getByLabel("문서 목표").fill("Improve decision readiness for the quarterly strategy review.");
  await page.getByLabel("톤").selectOption("analytical");
  await page.getByRole("button", { name: "문서 검토" }).click();

  await expect(page.getByText("Stub review finding")).toBeVisible();
  await expect(page.getByText(`${body} [reviewed]`)).toBeVisible();

  const replaceProposal = page.getByRole("button", { name: `${body} 제안으로 교체` });
  await expect(replaceProposal).toBeVisible();
  await expect(page.getByRole("button", { name: `${body} 제안을 아래에 추가` })).toBeVisible();
  await expect(page.getByRole("button", { name: `${body} 제안 거절` })).toBeVisible();

  await replaceProposal.click();
  await expect(page.getByText("수락됨")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "문서 본문" })).toContainText(`${body} [reviewed]`);
  await expect(page.getByRole("status", { name: "문서 저장 상태" })).toHaveText("저장되지 않음");
});
